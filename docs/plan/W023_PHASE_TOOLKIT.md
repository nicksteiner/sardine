# W023 — Wrapped-phase toolkit v1: interactive InSAR phase manipulation

wave: G2 (GPU track, differentiator)
status: todo
blocked_by: []
branch: w023-phase-toolkit

## Objective

Every existing InSAR portal (LiCSAR, EGMS, ASF Displacement) is
server-precompute-and-chart; nobody offers *interactive client-side phase
manipulation*. SARdine already streams GUNW and renders phase with corrections —
v1 of the toolkit adds the two operations analysts actually reach for:
**(a) reference-point re-referencing** (click a point → phase/displacement shown
relative to it, GPU-subtracted) and **(b) proper rewrapping** (mod-2π wrap of
corrected/re-referenced phase under a cyclic colormap, with wrap count control
for fringe visualization). Both are per-pixel uniform ops — shader work, not new
data paths. This is the survey's "empty lane" with the lowest entry cost.
Rationale: `docs/GPU_AUDIT_AND_HORIZON_2026-07.md` §3–4. (FFT/Goldstein/unwrap
are explicitly a later order — see README backlog.)

## Existing machinery (do not reinvent)

- `src/loaders/nisar-gunw-loader.js` + `nisar-product.js` — GUNW layer loading
  (wrapped/unwrapped phase, coherence, connected components).
- `src/utils/phase-corrections.js` + SARGPULayer's four correction textures
  (iono/tropo/SET/ramp, conditionally subtracted in-shader) — re-referencing
  composes after these subtractions, same pattern.
- Cyclic colormaps already in `shaders.js`: Phase, Twilight, romaO.
- Incidence-angle LOS→vertical conversion already in the shader.
- `src/components/ContextMenu.jsx` (new, untracked, on the current WIP tree) —
  candidate host for "Set reference point"; coordinate with that WIP, and keep
  the UI touch surface minimal (W014 hazard on `app/main.jsx`).
- Coordinate→pixel machinery: `src/utils/roi-subset.js` (`bboxToPixelRange`),
  transect/point sampling paths used by ROIProfilePanel.

## Scope

1. **Shader**: uniforms `uRefPhase` (float) and `uRewrap` (0/1 + wavelength/2π
   scale); after corrections, `phase -= uRefPhase`, then optional
   `mod(phase + π, 2π) − π` before colormap. For unwrapped-displacement layers,
   re-reference in displacement units. (If W022 has landed, this is a chain
   module; if not, inline like the corrections — do not block on W022.)
2. **Reference value extraction**: on "Set reference point", sample a small
   window (e.g. 5×5 mean of valid pixels, coherence-weighted if the coherence
   layer is loaded) around the clicked pixel from the already-decoded tile data
   (CPU-side, one-off — no readback needed), set the uniform. Nodata/low-
   coherence click → warn, keep previous reference.
3. **UI**: ContextMenu entry + a small status chip showing the active reference
   (lat/lon, value) with a clear-reference control. Deep-link param `ref=lon,lat`
   parse/serialize in `src/utils/deep-link.js` (post-load pin pattern, W008/W016
   precedent).
4. **Two-date differencing**: premise-audit what the GUNW paired view already
   computes. If pairs render as separate layers only, add shader-side
   subtraction of a second phase texture behind a toggle; if that's more than a
   texture bind + subtract, record a Finding and split it out — (a) and (b) ship
   regardless.

## Out of scope

- Phase unwrapping (DCT/least-squares, SNAPHU-WASM) and Goldstein filtering —
  backlog order, needs the WGSL FFT first. Time-series. Any server component.

## Acceptance criteria

- `npm test` + `npm run build` green.
- Unit test: rewrap + re-reference math (pure function shared or mirrored CPU
  reference) on synthetic wrapped/unwrapped arrays, incl. nodata and ±π edges.
- Browser check documented in PR (real GUNW granule): click reference on a
  stable area → fringes re-center; rewrap toggle shows expected fringe pattern
  on unwrapped data; `?ref=` deep link reproduces the state.
- Export parity (CLAUDE.md rule): rendered export honors reference + rewrap
  (via W019's shared shader if merged; otherwise extend the CPU export path).
