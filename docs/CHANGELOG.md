# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Basemap mode** (W033) — a projected scene (UTM COG, streamed NISAR GCOV) is drawn on a
  Web Mercator MapLibre basemap through warped tile meshes: each lon/lat map tile projects
  a small vertex grid into the image CRS, reads the pixel window through the scene's own
  `getTile`, and hands `SARGPULayer` a `mesh` so the GPU does the warp and source pixels
  are never resampled on the CPU. Toggle in Display; styles Positron (default), Bright,
  Liberty, Dark via OpenFreeMap (keyless). Needs a scene with `worldBounds` + `crs` and a
  bbox-driven `getTile` (RGB composites, VRTs, NISAR); the single-band tiled COG path is
  not yet wired
- **Context layers in map mode** — Overture overlay moved to live 2026-09-23 tiles with
  viewport-driven fetching (`OvertureTileLayer`); a global Buildings theme from the VIDA
  Google+Microsoft+OSM PMTiles; GHS-POP 2021 population density as a raster overlay under
  the scene (`raster-overlay.js`)
- **Exposure core** (`src/utils/exposure.js`) — people (GHS-POP COG) and buildings
  (PMTiles footprints) under a polygon, computed client-side from the data files; the
  reproject demo page queries it on click. `MapViewer` gains `onClick`, `extraLayers`,
  `rasterOverlays`, `layerProps`, `tileVersion` props
- Compact header strip
- **Data opacity** slider in Basemap mode — the scene's opacity over the basemap, so
  roads, rivers and labels can show through the SAR layer

### Fixed
- Load panel no longer stays pinned at 100% after a local GeoTIFF drop, COG band switch,
  mosaic append, or NITF load/segment switch. Those paths marked 100% without resetting
  the progress surface the W030 panel keys on; progress now resets once a load has settled
- Basemap mode draws local GeoTIFFs that are not COGs (tiled or stripped, no overviews —
  e.g. a GCOV band exported from SARdine). The local loader read these whole for the
  native view but answered every `getTile` with null, so the warped map tiles came back
  empty. Tiles are now cut out of the in-memory raster (`resampleWindow`: box-average when
  shrinking, bilinear / nearest-for-class-maps when growing, NaN and nodata never blended)
- **Production builds could not decode COGs** — the README demo on GitHub Pages opened
  the scene and then showed nothing, with no error. `@developmentseed/geotiff` declares
  `sideEffects: false`, so rollup dropped the bare import in the decode-worker shim and
  emitted a 1-byte worker: eight workers with no code, every tile decode waiting forever.
  The dev server does no tree-shaking, which is why it never showed locally. A resolve
  plugin keeps that module's side effects, and `npm run build` now fails if any worker
  chunk is empty (`test/check-dist.mjs`) so a Pages deploy can't ship it again

## [1.0.0-rc.5] - 2026-10-06 — deck.gl 9.4 / luma.gl 9.4 migration

### Changed
- **deck.gl 9.4 / luma.gl 9.4** (W034) — the rendering stack moves off deck.gl 8.9 and
  luma.gl 8.5. Custom layers (`SARGPULayer`, `OpticalPeekLayer`) build their `Model` on
  the luma `Device`, carry scalar uniforms in std140 uniform blocks declared by shader
  modules (`sarUniforms`, `opticalPeekUniforms`; the GLSL block is generated from the
  same list as the JS types so they cannot drift), and bind textures through
  `model.setBindings`. Raw WebGL2 R32F textures are kept — the FBO speckle pass,
  pixel-mode filter toggles and the W033 mesh path all work on the handle — and are lent
  to luma.gl as borrowed-handle textures for binding only. Blend/depth parameters use
  luma's string form; the viewer's clear color is now a View prop; `glOptions` →
  `deviceProps.webgl`. `BitmapLayer.textureParameters` takes luma sampler props.
  `@deck.gl/mapbox` (interleaved MapLibre overlay) is installed for the W033 map frame.
  Rendering verified in-browser: single-band, RGB composite, colormap band, speckle FBO,
  Optical Peek, compare grid; console clean

### Fixed
- `vite.test.config.js` targets es2022 like the main config, so the test/demo pages start
  with the `@developmentseed/geotiff` LZW codec (top-level await) in the tree

## [1.0.0-rc.4] - 2026-10-06 — Colormap band; Copy scene for agent

### Added
- **Colormap band** — a second colormap stretched over its own value range. Pixels whose
  display value (dB when dB scaling is on, else linear) falls inside `[min, max]` take the
  band's colormap and contrast; everything else keeps the base colormap. Lets a narrow
  backscatter regime (river ice, open water) be pulled apart without washing out the rest
  of the scene. Runs in the SARGPULayer shader (single-band mode; RGB composites ignore
  it) with a matching CPU fallback. Deep link `band=min,max[,cmap[,r]]`; the export
  sidecar records the band when applied; figure export draws it as an inset on the
  colorbar. Settings persist while the band is toggled off
- **Copy scene for agent** (command palette) — the push half of the agent bridge: the
  current canvas and a Markdown grounding brief (product, polarization, CRS, bounds,
  pixel spacing, render state, open questions) go to the clipboard as one card for
  pasting into any chat. Source URLs are reduced to origin + path so presigned
  credentials and Earthdata tokens never leave, the same rule as deep links

### Fixed
- Scene grounding no longer reports the NISAR polarization picker's default (HHHH) for
  COGs and VRTs; the polarization comes from the product (VRT band description or source
  filename) or is left unknown

## [1.0.0-rc.3] - 2026-10-05 — COG streaming 3–4× faster: tile-aligned reads, worker decode

### Changed
- **COG streaming moved onto `@developmentseed/geotiff`** (W032) — the standalone reader
  under deck.gl-raster, used without its deck.gl 9 layers. URL COGs (the README hero link,
  `?cog=` composites, `?compare=` panels) now read whole internal tiles as coalesced range
  requests, decode them in a worker pool, and keep decoded tiles in a 256 MB LRU shared
  across viewport tiles, so neighbouring tiles no longer re-inflate the same data and the
  main thread stays free while panning. Overview selection and nearest/bilinear resampling
  reproduce the geotiff.js formulas, so rendered output is byte-identical (parity test on
  the demo COG). Measured on the Hugging Face hero pair, cold: first screen 4.1 s → 1.1 s,
  pan 5.7 s → 1.3 s, same bytes. geotiff.js remains for metadata, local drops, VRT sources
  and the single-COG `loadCOG` path (next phases)
- Raw GeoTIFF export of a URL COG reads only each stripe's window instead of the whole
  raster per stripe

### Build
- Vite targets `es2022` (top-level await in the reader's LZW codec) and emits workers as
  ES modules with inlined dynamic imports

## [1.0.0-rc.2] - 2026-09-23 — GDAL VRT support, Earthdata auth that works, OPERA RTC-S1, h5chunk fixes

### Added
- **GDAL Virtual Rasters (`.vrt`)** (W031) — open a VRT anywhere a COG opens: `?url=` /
  `?cog=` deep links, the pasted-URL box, the bucket browser, or a local drop. Streams
  lazily: each tile, export stripe or pixel probe reads only the overlapping source
  windows, from each source's own overview, and composites them with GDAL's semantics
  (later sources win, nodata is see-through). Supports `SimpleSource` / `ComplexSource` /
  `AveragedSource`, `SrcRect`/`DstRect` scaling, `NODATA`, `ScaleRatio`/`ScaleOffset`,
  and relative, `/vsicurl/`, `/vsis3/` and `/vsigs/` paths. Warped VRTs, pixel functions
  and driver subdatasets are rejected with a message naming what isn't supported.
  Tested pixel-for-pixel against GDAL's own rendering of GDAL-built fixtures
- **VRT band stacks as RGB composites** — a `gdalbuildvrt -separate hh.tif hv.tif` stack
  opens as dual-pol RGB. Band polarization comes from `<Description>` or the source
  filenames (`…_HH.tif`, `OPERA_…_VH.tif`), since `-separate` writes no descriptions
- **Local VRTs with absolute source paths** — a VRT built on the data machine references
  `/mnt/…/scene.tif`, which a browser can't open. The app now says how many sources are
  missing and where the VRT expects them, and takes the folder either by dragging it onto
  the page or via **Choose source folder…**. Files are looked up by name, never by
  listing the folder; the folder can be the sources' own or any ancestor, and it is
  remembered for the session so every other VRT from the archive loads directly
- **OPERA RTC-S1 in CMR search** — `OPERA_L2_RTC-S1_V1` and `-STATIC_V1`, COG-native and
  per-polarization, opened as COGs rather than via the metadata-only `.h5` sibling

### Changed
- VRT sources without overviews get **synthetic overviews**: decoded once and kept as
  block-averaged 8×/16×/… levels (nodata excluded, 256 MB cache), so zoomed-out views stop
  re-decoding whole files. Big local mosaics resolve sources on demand, read small files
  whole, and auto-contrast from a bounded sample — a 140-source, 941 MB mosaic on an
  NTFS/FUSE archive loads about as fast as GDAL renders it
- `powerBandStats` (`stats.js`) and `rgbContrastFromBandStats` (`sar-composites.js`) are
  shared by the COG-list and VRT composite paths instead of living inline in each
- The histogram no longer recomputes while a scene is still streaming — each recompute
  issued its own tile reads that competed with the load, and every result was superseded
- h5chunk keeps 8 read-ahead windows instead of one: 3.4× fewer requests, 45% less data
  and 36% faster metadata on a 156-dataset GCOV
- One full-load threshold (`SARDINE_FULL_LOAD_MAX`) replaces two duplicated 500 MB
  constants, ahead of dropping h5wasm

### Fixed
- **Earthdata tokens** — one token store for the whole app (panels no longer disagree);
  the token is read at load time, not when the scene was selected; catalog loads send it
  and say when it's missing; validation is local (the old endpoint rejected valid user
  tokens as "invalid_token"); a 401 reports which token the server rejected
- **EDL-protected COGs** (e.g. OPERA) vanished mid-load: geotiff.js can't send headers, so
  the token has to stay in the URL, and the COG branch was stripping it
- A cancelled NISAR load is reported as cancelled, not as a failure
- h5chunk: v2 group links are parsed by a validated probe instead of a guessed padding
  (string data had been read as a file offset); a local heap whose data lies beyond the
  metadata prefetch is fetched instead of reporting the group as empty
- The loading overlay no longer stays at 100% after a VRT load (other local-file loaders
  still end the same way — tracked in W031's findings)

### Notes
- Known, not fixed here: the scale bar reads pixel units as metres for pixel-space
  loaders (local TIFs, VRTs), and the fit-to-scene zoom assumes a 1000 px viewport, so a
  tall mosaic opens with its top cut off

## [1.0.0-rc.1] - 2026-09-11 — UI/UX wave A: enforced design tokens, UI primitives, honest load feedback

The chrome gets a design system that can't drift, a reusable component layer, and
a load path that tells you what it is doing. From a full UI/UX audit of the app at
`1bc6ae4` (see `docs-internal/plan/W027`–`W030`).

### Added
- **Design tokens v2** (W027) — a warm-neutral instrument ramp replaces the ad-hoc
  values, with the muted step pinned to the measured AA floor (4.53:1 on the worst
  surface; the previous `--text-muted` failed at 3.45–4.19 and was used ~65 times at
  9–12px). Adds the wholly missing type scale (6 sizes, 11px floor, all rem — there
  was no `--font-size-*` token at all, and 31 ad-hoc sizes), a spacing scale with the
  low end the dense UI actually uses (2/6/12px), and a z-scale
- **`test/unit/theme-mirror.test.mjs`** — asserts every `DARK`/`LIGHT` key in
  `theme-tokens.js` resolves to the same hex as the CSS, and that every `var()` the
  stylesheet references is defined. Drift now fails the build; its absence is why the
  JS/CSS "single source of truth" had silently diverged on all 10 surface/text values
- **`npm run lint:tokens`** — fails on bare hex in JSX style objects, px font sizes,
  and sub-AA ink used as text. Wired into `npm test`
- **UI primitives** (W028) — `src/components/ui/`: `Button`, `Field`, `Section`,
  `Panel`, `Toolbar`, `Dialog`, token-pure and test-enforced. `Field` generates an id
  and wires `htmlFor`↔control, so a caller cannot produce an unlabeled input
- **Real per-chunk load progress** (W030) — `loadNISARGCOV` takes `onProgress` and
  reports actual chunk counts and byte totals from the decode pool, replacing a binary
  spinner on the longest operation in the app
- **Honest cancellation** (W030) — a load-scoped `AbortController` that stops the
  transfer, not just the UI. Deliberately separate from the per-tile deck.gl signal,
  which must never be forwarded into `readChunksBatch` (see W003)
- **A real empty state** and a working mobile sheet drag — the handle advertised
  `cursor: grab` with no drag implemented

### Changed
- The global `button` rule is no longer a primary CTA. It was a solid accent fill that
  every non-CTA button had to fight inline — the direct cause of 232 inline style
  blocks in `main.jsx` and of one class needing `!important` twice to escape it.
  `Button` now defaults to the quiet `secondary` variant, so the UI has hierarchy
- Errors accumulate and stay dismissible instead of one `setError` string being
  overwritten by the next across a dozen concurrent async paths
- Fonts load via `preconnect` + `link` with real system fallbacks instead of a
  render-blocking CSS `@import` of 4 families × 5 weights
- MapLibre CSS now comes from the local package. It was pinned to 4.0.0 on a CDN while
  `package.json` resolved 4.7.1 — a version skew and a network dependency in a tool
  whose pitch is "no server required"

### Fixed
- **One theme file.** `app/theme/` and `src/theme/sardine-theme.css` were byte-identical
  and *both* live — the app imported one, the benchmarks and a structural test asserted
  the other, so a theme edit silently diverged them
- `var(--text)` and `var(--border)` were referenced 17 times and defined nowhere
- `var(--radius-sm, 6px)` / `var(--radius-md, 8px)` fallbacks contradicted the real
  2px/3px tokens, so any fallback path rendered 2–3× the intended roundness
- Removed dead `drawMetadata()` — ~90 lines rendering from the stale token palette.
  It had no callers; the metadata box was intentionally dropped from exports in favour
  of the `.tif.json` sidecar
- `test/unit/fixtures/synthetic-gcov.h5` is committed. `.gitignore`'s `*h5` had
  swallowed it, so the W030 tests failed with `ENOENT` anywhere but their branch

### Notes
- Accessibility (W029) is **not** in this release. Its branch was cut from `main`
  rather than from the primitives, so its fixes target components W028 had already
  rewritten. It is being redone against this release so the aria/focus work lands
  inside `Button`/`Field`/`Dialog` once, rather than per-component
- The W027 z-scale is aspirational: the shell really stacks at 900/1000/1001/1010,
  above the scale's 700 ceiling. The footer, status pull-tab and status window keep
  literal z-indexes until the scale is corrected

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
