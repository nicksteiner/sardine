# D294: Phase 4 — GUNWExplorer extraction

**Parent directive:** [D290](D290_APP_SEPARATION.md)
**Depends on:** D291 merged. (Independent of D292/D293; can be done in
parallel if a second developer is available.)
**Blocks:** D295 (Local explorer uses the GUNW/GCOV/COG page components
as auto-detect targets).

## Scope

Peel the NISAR GUNW codepaths out of `GCOVExplorer.jsx` into their own
route at `/explore/gunw`. GUNW handling in `main.jsx` today already
branches on `nisarProductType === 'GUNW'` in most places — this is
mostly a code-org refactor, not a logic change.

## Work

1. **Create `app/pages/GUNWExplorer.jsx`.** Copy only the GUNW-relevant
   state, handlers, and JSX from `GCOVExplorer.jsx`. Strip GCOV-only
   UI: polarization picker (GUNW doesn't have pols in the same sense),
   RGB composite picker, dual-pol-specific controls.
2. **Keep in GUNWExplorer**: layer / dataset picker (unwrap phase,
   coherence, connected components), InSAR-specific export options,
   reference/secondary date metadata display.
3. **Move GUNW branches out of GCOVExplorer.** After extraction,
   `GCOVExplorer.jsx` should have no `if (nisarProductType === 'GUNW')`
   branches left. Any shared subcomponents (ROI tool, status window,
   coordinate overlays) are already in `app/shared/`.
4. **Landing page update.** `/explore/gunw` card becomes live.
5. **URL redirect.** `?url=<GUNW_URL>` on the root should route to
   `/explore/gunw` — extend the D291 URL-sniff redirect. NISAR GUNW
   filenames are distinguishable from GCOV by substring (`GUNW` vs
   `GCOV`); use that as the sniff heuristic.
6. **Playwright smoke test.** `test/e2e/gunw-explorer.spec.js` —
   mount page, load a fixture GUNW `.h5`, select a layer (e.g.
   unwrapped phase), assert render. Skip if fixture isn't present.

## Out of scope

- New GUNW features. Copy existing behavior as-is.
- Refactoring NISAR loader branching. `src/loaders/nisar-loader.js`
  stays unified (it's a single cohesive loader that handles both
  products); only the UI shell splits.

## Acceptance criteria

- [ ] `/explore/gunw` renders the same UI GCOVExplorer used to show
      when a GUNW file was loaded, minus GCOV-only controls.
- [ ] `GCOVExplorer.jsx` has no GUNW-specific branches after the
      extraction.
- [ ] GUNW-URL redirect from `?url=` works.
- [ ] Playwright smoke test passes.
- [ ] D290 rules pass.

## Branch / PR

- Branch: `d294-gunw-extract` off `main` (after D291).
- PR title: `D294: /explore/gunw extraction from GCOVExplorer`.

## Risks

- **GUNW fixture availability in CI.** GUNW test data is larger than
  GCOV; CI may not have one. Mitigation: mark the e2e test as
  `test.skip` if fixture missing, same pattern as D289 regression
  test. Manual verification on a developer workstation is sufficient.
- **GCOV/GUNW conditional state that isn't cleanly separable.** Some
  state fields are shared (e.g. frequency selector) — leave those
  in `GCOVExplorer.jsx` for GCOV use and re-introduce equivalents in
  `GUNWExplorer.jsx` where actually needed, rather than trying to
  share state across pages (which would violate D290's no-global-store
  principle).
