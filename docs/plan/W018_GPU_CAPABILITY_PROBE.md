# W018 — Async GPU capability probe + optional WebGPU feature adoption

wave: G1 (GPU track, parallel-safe)
status: todo
blocked_by: []
branch: w018-gpu-capability-probe

## Objective

Replace the boolean `navigator.gpu` probe with a real capability report so SARdine
can adopt optional WebGPU features (`subgroups`, `shader-f16`, `float32-filterable`,
`float32-blendable`, `timestamp-query`) behind feature checks, and can distinguish
core adapters from compatibility-mode adapters (policy: **require core, fall back to
WebGL2/CPU** — never maintain a compat-mode compute variant). Foundation for W020
(subgroup histogram) and any future f16/filterable use. Rationale:
`docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §2.

## Existing machinery (do not reinvent)

- `src/gpu/webgpu-device.js` — device singleton; `hasWebGPU()` is a synchronous
  `!!navigator.gpu` check; `getWebGPUDevice()` requests limits
  (`maxComputeWorkgroupSizeX: 256` etc.) but **no optional features**.
- `src/utils/gpu-detect.js` — `probeGPU()` (WebGL2 + `EXT_color_buffer_float`
  probing); returns `{webgl2, floatTextures, gpuRendering, webgpu, computeShaders}`.
- `src/components/StatusWindow.jsx` — where GPU status surfaces to the user.
- `npm run benchmark` — GPU vs CPU harness (candidate consumer of timestamp-query).

## Scope

1. **webgpu-device.js**: at device request time, intersect a wanted-features list
   (`subgroups`, `shader-f16`, `float32-filterable`, `float32-blendable`,
   `timestamp-query`) with `adapter.features` and pass the intersection to
   `requestDevice({requiredFeatures})`. Detect compat adapters (absence of
   `core-features-and-limits` when the adapter reports a featureLevel — verify the
   exact detection idiom against current Chrome; append a finding if it differs).
   On compat adapters, do not hand out the device: report `webgpu: 'compat'` and let
   callers fall back.
2. **New `getGPUCapabilities()`** (async, cached): `{tier: 'core'|'compat'|'none',
   features: Set<string>, limits: {...}}`. Keep `hasWebGPU()` for existing sync
   callers, unchanged semantics.
3. **gpu-detect.js**: `probeGPU()` gains an async sibling that folds in the WebGPU
   capability report (one object for StatusWindow).
4. **StatusWindow**: display tier + adopted features (one line, existing style).
5. **timestamp-query**: when present, wrap the histogram passes in
   `src/gpu/histogram-compute.js` with timestamp writes and expose pass timings via
   the existing benchmark harness (console/benchmark only — no UI).

## Out of scope

- Actually *using* subgroups/f16 in kernels (W020). Any WebGL2 changes.
- Compat-mode support of any kind.

## Acceptance criteria

- `npm test` + `npm run build` green.
- New unit test (`test/unit/gpu-capabilities.test.mjs`) with a mocked
  `navigator.gpu`: feature intersection, compat detection, absence of WebGPU →
  `tier: 'none'`, caching (adapter requested once).
- Existing GPU-stats fallback test still passes (no behavior change for callers).
- Manual check documented in PR: StatusWindow line on a WebGPU browser and on a
  WebGL2-only browser (or flag-disabled Chrome).
