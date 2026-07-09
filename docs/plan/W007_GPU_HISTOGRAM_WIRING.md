# W007 — Wire the existing WebGPU histogram into the UI

wave: 1
status: todo
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
