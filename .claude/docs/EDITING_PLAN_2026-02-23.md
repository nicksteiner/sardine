# SARdine Code Review & Editing Plan

**Date:** 2026-02-23
**Branch:** `fix/code-review-2026-02-23`
**Version:** v1.0.0-beta.2
**Reviewer:** Claude Opus 4.6 + Nick Steiner

---

## Overview

Comprehensive code review identified **6 critical bugs**, **25+ high-severity issues**, and **40+ medium/low issues** across the codebase. This plan organizes all fixes into phased work with clear priorities.

---

## Phase 1 — Critical Data Corruption Fixes

These bugs silently produce wrong output. Fix before any more exports ship.

### 1.1 GeoTIFF Edge Tile Predictor Bug
- **File:** `src/utils/geotiff-writer.js` ~line 402
- **Bug:** `applyHorizontalPredictor()` indexes as `y * TILE_SIZE + x` for all tiles, but edge tiles are smaller than TILE_SIZE. Last row/column of exported GeoTIFFs is corrupted.
- **Fix:** Change to `y * width + x` using actual tile dimensions.
- [ ] Fix indexing
- [ ] Add unit test for edge tile (e.g., 513x513 image = 2x2 tile grid, last tile 1x1)

### 1.2 GeoTIFF Pixel Geolocation Half-Pixel Shift
- **File:** `src/utils/geotiff-writer.js` ~lines 431-432
- **Bug:** ModelTiepoint doesn't account for pixel-corner vs pixel-center convention. Exported coordinates shifted ~10-100m.
- **Fix:** Add half-pixel offset to tiepoint calculation.
- [ ] Fix tiepoint math
- [ ] Validate against rasterio in `georef-comparison.mjs`

### 1.3 GeoTIFF Multilook Window Off-Center
- **File:** `src/utils/geotiff-writer.js` ~lines 177-220
- **Bug:** Box filter biased toward upper-left corner. `startY = Math.floor(y * scale - (mlWindow - scale) / 2)` clips asymmetrically.
- **Fix:** Center properly: `offset = Math.floor((mlWindow - 1) / 2)`.
- [ ] Fix centering
- [ ] Add multilook symmetry test

### 1.4 GDAL_NODATA Tag Wrong Type
- **File:** `src/utils/geotiff-writer.js` ~line 1027
- **Bug:** Written as ASCII `'nan'` string; GeoTIFF spec expects double. GDAL readers ignore it.
- **Fix:** Use proper TIFF double type or validate ASCII encoding matches GDAL expectations.
- [ ] Fix tag encoding
- [ ] Test round-trip with `gdalinfo`

### 1.5 CPU/GPU Colormap Coefficient Divergence
- **Files:** `src/utils/colormap.js` vs `src/layers/shaders.js`
- **Bug:** Plasma polynomial coefficients differ between CPU and GPU. Polarimetric colormap is a completely different colormap in each (CPU: magenta-navy-green, GPU: navy-purple-orange-yellow). Exports look different from on-screen.
- **Fix:** Determine canonical coefficients (from matplotlib source), unify both implementations.
- [ ] Audit all 9 colormaps for CPU/GPU parity
- [ ] Add snapshot test: CPU vs GPU output at t=[0, 0.25, 0.5, 0.75, 1.0]
- [ ] Remove duplicate colormap definitions in shaders.js (defined inline AND exported)

### 1.6 Median Calculation Bug
- **File:** `src/utils/stats.js` ~line 35
- **Bug:** Returns `values[mid]` for even-length arrays instead of interpolating between two middle elements.
- **Fix:** `(values[mid - 1] + values[mid]) / 2` for even lengths.
- [ ] Fix median
- [ ] Add test for even/odd array lengths

---

## Phase 2 — Data Pipeline Safety

Prevent crashes and silent failures on bad/large/corrupted input.

### 2.1 HDF5 Signature Validation
- **File:** `src/loaders/h5chunk.js` ~lines 20-50
- **Issue:** No check for HDF5 magic bytes. Non-HDF5 files cause garbage reads.
- [ ] Validate `\x89HDF\r\n\x1a\n` signature on open

### 2.2 B-Tree Cycle Detection
- **File:** `src/loaders/h5chunk.js` ~lines 285-334
- **Issue:** `walkGroupBTree()` recurses without a visited set. Corrupted files with circular pointers cause stack overflow.
- [ ] Add `visited = new Set()` with address tracking

### 2.3 Continuation Block Chaining
- **File:** `src/loaders/h5chunk.js` ~lines 354-393
- **Issue:** Only reads first continuation block. Objects spanning 2+ blocks lose datasets.
- [ ] Implement `while (nextContinuation)` loop

### 2.4 Silent Null on Buffer Overflow
- **File:** `src/loaders/h5chunk.js` ~line 207
- **Issue:** Returns `null` instead of throwing. Downstream gets `TypeError: Cannot read property of null`.
- [ ] Throw descriptive error with byte offsets

### 2.5 Heap Check Before h5wasm Load
- **File:** `src/loaders/nisar-loader.js` ~lines 385-460
- **Issue:** No check if browser has enough heap for file. 500MB+ on 32-bit browser = instant crash.
- [ ] Check `performance.memory?.jsHeapSizeLimit` before load
- [ ] Provide actionable error message with file size vs available heap

### 2.6 NISAR Loader Error Specificity
- **File:** `src/loaders/nisar-loader.js` ~lines 697-702
- **Issue:** Generic "File too large for browser" for 3 different root causes.
- [ ] Distinguish network timeout, corrupted index, and actual size issues

### 2.7 COG Bounds Validation
- **File:** `src/loaders/cog-loader.js` ~lines 152-159
- **Issue:** Inverted bounds (maxX < minX) not detected. Causes inverted viewport.
- [ ] Add `minX < maxX && minY < maxY` assertion, swap if needed

### 2.8 Freeman-Durden Availability Detection
- **File:** `src/utils/sar-composites.js` ~lines 254-257
- **Issue:** Only checks diagonal terms, not `requiredComplex` (HHVV_re/im). Shows as available, then crashes.
- [ ] Check both `diagonals` and `requiredComplex` datasets

---

## Phase 3 — Application Robustness

### 3.1 React Error Boundary
- **File:** `app/main.jsx`
- **Issue:** No ErrorBoundary. SARViewer crash takes down entire UI.
- [ ] Add ErrorBoundary wrapper with recovery UI

### 3.2 AbortController for Async Operations
- **File:** `app/main.jsx` — `handleLoadCOG`, `handleLoadRemoteNISAR`, `handleExportGeoTIFF`
- **Issue:** Fetch requests continue after component unmount.
- [ ] Add AbortController to all fetch/load paths
- [ ] Wire abort into component cleanup

### 3.3 Unbounded statusLogs
- **File:** `app/main.jsx` ~line 314
- **Issue:** Log array grows forever in long sessions.
- [ ] Implement circular buffer (max 500 entries)

### 3.4 WebGL Texture Upload Error Handling
- **File:** `src/layers/SARGPULayer.js` ~lines 332-378
- **Issue:** `gl.texImage2D()` failures are silent. VRAM exhaustion → leaked textures.
- [ ] Check `gl.getError()` after upload
- [ ] Delete texture and return null on failure

### 3.5 Shader Compilation Error Reporting
- **File:** `src/layers/SARGPULayer.js` ~lines 274-282
- **Issue:** Bad shader silently fails to render.
- [ ] Wrap Model creation in try-catch
- [ ] Log shader info log on failure

### 3.6 WebGL Context Loss Recovery
- **File:** `src/layers/SARGPULayer.js` ~lines 186-213
- **Issue:** Context restored handler doesn't trigger force update. Textures not re-uploaded.
- [ ] Call `setNeedsUpdate()` in restored handler

### 3.7 Tile Loading Backpressure
- **File:** `src/layers/SARTiledCOGLayer.js` ~lines 418-421
- **Issue:** Rapid pan/zoom spawns unlimited concurrent HTTP requests.
- [ ] Add queue with max 4 concurrent tile fetches
- [ ] Cancel pending loads on overview change

### 3.8 Histogram Stride Consistency
- **File:** `src/utils/stats.js` ~lines 219-272
- **Issue:** Pass 1 (min/max) uses no stride, Pass 2 (histogram) uses stride=4. Stats don't match.
- [ ] Apply stride consistently in both passes

### 3.9 Sigmoid Stretch Clamping
- **File:** `src/utils/stretch.js` ~lines 38-43
- **Issue:** High gamma causes output > 1.0.
- [ ] Clamp: `Math.max(0, Math.min(1, result))`

### 3.10 dB Conversion Precision
- **Files:** All GLSL shaders
- **Issue:** `log(x) / log(10.0)` loses precision on mobile GPUs.
- [ ] Replace with `log2(x) * 0.30103` or `log10(x)` where available

---

## Phase 4 — Architecture & Code Quality

### 4.1 Split Monolithic main.jsx
- **File:** `app/main.jsx` (~3000 lines, 50+ useState hooks)
- [ ] Extract `DataSourceSelector.jsx` — file type, NISAR/COG/remote inputs
- [ ] Extract `ContrastPanel.jsx` — histogram, auto-contrast, per-channel controls
- [ ] Extract `RenderingPanel.jsx` — colormap, dB, stretch, gamma
- [ ] Extract `ExportPanel.jsx` — multilook, ROI, export mode, figure export
- [ ] Extract `OverturePanel.jsx` — map overlay controls
- [ ] Convert related useState groups to useReducer

### 4.2 Consolidate Entry Points
- **Files:** `src/index.js` + `src/index.ts`
- **Issue:** Two export files, no clear migration strategy.
- [ ] Pick one (keep .js for now, TS migration later)
- [ ] Remove or mark the other as deprecated

### 4.3 Remove Dead Code
- [ ] `overture-loader.js`: delete `buildOvertureApiUrl()` and `fetchOvertureFeatures()` (always returns empty)
- [ ] `rollup.config.js`: remove (Vite is the build tool)
- [ ] Colormap duplication in `shaders.js`: define once in `glslColormaps`, inject into `sarFragmentShader`

### 4.4 Theme Token Unification
- **Files:** `src/utils/theme-tokens.js`, `src/theme/sardine-theme.css`, `src/utils/geo-overlays.js`
- **Issue:** Theme defined in 3 places. Colors hardcoded in 20+ component locations.
- [ ] Single source of truth in `theme-tokens.js`
- [ ] Replace all hardcoded colors in components with token imports
- [ ] Add missing `radiusLg` to JS tokens
- [ ] Make `CHANNEL_COLORS` theme-aware

### 4.5 CRS Detection Centralization
- **Files:** `geo-overlays.js`, `ScaleBar.jsx`, viewers
- **Issue:** `isProjectedBounds()` reimplemented inconsistently. Heuristic `|x| > 180` fails at boundary.
- [ ] Single function accepting optional EPSG code
- [ ] Use everywhere

### 4.6 Overture Loader Cleanup
- [ ] Unbounded `pmtilesGeoJSONCache` — add LRU eviction (max 500)
- [ ] Unbounded `pmtilesInstances` — add max size + cleanup
- [ ] Feature deduplication at tile boundaries
- [ ] Replace custom 300-line MVT protobuf decoder with `@mapbox/vector-tile`
- [ ] Add proj4js for non-UTM projection support

---

## Phase 5 — Dev Tooling & Testing Infrastructure

### 5.1 Linting & Formatting
- [ ] Add ESLint with standard rules
- [ ] Add Prettier
- [ ] Add `.editorconfig`
- [ ] Add pre-commit hooks (husky + lint-staged)

### 5.2 CI Pipeline
- [ ] GitHub Actions workflow: `npm test` on every PR
- [ ] Wire orphaned test files into `npm` scripts:
  - `npm run test:h5chunk` → `test-h5chunk-validation.mjs`
  - `npm run test:multilook` → `test-sar-multilook.js`
  - `npm run test:georef` → `georef-comparison.mjs`
- [ ] Add code coverage tracking (c8)

### 5.3 Test Coverage Gaps
- [ ] GPU rendering: Playwright pixel-sampling test
- [ ] React UI: React Testing Library for main.jsx critical paths
- [ ] End-to-end: load → export → re-import → verify
- [ ] Colormap regression: CPU vs GPU snapshot at known t values
- [ ] Edge cases: all-zero data, all-NaN, inverted bounds, mismatched mask dimensions

### 5.4 Documentation Gaps
- [ ] Add JSDoc to all exported functions in loaders and utils
- [ ] Fix colormap names in VISUALIZATION.md (lists 9, code has 5)
- [ ] Add troubleshooting guide (CORS, WebGL2, file size, memory)
- [ ] Add browser compatibility matrix
- [ ] Update stale TODOs in CLOUD_OPTIMIZED_HDF5.md with dates/status

---

## Phase 6 — Input Validation & UX Polish

### 6.1 User Input Validation
- [ ] COG URL format validation (`new URL(cogUrl)` before fetch)
- [ ] Multilook factor bounds: `Math.max(1, Math.min(128, value))`
- [ ] Bounds array: assert 4 elements, `minX < maxX`, `minY < maxY`
- [ ] Gamma: reject `<= 0`, warn `> 100`

### 6.2 Accessibility
- [ ] File input: use `<label htmlFor>` pattern instead of button click hack
- [ ] Add `aria-label` to all `<select>` elements
- [ ] Add `prefers-color-scheme` detection to CSS
- [ ] Firefox scrollbar styling (not just WebKit)

### 6.3 Performance
- [ ] Histogram: sample 2-3 tiles instead of 9; parallelize with `Promise.all()`
- [ ] Export progress: throttle `setExportProgress()` to every 5%
- [ ] Memoize markdown state generation
- [ ] Overview selection: add hysteresis to prevent flicker at zoom boundaries

### 6.4 Component Polish
- [ ] Histogram: make canvas responsive to container width
- [ ] ScaleBar: calculate pixels-per-meter from viewState + bounds, not zoom alone
- [ ] CornerCoordinates: fix newline split bug (never inserts newlines)
- [ ] LoadingIndicator: fix overview level off-by-one (0-indexed shown to user)
- [ ] StatusWindow: sync external `isCollapsed` prop with internal state

---

## Phase 7 — Pre-Rendering & Cache Architecture

### 7.1 Problem Statement

Loading a NISAR GCOV file has several expensive cold-start costs:
1. **Metadata parse** — h5chunk reads ~8MB metadata page, parses superblock + B-trees
2. **Chunk index build** — maps every dataset to `{offset, size, chunkCoords}`
3. **Histogram computation** — samples 9 tiles, computes stats for auto-contrast
4. **First tile render** — decompresses chunks, uploads texture, compiles shader

For a single file this takes 3-10 seconds. For a bucket with 100+ files (e.g., a full NISAR orbit strip), the user waits every time they switch scenes.

### 7.2 Browser-Side Cache Layer (sardine-cache)

Cache expensive artifacts in IndexedDB so reloads are instant.

**What to cache per file (keyed by filename + byte size + mtime):**

| Artifact | Size | Saves |
|----------|------|-------|
| Chunk index JSON | ~50-200 KB | Metadata parse + B-tree walk (2-5s) |
| Dataset list + shapes + dtypes | ~2 KB | Dataset enumeration |
| Coordinate bounds + CRS | ~100 bytes | Bounds extraction |
| Histogram bins + stats | ~5 KB per band | Auto-contrast computation (1-3s) |
| Overview tile (lowest res) | ~200 KB per band | Instant thumbnail on file switch |

**Implementation:**
- [ ] Add `src/cache/sardine-cache.js` — IndexedDB wrapper with LRU eviction
- [ ] Hook into `nisar-loader.js`: check cache before parse, write cache after
- [ ] Add cache status indicator in UI (cached/fresh icon per file)
- [ ] Add "Clear Cache" button in settings
- [ ] Expiry policy: evict after 7 days or when IndexedDB exceeds 500MB

### 7.3 Sidecar Pre-Computation (sardine-index)

For known buckets, pre-compute all the expensive artifacts server-side and store as JSON sidecars alongside the HDF5 files.

**Sidecar format:** `{filename}.sardine.json`
```json
{
  "version": "1.0",
  "source": "NISAR_L2_PR_GCOV_015_006_A_024_2000_SHNA_A_20250101T000000_20250101T000015_S_001_v1.0.h5",
  "size": 4294967296,
  "checksum_sha256": "abc123...",
  "datasets": [
    {
      "path": "/science/LSAR/GCOV/grids/frequencyA/HHHH",
      "shape": [16704, 16272],
      "dtype": "float32",
      "chunks": [512, 512],
      "chunk_index": [
        {"row": 0, "col": 0, "offset": 8388608, "size": 1048576},
        ...
      ]
    }
  ],
  "bounds": [-76.5, -12.5, -75.0, -11.0],
  "crs": "EPSG:4326",
  "stats": {
    "HHHH": {"min": 0, "max": 0.85, "mean": 0.012, "p2": 1e-5, "p98": 0.15, "histogram": [...]},
    "HVHV": {"min": 0, "max": 0.32, ...}
  },
  "overview_tiles": {
    "HHHH": {"width": 256, "height": 256, "encoding": "base64_float32", "data": "..."}
  }
}
```

**Generator CLI tool:** `sardine-index`
```bash
# Index a single file
npx sardine-index ./path/to/file.h5

# Index an entire S3 bucket (parallel)
npx sardine-index s3://nisar-oasis/GCOV/ --workers 8 --output ./index/

# Index with pre-rendered overview tiles
npx sardine-index s3://nisar-oasis/GCOV/ --overviews --bands HHHH,HVHV
```

- [ ] Create `tools/sardine-index.mjs` CLI
- [ ] Reuse `h5chunk.js` + `stats.js` in Node.js (already pure JS)
- [ ] Support local files and S3 URLs (with `@aws-sdk/client-s3`)
- [ ] Output `.sardine.json` sidecars next to each `.h5` file
- [ ] Parallel worker pool for bucket-scale indexing
- [ ] Update `nisar-loader.js` to check for sidecar before parsing

### 7.4 Pre-Rendered Tile Server (sardine-tileserver)

For maximum performance: pre-render all zoom levels as COG pyramids or tile sets.

**Architecture:**
```
S3 Bucket (NISAR .h5 files)
        │
        ▼
  sardine-batch (Node.js worker)
        │
        ├── Parse metadata (h5chunk)
        ├── Read all chunks
        ├── Apply dB scaling + default colormap
        ├── Generate COG pyramid (overview levels)
        └── Write rendered COG alongside source
                │
                ▼
       S3 Bucket (rendered COGs)
                │
                ▼
        SARdine browser app
        (loads COG via geotiff.js — instant)
```

**This is a separate app/service.** Recommend splitting into its own package:

```
sardine-tools/
├── packages/
│   ├── sardine-index/        # Sidecar JSON generator
│   │   ├── bin/cli.mjs
│   │   ├── src/indexer.mjs
│   │   └── package.json
│   ├── sardine-batch/        # Pre-render to COG
│   │   ├── bin/cli.mjs
│   │   ├── src/renderer.mjs  # Reuses sardine's loaders + CPU colormap
│   │   ├── src/cog-writer.mjs
│   │   └── package.json
│   └── sardine-cache/        # Browser IndexedDB cache (shared lib)
│       ├── src/index.js
│       └── package.json
└── package.json              # Monorepo root (npm workspaces)
```

**Why separate from the main app:**
- Runs in Node.js (no browser, no WebGL needed)
- Can run in Docker, Lambda, or EC2 batch
- Heavy I/O workload (reads entire files, not just viewport chunks)
- Different dependency profile (@aws-sdk, worker_threads)

- [ ] Scaffold `sardine-tools/` monorepo
- [ ] Implement `sardine-index` CLI (sidecar generation)
- [ ] Implement `sardine-batch` CLI (COG pre-rendering)
- [ ] Add `sardine-cache` shared lib (IndexedDB for browser)
- [ ] Wire browser app to consume sidecars + cache
- [ ] Document bucket-scale workflow in README

### 7.5 Bucket Catalog & Multi-File UX

Once caching/pre-rendering is in place, the browser app needs UX for browsing multiple files.

- [ ] Scene catalog panel (already exists: `SceneCatalog.jsx`) — wire to sidecar index
- [ ] Thumbnail grid from cached overview tiles
- [ ] Prefetch next/previous scene sidecars during idle
- [ ] "Load all frequencies/polarizations" button (loads HHHH + HVHV + VVVV from one file into cache)
- [ ] Time-series scrubber if files have temporal ordering

### 7.6 Advice: Recommended Approach for Pre-Rendering a Bucket

**For a bucket with ~100-1000 NISAR GCOV files, here's what I'd recommend in order:**

**Step 1 — Sidecar indexing (biggest bang for buck)**
Pre-compute `.sardine.json` for every file. This eliminates the 2-5 second metadata parse on every load. The sidecars are tiny (~200KB each) and can live next to the files in S3. The browser fetches the sidecar in one request instead of parsing 8MB of HDF5 metadata.

**Step 2 — Browser IndexedDB cache**
Cache chunk indices and stats in the browser so repeat visits are instant. This is pure client-side, no server changes needed. Works even if sidecars aren't deployed.

**Step 3 — Pre-rendered overview COGs (optional, for browsing)**
For a catalog/thumbnail experience, pre-render low-resolution COGs (256x256 per band, all pols). These load in <100ms via geotiff.js. Only needed if you want a "browse the bucket" gallery view.

**Step 4 — Full pre-rendered COGs (optional, for speed)**
Pre-render multi-resolution COG pyramids with default rendering (dB, grayscale). The browser loads these as regular COGs — instant display at any zoom. Downside: rendering parameters are baked in (can't change colormap without re-rendering). Best for "quick look" mode alongside the interactive HDF5 path.

**Don't do:** A traditional tile server (pmtiles, xyz tiles). The files are too large and the rendering parameters change too often. COGs + client-side rendering is the better fit for SAR data.

---

## Tracking

| Phase | Items | Status |
|-------|-------|--------|
| Phase 1 — Critical data corruption | 6 | Not started |
| Phase 2 — Pipeline safety | 8 | Not started |
| Phase 3 — App robustness | 10 | Not started |
| Phase 4 — Architecture | 6 | Not started |
| Phase 5 — Dev tooling & tests | 4 | Not started |
| Phase 6 — Validation & UX | 4 | Not started |
| Phase 7 — Cache & pre-render | 6 | Not started |
| **Total** | **44 work items** | |

---

*Generated from comprehensive code review on 2026-02-23.*
