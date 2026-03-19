# MintPy → WebGPU: InSAR Time-Series Workflows for SARdine

Evaluation of which MintPy processing steps can run as WebGPU compute shaders
in the browser, and which ones can't.

## MintPy Pipeline Overview

MintPy (`smallbaselineApp.py`) processes a stack of unwrapped interferograms
into a displacement time series. SARdine already loads individual NISAR GUNW
products — this evaluation covers extending that to **multi-GUNW time-series
analysis**.

```
MintPy Pipeline                   WebGPU Feasibility
─────────────────                  ──────────────────
1. Load interferogram stack        ✅ h5chunk streams each GUNW
2. Reference point selection       ✅ Reduction → per-pixel subtract
3. Phase closure (triplets)        ✅ Per-pixel, embarrassingly parallel
4. Unwrapping error correction     ⚠️ Bridging needs graph ops (partial)
5. Network inversion (SBAS)        ✅ Per-pixel least squares — GPU sweet spot
6. Temporal coherence              ✅ Per-pixel complex mean
7. Tropospheric delay correction   ✅ Already implemented (phase-corrections.js)
8. Phase ramp removal              ✅ Already implemented (phase-corrections.js)
9. DEM error estimation            ✅ Per-pixel regression vs. B_perp
10. Velocity estimation            ✅ Per-pixel linear regression
```

## Tier 1: Excellent GPU Fit (Implement Now)

### 1. SBAS Network Inversion

**What:** Solve for displacement at each epoch from a network of interferograms.

**Math:** For each pixel, solve `G·φ = d` where:
- `G` is the design matrix (N_ifg × N_epoch), sparse ±1 entries
- `d` is the unwrapped phase vector (N_ifg × 1)
- `φ` is the unknown phase time series (N_epoch × 1)
- Weighted by coherence: `W = diag(γ²)` or `diag(γ)`

**Why GPU:** The matrix `G` is the same for every pixel — only `d` and `W`
change. This is millions of independent small linear systems. Classic GPU
workload: same program, different data (SIMD).

**Approach:** Pre-compute `(GᵀWG)⁻¹GᵀW` on CPU (one matrix, shared across
all pixels). Upload as uniform. Each GPU thread multiplies this matrix by
the pixel's phase vector. For N_epoch ≤ 100, this is a small mat-vec multiply.

**Memory:** N_ifg × width × height × 4 bytes. For 50 interferograms on a
16K × 16K scene: ~50 GB. Must process in tiles (512×512 = ~50 MB per tile
for 50 ifgs). WebGPU `maxStorageBufferBindingSize` is typically 256 MB–2 GB.

```wgsl
// Per-pixel: displacement[epoch] = sum(invMatrix[epoch][ifg] * phase[ifg])
@compute @workgroup_size(256)
fn sbas(@builtin(global_invocation_id) gid: vec3u) {
  let pixel = gid.x;
  if (pixel >= params.numPixels) { return; }
  for (var e = 0u; e < params.numEpochs; e++) {
    var sum = 0.0;
    for (var i = 0u; i < params.numIfgs; i++) {
      let phase = phases[i * params.numPixels + pixel];
      let weight = coherence[i * params.numPixels + pixel];
      sum += invMatrix[e * params.numIfgs + i] * phase * weight;
    }
    output[e * params.numPixels + pixel] = sum;
  }
}
```

### 2. Velocity Estimation

**What:** Fit a line through the displacement time series at each pixel.

**Math:** `v = Σ(tᵢ·dᵢ) / Σ(tᵢ²)` (mean-removed), or full OLS:
`v = (ΣtᵢΔdᵢ - n·t̄·d̄) / (Σtᵢ² - n·t̄²)`

**Why GPU:** Per-pixel, no neighbor access, pure arithmetic. The most
embarrassingly parallel operation in the entire pipeline.

**Output:** Velocity map (mm/year) + velocity uncertainty.

### 3. Temporal Coherence

**What:** Quality metric after SBAS inversion. Measures how well the model
fits the data.

**Math:** `TC = |1/N · Σ exp(j·φ_residual_i)|` where φ_residual = observed - modeled.

**Why GPU:** Per-pixel complex arithmetic. No neighbor access.

**Output:** 0–1 map. High TC = reliable pixel. Used for masking.

### 4. DEM Error Estimation

**What:** Estimate residual topographic phase not removed during
interferogram processing.

**Math:** Per-pixel regression of phase residual against perpendicular
baseline: `δh = Σ(Bperp·φres) / Σ(Bperp²) × R·sin(θ) / (4π/λ)`

**Why GPU:** Same pattern as velocity — per-pixel regression with a
different independent variable (B_perp instead of time).

### 5. Phase Closure (Triplet Analysis)

**What:** For every triplet of interferograms that form a closed loop
(A→B, B→C, A→C), the sum of phases should be zero (modulo 2π).
Non-zero closure indicates unwrapping errors.

**Math:** `closure = φ_AB + φ_BC - φ_AC` (should be ~0 or ±2nπ)

**Why GPU:** Per-pixel addition of 3 interferogram values. Test all
triplets in parallel.

## Tier 2: Feasible with Caveats

### 6. Reference Point Selection

**What:** Find the most stable, high-coherence pixel to use as reference.

**Approach:**
1. GPU pass: compute mean temporal coherence per pixel (reduction)
2. GPU pass: compute phase variance per pixel
3. CPU: select pixel with max coherence + min variance

**Caveat:** The selection is a global argmax — GPU does the per-pixel stats,
CPU picks the winner. Fine for SARdine's tile-based architecture.

### 7. Coherence-Based Network Modification

**What:** Identify interferograms with low spatial coherence and exclude them
from the network before inversion.

**Approach:**
1. GPU: compute mean coherence per interferogram (reduction over pixels)
2. CPU: threshold and rebuild design matrix
3. Re-run SBAS with modified network

**Caveat:** The network modification is a graph operation (CPU), but the
coherence statistics that drive it are GPU-accelerated.

## Tier 3: Not Practical for Browser GPU

### 8. Phase Unwrapping (SNAPHU)

**Why not:** Minimum-cost flow / network optimization. Inherently sequential
graph algorithm. Even CUDA implementations only achieve ~2-5× speedup.
Academic GPU unwrappers exist but are research-grade.

**SARdine workaround:** Load already-unwrapped GUNW products. NISAR's
processing pipeline does unwrapping before distribution.

### 9. ERA5 Tropospheric Correction

**Why not:** Requires downloading ERA5 reanalysis data from CDS (~1 GB per
scene), interpolating 3D atmospheric fields, and ray-tracing through the
troposphere. This is a server-side data access problem, not a compute problem.

**SARdine workaround:** NISAR GUNW products include tropospheric correction
layers in the metadata cubes. SARdine already loads these
(`phase-corrections.js`).

### 10. Bridging for Unwrapping Error Correction

**Why not:** Minimum spanning tree + connected component labeling. Graph
algorithms with irregular memory access patterns. Possible on GPU but
complex and not worth the engineering effort for a browser tool.

**SARdine workaround:** Use GUNW `connectedComponents` dataset to identify
unwrapping regions. Let users mask out problematic regions interactively.

## Implementation Architecture

```
                  ┌──────────────────────────────────────────┐
                  │         WebGPU Compute Shaders           │
                  │                                          │
N × GUNW files ──→│  Stack loader  ──→  Reference subtract  │
(h5chunk)         │       │                    │             │
                  │  Coherence stack     Phase closure       │
                  │       │                    │             │
                  │  SBAS inversion  ←── Design matrix (CPU) │
                  │       │                                  │
                  │  DEM error correction                    │
                  │       │                                  │
                  │  Velocity regression                     │
                  │       │                                  │
                  │  Temporal coherence                      │
                  └───────┼──────────────────────────────────┘
                          ↓
                  WebGL2 R32F texture → SARGPULayer → Screen
                          │
                  GeoTIFF export (velocity map, time series)
```

### File Structure

```
src/gpu/
├── insar-timeseries.js      # Orchestrator: load stack, run pipeline
├── sbas-inversion.wgsl      # SBAS network inversion compute shader
├── velocity-compute.wgsl    # Per-pixel velocity regression
├── temporal-coherence.wgsl  # Temporal coherence quality metric
├── dem-error.wgsl           # DEM error estimation
└── phase-closure.wgsl       # Triplet phase closure
```

### Memory Strategy

Process in tiles to stay within WebGPU buffer limits:

| Stack Size | Tile 512×512 | Tile 256×256 |
|-----------|-------------|-------------|
| 20 ifgs   | 20 MB       | 5 MB        |
| 50 ifgs   | 50 MB       | 12.5 MB     |
| 100 ifgs  | 100 MB      | 25 MB       |
| 200 ifgs  | 200 MB      | 50 MB       |

Conservative target: 50 interferograms with 512×512 tiles = ~50 MB per
tile, well within typical `maxStorageBufferBindingSize`.

### Design Matrix Construction (CPU)

The SBAS design matrix `G` maps interferograms to epochs:

```javascript
// For ifg connecting epoch_i to epoch_j:
//   G[ifg][epoch_i] = -1, G[ifg][epoch_j] = +1
function buildDesignMatrix(pairs) {
  // pairs = [{ref: dateIndex, sec: dateIndex}, ...]
  const epochs = uniqueDates(pairs);
  const G = zeros(pairs.length, epochs.length);
  for (let i = 0; i < pairs.length; i++) {
    G[i][pairs[i].ref] = -1;
    G[i][pairs[i].sec] = +1;
  }
  return { G, epochs };
}
```

Inversion matrix `(GᵀWG)⁻¹GᵀW` computed once on CPU (small matrix,
typically < 200×100), uploaded as uniform buffer.

## Workflow UX

### Multi-GUNW Loading

1. User drops N GUNW files (same track/frame, different dates)
2. SARdine auto-detects temporal stack (same track + frame numbers)
3. Displays interferogram network graph (dates as nodes, pairs as edges)
4. User selects reference point (auto-suggested based on coherence)

### Time-Series Viewer

1. Slider scrubs through displacement epochs
2. Click any pixel → shows displacement time series chart
3. Velocity map as default view
4. Toggle: displacement / velocity / acceleration / temporal coherence
5. Coherence threshold slider masks low-quality pixels

### Export

- Velocity map as GeoTIFF (mm/year, Float32)
- Full displacement time series as multi-band GeoTIFF (one band per epoch)
- Temporal coherence mask as GeoTIFF
- Time series CSV for selected points

## Performance Estimates

| Operation | Per-tile (512×512, 50 ifgs) | Full scene (16K×16K) |
|-----------|---------------------------|---------------------|
| Stack upload | ~2 ms | Tiled, on-demand |
| SBAS inversion | ~5 ms | ~5 s (1000 tiles) |
| Velocity regression | <1 ms | <1 s |
| Temporal coherence | <1 ms | <1 s |
| DEM error | ~2 ms | ~2 s |

Total per tile: ~10 ms. Interactive for viewport-visible tiles.

## What This Gives SARdine Over QGIS

| Capability | SARdine + WebGPU | QGIS | MintPy (Python) |
|-----------|-----------------|------|-----------------|
| SBAS inversion | ~10 ms/tile, browser | N/A | Minutes (NumPy) |
| Velocity map | Interactive, GPU | Plugin (StaMPS) | CLI, batch |
| Time series click | Instant chart | N/A | Plot script |
| No install | Browser tab | Desktop + conda | conda + ISCE |
| Streaming | h5chunk tiles | Load all to RAM | Load all to RAM |

The key differentiator: **interactive InSAR time series in a browser tab**,
no Python environment, no server, no 30 GB of RAM.
