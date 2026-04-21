# S293: Phase 3 — CropApp + DisturbanceApp

**Parent directive:** [S290](S290_APP_SEPARATION.md)
**Depends on:** S292 merged (InundationApp is the scaffold these clone).
**Blocks:** nothing.

## Scope

Ship `/crop` and `/disturbance` by cloning the InundationApp scaffold and
swapping the algorithm + the data-query shape. No new shared code should
be required — if it is, it means the Inundation scaffold wasn't generic
enough and needs extraction into `app/shared/` before S293 proceeds.

## Work

1. **CropApp (`app/pages/CropApp.jsx`)**:
   - Same guided flow as Inundation (Location → Auto-stack → ROI → Run
     → Export).
   - `atbd-auto-stack` called with `algorithm: 'crop'`:
     - Any pol works; prefer dual-pol. Target ≥6 frames over
       ≥60 days (minimum viable for temporal CV to be meaningful).
     - User-facing date-range control with defaults `startDate = now-
       120d`, `endDate = now`.
   - Algorithm param UI: CV threshold slider (default 0.25, range
     0.1–1.0). One control; no histogram clutter.
   - Runs `runATBD(frames, bounds, { algorithm: 'crop', cvThreshold })`.
   - Binary classification palette (crop / non-crop) via
     `ATBD_PALETTES.crop`.

2. **DisturbanceApp (`app/pages/DisturbanceApp.jsx`)**:
   - Same guided flow.
   - `atbd-auto-stack` called with `algorithm: 'disturbance'`:
     - ≥3 frames. User-facing window control: default last 90 days,
       adjustable to 30/60/90/180/365.
   - Algorithm param UI: `sdiffThresholdPercentile` slider (default
     80, range 50–99).
   - Runs `runATBD(..., { algorithm: 'disturbance', sdiffThresholdPercentile })`.
   - Binary palette (disturbed / undisturbed) via `ATBD_PALETTES.disturbance`.

3. **`atbd-auto-stack.js` extensions.** Add algorithm-specific date
   policies alongside the existing Inundation behavior:
   - `inundation`: 2-6 most recent dual-pol frames, no min time span.
   - `crop`: ≥6 frames spanning ≥60 days, any pol (dual preferred).
   - `disturbance`: ≥3 frames within user-picked window (default 90 d).
   Express as a single dispatch function in the same file, not separate
   per-app wrappers (S290 R4).

4. **Landing page update.** `/crop` and `/disturbance` cards become
   live.

5. **Playwright smoke tests:**
   - `test/e2e/crop.spec.js` — mount page, trigger a run on a fixture
     location, assert overlay + export.
   - `test/e2e/disturbance.spec.js` — same.

6. **Drift check (S290 R3).** Before merging, diff InundationApp vs
   CropApp vs DisturbanceApp. If >70% of the page JSX is duplicated,
   extract `<AtbdAppShell>` into `app/shared/` (takes `algorithm`,
   `paramsUI`, `extraDataFilters` as props) and rewrite the three
   pages as thin wrappers. Otherwise leave them independent. The
   call is made at PR-review time, not up-front.

## Out of scope for S293

- New algorithm params beyond what `runATBD` already accepts. If
  Crop or Disturbance needs a new tunable, that's a separate
  directive that touches `src/algorithms/`.
- Time-lapse animation of classification results (D298 candidate).
- Multi-algorithm comparison view (side-by-side Crop vs Disturbance
  on the same AOI) — interesting but a separate concept.

## Acceptance criteria

- [ ] `/crop` and `/disturbance` both live, both auto-stack correctly
      for a known-coverage lon/lat.
- [ ] CV threshold slider on `/crop` updates the classification in
      place (< 2 s recompute on a ROI-sized stack).
- [ ] Percentile slider on `/disturbance` same.
- [ ] GeoTIFF export for each produces a valid classification raster.
- [ ] Playwright smoke tests (crop, disturbance) pass.
- [ ] S290 rules pass (no forks, no page-specific code in `src/`,
      shared components still have ≥2 callers).
- [ ] `runATBD` was not modified. If it was, the modification must
      be backwards-compatible for Inundation (verify S292 tests still
      pass).

## Branch / PR

- Branch: `s293-crop-disturbance-apps` off `main` (after S292 merges).
- PR title: `S293: /crop and /disturbance ATBD apps`.

## Risks

- **Date-range sensitivity.** Crop's CV is meaningful over phenological
  cycles; Disturbance's CUSUM window needs enough "stable" pre-frames
  to detect a step-change. If defaults are wrong, results look
  nonsensical. Mitigation: ship with conservative defaults and the
  sliders exposed; let user iterate.
- **Single-pol availability.** Not all NISAR modes record frequencyB.
  Auto-stack may return empty groups. UI must handle gracefully:
  "no stacks found for this location in this window — try adjusting
  dates or picking a different location."
- **Over-extraction into `AtbdAppShell`.** Tempting to DRY early.
  Resist until the third page is written — that's when real commonality
  becomes visible. Premature abstraction will make S294/S295 harder.
