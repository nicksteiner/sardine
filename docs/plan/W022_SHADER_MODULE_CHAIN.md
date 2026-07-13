# W022 — Shader module chain: composable render pipeline

wave: G2 (GPU track, differentiator-enabling)
status: todo
blocked_by: [W014]
branch: w022-shader-modules

## Objective

Refactor the monolithic fragment-shader assembly (`shaders.js` + the ~300-line
GLSL in `SARGPULayer`) into an ordered chain of named, self-contained shader
modules — dB → phase-correction → stretch → colormap → composite → mask — that
compose into the generated fragment shader (the deck.gl-raster pattern). Zero
visual change. This unblocks three roadmap items that all need to *insert a
stage*: W011's GPU threshold overlay, future RVI/index stages, and a client-side
"evalscript" panel (user expressions compiled into a stage — the Sentinel
Hub/OpenLayers/Neuroglancer convergence identified in the survey). The chain
description (ordered module names + params) is data, aligning with W010's
RenderConfig. Rationale: `docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §3.

## Existing machinery (do not reinvent)

- `src/layers/shaders.js` — `glslColormaps` preamble (18 colormaps) + fragment
  shader source; shared with `src/layers/SARGPULayer.js` (inline GLSL: dB,
  6 stretch modes, per-channel contrast, CVD matrices, NISAR mask, coherence
  threshold, 4 GUNW corrections, incidence-angle handling, RGB saturation).
- `SARGPULayer` update-triggers / stable-render-config pattern — uniform changes
  must keep avoiding tile refetch and (where possible) program recompiles.
- W019's `export-render.js` imports the same shader source — the chain must
  serve both consumers or W019's parity guarantee dies.
- Blocked by W014 because the ASF line reshuffles `app/` — land this after to
  avoid a painful rebase (it touches only `src/layers/`, but W014 must settle
  which layers the SPA shell imports).

## Scope

1. **Module registry** `src/layers/shader-modules.js`: each module =
   `{name, glsl: {functions, apply}, uniforms, defaults}`; `assembleShader(
   chainSpec) -> {fragmentShader, uniformMap}` with a compile cache keyed by the
   chain signature (colormap/stretch selection stays uniform-driven, not
   recompile-driven, exactly as today).
2. **Port the existing pipeline** into modules with **pixel-identical output**.
   No new features, no reordering, no cleanup of quirks (e.g. the exact
   `10·log2(x)·0.30103` dB form) — quirks are the spec.
3. **SARGPULayer + export-render** consume `assembleShader`. Old monolithic
   strings deleted (not kept as dead code — W002 rule).
4. **Docs**: module API + how to add a stage (one page, `docs/`).

## Out of scope

- The evalscript UI itself (future order; needs W010 sign-off for RenderConfig
  serialization). Any WGSL/WebGPU. Any new visual feature. CPU fallback paths.

## Acceptance criteria

- `npm test` + `npm run build` + `npm run test:layer` green.
- Pixel-identical proof: browser harness renders the fixture scene across
  {single-band, RGB, GUNW-with-corrections} × {3 colormaps} × {3 stretches}
  before/after and asserts zero per-pixel diff (uint8 exact). Screenshots or
  diff counts in the PR.
- No new program compiles during colormap/stretch/contrast slider interaction
  (verify via program-cache counter; document in PR).
