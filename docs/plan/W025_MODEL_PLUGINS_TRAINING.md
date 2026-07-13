# W025 — Model plugin framework: heuristic / classical / ONNX / remote behind one manifest

wave: G2 (GPU/ML track; sibling of W024, feeds W011 components 3+5, contract for sardine-tuner)
status: launched
blocked_by: []
branch: w025-model-plugins

## Objective

Give SARdine a **model plugin capacity** that treats heuristics (thresholds,
indices, rules), classical learned heads, in-browser neural nets (ONNX), and
remote models (sardine-agent / sardine-tuner endpoints) as **peers behind one
manifest and one execution contract**. Inference-first: training in the
browser is scoped to lightweight head-fitting on labeled pixels/embeddings.
Includes an ONNX-in-the-browser proof of concept.

This is the "learn/propose" socket of the flywheel and the interchange
contract with **sardine-tuner** (planned desktop fine-tuning app): labels go
out via W004/W011 exports, models come back as manifest + weights.

## Design basis (deep research, 2026-07-13 — 13 verified findings)

Full report: workflow `wf_f531fff1-a06`; key prior art and what we take:

- **QGIS Deepness** (ONNX-only GIS inference plugin): five-task taxonomy
  (Segmentor/Detector/Regressor/Recognition/Superresolution); execution
  metadata (tiles_size, tiles_overlap, standardization mean/std, class_names,
  thresholds) embedded in ONNX `metadata_props` so the artifact is
  self-describing; fixed tiled contract [B,C,H,W]. **Take:** the taxonomy
  (adapted), metadata-travels-with-model, tiled contract. **Anti-lesson:**
  Deepness is uint8-only — our contract is float32-native for SAR power/dB.
- **napari npe2**: static declarative manifests, lazily discovered — plugin
  capability indexed without executing plugin code. **Take:** registration
  never loads weights; discovery and execution are separate concerns.
- **MONAI Label**: optional capability interfaces (Inference required;
  Training/ActiveLearning optional); Inference declares interaction mode
  (click/scribble/ROI) and inferrer strategy (whole vs sliding-window)
  explicitly; **heuristic (GraphCut/scribbles) and DL models are peers under
  one InferTask base with a type tag**; remote execution = REST app server,
  viewers are thin clients. **Take:** all four — this is the architecture.
- **STAC MLM v1.5.x** (Candidate maturity; CRIM/Wherobots/Terradue/NRCan;
  Wherobots ships MLM-JSON-as-runtime-manifest in production BYOM):
  **Take:** align manifest field names with `mlm:*` (name, tasks, input w/
  normalization, output, artifacts, license) rather than inventing; pin to
  the v1.5.x line and expect churn (Candidate, not Stable).
- **ONNX Runtime Web WebGPU EP**: viable and production-proven
  (Transformers.js v3+), **but** blanket WebGPU-on-Chromium availability was
  REFUTED (0–3) in verification; open issues: fp16 overflow, no service
  workers. **Take:** per-session EP negotiation `webgpu → wasm`, WASM
  fallback mandatory, never assume WebGPU.
- **Research gaps** (unverified, not disproven): SAM2/3 client embedding-cache
  contracts, browser classical-training precedents, browser-ready SAR
  foundation-model ONNX exports (TerraMind/Prithvi). Consequence: the PoC
  model is a generated, license-free demo net; real SAR models (SAR2SAR
  despeckle — W024's premise risk; TerraMind encoder) enter later via the
  same manifest once license/export checks pass.

## The contract

**Tasks:** `pixel-classifier` | `segmentation` | `detection` | `regression` |
`enhancement` | `embedding`. (Deepness's five + explicit pixel-classifier
and embedding; embedding is the foundation-encoder slot.)

**Backends (peers, type-tagged):**

- `builtin-heuristic` — declarative rules (band + transform + threshold
  expression), runs in-page, no weights
- `builtin-classical` — parameter-carrying heads (logistic v1), params in
  manifest, runs in-page
- `onnx` — ORT-web; lazy dynamic import; EP negotiation webgpu→wasm; weights
  fetched once, cached in IDB (chunk-cache pattern); tiled via runTiled
- `remote` — HTTP endpoint (sardine-agent / sardine-tuner), same manifest,
  same output shape (MONAI app-server pattern)

**Execution:** `run(manifest, input, {signal, onProgress})` — async,
cancelable (AbortSignal), progress phases (weights → session → tiles);
`strategy: "whole" | "tiled"`; tiled = float32 NCHW, configurable
tileSize/overlap, feathered blend; `interaction: "none" | "click" | "roi"`
(only "none" and "roi" execute in v1; "click" reserved for W011 SAM).

**Manifest** (`{name}.sardine-model.json` — `.sardine.json` is TAKEN by the
NITF sidecar): STAC-MLM-aligned properties (`mlm:name`, `mlm:tasks`,
`mlm:input` incl. explicit normalization expression, `mlm:output`,
`mlm:artifacts`, license, provenance, metrics) + `sardine:*` execution
fields (backend, strategy, interaction, overlay style). Deepness-style ONNX
`metadata_props` accepted as an import source; the manifest is the source of
truth. Schema version `sardine:model: 2` (v1 was the pre-research draft).

## Scope

1. `src/ml/manifest.js` — schema, validation, (de)serialization, metadata_props import
2. `src/ml/registry.js` — lazy declarative registry; backend dispatch; builtin demo manifests
3. `src/ml/run-tiled.js` — tiled float32 execution w/ feathered overlap, cancel + progress
4. `src/ml/backends/heuristic.js`, `classical.js`, `onnx.js` (remote is a
   stub that validates + errors with guidance until tuner/agent endpoints exist)
5. `src/ml/trainer.js` + `dataset.js` — head-fitting utility (logistic on
   band features or embeddings), seeded/reproducible, honest test metrics
6. Demo plugins: `water-threshold` (heuristic, works on any dB scene),
   trained-head save/load, and a generated ONNX demo net (PoC: proves lazy
   ORT load → EP negotiation → IDB weight cache → tiled run → overlay)
7. UI: "Models" section in the Analyze rail panel — list, run on ROI,
   overlay result, fit head from classifier regions, save/load manifests
8. `onnxruntime-web` npm dep as **lazy dynamic import only** — entry bundle
   size must not change (W024 ground rule; verify chunking in build)

## Coordination notes

- **W024**: the ONNX backend + runTiled land here first (user-directed PoC).
  W024's despeckle pilot should consume `src/ml/backends/onnx.js` and extend
  it (graph capture, f16) rather than create `ort-session.js` — update W024
  before starting it.
- **W010**: `.sardine-model.json` is a new serialization format — add it to
  W010's mapping table; trained heads/model refs belong in
  `SessionState.analysisArtifacts`.
- **W012**: MLM alignment is a standards-play asset; consider publishing the
  `sardine:*` execution fields as a proposed MLM profile.
- **sardine-tuner** (future, separate repo): inherits the manifest contract;
  needs its own work order. Lock `.sardine-model.json` suffix + schema
  versioning into docs/plan/README.md ground truth when this merges.

## Out of scope

Neural training/fine-tuning in browser (tuner's job); SAM assist (W011,
consumes this); despeckle model vetting (W024); TF.js/WebNN (audit forbids);
remote backend implementation beyond the stub.

## Acceptance criteria

- `npm test` + `npm run build` green; entry bundle unchanged (ORT lazy-chunked).
- Unit tests: manifest validation + round-trip; runTiled seam tolerance vs
  whole-image; heuristic backend on synthetic dB data; classical head
  train→predict determinism for fixed seed; ≥95% accuracy on separable
  synthetic data.
- Browser check: water-threshold heuristic runs on a real GCOV ROI and
  renders an overlay; ONNX demo net downloads once (IDB hit on second run),
  negotiates EP (webgpu or wasm), runs tiled, renders output; trained head
  round-trips save → load → identical predictions.

## BUG REPORT — please fix (2026-07-13, from the GPU-track review session)

**User-visible in the field right now**: classification histograms show NaNs
and a two-valued output; histograms elsewhere in the app are fine. Reported
by Nick against the live build (main @ 681d646 + your WIP). Diagnosed
mechanism — a NaN-poisoned model is *silent* end to end:

1. `computeStandardizer` (src/ml/trainer.js:41-57) sums features with **no
   finite check**. One NaN/Inf sample → `mean[j] = NaN`; the guard at :55
   (`!(std[j] > 1e-12)` is true for NaN) then sets `std = 1`, which **masks**
   the poisoning instead of surfacing it. The persisted model carries
   `mean: [NaN, ...]`.
2. `predictLogistic` (src/ml/trainer.js:160-189) guards non-finite *inputs*
   (label 255) but not a non-finite *model*: with NaN `mean`, every logit is
   NaN, `NaN > -Infinity` never fires, so **every valid pixel gets class 0
   and every invalid pixel gets 255 → a two-valued map**; the confidence
   branch computes `exp(NaN)/NaN` → **NaN confidence for every pixel**.
   That is exactly the reported symptom.
3. NaN feeds exist by design in this line, so the poisoning path is live:
   `applyTransform('dB')` maps non-positive → NaN (src/ml/registry.js:29),
   and `applyHeadToClassifierData` (app/main.jsx:5730-5731) builds X with
   NaN rows for invalid pixels. `datasetFromClassRegions` filters
   `!valid[i]` (src/ml/dataset.js:36), but any current or future path that
   standardizes/trains/evaluates on transform-output or unfiltered features
   hits (1).

**Requested fixes** (fail loud, not two-valued-quiet):
- `computeStandardizer`: skip or throw on non-finite samples (throwing is
  preferable — silently skipping changes n and hides label/feature bugs).
- `trainLogistic` / `buildHeadManifest`: assert `mean`/`std`/`weights` are
  all finite before returning/persisting; a manifest must never carry NaN
  params.
- `predictLogistic`: cheap model-validity assert (finite mean/std) at entry.
- A unit test that trains on data containing one NaN row and asserts the
  loud failure, plus one that loads a manifest with NaN mean and asserts
  predict refuses.
- Worth checking while in there: whether the ONNX/classical backends can
  emit NaN into overlays/metrics from `applyTransform('dB')` bands
  (NaN-in → what comes out of `runTiled` feathered blending?).

Context that may help repro: symptom appeared in the classification
histogram panel after head-fit/apply on a live scene. The scatter
classifier's own extraction is NaN-clean (app/main.jsx:1197-1204 guards
before dB), so the poisoning most likely entered via a train/eval path
around the head-fit loop or your uncommitted onnx.js changes.

— GPU-track session (Wave G1). Our review fix-pass did not touch src/ml/;
this note is the only edit to your territory.
