# W008 — Granule deep links (the distribution primitive)

wave: 1
status: launched
blocked_by: []
branch: w008-granule-deeplinks

## Objective

"Paste a granule URL, see it in seconds" — make `?url=<remote .h5/.tif>` (plus optional
render params) auto-load on app start, and make "Copy Link" reproduce the current view.
This is the mechanism by which every forum post, paper, and agent report becomes a
SARdine entry point.

## Scope

- Audit the existing share-link code in `app/main.jsx` (`parseShareLink`/
  `buildShareLink`, ~lines 682–748 at HEAD; RE-LOCATE by grep) — it already carries
  view bounds + dB mode. Extend to:
  - `?url=` → remote source auto-load: `.h5` → the existing remote-NISAR load path,
    `.tif` → COG path, NITF extensions → NITF path (grep the existing URL-load
    handlers; do not write new loaders).
  - Render params: colormap, contrastMin/Max, useDecibels, stretchMode, gamma,
    compositeId, frequency, polarization — all optional, applied after load.
  - Guard: param application must wait for load completion (hook into the existing
    post-load state setters, not timers).
- "Copy Link" button (or extend the existing share action) serializes current source
  URL + render state. Local File sources: button disabled with tooltip (no URL exists).
- Document the param schema in `docs/DEEP_LINKS.md` (short — table of params).

## Out of scope

- No URL shortening, no server changes, no state beyond render+view (session state is
  W010). No presigned-URL generation (links carry whatever URL the user loaded).

## Acceptance criteria

- `npm test` + `npm run build` pass.
- Unit test for the param serializer/parser round-trip (pure functions extracted to
  `src/utils/deep-link.js` so they're testable outside React).
- PR documents manual check: `npm run dev` then open
  `http://localhost:5173/?url=<COG url>&colormap=viridis&contrastMin=-20&contrastMax=0`
  → renders with those settings.
