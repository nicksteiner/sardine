# Multi-Product Analysis Space — GCOV + GUNW + Coherence

**Priority: HIGH** — Enables wetland hydrology, flood mapping, and InSAR quality assessment workflows that are the primary science use case for NISAR L-band data.

## Why This Matters

NISAR produces matched GCOV (backscatter) and GUNW (interferometry) products over the same geographic footprint. Loading them together in a single viewer — with GPU-accelerated compositing — unlocks analysis that no current browser tool provides:

- **Flood detection**: HH backscatter increase (double-bounce) + coherence loss = inundated area
- **Water level mapping**: Unwrapped phase → cm-precision water level change, masked by coherence
- **Wetland classification**: HH/HV/coherence RGB composite discriminates open water, flooded forest, marsh
- **InSAR quality assessment**: Coherence + connected components show where phase measurements are reliable

The GPU advantage is critical: multi-product visualization requires 3–6 co-registered textures rendered simultaneously with per-pixel math (ratios, thresholds, alpha modulation). This is exactly what fragment shaders excel at — the CPU path would be prohibitively slow for interactive exploration.

---

## Architecture: GPU Multi-Texture Compositing

### Current State

```
SARGPULayer fragment shader handles:
  - Single-band:  1× R32F texture → dB → stretch → colormap → RGBA
  - RGB composite: 3× R32F textures → per-channel dB+stretch → RGB → RGBA
  - Mask overlay:  1× R32F texture → alpha masking
  Total: up to 4 textures per draw call
```

### Target State

```
Multi-product fragment shader handles:
  - Backscatter:   1–3× R32F textures (HH, HV, VV from GCOV)
  - Phase:         1× R32F texture (unwrapped phase from GUNW)
  - Coherence:     1× R32F texture (coherence magnitude from GUNW)
  - Components:    1× R32U texture (connected components from GUNW)
  - Mask:          1× R8 texture (quality mask)
  Total: up to 8 textures per draw call (well within WebGL2 limit of 16)
```

### Why GPU-First Is Non-Negotiable

Every pixel in a multi-product view requires:
1. **dB conversion** of 1–3 backscatter bands (transcendental: log₂)
2. **Normalization** per channel with independent contrast limits
3. **Stretch** (sqrt/gamma/sigmoid) per channel
4. **Phase-to-height conversion** (multiply by λ/4π·cos θ)
5. **Coherence-weighted alpha** (multiply coherence × opacity)
6. **Connected component masking** (component == 0 → transparent)
7. **Threshold classification** (HH > threshold AND coherence < threshold → flood)
8. **Colormap application** (phase → cyclic, coherence → inferno, classification → categorical)

At 4K viewport (3840×2160 = 8.3M pixels), this is **50–80M floating-point operations per frame**. On GPU: <1ms. On CPU: 200–400ms (non-interactive).

The fragment shader does this work **for free** — it runs at display time with zero additional memory allocation. Changing a threshold, contrast limit, or colormap is a uniform update: no data re-fetch, no texture re-upload, instant visual feedback.

---

## GUNW HDF5 Loader Extension

### GUNW Dataset Structure

Under `/science/LSAR/GUNW/grids/frequencyA/`:

```
unwrappedInterferogram/
  {POL}/
    unwrappedPhase           float32    Continuous phase (radians)
    coherenceMagnitude       float32    Coherence (0–1)
    connectedComponents      uint32     Phase unwrapping regions
    ionospherePhaseScreen    float32    Ionosphere correction
    ionospherePhaseScreenUncertainty  float32
    mask                     uint8      Quality/validity mask

wrappedInterferogram/
  {POL}/
    wrappedInterferogram     complex64  Complex wrapped interferogram
    coherenceMagnitude       float32    Coherence for wrapped product

pixelOffsets/
  {POL}/
    alongTrackOffset         float32    Azimuth pixel offset
    slantRangeOffset         float32    Range pixel offset
    correlationSurfacePeak   float32    Cross-correlation quality
```

### Implementation: Extend `nisarPaths()` and `listNISARDatasets()`

The key difference from GCOV: an extra nesting level. GCOV has `frequency{F}/{TERM}`, GUNW has `frequency{F}/unwrappedInterferogram/{POL}/unwrappedPhase`.

```javascript
// nisar-loader.js — extend nisarPaths() for GUNW
function nisarPaths(band = 'LSAR', productType = 'GCOV') {
  const base = `/science/${band}/${productType}`;

  if (productType === 'GUNW') {
    return {
      ...commonPaths(base, band),
      // GUNW-specific dataset accessors
      unwrappedPhase:     (f, pol) => `${base}/grids/frequency${f}/unwrappedInterferogram/${pol}/unwrappedPhase`,
      coherence:          (f, pol) => `${base}/grids/frequency${f}/unwrappedInterferogram/${pol}/coherenceMagnitude`,
      connectedComponents:(f, pol) => `${base}/grids/frequency${f}/unwrappedInterferogram/${pol}/connectedComponents`,
      ionosphere:         (f, pol) => `${base}/grids/frequency${f}/unwrappedInterferogram/${pol}/ionospherePhaseScreen`,
      wrappedInterferogram:(f, pol) => `${base}/grids/frequency${f}/wrappedInterferogram/${pol}/wrappedInterferogram`,
      wrappedCoherence:   (f, pol) => `${base}/grids/frequency${f}/wrappedInterferogram/${pol}/coherenceMagnitude`,
      alongTrackOffset:   (f, pol) => `${base}/grids/frequency${f}/pixelOffsets/${pol}/alongTrackOffset`,
      slantRangeOffset:   (f, pol) => `${base}/grids/frequency${f}/pixelOffsets/${pol}/slantRangeOffset`,
    };
  }

  // existing GCOV paths...
}
```

### `listNISARDatasets()` Returns Unified Catalog

```javascript
// For a GUNW file, returns:
[
  { frequency: 'A', polarization: 'HH', layer: 'unwrappedPhase',      dtype: 'float32', shape: [...] },
  { frequency: 'A', polarization: 'HH', layer: 'coherenceMagnitude',  dtype: 'float32', shape: [...] },
  { frequency: 'A', polarization: 'HH', layer: 'connectedComponents', dtype: 'uint32',  shape: [...] },
  { frequency: 'A', polarization: 'HH', layer: 'ionospherePhaseScreen', dtype: 'float32', shape: [...] },
  // ... wrappedInterferogram, pixelOffsets
]

// For GCOV (unchanged):
[
  { frequency: 'A', polarization: 'HHHH', layer: 'covariance', dtype: 'float32', shape: [...] },
  // ...
]
```

---

## GPU Rendering Modes

### Mode 1: Phase-on-Coherence (Single GUNW file)

**The canonical InSAR display.** Phase as color, coherence as opacity.

```glsl
// Fragment shader: phase-on-coherence mode
uniform sampler2D uPhaseTexture;     // unwrapped phase (radians)
uniform sampler2D uCoherenceTexture; // coherence magnitude (0–1)
uniform sampler2D uComponentTexture; // connected components (uint)
uniform float uPhaseMin;             // display range min (radians)
uniform float uPhaseMax;             // display range max (radians)
uniform float uCoherenceThreshold;   // fade below this (default 0.2)

void main() {
  float phase = texture(uPhaseTexture, vTexCoord).r;
  float coherence = texture(uCoherenceTexture, vTexCoord).r;
  float component = texture(uComponentTexture, vTexCoord).r;

  // Normalize phase to [0,1] for colormap
  float t = (phase - uPhaseMin) / (uPhaseMax - uPhaseMin);
  t = clamp(t, 0.0, 1.0);

  // Cyclic phase colormap
  vec3 color = phaseColormap(t);

  // Coherence modulates opacity: low coherence fades to transparent
  float alpha = smoothstep(0.0, uCoherenceThreshold, coherence);

  // Connected component 0 = unreliable unwrapping → force transparent
  if (component < 0.5) alpha = 0.0;

  // NaN/nodata masking
  if (isnan(phase) || isnan(coherence)) alpha = 0.0;

  fragColor = vec4(color, alpha);
}
```

**GPU advantage:** Adjusting `uCoherenceThreshold` or `uPhaseMin/Max` is a single uniform update. The user drags a slider → instant visual feedback at 60fps. No data movement.

### Mode 2: Multi-Product RGB Composite (GCOV + GUNW)

**R = HH backscatter, G = HV backscatter, B = coherence**

```glsl
// Fragment shader: multi-product RGB mode
uniform sampler2D uTextureHH;        // GCOV HHHH (power)
uniform sampler2D uTextureHV;        // GCOV HVHV (power)
uniform sampler2D uTextureCoherence;  // GUNW coherence (0–1)

// Per-channel contrast (dB for HH/HV, linear for coherence)
uniform float uMinR, uMaxR;   // HH: e.g. -25 to 0 dB
uniform float uMinG, uMaxG;   // HV: e.g. -30 to -5 dB
uniform float uMinB, uMaxB;   // Coherence: e.g. 0.0 to 1.0

void main() {
  float hh  = texture(uTextureHH, vTexCoord).r;
  float hv  = texture(uTextureHV, vTexCoord).r;
  float coh = texture(uTextureCoherence, vTexCoord).r;

  // R,G: dB scale + stretch (backscatter)
  float r = processChannel(hh, uMinR, uMaxR);   // dB path
  float g = processChannel(hv, uMinG, uMaxG);   // dB path

  // B: linear scale (coherence is already 0–1)
  float b = clamp((coh - uMinB) / (uMaxB - uMinB), 0.0, 1.0);

  bool anyValid = (hh > 0.0 && !isnan(hh)) ||
                  (hv > 0.0 && !isnan(hv)) ||
                  (!isnan(coh));
  float alpha = anyValid ? 1.0 : 0.0;

  fragColor = vec4(r, g, b, alpha);
}
```

**Interpretation:**
- Bright red-cyan = flooded forest (high HH + high coherence)
- Dark = open water (low HH, low coherence)
- Green-blue = unflooded dense canopy (high HV, high coherence)
- Bright red only = flood-enhanced HH with poor InSAR (ambiguous)

### Mode 3: Classified Inundation Map (GPU Thresholding)

**GPU computes a per-pixel wetland classification from thresholds.**

```glsl
// Fragment shader: inundation classification mode
uniform sampler2D uTextureHH;
uniform sampler2D uTextureCoherence;
uniform float uFloodThreshold_dB;     // HH threshold (e.g. -12 dB)
uniform float uWaterCoherenceMax;      // coherence < this = water (e.g. 0.15)
uniform float uForestCoherenceMin;     // coherence > this = woody wetland (e.g. 0.5)

// Classification colors
const vec3 OPEN_WATER     = vec3(0.039, 0.086, 0.157);  // dark navy
const vec3 FLOODED_FOREST = vec3(0.831, 0.361, 1.0);    // magenta
const vec3 UNFLOODED_VEG  = vec3(0.239, 0.863, 0.518);  // green
const vec3 HERBACEOUS     = vec3(0.306, 0.788, 0.824);  // cyan

void main() {
  float hh  = texture(uTextureHH, vTexCoord).r;
  float coh = texture(uTextureCoherence, vTexCoord).r;

  float hh_dB = 10.0 * log2(max(hh, 1e-10)) * 0.30103;

  vec3 color;
  float alpha = 1.0;

  if (isnan(hh) || hh == 0.0) {
    alpha = 0.0;  // nodata
  } else if (coh < uWaterCoherenceMax && hh_dB < uFloodThreshold_dB) {
    color = OPEN_WATER;
  } else if (coh > uForestCoherenceMin && hh_dB > uFloodThreshold_dB) {
    color = FLOODED_FOREST;
  } else if (coh > uForestCoherenceMin) {
    color = UNFLOODED_VEG;
  } else {
    color = HERBACEOUS;
  }

  fragColor = vec4(color, alpha);
}
```

**GPU advantage:** Adjusting any threshold slider re-classifies **8M pixels in <0.5ms**. The user can interactively explore threshold sensitivity — impossible at CPU speeds.

### Mode 4: Water Level Change Surface (Phase → cm)

```glsl
// Fragment shader: water level change
uniform sampler2D uPhaseTexture;
uniform sampler2D uCoherenceTexture;
uniform sampler2D uComponentTexture;
uniform float uWavelength;            // 0.238 m (L-band)
uniform float uIncidenceAngle;        // radians (from metadata, or per-pixel texture)
uniform float uCoherenceThreshold;
uniform float uHeightMin;             // display range, cm
uniform float uHeightMax;

void main() {
  float phase = texture(uPhaseTexture, vTexCoord).r;
  float coherence = texture(uCoherenceTexture, vTexCoord).r;
  float component = texture(uComponentTexture, vTexCoord).r;

  // Phase → height change (cm)
  // Δh = λ·Δφ / (4π·cos θ) × 100 (m→cm)
  float dh_cm = (uWavelength * phase / (4.0 * 3.14159265 * cos(uIncidenceAngle))) * 100.0;

  // Normalize to display range
  float t = (dh_cm - uHeightMin) / (uHeightMax - uHeightMin);
  t = clamp(t, 0.0, 1.0);

  // Diverging colormap: blue=subsidence, white=stable, red=uplift
  vec3 color = divergingMap(t);

  // Mask by coherence and connected component quality
  float alpha = smoothstep(0.0, uCoherenceThreshold, coherence);
  if (component < 0.5) alpha = 0.0;
  if (isnan(phase)) alpha = 0.0;

  fragColor = vec4(color, alpha);
}
```

---

## WebGPU Compute: Spatial Filters on Multi-Product Data

The existing `spatial-filter.js` infrastructure (boxcar, Lee, enhanced-Lee, Frost, Gamma-MAP) extends naturally to multi-product analysis. Two high-value additions:

### Coherence-Weighted Spatial Averaging

Standard speckle filters assume homogeneous neighborhoods. Coherence provides a **per-pixel quality weight** — the filter should trust high-coherence pixels more.

```wgsl
// Coherence-weighted boxcar: WebGPU compute shader
// Loads two shared-memory tiles (backscatter + coherence)
// Weighted average: Σ(pixel_i × coh_i) / Σ(coh_i)

@compute @workgroup_size(16, 16)
fn coherenceWeightedFilter(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec2u,
  @builtin(workgroup_id) wid: vec2u
) {
  loadTile(wid.xy * vec2u(16u), lid);  // loads backscatter tile
  loadCoherenceTile(wid.xy * vec2u(16u), lid);  // loads coherence tile
  workgroupBarrier();

  var weightedSum: f32 = 0.0;
  var weightSum: f32 = 0.0;

  for (var dy: i32 = -halfK; dy <= halfK; dy++) {
    for (var dx: i32 = -halfK; dx <= halfK; dx++) {
      let tIdx = tileIndex(lid, dx, dy);
      let val = tile[tIdx];
      let coh = cohTile[tIdx];

      if (!isNanOrZero(val) && coh > 0.0) {
        weightedSum += val * coh;
        weightSum += coh;
      }
    }
  }

  let result = select(bitcast<f32>(NAN_BITS), weightedSum / weightSum, weightSum > 0.0);
  outputData[gid.y * params.width + gid.x] = result;
}
```

### Multi-Product Derived Bands (WebGPU Compute)

Some derived products require neighbor access or reduction that fragment shaders can't do efficiently. These run as WebGPU compute passes before rendering:

| Derived Product | Input Textures | Compute Operation | Output |
|:---|:---|:---|:---|
| HH/HV ratio | GCOV HH, HV | Per-pixel division in power domain | R32F texture |
| Local ENL estimate | GCOV any band | NxN mean²/variance reduction | R32F texture |
| Phase gradient magnitude | GUNW phase | Sobel or central-difference filter | R32F texture |
| Coherence-weighted phase smooth | GUNW phase + coherence | Weighted spatial filter (above) | R32F texture |
| Flood probability | GCOV HH + GUNW coherence | Fuzzy classification (sigmoid thresholds) | R32F texture |

These compute passes produce Float32Arrays that are uploaded as additional R32F textures for the fragment shader to composite.

---

## Multi-File Co-Registration

### Problem

GCOV and GUNW files cover the same geographic footprint but may have:
- Different pixel spacing (GCOV: configurable multilook; GUNW: fixed posting)
- Slight bound offsets (sub-pixel registration differences)
- Different grid dimensions

### Solution: Viewport-Aligned Texture Sampling

No explicit resampling needed. Each product is loaded into its own `SARGPULayer` instance with correct geographic bounds. deck.gl handles the projection:

```javascript
// Load GCOV and GUNW as separate layers with matched viewports
const gcovLayer = new SARGPULayer({
  id: 'gcov-hh',
  bounds: gcovBounds,   // [west, south, east, north] from GCOV metadata
  data: hhTextureData,
  // ...
});

const gunwLayer = new SARGPULayer({
  id: 'gunw-coherence',
  bounds: gunwBounds,   // [west, south, east, north] from GUNW metadata
  data: coherenceTextureData,
  // ...
});
```

For **GPU compositing** (modes 2–4 where multiple products must be in the same shader), we need co-registered textures at matching resolution. Strategy:

1. **At tile load time**: Resample GUNW tile to match GCOV tile grid (bilinear, on CPU — one-time cost per tile)
2. **Upload matched textures**: Both products as R32F textures at the same pixel dimensions
3. **Fragment shader**: Sample all textures at the same `vTexCoord` — guaranteed alignment

This is efficient because tile loads are already the bottleneck (HDF5 chunk decompression), and bilinear resampling of a 512×512 tile is ~1ms on CPU.

---

## Implementation Phases

### Phase A: GUNW Loader (Foundation)

Extend `nisar-loader.js` to enumerate and load GUNW datasets.

| Task | Effort | Files |
|:-----|:-------|:------|
| Add GUNW paths to `nisarPaths()` | Small | `nisar-loader.js` |
| Enumerate GUNW subgroups in `listNISARDatasets()` | Medium | `nisar-loader.js` |
| Handle uint32 dtype for `connectedComponents` | Small | `nisar-loader.js`, `h5chunk.js` |
| Auto-detect product type from HDF5 metadata | Small | `nisar-loader.js` |
| Default rendering settings per layer type | Small | `nisar-loader.js` |

**Defaults:**
| Layer | Colormap | Range | Scale |
|:------|:---------|:------|:------|
| `unwrappedPhase` | phase (cyclic) | auto (p2–p98) | linear (radians) |
| `coherenceMagnitude` | inferno | 0–1 | linear |
| `connectedComponents` | categorical | auto | integer |
| `ionospherePhaseScreen` | diverging | auto | linear |
| `wrappedInterferogram` | phase (cyclic) | -π to π | linear (angle of complex) |
| `alongTrackOffset` | diverging | auto | linear |
| `slantRangeOffset` | diverging | auto | linear |

### Phase B: Single-Product GUNW Viewing

Display individual GUNW layers with appropriate rendering.

| Task | Effort | Files |
|:-----|:-------|:------|
| Phase-on-coherence shader mode | Medium | `shaders.js`, `SARGPULayer.js` |
| Connected component categorical colormap | Small | `shaders.js` |
| Phase colormap range control (radians or fringe count) | Small | `app/main.jsx` |
| Coherence threshold slider for alpha masking | Small | `app/main.jsx` |
| Layer selector for GUNW datasets | Medium | `app/main.jsx` |
| Ionosphere correction toggle (subtract from phase) | Medium | `SARGPULayer.js` |

### Phase C: Multi-Product Compositing (GPU Core)

Load GCOV + GUNW together; composite on the GPU.

| Task | Effort | Files |
|:-----|:-------|:------|
| Multi-file loader (drag multiple .h5 files) | Medium | `app/main.jsx` |
| Auto-detect GCOV vs GUNW from product metadata | Small | `nisar-loader.js` |
| Tile co-registration (resample GUNW to GCOV grid) | Medium | `nisar-loader.js` |
| Multi-texture fragment shader (6–8 textures) | Large | `shaders.js`, `SARGPULayer.js` |
| HH/HV/Coherence RGB preset | Small | `sar-composites.js` |
| Per-product contrast controls (independent histograms) | Medium | `app/main.jsx` |
| Export: multi-product GeoTIFF (classified raster) | Medium | `geotiff-writer.js` |

### Phase D: Wetland Analysis Tools (GPU-Accelerated)

Interactive analysis powered by GPU thresholding.

| Task | Effort | Files |
|:-----|:-------|:------|
| Inundation classification shader (Mode 3) | Medium | `shaders.js` |
| Interactive threshold sliders (HH, coherence) | Medium | `app/main.jsx` |
| Water level change shader (Mode 4) | Medium | `shaders.js` |
| Coherence-weighted spatial filter (WebGPU compute) | Medium | `spatial-filter.js` |
| Classification legend overlay | Small | `figure-export.js` |
| Flood area calculation (GPU reduce or CPU from mask) | Medium | `gpu-stats.js` |
| GeoJSON export of classified polygons | Medium | new `vectorize.js` |

### Phase E: Multi-Product Derived Bands (WebGPU Compute)

Pre-compute derived products that require spatial operations.

| Task | Effort | Files |
|:-----|:-------|:------|
| HH/HV ratio compute pass | Small | `spatial-filter.js` |
| Phase gradient (Sobel filter) | Small | `spatial-filter.js` |
| Local ENL estimation | Medium | `spatial-filter.js` |
| Coherence-weighted phase smoothing | Medium | `spatial-filter.js` |
| Fuzzy flood probability | Medium | new `classification-compute.js` |

---

## GPU Resource Budget

| Resource | Single GCOV (today) | GCOV + GUNW (target) | WebGL2 Limit |
|:---------|:--------------------|:---------------------|:-------------|
| R32F textures per tile | 1–4 | 6–8 | 16 per shader |
| Texture memory per tile (512×512) | 1–4 MB | 6–8 MB | N/A |
| Texture memory at 4 visible tiles | 4–16 MB | 24–32 MB | ~256 MB typical |
| Uniforms | 12 | 24 | 1024 components |
| Fragment shader ops/pixel | ~20 | ~60 | No practical limit |
| WebGPU storage buffers | 0–2 | 2–4 | Device-dependent |

All well within hardware limits. The bottleneck remains data loading (HDF5 chunk fetch + decompress), not GPU rendering.

---

## Composite Presets

Extend `sar-composites.js` with multi-product presets:

```javascript
export const MULTI_PRODUCT_PRESETS = {
  'hh-hv-coherence': {
    name: 'HH / HV / Coherence',
    description: 'Backscatter + InSAR quality',
    channels: {
      R: { source: 'GCOV', dataset: 'HHHH', scale: 'dB' },
      G: { source: 'GCOV', dataset: 'HVHV', scale: 'dB' },
      B: { source: 'GUNW', dataset: 'coherenceMagnitude', scale: 'linear' },
    },
    defaults: {
      R: [-25, 0],   // dB
      G: [-30, -5],  // dB
      B: [0, 1],     // linear
    },
  },
  'phase-on-coherence': {
    name: 'Phase on Coherence',
    description: 'Unwrapped phase with coherence-weighted opacity',
    channels: {
      color: { source: 'GUNW', dataset: 'unwrappedPhase', colormap: 'phase' },
      alpha: { source: 'GUNW', dataset: 'coherenceMagnitude', threshold: 0.2 },
      mask:  { source: 'GUNW', dataset: 'connectedComponents', exclude: [0] },
    },
  },
  'inundation-map': {
    name: 'Inundation Classification',
    description: 'HH + coherence → open water / flooded forest / vegetation',
    channels: {
      classify: {
        inputs: [
          { source: 'GCOV', dataset: 'HHHH', scale: 'dB' },
          { source: 'GUNW', dataset: 'coherenceMagnitude', scale: 'linear' },
        ],
        thresholds: {
          floodHH_dB: -12,
          waterCoherenceMax: 0.15,
          forestCoherenceMin: 0.5,
        },
      },
    },
  },
  'water-level-change': {
    name: 'Water Level Change',
    description: 'Unwrapped phase → cm displacement, coherence-masked',
    channels: {
      value: { source: 'GUNW', dataset: 'unwrappedPhase', transform: 'phase_to_height' },
      alpha: { source: 'GUNW', dataset: 'coherenceMagnitude', threshold: 0.3 },
      mask:  { source: 'GUNW', dataset: 'connectedComponents', exclude: [0] },
    },
    colormap: 'diverging',
    defaults: { range: [-20, 20] }, // cm
  },
  'hh-ratio-change': {
    name: 'HH Change + Coherence',
    description: 'Log-ratio of two GCOV dates with coherence mask',
    channels: {
      R: { source: 'GCOV_t1', dataset: 'HHHH', scale: 'dB' },
      G: { source: 'GCOV_t2', dataset: 'HHHH', scale: 'dB' },
      B: { source: 'GUNW', dataset: 'coherenceMagnitude', scale: 'linear' },
    },
  },
};
```

---

## UI: Multi-Product Panel

```
┌────────────────────────────────────────────┐
│  Products Loaded                           │
│  ┌──────────────────────────────────────┐  │
│  │ ☑ GCOV  NISAR_L2_GCOV_001_...h5    │  │
│  │   Bands: HHHH, HVHV, VVVV          │  │
│  │ ☑ GUNW  NISAR_L2_GUNW_001_...h5    │  │
│  │   Layers: phase, coherence, offsets │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  Display Mode:                             │
│  ◉ Single Layer  ○ RGB Composite           │
│  ○ Phase-on-Coherence  ○ Classification    │
│  ○ Water Level Change                      │
│                                            │
│  ── Classification Thresholds ──           │
│  HH flood:    ◄━━━━━━━━━━━━► -12.0 dB    │
│  Water coh:   ◄━━━━━━━━━━━━►  0.15       │
│  Forest coh:  ◄━━━━━━━━━━━━►  0.50       │
│                                            │
│  Flood area: 342.7 km²                    │
│  [Export GeoJSON]  [Export GeoTIFF]        │
└────────────────────────────────────────────┘
```

---

## Priority & Dependencies

```
Phase A: GUNW Loader
  │      ← depends on: existing h5chunk + nisar-loader
  │
  ├── Phase B: Single-Product GUNW Viewing
  │      ← depends on: Phase A + existing SARGPULayer
  │
  └── Phase C: Multi-Product Compositing
         ← depends on: Phase A + Phase B
         │
         ├── Phase D: Wetland Analysis Tools
         │      ← depends on: Phase C + existing spatial-filter.js
         │
         └── Phase E: Derived Bands (WebGPU Compute)
                ← depends on: Phase C + existing WebGPU infrastructure
```

**Phase A → B is the critical path.** Once GUNW datasets load and render individually, everything else builds incrementally on the existing GPU pipeline.

---

## Success Criteria

**Phase A+B (GUNW Viewer):** User drops a NISAR GUNW .h5 file → sees unwrapped phase with cyclic colormap, coherence with inferno colormap, connected components with categorical colors. Coherence-threshold alpha masking works interactively.

**Phase C (Multi-Product):** User drops GCOV + GUNW files → selects "HH/HV/Coherence" RGB preset → sees composite at 60fps → adjusts per-channel contrast → exports multi-band GeoTIFF.

**Phase D (Wetland Analysis):** User loads matched GCOV + GUNW over Louisiana wetlands → selects "Inundation Classification" → adjusts HH and coherence thresholds interactively → sees classified flood map update in real-time → exports flood extent as GeoJSON → sees area statistic.

**Phase E (Derived Bands):** Coherence-weighted phase smoothing reduces noise in water level change maps. HH/HV ratio derived band enables biomass-proxy visualization.
