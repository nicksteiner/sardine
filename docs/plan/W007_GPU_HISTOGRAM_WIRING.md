# W007 — Wire the existing WebGPU histogram into the UI

wave: 1
status: branch-ready
blocked_by: []
branch: w007-gpu-histogram

## Objective

`src/gpu/gpu-stats.js` (`computeChannelStatsGPU`, WebGPU two-pass histogram with CPU
fallback) exists and is unused. Replace the debounced CPU histogram path in
`app/main.jsx` with it, so histogram + auto-contrast update in near-real-time.

## Scope

- Grep `app/main.jsx` for `computeChannelStats` / `sampleViewportStats` call sites
  (histogram scope logic ~lines 1500s at HEAD; RE-LOCATE by grep). Route the per-array
  stats computation through `computeChannelStatsGPU` (same return shape by design —
  verify against `src/utils/stats.js` `computeChannelStats`).
- Reduce the histogram debounce when the GPU path is active (e.g. 800 ms → 100 ms);
  keep the long debounce on CPU fallback. Detect via `gpu-detect.js` probe
  (`webgpu: true`).
- `sampleViewportStats` still gathers tiles on CPU — only the binning/stats math moves
  to GPU. Do not restructure tile sampling.
- Status-window log line on first use: "histogram: WebGPU" / "histogram: CPU" so the
  active path is visible.

## Out of scope

- No WGSL changes. No spatial-filter integration. No per-frame (undebounced) updates.

## Acceptance criteria

- `npm test` + `npm run build` pass.
- With WebGPU unavailable (Node/test env), behavior is byte-identical to before
  (fallback returns CPU results) — unit test comparing `computeChannelStatsGPU`
  fallback output to `computeChannelStats` on the same synthetic array.
- PR documents a manual dev-server check: histogram updates when panning, no console
  errors, log line shows which path ran.

## Findings

**Stale premise (partially):** at branch point (78b7b61) the GPU path was already
partially wired upstream. Pre-existing:

- `app/main.jsx` already imported `computeChannelStatsAuto` and used it in two
  places: the RGB histogram-recompute path and the remote-NISAR RGB background
  histogram.
- The ROI-scope auto-refresh effect was already gated on `gpuInfo.webgpu`
  (`probeGPU()` from `gpu-detect.js`) with a 300 ms debounce.

**Done by this work order:**

- Routed the 5 remaining CPU-direct call sites in `app/main.jsx` through the GPU
  path: ROI-RGB per-channel stats, ROI time-series per-channel + single-band stats,
  single-band viewport/ROI histogram recompute, and remote single-band background
  histogram. `app/main.jsx` no longer imports from `utils/stats.js` directly.
- Added `sampleViewportStatsAuto()` to `src/gpu/gpu-stats.js` (exported via
  `src/gpu/index.js` + `src/index.js`): same 3×3 CPU tile gathering, binning/stats
  math on WebGPU, delegates to CPU `sampleViewportStats()` when WebGPU is
  unavailable or the dispatch fails (identical results by construction).
- Viewport-scope debounce is now conditional: 100 ms with `gpuInfo.webgpu`, 800 ms
  on CPU fallback.
- One-time status log `histogram: WebGPU` / `histogram: CPU` on first stats
  computation (`logHistogramPathOnce`, all 6 stats-computing sites call it).
- Unit test `test/unit/gpu-stats-fallback.test.mjs` (11 tests): CPU-fallback output
  of both Auto functions is deep-equal to `computeChannelStats` /
  `sampleViewportStats` on synthetic arrays (nodata, dB/linear, stride, rejected
  tiles, all-nodata → null).

**Latent bug found and avoided:** `computeHistogramGPU(data, { numBins })` accepts a
bin count but the WGSL shaders are compiled with a hard-coded `NUM_BINS = 256`;
passing `numBins < 256` would size the chunk buffers smaller than the shader's write
range. The Auto wrappers therefore always use the 256-bin default on the GPU path
and honor the caller's `numBins` only on the CPU fallback. Fixing
`computeHistogramGPU` itself was out of scope (no WGSL changes).

**Manual dev-server check (`npm run dev`):** pan with viewport-scope histogram →
updates ~100 ms after motion stops when WebGPU is active; status window shows the
one-time `histogram: WebGPU` (Chrome) / `histogram: CPU` (WebGPU disabled) line; no
console errors.
