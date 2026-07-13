# W024 — In-browser ML inference substrate + despeckle pilot

wave: G2 (GPU track, differentiator; feeds W011 component 5)
status: todo
blocked_by: []
branch: w024-ml-despeckle

## Objective

Stand up ONNX Runtime Web (WebGPU EP, WASM fallback) as SARdine's client-side
inference substrate, proven by one pilot model: a SAR despeckling UNet offered
as a filter option beside the WGSL Lee/Frost filters. The survey found **no
shipped browser-native SAR despeckling or flood segmentation anywhere** — and
W011's SAM-assist (component 5) needs exactly this substrate (session
management, tile inference, weight caching), so building it here de-risks the
flood slice. Rationale: `docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §3–4.

## Existing machinery (do not reinvent)

- `src/gpu/spatial-filter.js` — `getFilterTypes()` / `applySpeckleFilter(data,
  w, h, opts)` registry and signature: the despeckle model must appear as one
  more filter type through the same interface (UI comes free).
- `src/loaders/chunk-cache-idb.js` — the IDB LRU pattern; model weights get the
  same treatment (weights are 5–50 MB at q8 — cache-once).
- `src/gpu/webgpu-device.js` / W018 capabilities — note: ORT-web creates its own
  WebGPU device; do NOT try to share the singleton (its GPU-buffer IO binding
  only pays off intra-ORT; tile arrays are ~1 MB, CPU handoff is fine).
- Repo ground rules: minimal deps — `onnxruntime-web` enters as a **lazy
  dynamic import** so the bundle pays nothing until first use; verify
  `npm run build` chunking keeps it out of the entry bundle.

## Scope

1. **`src/ml/ort-session.js`**: lazy-load ORT, EP selection
   (webgpu → wasm), session cache keyed by model ID, weight fetch with IDB
   caching + progress callback, `runTiled(session, data, w, h, {tileSize=256,
   overlap=16})` — tile-and-blend (feather the overlap) so arbitrary raster
   sizes work with a static-shape model (enables ORT graph capture).
2. **Model**: a published SAR despeckling network exported to ONNX
   (SAR2SAR / MERLIN / deepdespeckling-class). **This is the premise risk**:
   verify license permits redistribution and that the export is faithful
   (Python-side export script checked into `test/benchmarks/` or a `tools/`
   dir, with the source repo + license recorded). Input normalization must
   match training (typically log-intensity — document the exact transform).
   If no redistributable model survives scrutiny: set `status: blocked`, append
   Findings, and land the substrate with a trivially-verifiable test model
   (e.g. exported 3×3 Gaussian) so W011 still inherits working infrastructure.
3. **Filter integration**: new type `ml-despeckle` in the filter registry;
   async path with progress (first run downloads weights); output is Float32
   power like the other filters. Runs on the same data the WGSL filters get.
4. **Evaluation**: side-by-side vs enhanced-Lee on a real GCOV tile — ENL on a
   homogeneous ROI, edge preservation eyeball, timing (WebGPU vs WASM EP).
   Table in Findings. If the model underperforms classical filters on NISAR
   data, that IS the finding — publish it, keep the substrate.

## Out of scope

- SAM/segmentation (W011 owns it — it consumes `ort-session.js`). Training or
  fine-tuning. WebNN / TF.js (maintenance-mode; see audit doc "do not do").
  Complex-data (SLC) despeckling.

## Acceptance criteria

- `npm test` + `npm run build` green; entry bundle size unchanged (ORT lazy).
- Unit test (Node, wasm EP): `runTiled` on synthetic data with the test model —
  tile-and-blend seamlessness (no visible seams: max Δ at tile borders below
  tolerance vs whole-image run) and shape/normalization round-trip.
- Browser check in PR: despeckle filter runs on a real granule tile; weights
  load once then hit IDB; timings for webgpu + wasm EPs recorded.
- W011 handoff note appended: what its SAM component reuses (session cache,
  weight cache, EP selection) and what it adds (encoder embedding cache,
  prompt decoder).
