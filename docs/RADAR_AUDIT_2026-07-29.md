# Radar / Colormap Audit — 2026-07-29

Audit of SAR-domain correctness across code and docs, plus verification of every
colormap against authoritative data (matplotlib `_cm_listed` data files; official
Crameri data via cmcrameri).

## Resolution status (2026-07-29, same day)

- **Colormaps**: fixed and verified (Part 1).
- **Docs D1–D19**: all corrections applied, plus the Lee formula in
  SAR_PROCESSING_ROADMAP.md.
- **Code findings**: fixed — C1/C2 (LOS conversion wired via a `valueScale`
  layer prop using the per-product wavelength; vertical projection now runs on
  meters), C3 (Lee weight → `(var−noiseVar)/var` in all 9 sites), C4 (complex
  multilook before atan2, incl. the pixel-probe window), C8 (co/cross threshold
  3→6 dB + corrected comments), C9 (densified edge reprojection), C10
  (EPSG-aware `isProjectedBounds`, threaded through ScaleBar/grid/figure
  export), C11 (correction toggles disabled when the processor already applied
  them), C12 (Enhanced-Lee `Cmax = √(1+2/ENL)`), C13 (speckle filter forced off
  for GUNW products), C14 (ramp-fit coherence default 0.7→0.4), C15 (correction
  eval cap 512→1024).
- **Mitigated, not fully resolved**: C5 — the Pauli (power) and Freeman-Durden
  presets are **hidden from the UI** pending a correct full-covariance
  implementation (polarimetric decompositions parked); C6 — loader/shader mask
  comments reconciled to one documented convention, but per-code meanings still
  need verification against the NISAR GCOV product spec mask table; C7 —
  compact-pol terms are now split/labeled but mode-aware defaults remain to do.
- **Open**: C14's second half (planar-ramp correction is still unwired from the
  UI — `fitPlanarRamp` has no producer; feature gap, not an error).

---

## Part 1 — Colormaps (FIXED in this change)

Every ramp was sampled at 9 stops and compared against ground truth.
Files fixed: `src/utils/colormap.js`, `src/layers/shaders.js` (GLSL, used by both
`sarFragmentShader` and `SARGPULayer`), `src/utils/tone-mapping.js`.

| Colormap | Max component error (before) | What was wrong |
|:---------|:----------------------------:|:---------------|
| **inferno** | **0.99** | Polynomial coefficients were fabricated — the ramp rendered near-black across its entire range (t=1 gave RGB ≈ (0, 0.19, 0.06) instead of bright yellow) |
| **plasma** | **0.89** | Wrong coefficients — ramp stayed blue→cyan instead of violet→orange→yellow. Comment claimed "Matplotlib canonical coefficients"; they were not |
| **viridis** | **0.77** | `c1` green/blue terms wrong (0.6389/0.7916 vs canonical 1.4046/1.3846) — ramp ended red-orange instead of yellow, green channel collapsed |
| **romaO** | **0.32** | Stop table did not match Crameri's romaO at any interior stop (invented red-brown→orange cycle vs actual mauve→orange→green→blue cycle) |
| **twilight** | **0.25** | Mid-cycle stops wrong: nadir was "dark teal" (0.19, 0.33, 0.37); actual matplotlib twilight nadir is dark purple (0.19, 0.08, 0.21). 0.125/0.875 stops also off |
| **batlow** | **0.21** | Top quarter drifted: endpoint (0.98, 0.80, **0.77**) vs official (0.98, 0.80, **0.98**) — ended salmon instead of pale lavender-pink |
| **cividis** | **0.12** | All interior stops systematically dark/lagging (repo's t=0.5 value ≈ true cividis at t≈0.39) |
| **magma** | 0.09 | Only 0.75/0.875 stops slightly off — fixed for parity |
| tone-mapping.js "viridis" | ~0.35 | Self-labeled approximation ended blue-tinged white; replaced with canonical polynomial |

Correct after fix: grayscale, turbo (Mikhailov coefficients verified exact), rdbu
(matches matplotlib RdBu_r), sardine (canonical cubehelix coefficients), phase
(analytic), and the brand ramps (flood/diverging/polarimetric/label/coherence —
no external reference; internally consistent).

Verification: all maps now within 0.035 of ground truth (residual is the inherent
accuracy of the degree-6 polynomial fits); CPU (colormap.js) vs GPU (shaders.js)
max divergence 0.002 over 201 samples per map. `npm test` green.

Replacement sources: viridis/inferno/plasma use the canonical degree-6 polynomial
fits of the matplotlib data; stop tables resampled from matplotlib
`_cm_listed.py` and official Crameri batlow/romaO 256-row data.

---

## Part 2 — Radar errors in code (NOT yet fixed)

### High priority

**C1. LOS-displacement toggle never converts the data — it only rescales the
contrast limits.** `app/main.jsx:8059-8072`. The λ/(4π) factor and λ = 0.2384 m
are right, but they are applied to `contrastMin/Max` only; the texture still
holds radians and no `uPhaseScale`-style uniform exists in any layer. Net
effect: the contrast window becomes ~52× too narrow, the RdBu display saturates
everywhere, and the axis is labeled "(m)" on data that is still radians. Fix by
scaling the sampled value (shader uniform or at load). Also: the physical
convention is d_LOS = −λ/(4π)·φ (ISCE3 sign: positive phase = range decrease);
the missing minus flips red/blue on every deformation map. And the hardcoded
0.2384 m ignores the per-product λ already computed at
`nisar-gunw-loader.js:152` (wrong for S-band granules).

**C2. Vertical-displacement toggle divides radians by cos θ.**
`SARGPULayer.js:275-291`. d_vert = d_LOS/cos θ is the right geometry, but it is
applied to unwrapped phase (C1 means the data was never converted to meters),
producing a unit-less hybrid. Must run after the λ/(4π) conversion.

**C3. Lee filter uses the additive-noise (Wiener/Kuan-style) weight instead of
the multiplicative-speckle Lee weight — in every backend.**
`src/gpu/spatial-filter.js:202-206` (+ lines 281, 449, 540, 577, 665) and
`src/gpu/webgl-spatial-filter.js:98-161`. Implemented: `K = var/(var+noiseVar)`.
Lee (1980): `K = clamp((var − noiseVar)/var, 0, 1)` with `noiseVar = mean²/ENL`.
In a homogeneous (speckle-only) region correct K → 0 (full smoothing); the
implemented K → 0.5, so every filter retains half the speckle. The docstring
("K→0.5, partial filtering") documents the bug as intended, and
`docs/SAR_PROCESSING_ROADMAP.md` §1.2-1.3 carries the same wrong formula —
fix both together.

**C4. Wrapped interferometric phase is multilooked by arithmetic averaging.**
`nisar-gunw-loader.js:459-466`: `extractPhaseFromComplex` (atan2, wraps to
(−π, π]) runs *before* `multilookFloat32`. Adjacent pixels at +3.1 and −3.1 rad
average to 0 — every 2π branch cut becomes a spurious mid-gray band at ml > 1.
Correct: multilook the complex samples (sum re/im over the window), then atan2.

**C5. Freeman-Durden volume model does not match the cited reference.**
`src/utils/sar-composites.js:57-101` cites "random-dipole-cloud (Freeman &
Durden 1998)" but uses fv = 4·C22 with co-pol subtraction fv/2 = 2·C22. The
1998 random-dipole model has ⟨|HH|²⟩v = ⟨|VV|²⟩v = fv, ⟨|HV|²⟩v = fv/3,
⟨HH·VV*⟩v = fv/3 — i.e. fv = 3·C22, co-pol subtraction 3·C22, volume span
8·C22 (code: 6·C22). The code under-subtracts volume, biasing Ps/Pd high in
vegetated scenes. The surface/double-bounce branch (`Ps = c33r;
Pd = c11r − |c13r|²/c33r`) is also a heuristic, not the paper's α=−1 / β=1
solution (fd = (C11r·C33r − |C13r|²)/(C11r + C33r + 2Re C13r), etc.).

### Medium priority

**C6. Mask semantics contradict between loader and shader.**
`nisar-loader.js:1502` (and :3299): "0=invalid, 1-5=valid, 255=fill".
`SARGPULayer.js:211-216`: "2+=layover/shadow" and discards everything in
(1.5, 254.5) when masking layover/shadow — deleting pixels the loader calls
valid (likely including water). Reconcile against the GCOV mask encoding table;
test specific codes, not `> 1.5`. Related doc typo: mask range "0-155" in
`NISAR_GCOV.md:222` / `NISAR_GUNW.md:228` (should be 0-255), and six
cross-references point to a `NISAR_PRODUCTS.md` that does not exist.

**C7. Compact-pol terms conflated with linear-pol.** `nisar-loader.js:45-48`,
`nisar-product.js:328`: RHRH/RVRV (compact-pol, circular transmit) sit in the
linear quad-pol `DIAGONAL_TERMS` list with the same [−30, 0] dB default; the
code has no linear-vs-compact mode concept.

**C8. Polarization-guessing heuristic is physically wrong.**
`nisar-loader.js:4318-4332`. (a) "Strongest signal is always co-pol (HHHH)":
co-pol > cross-pol is safe, but HH vs VV ordering is scene-dependent (VV > HH
over most vegetation/bare soil at L-band; HH > VV over sea ice) — sorting by
power and assigning means[0]=HHHH, means[1]=VVVV mislabels many scenes.
(b) The 3 dB co/cross threshold in the 2-band case is too small (HH/VV spread
can exceed it; co/cross separation is typically 6–12 dB). Use ~5-6 dB and flag
the assignment as unverified in the UI.

**C9. Two-corner bbox reprojection clips data on projected grids.**
`roi-subset.js:56-65`. A lat/lon rectangle maps to a curved quadrilateral in
UTM; sampling only SW/NE corners under-estimates the bbox and silently clips
east/west margins — worst at high latitude, exactly where NISAR polar scenes
live. Reproject all 4 corners + densified edge points.

**C10. `isProjectedBounds` magnitude heuristic breaks polar scenes.**
`geo-overlays.js:34` (`|x| > 180` test) drives scale-bar rendering and °-vs-m
labels. Polar stereographic (EPSG:3031/3413) eastings within ±180 m of the pole
— or a small UTM subset — get labeled in degrees and lose the scale bar. The
true EPSG is already read in `nisar-product.js`; thread it through.

**C11. GUNW corrections applied without checking "already applied" flags.**
`nisar-gunw-loader.js:160-171` reads `appliedIonosphereCorrection` etc., but
`phase-corrections.js` / `SARGPULayer.js:239-273` never consult them — enabling
a toggle the processor already applied double-subtracts the screen.

### Lower priority / suspicious

- **C12.** Enhanced-Lee `Cmax = √2·Cu` (`spatial-filter.js:268`) vs Lopes et
  al. 1990 `Cmax = √(1 + 2/ENL)` — point-target cutoff fires far too early
  (0.71 vs 1.22 at ENL=4). The Gamma-MAP branch uses a third expression; check
  all against the paper.
- **C13.** Speckle filters are a global render setting with no product gate:
  applied to GUNW phase they clamp negatives to 0 and treat 0 as nodata, but
  for GUNW "nodata is NaN — zero phase is valid" (`SARGPULayer.js:237`).
- **C14.** `fitPlanarRamp` correct but unreachable (no 'ramp' in
  `CORRECTION_TYPES`); `uCorRamp` has no producer. Default
  `coherenceThreshold = 0.7` is aggressive for L-band over vegetation.
- **C15.** Tropo/SET cubes resampled to fixed ≤512×512 (`phase-corrections.js:95`)
  — ~15 km/sample on a large frame; check against the native cube grid.

Verified correct in code (no action): 10·log10 everywhere for GCOV power
(stats.js, shaders, composites — no 20·log10 mixups); inverse-dB multilook in
geotiff-writer.js; ENL = mean²/var; Cloude-Pottier entropy/anisotropy in
matrix.js; atan2/magnitude complex extraction; λ = c/f; γ⁰ = σ⁰/cos θ incidence
normalization; metadata-cube interpolation; RVI formulas in sar-indices.js
(quad 8HV/(HH+VV+2HV) = Kim & van Zyl 2009; dual 4·cross/(co+cross)).

---

## Part 3 — Radar errors in docs (NOT yet fixed)

| # | File:line | Error | Correction |
|---|-----------|-------|------------|
| D1 | `NISAR_GCOV.md:244` | Pauli preset table uses `HHHH−VVVV` / `HHHH+VVVV` power differences as Pauli channels | True Pauli needs Re(HHVV): R=(HHHH+VVVV−2Re HHVV)/2, B=(HHHH+VVVV+2Re HHVV)/2 (as `POLSAR_DECOMPOSITION_ROADMAP.md:152` correctly states). Label the preset "power approximation (no phase)" |
| D2 | `H_ALPHA_IMPLEMENTATION.md:55-59` | Pauli basis-change matrix is not unitary (√2/−√2 in row 2, 2 in row 3) | Rows: [1 0 1], [1 0 −1], [0 √2 0], all × 1/√2 |
| D3 | `H_ALPHA_IMPLEMENTATION.md:62,144` | `c22 = HVHV` under lexicographic basis | `c22 = 2·HVHV` (√2 factor NOT applied in GCOV symmetrization per `NISAR_GCOV.md:176`) — biases entropy/alpha low |
| D4 | `H_ALPHA_IMPLEMENTATION.md:211-212` | "High alpha = volume scattering" | α≈45° = volume; α→90° = double-bounce. Also high anisotropy ≠ "oriented targets" (A = (λ2−λ3)/(λ2+λ3), meaningful mainly at moderate/high entropy) |
| D5 | `H_ALPHA_IMPLEMENTATION.md:226`, `POLSAR_DECOMPOSITION_ROADMAP.md:20-21` | Reciprocity used to claim HHVH ≈ HHVV*, VVVH ≈ 0 | Reciprocity gives HHVH = HHHV only; zeroing co×cross terms is the separate *reflection-symmetry* assumption |
| D6 | `DATA_WORKFLOW.md:163` | "Switch to VV polarization (best for flood detection)" | HH is preferred (darker open water; strongest double-bounce over flooded vegetation) — and NISAR's standard land mode is HH+HV, so VV usually isn't in the file |
| D7 | `DATA_WORKFLOW.md:94-113`, `VISUALIZATION.md:194` | GCOV grid described as EPSG:4326 lat/lon; `frequencyB` labeled "S-band" | GCOV is UTM/polar-stereographic in meters (per-frame EPSG); frequencyB is the second sub-band of the same radar — S-band is a separate `SSAR/` root |
| D8 | `TUTORIAL_GCOV.md:166-172` | Flooded-veg HH/HV ratio labels contradict the table's own numbers ("Very High" row computes 0–6 dB; "Moderate" row computes 7–13 dB) | Swap labels; raise canopy-over-water HH to ~−8 to −3 dB; open-water "High ratio" is noise-floor-dominated, not a reliable discriminator |
| D9 | `TUTORIAL_GCOV.md:123-124` | RGB table: Blue (high HH/HV) = "Water"; Yellow = "Flooded vegetation" | Water is dark in all channels (README:185 says so); high ratio = smooth bare surfaces. High HH+HV = dense forest; flooded veg trends red (HH up, HV unchanged) |
| D10 | `tutorial-gunw.md:282` | "L-band sees ~4x more ionospheric contamination" (1/f) | In phase, ~4.3×; in equivalent LOS displacement (what the doc uses elsewhere), ∝1/f² ≈ 18× |
| D11 | `VISUALIZATION.md:173` | Chunk sub-sampling credited with "16–64 looks per output pixel" | Decimation gives 1 look; only averaging increases ENL |
| D12 | `tutorial-gunw.md:273` | Max measurable gradient "~1 fringe per pixel" | Unwrapping Nyquist limit is half a fringe (π) per pixel: ~6 cm / 80 m ≈ 0.075% |
| D13 | `tutorial-gunw.md:97-98` | Blue/red = toward/away asserted without phase-sign convention; westward/eastward parenthetical hard-codes descending geometry | State the ISCE3 sign convention; right-looking: ascending looks east, descending looks west |
| D14 | `TUTORIAL_GCOV.md:132` | Pauli "requires quad-pol (HH, HV, VH, VV)" | Requires full covariance (complex HHVV term), not just the four powers |
| D15 | `TUTORIAL_GCOV.md:52` | `numberOfLooks` = "independent samples" | Contributing radar samples are correlated; ENL (which governs speckle, σ/μ = 1/√ENL) is generally lower — don't feed numberOfLooks to ENL-based filters |
| D16 | `NISAR_GUNW.md:255` | "steep incidence angles" used for θ=50° | 50° is shallow/oblique; steep = near-nadir small θ |
| D17 | `NISAR_GCOV.md:226,231` | Exact-zero power = "shadow" | Zero illuminated area: shadow, layover exclusion, or no contributing samples |
| D18 | `TUTORIAL_GCOV.md:22` | RTC brightening attributed to "foreshortening" | Brightening is the projected-area / local-incidence effect; foreshortening is the geometric range compression |
| D19 | various | λ quoted as 24 cm / 23.84 cm / "1.2 GHz" inconsistently; coherence "reliable > 0.5" vs three-tier 0.3/0.7 guidance | Standardize on λ = 0.2384 m (1.2575 GHz); align coherence guidance |

Note: `docs/SAR_PROCESSING_ROADMAP.md` §1.2-1.3 specifies the same incorrect
Lee weight as the code (C3) — the doc and code must be corrected together, or
a doc-driven reimplementation will reproduce the bug.
