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
│   └── main.jsx                # Main React application (~3000 lines)
├── src/
│   ├── index.js                # Library exports
│   ├── loaders/
│   │   ├── cog-loader.js       # geotiff.js COG wrapper
│   │   ├── h5chunk.js          # Cloud-optimized HDF5 chunk reader (pure JS)
│   │   ├── hdf5-chunked.js     # Legacy HDF5 implementation
│   │   ├── nisar-loader.js     # NISAR GCOV product loader (~3000 lines)
│   │   └── overture-loader.js  # Overture Maps PMTiles/GeoParquet
│   ├── layers/
│   │   ├── SARGPULayer.js      # Primary GPU-accelerated layer (WebGL2 textures)
│   │   ├── SARGPUBitmapLayer.js # GPU bitmap variant
│   │   ├── SARBitmapLayer.js   # CPU-fallback bitmap layer
│   │   ├── SARTileLayer.js     # Original tile layer (Phase 1)
│   │   ├── SARTiledCOGLayer.js # Tiled COG layer
│   │   ├── OvertureLayer.js    # Overture Maps vector overlay
│   │   └── shaders.js          # GLSL vertex + fragment shaders (dB, colormaps, stretch)
│   ├── viewers/
│   │   ├── SARViewer.jsx       # Orthographic viewer (no basemap)
│   │   ├── MapViewer.jsx       # MapLibre basemap + SAR overlay
│   │   └── ComparisonViewer.jsx # Side-by-side / swipe comparison
│   ├── components/
│   │   ├── Histogram.jsx       # Interactive histogram with percentile markers
│   │   ├── StatusWindow.jsx    # Scrolling status/log panel
│   │   ├── ScaleBar.jsx        # Dynamic scale bar overlay
│   │   ├── CoordinateGrid.jsx  # Lat/lon grid overlay
│   │   ├── CornerCoordinates.jsx # Corner coordinate labels
│   │   └── LoadingIndicator.jsx # Loading spinner
│   ├── utils/
│   │   ├── sar-composites.js   # RGB composite presets (Pauli, dual-pol, quad-pol)
│   │   ├── stretch.js          # Stretch modes (linear, sqrt, gamma, sigmoid)
│   │   ├── colormap.js         # Colormaps (grayscale, viridis, inferno, plasma, phase)
│   │   ├── stats.js            # Histogram computation, auto-contrast, percentile stats
│   │   ├── geotiff-writer.js   # Client-side GeoTIFF writer (RGBA + RGB + Float32)
│   │   ├── figure-export.js    # Figure/colorbar PNG export with overlays
│   │   ├── geo-overlays.js     # Scale bar, coordinates, theme constants
│   │   └── gpu-detect.js       # WebGL2 capability detection
│   └── theme/
│       └── sardine-theme.css   # CSS custom properties (dark theme)
├── test/
│   ├── run-tests.js            # Main test runner (100+ checks)
│   ├── quick-validation.js     # Fast smoke tests
│   ├── layer-test.html         # Browser-based layer rendering test
│   ├── gpu-debug.html          # GPU shader debugging page
│   ├── georef-comparison.mjs   # Georeferencing validation
│   └── benchmarks/
│       └── gpu-vs-cpu.html     # GPU vs CPU rendering benchmark
├── docs/
│   ├── CLOUD_OPTIMIZED_HDF5.md # h5chunk technical design
│   ├── COMPETITIVE_ANALYSIS.md # Market landscape analysis
│   ├── VISUALIZATION.md        # SAR visualization roadmap
│   └── sardine-style-guide.html # Visual design system
├── package.json
├── vite.config.js
└── CLAUDE.md                   # This file
```

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
npm test             # Run test suite (100+ checks)
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

### Shipped
- COG viewer with dB scaling, colormaps, contrast sliders
- NISAR HDF5 GCOV streaming via h5chunk
- GPU-accelerated rendering (SARGPULayer with GLSL shaders)
- RGB composite mode (Pauli, dual-pol-h, dual-pol-v, quad-pol)
- Histogram panel with auto-contrast (percentile-based)
- Stretch modes (sqrt, gamma, sigmoid)
- GeoTIFF export (raw Float32 + rendered RGBA + RGB composites)
- Figure export (PNG with overlays)
- RGB triangle colorbar export
- MapLibre basemap integration
- Overture Maps vector overlay
- Scale bar, coordinate grid, corner coordinates

### Next
- Chat/prompt interface for natural language visualization control
- Drawing/annotation tools on the map
- Time series multi-date loading and animation
- Split view / swipe comparison
- Flood thresholding with mask overlay and GeoJSON export
- Server mode for Docker deployment (sardine-launch)
- Processing backend hook (Nextflow / Python pipeline)

## Target Workflow

1. Drop a NISAR GCOV file into SARdine
2. Sensible defaults applied automatically (dB, grayscale, auto-contrast)
3. Switch polarizations, enable RGB composite
4. Adjust contrast, colormap, stretch
5. Export georeferenced GeoTIFF or annotated figure PNG
