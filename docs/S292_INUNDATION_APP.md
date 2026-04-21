# S292: Phase 2 — InundationApp + ASF auto-stack streaming

**Parent directive:** [S290](S290_APP_SEPARATION.md)
**Depends on:** S291 merged (router shell in place, `app/shared/` set up).
**Blocks:** S293 (Crop + Disturbance apps clone this scaffold).

## Scope

Ship `/inundation` as a standalone, applications-user-focused ATBD app
with a guided flow: **pick a location → system auto-selects an ASF NISAR
time-series → optional ROI → run → export.** No explore-mode controls
(no histogram, no contrast sliders, no stretch / colormap / composite
pickers). Inundation is the first algorithm because the D289 regression
test gives us ground truth for the streaming-sourced classification.

## Work

1. **Create `app/pages/InundationApp.jsx`.** Guided stepper UI:
   - **Step 1: Location.** Map click (lon/lat point), or paste
     `lon,lat` / bbox, or place-name via geocode (stretch goal — skip
     for v1, document as D296 follow-up if deferred).
   - **Step 2: Auto-stack.** Calls new `src/utils/atbd-auto-stack.js`
     (see below). Shows "Searching ASF..." → "Selected stack: 6 frames,
     2026-01-26 to 2026-04-12, orbit D/123/F456". Surfaces the chosen
     group + collapsible list of rejected groups so the user can swap.
   - **Step 3: ROI (optional).** Reuses `app/shared/ROITool.jsx`. If
     no ROI is drawn, uses the stack's valid intersection footprint.
   - **Step 4: Run.** Progress bar; calls existing `runATBD` from
     `src/utils/atbd-runner.js` with `algorithm: 'inundation'`.
   - **Step 5: View + Export.** Classification overlay is the primary
     render (via `app/shared/ClassificationOverlay.jsx` from S291).
     "Show SAR underlay" toggle reveals the dual-pol composite behind
     the classification. Export GeoTIFF + Export Figure (PNG) buttons.

2. **New `src/utils/atbd-auto-stack.js`.** Pure data-fetching module,
   reusable by S293's Crop + Disturbance apps:
   - Input: `{ lon, lat, algorithm, startDate?, endDate?, maxFrames? }`.
   - Queries CMR (via existing `src/loaders/cmr-client.js`) for NISAR
     L2 GCOV granules covering `(lon, lat)`.
   - Filters by `frequencyB` presence + polarization availability
     (`HHHH + HVHV` for Inundation).
   - Groups results by `(orbit_pass_direction, track, frame)` — the
     stackability key. Pixel-registered observations share this tuple.
   - Ranks groups by (most frames available, shortest total time span,
     highest resolution). Returns the winning group's 2-`maxFrames`
     most-recent granule URLs + metadata (bounds, dates, pols).
   - Returns alternatives for UI swap-ability.
   - Unit tests: fixture-based (hand-crafted CMR response), verify
     grouping + ranking logic. No network in tests.

3. **New streaming time-series loader.** Extend, don't fork.
   `src/loaders/nisar-loader.js` already has `loadNISARGCOVFromUrl`
   (line ~4542). Add `loadNISARTimeSeriesFromUrls(urls, opts)` that
   iterates the URL list and returns an array of frame objects matching
   the shape `handleLoadRoiTimeSeries` builds today in `main.jsx:928`.
   - Reuses existing remote RGB composite loader so each frame carries
     both `HHHH` and `HVHV` — avoids the single-pol UX gap seen during
     D288 session testing.
   - Per-frame progress callback.
   - Serial by default (ASF TEA redirect chains + Earthdata Login
     cookies don't parallelize well); optional concurrency knob later
     if measurements show it helps.
   - **S290 R4 compliance:** this is a reusable loader in `src/`, not
     a page-specific wrapper. Its existence is the reason the app
     doesn't need to duplicate frame-loading logic.

4. **URL state.** `/inundation?lon=-73.8&lat=-8.4&n=6&start=2026-01-01&end=2026-04-01&roi=x0,y0,x1,y1`.
   Serializer + parser in `app/shared/urlState.js`. Bidirectional:
   user interactions update URL via `history.replaceState`; incoming
   URL params hydrate initial state.

5. **Classification-first render path.** SARCanvas already supports
   `overlays={[...]}`. ATBD pages pass the classification result; the
   underlying SAR composite is a *secondary* overlay gated on the
   "show underlay" toggle. No new SARCanvas behavior; just new calls.

6. **Earthdata Login status bar.** Same token state that NISARSearch
   uses today (main.jsx:452). If token is missing/expired, a compact
   banner prompts for login before auto-stack runs. Reuses the existing
   token-entry UI component; if it's not yet in `app/shared/`, move it
   there in this phase (it will now have ≥2 callers, satisfying S290 R2).

7. **Playwright smoke test.** `test/e2e/inundation.spec.js`:
   - `/` → click "Inundation ATBD" card → navigates to `/#/inundation`.
   - Enter a known-coverage lon/lat (e.g. Mississippi wetlands or
     equivalent NISAR coverage area from D289 data).
   - Assert auto-stack completes within 60 s.
   - Assert "Run" button becomes active; click it.
   - Assert classification overlay renders within 60 s.
   - Assert GeoTIFF export triggers a download.
   - Test is skipped (not failed) if no Earthdata token is in the CI
     env — avoids flakiness while keeping the test meaningful locally.

8. **Landing page update.** `/inundation` card becomes live
   (no longer "coming soon").

## Out of scope for S292

- Crop / Disturbance apps (S293).
- GUNW / COG / Local extraction (S294, S295).
- Geocoding / place-name search (possible D296).
- Manual-browse granule override for users who don't want auto-stack
  (possible D297, once someone actually asks).
- Classification caching across page reloads (D298 if needed).

## Acceptance criteria

- [ ] `/` chooser shows an active "Inundation ATBD" card.
- [ ] Clicking a known-coverage NISAR lon/lat on `/inundation`
      auto-selects a stack and displays it (2-6 frames, dates, orbit
      info) within 60 s.
- [ ] "Run" produces an on-screen classification overlay within 60 s
      on a typical ROI.
- [ ] "Export GeoTIFF" produces a valid `.tif` that opens in QGIS /
      `gdalinfo` with correct bounds + CRS.
- [ ] Classification result matches D289 regression output to within
      rounding (smoke-test against the UAVSAR Mississippi stack if
      available — use the same fixture D289 uses).
- [ ] URL round-trip: copy URL, open in private window, same stack
      + same ROI + same classification reproduce.
- [ ] No histogram / contrast / stretch / colormap UI visible on
      `/inundation`.
- [ ] `npm test` + `npm run test:e2e` green.
- [ ] S290 rules pass: `lint:shared`, ESLint, no forks, no page-specific
      code in `src/`.

## Branch / PR

- Branch: `s292-inundation-app` off `main` (after S291 merges).
- PR title: `S292: /inundation ATBD app with ASF auto-stack streaming`.

## Risks

- **ASF concurrent CORS/auth.** The single-file remote load path is
  proven; N-file serial loads should be safe extrapolation but haven't
  been stress-tested. Mitigation: ship serial-by-default and measure
  real latencies before optimizing.
- **CMR query semantics for frequencyB filtering.** NISAR's CMR
  metadata may or may not expose frequency availability as a
  queryable attribute. If it doesn't, we filter client-side after
  fetching candidate granule metadata — slower but correct.
  Investigate in the first day of work and pick the simpler path.
- **"Coherent stack" definition.** Grouping by
  `(orbit, track, frame)` is the textbook answer; real NISAR metadata
  field names may differ. Grounded in `cmr-client.js` — inspect the
  actual response shape and adjust accordingly.
- **Earthdata Login token UX.** If the prompt banner isn't polished,
  applications users will get stuck. Borrow the existing explore-mode
  flow as-is for S292; revisit if usability feedback warrants.
