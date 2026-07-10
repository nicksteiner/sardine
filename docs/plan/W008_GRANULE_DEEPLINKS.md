# W008 — Granule deep links (the distribution primitive)

wave: 1
status: branch-ready
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

## Findings

Premise audit (before implementation): the share-link machinery was further along than
the work order assumed. At HEAD 78b7b61:

- `src/utils/share-link.js` already existed as PURE functions (`parseShareLink`,
  `buildShareLink`, `clearShareLinkParams`) — the extraction the acceptance criteria
  ask for was effectively done, just under a different filename and with no unit tests.
- Auto-load on startup already worked for explicit `?cog=`/`?nisar=`/`?nitf=`(/`?sicd=`)
  params (main.jsx mount effect), including EDL-token gating for DAAC NISAR URLs and a
  URLFile bridge for NITF. Short render params (`cmap`, `min`, `max`, `db`, `stretch`,
  `gamma`, `pol`, `freq`, `ml`, `comp`, `mode`, `c`, `z`) were parsed and applied.
- A "Copy share link" button already existed, but was hidden entirely for local files
  (work order asks for disabled-with-tooltip), and there was NO generic `?url=` param,
  no long-form param names, and no docs.
- Gap confirmed in the "guard" requirement: render params were applied synchronously
  BEFORE load, and the loaders' post-load auto-derivation clobbered them —
  `handleLoadCOG` overwrote contrastMin/Max + view center/zoom, `handleRemoteFileSelect`
  overwrote pol/freq + contrast from metadata stats, `handleLoadRemoteNISAR` overwrote
  contrast twice more (HDF5 stats + background histogram). `clearShareLinkParams` was
  imported but never called (comment at the mount effect referenced a strip-after-load
  effect that does not exist) — left as-is: keeping params in the URL means a reload
  re-triggers the deep link, which is the desired behavior for a distribution primitive.

What W008 added: `src/utils/deep-link.js` (canonical module; `share-link.js` kept as a
re-export shim), `?url=` with extension routing + long-form aliases, a one-shot
"deep-link pin" guard consumed by the existing post-load setters (no timers), the
disabled-with-tooltip Copy button for local files, 21 unit tests, `docs/DEEP_LINKS.md`.

Known limit: for remote NISAR the raster load is user-initiated (auto-load of multi-GB
granules was deliberately removed), so the deep link pre-selects pol/freq/render state
and the contrast pin survives until the first Load click completes; subsequent loads
re-enable auto-contrast by design.

Discovery: `?url` is a RESERVED Vite import query (`import x from './x?url'`) — the
dev server 403s any page navigation carrying `?url=` ("outside of Vite serving allow
list"), verified with curl. Fixed with `deepLinkDevFixPlugin` in vite.config.js, which
strips the query from HTML navigation requests server-side (the browser keeps the full
URL, so the app still parses location.search). Production static hosting is unaffected.

Manual acceptance check performed headlessly (puppeteer + swiftshader, dev server on
:5199, 256×256 Float32 GeoTIFF served with Range support on :8899):
`/?url=<COG url>&colormap=viridis&contrastMin=-20&contrastMax=0` → COG loads, colormap
select = viridis, contrast UI shows -20.0/0.0 dB, status log shows "Keeping deep-link
contrast (auto-contrast skipped)", and the sampled auto-contrast values (-33..1.3) do
NOT appear — 7/7 checks passed.
