/**
 * annotation-io.js — GeoJSON (de)serialization for SARdine analysis markup.
 *
 * Serializes annotations (arrows + text labels), the ROI rectangle, the
 * transect line, and feature-space classifier regions as a GeoJSON
 * FeatureCollection with a versioned properties schema — and imports them
 * back. This is the durable/interoperable form of SARdine's interpretation
 * layer (W004; PLATFORM_REVIEW.md Phase 2–3 builds on this schema).
 *
 * COORDINATE SYSTEM NOTE (important): feature coordinates are written in the
 * scene's WORLD CRS (UTM meters or lon/lat degrees), recorded per-feature in
 * `properties.sourceScene.crs` and at the collection level in `sardine:crs`.
 * This is NOT necessarily EPSG:4326, which strict GeoJSON (RFC 7946) assumes.
 * Consumers that require spec-compliant GeoJSON must reproject.
 * `geoJSONToAnnotations` emits a `warnings` entry when the CRS is not
 * EPSG:4326.
 *
 * Pixel ↔ world conversion follows docs/COORDINATE_SYSTEMS.md
 * ("Image Pixel ↔ World" — row 0 = north = maxY):
 *
 *   worldX = bounds[0] + (col / width)  * (bounds[2] - bounds[0])
 *   worldY = bounds[3] - (row / height) * (bounds[3] - bounds[1])
 *
 * Kind → geometry mapping:
 *   annotation-text  → Point       (annotations already store world coords)
 *   annotation-arrow → LineString  (tail → head)
 *   roi              → Polygon     (image-pixel rect → world, CCW exterior ring)
 *   transect         → LineString  (image-pixel endpoints → world)
 *   class-region     → null geometry + `properties.featureSpace`
 *                      ({xMin,xMax,yMin,yMax} in dB feature space, NOT geography)
 *
 * Forward compatibility: unknown feature properties survive a round trip.
 * On import they are stashed on the reconstructed state objects
 * (`__geojsonProps` for top-level properties, `__styleExtra` for unknown
 * `style` keys) and re-emitted on export. Unknown fields on state objects
 * (e.g. future annotation attributes) are carried in
 * `properties["sardine:extra"]` and spread back onto the object on import.
 *
 * Feature properties schema (version 1):
 * {
 *   "sardine:kind": "annotation-arrow | annotation-text | roi | transect | class-region",
 *   "sardine:schema": 1,
 *   "label": "<text or class name>",
 *   "observer": "human",
 *   "method": "manual",
 *   "created": "<ISO 8601 UTC>",
 *   "confidence": null,
 *   "sourceScene": { "file": "<filename>", "crs": "EPSG:XXXX", "bounds": [w,s,e,n] },
 *   "style": { "color": "cyan", "size": "medium" },
 *   "measurements": { }
 * }
 */

export const SARDINE_MARKUP_SCHEMA_VERSION = 1;

// Fields of the app-state objects that map to schema slots (everything else
// is passed through via properties["sardine:extra"]).
const ANNOTATION_KEYS = ['id', 'type', 'color', 'size', 'fontSize', 'text',
  'worldX', 'worldY', 'worldX2', 'worldY2', '__geojsonProps', '__styleExtra'];
const ROI_KEYS = ['id', 'label', 'color', 'size', 'left', 'top', 'width', 'height',
  '__geojsonProps', '__styleExtra'];
const TRANSECT_KEYS = ['id', 'label', 'color', 'size', 'x0', 'y0', 'x1', 'y1',
  '__geojsonProps', '__styleExtra'];
const CLASS_REGION_KEYS = ['id', 'name', 'color', 'size', 'xMin', 'xMax', 'yMin', 'yMax',
  '__geojsonProps', '__styleExtra'];

// Property keys the importer consumes into object fields; everything else is
// preserved verbatim in __geojsonProps for re-export.
const CONSUMED_PROPS = ['sardine:kind', 'sardine:schema', 'label', 'style',
  'sardine:extra', 'sourceScene'];

// ─── Pixel ↔ world (docs/COORDINATE_SYSTEMS.md) ─────────────────────────────

function pixelToWorldPt(col, row, { bounds, width, height }) {
  const wx = bounds[0] + (col / width) * (bounds[2] - bounds[0]);
  const wy = bounds[3] - (row / height) * (bounds[3] - bounds[1]); // row 0 = north = maxY
  return [wx, wy];
}

function worldToPixelPt(wx, wy, { bounds, width, height }) {
  const col = ((wx - bounds[0]) / (bounds[2] - bounds[0])) * width;
  const row = ((bounds[3] - wy) / (bounds[3] - bounds[1])) * height; // larger worldY → smaller row
  return [col, row];
}

/**
 * Validate that the scene carries enough information to convert image-pixel
 * markup (ROI, transect) to world coordinates. Falls back to identity pixel
 * bounds [0, 0, width, height] when the scene has no georeferencing (same
 * fallback the loaders use).
 */
function requirePixelScene(scene, what) {
  const width = scene?.width;
  const height = scene?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`cannot convert ${what}: scene {width, height} required for pixel↔world conversion`);
  }
  const bounds = (Array.isArray(scene?.bounds) && scene.bounds.length >= 4)
    ? scene.bounds
    : [0, 0, width, height];
  return { bounds, width, height };
}

// ─── Shared feature builders ─────────────────────────────────────────────────

function pickExtra(obj, knownKeys) {
  const extra = {};
  if (!obj || typeof obj !== 'object') return extra;
  for (const k of Object.keys(obj)) {
    if (!knownKeys.includes(k) && obj[k] !== undefined) extra[k] = obj[k];
  }
  return extra;
}

function buildStyle(obj) {
  const o = obj || {};
  const style = { ...(o.__styleExtra || {}) };
  style.color = o.color || style.color || 'cyan';
  style.size = o.size || style.size || 'medium';
  if (o.fontSize != null) style.fontSize = o.fontSize;
  return style;
}

function makeFeature({ id, kind, geometry, label, obj, knownKeys, sourceScene, created }) {
  const preserved = (obj && obj.__geojsonProps) || {};
  const extra = pickExtra(obj, knownKeys);
  const properties = {
    // Defaults — overridden by preserved (round-tripped) properties so that
    // e.g. observer: "agent" or an original `created` timestamp survives.
    observer: 'human',
    method: 'manual',
    created,
    confidence: null,
    measurements: {},
    ...preserved,
    // Structural slots — always regenerated from current state.
    'sardine:kind': kind,
    'sardine:schema': SARDINE_MARKUP_SCHEMA_VERSION,
    label: label !== undefined ? label : (preserved.label ?? ''),
    sourceScene,
    style: buildStyle(obj),
  };
  if (Object.keys(extra).length > 0) properties['sardine:extra'] = extra;
  const feature = { type: 'Feature', geometry: geometry ?? null, properties };
  if (id !== undefined && id !== null) feature.id = id;
  return feature;
}

function genId() {
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Move style/unknown-property information from a parsed feature back onto a
// reconstructed state object (import-side counterpart of makeFeature).
function attachExtras(obj, props, style, extraConsumed = []) {
  if (style.size !== undefined) obj.size = style.size;
  if (style.fontSize !== undefined) obj.fontSize = style.fontSize;
  const styleExtra = {};
  for (const k of Object.keys(style)) {
    if (k !== 'color' && k !== 'size' && k !== 'fontSize') styleExtra[k] = style[k];
  }
  if (Object.keys(styleExtra).length > 0) obj.__styleExtra = styleExtra;
  const consumed = new Set([...CONSUMED_PROPS, ...extraConsumed]);
  const geojsonProps = {};
  for (const k of Object.keys(props)) {
    if (!consumed.has(k)) geojsonProps[k] = props[k];
  }
  if (Object.keys(geojsonProps).length > 0) obj.__geojsonProps = geojsonProps;
  return obj;
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Serialize SARdine markup state to a GeoJSON FeatureCollection.
 *
 * @param {object} state
 * @param {Array}  state.annotations  Arrow/text annotations (world coords,
 *                                    AnnotationOverlay shape).
 * @param {object} state.roi          {left, top, width, height} in image pixels, or null.
 * @param {object} state.transectLine {x0, y0, x1, y1} in image pixels, or null.
 * @param {Array}  state.classRegions [{name, color, xMin, xMax, yMin, yMax}] in dB feature space.
 * @param {object} state.scene        {file, crs, bounds: [w,s,e,n], width, height}.
 * @param {object} state.renderState  Optional — embedded verbatim as the
 *                                    collection-level "sardine:renderState" member.
 * @param {object} state.roiProfile   Optional — {mean, count, histMin, histMax, useDecibels}
 *                                    embedded as the ROI feature's measurements.
 * @returns {object} GeoJSON FeatureCollection (coords in the scene's world CRS —
 *                   see module docs; NOT always EPSG:4326).
 */
export function annotationsToGeoJSON({
  annotations = [],
  roi = null,
  transectLine = null,
  classRegions = [],
  scene = null,
  renderState = null,
  roiProfile = null,
} = {}) {
  const created = new Date().toISOString();
  const sourceScene = {
    file: scene?.file ?? null,
    crs: scene?.crs ?? null,
    bounds: (Array.isArray(scene?.bounds) && scene.bounds.length >= 4)
      ? scene.bounds.slice(0, 4)
      : null,
  };
  const features = [];

  // Annotations — already stored in world coordinates.
  for (const a of annotations || []) {
    if (!a || (a.type !== 'arrow' && a.type !== 'text')) continue;
    const geometry = a.type === 'arrow'
      ? { type: 'LineString', coordinates: [[a.worldX, a.worldY], [a.worldX2, a.worldY2]] } // tail → head
      : { type: 'Point', coordinates: [a.worldX, a.worldY] };
    features.push(makeFeature({
      id: a.id,
      kind: a.type === 'arrow' ? 'annotation-arrow' : 'annotation-text',
      geometry,
      label: a.text || '',
      obj: a,
      knownKeys: ANNOTATION_KEYS,
      sourceScene,
      created,
    }));
  }

  // ROI — image-pixel rect → world Polygon (CCW exterior ring: NW→SW→SE→NE).
  if (roi) {
    const px = requirePixelScene(scene, 'ROI');
    const ring = [
      [roi.left, roi.top],                          // NW
      [roi.left, roi.top + roi.height],             // SW
      [roi.left + roi.width, roi.top + roi.height], // SE
      [roi.left + roi.width, roi.top],              // NE
      [roi.left, roi.top],                          // close
    ].map(([c, r]) => pixelToWorldPt(c, r, px));
    const feature = makeFeature({
      id: roi.id ?? 'roi',
      kind: 'roi',
      geometry: { type: 'Polygon', coordinates: [ring] },
      label: roi.label,
      obj: roi,
      knownKeys: ROI_KEYS,
      sourceScene,
      created,
    });
    if (roiProfile) {
      feature.properties.measurements = {
        mean: roiProfile.mean ?? null,
        count: roiProfile.count ?? null,
        histMin: roiProfile.histMin ?? null,
        histMax: roiProfile.histMax ?? null,
        useDecibels: roiProfile.useDecibels ?? null,
      };
    }
    features.push(feature);
  }

  // Transect — image-pixel endpoints → world LineString.
  if (transectLine) {
    const px = requirePixelScene(scene, 'transect');
    features.push(makeFeature({
      id: transectLine.id ?? 'transect',
      kind: 'transect',
      geometry: {
        type: 'LineString',
        coordinates: [
          pixelToWorldPt(transectLine.x0, transectLine.y0, px),
          pixelToWorldPt(transectLine.x1, transectLine.y1, px),
        ],
      },
      label: transectLine.label,
      obj: transectLine,
      knownKeys: TRANSECT_KEYS,
      sourceScene,
      created,
    }));
  }

  // Classifier regions — dB feature space, not geography → null geometry +
  // featureSpace bounds in properties.
  (classRegions || []).forEach((r, i) => {
    if (!r) return;
    const feature = makeFeature({
      id: r.id ?? `class-region-${i}`,
      kind: 'class-region',
      geometry: null,
      label: r.name ?? '',
      obj: r,
      knownKeys: CLASS_REGION_KEYS,
      sourceScene,
      created,
    });
    feature.properties.featureSpace = {
      xMin: r.xMin, xMax: r.xMax, yMin: r.yMin, yMax: r.yMax,
    };
    features.push(feature);
  });

  const fc = {
    type: 'FeatureCollection',
    'sardine:schema': SARDINE_MARKUP_SCHEMA_VERSION,
    'sardine:crs': sourceScene.crs, // NOT always EPSG:4326 — see module docs
    features,
  };
  if (renderState != null) fc['sardine:renderState'] = renderState;
  return fc;
}

// ─── Import ──────────────────────────────────────────────────────────────────

function isCoordPair(c) {
  return Array.isArray(c) && c.length >= 2
    && Number.isFinite(c[0]) && Number.isFinite(c[1]);
}

/**
 * Reconstruct SARdine markup state from a GeoJSON FeatureCollection.
 *
 * Non-fatal problems (unknown kinds, malformed geometry, CRS mismatch,
 * non-4326 coordinates, duplicate ROI/transect features) are reported in
 * `warnings` — matching features are skipped, everything else imports.
 *
 * @param {object} featureCollection Parsed GeoJSON.
 * @param {object} scene             Current scene {crs, bounds, width, height}
 *                                   — needed to convert ROI/transect back to image pixels.
 * @returns {{annotations: Array, roi: object|null, transectLine: object|null,
 *            classRegions: Array, warnings: string[]}}
 */
export function geoJSONToAnnotations(featureCollection, scene = null) {
  if (!featureCollection || typeof featureCollection !== 'object') {
    throw new Error('geoJSONToAnnotations: input is not an object');
  }
  if (featureCollection.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
    throw new Error('geoJSONToAnnotations: input is not a GeoJSON FeatureCollection');
  }

  const warnings = [];
  const annotations = [];
  const classRegions = [];
  let roi = null;
  let transectLine = null;

  const fcCrs = featureCollection['sardine:crs'] ?? null;
  const fcSchema = featureCollection['sardine:schema'];
  if (typeof fcSchema === 'number' && fcSchema > SARDINE_MARKUP_SCHEMA_VERSION) {
    warnings.push(`markup schema ${fcSchema} is newer than supported ${SARDINE_MARKUP_SCHEMA_VERSION} — importing best-effort`);
  }

  let warnedNon4326 = false;
  let warnedMismatch = false;
  let warnedSchema = false;

  featureCollection.features.forEach((f, idx) => {
    const where = `feature ${idx}${f && f.id != null ? ` (${f.id})` : ''}`;
    if (!f || f.type !== 'Feature') {
      warnings.push(`${where}: not a GeoJSON Feature — skipped`);
      return;
    }
    const props = (f.properties && typeof f.properties === 'object') ? f.properties : {};
    const kind = props['sardine:kind'];
    if (!kind) {
      warnings.push(`${where}: no "sardine:kind" property — skipped (not SARdine markup)`);
      return;
    }
    const schema = props['sardine:schema'];
    if (!warnedSchema && typeof schema === 'number' && schema > SARDINE_MARKUP_SCHEMA_VERSION) {
      warnings.push(`markup features use schema ${schema} (supported: ${SARDINE_MARKUP_SCHEMA_VERSION}) — importing best-effort`);
      warnedSchema = true;
    }

    const featCrs = props.sourceScene?.crs ?? fcCrs;
    if (featCrs && featCrs !== 'EPSG:4326' && !warnedNon4326) {
      warnings.push(`markup coordinates are in ${featCrs}, not EPSG:4326 — nonstandard GeoJSON, other tools must reproject`);
      warnedNon4326 = true;
    }
    if (featCrs && scene?.crs && featCrs !== scene.crs && !warnedMismatch) {
      warnings.push(`markup CRS ${featCrs} differs from current scene CRS ${scene.crs} — geometry may be misplaced`);
      warnedMismatch = true;
    }

    const style = (props.style && typeof props.style === 'object') ? props.style : {};
    const extra = (props['sardine:extra'] && typeof props['sardine:extra'] === 'object')
      ? props['sardine:extra'] : {};
    const g = f.geometry;

    switch (kind) {
      case 'annotation-arrow': {
        if (!g || g.type !== 'LineString' || !Array.isArray(g.coordinates)
            || g.coordinates.length < 2 || !isCoordPair(g.coordinates[0]) || !isCoordPair(g.coordinates[1])) {
          warnings.push(`${where}: annotation-arrow needs a 2-point LineString — skipped`);
          return;
        }
        const [tail, head] = g.coordinates;
        annotations.push(attachExtras({
          ...extra,
          id: f.id != null ? String(f.id) : genId(),
          type: 'arrow',
          color: style.color || 'cyan',
          worldX: tail[0], worldY: tail[1],
          worldX2: head[0], worldY2: head[1],
          text: typeof props.label === 'string' ? props.label : '',
        }, props, style));
        break;
      }
      case 'annotation-text': {
        if (!g || g.type !== 'Point' || !isCoordPair(g.coordinates)) {
          warnings.push(`${where}: annotation-text needs a Point — skipped`);
          return;
        }
        annotations.push(attachExtras({
          ...extra,
          id: f.id != null ? String(f.id) : genId(),
          type: 'text',
          color: style.color || 'cyan',
          worldX: g.coordinates[0], worldY: g.coordinates[1],
          text: typeof props.label === 'string' ? props.label : '',
        }, props, style));
        break;
      }
      case 'roi': {
        if (roi) {
          warnings.push(`${where}: multiple ROI features — keeping the first`);
          return;
        }
        const ring = (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) ? g.coordinates[0] : null;
        if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isCoordPair)) {
          warnings.push(`${where}: roi needs a Polygon with a valid exterior ring — skipped`);
          return;
        }
        let px;
        try {
          px = requirePixelScene(scene, 'ROI');
        } catch (e) {
          warnings.push(`${where}: ${e.message} — skipped`);
          return;
        }
        let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minWX) minWX = x;
          if (x > maxWX) maxWX = x;
          if (y < minWY) minWY = y;
          if (y > maxWY) maxWY = y;
        }
        const [left, top] = worldToPixelPt(minWX, maxWY, px);      // NW: max worldY → min row
        const [right, bottom] = worldToPixelPt(maxWX, minWY, px);  // SE: min worldY → max row
        roi = attachExtras({
          ...extra,
          left, top,
          width: right - left,
          height: bottom - top,
        }, props, style);
        break;
      }
      case 'transect': {
        if (transectLine) {
          warnings.push(`${where}: multiple transect features — keeping the first`);
          return;
        }
        if (!g || g.type !== 'LineString' || !Array.isArray(g.coordinates)
            || g.coordinates.length < 2 || !isCoordPair(g.coordinates[0]) || !isCoordPair(g.coordinates[1])) {
          warnings.push(`${where}: transect needs a 2-point LineString — skipped`);
          return;
        }
        let px;
        try {
          px = requirePixelScene(scene, 'transect');
        } catch (e) {
          warnings.push(`${where}: ${e.message} — skipped`);
          return;
        }
        const [p0, p1] = g.coordinates;
        const [x0, y0] = worldToPixelPt(p0[0], p0[1], px);
        const [x1, y1] = worldToPixelPt(p1[0], p1[1], px);
        transectLine = attachExtras({ ...extra, x0, y0, x1, y1 }, props, style);
        break;
      }
      case 'class-region': {
        const fs = (props.featureSpace && typeof props.featureSpace === 'object')
          ? props.featureSpace : null;
        if (!fs) {
          warnings.push(`${where}: class-region has no featureSpace bounds — skipped`);
          return;
        }
        classRegions.push(attachExtras({
          ...extra,
          name: typeof props.label === 'string' ? props.label : '',
          color: style.color || 'cyan',
          xMin: fs.xMin, xMax: fs.xMax,
          yMin: fs.yMin, yMax: fs.yMax,
        }, props, style, ['featureSpace']));
        break;
      }
      default:
        warnings.push(`${where}: unknown sardine:kind "${kind}" — skipped`);
    }
  });

  return { annotations, roi, transectLine, classRegions, warnings };
}

// ─── Helpers for app integration ─────────────────────────────────────────────

/** Heuristic: is this parsed GeoJSON a SARdine markup file (vs a plain overlay)? */
export function isSardineMarkup(geojson) {
  if (!geojson || geojson.type !== 'FeatureCollection') return false;
  if (geojson['sardine:schema'] != null) return true;
  return Array.isArray(geojson.features)
    && geojson.features.some((f) => f?.properties?.['sardine:kind']);
}

/** Trigger a browser download of the FeatureCollection as pretty-printed GeoJSON. */
export function downloadMarkupGeoJSON(featureCollection, filename = 'sardine-markup.geojson') {
  const blob = new Blob([JSON.stringify(featureCollection, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
