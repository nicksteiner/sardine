# SAR Processing Roadmap — Speckle Filtering, InSAR, Geocoding & Terrain Correction

Browser-native SAR processing pipeline for SARdine, informed by ISCE3 architecture
and built on the WebGPU compute infrastructure established in Release 1 (GPU histogram).

## Vision

Bring core SAR processing capabilities — speckle filtering, multi-looking, InSAR
interferogram formation, geocoding, and terrain correction — to the browser using
WebGPU compute shaders. No server, no Python, no GDAL. Process NISAR L1/L2 products
directly in the client.

## Architecture Overview

```
                          ┌─────────────────────────────────────────┐
                          │            WebGPU Compute               │
                          │                                         │
Raw SLC/GCOV ──→ h5chunk ─┤  Multilook ──→ Speckle Filter          │
                          │       │                                 │
                          │  DEM Texture ──→ Geocode (rdr2geo)      │
                          │       │              │                  │
                          │  Terrain Correction   │                 │
                          │       │              │                  │
                          │  InSAR: coregister ──→ interferogram    │
                          │       │              │                  │
                          └───────┼──────────────┼──────────────────┘
                                  ↓              ↓
                          WebGL2 R32F texture → Fragment shader → Screen
                                                     │
                                              GeoTIFF Export
```

The compute pipeline sits between data loading (h5chunk/geotiff.js) and the existing
WebGL2 rendering path (SARGPULayer). Each processing step reads from and writes to
GPU storage buffers. Final output is read back to Float32Array for texture upload
or GeoTIFF export.

---

## Phase 1 — Speckle Filtering (GPU Compute)

**Builds on:** Release 2 of WEBGPU_COMPUTE_ROADMAP.md (`src/gpu/spatial-filter.js`)

### 1.1 Boxcar (Mean) Filter
- NxN box-filter in power domain (linear, not dB)
- Workgroup shared memory tiling: load (N+kernel)×(N+kernel) tile, compute NxN output
- NaN/zero masking: exclude no-data pixels from kernel, normalize by valid count
- Configurable kernel: 3×3, 5×5, 7×7, 9×9, 11×11
- **GPU approach:** Single compute pass, 16×16 workgroups with halo region

### 1.2 Lee Filter (Adaptive)
- Classic Lee (1980): uses local mean and variance within kernel window
- Formula: `filtered = mean + K * (pixel - mean)` where `K = var / (var + noise_var)`
- Noise variance estimated from equivalent number of looks (ENL)
- **GPU approach:** Two shared-memory reductions per workgroup tile (sum, sum-of-squares)
- Preserves edges better than boxcar while reducing speckle
- ENL estimation: user-provided or auto-computed from homogeneous region

### 1.3 Enhanced Lee Filter
- Extends Lee with coefficient of variation (Cv) thresholding
- Three regimes: Cv < Cu (pure mean), Cu < Cv < Cmax (Lee), Cv > Cmax (no filter)
- Cu from ENL: `Cu = 1/sqrt(ENL)`, Cmax typically ~1.7
- Better preservation of point targets and strong scatterers

### 1.4 Refined Lee (Lee-Sigma)
- Uses sigma range (statistical bounds) instead of fixed kernel
- Pixels outside ±2σ of local mean are excluded from averaging
- Iterative: recompute mean with filtered neighbor set
- Better edge preservation than standard Lee
- **GPU approach:** Two-pass — pass 1 computes local stats, pass 2 applies sigma filter

### 1.5 Frost Filter
- Exponentially weighted kernel: `w(r) = exp(-α * Cv² * r)`
- α controls damping rate, Cv is local coefficient of variation
- Distance-weighted: nearby pixels contribute more
- **GPU approach:** Precompute distance LUT, one compute pass with shared memory

### 1.6 Gamma-MAP Filter
- Maximum a posteriori filter assuming Gamma-distributed intensity
- Better theoretical foundation than Lee for multi-look SAR
- Uses ENL as shape parameter
- Three regimes similar to Enhanced Lee but with Gamma statistics
- **GPU approach:** Same workgroup tile pattern as Lee, different kernel math

### Filter Module API

```javascript
// src/gpu/spatial-filter.js
import { applySpeckleFilter } from './gpu/spatial-filter.js';

const filtered = await applySpeckleFilter(data, width, height, {
  type: 'lee',           // 'boxcar' | 'lee' | 'enhanced-lee' | 'frost' | 'gamma-map'
  kernelSize: 7,         // odd integer 3–15
  enl: 4,                // equivalent number of looks (auto-estimate if omitted)
  damping: 1.0,          // Frost α parameter
  sigmaRange: 2.0,       // Lee-Sigma bounds
});
// Returns Float32Array (power domain, same shape as input)
```

### UI Integration

- Filter selector dropdown in control panel
- Kernel size slider (3–15, odd only)
- Real-time preview: filter runs on visible tiles only
- Toggle: show filtered vs. unfiltered (A/B comparison)
- ENL display with auto-estimate option
- Export: apply selected filter before GeoTIFF write

---

## Phase 2 — GPU Multi-Looking

**Extends:** Current CPU multilook in nisar-loader.js (lines 1885–2105)

### 2.1 GPU Box-Filter Multilook
- Replace CPU ml×ml averaging with compute shader
- Input: raw power values from h5chunk (Float32 storage buffer)
- Output: reduced-resolution Float32 buffer
- Workgroup tiles: each thread computes one output pixel by averaging ml×ml input pixels
- Much faster for large ml factors (16×, 32×) where CPU loops are expensive

### 2.2 Weighted Multilook
- Gaussian-weighted instead of uniform box
- Better SNR at edges, reduced scalloping
- Separable: horizontal pass → vertical pass (2 dispatches)

### 2.3 Fractional Multilook
- Non-integer look factors via bilinear interpolation
- Needed for irregular grids and InSAR coregistration
- Anti-aliasing: low-pass filter before resampling

### Multilook API

```javascript
// src/gpu/multilook-compute.js
import { gpuMultilook } from './gpu/multilook-compute.js';

const result = await gpuMultilook(powerData, width, height, {
  factorX: 8,
  factorY: 8,
  mode: 'box',           // 'box' | 'gaussian' | 'fractional'
  outputWidth: Math.ceil(width / 8),
  outputHeight: Math.ceil(height / 8),
});
```

---

## Phase 3 — In-Memory DEM Layer

**Inspired by:** ISCE3 `DEMInterpolator` — bilinear/bicubic interpolation over
regular geographic grids with coordinate system awareness.

### 3.1 DEM Loading

Support loading DEMs from:
- **Cloud Optimized GeoTIFF** (Copernicus 30m, SRTM 90m) via geotiff.js
- **Terrain tiles** (Mapbox/MapTiler terrain-RGB PNG tiles → decode to elevation)
- **Local file drop** (GeoTIFF DEM from user's machine)

```javascript
// src/loaders/dem-loader.js
import { loadDEM } from './loaders/dem-loader.js';

const dem = await loadDEM(source, {
  bounds: [west, south, east, north],  // geographic extent to load
  resolution: 30,                       // target posting in meters
});
// dem = {
//   data: Float32Array,      // elevation values
//   width, height,           // grid dimensions
//   bounds: [w, s, e, n],    // geographic bounds
//   crs: 'EPSG:4326',
//   nodata: -9999,
//   pixelScaleX, pixelScaleY // degrees per pixel
// }
```

### 3.2 GPU DEM Texture

- Upload DEM as R32F texture to WebGPU
- Bilinear interpolation in compute shader for sub-pixel elevation queries
- Bicubic interpolation option for smoother terrain (16-tap kernel)
- Handle nodata: propagate NaN through processing chain

### 3.3 DEM Visualization

- Hillshade rendering (sun azimuth/elevation configurable)
- Slope/aspect colormaps
- Contour line generation (GPU marching squares)
- Transparent overlay on SAR imagery
- Elevation profile extraction along drawn line

### 3.4 Geoid Correction

- EGM96/EGM2008 geoid undulation grid (low-res, ~50KB compressed)
- Convert between ellipsoidal and orthometric heights
- Applied automatically when mixing DEM sources with different datums

### DEM Data Sources (No Server Required)

| Source | Resolution | Coverage | Access |
|--------|-----------|----------|--------|
| Copernicus GLO-30 | 30m | Global | AWS S3 COG (free) |
| SRTM v3 | 30m/90m | ±60° lat | USGS/OpenTopography COG |
| ALOS World 3D | 30m | Global | JAXA COG |
| Terrain-RGB tiles | ~30m | Global | MapTiler/Mapbox (API key) |

---

## Phase 4 — Geocoding (Radar → Geographic)

**Based on:** ISCE3 `Geocode` module — maps radar geometry (range, azimuth) to
geographic coordinates using orbit, DEM, and radar parameters.

### 4.1 Forward Geocoding (rdr2geo)

Map each radar pixel to a geographic position:
1. For each (azimuth_time, slant_range) pixel
2. Compute satellite position/velocity from orbit state vectors
3. Intersect range sphere with Earth ellipsoid + DEM surface
4. Iterate (Newton-Raphson) until convergence: |Δheight| < threshold

**ISCE3 approach:** Iterative intersection of range-Doppler equations with
DEM-draped ellipsoid. SARdine simplification: for NISAR GCOV L2 products,
coordinate arrays are already provided in the HDF5 — use those directly.
rdr2geo only needed for L1 SLC products.

```
For each radar pixel (i, j):
  azTime = t0 + i * Δt
  range  = r0 + j * Δr
  (lat, lon, h) = rdr2geo(azTime, range, orbit, ellipsoid, dem)
```

**GPU approach:** Each compute thread processes one pixel. DEM lookups via
texture sampling (bilinear). Orbit interpolation via Hermite polynomials
stored in uniform buffer.

### 4.2 Inverse Geocoding (geo2rdr)

Map each geographic grid point back to radar coordinates:
1. For each (lat, lon) output grid point
2. Look up DEM height at (lat, lon)
3. Compute 3D position on ellipsoid+DEM
4. Find (azimuth_time, slant_range) via Newton-Raphson on range-Doppler equations

**Used for:** Terrain correction, InSAR coregistration, DEM-assisted resampling.

### 4.3 NISAR GCOV Simplification

For L2 GCOV products (SARdine's primary input), NISAR provides:
- `GCOV/metadata/radarGrid/coordinateX` (longitude array)
- `GCOV/metadata/radarGrid/coordinateY` (latitude array)

These are already geocoded grids. Full rdr2geo is only needed for:
- L1 RSLC/GSLC products
- Sub-pixel geolocation refinement
- Cross-track terrain correction

### Geocoding Module

```javascript
// src/processing/geocode.js
import { geocodeRadarToGeo } from './processing/geocode.js';

const geoGrid = await geocodeRadarToGeo(radarData, {
  orbit: orbitStateVectors,    // from HDF5 metadata
  radarGrid: { t0, r0, dt, dr, nAzimuth, nRange },
  dem: demTexture,             // GPU R32F texture
  ellipsoid: WGS84,
  outputBounds: [w, s, e, n],
  outputSpacing: 0.000278,     // ~30m in degrees
  interpolation: 'bilinear',   // 'nearest' | 'bilinear' | 'bicubic'
});
```

---

## Phase 5 — Terrain Correction

**Based on:** ISCE3 radiometric terrain correction (RTC) — corrects for
foreshortening, layover, and shadow effects caused by topography.

### 5.1 Geometric Terrain Correction (GTC)

Reproject radar data onto a DEM-aware geographic grid:
1. For each output (lat, lon) pixel, compute radar (range, azimuth) via geo2rdr
2. Resample radar image at computed coordinates (bilinear/sinc interpolation)
3. Output is orthorectified: each pixel maps to correct geographic position

**GPU approach:** geo2rdr lookup per output pixel in compute shader, with
radar image stored as R32F texture for hardware-accelerated bilinear sampling.

### 5.2 Radiometric Terrain Correction (RTC)

Correct backscatter intensity for local incidence angle:
1. Compute local incidence angle from DEM slope + satellite look vector
2. Apply area correction factor: `γ⁰ = σ⁰ × (A_flat / A_slope)`
3. A_flat = flat-Earth pixel area, A_slope = actual terrain pixel area

**ISCE3 method:** Area projection — compute area of each radar pixel projected
onto the DEM surface. Uses faceted DEM model (triangulated surface) to compute
exact projected areas.

**SARdine simplified approach:**
- Compute DEM gradient (∂h/∂x, ∂h/∂y) via Sobel or central differences
- Local incidence angle: `cos(θ_i) = n̂ · ŝ` (surface normal · satellite look)
- Correction factor: `cos(θ_i) / cos(θ_flat)`
- All computable on GPU from DEM texture + orbit metadata

```javascript
// src/processing/terrain-correction.js
import { applyRTC } from './processing/terrain-correction.js';

const corrected = await applyRTC(backscatter, {
  dem: demTexture,
  orbit: orbitStateVectors,
  radarGrid: radarParams,
  outputType: 'gamma0',     // 'sigma0' | 'gamma0' | 'beta0'
  method: 'area-projection', // 'area-projection' | 'cos-correction'
});
```

### 5.3 Layover/Shadow Mask

- Forward-project DEM through radar geometry
- Detect layover: multiple ground points map to same radar pixel
- Detect shadow: ground points not illuminated by radar
- Output binary mask (layover | shadow | valid)
- Visualize as transparent overlay on SAR image

---

## Phase 6 — InSAR Processing

**Based on:** ISCE3 InSAR pipeline — interferogram formation, coherence estimation,
and phase-to-height conversion.

### 6.1 SLC Data Support

Extend h5chunk to read NISAR L1 RSLC (Radar Single Look Complex):
- Complex float32 (real + imaginary) or float16
- Dataset path: `science/LSAR/RSLC/swaths/frequencyA/HH`
- Need both amplitude and phase

```javascript
// Extend nisar-loader.js
const { getTile, bounds } = await loadNISARSLC(file, {
  frequency: 'frequencyA',
  polarization: 'HH',
});
// Returns {real: Float32Array, imag: Float32Array}
```

### 6.2 Coregistration

Align secondary SLC to primary SLC geometry:
1. **Geometric coregistration** (coarse): Use orbit + DEM to compute
   pixel offsets via geo2rdr mapping between two acquisitions
2. **Cross-correlation refinement** (fine): GPU cross-correlation on
   amplitude patches to refine sub-pixel offsets
3. **Resampling**: Sinc interpolation of secondary SLC to primary grid

**GPU approach:**
- Cross-correlation via FFT (WebGPU FFT or spatial-domain compute)
- Resampling with 8-tap sinc kernel in compute shader
- Offset field stored as 2-channel (azimuth, range) storage buffer

### 6.3 Interferogram Formation

```
interferogram = primary × conj(secondary)
             = |P|·|S| · exp(j·(φ_P - φ_S))
```

- **Phase:** `atan2(imag, real)` — contains topographic + deformation signal
- **Coherence:** `|⟨P·S*⟩| / sqrt(⟨|P|²⟩ · ⟨|S|²⟩)` over estimation window
- **Amplitude:** `sqrt(real² + imag²)` of interferogram

**GPU compute shader:**
- Complex multiplication: 2 muls + 1 add per pixel (trivially parallel)
- Coherence: reduction over NxN window (same pattern as Lee filter)
- Output 3 bands: phase (R32F), coherence (R32F), amplitude (R32F)

### 6.4 Flat-Earth Phase Removal

Remove phase contribution from Earth's curvature:
- Compute theoretical flat-Earth phase from baseline + range geometry
- `φ_flat = -4π/λ · B_perp · (r - r_ref) / (r · tan(θ))`
- Subtract from interferometric phase
- Remaining phase = topography + deformation + atmosphere + noise

### 6.5 Phase Visualization

New shader mode for wrapped/unwrapped phase:
- **Wrapped phase** [-π, π]: cyclic colormap (existing `phase` colormap)
- **Coherence overlay**: coherence as alpha, phase as hue
- **Fringe rate** control: multiply phase to enhance fringes
- **Phase-to-displacement**: `d = φ · λ / (4π)` for deformation mapping

### 6.6 Phase Unwrapping (Stretch Goal)

Full 2D phase unwrapping in the browser is ambitious but feasible for small scenes:
- **SNAPHU-lite:** Simplified minimum-cost-flow on GPU
- **Quality-guided:** Unwrap high-coherence pixels first, flood-fill
- **Branch-cut:** Goldstein's algorithm adapted for GPU (residue detection → branch cuts → integration)
- Practical limit: ~4K×4K pixels in browser (GPU memory bound)

---

## Phase 7 — Texture & Polarimetric Processing

### 7.1 GLCM Texture Features (GPU)

Gray-Level Co-occurrence Matrix texture analysis:
- Compute GLCM for configurable direction and distance
- Extract: contrast, dissimilarity, homogeneity, energy, correlation, entropy
- **GPU approach:** Each workgroup computes GLCM for one tile, atomic histogram
- Output: multi-band texture feature image

### 7.2 Polarimetric Decomposition (GPU)

Move existing CPU decompositions to GPU compute:
- **Freeman-Durden** (already in sar-composites.js → port to WGSL)
- **H/A/α (Cloude-Pottier)**: Eigendecomposition of coherency matrix
  - 3×3 Hermitian matrix eigenvalues → entropy, anisotropy, alpha angle
  - GPU: Jacobi eigenvalue solver per pixel (small matrix, many pixels)
- **Yamaguchi 4-component**: Surface + double-bounce + volume + helix
- **Van Zyl decomposition**: Non-negative power constraint

### 7.3 Change Detection

Multi-temporal SAR analysis:
- Log-ratio: `10·log10(I₂/I₁)` between two dates
- Coherent change detection (CCD): interferometric coherence thresholding
- GPU compute: per-pixel ratio + threshold → change mask
- Export as GeoJSON polygons (GPU → mask → vectorize on CPU)

---

## Implementation Priority & Dependencies

```
Phase 1: Speckle Filtering ←── WebGPU compute (Release 1 ✓)
    │
Phase 2: GPU Multilook ←── Phase 1 (shared memory patterns)
    │
Phase 3: DEM Layer ←── geotiff.js COG loader (exists ✓)
    │
    ├── Phase 4: Geocoding ←── Phase 3 (DEM required)
    │       │
    │       └── Phase 5: Terrain Correction ←── Phase 4 (geocoding required)
    │
    └── Phase 6: InSAR ←── Phase 3 (DEM) + Phase 2 (multilook)
                    │
Phase 7: Texture/PolSAR ←── Phase 1 (filter patterns) + Phase 2 (multilook)
```

### Estimated Complexity

| Phase | New Files | WGSL Shaders | Difficulty | Key Challenge |
|-------|-----------|-------------|------------|---------------|
| 1. Speckle Filters | 1–2 | 4–6 | Medium | Shared memory halo regions |
| 2. GPU Multilook | 1 | 2 | Low | Already have CPU reference |
| 3. DEM Layer | 2–3 | 1–2 | Medium | COG streaming for large DEMs |
| 4. Geocoding | 2 | 2 | High | Newton-Raphson convergence |
| 5. Terrain Correction | 1–2 | 2 | High | Area projection geometry |
| 6. InSAR | 4–5 | 5–6 | Very High | Complex data, coregistration, unwrapping |
| 7. Texture/PolSAR | 2–3 | 4–5 | Medium-High | Eigendecomposition on GPU |

### File Structure

```
src/
├── gpu/
│   ├── webgpu-device.js          # ✓ Exists
│   ├── histogram-compute.js      # ✓ Exists
│   ├── gpu-stats.js              # ✓ Exists
│   ├── spatial-filter.js         # Phase 1: speckle filters
│   ├── multilook-compute.js      # Phase 2: GPU multilook
│   └── texture-features.js       # Phase 7: GLCM
├── processing/
│   ├── dem-loader.js             # Phase 3: DEM loading + interpolation
│   ├── dem-layer.js              # Phase 3: DEM visualization
│   ├── geocode.js                # Phase 4: rdr2geo / geo2rdr
│   ├── terrain-correction.js     # Phase 5: GTC + RTC
│   ├── insar.js                  # Phase 6: interferogram + coherence
│   ├── coregistration.js         # Phase 6: SLC coregistration
│   └── phase-unwrap.js           # Phase 6: phase unwrapping (stretch)
├── layers/
│   ├── DEMLayer.js               # Phase 3: hillshade/contour rendering
│   └── shaders.js                # Extend: phase colormap, coherence overlay
└── utils/
    └── sar-composites.js         # Extend: PolSAR decompositions
```

---

## Key Design Constraints (Browser-Native)

### Memory Budget
- WebGPU `maxBufferSize`: typically 256MB–4GB (device-dependent)
- Practical limit per tile: ~64MB (16K×16K float32)
- DEM: Copernicus 30m global = ~2TB raw → must stream tiles on demand
- InSAR SLC pair: 2× complex float32 → 2× memory vs. power imagery
- Strategy: process in tiles, stream from COG/HDF5, never load full scene

### Compute Budget
- Target: interactive rates for viewport-visible tiles
- Speckle filter 512×512: <5ms on discrete GPU
- Geocoding 512×512: <10ms (Newton iterations)
- InSAR interferogram 512×512: <2ms (trivially parallel)
- Phase unwrapping: batch operation, not real-time (seconds)

### Data Access (No Server)
- DEMs: COG from S3/OpenTopography (HTTP Range)
- NISAR SLC: h5chunk streaming from local file or URL
- Orbit state vectors: embedded in HDF5 metadata
- Geoid: EGM96 (~50KB) bundled as static asset

### ISCE3 Algorithmic References

The following ISCE3 modules inform the implementations above:
- `cxx/isce3/geocode/GeocodeCov` — Area-projection geocoding
- `cxx/isce3/geometry/Geo2rdr` — Inverse geocoding (Newton-Raphson)
- `cxx/isce3/geometry/Topo` — Forward geocoding (rdr2geo)
- `cxx/isce3/geometry/DEMInterpolator` — DEM bilinear/bicubic interpolation
- `cxx/isce3/signal/Crossmul` — Interferogram formation
- `cxx/isce3/signal/multilook` — Multi-look averaging
- `python/packages/isce3/signal/filter_data` — Spatial filtering utilities

---

## Success Criteria

**Phase 1 (Speckle):** User drops NISAR GCOV → applies Lee filter → sees reduced
speckle in real-time → exports filtered GeoTIFF.

**Phase 3 (DEM):** User specifies AOI → DEM streams from S3 COG → hillshade overlay
appears on SAR image → elevation query on hover.

**Phase 5 (Terrain Correction):** User loads GCOV + DEM → applies RTC → gamma-nought
backscatter with terrain effects removed → exports corrected GeoTIFF.

**Phase 6 (InSAR):** User loads two RSLC files → coregistration runs → interferogram
displayed with phase colormap → coherence overlay → fringe visualization.
