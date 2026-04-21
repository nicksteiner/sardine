# D295: Phase 5 — COGExplorer + LocalExplorer

**Parent directive:** [D290](D290_APP_SEPARATION.md)
**Depends on:** D291 merged. (Independent of D292/D293/D294.)
**Blocks:** nothing — final phase.

## Scope

Ship `/explore/cog` as a COG-only viewer (strip NISAR panels) and
`/local` as the drop-file catch-all entry point. After D295, every
route in the D290 target URL surface is live.

## Work

1. **COGExplorer (`app/pages/COGExplorer.jsx`)**:
   - Minimal UI: COG URL input, contrast sliders, colormap picker,
     stretch mode, MapLibre basemap toggle, GeoTIFF export.
   - No NISAR-specific panels (no frequency, no polarization, no
     product-type detection, no HDF5 metadata tree).
   - Reuses `src/loaders/cog-loader.js` + `app/shared/SARCanvas.jsx`.
   - URL: `/explore/cog?url=URL`.
   - Backward-compat: the root `?cog=URL` redirect set up in D291
     now points to a live page.

2. **LocalExplorer (`app/pages/LocalExplorer.jsx`)**:
   - File-drop zone on mount; no URL required.
   - On drop, inspects the file (extension + magic bytes) and
     delegates to the appropriate page component *in-place* — does
     **not** redirect. The URL stays `/local` but the rendered body
     becomes `<GCOVExplorer localFile={file} />` etc.
   - Supported file types: NISAR GCOV `.h5`, NISAR GUNW `.h5`,
     generic COG `.tif` / `.tiff`.
   - Each delegate page component must already accept a `localFile`
     prop (add in this directive if missing — one-line hook).

3. **Root `/` default.**
   - Production builds: `/` → Landing.
   - Dev builds: optional env var `VITE_DEFAULT_ROUTE` (e.g.
     `/local`) boots directly into the specified page for faster
     iteration. Documented in `CONTRIBUTING.md`.

4. **Landing page updates.** `/explore/cog` and `/local` cards go
   live. Landing is now in its final form.

5. **`src/components/` cleanup.** If D291 / D294 / D295 have moved
   every NISAR/SAR-specific component out of `src/components/` into
   `app/shared/`, delete `src/components/` and remove re-exports from
   `src/index.js`. Run the shared-usage checker to confirm no route
   has lost a component mid-move.

6. **Playwright smoke tests**:
   - `test/e2e/cog-explorer.spec.js` — `/explore/cog?url=<fixture>`
     → page mounts, tile renders.
   - `test/e2e/local-explorer.spec.js` — `/local` → simulate file
     drop with a fixture COG → assert inline COGExplorer renders.

7. **Docs pass.** Update `CLAUDE.md` and `docs/API.md` with the new
   route structure. Add a routing section to `README.md` if present.

## Out of scope

- New COG features (e.g. multi-band COG picker). Preserve current
  behavior.
- Server-mode integration. `/local` is browser-only; server-mode
  entry point (if ever built) is a separate directive.
- Drag-drop multi-file time-series into `/local` (interesting but
  separate directive — would overlap with ATBD app auto-stack).

## Acceptance criteria

- [ ] `/explore/cog?url=<COG_URL>` renders the same COG viewer that
      the current app shows for a COG-mode load, minus NISAR panels.
- [ ] `/local` accepts a dropped `.h5` or `.tif` and renders the
      matching explorer in-place without navigating away.
- [ ] Root `?cog=` redirect (from D291) lands on a functional
      `/explore/cog` page.
- [ ] Landing page lists every route as live (no "coming soon"
      placeholders).
- [ ] `src/components/` is removed (or confirmed empty / not
      imported by any page).
- [ ] All Playwright smoke tests (landing, gcov, gunw, cog, local,
      inundation, crop, disturbance) pass.
- [ ] D290 rules all pass: ESLint, `lint:shared`, no forks.
- [ ] `CLAUDE.md` + `docs/API.md` reflect the new routing.

## Branch / PR

- Branch: `d295-cog-local-apps` off `main` (after D291; D292/D293/D294
  ordering irrelevant).
- PR title: `D295: /explore/cog + /local final-phase extraction`.

## Risks

- **LocalExplorer's in-place delegation.** Rendering a page component
  as a child of another page is unusual; if delegate pages implicitly
  depend on Wouter route-param hooks, the delegation will break them.
  Mitigation: every page component must accept its primary inputs as
  props (not only from URL params). Router reads URL → passes props.
  LocalExplorer passes props directly. This also makes pages unit-
  testable in isolation, which is desirable.
- **`src/components/` removal.** Some external consumers (other
  repos, the launch server, the MCP stub) might import from
  `sardine` → `src/components/*`. Check `src/index.js` re-exports
  before deletion; keep re-exports with deprecation comments if
  needed for one release cycle.
