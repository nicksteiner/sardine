# W016 — Spatial subset in deep links: ?bbox= / ?wkt= loads only intersecting chunks

wave: 1 (release wrinkle, pre-W015)
status: launched
blocked_by: []
branch: w016-bbox-deeplink

## Objective

`?url=<granule>&bbox=w,s,e,n` (lon/lat WGS84; also accept `wkt=` for polygons) loads
the scene AND (a) fits the initial view to the region, (b) applies it as the ROI, and
(c) restricts data fetching to chunks intersecting the region — so a deep link to a
240×240 km granule with a small AOI streams only that AOI's chunks. This is the "send
a colleague exactly this flood, not the whole granule" primitive, and what an agent
report will embed per finding.

## Existing machinery (do not reinvent)

- `src/utils/deep-link.js` (W008) — param parse/serialize + post-load pin pattern.
- `src/utils/wkt.js` — `parseWKT`, `wktToBbox`, `bboxToWKT`, `validateWKT`.
- `src/utils/roi-subset.js` — `bboxToPixelRange(bbox, fileMetadata)` (handles
  coordinate arrays + clamping), `reprojectBbox(bbox4326, fileCrs)`,
  `roiIntersectsFile`.
- `nisar-loader.js` — `wktToROI` export; `prefetchOverviewChunks` (the whole-image
  8×8 sampler that must become region-scoped when a bbox is given); main.jsx
  `handleWktApply` (~grep wktInput) already turns WKT → pixel ROI + view.

## Scope

1. **deep-link.js**: add `bbox` (4 comma floats, WGS84 lon/lat, `w,s,e,n`) and `wkt`
   (URL-encoded WKT string; POLYGON/BBOX accepted) to parse + serialize. Validation:
   reject malformed with a warning, never throw. `wkt` wins over `bbox` when both
   present; internally `wkt` reduces to its bbox for fetch-scoping (polygon fidelity
   is only for the ROI display/WKT input). Copy Link: when a ROI is active, emit
   `bbox=` (from the ROI's geographic bounds, reprojected to 4326 if the file CRS is
   projected — proj4 is available via reprojectBbox's inverse; if inverse reprojection
   is awkward, emit only for 4326 scenes and note it).
2. **View + ROI application (main.jsx)**: after load completes, reproject the 4326
   bbox to the file CRS, compute the pixel ROI via `bboxToPixelRange`, set the ROI
   state + WKT input (reuse the existing handleWktApply pathway rather than
   duplicating it), and fit the initial viewState to the region bounds instead of the
   full scene. Follow W008's one-shot pin pattern so post-load auto-fit doesn't
   clobber it. Warn + fall back to full-scene load if the bbox doesn't intersect the
   file (`roiIntersectsFile`).
3. **Fetch scoping (nisar-loader.js)**: add an option to `loadNISARGCOVFromUrl`
   (e.g. `{ scopeBbox }`, file-CRS bounds) that (a) restricts
   `prefetchOverviewChunks` to the chunk-grid range intersecting the bbox's pixel
   range, and (b) skips Phase-2 refinement outside it. Tile requests are already
   viewport-driven, so with the view fitted to the bbox nothing else fetches
   out-of-region — do NOT hard-block out-of-region getTile calls (the user may pan
   out; that must still work, lazily).
4. **COG path**: no loader change needed (viewport-driven overviews); just apply the
   view-fit + ROI. Verify it works.
5. **docs/DEEP_LINKS.md**: add the params with an example.

## Out of scope

- No polygon-accurate chunk masking (bbox of the polygon is the fetch unit).
- No multi-region support. No changes to local-file loading.

## Acceptance criteria

- `npm test` (full chain) + `npm run build` green.
- Unit tests (extend `test/unit/deep-link.test.mjs`): bbox/wkt parse+serialize
  round-trip, malformed rejection, wkt→bbox reduction, ROI→bbox emission.
- Unit test for the prefetch scoping math: given synthetic metadata (bounds, chunk
  grid), `scopeBbox` yields exactly the expected chunk-coordinate subset.
- PR documents a manual/headless check: `?url=<remote scene>&bbox=...` fetches a
  chunk count consistent with the AOI (log or network evidence), view opens on the
  AOI, ROI panel shows stats for it.
