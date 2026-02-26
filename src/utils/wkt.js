/**
 * wkt.js — Minimal WKT (Well-Known Text) geometry parser for SARdine.
 *
 * Converts WKT strings to GeoJSON and extracts bounding boxes.
 * No external dependencies — pure string parsing.
 *
 * Supported WKT types: POLYGON, MULTIPOLYGON, POINT, LINESTRING, MULTILINESTRING
 * Also supports a BBOX shorthand: BBOX(west, south, east, north)
 */

/**
 * Parse a WKT coordinate ring string into an array of [x, y] pairs.
 * @param {string} ring — "x1 y1, x2 y2, x3 y3, ..."
 * @returns {number[][]} — [[x1,y1], [x2,y2], ...]
 */
function parseRing(ring) {
  return ring.trim().split(',').map(pair => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x, y];
  });
}

/**
 * Parse a WKT string into a GeoJSON geometry object.
 *
 * @param {string} wkt — WKT geometry string
 * @returns {{ type: string, coordinates: any }} GeoJSON geometry
 * @throws {Error} if WKT cannot be parsed
 */
export function parseWKT(wkt) {
  if (!wkt || typeof wkt !== 'string') {
    throw new Error('WKT must be a non-empty string');
  }

  const trimmed = wkt.trim();

  // BBOX shorthand: BBOX(west, south, east, north)
  const bboxMatch = trimmed.match(/^BBOX\s*\(\s*([^)]+)\s*\)$/i);
  if (bboxMatch) {
    const [west, south, east, north] = bboxMatch[1].split(',').map(s => parseFloat(s.trim()));
    if ([west, south, east, north].some(isNaN)) {
      throw new Error('BBOX values must be numeric: BBOX(west, south, east, north)');
    }
    return {
      type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    };
  }

  // POINT(x y)
  const pointMatch = trimmed.match(/^POINT\s*\(\s*([^\s]+)\s+([^\s)]+)\s*\)$/i);
  if (pointMatch) {
    const x = parseFloat(pointMatch[1]);
    const y = parseFloat(pointMatch[2]);
    if (isNaN(x) || isNaN(y)) throw new Error('POINT coordinates must be numeric');
    return { type: 'Point', coordinates: [x, y] };
  }

  // LINESTRING(x1 y1, x2 y2, ...)
  const lineMatch = trimmed.match(/^LINESTRING\s*\(\s*([^)]+)\s*\)$/i);
  if (lineMatch) {
    return { type: 'LineString', coordinates: parseRing(lineMatch[1]) };
  }

  // MULTILINESTRING((x1 y1, x2 y2), (x3 y3, x4 y4))
  const mlineMatch = trimmed.match(/^MULTILINESTRING\s*\(\s*(.*)\s*\)$/is);
  if (mlineMatch) {
    const rings = mlineMatch[1].match(/\(([^)]+)\)/g);
    if (!rings) throw new Error('Invalid MULTILINESTRING WKT');
    return {
      type: 'MultiLineString',
      coordinates: rings.map(r => parseRing(r.replace(/^\(|\)$/g, ''))),
    };
  }

  // MULTIPOLYGON(((x1 y1, ...)), ((x1 y1, ...)))
  const mpMatch = trimmed.match(/^MULTIPOLYGON\s*\(\s*(.*)\s*\)$/is);
  if (mpMatch) {
    // Split on )),(( to separate polygons
    const polyStrings = mpMatch[1].split(/\)\s*,\s*\(/);
    const polygons = polyStrings.map(ps => {
      // Extract all rings within this polygon
      const cleaned = ps.replace(/^\(+|\)+$/g, '');
      const rings = cleaned.split(/\)\s*,\s*\(/);
      return rings.map(r => parseRing(r.replace(/^\(+|\)+$/g, '')));
    });
    return { type: 'MultiPolygon', coordinates: polygons };
  }

  // POLYGON((x1 y1, x2 y2, ...), (hole1), ...)
  const polyMatch = trimmed.match(/^POLYGON\s*\(\s*(.*)\s*\)$/is);
  if (polyMatch) {
    const inner = polyMatch[1];
    const rings = inner.match(/\(([^)]+)\)/g);
    if (!rings) throw new Error('Invalid POLYGON WKT: no coordinate rings found');
    return {
      type: 'Polygon',
      coordinates: rings.map(r => parseRing(r.replace(/^\(|\)$/g, ''))),
    };
  }

  throw new Error(`Unsupported WKT type. Expected POLYGON, MULTIPOLYGON, POINT, LINESTRING, or BBOX. Got: ${trimmed.slice(0, 40)}...`);
}

/**
 * Extract the bounding box of a WKT geometry.
 *
 * @param {string} wkt — WKT geometry string
 * @returns {number[]} [west, south, east, north]
 */
export function wktToBbox(wkt) {
  const geom = parseWKT(wkt);
  return geometryToBbox(geom);
}

/**
 * Compute the bbox of a GeoJSON geometry.
 * @param {{ type: string, coordinates: any }} geom
 * @returns {number[]} [minX, minY, maxX, maxY]
 */
function geometryToBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function visit(coords) {
    if (typeof coords[0] === 'number') {
      // It's a coordinate pair [x, y]
      if (coords[0] < minX) minX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] > maxY) maxY = coords[1];
    } else {
      // It's a nested array — recurse
      for (const c of coords) visit(c);
    }
  }

  visit(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

/**
 * Convert a [west, south, east, north] bbox to a WKT POLYGON string.
 *
 * @param {number[]} bbox — [west, south, east, north]
 * @returns {string} WKT POLYGON
 */
export function bboxToWKT(bbox) {
  const [w, s, e, n] = bbox;
  return `POLYGON ((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

/**
 * Validate a WKT string without throwing.
 *
 * @param {string} wkt — WKT string to validate
 * @returns {{ valid: boolean, error?: string, bbox?: number[], type?: string }}
 */
export function validateWKT(wkt) {
  try {
    const geom = parseWKT(wkt);
    const bbox = geometryToBbox(geom);
    if (bbox.some(isNaN) || bbox.some(v => !isFinite(v))) {
      return { valid: false, error: 'Coordinates contain non-numeric values' };
    }
    return { valid: true, bbox, type: geom.type };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Convert a WKT string to a GeoJSON Feature (for deck.gl rendering).
 *
 * @param {string} wkt — WKT geometry string
 * @returns {{ type: 'Feature', geometry: Object, properties: {} }}
 */
export function wktToGeoJSON(wkt) {
  return {
    type: 'Feature',
    geometry: parseWKT(wkt),
    properties: {},
  };
}
