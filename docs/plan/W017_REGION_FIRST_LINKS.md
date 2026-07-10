# W017 — Region-first deep links: ?bbox= without a granule resolves via CMR

wave: 1 (release wrinkle 2, pre-W015)
status: launched
blocked_by: [W016]
branch: w017-region-first-links

## Objective

A deep link with `bbox=` (or `wkt=`) and NO data URL resolves its own granule:
client-side CMR spatial search over the NISAR GCOV collections → rank → auto-load the
best match chunk-scoped to the region (W016), or present a ranked picker when
ambiguous. The ROI becomes the primary key; granule IDs become an implementation
detail (they change across BETA→PROVISIONAL→VALIDATED reprocessing; coordinates
don't). Optional `t=<start>/<end>` ISO date-range param filters acquisitions.

## Existing machinery (do not reinvent)

- `src/loaders/cmr-client.js` — inspect what it already does before writing anything.
- CMR granule search (CORS-open, no auth needed for search):
  `https://cmr.earthdata.nasa.gov/search/granules.json?short_name=NISAR_L2_GCOV_BETA_V1&bounding_box=w,s,e,n&page_size=N&sort_key=-start_date`
  — entries carry `polygons` (footprints), `links` (.h5 URL), `producer_granule_id`.
  See docs/DEMO.md "Finding fresh granules" for the verified query shape.
- W016: deep-link staging, `deepLinkRoiRef`, auto-load ref, chunk scoping.
- W008: post-load pins; the existing `?nisar=` staging path (reuse it — resolution
  should end by feeding the chosen URL into the exact same staging as an explicit
  link).

## Scope

1. **deep-link.js**: `bbox`/`wkt` with no data param is now valid (currently the
   mount effect exits when `dataUrl` is null — that's the behavior change);
   add optional `t=` (ISO `start/end`, both optional halves) and `col=` (collection
   short_name override, default try order: VALIDATED → PROVISIONAL → BETA, first
   collection with hits wins).
2. **New `src/utils/granule-resolve.js`** (pure, unit-testable):
   `resolveGranulesForBbox(bbox4326, { dateRange, collections, fetchFn }) ->
   [{url, name, granuleId, footprint, coveragePct, fullFrame, polMode, startTime}]`
   ranked by: region-coverage % (point-in-polygon/overlap of bbox vs footprint) →
   full-frame (`_N_F_` in granule name) → dual-pol lean files (`DHDH`) → newest.
   Coverage math: polygon-bbox intersection area / bbox area (a small pure helper;
   footprints are single rings from CMR `polygons`).
3. **main.jsx mount effect**: when spatial params exist without a data URL, call the
   resolver, log candidates to the status window, take the top result when its
   coverage ≥ ~90%, and feed it through the existing nisar staging (EDL token attach
   included) + W016 auto-load. When top coverage < 90% or several near-ties, surface
   the ranked list (reuse/populate the existing discovery/scene list UI if trivial;
   otherwise a simple status-log listing + auto-pick with a note is acceptable for
   this pass — record the choice in Findings).
4. **Copy Link**: unchanged (still emits the loaded granule +bbox — explicit beats
   resolved for reproducibility). Add a small "region link" variant ONLY if trivial.
5. **docs/DEEP_LINKS.md**: document region-first links + `t=`/`col=`.

## Out of scope

- Multi-granule mosaicking of the ROI (phase 2 — note it).
- Sentinel-1/other collections. Server-side resolution. Auth for search (not needed).

## Acceptance criteria

- `npm test` full chain + `npm run build` green.
- Unit tests for `granule-resolve.js` with canned CMR JSON fixtures: ranking order
  (coverage beats recency; full-frame beats partial), date filtering, collection
  fallback order, zero-hit → clear error message.
- Coverage math unit-tested against a hand-computed bbox/footprint pair (use the
  real Chesapeake granule footprint from docs/DEMO.md context: lat/lon ring
  37.83/-74.91, 39.93/-75.73, 39.20/-78.60, 37.12/-77.71).
- PR documents (checklist item, no browser automation — a concurrent puppeteer
  process may be running): `?bbox=-77.48,38.90,-77.26,39.01` alone resolves to the
  Chesapeake granule via live CMR (curl or Node fetch evidence acceptable).
