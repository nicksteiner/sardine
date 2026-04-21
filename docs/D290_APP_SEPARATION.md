# D290: Separate URL-Based Entry Points (App Separation)

**Short answer:** turn SARdine from a single explore-everything page into a
family of URL-addressable apps. `/explore/gcov`, `/explore/gunw`, `/inundation`,
`/crop`, `/disturbance`, `/local`. Each route boots a focused UI targeted at a
specific user question. Shared rendering and loaders stay in `src/`. This is
a routing + code-organization refactor — no algorithm changes, no new
features in this directive.

## Why now

D285 ported three NISAR ATBD algorithms. D288 wired them into `app/main.jsx`
as a panel inside the existing ROI time-series UI. D289 validated Inundation
against the JPL reference. The algorithms work and are tested; the remaining
gap is **surface**:

- `app/main.jsx` is now ~6000 lines with histogram, contrast, stretch,
  colormap, RGB composite, GCOV, GUNW, local-file, remote-URL, CMR search,
  ROI drawing, time-series, and ATBD controls all coexisting in one panel.
  Every feature pays the cost of every other feature's complexity.
- An applications user (a hydrologist running Inundation, an agronomist
  running Crop) does not care about contrast sliders or stretch curves. The
  exploration UI obscures their workflow.
- A shareable URL is the natural delivery vehicle for a science app. Today
  there is no way to hand a colleague a link that lands them in the right
  tool with the right data. URL params (`?cog=`, `?url=`) exist but only
  seed a single-file view.
- ATBD-mode requires an auto-stack flow against ASF streaming (D290's
  companion directive for auto-selection). That flow is fundamentally
  different from the explore flow — pick an algorithm, fetch data for it,
  classify, export — and does not belong in the same panel.

Separating routes *before* building the ATBD auto-stack flow avoids a second
rewrite later.

## Target URL surface

```
/                       Landing chooser
/local                  Drop-file explorer (current default)
/explore/gcov           GCOV explorer (current main.jsx UI, full controls)
/explore/gunw           GUNW explorer
/explore/cog            Cloud Optimized GeoTIFF viewer
/inundation             Inundation ATBD app
/crop                   Crop Area ATBD app
/disturbance            Disturbance ATBD app
```

### Per-route user persona and stripped controls

| Route | Persona | Keeps | Strips |
|:------|:--------|:------|:-------|
| `/local` | Anyone, ad hoc | File drop, auto-detect, all controls | nothing |
| `/explore/gcov` | SAR engineer | Full current UI | nothing |
| `/explore/gunw` | InSAR analyst | GUNW-specific layers, unwrap visualization | GCOV-only composites |
| `/explore/cog` | Generic raster user | COG URL + contrast + colormap | NISAR-specific panels |
| `/inundation` | Hydrologist, disaster response | Location picker, date range, ROI, Run, Export | histogram, contrast, stretch, colormap, composite, GUNW, polarization picker |
| `/crop` | Agronomist | Same as Inundation | same as Inundation |
| `/disturbance` | Forester, land-cover analyst | Same as Inundation + window-size control | same as Inundation |

The ATBD routes all share the same guided flow:
**Location → Auto-stack → ROI (optional) → Run → Export.**

### URL query-param convention

Each route encodes its state in query params so a URL is a reproducible run.

```
/inundation?loc=-73.80,-8.42&n=6&start=2026-01-01&end=2026-04-01
/inundation?url=https://asf.alaska.edu/...#01.h5,https://...#02.h5&roi=...
/explore/gcov?url=https://.../file.h5&freq=B&pol=HHHH
/explore/cog?url=https://.../file.tif
```

Params are read on mount, written back on state change via
`history.replaceState` (no navigation, no full reload). Deep links are the
only persistence layer — no accounts, no server-side state.

## Routing library decision

**Use [Wouter](https://github.com/molefrog/wouter)** — ~1 KB gzipped,
hook-based API, no nested routes, no data loaders. The app has five flat
routes and no auth/guard requirements, so React Router v6 (~10 KB + ecosystem
weight) is overkill.

**Use HashRouter, not BrowserRouter.** The app deploys to:

- JupyterHub proxy at `.jpl.nasa.gov` (path-rewritten subpaths)
- Static CDN targets (GitHub Pages, Cloudflare Pages, S3 + CloudFront)
- Local `file://` for offline demos

Hash routing (`/#/inundation`) works under all three without server-side
SPA rewrites. `vite.config.js` already uses `base: './'` for relative
paths — hash routing is the natural pair. If we ever land on a host with
full SPA rewrite support we can swap to pathname routing without changing
component code.

## File layout

```
app/
├── index.html              (unchanged — single HTML entry)
├── main.jsx                Router shell + theme + top-level providers (~100 lines)
├── pages/
│   ├── Landing.jsx         /         — chooser with big cards per app
│   ├── LocalExplorer.jsx   /local    — drop zone, full controls
│   ├── GCOVExplorer.jsx    /explore/gcov  — extracted from today's main.jsx
│   ├── GUNWExplorer.jsx    /explore/gunw
│   ├── COGExplorer.jsx     /explore/cog
│   ├── InundationApp.jsx   /inundation
│   ├── CropApp.jsx         /crop
│   └── DisturbanceApp.jsx  /disturbance
└── shared/
    ├── SARCanvas.jsx       deck.gl + MapLibre render surface (shared by all)
    ├── ROITool.jsx         ROI drawing on map
    ├── StatusWindow.jsx    (already a component)
    ├── Histogram.jsx       (already a component; used only by /explore/*)
    ├── ClassificationOverlay.jsx  (used only by /<atbd>)
    └── urlState.js         hooks for query-param read/write per route

src/                        (unchanged — rendering, loaders, algorithms)
```

The critical extraction is `GCOVExplorer.jsx`: everything currently in
`app/main.jsx` body moves into this one page component. The rest of the
app is new code or light reuse.

## Shared vs per-route code

**Shared (`app/shared/` and `src/`)** — survives across every route:
- `SARCanvas` — the deck.gl/MapLibre/SARGPULayer render stack
- All `src/loaders/*` (COG, NISAR GCOV, NISAR GUNW, CMR search, STAC)
- All `src/layers/*`, `src/utils/*`, `src/algorithms/*`
- `StatusWindow`, `ROITool`, theme CSS

**Per-route** — each page imports only what it needs:
- `/explore/gcov` imports histogram, contrast sliders, composite picker, stretch mode, etc.
- `/inundation` imports `runATBD`, auto-stack logic, `ClassificationOverlay`, minimal export UI
- `/local` imports file-drop + everything (it's the catch-all)

**No global store.** Each page owns its own state. URL query params are the
only thing that crosses route boundaries. This is a deliberate choice: each
route is an independent app that happens to share a rendering core.

## Keeping flavors in sync — hard rules

**The drift hazard:** once the app is five routes, each one edited by a
different developer on a different day for a different user audience, it
will gradually stop being the *same* app. The Inundation page will grow a
subtly different `SARCanvas` wrapper. The Crop page will fork the streaming
loader "just to add a filter." Six months later, a fix to the loader ships
to GCOV Explorer but not to Crop, because nobody remembers they diverged.

This section exists because drift is the single biggest risk of this
refactor, and it has to be prevented at the architectural layer — not
policed at review time. The rules below are **enforceable** (via lint /
CI / directory layout), not aspirational.

### The propagation contract

| Change made in... | Automatically reaches... | Why |
|:---|:---|:---|
| `src/loaders/*` | every app that streams data | one loader, many callers |
| `src/layers/*`, `src/layers/shaders.js` | every app that renders SAR | GPU path is singular |
| `src/utils/*` (stats, stretch, colormap, geotiff-writer, figure-export) | every app that uses them | math and export have one true copy |
| `src/algorithms/*` | every ATBD app that imports them | algorithms are pure modules |
| `src/theme/sardine-theme.css` | every page | theme loaded once in the router shell |
| `app/shared/SARCanvas.jsx` | every page that shows a map | rendering surface is singular |
| `app/shared/{ROITool,StatusWindow,ClassificationOverlay,Histogram}.jsx` | every page that imports them | UI primitives, not per-app copies |

Deploying one bundle (`dist/`) for all routes means every flavor is on
the same version by construction — a build invariant, not a process.

### Hard rules (enforced)

**R1. `src/` is source-of-truth. No page-specific code in `src/`.**
- `src/` is the SARdine library. Any module added there must be usable by
  ≥2 pages or be plausibly reusable by a future page/Node consumer.
- If a module is only ever used by `InundationApp`, it lives at
  `app/pages/InundationApp/` (or inline in the page file), not in `src/`.
- **Enforced by**: ESLint rule `no-restricted-imports` — `src/*` files
  cannot import anything from `app/*`. Violation fails CI.

**R2. `app/shared/` is for components used by ≥2 pages. Single-use components
live next to their page.**
- When a component starts being imported by a second page, move it into
  `app/shared/`. When it drops back to one caller, move it back — do not
  let `app/shared/` become a dumping ground.
- **Enforced by**: a Node script in CI that parses imports and fails if
  any `app/shared/*` file has exactly one caller across `app/pages/`.
  (`npm run lint:shared`, wired into `npm test`.)

**R3. No forks. Extend shared components via props, never by copy-and-edit.**
- If `InundationApp` needs `SARCanvas` to render a classification overlay,
  add a prop to `SARCanvas` (`overlays`, `classification`, etc.). Do not
  create `InundationSARCanvas.jsx`.
- The moment a `FooForX.jsx` file exists next to `Foo.jsx`, the rule has
  been broken and the fork must be reconciled before merge.
- **Enforced by**: code review + a CI grep check that flags filenames
  matching `^(.+)For(.+)\.jsx$` or `^(.+)\.<page>\.jsx$`.

**R4. Loaders, exporters, and algorithms have exactly one entry point.**
- `loadNISARGCOV`, `loadNISARGCOVFromUrl`, `writeRGBAGeoTIFF`,
  `runInundationATBD`, etc. — each lives in one file, exported from
  `src/index.js`. Pages import from `src/` or from `sardine` (the alias).
- Pages do **not** re-implement thin wrappers with "just a small tweak."
  If a tweak is needed, it becomes a parameter on the canonical function.
- **Enforced by**: code review. Any PR adding a wrapper function whose
  body calls an `src/` function with slightly different args gets pushed
  back into `src/` as a parameter.

**R5. Every route has a Playwright smoke test in CI.**
- One test per route that mounts the page and executes one meaningful
  action (e.g. `/inundation`: click a known coverage point, assert
  classification overlay appears within 30 s).
- A `src/` change that breaks any route fails CI before the offending
  PR merges.
- **Enforced by**: CI gate. `npm run test:e2e` runs all route smoke
  tests in every PR.

**R6. One build artifact per deploy. No per-route deploys.**
- `dist/` contains all routes. Deploy all-or-nothing. There is no way to
  push `/inundation` at version N while `/explore/gcov` is stuck at N-1.
- **Enforced by**: build system. Vite produces a single SPA; hash routing
  means all routes share one `index.html` + shared vendor chunk + per-route
  chunks from the same build.

**R7. Shared UI primitives render the same visual chrome across flavors.**
- Header bar, status window position, theme colors, focus/hover states
  are controlled centrally by `app/main.jsx` (router shell) + theme CSS.
- Pages can choose to hide chrome (e.g. `/inundation` may hide the
  colormap panel) but cannot restyle chrome. A user who has seen one
  SARdine flavor should recognize another on sight.
- **Enforced by**: code review. Any page-level CSS that overrides
  `var(--*)` theme variables is a red flag.

**R8. Version + build SHA visible on every route.**
- The router shell reads `import.meta.env.VITE_BUILD_SHA` (or injects via
  `define`) and the `package.json` version, and renders them in a
  consistent footer/corner on every page.
- If a user reports a bug from `/crop`, the version is visible and
  matches every other flavor. No "which version were you on" ambiguity.
- **Enforced by**: Phase 1 acceptance criterion.

### What drift looks like in a code review

If a PR includes any of the following, it violates the rules above and
needs to be reshaped before merge:

- A new file `app/pages/InundationApp/loaders.js` duplicating `src/loaders/`
  logic "just for inundation."
- A `SARCanvasInundation.jsx` or `SARCanvas.atbd.jsx` next to `SARCanvas.jsx`.
- A new `src/utils/inundation-helpers.js` that imports from `app/`.
- A `useInundationState` hook in `app/shared/` referenced by only one page.
- A CSS file in `app/pages/*` that sets `--surface`, `--text`, or any
  theme variable defined in `src/theme/sardine-theme.css`.
- A streaming function that duplicates `loadNISARGCOVFromUrl` with a
  hardcoded filter or a subtly different cache policy.

### CI / lint wiring (Phase 1 deliverable)

Add to `.eslintrc.json`:

```json
{
  "overrides": [
    {
      "files": ["src/**/*.{js,jsx}"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [{
            "group": ["../app/*", "app/*", "@app/*"],
            "message": "src/ cannot import from app/. Move the shared code into src/, or keep the page-specific code in app/pages/."
          }]
        }]
      }
    }
  ]
}
```

Add `scripts/check-shared-usage.mjs` (called by `npm run lint:shared` and
wired into `npm test`):

1. Walks `app/shared/*` and `app/pages/**`.
2. For each `app/shared/<Component>.jsx`, counts importers in `app/pages/`.
3. Fails if any shared component has exactly one importer (move it back
   to the page), or zero importers (delete it or move to page).
4. Greps for forbidden filename patterns (`*For*.jsx`, `*.<page>.jsx` when
   `<page>` matches a sibling file).

Add a Playwright config in Phase 1 with route smoke tests added
incrementally per phase:
- Phase 1: `/`, `/explore/gcov` (existing behavior)
- Phase 2: `/inundation`
- Phase 3: `/crop`, `/disturbance`
- Phase 4: `/explore/gunw`
- Phase 5: `/explore/cog`, `/local`

### Code-review checklist (committed in CONTRIBUTING.md)

A PR touching multiple flavors or `src/` must have a review comment
confirming each item:

- [ ] If this changes a shared component/loader/utility, every flavor that
      uses it still works (checked by CI smoke tests).
- [ ] No new file in `src/` imports from `app/`.
- [ ] No new file in `app/shared/` has only one caller.
- [ ] No filename pattern suggests a fork (`*For*.jsx`, `*.<page>.jsx`).
- [ ] Any new prop on a shared component has a sensible default so
      existing callers don't need updating.
- [ ] Version + build SHA footer renders on every touched route.

## Build / bundle strategy

Single HTML entry + hash routing = SPA. Vite code-splits each page via
`React.lazy` + `Suspense`:

```jsx
const InundationApp = lazy(() => import('./pages/InundationApp.jsx'));
const CropApp       = lazy(() => import('./pages/CropApp.jsx'));
// ...

<Switch>
  <Route path="/inundation"><InundationApp /></Route>
  <Route path="/crop"><CropApp /></Route>
  ...
</Switch>
```

First load of `/inundation` pulls the shared vendor chunk (React, deck.gl,
luma.gl, SARGPULayer), the inundation page bundle, and the inundation
algorithm. It does not pull the GCOV explorer's histogram panel or the GUNW
code. Bundle-analyzer check is in Phase 1 acceptance criteria.

`src/algorithms/*` individually re-exports today (`src/algorithms/index.js`).
ATBD pages import directly from the specific algorithm module, not from
`index.js`, so unused ATBDs tree-shake.

## Phased migration

The plan is bottom-up. Do not attempt to decompose `main.jsx` top-down —
that's a month-long refactor with a broken app in the middle. Instead,
extract one page at a time, leaving the old `main.jsx` untouched until
enough is peeled off.

### Phase 1 — Router shell + Landing + GCOVExplorer extraction

**Goal:** nothing looks different to the user; the single page is now served
under `/#/explore/gcov` with a chooser at `/`.

Work:
1. Add Wouter dep, wire `HashRouter` into `app/main.jsx` as a ~100-line shell.
2. Move current `app/main.jsx` body → `app/pages/GCOVExplorer.jsx` (almost
   a pure rename; imports rebase to `../shared/` and `../../src/`).
3. Create `app/pages/Landing.jsx` — a chooser with one big card per app
   (links currently go: `/explore/gcov` live, others disabled/"coming soon").
4. Smoke-test: drop a NISAR file, draw an ROI, run an ATBD as the panel
   today. Everything works.
5. Bundle analysis: confirm Landing loads <100 KB, GCOVExplorer loads the
   existing weight.

**Acceptance:** all 232 existing tests pass; manual smoke-test matches
pre-refactor behavior; shareable URL `#/explore/gcov?url=...` works.

### Phase 2 — InundationApp

**Goal:** `/inundation` is a standalone working app with no explore controls.

Work:
1. Create `app/pages/InundationApp.jsx` with the guided flow:
   Location picker (map click + optional place-search stub) → auto-stack
   call → stack preview → optional ROI draw → Run → classification view +
   Export.
2. Extract `ClassificationOverlay` into `app/shared/` if not already there.
3. Auto-stack logic lives in a new `src/utils/atbd-auto-stack.js` that:
   queries CMR for NISAR granules at the clicked location filtered to
   frequencyB + HHHH/HVHV availability, groups by (orbit, track, frame),
   picks the best group by (most frames, shortest span), returns the 2-6
   most recent dates as loadable URL frames.
4. Streaming path: reuse `loadNISARGCOVFromUrl` + the RGB composite remote
   loader to pull dual-pol frames at ROI bounds.
5. URL params: `?loc=lon,lat&n=6&start=...&end=...&roi=minX,minY,maxX,maxY`.
6. Classification view is the default render; a small "show SAR underlay"
   toggle reveals the dual-pol composite. No histogram, no stretch, no
   colormap picker.

**Acceptance:** classified map rendered in the browser within <30 s of a
map click on a known NISAR coverage area; GeoTIFF export produces a valid
COG; URL round-trip (copy URL, open in private window) reproduces the run;
shares nothing but `src/` and `app/shared/` with the GCOV explorer.

### Phase 3 — CropApp, DisturbanceApp

Clone `InundationApp.jsx` twice, swap the algorithm and the data-query
shape:
- Crop: single-pol OK, prefer dual-pol; target ≥6 frames over ≥60 days.
- Disturbance: ≥3 frames; expose window-size control (default last 90 days).

Everything else is the same as Phase 2. One day each if Phase 2 is clean.

### Phase 4 — GUNWExplorer extraction

Peel GUNW-specific code out of `GCOVExplorer.jsx` into its own route.
This is cosmetic — the code already branches on `nisarProductType === 'GUNW'`.
Pull those branches into their own file, remove the GUNW branches from
`GCOVExplorer.jsx`.

### Phase 5 — COGExplorer + LocalExplorer

- `/explore/cog`: strip NISAR-specific panels, keep COG URL loading +
  contrast + colormap.
- `/local`: drop-file catch-all — boots whatever loader matches the dropped
  file type and delegates to the appropriate route component rendered
  in-place (no redirect).

## What we are explicitly NOT doing in D290

- No new algorithms. ATBDs already merged on `d288-d289-combined` are the
  scope.
- No auth/account layer. URL state only; Earthdata token remains a user-
  entered field as today.
- No server-side rendering, no server-side session. The app stays static.
- No Deno/Next.js/Remix migration. Vite + React 18 + Wouter only.
- No mobile-first redesign. Target is desktop browsers; mobile is nice-to-
  have but not gated.
- No i18n. English only.
- No bundler swap (esbuild / Rollup stays under Vite).

## Deployment implications

- **JupyterHub (`.jpl.nasa.gov`)**: hash routing works under the proxy
  without config changes. Current `base: './'` + `host: '0.0.0.0'` stay.
- **GitHub Pages / CDN**: `dist/` already builds to a self-contained static
  site. Hash routing means no 404 fallback config needed.
- **Bundle size budget**: Landing + Router shell < 100 KB gzipped;
  individual ATBD page load < 400 KB gzipped on top of shared vendor chunk
  (shared chunk is ~800 KB today, dominated by deck.gl + luma.gl + geotiff.js).
  Check in Phase 1 with `rollup-plugin-visualizer`.
- **CORS proxy**: stays in `vite.config.js` for dev only. Production
  streaming relies on ASF's own CORS headers + Earthdata Login cookies
  (verified working in D200-series streaming directives). ATBD auto-stack
  adds no new CORS surface — same fetch path as current remote NISAR load.

## Testing strategy

- **Unit tests**: existing 232 tests stay. Add tests for `urlState.js`
  (param read/write round-trip) and `atbd-auto-stack.js` (CMR result
  grouping, best-group selection, date filtering) in Phase 2.
- **Per-route smoke tests**: one Playwright test per route that asserts
  "page mounts, core action works." Phase 1 wires the test harness;
  each subsequent phase adds its route's test.
- **URL round-trip tests**: for each ATBD route, assert that serializing
  state → URL → parsing → re-rendering produces equivalent state.

## Open questions (resolve before starting Phase 1)

1. **Router: Wouter vs React Router v6 vs hand-rolled hash parsing?**
   Recommendation: **Wouter**. Hand-rolled is one more thing to maintain;
   React Router's feature set is unused. If user disagrees, happy to swap.

2. **Landing page style: chooser cards vs direct redirect to `/explore/gcov`?**
   Recommendation: **chooser cards**, because the whole point of the
   refactor is surfacing the ATBD apps as first-class peers. Redirecting
   to `/explore/gcov` re-hides them.

3. **Backward-compat for old URL params?**
   The current app supports `?cog=` and `?url=` at the root. These should
   redirect: `?cog=URL` → `#/explore/cog?url=URL`; `?url=URL` → auto-detect
   file type and redirect to the matching `/explore/*`. Low effort;
   preserves existing shared links.

4. **Should `/local` be the app's default (root) route, or should Landing be?**
   Today's behavior is "open the app → drop a file." Changing that to a
   chooser is a workflow change. Recommendation: **Landing is default for
   production builds; dev mode can be configured to boot into `/local`**
   via env var for faster iteration. User call.

5. **Do all three ATBD apps share one `<AtbdShell>` component with an
   `algorithm` prop, or are they three independent files?**
   Recommendation: **three independent files** in Phase 2-3; extract a
   shared shell only if/when we see >70% code duplication. Premature
   abstraction is the enemy here.

6. **Does `/inundation` need a "disable auto-stack, browse granules
   manually" escape hatch?**
   Yes, eventually — but not in Phase 2. Ship the auto flow first, add
   manual override in a later pass if users ask for it.

## Estimated effort

| Phase | Work | Calendar |
|:------|:-----|:---------|
| 1 | Router + Landing + GCOV extract | 1 day |
| 2 | InundationApp + auto-stack | 2-3 days |
| 3 | Crop + Disturbance | 1 day each |
| 4 | GUNW extract | 1 day |
| 5 | COG + Local | 1 day |
| **Total** | | **~7-8 days** |

Most risk is in Phase 2's auto-stack + ASF streaming under concurrent
requests. Phase 1 is a pure refactor with high test coverage.

## Commit / branch convention

One branch per phase, each a PR on top of the previous:
- `d290-01-router-shell`
- `d290-02-inundation-app`
- `d290-03-crop-disturbance-apps`
- `d290-04-gunw-extract`
- `d290-05-cog-local`

Base `d290-01-router-shell` off `d288-d289-combined` so the ATBD algorithms
and the UI panel are both present and can be migrated into the new route
structure.
