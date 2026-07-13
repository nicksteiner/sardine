# W021 — WGSL nodata-aware compute pyramid (statistically correct overviews)

wave: G1 (GPU track)
status: todo
blocked_by: []
branch: w021-compute-pyramid

## Objective

A WGSL compute kernel that builds reduced-resolution levels of a Float32 power
tile carrying **mean-power / min / max / valid-count** per output texel with
NaN/zero nodata masking. This is a correctness feature before a perf feature:
bilinear/subsampled overviews are statistically wrong for SAR (power must be
averaged in linear units with nodata excluded — exactly what the export
multilook does on CPU). WebGPU has no built-in mipmap generation, so this kernel
is also the only way to get GPU pyramids at all. Consumers: on-screen multilook
of decoded chunks, overview-level auto-stretch, and (later) W011's area
statistics. Rationale: `docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §2.

## Existing machinery (do not reinvent)

- CPU ground truth: the exact ml×ml box-filter multilook in the export path and
  the `nSub=4–8` chunk sub-sampling used on-screen (`src/loaders/nisar-loader.js`;
  CLAUDE.md "Important Implementation Details"). The kernel's level-1 mean must
  reproduce the box filter.
- `src/gpu/spatial-filter.js` — the repo's WGSL conventions: 16×16 workgroups,
  `shaderPreamble` codegen, pipeline cache, buffer readback + cleanup, CPU
  fallback dispatch. Follow them.
- `src/gpu/webgpu-device.js` singleton (+ W018 capabilities if merged; core
  WebGPU suffices — write level N as an `r32float`/storage buffer, bind level
  N−1 as input; read-write storage textures are NOT required).
- `src/gpu/gpu-stats.js` — overview stats consumers.

## Scope

1. **Kernel + wrapper** `src/gpu/compute-pyramid.js`:
   `computePyramidGPU(data, width, height, {levels, factor=2}) ->
   [{data, valid, min, max, width, height}, ...]`. Each output texel aggregates
   its factor×factor footprint: sum of finite non-zero power / count, min, max;
   texels with zero valid inputs emit 0 (the pipeline's nodata convention).
   Multi-level in one submit (ping-pong buffers), SPD-style multi-level-per-
   dispatch only if it stays simple.
2. **CPU fallback** (same module, same signature) — required for the test suite
   and non-WebGPU browsers; reuse/extract the export box-filter logic rather
   than writing a third averaging implementation.
3. **One production call site** (premise-audit first, adapt if drift): the
   display-path multilook of decoded chunks where the CPU box filter or
   sub-sampling runs today. If integration is riskier than it looks (tile
   lifecycle, worker boundaries), land the kernel + fallback + benchmark and
   record the integration path as a Finding for a follow-up — the kernel is the
   deliverable.

## Out of scope

- Persisting pyramids (chunk cache stays raw). Overview *fetch* logic
  (`prefetchOverviewChunks` ladder is untouched). f16 storage. Export path
  changes (W019 owns export).

## Acceptance criteria

- `npm test` + `npm run build` green.
- Unit test (Node, CPU fallback): pyramid of a synthetic tile with NaN/zero
  holes matches an independent reference (mean excludes nodata; valid-count
  exact; min/max exact); level-1 mean ≡ existing export box filter for ml=2,4.
- GPU/CPU cross-check in the browser harness (same pattern as spatial-filter
  tests): identical outputs within 1e-5 relative.
- Benchmark: GPU vs CPU pyramid on a 2048² tile, table in Findings.
