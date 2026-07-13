# W019 — GPU export parity: render exports through the WebGL2 pipeline

wave: G1 (GPU track)
status: todo
blocked_by: []
branch: w019-gpu-export-parity

## Objective

Rendered RGBA GeoTIFF/figure exports currently re-implement the entire
dB → stretch → colormap → contrast pipeline as a per-pixel JS loop
(`createRGBTexture`, ~26–40 ms/tile) — a second implementation of the fragment
shader that must be kept in sync by hand. Render export tiles through the same
WebGL2 shader pipeline as the screen (offscreen FBO + one `readPixels` per tile)
so export parity holds **by construction** and export gets ~10× faster. This is
the one genuine CPU-render gap left from the GPU audit
(`docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §1).

## Existing machinery (do not reinvent)

- `src/layers/shaders.js` — `glslColormaps` preamble + fragment shader source
  shared with `SARGPULayer.js` (the ground-truth pipeline).
- `src/gpu/webgl-spatial-filter.js` — the repo's proven render-to-R32F-FBO
  pattern, including `EXT_color_buffer_float` check, shader program cache
  (WeakMap per context), and full GL state save/restore. Copy its discipline.
- `src/utils/sar-composites.js:391–479` — `createRGBTexture` (the CPU path to be
  demoted to fallback). Callers: `app/main.jsx:4410` and `:4669` (export tile
  loops); `src/utils/figure-export.js` consumes the result.
- `src/utils/gpu-detect.js` — `probeGPU().gpuRendering` gates the GPU path.
- Export applies a 3×3 spatial smooth to rendered exports (CLAUDE.md
  "Important Implementation Details") — the GPU path must preserve this.

## Scope

1. **New module `src/utils/export-render.js`**: `renderTileGPU(bands, width,
   height, renderParams) -> Uint8ClampedArray (RGBA)`. Owns a lazily-created
   OffscreenCanvas WebGL2 context (falls back to a hidden canvas element),
   uploads band Float32Arrays as R32F textures, renders a fullscreen quad with
   the same fragment shader + uniform mapping the screen uses (import from
   shaders.js — do not fork the GLSL), `readPixels` once. Program cache keyed by
   shader variant; context reused across tiles; handles single-band + RGB
   composite + per-channel contrast + CVD + NaN/zero masking.
2. **main.jsx call sites**: swap `createRGBTexture(...)` for
   `renderTileGPU(...)` with `createRGBTexture` as the fallback when
   `gpuRendering` is false or the GPU path throws. **Touch surface must stay
   minimal** (two call sites + import) — W014 renames `app/main.jsx` to
   `app/pages/GCOVExplorer.jsx`; expect a rebase.
3. **Parity harness**: a browser-run comparison (extend `npm run test:layer` or
   the debug page) rendering synthetic Float32 tiles through both paths across
   {grayscale, viridis} × {linear, sqrt, gamma} × {single-band, RGB} and
   asserting per-channel |Δ| ≤ 2 (uint8) for finite pixels and exact
   transparent-mask agreement. Document numbers in the PR.
4. Keep the 3×3 smooth where it currently happens (pre- or post-render — audit
   the call order first; it operates on raw power before compositing, so it
   likely stays upstream untouched).

## Out of scope

- Raw Float32 export path (already correct — no rendering involved).
- WebGPU render targets; figure-export overlay drawing (canvas 2D, fine).
- Removing `createRGBTexture` (it remains the no-WebGL fallback).

## Acceptance criteria

- `npm test` + `npm run build` green.
- Parity harness passes with tolerances above; results (max Δ per combo) in PR.
- Timing evidence in PR: per-tile export render before vs after on a real NISAR
  GCOV scene (expect ≥5× on the render step).
- Fallback proven: force `gpuRendering=false`, export still completes,
  output identical to pre-change CPU path.
