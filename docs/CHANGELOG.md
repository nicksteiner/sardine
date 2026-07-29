# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.10] - 2026-07-29 — Vector figure export, compare deep links, EDL whoami fix

### Added
- **Editable-vector SVG figure export** — figure export can now emit SVG
  alongside PNG. A canvas-command recorder (`svg-recorder.js`) captures the
  figure chrome (scale bar, coordinate grid, colorbar, labels) as real vector
  text and paths with the rendered raster embedded, so exported figures stay
  editable in Illustrator/Inkscape. Both formats share one draw path via a
  common render-target seam in `figure-export.js`
- **Figure style presets** (`figure-style.js`) — exported figures get a house
  style separate from the app's dark UI theme: `publication` (default — warm
  white ground, near-black ink, hairline open chrome, halo text casing) and
  `dark` (the legacy on-screen look for slides/projectors). Chrome now scales
  with figure size (`makeScale`) instead of devicePixelRatio
- **Multi-panel compare deep links** — `?compare=` takes up to 4 comma-separated
  COG URLs (each optionally `label~url`) and opens them as a synced compare
  grid. `cog-loader` now accepts URL sources directly (geotiff.js `fromUrl`,
  HTTP Range), and the class-map palette/label pipeline works for remote COGs,
  not just dropped files
- **Geographic co-registration in the compare grid** — panels re-frame their
  render quads into geographic bounds, so files with different resolutions or
  extents co-register under the shared view (same-CRS overlap; no reprojection).
  Scale bar and coordinate overlays become geographically correct in compare
  mode. Class panels seed their legend from embedded class names the instant
  they load, plus optical peek support in compare panels
- **W010 design gate** — `SESSION_SCHEMA.md` + JSON Schemas for
  SARScene/RenderConfig/SessionState with a no-dependency validator (the
  contract for the main-app store extraction)
- **W012a design doc** — `sardine-figure` STAC extension for self-describing
  class-map figure COGs with deep-link resolution
- **README hero is now a live deep link** — the front-page screenshot opens the
  equivalent view streamed from the ASF archive: CMR resolves a NISAR GCOV
  granule over the Amazon floodplain and streams the single-pol HH backscatter
  for the region (kept single-pol deliberately — the lightest first-click load)

### Fixed
- **EDL proxy `/whoami` rejected valid tokens** — Earthdata Login's user API
  now requires the username in the path (no `/api/users/user` alias) and a
  `client_id` query param; bare bearer requests get `invalid_token`. The Worker
  (v0.1.1) decodes the uid from the JWT payload and calls
  `/api/users/<uid>?client_id=…`, so the "Test token" button validates fresh
  tokens again. Requires a `wrangler deploy` of `sardine-edl-proxy`

## [1.0.0-beta.9] - 2026-07-13 — Classification maps in comparison panels

### Added
- **Class-map rendering in the compare grid** — comparison panels now render
  classification GeoTIFFs (integer land-cover/segmentation labels) with one
  exact color per class. A new GPU path in `SARGPULayer`/`shaders.js` adds a
  `classMode` uniform and a 256×1 RGBA palette texture: the fragment shader
  NEAREST-samples the label, floors to a class index, and looks up its color in
  the palette (bypassing dB/stretch/colormap; 0/NaN → transparent). The CPU
  `SARBitmapLayer` gains a matching `createClassTexture` path with NEAREST
  filtering for plain (non-COG) TIFs. Props thread through `SARViewer` →
  `SARTileLayer` → `SARGPULayer` (`classMode`/`classPalette`/
  `classPaletteEntries`)
- **Embedded palette + class-name extraction** — `cog-loader.js` reads a palette
  GeoTIFF's TIFF `ColorMap` (`extractColorTable`, 16-bit→8-bit) and class labels
  from `GDAL_METADATA` (`extractClassNames`: indexed `CATEGORY_NAMES_<n>`,
  `role="category"` sample items, and delimited `CLASS_NAMES` lists). Categorical
  rasters are auto-detected (`looksCategorical` / presence of a color table) and
  the compare panel enables class mode on load, with a **Classes** toggle to
  override. Files without an embedded table fall back to deterministic `label`
  colormap colors (`test/unit/class-map.test.mjs`)
- **Per-panel class legend** — each class-map panel shows a collapsible legend
  listing the classes present in the current view — color swatch + name (or
  "Class N") — recomputed on pan/zoom by sampling the visible tiles

### Fixed
- **Class-boundary color fringing** — categorical COGs read overviews with
  NEAREST resampling instead of bilinear, which was blending integer class
  indices across boundaries and painting phantom classes along every edge
- **Band description misread as a class name** — `extractClassNames` skips
  `role="description"` items (a per-band raster title, not a class-0 label)

## [1.0.0-beta.8] - 2026-07-13 — Optical peek detail atlas + ML NaN hardening

### Added
- **Optical peek detail atlas (W026)** — the optical overlay now tracks the
  viewport: a second, screen-density-matched atlas rebuilds on debounced
  pan/zoom up to the provider's max resolution (z19 ≈ 0.3 m/px), with parent-
  tile overzoom fill where coverage ends, an LRU tile cache, bounded fetch
  concurrency, and per-provider `maxZoom` (`src/layers/OpticalPeekLayer.js`,
  `src/utils/optical-peek-math.js`, `test/unit/optical-peek-math.test.mjs`)

### Fixed
- **Optical peek mis-registration near invalid warp nodes** — hardware LINEAR
  filtering blended the (-1,-1) invalid-node sentinel into wrong-but-positive
  atlas UVs (and RG32F LINEAR needs an optional extension); the shader now
  interpolates the warp manually via texelFetch and rejects cells touching an
  invalid node
- **Optical peek at polar latitudes / long-thin scenes** — grid nodes beyond
  Web Mercator's ±85.05° are masked instead of requesting nonexistent tiles;
  the atlas zoom now steps down to honor a per-axis tile cap so strip-shaped
  scenes can't exceed the browser's max canvas dimension
- **ML NaN-poisoned model guards (W025 hardening)** — training and inference now
  refuse non-finite parameters at every gate: `computeStandardizer` throws on a
  non-finite feature sample, `trainLogistic` throws on a diverged weight,
  `predictLogistic`/`buildHeadManifest` assert finiteness before use, and
  `validateManifest` rejects non-finite `weights`/`mean`/`std` (NaN serializes
  to `null` in JSON, so a bad artifact could otherwise register and predict a
  silent two-valued map) (`src/ml/trainer.js`, `src/ml/manifest.js`,
  `src/ml/registry.js`)

## [1.0.0-beta.7] - 2026-07-13 — Activity rail UI + EDL trust hardening + GPU track plan

### Added
- **Activity rail** — VS Code-style icon rail switches the control panel between
  groups (one visible at a time; re-click collapses); on mobile (≤768px) it becomes
  a bottom tab bar with the controls as a bottom sheet
  (`src/components/ActivityRail.jsx`)
- **Viewer context menu** — right-click/long-press menu on the viewer, driven by the
  command-palette action registry (viewport clamping, keyboard navigation)
  (`src/components/ContextMenu.jsx`)
- **GPU audit + horizon report** (internal notes: `docs-internal/GPU_AUDIT_AND_HORIZON_2026-07.md`) and the
  GPU-track work orders W018–W024 (capability probe, GPU export parity, subgroup
  histogram, compute pyramid, shader module chain, wrapped-phase toolkit, ML
  inference substrate); W012 gains a chunk-manifest interop component

### Changed
- **EDL token trust hardening** — self-host docs, in-UI disclosure, header transport
- README: NYC deep-link examples for the hosted build

## [1.0.0-beta.6] - 2026-07-10 — Wave 0/1 work-order batch + DAAC demo hardening

Executed as machine-verifiable work orders (internal work orders W001–W017) by parallel
worktree agents against acceptance criteria; strategy in the internal platform review.
Also merges the July WIP feature set. (The ATBD/SPA demo-apps line — D582/D106 —
is deferred to the next release; tracked internally as W014.)

### Added
- **Region-first deep links** (W017) — `?bbox=w,s,e,n` (or `wkt=`) with no granule
  resolves its own data: client-side CMR spatial search (VALIDATED → PROVISIONAL →
  BETA), footprint-coverage ranking (full-frame > partial, dual-pol, newest),
  auto-load of the winner; `t=start/end` date filter (`src/utils/granule-resolve.js`)
- **Spatial-subset deep links** (W016) — `bbox`/`wkt` params fit the view, apply the
  ROI, and scope chunk prefetch + refinement to the region (verified: 6 of 64 chunks
  for a small AOI); Copy Link emits the active ROI as `bbox=`
- **Deep-link auto-load** — links carrying a region skip the remote-NISAR
  click-to-load guard (bounded fetch); the region ROI survives scene load
- **NISAR demo runbook** (`docs/DEMO.md`) — verified end-to-end walkthrough against
  live ASF DAAC data (Chesapeake Bay dual-pol granule), FreqA caveats, CMR recipes
- **DAAC streaming hardening** — dev-proxy presigned-URL cache (OAuth chain resolved
  once per scene), keep-alive agents (removes per-Range TLS cost), EDL token attach
  for pasted URLs, overview mask-fetch deferral, latency-aware concurrency
- **Markup GeoJSON save/load** (W004) — annotations, ROI, transects, and classifier
  regions serialize as a GeoJSON FeatureCollection with a versioned properties schema
  (`sardine:kind`, observer/method/created/confidence, `sourceScene`, embedded ROI
  measurements); round-trip import incl. drag-drop; unknown properties preserved
  (`src/utils/annotation-io.js`)
- **Export provenance sidecar** (W005) — every GeoTIFF export writes `{output}.tif.json`
  with verbatim product identification, georeference, render state, and `derived_from`
  lineage (`src/utils/export-sidecar.js`)
- **Granule deep links** (W008) — `?url=<granule>` auto-load with render params
  (colormap/contrast/dB/stretch/pol/freq/composite/view); "Copy Link" reproduces the
  view; post-load guards keep deep-link contrast from being clobbered by auto-contrast
  (`src/utils/deep-link.js`, `docs/DEEP_LINKS.md`)
- **Decode worker pool** (W006) — HDF5 chunk inflate+shuffle in transferable-buffer
  Web Workers, lazy min(4, cores), bit-exact sync fallback
  (`src/loaders/decode-core.js`, `decode-worker.js`, `decode-pool.js`)
- **IndexedDB L2 chunk cache** (W009) — ~200 MB LRU persistent cache under the
  in-memory L1, probed by all five batch-fetch paths; repeat sessions on the same
  remote scene avoid refetching (`src/loaders/chunk-cache-idb.js`)
- **Behavioral unit-test suite** (W001) — `npm run test:unit`: GeoTIFF write/read
  round-trip (bit-exact Float32), stats, WKT/ROI, synthetic HDF5 fixtures; auto-
  discovering runner (`test/unit/`)
- Compare-grid NISAR panels (per-panel freq/pol), transect line + profile panels,
  ROI profile sidebar, annotation size presets, RVI SAR index (July WIP)

### Changed
- **GPU histogram wired into the UI** (W007) — all seven stats call sites route
  through WebGPU compute with CPU fallback; viewport debounce 800 ms → 100 ms when
  WebGPU is active; one-time "histogram: WebGPU/CPU" status log
- Adaptive concurrency ignores aborted batches (`Promise.allSettled`) so AbortErrors
  no longer decay throughput (W003)
- `MERGE_GAP` hoisted to an exported, test-guarded 2 MB constant (W009)

### Fixed
- Deep-link region ROI was wiped by the scene-change cleanup effect the moment the
  raster committed (orange box flashed and vanished); ROI rectangles are now
  bounds-only (interior fill removed on screen and in figure exports)
- `cmr-client.js` no longer appends `T00:00:00Z` to full ISO datetimes (W017)
- **Single-tile RGBA GeoTIFF corruption** — `writeIFD` wrote a placeholder 0 for
  inline TileOffsets on images ≤512×512 (W001)
- **Signal-abort cascade** — tile aborts no longer cancel chunk reads (cache always
  warms); tile-level abort check re-plumbed through SARViewer (W003)
- **Silent all-zero chunk decode** when `Worker` is unavailable; lost
  deflate→shuffle+deflate retry on the worker path (W006)
- **h5chunk superblock v0/v1 misparse** — default-settings h5py files opened with
  zero datasets (root symbol-table entry's `linkNameOffset` read as the root group
  address); v0 fixture + 6 regression tests (W013)
- Latent `computeHistogramGPU` out-of-bounds: WGSL is compiled at 256 bins, so
  caller `numBins` is honored only on the CPU fallback (W007, guard)

### Removed
- Dead modules (W002, −1,429 lines): `SARGPUBitmapLayer.js`, `hdf5-chunked.js`,
  `ChunkedDatasetReader`, `writeLegacyRGBGeoTIFF` (+ the deprecated public
  `writeRGBGeoTIFF` export), `jest.config.cjs`; interim Cache-API chunk cache
  (`src/utils/chunk-cache.js`, superseded by W009)
- Stale `docs/API.md`/`docs/CONTRIBUTING.md` (v0.1 TypeScript API) rewritten

## [1.0.0-beta.4] - 2026-03-18

### Added
- Color deficiency support for RGB composites (deuteranopia/protanopia, tritanopia remapping via CVD color matrices in GLSL shader and CPU path)
- PNG save state — export and restore full viewer state as an embedded PNG

### Changed
- Renamed "Colorblind mode" UI label to "Color deficiency" (terminology update)

### Fixed
- Histogram clamping and rendering fixes

### Housekeeping
- Removed stale `src/SARTileLayer.js` duplicate
- Moved AWS config templates to `config/aws/`
- Added `.claude/` and `test/benchmarks/results/` to `.gitignore`
- Bumped version to `1.0.0-beta.4`; corrected license field from `MIT` to `GPL-3.0`

## [1.0.0-beta.3] - 2026-03-01

### Added
- Expanded test suite (100+ checks across loaders, composites, export, GPU layer)
- Time-series composite support
- Side-by-side figure export

### Fixed
- B-tree parsing for GUNW coherence datasets
- Histogram overlay coherence with main histogram panel
- Histogram skip logic
- Concurrency errors in tile loading
- `frequencyA` RGB composite mode

## [1.0.0-beta.2] - 2026-02-18

### Changed
- Rewrote README for beta release with step-by-step usage instructions
- Added clear workflows for local HDF5 files, presigned S3 URLs, and COG URLs
- Added Node.js/npm install instructions for macOS, Windows, and Linux
- Added CORS setup guide for S3, GCS, and Azure
- Added controls reference, export documentation, and keyboard shortcuts
- Bumped version to 1.0.0-beta.2

## [1.0.0-beta.1] - 2026-02-01

### Added
- NISAR GCOV HDF5 local and remote streaming via h5chunk
- Cloud Optimized GeoTIFF loading
- GPU-accelerated dB scaling, colormaps, stretch modes (WebGL2 GLSL)
- RGB polarimetric composites (Pauli, dual-pol, quad-pol)
- Freeman-Durden decomposition
- Per-channel histogram with auto-contrast
- GeoTIFF export (raw Float32 + rendered RGBA + RGB composite)
- Figure export (PNG with scale bar, coordinates, colorbar)
- Overture Maps vector overlay (buildings, roads, places)
- MapLibre basemap integration
- State-as-markdown editing
- STAC catalog search
- Scene catalog (GeoJSON) browsing
- Multi-band and temporal COG stacking
- JupyterHub server mode (launch.cjs)

## [0.1.0] - 2026-01-31

### Added
- Initial release of SARdine
- Core `SARdine` viewer class for SAR imagery visualization
- Custom `SARImageLayer` based on deck.gl's BitmapLayer
- GeoTIFF loading and parsing utilities
- Support for ArrayBuffer and URL-based GeoTIFF loading
- Data normalization and color mapping utilities
- Viewport control methods (pan, zoom, fit bounds)
- Layer management (add, remove, update, clear)
- TypeScript type definitions
- Comprehensive documentation and examples
- Build system using Rollup
- Test infrastructure with Jest

### Features
- Lightweight architecture (no Viv dependency)
- deck.gl-powered WebGL rendering
- Native GeoTIFF support via geotiff.js
- Customizable opacity and color mapping
- Interactive viewport controls
- Multiple layer support

[0.1.0]: https://github.com/nicksteiner/sardine/releases/tag/v0.1.0
