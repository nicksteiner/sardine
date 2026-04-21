# D291: Phase 1 — Router shell + Landing + GCOVExplorer extraction

**Parent directive:** [D290](D290_APP_SEPARATION.md)
**Depends on:** main at or after the D290 design-doc commit.
**Blocks:** D292, D293, D294, D295.

## Scope

Turn the single SARdine page into a hash-routed SPA with a chooser at `/`
and the existing explorer at `/explore/gcov`. No feature changes, no new
algorithms. A user dropping a NISAR file on `/#/explore/gcov` sees the
same behavior as today.

## Work

1. **Add Wouter.** `npm i wouter` (~1 KB gzip). No React Router, no
   hand-rolled parsing.
2. **Rewrite `app/main.jsx` as a ~100-line shell:**
   - `<HashRouter>` + `<Switch>` over all planned routes. Unbuilt pages
     render a "coming soon" placeholder that links back to `/`.
   - Mount global theme + status-window host.
   - Inject build SHA via Vite `define` (`__BUILD_SHA__`) and render it
     plus `package.json.version` in a consistent corner on every page
     (satisfies D290 R8).
3. **Create `app/pages/GCOVExplorer.jsx`.** Move the entire current
   `app/main.jsx` body into it — component export, all hooks, all JSX.
   Rebasing imports: `../src/*` → `../../src/*`; components referenced
   from `../src/components/*` that are used by future pages get copied
   to `app/shared/` (StatusWindow, Histogram, ClassificationOverlay,
   CoordinateGrid, ScaleBar, LoadingIndicator) — `app/shared/` is a
   drop-in replacement path for now, `src/components/` can be removed
   in D295 once every importer is moved.
4. **Create `app/pages/Landing.jsx`:**
   - Header: SARdine wordmark + version/SHA.
   - Grid of cards, one per planned route. `/explore/gcov` is live;
     others render as "coming soon — D29X" with a link back to the
     design doc.
   - Minimal CSS; uses theme variables only, no overrides
     (satisfies D290 R7).
5. **Wire backward-compat query-param redirects** at the router root:
   - `?cog=URL` → `navigate('/#/explore/cog?url=URL')` (scaffolded;
     /explore/cog page lands in D295 but the redirect is in place now
     so existing shared links don't 404).
   - `?url=URL` → detect by extension (`.h5` → `/explore/gcov`, `.tif`
     → `/explore/cog`) and redirect.
6. **ESLint rule (D290 R1).** Add to `.eslintrc.json`:
   ```json
   {
     "overrides": [{
       "files": ["src/**/*.{js,jsx}"],
       "rules": {
         "no-restricted-imports": ["error", {
           "patterns": [{
             "group": ["../app/*", "app/*", "@app/*"],
             "message": "src/ cannot import from app/."
           }]
         }]
       }
     }]
   }
   ```
7. **Shared-usage checker (D290 R2, R3).** New script
   `scripts/check-shared-usage.mjs`:
   - Fails if any `app/shared/*.jsx` has <2 callers in `app/pages/`.
   - Fails if any filename matches `*For*.jsx` or `*.<pagename>.jsx`.
   - Wired into `npm run lint:shared`, called from `npm test`.
8. **Playwright harness (D290 R5).** Add `@playwright/test` dev dep,
   minimal `playwright.config.js`, a `test/e2e/` dir, and two smoke
   tests:
   - `test/e2e/landing.spec.js` — `/` mounts, shows cards for every
     planned route.
   - `test/e2e/gcov-explorer.spec.js` — `/explore/gcov` mounts, drops
     a fixture `.h5`, renders a tile, opens an ROI. (Use the small
     test fixture already in `test/fixtures/` — check availability.)
   - Wired into `npm run test:e2e`. Not in the default `npm test` yet
     (Playwright is slow); runs as a separate CI job.
9. **CONTRIBUTING.md code-review checklist** from D290.

## Out of scope for D291

- Any ATBD page (deferred to D292/D293).
- GUNW/COG/Local pages (deferred to D294/D295).
- The auto-stack ASF streaming flow (D292).
- Bundle analyzer / code-splitting. Code-splitting per route ships
  when the second page lands (D292); for D291 everything stays in one
  chunk, which is still smaller than today because Landing is tiny.

## Acceptance criteria

- [ ] `npm test` → 232 passing + shared-usage check passes.
- [ ] `npm run test:e2e` → 2 passing smoke tests.
- [ ] Browser: `/` shows the chooser; clicking "GCOV Explorer" navigates
      to `/#/explore/gcov` and the page looks identical to pre-refactor.
- [ ] Dropping a NISAR `.h5` file at `/#/explore/gcov` + drawing an ROI
      + running Inundation ATBD still works (the D288 panel is intact
      inside GCOVExplorer.jsx).
- [ ] URL `?cog=https://example.com/file.tif` at root redirects to
      `/#/explore/cog?url=...` (placeholder page, but redirect works).
- [ ] `?url=.../file.h5` at root redirects to
      `/#/explore/gcov?url=...` and auto-loads.
- [ ] Build SHA + version visible on both `/` and `/explore/gcov`.
- [ ] No `src/` file imports from `app/` (ESLint green).
- [ ] `dist/` builds cleanly; served from a static dir, both routes
      work (tested via `python3 -m http.server -d dist`).

## Branch / PR

- Branch: `d291-router-shell` off `main`.
- PR title: `D291: hash-routed SPA shell + Landing + GCOVExplorer`.
- Squash-merge discouraged — keep the extraction commit atomic so
  `git log --follow` on `GCOVExplorer.jsx` reaches the original
  `main.jsx` history.

## Risks

- **Import path churn.** Hundreds of relative imports in `main.jsx`
  need rebasing. Mitigation: use the existing `@src` Vite alias
  (already configured, `vite.config.js:~160`) for all `src/` imports
  from pages — `@src/loaders/...`, `@src/utils/...`. One search-and-
  replace across the extraction.
- **`base: './'` + hash routing.** Confirm JupyterHub proxy still
  resolves asset paths; the combination has worked for `?cog=` query
  params but hasn't been tested with hash-routed assets. Manual
  verification on a JupyterHub preview before declaring Phase 1 done.
- **`src/components/` → `app/shared/` move.** Some tests might import
  components directly from `src/components/`. Grep `test/` before
  moving; update imports in the same commit.
