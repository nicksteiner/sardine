# SARdine Platform Review & Strategic Direction

**Date:** July 2026
**Scope:** Full-codebase integration review · GPU/silicon utilization review · literature review of medical imaging (and adjacent fields) as a model for SAR interpretation tooling · positioning and roadmap.
**Method:** Multi-agent code review (architecture, annotation/labeling, data pipeline, GPU pipeline), full read of `docs/`, and a web literature sweep of primary sources (spec documents, project repos, society statements). Claims flagged **[verify]** should be re-checked against the cited URL before external publication.

---

## 1. Executive Summary

SARdine is a genuinely strong **rendering and streaming engine** wrapped in an increasingly strained **application shell**. The engine — h5chunk cloud-optimized HDF5 streaming, COG/NITF/SICD range reads, an 18-colormap WebGL2 shader pipeline, client-side georeferenced export — is production-quality and, per the competitive sweep, **unique**: no tool anywhere combines browser-native client-side streaming of SAR-native formats with GPU SAR rendering, and none adds annotation on top.

Three findings drive the strategy:

1. **The missing layer is a shared data model, not features.** There is no canonical scene object, no canonical render-config, and no persistence for any analysis work. SARdine has already built most of the *pieces* of an interpretation workstation (annotations, ROI stats, transects, a scatter classifier, compare grid, GUNW paired view) — but every one of them is ephemeral React state, serialized four different partial ways, and rasterized into PNGs on export.

2. **The GPU is underutilized, and the bottlenecks are CPU-architectural, not silicon.** Rendering is excellent (4–8 ms/tile, everything in fragment shaders). But pako decompression blocks the main thread 7–17 ms/chunk, histograms run on CPU behind an 800 ms debounce, and the WebGPU compute infrastructure that already exists (`src/gpu/`) is not wired into the UI. The state-of-the-art move for 2026 is **not** a WebGPU rendering migration (deck.gl 9's WebGPU backend cannot render bitmap layers yet); it is workers for decode, integration of the existing compute passes, and export-path GPU parity.

3. **Medical imaging is the right model, and the analogous EO standards ground is open.** Radiology's core insight — *the interpretation is data*: masks (DICOM SEG), structured findings (DICOM SR TID 1500), saved presentation states (GSPS), AI results as reviewable packages (IHE AIR), human-in-the-loop annotation servers (MONAI Label) — has no working EO equivalent. The STAC label extension is dormant (Pilot, last release Jan 2022); OGC TrainingDML-AI is adopted but has near-zero tooling; every EO labeling tool is radiometry-blind and CRS-blind; every SAR portal is annotation-free. With NISAR's calibrated global release happening now (~85 TB/day) and no official streaming viewer, SARdine can own the position of **the SAR reading workstation: human + AI diagnostic markup on live-streamed data**.

---

## 2. Where SARdine Stands Today

### 2.1 The engine (strengths)

| Capability | Evidence |
| --- | --- |
| Cloud-optimized HDF5 streaming, pure JS | `src/loaders/h5chunk.js` (~3,500 lines): superblock → B-tree chunk index → coalesced Range reads (MERGE_GAP merging, adaptive concurrency, 8 MB metadata page). See `docs/CHUNK_PIPELINE.md`, `docs/HDF5_FILE_FORMAT.md`. No comparable JS library exists. |
| Rich metadata extraction | `nisar-loader.js:161-381` reads 40+ NISAR identification fields (orbit, track, frame, DOI, processing flags) in parallel |
| Multi-format reads | NISAR GCOV + GUNW (HDF5), COG (geotiff.js), NITF/SICD (URLFile with Content-Range fallback), Overture PMTiles |
| GPU-first rendering | 18 colormaps, 6 stretch modes, dB conversion, per-channel RGB contrast, masking, GUNW phase-correction layers — all GLSL (`src/layers/shaders.js`) |
| Progressive streaming UX | Two-phase coarse→fine tile refinement with foreground priority gating; first paint 2–8 s from S3 (`docs/CHUNK_PIPELINE.md`) |
| Client-side export | Float32/RGBA GeoTIFF with CRS + tiepoints, figure PNG with overlays, colorbar exports (`src/utils/geotiff-writer.js`, `figure-export.js`) |
| Server mode & cloud story | `sardine-launch` with DuckDB-backed STAC API, server-side S3 presigning, Docker + titiler compose (`docs/STAC_CATALOG.md`) |
| WebGPU compute foundation | `src/gpu/webgpu-device.js`, `histogram-compute.js`, `gpu-stats.js`, `spatial-filter.js` (WGSL) + `webgl-spatial-filter.js` (FBO speckle filters) — Release 1–2 of `docs/WEBGPU_COMPUTE_ROADMAP.md` exist in code |

### 2.2 Integration debt (the shell)

**a. Monolithic state.** `app/main.jsx` is ~7,800 lines with 70+ `useState` hooks and pure prop-drilling — no context, reducer, or store. `SARViewer.jsx` takes ~97 props (`SARViewer.jsx:27-96`). `docs/AUDIT.md` flagged this in February at 2,283 lines / 22 hooks; the monolith has **tripled** since the audit named it the top code-quality issue. Every feature (compare grid, transects, ROI panels, GUNW corrections) adds parallel state clusters to the same component. ROI alone is fragmented across 8+ hooks (pixel ROI, profile, RGB overlay, time-series, WKT input — `main.jsx:545-579`).

**b. Four serialization formats, zero sessions.** Share-links (URL params), PNG state embedding (`src/utils/png-state.js`), markdown state, and the render-state clipboard (`main.jsx:4242-4350`) each capture a different partial subset of viewer state. None captures the full analysis: loaded source + render config + ROI + classifier + annotations + transects. Close the tab and the work is gone.

**c. Render logic duplicated across export paths.** No shared `RenderConfig` object: viewer shaders, `exportFigure`, GeoTIFF export, and each serializer independently re-implement dB/contrast/stretch/colormap. `serializeViewerState`/`serializeRenderState` (`main.jsx:4217-4296`) hand-copy ~30 fields. Adding one render option means touching 3–4 codepaths — the "export parity" burden institutionalized.

**d. No unified product/scene model.** Loaders converge on an ad-hoc `{getTile, bounds, crs, width, height, meta}` shape (`src/loaders/types.js:59-75`) with an opaque `meta`. Product metadata read at open time is **never written on export** — GeoTIFFs carry only georeferencing tags; no sidecar, no provenance, no `derived_from` lineage.

**e. Dead code and stale docs.** `SARGPUBitmapLayer.js` (exported, never instantiated), `hdf5-chunked.js` (never imported), `ChunkedDatasetReader` (`nisar-loader.js:1127-1331`), `writeLegacyRGBGeoTIFF`. `docs/API.md` and `docs/CONTRIBUTING.md` describe the original v0.1 TypeScript library and no longer match the codebase.

**f. Tests check structure, not behavior.** `test/run-tests.js` (263 checks) verifies file existence, exports, brace balance. GeoTIFF-writer and colormap tests are good; loaders, export round-trips, and GPU rendering have no automated coverage (`docs/AUDIT.md` test matrix). This is the safety net any refactor needs first.

**g. Known pipeline bugs are documented but open.** `docs/RENDERING_PIPELINE_AUDIT.md`: P0 signal-abort cascade (deck.gl aborts in-flight chunk reads during viewport stabilization → tiles fail; recommended fix: stop propagating abort signals to chunk reads and let the cache absorb them), sparse RGB overview tiles (no `buildMosaicTile` on the RGB path), adaptive-concurrency decay from AbortErrors. Security items from `docs/AUDIT.md` (unbounded B-tree recursion, >2^53 offset precision, client-side credential exposure) remain relevant.

### 2.3 Annotation & interpretation inventory (what already exists)

More is built than the roadmaps acknowledge — the problem is that none of it persists or carries semantics:

| Tool | Implementation | Data model | Coordinate space | Persistence |
| --- | --- | --- | --- | --- |
| Arrows + text labels | `AnnotationOverlay.jsx` (476 lines), shared vector renderer `annotation-render.js` | `{id, type, worldX/Y(2), text, color, size}` | World (survives pan/zoom) | **None** — React state only |
| Rectangular ROI + profiles | `ROIOverlay.jsx`, `ROIProfilePlot.jsx`, `ROIProfilePanel.jsx` (new); stats hook `main.jsx:763-862` | `{left, top, width, height}` + `{rowMeans, colMeans, hist, mean, count}` | Image pixels | None |
| Transect profiles | `TransectLineOverlay.jsx`, `TransectProfilePanel.jsx` | `{x0,y0,x1,y1}` + sampled profile | Image pixels | None |
| Scatter-plot classifier | `ScatterClassifier.jsx`, `ClassificationOverlay.jsx` | class regions in feature space + `Uint8Array` classification map | Feature space / ROI grid | None |
| WKT ROI input | `wkt.js`, `roi-subset.js` (parse/validate, bbox↔pixel, reprojection) | GeoJSON geometry | Geographic | Input-only |
| Figure export of all of the above | `figure-export.js:992-1010` draws annotations as vectors onto the export canvas | — | — | **Burned into PNG pixels** |

Gaps relative to a diagnostic-markup vision: no save/load in any form; no GeoJSON export of annotations/ROIs/classes; no polygon or freehand ROI; no measured primitives (distance/area); no semantic fields (class, observer, timestamp, confidence); no linkage between an annotation and the statistics computed under it; classification maps are bare uint8 with no class table on export.

### 2.4 sardine-agent (the AI companion)

*(Corrected after reading the active checkout at `~/sandbox/sardine-agent` — the `~/workspace` copy reviewed first is an older snapshot.)*

sardine-agent (v0.5.0) is much further along than "an MCP wrapper." It is an **AI science harness** with:

- **~46 MCP tools** across two servers (JS + Python): NISAR streaming/stats/render/export, NASA CMR search + granule ranking + download, an autonomous explorer (`sardine_explore`), Sentinel-1 burst search + HyP3 RTC/InSAR job submission, SWOT pixel-cloud reads, ICESat-2 ATL03/06/08, S3 credential resolution, and GitHub error/feature reporting (`docs/AGENT_TOOLS.md`).
- **A structured-findings system** (`.sardine/`): D-numbered experiment directives, an active hypothesis queue (27 hypotheses, 2 confirmed findings), `EXPERIMENT_RULES.md` (statistical standards, exploratory-vs-confirmatory modes, "null results are first-class"), a mandatory findings JSON schema (`{hypothesis, datasets, metrics, outcome, confidence, limitations, parent_finding_id, next_questions}`), rejected-hypotheses and amendment-proposal logs, and a PI-governed `RESEARCH_ROADMAP.md`. **This is already a working "structured report" system — the DICOM-SR analog exists here, for research findings.**
- **The Sardine Maps design** (`docs/SARDINE_MAPS.md`): forcing agent → observation swarm → synthesis agent over a DuckDB Spatial store (campaigns/chunks/events/observations/directives/reports schemas defined), humans reviewing at both ends, and full provenance ("every pixel traces back: output → observation → event → builder config → human intent"). This is the IHE AIR/AIW-I analog (AI result objects + worklists), designed but not yet built.
- **A `sardine.json` scene-sidecar schema** already at the repo root — the embryo of the metadata sidecar recommended in Phase 0.
- **An active science program** feeding papers (P3 IEEE TGRS ICEYE urban-flood double-bounce; P4 WRR HiFLOWS InSAR flood-wave celerity) across NISAR, Sentinel-1, ICEYE, SWOT, GEDI, ECOSTRESS, ICESat-2 and sites from the Congo Cuvette to the Y-K Delta.

The two structural issues that remain:

- **No shared interpretation schema with the viewer.** The agent writes findings to `.sardine/` markdown/JSON and exports GeoTIFF/GeoJSON, but nothing renders back into SARdine as annotations/overlays, and the viewer's annotations don't feed the agent. The Phase 2/3 schema work below is exactly the bridge — and the agent side already defines most of the semantics (outcome, confidence, provenance, parent links).
- **Copied, not shared, loaders.** `h5chunk.js`/`nisar-loader.js`/`cog-loader.js` are duplicated across sardine and sardine-agent (the agent's copies have since grown GUNW/GOFF/SWOT/ICESat-2 loaders the viewer lacks). The library boundary should become a single package both consume — note sardine-agent already publishes `packages/h5chunk/` as a standalone npm package, which is the natural convergence point.

---

## 3. GPU & Performance Review

### 3.1 What actually runs on silicon today

**Rendering (WebGL2, GLSL ES 300) — fully GPU, well-engineered.**

- `R32F` textures uploaded via raw `gl.texImage2D` (luma.gl 8 lacks good R32F support), NEAREST/LINEAR selectable, CLAMP_TO_EDGE, no mipmaps (`SARGPULayer.js:638-695`).
- Up to **10 simultaneous texture units** per draw: data (1–3 for RGB), mask, coherence/incidence, and four GUNW phase-correction layers (`shaders.js:388-491`).
- Per-fragment work: dB via `log2·0.30103`, 6 stretch modes, 18 colormaps (8-stop lerp or polynomial), NaN/zero/NISAR-mask/coherence masking, RGB per-channel contrast + saturation + colorblind CVD matrices. Worst case ~50–100 ops + ~10 fetches/pixel → **4–8 ms per 512² tile**; parameter changes are uniform updates (no re-upload, no re-fetch — the `stableGetTileData` + `updateTriggers` pattern).
- Speckle filtering runs on GPU two ways: WebGL2 FBO fragment passes for interactive preview (`src/gpu/webgl-spatial-filter.js` — boxcar/Lee/enhanced-Lee/Frost/Gamma-MAP, 3–15 px kernels) and a WGSL compute path with workgroup shared-memory tiling (`src/gpu/spatial-filter.js`, partially complete).

**Compute (WebGPU, WGSL) — built but not integrated.**

- `webgpu-device.js` (singleton device manager with loss handling), `histogram-compute.js` (two-pass: tree-reduction min/max + atomic 256-bin binning), `gpu-stats.js` (drop-in `computeChannelStatsGPU` with CPU fallback). **Nothing in `app/main.jsx` calls the GPU stats path yet** — the histogram UI still runs `stats.js` on the main thread behind a ~800 ms debounce.

**CPU (main thread) — where the time actually goes.**

| Stage | Cost | Status |
| --- | --- | --- |
| pako inflate + shuffle per chunk | **7–17 ms/chunk, main thread, serial** | The throughput bottleneck; network is not the limiter. No workers anywhere in the codebase. |
| Histogram/stats per tile | 1–3 ms/tile; 27–54 ms for a 9-tile viewport sample | GPU replacement already written, unwired |
| Multilook box-filter | ~1.5 ms | Fine for now; GPU multilook is roadmapped (`WEBGPU_COMPUTE_ROADMAP.md` R3) |
| Export rendering (`createRGBTexture`) | **26–40 ms/tile, per-pixel JS loops** | Entire export path re-renders on CPU instead of reading back the GPU result |
| RGB composite math (`computeRGBBands`) | 1–10 ms/tile | Cached per composite; deprioritized for now (decomposition work parked) |

**VRAM:** ~24 MB/512² tile worst-case (all correction layers); 2–4 GB at dense high-zoom cache. Adequate; texture atlases are not currently justified.

### 3.2 Ranked upgrade path to a state-of-the-art performance environment

The literature review's bottom line (§4.4) supports the architecture SARdine already chose: **WebGL2-primary rendering + feature-detected WebGPU compute** is the correct 2026 posture. WebGL2 reaches ~96% of browsers including Linux workstations (disproportionately common among SAR users); deck.gl 9.2's WebGPU backend is an explicit "Early Preview — not production ready" and **cannot render bitmap layers, picking, post-processing, or basemap interleaving** ([deck.gl WebGPU guide](https://deck.gl/docs/developer-guide/webgpu)). Production WebGPU adoption industry-wide is compute-led (Figma, Google Meet, ONNX Runtime Web), always with fallback.

Priority order (decomposition/PolSAR ports intentionally excluded — parked):

1. **P0 — Fix the signal-abort cascade** (`RENDERING_PIPELINE_AUDIT.md` BUG 1): stop propagating tile abort signals into `readChunksBatch`/`readRegion`; let chunk reads complete and cache. Also stop counting AbortErrors in adaptive-concurrency throughput (BUG 3). This unblocks the S3 streaming experience and costs a few lines.
2. **Worker pool for chunk decode.** Move pako inflate + shuffle (and ideally h5chunk chunk decode) into 2–4 Web Workers with transferable ArrayBuffers. This is the single biggest interactivity win: decompression currently blocks pan/zoom frames. The Zarr world's `numcodecs.js`/zstd-WASM-SIMD pattern is the reference; DICOM viewers do the same with HTJ2K/OpenJPH WASM-SIMD decoders.
3. **Wire the existing GPU histogram into the UI.** Replace the debounced CPU stats with `computeChannelStatsGPU` (fallback already handled). Result: real-time histogram + auto-contrast on every viewport change — a visible "wow" for demos and the enabler for live threshold exploration.
4. **GPU export parity.** Export currently re-renders on CPU (26–40 ms/tile through `createRGBTexture`). Render export tiles through the same WebGL2 pipeline into an FBO and `readPixels` once — removes the largest remaining CPU pixel loop and guarantees screen/export visual identity (a repeated source of bugs, e.g. the duplicated plasma coefficients flagged in `AUDIT.md` #5).
5. **Finish the WGSL spatial-filter set + threshold/mask compute.** Boxcar/Lee exist in WGSL; complete Frost/Gamma-MAP, then add the interactive **threshold + pixel-count compute pass** (flood area live readout — `WEBGPU_COMPUTE_ROADMAP.md` R4 and the inundation shader modes in `MULTI_PRODUCT_ROADMAP.md`). This is the compute pass that directly powers the interpretation features in §6.
6. **In-browser ML inference via ONNX Runtime Web (WebGPU where available, WASM fallback).** SAM-style interactive segmentation over streamed SAR tiles is the concrete near-term AI-assist win (see §5) — 3–10× faster on WebGPU vs WASM per Microsoft's ORT-Web numbers.
7. **IndexedDB L2 chunk cache** (`CHUNKING_USABILITY_REVIEW.md` gap 3) + raise MERGE_GAP to 2–4 MB (`CHUNK_PIPELINE.md`): cheap streaming wins for repeat sessions.
8. **Defer:** deck.gl 9 / luma.gl 9 migration (revisit when WebGPU exits Early Preview and Firefox ships Linux WebGPU — realistically 2027–2028); f16 textures; OffscreenCanvas rendering workers; texture atlases.

---

## 4. Literature: How Mature Imaging Fields Solved This

### 4.1 The medical imaging mechanism set

What made radiology's ecosystem work is that **every interpretation artifact is a standardized, persistable object that references the source image**:

- **DICOM SEG** (Sup 111) — per-pixel segmentation masks as first-class objects. [spec](https://www.dicomstandard.org/News-dir/ftsup/docs/sups/sup111.pdf)
- **DICOM SR TID 1500** — coded, machine-computable measurements over ROIs/SEGs (the "structured report"). [dicom4qi](https://dicom4qi.readthedocs.io/en/latest/instructions/sr-tid1500/)
- **GSPS presentation states** — window/level, annotations, and transforms saved *apart from* pixels, shareable and re-renderable.
- **IHE AI Results (AIR)** — AI output packaged as one atomic result object (SR + SEG + parametric map + evidence); **IHE AIW-I** routes work via standard worklists. Both remain Trial Implementation (AIR Rev 1.3, Aug 2025; neither at Final Text) — the *pattern*, not the finished standard, is the exportable asset. [AIR](https://www.ihe.net/uploadedFiles/Documents/Radiology/IHE_RAD_Suppl_AIR.pdf), [profiles.ihe.net/RAD](https://profiles.ihe.net/RAD/)
- **CADt triage pattern** (Viz.ai De Novo, 2018): AI never diagnoses — it flags, reprioritizes the human worklist, and the human confirms. Of the 1,451 FDA AI-enabled device authorizations through end of 2025, 1,104 (76%) are radiology (verified against the FDA AI-Enabled Medical Devices list); nearly all follow this human-in-the-loop shape. [FDA list](https://www.fda.gov/medical-devices/software-medical-device-samd/artificial-intelligence-enabled-medical-devices), [tally](https://theimagingwire.com/2025/12/10/ai-enabled-medical-devices-granted-fda-marketing-authorization/)
- **MONAI Label** — a server that backs multiple viewers (OHIF, Slicer, QuPath) with interactive segmentation (DeepGrow/DeepEdit/scribbles) and active learning choosing the next case. The annotation brain is decoupled from the viewer. [paper](https://arxiv.org/pdf/2203.12362)
- **OHIF v3** — extensions (capabilities) + modes (workflow compositions); the viewer of the NCI Imaging Data Commons. [architecture](https://docs.ohif.org/development/architecture/)
- **Cornerstone3D** — single shared offscreen WebGL context compositing many viewports; streaming volume upload via `texSubImage3D`. Still WebGL in production; WebGPU only exploratory. [docs](https://www.cornerstonejs.org/)
- **Digital pathology WSI** (DICOM Sup 145, HTJ2K Sup 235) — tiled pyramids + range retrieval for multi-GB rasters; structurally identical to COG. Paige Prostate (first pathology-AI De Novo) shipped *inside a viewer*.

### 4.2 What that field says it needs next (demand signals)

- **AI monitoring/orchestration**: multi-society statement (ACR/CAR/ESR/RANZCR/RSNA, *Radiology: AI* 2024, DOI 10.1148/ryai.230513) demands lifecycle monitoring; institutions build orchestration platforms over many models (Blackford: 150+ models behind one integration).
- **Computable findings, not prose**: RSNA/ACR Common Data Elements ([radelement.org](https://www.rsna.org/practice-tools/data-tools-and-standards/radelement-common-data-elements)); ESR push from prose to structured reports.
- **Cloud-native, zero-footprint viewing is assumed**; the debate has moved to security (ACR/SIIM 2025).
- **Annotation quality codified**: CLAIM 2024 (DOI 10.1148/ryai.240300) *requires* inter-rater variability handling and bans the term "ground truth" in favor of "reference standard." Expert-vs-consensus Dice can run 0.66–0.76 — label quality is a measured, managed quantity.
- **Longitudinal comparison** (hanging protocols, priors) remains core and still metadata-fragile.

### 4.3 The EO/geospatial labeling landscape (the open ground)

- **STAC label extension**: v1.0.1, maturity "Pilot," last release **Jan 2022 — dormant** (43 commits ever). [repo](https://github.com/stac-extensions/label)
- **STAC MLM (model metadata)**: active, Candidate — the community's ML energy moved to *models*, leaving *labels and results* unclaimed. [repo](https://github.com/stac-extensions/mlm)
- **OGC TrainingDML-AI**: all three parts are adopted OGC standards (23-008r3 et al.) with real semantics for training-data quality/provenance — and **near-zero tooling uptake**. [OGC](https://www.ogc.org/standards/trainingdml-ai/)
- **Tooling**: generic labelers (CVAT/Labelbox/Roboflow) require chipping GeoTIFFs to PNGs and emit pixel-space labels with no CRS; the dominant human+AI EO pattern is **desktop QGIS + SAM plugins** ([samgeo](https://samgeo.gishub.org/), [Geo-SAM](https://github.com/coolzhao/Geo-SAM)). **SAR-appropriate rendering in labeling tools is essentially nonexistent** (inference from absence across all surveyed tools).
- **Foundation-model label hunger**: Prithvi-EO-2.0, Major TOM, M3LEO all exist partly *because* SAR-labeled benchmarks are scarce relative to optical.
- Cloud-native geospatial substrate is mature and moving: COG is an OGC standard (21-026), GeoParquet 1.1→2.0, GeoZarr in OGC SWG, Icechunk 1.0 with virtual HDF5 references, Radiant MLHub → Source Cooperative (1 PB).

### 4.4 Browser GPU state of the art (2026)

- WebGPU shipped: Chrome 113+, Firefox 141+ (Windows; **Linux still Nightly**, expected 2026+), Safari 26. API-present coverage ~82–84% but real usable coverage lower; **WebGL2 is ~96% and universal, including Linux**. [implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [caniuse](https://caniuse.com/webgpu)
- Production WebGPU is **compute-led** (Figma's renderer rewrite for compute shaders; Google Meet subgroups 2.3–2.9× ML speedups; ONNX Runtime Web / Transformers.js WebGPU backends 3–10× vs WASM). Everyone feature-detects and falls back.
- **deck.gl v9.2 WebGPU: "Early Preview," not production ready; BitmapLayer, picking, PostProcessEffect, basemap interleaving all non-functional on WebGPU** — SARdine's entire rendering pattern has no WebGPU path in deck.gl today. [deck.gl docs](https://deck.gl/docs/developer-guide/webgpu)
- WASM+SIMD is baseline everywhere; threads need COOP/COEP headers. HTJ2K-via-WASM-SIMD worker decode is production practice in DICOM viewers — the template for h5chunk's inflate+shuffle.

### 4.5 SAR competitive landscape

| Tool | Model | Gap SARdine exploits |
| --- | --- | --- |
| ESA SNAP 12 | Free desktop Java; 32 GB-RAM norms, chronic performance complaints | No browser mode, no labeling |
| GAMMA / ENVI SARscape | Commercial desktop/CLI, expert-only | Same |
| ASF Vertex + HyP3 + OpenScienceLab | Browser *search*, server compute, Jupyter analysis | Nothing renders SAR client-side |
| Umbra Canopy / Capella Console / ICEYE Insights | Tasking + **closed** pre-cooked detections (vessel/change/flood) | No interactive pixel analysis, no human-correction loop |
| Google Earth Engine | Sentinel-1 GRD only; **cannot ingest complex/SLC data** | Server-bound, SAR-limited |
| Copernicus/EO Browser, TiTiler stacks | Server-side tile rendering | Thin clients; pins, not interpretation |
| H5Web/myHDF5 | Client-side HDF5 | No georeferencing, no chunk-viewport streaming |
| COMET-LiCS / EGMS / ASF Displacement portals | Serve finished InSAR products | Zero user-driven rendering of source SAR |

**NISAR context:** launched July 30, 2025; ~85 TB/day; >100K BETA L1–L3 products (>500 TB) released Feb 27, 2026; **provisional calibrated forward processing begins July 2026 — i.e., now** — with fully validated reprocessing of the archive in Q4 2026 (verified against ASF's availability overview). The mission's official viewing path is bulk download + h5py scripts. There is no first-class viewer, and no DAAC offers one. ([ASF availability overview](https://nisar-docs.asf.alaska.edu/availability-overview/), [NISAR data news](https://www.earthdata.nasa.gov/news/nisar-release-over-100000-new-data-product-files))

---

## 5. The Mapping: Medical Imaging → SAR/EO

| Medical mechanism | What it does | SAR/EO equivalent | Status |
| --- | --- | --- | --- |
| DICOM tiled WSI / HTJ2K progressive | Pyramid + range retrieval of huge rasters | COG overviews + Range; h5chunk | **Done** — SARdine already implements the HDF5 analog |
| DICOMweb (QIDO/WADO) | Standard query + retrieve | STAC API + Range reads | Mature; SARdine has a STAC client + server |
| **DICOM SEG** | Mask as first-class object referencing source | COG mask / GeoJSON+GeoParquet polygons with STAC-label / TrainingDML-AI metadata | Standards exist but dormant/unadopted — **open ground** |
| **DICOM SR TID 1500** | Coded, computable measurements/findings | *No EO equivalent exists* | **Gap — "structured SAR interpretation record" is inventable** |
| **GSPS presentation state** | Persist rendering apart from pixels | *No standard*; SARdine's render-state clipboard is the embryo | **Gap — a shareable "SAR presentation state" is a SARdine-definable artifact** |
| IHE AIR (AI result object) | Standard package: masks + measurements + evidence | STAC MLM covers *models*; result packaging unclaimed | **Gap** |
| IHE AIW-I worklist | Task routing to AI and humans | No open labeling-worklist standard for EO | Gap (annotation campaigns) |
| CADt triage (AI flags → human confirms) | The proven AI deployment shape | ICEYE/Capella ship closed detections; **no human-correction loop anywhere** | Pattern half-present, human half missing |
| Hanging protocols + priors | Auto-layout current vs prior | CompareGrid + time series | SARdine's CompareGrid **is** this — needs saved layouts |
| MONAI Label (active learning, click-to-segment) | Server-assisted annotation inside the viewer | QGIS+SAM desktop plugins only; nothing browser-native on streamed data | **Gap — the flagship opportunity** |
| CLAIM label-quality rigor | Codified annotation QA (inter-rater, reference standard) | No EO analog | Thought-leadership opening |
| NCI IDC + OHIF | Public data commons with first-class viewer | DAACs serve files; no viewer | The NISAR-viewer position is vacant |

---

## 6. Positioning: SARdine as the SAR Reading Workstation

**Thesis.** SARdine should position as the browser-native workstation where SAR data is *read* — in the radiological sense: streamed instantly, rendered expertly, marked up by humans and AI in a shared reviewable format, and exported as computable interpretation objects, not screenshots.

**The five gaps SARdine can own:**

1. **NISAR day-one, zero-footprint viewing.** Provisional calibrated forward processing starts July 2026 (validated archive reprocessing Q4 2026) at ~85 TB/day, and the official path is bulk download. "Paste a granule URL, see it in seconds" is unclaimed — and h5chunk is the only implementation of it.
2. **SAR-aware, georeferenced, in-browser labeling.** Every labeling tool is radiometry-blind (no dB, no composites, no speckle handling) and CRS-blind; every SAR portal is annotation-free. Georeferenced markup drawn over live-rendered dB/polarimetric imagery, exported as GeoJSON/GeoParquet with STAC-label/TrainingDML-AI metadata, exists nowhere — and SAR foundation models are starved for exactly these labels.
3. **The human+AI markup loop (CADt/MONAI pattern for EO).** AI proposals — from sardine-agent, a server model, or in-browser SAM via ONNX Runtime Web — rendered over streamed SAR in a "pending" state; the analyst accepts/edits/rejects; provenance records proposer and adjudicator. Constellation vendors ship only closed detections; the correction loop is the differentiator.
4. **Presentation-state and structured-interpretation artifacts for SAR.** Define the GSPS analog (versioned render-config: dB range, stretch, composite, colormap, masks) and the TID-1500 analog (findings JSON: geometry + measurement + class + observer + method + scene reference). The STAC-extension route is open — the label extension is dormant, and the STAC community demonstrably ships extensions. This is a standards-leadership play with running code.
5. **Eventually: complex/SLC in the browser.** GEE structurally can't; portals won't; desktop-only today. The SAR_PROCESSING_ROADMAP (InSAR in-browser) is the long-game moat.

**Why SARdine is credentialed to take this position:** the streaming engine is unique; the GPU pipeline already renders SAR the way experts need it (which is exactly what generic labeling tools lack); the STAC server, agent toolkit, and compare grid are the seeds of worklist, AI loop, and hanging protocols respectively.

---

## 7. Roadmap

Two parallel workstreams: **Platform** (integration + interpretation-as-data) and **Performance** (GPU §3.2). Phases are ordered by dependency, not calendar.

### Phase 0 — Quick wins (days)

1. GeoJSON save/load for annotations + ROI + transects + class regions (forces the schema decision everything else builds on).
2. Metadata sidecar on export (`.tif.json`: product identification + render config + `derived_from`).
3. Fix P0 signal-abort cascade + adaptive-concurrency AbortError bug.
4. Delete dead modules (`SARGPUBitmapLayer.js`, `hdf5-chunked.js`, `ChunkedDatasetReader`, `writeLegacyRGBGeoTIFF`); refresh or remove stale `API.md`/`CONTRIBUTING.md`.
5. Add loader + export round-trip tests as the refactor safety net.

### Phase 1 — Unify the model (the refactor)

- **`SARScene`**: one typed object all loaders return — source ref, format, CRS, bounds, dims, full identification metadata, capabilities. Kill the opaque `meta`.
- **`RenderConfig`**: one versioned schema consumed by the viewer, every export path, and every serializer. Collapse share-link/PNG/markdown/clipboard into one `SessionState` (scene ref + render config + analysis objects) with `.sardine.json` save/load. This *is* the GSPS analog — build it once, brand it later.
- Extract main.jsx state into a store (zustand or context+reducer) organized around `SARScene`/`RenderConfig`/`Analysis`; make the library boundary (`src/index.js`) the single source sardine-agent consumes instead of copied loaders.

### Phase 2 — Interpretation as data (the SEG/SR analogs)

- Migrate annotations to geographic coordinates; serialize **everything** (annotations, ROIs, transects, class regions, thresholds) as GeoJSON Features with a defined properties schema: `{label, class, observer: 'human'|'ai', method, created, sourceScene, renderState?, measurements}`.
- Attach computed stats to their geometry: ROI histograms, transect profiles, class statistics become *properties of the feature*, not detached panel state.
- Add polygon ROI + measured primitives (distance/area — geodesy already exists in the scale-bar code).
- Export classification/threshold maps as uint8 COG masks with class tables; emit a STAC Item (label extension + `derived_from`) per export — the existing DuckDB STAC server can catalog SARdine's own outputs.
- "Reading report" bundle: figure PNG + findings JSON + labeled GeoJSON in one export.

### Phase 3 — The human+AI markup loop (the differentiator)

Much of the AI side already exists in sardine-agent (§2.4): a findings JSON schema with `outcome/confidence/limitations/parent_finding_id`, the Sardine Maps observation/report DB design, an autonomous explorer, and multi-sensor discovery tools. Phase 3 is therefore a **convergence** task, not a green-field build: make the viewer's annotation schema (Phase 2) and the agent's findings/observation schema the same object, then render it.

- sardine-agent write tools: `sardine_annotate`, `sardine_write_mask` emitting the *same* GeoJSON schema as the viewer's human tools; conversely, surface `.sardine/` findings and Sardine Maps outputs as viewer overlays with their provenance chain intact.
- Review workflow in the viewer: AI-proposed features render in "pending" style → accept/edit/reject → provenance records both parties. (The CADt pattern; the agent's directives table is the natural queue.)
- In-browser assisted segmentation: SAM-class encoder via ONNX Runtime Web (WebGPU/WASM) over the current viewport; click-to-segment water/flood/ice, output straight into the annotation schema. (The MONAI DeepEdit pattern, using the GPU work from §3.2 item 6.)
- Interactive threshold classification with live area readout (WGSL threshold+count pass) feeding mask + GeoJSON export — the flood workflow from `MULTI_PRODUCT_ROADMAP.md` Mode 3, now persisted.

### Phase 4 — Longitudinal reading & the commons

- Saved compare-grid layouts per task ("hanging protocols"); annotations carried across dates for change reading; time-series AOI statistics as findings.
- Publish the presentation-state and findings schemas as draft STAC extensions with SARdine as the reference implementation.
- Worklist: STAC-catalog-driven queues of scenes to review (the AIW-I analog), which the existing sardine-launch STAC server already half-supports.

### Performance workstream (parallel, from §3.2)

Worker decode pool → GPU histogram integration → GPU export parity → threshold/mask compute + finish WGSL filters → ONNX Runtime Web inference → IndexedDB chunk cache. Defer deck.gl 9/WebGPU rendering until it exits Early Preview (~2027–2028 revisit).

---

## 8. Risks & Caveats

- **Refactor risk:** Phase 1 touches the 7,800-line monolith; do Phase 0 item 5 (tests) first, and consider strangling main.jsx incrementally (one state cluster at a time) rather than a rewrite.
- **Standards timing:** IHE AIR/AIW-I are Trial Implementation, not Final Text — even medicine hasn't finished this. Frame SARdine's schemas as patterns with running code, not compliance claims.
- **Verification status:** a fact-check pass against primary sources confirmed the load-bearing claims (IHE AIR/AIW-I Trial Implementation status, NISAR dates/volumes, FDA device counts, the multi-society AI statement, FDA PCCP/lifecycle guidance status, Radiant MLHub→Source Cooperative, MONAI Label, DICOM Sup 145/IDC viewers, Paige Prostate De Novo). Still un-reverified: CEOS-ARD SAR spec version and OHIF v3.11 feature mapping. "No labeling tool renders SAR properly" and "TrainingDML-AI has no tooling uptake" remain strong inferences from absence, not single quotable sources.
- **Scope discipline:** polarimetric decomposition GPU work (Freeman-Durden/H-α/Yamaguchi) is intentionally parked per current priorities; the roadmaps in `POLSAR_DECOMPOSITION_ROADMAP.md` remain valid for later.
- **Security items** from `AUDIT.md` (recursion limits, credential handling, URL sanitization) should ride along with Phase 1 rather than wait.

---

## Appendix A — Key internal references

| Topic | File |
| --- | --- |
| Architecture debt | `app/main.jsx` (7,764 lines), `src/viewers/SARViewer.jsx:27-96` (97 props) |
| Serialization fragments | `main.jsx:4217-4350`, `src/utils/png-state.js` |
| Annotation system | `src/components/AnnotationOverlay.jsx`, `src/utils/annotation-render.js`, `figure-export.js:992-1010` |
| ROI/transect/classifier | `ROIOverlay.jsx`, `ROIProfilePanel.jsx`, `TransectLineOverlay.jsx`, `ScatterClassifier.jsx`, `main.jsx:763-906` |
| Loader contract | `src/loaders/types.js:59-75`; metadata read `nisar-loader.js:161-381`, never re-written on export (`geotiff-writer.js:79-149`) |
| GPU shaders | `src/layers/shaders.js` (18 colormaps, 10 texture units), `SARGPULayer.js:638-695` (R32F upload) |
| WebGPU compute (unwired) | `src/gpu/webgpu-device.js`, `histogram-compute.js`, `gpu-stats.js`, `spatial-filter.js`, `webgl-spatial-filter.js` |
| Pipeline bugs | `docs/RENDERING_PIPELINE_AUDIT.md` (P0 abort cascade), `docs/AUDIT.md` (Feb 2026 audit), `docs/CHUNKING_USABILITY_REVIEW.md` |
| Existing roadmaps | `docs/MULTI_PRODUCT_ROADMAP.md`, `docs/SAR_PROCESSING_ROADMAP.md`, `docs/WEBGPU_COMPUTE_ROADMAP.md`, `docs/VISUALIZATION.md`, `docs/STAC_CATALOG.md` |
| Dead code | `src/layers/SARGPUBitmapLayer.js`, `src/loaders/hdf5-chunked.js`, `nisar-loader.js:1127-1331` |

## Appendix B — External sources (selection)

Medical: DICOM SEG Sup 111 (dicomstandard.org) · SR TID 1500 (dicom4qi.readthedocs.io) · IHE AIR/AIW-I supplements (ihe.net) · HTJ2K Sup 235 (dicomstandard.org) · OHIF architecture (docs.ohif.org) · Cornerstone3D (cornerstonejs.org) · MONAI Label (arxiv.org/pdf/2203.12362) · multi-society AI statement DOI 10.1148/ryai.230513 · CLAIM 2024 DOI 10.1148/ryai.240300 · RSNA CDEs (radelement.org) · Viz.ai CADt De Novo (2018).

EO/geospatial: STAC label ext (github.com/stac-extensions/label, dormant) · STAC MLM (github.com/stac-extensions/mlm) · OGC TrainingDML-AI (ogc.org/standards/trainingdml-ai) · COG OGC 21-026 · GeoParquet 2.0 (cloudnativegeo.org) · Source Cooperative (source.coop) · CEOS-ARD (ceos.org/ard) · samgeo/Geo-SAM QGIS plugins · Prithvi-EO-2.0 (arxiv 2412.02732) · M3LEO (arxiv 2406.04230).

Browser GPU: WebGPU implementation status (github.com/gpuweb/gpuweb/wiki/Implementation-Status) · deck.gl WebGPU guide + v9.2 notes (deck.gl) · Figma WebGPU renderer (figma.com/blog) · Chrome 134 subgroups (developer.chrome.com) · ONNX Runtime Web WebGPU · caniuse.com/webgpu, /webgl2.

SAR landscape: SNAP 12 (step.esa.int) · HyP3 (hyp3-docs.asf.alaska.edu) · Umbra Canopy docs · Capella/ICEYE product announcements · GEE Sentinel-1 limitations (developers.google.com/earth-engine/guides/sentinel1) · NISAR data releases (earthdata.nasa.gov).
