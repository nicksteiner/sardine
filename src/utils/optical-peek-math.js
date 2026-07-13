/**
 * optical-peek-math.js — pure math for OpticalPeekLayer (W026).
 *
 * Everything here is dependency-free and side-effect-free so it can be unit
 * tested in plain node (test/unit/optical-peek-math.test.mjs). The layer
 * imports these helpers; keeping them out of OpticalPeekLayer.js also keeps
 * deck.gl/luma.gl out of the test import graph.
 *
 * Spaces involved (see docs/COORDINATE_SYSTEMS.md):
 *   world  — the deck.gl OrthographicView coordinate space of the SAR quad.
 *            Pixel-space [0,0,W,H] for local COG/NITF, geographic for NISAR.
 *   geo    — the image CRS extent (geoBounds): degrees for EPSG:4326,
 *            meters for UTM / polar stereo.
 *   UV     — layer-local [0,1]² over the quad, v=0 at north (maxY).
 *   tile   — Web Mercator Slippy Map tiles at zoom z.
 */

export const TILE_PX = 256;

/** Latitude limit of the Web Mercator projection (EPSG:3857). */
export const WEB_MERCATOR_MAX_LAT = 85.05112878;

/** Ground resolution (m/px) of Web Mercator z=0 at the equator, 256px tiles. */
export const MERCATOR_M_PER_PX_Z0 = 156543.03392;

/** Meters per degree of longitude at the equator (also ~m/deg latitude). */
export const M_PER_DEG = 111320;

// ── proj4 defs for the CRSes SARdine actually loads ───────────────────────
// Mirrors getProj4Def() in overture-loader.js. Kept here so both the layer
// and node tests can use it without importing proj4 itself.
export function proj4DefFor(crs) {
  const m = crs?.match(/EPSG:(\d+)/);
  if (!m) return null;
  const epsg = parseInt(m[1]);
  if (epsg === 4326) return null;
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  if (epsg === 3413) return '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
  if (epsg === 3031) return '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
  return null;
}

/** True if lat/lon can be mapped onto a Web Mercator tile at all. */
export function isMercatorMappable(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= WEB_MERCATOR_MAX_LAT;
}

/** Clamp a latitude into the Web Mercator domain (for range math only —
 *  nodes beyond the limit must still be flagged invalid). */
export function clampMercatorLat(lat) {
  return Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, lat));
}

// ── lon/lat ↔ Web Mercator tile (Slippy Map) ─────────────────────────────
export function lonLatToTilePx(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { tileX: Math.floor(x), tileY: Math.floor(y), pxX: (x - Math.floor(x)) * TILE_PX, pxY: (y - Math.floor(y)) * TILE_PX };
}

/**
 * Tile index range covering a lon/lat box at zoom z. Latitudes are clamped
 * to the Mercator domain; tile y is clamped to [0, 2^z - 1] so a box that
 * pokes past ±85.05° never yields out-of-range rows.
 */
export function tileRangeForLonLat(lonMin, lonMax, latMin, latMax, z) {
  const n = 2 ** z;
  const nw = lonLatToTilePx(lonMin, clampMercatorLat(latMax), z);
  const se = lonLatToTilePx(lonMax, clampMercatorLat(latMin), z);
  const txMin = Math.min(nw.tileX, se.tileX);
  const txMax = Math.max(nw.tileX, se.tileX);
  const tyMin = Math.max(0, Math.min(nw.tileY, se.tileY));
  const tyMax = Math.min(n - 1, Math.max(nw.tileY, se.tileY));
  return { txMin, txMax, tyMin, tyMax, cols: txMax - txMin + 1, rows: tyMax - tyMin + 1 };
}

/**
 * Step a requested zoom down until the tile range fits the atlas caps.
 * Two caps: total tile count (GPU memory backstop) and per-axis tile count
 * (a 256px-tile row must also fit the browser's max canvas dimension —
 * ~16,384 px on conservative GPUs → 64 tiles per axis).
 *
 * Returns { zoom, range } with range from tileRangeForLonLat at the fitted z.
 */
export function fitZoomToCaps({
  lonMin, lonMax, latMin, latMax, zoom,
  maxTilesTotal = 1024, maxTilesAxis = 64, minZoom = 1,
}) {
  let z = Math.max(minZoom, Math.round(zoom));
  let range = tileRangeForLonLat(lonMin, lonMax, latMin, latMax, z);
  while (z > minZoom
    && (range.cols * range.rows > maxTilesTotal || range.cols > maxTilesAxis || range.rows > maxTilesAxis)) {
    z -= 1;
    range = tileRangeForLonLat(lonMin, lonMax, latMin, latMax, z);
  }
  return { zoom: z, range };
}

/**
 * Ground meters per world unit of the SAR quad's coordinate space, along x.
 *
 * bounds and geoBounds are affine-related rectangles over the same image:
 * the world→geo scale is just the span ratio. For a geographic CRS the geo
 * unit is a degree of longitude, worth M_PER_DEG·cos(lat) meters; for a
 * projected CRS the geo unit is already a meter.
 */
export function metersPerWorldUnit({ bounds, geoBounds, isProjected, latCenterDeg }) {
  const worldSpan = bounds[2] - bounds[0];
  const geoSpan = geoBounds[2] - geoBounds[0];
  if (!(worldSpan > 0)) return 0;
  const metersPerGeoUnit = isProjected
    ? 1
    : M_PER_DEG * Math.cos((latCenterDeg * Math.PI) / 180);
  return (geoSpan / worldSpan) * metersPerGeoUnit;
}

/**
 * Web Mercator zoom whose ground resolution matches the screen, given an
 * OrthographicView zoom (screen px per world unit = 2^viewZoom).
 *
 * Picks the smallest z whose tile resolution is at least screen resolution
 * (ceil), clamped to [minZoom, maxZoom]. Returns minZoom when inputs are
 * degenerate (zero scale, zoomed out to nothing).
 */
export function detailZoomForView({ viewZoom, metersPerWorld, latCenterDeg, maxZoom, minZoom = 1 }) {
  const metersPerScreenPx = metersPerWorld / 2 ** viewZoom;
  if (!(metersPerScreenPx > 0)) return minZoom;
  const cosLat = Math.cos((latCenterDeg * Math.PI) / 180);
  const zIdeal = Math.ceil(Math.log2((MERCATOR_M_PER_PX_Z0 * cosLat) / metersPerScreenPx));
  return Math.max(minZoom, Math.min(maxZoom, zIdeal));
}

/**
 * World-space rect → layer-UV rect [u0, v0, u1, v1], v=0 at north (maxY),
 * matching the texCoord winding of the quad and the warp-grid walk.
 */
export function worldRectToUV(rect, bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  const sx = maxX - minX;
  const sy = maxY - minY;
  return [
    (rect[0] - minX) / sx,
    (maxY - rect[3]) / sy,
    (rect[2] - minX) / sx,
    (maxY - rect[1]) / sy,
  ];
}

/** Layer-UV rect → geo-bounds rect [minX, minY, maxX, maxY] (inverse of
 *  worldRectToUV applied to geoBounds — same v=0-at-north convention). */
export function uvRectToGeoBounds(uvRect, geoBounds) {
  const [minX, minY, maxX, maxY] = geoBounds;
  const sx = maxX - minX;
  const sy = maxY - minY;
  return [
    minX + uvRect[0] * sx,
    maxY - uvRect[3] * sy,
    minX + uvRect[2] * sx,
    maxY - uvRect[1] * sy,
  ];
}

/** Pad a world rect by `frac` of its span on each side, clamped to limits. */
export function padRect(rect, frac, limits) {
  const px = (rect[2] - rect[0]) * frac;
  const py = (rect[3] - rect[1]) * frac;
  return [
    Math.max(limits[0], rect[0] - px),
    Math.max(limits[1], rect[1] - py),
    Math.min(limits[2], rect[2] + px),
    Math.min(limits[3], rect[3] + py),
  ];
}

/** Wrap a tile x index into [0, 2^z) for the request URL (antimeridian). */
export function wrapTileX(x, z) {
  const n = 2 ** z;
  return ((x % n) + n) % n;
}
