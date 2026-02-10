# SARdine — SAR Data INspection and Exploration: Visualization

## Design Philosophy

SARdine applies sensible SAR defaults on load — dB scaling, grayscale colormap, auto-contrast. Standard interactive operations (band selection, stretch, colormap, export) are exposed as direct UI controls. Data streams from local files or URLs; the full file is never loaded into memory.

---

## 1. Data Ingestion

### Supported inputs

| Input | Behavior | Status |
| :---- | :------- | :----- |
| Local NISAR `.h5` | Stream via h5chunk — chunked reads from File.slice(). No full load into memory. | **Shipped** |
| Local `.tif` / `.tiff` (COG) | Load via geotiff.js, auto-detect overviews and CRS. | **Shipped** |
| Remote COG URL | Stream via geotiff.js HTTP Range requests. | **Shipped** |
| S3 URI to NISAR `.h5` | Stream directly from cloud via HTTP Range reads. No download. | Planned |
| Shopping list CSV | Batch load all products, populate time series selector. | Planned |
| ASF search URL | Query ASF API, display available scenes on map, click to load. | Planned |

### Auto-detection (shipped)
When loading a NISAR GCOV HDF5 file, SARdine automatically:
- Discovers all frequency bands (frequencyA, frequencyB)
- Enumerates available polarizations (HHHH, HVHV, VHVH, VVVV)
- Reads coordinate arrays for georeferencing bounds
- Parses product metadata (identification group attributes)
- Selects default frequency/polarization
- Auto-selects best RGB composite preset based on available polarizations

---

## 2. Default Rendering

On load, SARdine applies these defaults automatically:

### Backscatter (GCOV, GRD, GEC) — Shipped

| Setting | Default | Why |
| :------ | :------ | :-- |
| Scale | dB (10·log₁₀) | Standard for backscatter display |
| Range | -25 to 0 dB | Reasonable for most land cover |
| Colormap | Grayscale | Standard SAR convention |
| Nodata | Transparent | NaN and 0 masked out |
| Stretch | Linear | User can switch to sqrt/gamma/sigmoid |
| Multilook | 4× (on-screen adaptive) | Balance resolution vs speckle |

### Interferometry (GUNW) — Planned

| Setting | Default | Why |
| :------ | :------ | :-- |
| Unwrapped phase | Phase (cyclic) colormap | Standard InSAR convention |
| Coherence | Inferno, 0–1 | Highlights low coherence areas |
| Connected components | Categorical colors | Identify disconnected regions |

### Offset Tracking (GOFF) — Planned

| Setting | Default | Why |
| :------ | :------ | :-- |
| Range/Azimuth offset | Diverging colormap (blue-white-red) | Show direction of motion |
| Magnitude | Viridis | Highlight fast-moving areas |

These are starting defaults; all are adjustable.

---

## 3. Interactive Controls

Controls for common SAR visualization operations.

### Stretch / Colormap Panel — Shipped

```
┌─────────────────────────────────────┐
│  ☑ dB Scale                        │
│                                     │
│  Min ◄━━━━━━━━━━━━━━━━━━━━━► Max   │
│  -25.0 dB                  0.0 dB  │
│                                     │
│  Colormap: [Grayscale ▾]           │
│  Stretch:  [Linear ▾]              │
│  Gamma:    [1.0 ▾]                 │
│                                     │
│  [Auto-Contrast]                    │
│  ╔══════════════════════════════╗   │
│  ║  Histogram (interactive)    ║   │
│  ║  with percentile markers    ║   │
│  ╚══════════════════════════════╝   │
└─────────────────────────────────────┘
```

What's implemented:
- **dB toggle** — GPU converts on the fly, no re-fetch
- **Min/Max sliders** — real-time adjustment, GPU colormap update
- **Auto-contrast** — percentile-based (2nd/98th) from sampled tile data
- **Colormap picker** — grayscale, viridis, inferno, plasma, phase
- **Stretch modes** — linear, sqrt, gamma (adjustable exponent), sigmoid
- **Interactive histogram** — with percentile markers and bin counts
- **Per-channel contrast** — independent min/max for R, G, B in composite mode

All rendering parameters update on the GPU; no data re-fetch required.

### Polarization Selector — Shipped

```
┌─────────────────────────────────────┐
│  Frequency: [frequencyA ▾]         │
│  Polarization: [HHHH ▾]            │
│                                     │
│  Display Mode:                      │
│  ◉ Single Band  ○ RGB Composite    │
│                                     │
│  Composite: [HH / HV / HH÷HV ▾]  │
│  Available: dual-pol-h, pauli-power │
│                                     │
│  Per-channel contrast:              │
│  R (HHHH):  [-25, 0] dB           │
│  G (HVHV):  [-30, -5] dB          │
│  B (HH/HV): [0, 15] dB            │
└─────────────────────────────────────┘
```

What's implemented:
- Single-pol view: dropdown switches between available polarizations
- RGB composite mode: preset-based (dual-pol-h, dual-pol-v, pauli-power, hh-hv-vv)
- Per-channel contrast limits (independent for each RGB channel)
- Auto-selection of best composite based on available polarizations
- Composite presets with formula channels (ratios, differences, sums)

### Metadata Info — Partially Shipped

Product metadata is parsed and displayed in the status window when a file is loaded. Full metadata info bar (track, frame, orbit direction, cycle) is planned.

### Cursor Inspector — Planned

Hover readout: lat/lon, per-pol dB values, incidence angle at cursor position.

---

## 4. Rendering Pipeline — Shipped

### GPU Path (default)

The primary rendering pipeline runs entirely on the GPU:

```
Raw Float32 → WebGL2 R32F Texture → Fragment Shader
                                        ↓
                           power → dB (10·log₁₀)
                                        ↓
                           normalize to [0,1] using contrast limits
                                        ↓
                           apply stretch (sqrt/gamma/sigmoid)
                                        ↓
                           apply colormap (viridis/inferno/etc)
                                        ↓
                           output RGBA
```

For RGB composites, three textures are uploaded (one per channel) and the shader applies per-channel contrast, stretch, and outputs composite RGB.

### CPU Fallback

When WebGL2 is unavailable, `createRGBTexture()` performs the same pipeline on the CPU using `ImageData`. Used for:
- Export rendering (GeoTIFF RGBA)
- Figure export (PNG)
- Systems without GPU support

### Multilook

| Context | Method | Effective looks |
| :------ | :----- | :-------------- |
| On-screen (overview zoom) | Chunk sub-sampling, nSub=4–8 | 16–64 per output pixel |
| On-screen (full zoom) | Direct chunk pixels | 1 (raw resolution) |
| Export (raw) | Exact ml×ml box-filter | ml² |
| Export (rendered) | ml×ml box-filter + 3×3 smooth | ~ml²×9 |

The 3×3 smooth on rendered exports compensates for the noise amplification in ratio channels (e.g., HH/HV).

---

## 5. Export — Shipped

### GeoTIFF Export

| Mode | Output | Use case |
| :--- | :----- | :------- |
| Raw | Float32 GeoTIFF, linear power values | GIS analysis, further processing |
| Rendered | RGBA GeoTIFF with dB + colormap + stretch applied | Quick visualization, sharing |
| RGB Composite | 3-band or 4-band RGBA GeoTIFF from composite | Publication, overlay in GIS |

All exports include:
- Proper GeoTIFF tags (ModelTiepointTag, ModelPixelScaleTag)
- CRS via GeoKeyDirectoryTag (EPSG:4326 for NISAR)
- Full-resolution multilook (configurable ml factor)

### Figure Export

PNG export with geo-overlays baked in:
- Scale bar (adaptive units: m/km)
- Corner coordinates
- Colorbar (single-band) or legend (RGB)
- File/dataset info annotation
- SARdine branding

### RGB Colorbar Export

Standalone PNG of a triangular ternary color-space diagram showing the RGB channel mapping with:
- Barycentric color interpolation with stretch applied
- Channel labels at triangle vertices
- Per-channel contrast range table
- Composite name and parameters

---

## 6. Overlays — Partially Shipped

### Base Maps — Shipped
- MapLibre dark basemap
- Toggle between SAR-only (orthographic) and map (geographic) views

### Vector Overlays — Shipped
- Overture Maps building/road/land-use polygons via PMTiles streaming
- Auto-loaded from Overture CDN for visible viewport

### Geo-annotations — Shipped
- Scale bar overlay (dynamic, adapts to zoom)
- Corner coordinate labels
- Coordinate grid overlay (lat/lon lines)

### Planned
- User-uploaded GeoJSON/Shapefile (drag and drop)
- Drawing tools (polygon, line, point annotation)
- Flood extent polygons from threshold tool
- NISAR frame/track footprint overlay

---

## 7. Time Series & Change Detection — Planned

### Timeline Scrubber

When multiple acquisitions are loaded:

```
┌────────────────────────────────────────────────────┐
│  ◄  12/26  │  01/07  │  01/19  │  01/31  ►        │
│      ●         ●         ●         ◉               │
│                                                    │
│  ▶ Play   ⏸ Pause   Speed: [1x ▾]                │
│  ☐ Loop                                           │
└────────────────────────────────────────────────────┘
```

### Split View / Swipe

```
┌──────────────────┬──────────────────┐
│                  │                  │
│   2026-01-19     │   2026-01-31     │
│   (pre-flood)    ◄►  (post-flood)   │
│                  │                  │
└──────────────────┴──────────────────┘
```

ComparisonViewer.jsx and SwipeComparisonViewer already exist in `src/viewers/` — need integration into main app.

### Difference Map

- **dB difference**: σ₀(t2) - σ₀(t1)
- **Log ratio**: 10·log₁₀(σ₀(t2) / σ₀(t1))
- Diverging colormap (blue = decrease, red = increase)
- GPU computes the difference — no server round trip

---

## 8. Analysis Tools — Planned

### Flood Extent Thresholding

Since HiFLOWS is a core use case:

```
┌─────────────────────────────────────┐
│  Flood Detection                    │
│                                     │
│  Threshold: ◄━━━━━━━━━► -15.0 dB  │
│  ☐ Auto (Otsu)                     │
│  ☐ Show flood mask overlay         │
│  ☐ Show pre-event comparison       │
│                                     │
│  Flood area: 342.7 km²             │
│  [Export GeoJSON]  [Export GeoTIFF] │
└─────────────────────────────────────┘
```

### Transect / Profile Tool

Draw a line → get a backscatter profile chart. Multi-date overlay for the same transect.

### AOI Statistics

Draw a polygon → get mean, std, min, max, histogram for that region. All computed client-side.

---

## 9. Multi-Vendor Support Matrix

| Vendor | Format | Access | Polarizations | Status |
| :----- | :----- | :----- | :------------ | :----- |
| **NISAR** | HDF5 (cloud-opt) | Local file / S3 range read | HH+HV (L), VV (S), quad planned | **Shipped** |
| Any COG | GeoTIFF / COG | URL / Local file | Any single-band | **Shipped** |
| ICEYE | GeoTIFF / COG | S3 / HTTPS | VV | Planned |
| Capella | GeoTIFF / COG | S3 / HTTPS | HH | Planned |
| Umbra | GeoTIFF / COG | S3 / HTTPS | VV | Planned |
| Sentinel-1 | SAFE / COG (ASF) | ASF S3 | VV+VH or HH+HV | Planned |

COG support is generic — any single-band Float32 GeoTIFF with overviews works today. Vendor-specific auto-detection (reading metadata to set defaults) is planned.

---

## 10. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Browser (Client)                       │
│                                                          │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │ React UI  │  │ h5chunk   │  │ deck.gl              │ │
│  │ Controls  │  │ (HDF5     │  │ SARGPULayer          │ │
│  │ Histogram │  │  chunked  │  │ WebGL2 textures      │ │
│  │ Status    │  │  reader)  │  │ GLSL shaders         │ │
│  │ Export    │  │           │  │ (dB + stretch +      │ │
│  │           │  │ geotiff.js│  │  colormap + composite)│ │
│  │           │  │ (COG      │  │                      │ │
│  │           │  │  reader)  │  │ MapLibre basemap     │ │
│  └─────┬─────┘  └─────┬─────┘  └──────────┬───────────┘ │
│        │              │                    │             │
│        └──────────────┴────────────────────┘             │
│                         │                                │
└─────────────────────────┼────────────────────────────────┘
                          │ File.slice() or HTTP Range GET
                          ▼
               ┌─────────────────────┐
               │  Local File / S3    │
               │  NISAR .h5 / .tif   │
               └─────────────────────┘
```

---

## 11. Keyboard Shortcuts — Planned

| Key | Action |
| :-- | :----- |
| `1-4` | Switch polarization (HH, HV, VH, VV) |
| `R` | Toggle RGB composite mode |
| `D` | Toggle dB / Linear |
| `H` | Histogram auto-stretch |
| `F` | Toggle flood mask |
| `T` | Activate transect tool |
| `←` `→` | Previous / next date |
| `Space` | Play/pause time series |
| `S` | Screenshot / figure export |
| `I` | Toggle cursor inspector |
| `L` | Cycle base map |

---

## Priority Order

### Shipped (top priorities delivered)
1. ~~Load and render a single NISAR GCOV with sensible defaults~~
2. ~~Stretch controls + colormap picker~~
3. ~~Polarization switcher~~
4. ~~RGB composite / Pauli decomposition~~
5. ~~Multi-vendor COG support (generic)~~
6. ~~GeoTIFF export (raw + rendered)~~
7. ~~Figure export with overlays~~

### Next priorities
8. Cursor inspector with pixel values
9. Keyboard shortcuts
10. Flood thresholding + mask overlay + GeoJSON export
11. Multi-date loading from shopping CSV + timeline scrubber
12. Split view / swipe comparison
13. Difference map (change detection)
14. Transect and AOI stats tools
15. Share URLs / deep linking
16. Server mode (sardine-launch for Docker deployment)
