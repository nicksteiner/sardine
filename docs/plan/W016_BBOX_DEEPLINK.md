# W016 — Spatial subset in deep links: ?bbox= / ?wkt= loads only intersecting chunks

wave: 1 (release wrinkle, pre-W015)
status: branch-ready
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

## Findings

Premise audit (before implementation, at base a25ebf2):

- **`handleWktApply` does NOT touch the view** — it only maps WKT → pixel ROI via
  `wktToROI` and calls `setROI` (the work order said it "already turns WKT → pixel
  ROI + view"). The region view-fit therefore lives in the new `applyDeepLinkRoi`
  (main.jsx), which reuses the same `reprojectBbox → roiIntersectsFile →
  bboxToPixelRange → setROI + setWktInput` pathway plus the zoom conventions of the
  existing fit sites (projected: `log2(1000/span)`; geographic: `log2(360/span)−1`).
- **Remote NISAR raster load is user-initiated** (W008 known limit: multi-GB
  auto-load was deliberately removed). A `?url=<h5>&bbox=` link streams metadata and
  stages the region; the ROI/view/scoped-prefetch all fire on the first "Load
  Dataset" click. COG deep links auto-load, so the region applies immediately there.
- **`scopeBbox` cannot be "file-CRS bounds" as the work order suggested** — the
  caller doesn't know the file CRS until `loadNISARGCOVFromUrl` has read the
  projection dataset. The option takes WGS84 `[w,s,e,n]` and the loader reprojects
  internally once bounds/CRS are known (pure helper `scopeBboxToChunkRange` in
  roi-subset.js, unit-tested).
- `prefetchOverviewChunks` at HEAD is the byte-budgeted overview-ladder entry-level
  sampler (not a plain 8×8 grid); the scope clamps the ladder's chunk-grid range, so
  budget/entry-level logic keeps working inside the region.

Implementation notes:

- Phase-2 refinement: tiles whose chunk range is fully outside the scope skip
  background refinement; Phase-1 coarse render and zoomed-in `readRegion` reads are
  untouched, so panning out of the region loads lazily (verified headlessly).
- The post-load background histogram now samples the region bounds (not the full
  scene) when a deep-link region is active — auto-contrast matches the AOI and the
  sampling doesn't pull out-of-region chunks.
- Copy Link emits `bbox=` for both 4326 and projected scenes: ROI pixel range →
  `computeSubsetBounds` → `projectedToWGS84` (proj4 inverse already existed in
  overture-loader.js), 5-dp precision.
- `wkt=` keeps the original string in the ROI/WKT input; degenerate geometries
  (zero-area, e.g. POINT) are rejected like malformed bboxes — warn, never throw.

Acceptance evidence (2026-07-10):

- `npm test` full chain green (structural + pipeline + 8/8 unit files, deep-link
  30 passed, wkt+roi-subset 28 passed); `npm run build` clean.
- Headless loader check (Node, synthetic 2048×2048 GCOV EPSG:32610, 64 chunks of
  256×256, served over local HTTP Range): unscoped prefetch pulled all 64 overview
  chunks (14.15 MB); with `bbox=` covering a 512×512 px AOI the loader logged
  "Scope bbox → chunk range rows 2–4, cols 4–5 (6 of 64 chunks)" and prefetched
  exactly those 6 (3.98 MB); `scopeChunkRange` matched the pure-math helper;
  out-of-region `getTile` still returned data. 7/7 checks.
- Browser check (puppeteer + vite dev :5199, same fixture): deep link
  `/?url=…&bbox=-122.86994,45.06113,-122.80475,45.10731` → after "Load Dataset",
  console shows the scoped prefetch (6 of 64), first tile bbox sits inside the AOI
  (view fitted), WKT input reads `BBOX(-122.86994, 45.06113, -122.80475, 45.10731)`,
  ROI profile computed, status shows "Deep-link region applied". 7/7 checks.
  (Run completed before a concurrent browser-automation process was flagged on this
  machine; not re-run afterward. A live-DAAC spot check remains a PR checklist item.)

Known limits (in scope boundaries):

- Fetch scoping applies to the single-band `loadNISARGCOVFromUrl` path only; RGB
  composite / index deep links still get the ROI + view fit but prefetch full-scene
  (work order scoped item 3 to `loadNISARGCOVFromUrl`).
- NITF deep links ignore spatial params (no georeferenced ROI pathway there).
