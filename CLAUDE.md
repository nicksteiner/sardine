# SARdine — Claude Code Project Guide

Context for Claude Code (or any AI coding assistant) to understand the SARdine project.

## What SARdine Is

**SARdine** (**SAR** **D**ata **IN**spection and **E**xploration) is a browser-native SAR analysis tool. It loads NISAR HDF5 GCOV products and Cloud Optimized GeoTIFFs directly in the browser using client-side JavaScript. Rendering runs on the GPU via WebGL2 GLSL shaders. GeoTIFF export is computed client-side.

**Core capabilities today:**
- Stream NISAR L2 GCOV HDF5 files via chunked range reads (h5chunk.js)
- Load Cloud Optimized GeoTIFFs via geotiff.js
- GPU-accelerated dB scaling + colormaps at 60 fps (SARGPULayer)
- Polarimetric RGB composites (HH/HV/VV, Pauli, dual-pol ratios)
- Per-channel contrast with histogram and auto-stretch
- Stretch modes: linear, sqrt, gamma, sigmoid
- Client-side GeoTIFF export (raw Float32 + rendered RGBA)
- Figure export with scale bar, coordinates, colorbar overlays
- RGB triangle colorbar export
- Overture Maps vector overlay via PMTiles

## Tech Stack

| Technology | Purpose |
|:-----------|:--------|
| **React 18** | UI framework |
| **deck.gl 8.9** | WebGL tile/bitmap rendering |
| **@luma.gl/core** | WebGL2 texture + shader management |
| **geotiff.js** | COG loading (HTTP range reads) |
| **h5chunk.js** | Cloud-optimized HDF5 streaming (pure JS, no WASM for streaming) |
| **h5wasm** | HDF5 attribute/metadata parsing (WASM, used alongside h5chunk) |
| **pako** | Inflate/deflate for HDF5 chunk decompression |
| **MapLibre GL** | Basemap rendering |
| **parquet-wasm** | Overture Maps GeoParquet decoding |
| **Vite** | Build tool and dev server |

### Key Design Decisions

- **h5chunk for streaming** — Pure JS HDF5 chunk reader. Parses superblock, object headers, B-trees to build a chunk index. Fetches only viewport-intersecting chunks via File.slice() or HTTP Range. No need to load entire file into memory.
- **GPU-first rendering** — dB conversion, colormap application, and contrast stretching all run in GLSL fragment shaders. CPU fallback exists but GPU path is default.
- **No server required** — Everything runs client-side. h5chunk streams from local File objects. geotiff.js streams from URLs.
- **Minimal dependencies** — Pure JS/WASM stack. No GDAL, no Python, no tile server.

## Project Structure

```
sardine/
├── app/
│   ├── index.html              # Entry HTML
│   └── main.jsx                # Main React application (large monolith; refactor gated on W010)
├── src/
│   ├── index.js                # Library exports (the app/agent boundary)
│   ├── loaders/
│   │   ├── cog-loader.js       # geotiff.js COG wrapper
│   │   ├── h5chunk.js          # Cloud-optimized HDF5 chunk reader (pure JS)
│   │   ├── decode-core.js / decode-worker.js / decode-pool.js  # chunk decode worker pool (W006)
│   │   ├── chunk-cache-idb.js  # IndexedDB L2 chunk cache, ~200 MB LRU (W009)
│   │   ├── nisar-loader.js     # NISAR GCOV product loader
│   │   ├── nisar-gunw-loader.js / nisar-product.js  # GUNW layers + product auto-detect
│   │   ├── nitf-loader.js / url-file.js  # NITF/SICD + Range-request file adapter
│   │   ├── stac-client.js / cmr-client.js  # STAC + NASA CMR search
│   │   └── overture-loader.js  # Overture Maps PMTiles/GeoParquet
│   ├── gpu/                    # WebGPU compute (+ WebGL2 FBO filters)
│   │   ├── webgpu-device.js    # device singleton + capability detection
│   │   ├── histogram-compute.js / gpu-stats.js  # 2-pass WGSL histogram; Auto wrappers w/ CPU fallback (W007)
│   │   └── spatial-filter.js / webgl-spatial-filter.js  # speckle filters (WGSL + FBO)
│   ├── layers/                 # SARGPULayer (primary), SARTileLayer, SARTiledCOGLayer,
│   │                           # SARBitmapLayer (CPU fallback), OvertureLayer, shaders.js (GLSL)
│   ├── viewers/                # SARViewer, MapViewer, ComparisonViewer, CompareGrid (multi-panel)
│   ├── components/             # Histogram, StatusWindow, AnnotationOverlay, ROIOverlay,
│   │                           # ROIProfilePanel, TransectLineOverlay, ScatterClassifier, ...
│   ├── utils/
│   │   ├── annotation-io.js    # markup ⇄ GeoJSON w/ versioned properties schema (W004)
│   │   ├── export-sidecar.js   # {output}.tif.json provenance sidecar (W005)
│   │   ├── deep-link.js        # ?url= + render-param links; share-link.js is a shim (W008)
│   │   ├── sar-composites.js / sar-indices.js  # RGB presets + RVI-family indices
│   │   ├── stats.js / stretch.js / colormap.js
│   │   ├── geotiff-writer.js / figure-export.js / png-state.js / svg-export.js
│   │   ├── wkt.js / roi-subset.js / geo-overlays.js / gpu-detect.js
│   │   └── metadata-cube.js / phase-corrections.js / s3-presign.js / s3-url.js
│   └── theme/sardine-theme.css
├── server/launch.cjs           # Optional server: file browser, STAC (DuckDB), S3 presigning
├── test/
│   ├── run-tests.js            # Structural checks (files, exports, layer contracts)
│   ├── unit/                   # Behavioral tests — auto-discovered *.test.mjs (W001):
│   │                           # geotiff round-trip, stats, wkt/roi, annotation-io,
│   │                           # export-sidecar, deep-link, gpu-stats fallback,
│   │                           # h5chunk synthetic fixtures (v0 + v2 paged)
│   ├── w003/w006/w009 *.test.mjs  # pipeline regression tests (chained into npm test)
│   └── benchmarks/
├── docs/
│   ├── PLATFORM_REVIEW.md      # Strategy: integration, GPU, positioning (July 2026)
│   ├── plan/                   # Machine-executable work orders (W###) + conventions
│   ├── CLOUD_OPTIMIZED_HDF5.md / CHUNK_PIPELINE.md / HDF5_FILE_FORMAT.md
│   ├── DEEP_LINKS.md           # URL parameter reference
│   └── ...                     # product specs, roadmaps, tutorials
├── package.json
├── vite.config.js
└── CLAUDE.md                   # This file
```

**Working conventions:** implementation work is tracked as work orders in `docs/plan/`
(one order → one branch → runnable acceptance criteria; findings appended on premise
drift). Read `docs/plan/README.md` before starting roadmap work — it also records the
sardine-agent API ground truth and naming collisions (e.g. `{file}.sardine.json` is
reserved).

## Architecture

### Data Flow

```
File/URL → Loader → Chunks → GPU Texture → GLSL Shader → Screen
                                              ↓
                                    dB scale → stretch → colormap → contrast
```

### HDF5 Pipeline (NISAR GCOV)

```
1. Open file → h5chunk parses superblock + metadata page (~8MB)
2. Build chunk index: {dataset → [{offset, size, chunkCoords}]}
3. For viewport tile: calculate intersecting chunks
4. Read chunks via File.slice() → decompress (pako) → Float32Array
5. Box-filter multilook (configurable ml factor)
6. Upload as WebGL2 R32F texture
7. Fragment shader: power → dB → normalize → stretch → colormap → RGBA
```

### COG Pipeline

```
1. geotiff.js opens URL with HTTP Range support
2. Reads IFD for overview selection based on zoom
3. Fetches tiles → Float32Array
4. Same GPU rendering pipeline as HDF5
```

### RGB Composite Pipeline

```
1. Load all required polarization bands (e.g., HHHH, HVHV)
2. computeRGBBands() applies preset formula (direct mapping or ratio)
3. Upload 3 bands as separate textures or compute on CPU
4. createRGBTexture() for CPU path: per-channel dB + stretch + contrast
5. GPU path: 3-texture fragment shader with per-channel contrast
```

### Export Pipeline

```
Raw Export:      chunks → multilook → Float32 GeoTIFF (with CRS + tiepoints)
Rendered Export: chunks → multilook → smooth → composite → stretch → RGBA GeoTIFF
Figure Export:   rendered + scale bar + coordinates + colorbar → PNG
Colorbar Export: triangle ternary diagram → PNG
```

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (localhost:5173)
npm test             # Full suite: structural checks + pipeline regressions + unit tests
npm run test:unit    # Behavioral unit tests only (test/unit/*.test.mjs, auto-discovered)
npm run test:quick   # Fast smoke tests
npm run test:layer   # Browser layer rendering test
npm run debug:gpu    # GPU shader debug page
npm run benchmark    # GPU vs CPU performance comparison
npm run build        # Production build → dist/
npm run example      # Run example viewer
```

## Coding Guidelines

### Style

- React functional components with hooks
- ES modules (import/export)
- Plain JavaScript (no TypeScript in app code)
- JSX for React components (.jsx extension)
- Dark theme via CSS custom properties (sardine-theme.css)

### Key Patterns

**NISAR HDF5 Loading:**
```javascript
import { listNISARDatasets, loadNISARGCOV } from './loaders/nisar-loader.js';

const datasets = await listNISARDatasets(file);
// → [{frequency: 'frequencyA', polarization: 'HHHH', shape: [16704, 16272], ...}]

const { getTile, bounds, getExportStripe } = await loadNISARGCOV(file, {
  frequency: 'frequencyA',
  polarization: 'HHHH',
  multilook: 4,
});
```

**RGB Composites:**
```javascript
import { computeRGBBands, createRGBTexture } from './utils/sar-composites.js';

const rgb = computeRGBBands(bandData, 'dual-pol-h', tileSize);
// rgb = {R: Float32Array, G: Float32Array, B: Float32Array}

const imageData = createRGBTexture(rgb, width, height,
  contrastLimits, useDecibels, gamma, stretchMode);
```

**COG Loading:**
```javascript
import { loadCOG } from './loaders/cog-loader.js';
const { getTile, bounds } = await loadCOG(url);
```

**GeoTIFF Export:**
```javascript
import { writeRGBAGeoTIFF, downloadBuffer } from './utils/geotiff-writer.js';
const buffer = writeRGBAGeoTIFF(rgbaData, width, height, bounds, crs);
downloadBuffer(buffer, 'export.tif');
```

### Important Implementation Details

- **Multilook**: Export uses exact ml×ml box-filter on raw power values. On-screen uses chunk sub-sampling with nSub=4–8. Export at low ml can look noisier than on-screen display — a 3×3 spatial smooth is applied to rendered exports to compensate.
- **Per-channel contrast**: RGB composites support `{R: [min,max], G: [min,max], B: [min,max]}` or uniform `[min, max]`.
- **NaN/zero masking**: SAR nodata is 0 or NaN. Both are masked to transparent in shaders and CPU rendering.
- **Coordinate system**: NISAR GCOV uses EPSG:4326 with lat/lon coordinate arrays stored as HDF5 datasets. Bounds extracted from coordinate arrays at file open time.
- **Chunk decompression**: h5chunk handles deflate (via pako) + shuffle filter. Float16/32/64 decoding supported.

### When Adding Features

1. **Minimal changes** — Keep diffs small and focused.
2. **GPU-first** — New visualization features should run in shaders when possible.
3. **No server** — Everything must work client-side from local files or HTTP Range URLs.
4. **Test with real data** — Use actual NISAR GCOV .h5 files and SAR GeoTIFFs for testing.
5. **Export parity** — Any new rendering feature should work in both on-screen and export paths.

## Roadmap

The living roadmap is `docs/plan/` (work orders with acceptance criteria) driven by
the strategy in `docs/PLATFORM_REVIEW.md`. Snapshot:

### Shipped
- COG viewer with dB scaling, colormaps, contrast sliders
- NISAR HDF5 GCOV + GUNW streaming via h5chunk; NITF/SICD via URLFile
- GPU-accelerated rendering (SARGPULayer, GLSL) + WebGPU compute histogram/stats
  with CPU fallback; decode worker pool; IndexedDB L2 chunk cache
- RGB composite mode (Pauli, dual-pol, quad-pol) + RVI-family indices
- Annotations (arrows/text), rectangular ROI + profiles, transects, scatter
  classifier — with **GeoJSON markup save/load** (versioned schema, annotation-io.js)
- GeoTIFF export (raw Float32 + rendered RGBA) with **provenance sidecars**
  ({output}.tif.json); figure PNG export; PNG state embedding
- **Deep links** (?url= + render params) and Copy Link (docs/DEEP_LINKS.md)
- Compare grid (up to 4 synced panels, mixed COG/NISAR), GUNW paired view
- MapLibre basemap, Overture Maps overlay, scale bar/coordinate overlays
- Server mode (sardine-launch): file browser, DuckDB STAC API, S3 presigning
- Behavioral test suite (test/unit) + pipeline regression tests

### In flight
- ASF DAAC demo capacity — SPA shell + ATBD apps (/inundation with ASF auto-stack,
  /crop, /disturbance) on the D582/D106 line; integration tracked as W014

### Next (see docs/plan/)
- W010 SARScene/RenderConfig/SessionState schema (design gate) → main-app store
  extraction
- W011 flood vertical slice: GPU threshold + AI proposals + accept/reject
  adjudication + STAC-labeled export (adds sardine_annotate/sardine_write_mask to
  sardine-agent)
- W012 publish: h5chunk to npm (converge with sardine-agent's packages/h5chunk),
  schemas as draft STAC extensions, public demo instance
- Time series multi-date loading and animation; chat/prompt interface

## Target Workflow

1. Drop a NISAR GCOV file into SARdine
2. Sensible defaults applied automatically (dB, grayscale, auto-contrast)
3. Switch polarizations, enable RGB composite
4. Adjust contrast, colormap, stretch
5. Export georeferenced GeoTIFF or annotated figure PNG
