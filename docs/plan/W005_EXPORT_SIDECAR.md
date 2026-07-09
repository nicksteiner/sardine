# W005 — Export provenance sidecar (metadata survives the exit)

wave: 1
status: merged — was branch-ready (commit 3cb02d2)
blocked_by: []
branch: w005-export-sidecar

## Findings (from implementation, 2026-07-08)

- Implemented as `src/utils/export-sidecar.js` + 58-line main.jsx diff covering
  `handleExportGeoTIFF` (raw + rendered + RGB composite) and `handleExportTSFrame`.
  Identification passed through verbatim (key-set-equality tested); BigInt/typed-array/
  NaN-safe serialization.
- Vite 4 can't import package.json with Node-24-style import attributes — version is a
  `SARDINE_VERSION` constant with a drift-detecting unit test.
- Time-series frames had no `identification`/`fileName` at HEAD (state comment claims
  they should — likely upstream WIP); added to `frames.push()`, expect a two-line
  additive rebase hunk.
- `test/unit/export-sidecar.test.mjs` (10 checks) runs standalone; not wired into the
  custom runner because `test/run-tests.js` carries uncommitted WIP — register it when
  that lands.

## Objective

SARdine reads 40+ NISAR identification fields but writes none of them on export —
GeoTIFFs leave with only georeferencing tags. Write a JSON provenance sidecar next to
every GeoTIFF export so products carry identification, render state, and lineage.

## Naming — collision warning

`{file}.sardine.json` is TAKEN (sardine-agent NITF scene-geometry sidecar; schema at
`~/sandbox/sardine-agent/sardine.json`). Export sidecars are `{output}.tif.json`
(e.g. `export_HHHH_ml4.tif` → `export_HHHH_ml4.tif.json`).

## Schema

New module `src/utils/export-sidecar.js` exporting
`buildExportSidecar({ scene, renderState, exportParams }) -> object` and
`EXPORT_SIDECAR_VERSION = 1`:

```json
{
  "sardine:export": 1,
  "created": "<ISO 8601 UTC>",
  "software": "SARdine <version from package.json>",
  "derived_from": { "file": "<source filename or URL>", "productType": "GCOV|GUNW|COG|NITF" },
  "identification": { "...all fields the loader read (opaque pass-through of imageData.identification / meta)..." },
  "georeference": { "crs": "EPSG:XXXX", "bounds": [w,s,e,n], "width": 0, "height": 0, "multilook": 1 },
  "render": { "mode": "raw|rendered", "useDecibels": true, "contrastLimits": [0,0], "colormap": "", "stretchMode": "", "gamma": 1, "compositeId": null }
}
```

Rule: pass identification through opaquely — do NOT hand-pick fields (that's how
metadata gets dropped). `render` is null for raw exports beyond mode/multilook.

## Integration (minimal main.jsx touch — it has uncommitted upstream changes)

- In the GeoTIFF export handlers in `app/main.jsx` (grep `downloadBuffer` call sites
  for raw + rendered GeoTIFF paths), after triggering the .tif download, build the
  sidecar and trigger a second download of `{name}.tif.json`. Extract whatever render
  state the handler already has in scope; do not restructure the handlers.
- Figure PNG export: SKIP (PNG already embeds state via png-state.js).

## Out of scope

- No GeoTIFF tag embedding (GEO_ASCII_PARAMS) — sidecar only. No STAC Item emission
  (W011). No changes to geotiff-writer.js output bytes.

## Acceptance criteria

- `npm test` + `npm run build` pass.
- New `test/unit/export-sidecar.test.mjs`: given a synthetic scene with an
  identification object of 10+ fields, the sidecar contains ALL of them verbatim,
  valid JSON, correct bounds/CRS; version + derived_from present.
- Grep shows both GeoTIFF export paths (raw + rendered) call `buildExportSidecar`.
