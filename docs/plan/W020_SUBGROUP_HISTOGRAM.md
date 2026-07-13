# W020 — Subgroup-accelerated histogram/stats kernels

wave: G1 (GPU track)
status: todo
blocked_by: [W018]
branch: w020-subgroup-histogram

## Objective

Use WGSL `subgroups` (shipped Chrome 134+, feature-detected via W018) to replace
part of the shared-memory tree reduction in the histogram/stats kernels with
subgroup intrinsics (`subgroupAdd`, `subgroupMin/Max`). Published reduction
speedups are 2.3–2.9×; the histogram drives auto-contrast on every viewport
change, so this is latency users feel. The workgroup-memory path remains the
default — subgroups are absent on Firefox/Safari and non-uniform in size (4–128),
so this is strictly an additive fast path. Rationale:
`docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §2.

## Existing machinery (do not reinvent)

- `src/gpu/histogram-compute.js` — 3-pass design: `reduceShader` (256-thread
  tree reduction over shared `sMin/sMax/sSum/sCount`), `histogramShader`
  (workgroup-local atomic bins → per-workgroup chunks), `histReduceShader`
  (per-bin final sum). W007 added a numBins guard — do not regress it.
- `src/gpu/gpu-stats.js` — `computeChannelStatsAuto` / `sampleViewportStatsAuto`
  (the wired consumers; their signatures must not change).
- `test/unit/` gpu-stats fallback test; `test/benchmarks/`.

## Scope

1. **Shader variants**: when `getGPUCapabilities().features.has('subgroups')`,
   generate the reduce shader with `enable subgroups;` — each thread reduces its
   subgroup first (`subgroupMin/Max/Add`), one lane per subgroup writes to shared
   memory, then the existing tree reduction finishes across subgroups. Do NOT
   assume a subgroup size; use `subgroup_size` builtin and keep the shared-memory
   arrays sized for the worst case.
2. **Pass 3** (`histReduceShader`): same treatment for the per-bin sums where it
   helps; skip if the pass is bandwidth-bound (measure first, note the finding).
3. **Selection plumbing**: pipeline cache keyed by (variant, numBins) so both
   paths coexist; a `forceNoSubgroups` escape hatch for testing.
4. **Benchmark**: extend the benchmark harness to time both variants on the same
   synthetic data (1M, 16M elements) and record results in Findings.

## Out of scope

- `shader-f16` in these kernels (SAR power must accumulate in f32 — dynamic
  range clips at f16 max 65504).
- One-pass scatter histograms via texture atomics (still a WebGPU proposal;
  the 3-pass design stays).
- Subgroups in the spatial filters (separate order if the histogram numbers
  justify it).

## Acceptance criteria

- `npm test` + `npm run build` green.
- Correctness: on synthetic data (incl. NaN/zero nodata), subgroup and
  non-subgroup variants return **identical** bins/min/max/count, and match the
  CPU `computeChannelStats` within existing test tolerances (extend the existing
  gpu-stats unit test; browsers without subgroups auto-skip the variant).
- Benchmark table (both variants, 2 sizes) appended to Findings; if the win is
  <1.3× end-to-end, say so — the order is still done, the finding is the value.
