# W004 — Annotation/ROI/transect GeoJSON serialization (interpretation as data, step 1)

wave: 1
status: merged — was branch-ready (commit 0088163)
blocked_by: []
branch: w004-annotation-geojson-io

## Findings (from implementation, 2026-07-08)

- Schema implemented exactly; coordinates stay in scene world CRS with `sardine:crs`
  recorded collection-level and a non-4326 import warning. Forward compat via
  `__geojsonProps`/`__styleExtra` pass-through — preserved values (e.g.
  `observer:"agent"`, original `created`) survive re-export, which is exactly what the
  W011 adjudication loop needs.
- `transectLine` state doesn't exist in main.jsx at HEAD (it's uncommitted upstream
  work) — module supports transects fully (tested); the main.jsx wire-up point is
  commented for the rebase.
- Drop handler routes markup `.geojson` (detected via `sardine:kind`/`sardine:schema`)
  to import; plain overlay GeoJSON behavior unchanged.
- 25 unit checks in `test/unit/annotation-io.test.mjs`, chained via package.json
  (`test/run-tests.js` left untouched — carries upstream WIP).

## Objective

Make analysis markup durable and interoperable: serialize annotations, ROI, transect,
and classifier regions as a GeoJSON FeatureCollection with a defined properties schema;
import them back. This forces the schema decision the whole interpretation roadmap
(PLATFORM_REVIEW.md Phase 2–3) builds on.

## Schema (the load-bearing part — implement exactly)

New module `src/utils/annotation-io.js` exporting:

- `annotationsToGeoJSON({ annotations, roi, transectLine, classRegions, scene, renderState }) -> FeatureCollection`
- `geoJSONToAnnotations(featureCollection, scene) -> { annotations, roi, transectLine, classRegions, warnings }`
- `SARDINE_MARKUP_SCHEMA_VERSION = 1`

Feature properties (aligned with the sardine-agent findings schema so the two converge
later — see docs/plan/README.md "sardine-agent API ground truth"):

```json
{
  "sardine:kind": "annotation-arrow | annotation-text | roi | transect | class-region",
  "sardine:schema": 1,
  "label": "<text or class name>",
  "observer": "human",
  "method": "manual",
  "created": "<ISO 8601 UTC>",
  "confidence": null,
  "sourceScene": { "file": "<filename>", "crs": "EPSG:XXXX", "bounds": [w,s,e,n] },
  "style": { "color": "cyan", "size": "medium" },
  "measurements": { }
}
```

Geometry: Points (text), LineStrings (arrow: tail→head; transect), Polygons (ROI rect,
class regions carried as feature with null geometry + `featureSpace` bounds in
properties since they live in dB feature space, not geography). Coordinates in the
scene's world CRS with the CRS recorded in `sourceScene.crs` — document clearly that
this is NOT always EPSG:4326 (GeoJSON spec purists reprojet later; a `warnings` entry
notes non-4326 output). Conversion: annotations store world coords already
(`AnnotationOverlay.jsx` worldX/worldY); ROI/transect store image pixels — convert via
bounds exactly as `docs/COORDINATE_SYSTEMS.md` "Image Pixel ↔ World" specifies
(row 0 = north = maxY).

## Integration (minimal touch — main.jsx has uncommitted upstream changes)

- Wire two handlers in `app/main.jsx`: "Save Markup (GeoJSON)" (download via existing
  `downloadBuffer`/blob pattern) and "Load Markup" (file input), placed near the
  existing annotation controls. Keep the main.jsx diff as small as possible — all logic
  in annotation-io.js. Also accept `.geojson` markup files in the existing drop handler
  ONLY if the diff stays trivial; otherwise skip drop support and note it.
- `measurements`: for ROI features, if a `roiProfile` object is passed in, embed
  `{mean, count, histMin, histMax, useDecibels}` — stats attached to geometry.

## Out of scope

- No STAC label extension emission yet (W011). No reprojection. No UI redesign.
- Note: annotation `size` presets exist only in the uncommitted working tree; code
  against HEAD's annotation shape and tolerate unknown extra fields on import/export
  (pass through `style` keys you don't recognize).

## Acceptance criteria

- `npm test` + `npm run build` pass.
- New `test/unit/annotation-io.test.mjs`: build a synthetic scene
  (bounds/CRS/width/height) + one of each markup kind → toGeoJSON → JSON.parse →
  fromGeoJSON → deep-equal round-trip (world coords within 1e-9; pixel-derived ROI
  within 0.5 px). Validate output is well-formed GeoJSON (type, coordinates nesting).
- Round-trip preserves unknown properties (forward compatibility).
