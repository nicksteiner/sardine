/**
 * exposure.js — people and buildings under a polygon, computed in the browser.
 *
 * The raster → vector analysis behind "how many are affected": a mask drawn
 * or derived from SAR (flood extent, damage, an ROI) becomes a lon/lat
 * polygon; the population comes from a gridded density COG read through
 * cog-tile-reader (GHS-POP 100 m on OpenLandMap: people per km², EPSG:4326),
 * and the buildings from the VIDA footprint PMTiles. No server, no
 * pre-computed zonal tables — the numbers come straight from the data files.
 *
 * Conventions: polygons are GeoJSON-style rings of [lon, lat]; the first
 * ring is the outer boundary, further rings are holes.
 */
import { fetchOvertureTile } from '../loaders/overture-loader.js';

/** Default population source: GHS-POP (JRC, CC BY) 2021, people / km². */
export const GHS_POP_COG_URL = (year = 2021) =>
  `https://s3.openlandmap.org/arco/pop.count_ghs.jrc_m_100m_s_${year}0101_${year}1231_go_epsg.4326_v20230620.tif`;

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

/** Area in km² of one EPSG:4326 cell of dLon × dLat degrees centred at `lat`. */
export function cellAreaKm2(lat, dLonDeg, dLatDeg) {
  const width = EARTH_RADIUS_KM * Math.cos(lat * DEG) * dLonDeg * DEG;
  const height = EARTH_RADIUS_KM * dLatDeg * DEG;
  return Math.abs(width * height);
}

/** Ray-casting point-in-polygon with holes. */
export function pointInPolygon(lon, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** [minLon, minLat, maxLon, maxLat] of a polygon's outer ring. */
export function polygonBbox(rings) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of rings[0]) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Sum a density raster over a polygon.
 *
 * @param {COGReader} reader - cog-tile-reader over an EPSG:4326 density COG
 * @param {number[][][]} rings - polygon in lon/lat
 * @param {Object} [opts]
 * @param {number} [opts.maxCells=4e6] - pick a coarser overview above this
 *   many cells in the bbox (density averages cleanly across overviews)
 * @param {'density'|'count'} [opts.units='density'] - raster semantics:
 *   people per km² (× cell area) or people per cell (summed as is)
 * @returns {Promise<{people:number, cells:number, areaKm2:number, level:number}>}
 */
export async function sumPopulationInPolygon(reader, rings, { maxCells = 4e6, units = 'density' } = {}) {
  const [minLon, minLat, maxLon, maxLat] = polygonBbox(rings);
  const [rMinX, rMinY, rMaxX, rMaxY] = reader.bbox;
  const fullSx = reader.width / (rMaxX - rMinX);
  const fullSy = reader.height / (rMaxY - rMinY);
  const baseCells = (maxLon - minLon) * fullSx * (maxLat - minLat) * fullSy;

  // Coarsest level that still keeps the bbox under maxCells.
  let level = 0;
  for (let i = 0; i < reader.levelCount; i++) {
    const scale = reader.levels[i].width / reader.width;
    if (baseCells * scale * scale <= maxCells) { level = i; break; }
    level = i;
  }
  const L = reader.levels[level];
  const sx = L.width / (rMaxX - rMinX);
  const sy = L.height / (rMaxY - rMinY);
  const win = [
    Math.floor((minLon - rMinX) * sx), Math.floor((rMaxY - maxLat) * sy),
    Math.ceil((maxLon - rMinX) * sx), Math.ceil((rMaxY - minLat) * sy),
  ];
  const w = await reader.readWindow(level, win);
  if (!w) return { people: 0, cells: 0, areaKm2: 0, level };

  const dLon = 1 / sx;
  const dLat = 1 / sy;
  const left = Math.max(0, win[0]);
  const top = Math.max(0, win[1]);
  let people = 0, cells = 0, areaKm2 = 0;
  for (let r = 0; r < w.height; r++) {
    const lat = rMaxY - (top + r + 0.5) * dLat;
    const area = cellAreaKm2(lat, dLon, dLat);
    for (let c = 0; c < w.width; c++) {
      const lon = rMinX + (left + c + 0.5) * dLon;
      if (!pointInPolygon(lon, lat, rings)) continue;
      const v = w.data[r * w.width + c];
      cells++;
      areaKm2 += area;
      if (Number.isFinite(v) && v > 0) people += units === 'density' ? v * area : v;
    }
  }
  return { people, cells, areaKm2, level };
}

/**
 * Count building footprints whose centroid falls inside a polygon, reading
 * the covering tiles of a footprint PMTiles archive (VIDA by default — the
 * `buildings` theme in OVERTURE_THEMES).
 *
 * @param {number[][][]} rings - polygon in lon/lat
 * @param {Object} [opts]
 * @param {string} [opts.url] - PMTiles archive (defaults to the VIDA global file)
 * @param {string} [opts.layer] - vector layer id
 * @param {number} [opts.zoom=14] - tile zoom to read (14 ≈ full footprints)
 * @param {number} [opts.maxTiles=64] - refuse polygons larger than this at `zoom`
 * @returns {Promise<{buildings:number, areaM2:number, tiles:number, bySource:Object}>}
 */
export async function countBuildingsInPolygon(rings, {
  url = 'https://data.source.coop/vida/google-microsoft-osm-open-buildings/pmtiles/goog_msft_osm.pmtiles',
  layer = 'goog_msft_osm_building_footprints',
  zoom = 14,
  maxTiles = 64,
} = {}) {
  const [minLon, minLat, maxLon, maxLat] = polygonBbox(rings);
  const n = Math.pow(2, zoom);
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => Math.floor(((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2) * n);
  const x0 = tx(minLon), x1 = tx(maxLon), y0 = ty(maxLat), y1 = ty(minLat);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > maxTiles) {
    throw new Error(`countBuildingsInPolygon: ${count} tiles at z${zoom} exceeds maxTiles (${maxTiles}); use a coarser zoom or a smaller polygon`);
  }
  const coords = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) coords.push([x, y]);
  const tiles = await Promise.all(coords.map(([x, y]) => fetchOvertureTile('buildings', zoom, x, y, undefined, url).catch(() => null)));

  let buildings = 0, areaM2 = 0;
  const bySource = {};
  const seen = new Set();
  for (const t of tiles) {
    for (const f of t?.layers?.[layer] || []) {
      // Footprints on a tile seam appear in both tiles; dedupe on identity.
      const id = f.id ?? f.properties?.geohash ?? null;
      if (id !== null) { if (seen.has(id)) continue; seen.add(id); }
      const [lon, lat] = centroid(f.geometry);
      if (!pointInPolygon(lon, lat, rings)) continue;
      buildings++;
      areaM2 += Number(f.properties?.area_in_meters) || 0;
      const src = f.properties?.bf_source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }
  }
  return { buildings, areaM2, tiles: coords.length, bySource };
}

/** Vertex-average centroid of a Polygon/MultiPolygon/Point geometry. */
function centroid(geometry) {
  if (!geometry) return [NaN, NaN];
  if (geometry.type === 'Point') return geometry.coordinates;
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates[0][0] : null;
  if (!ring || !ring.length) return [NaN, NaN];
  let sx = 0, sy = 0, k = 0;
  for (let i = 0; i < ring.length - 1; i++) { sx += ring[i][0]; sy += ring[i][1]; k++; }
  return k ? [sx / k, sy / k] : [NaN, NaN];
}

/**
 * Turn a boolean mask on a georeferenced grid into lon/lat polygons: one
 * polygon per mask cell run would be enormous, so this traces the mask at
 * cell resolution into a MultiPolygon of merged rectangles row by row. Good
 * enough for exposure sums (point-in-polygon tests) on masks up to a few
 * hundred thousand cells; for cartography, use a proper contour tracer.
 *
 * @param {Uint8Array|Float32Array} mask - non-zero = inside
 * @param {number} width
 * @param {number} height
 * @param {Function} toLonLat - (col, row) → [lon, lat] for pixel corners
 * @returns {number[][][][]} array of polygons (each: one outer ring)
 */
export function maskToPolygons(mask, width, height, toLonLat) {
  const polys = [];
  for (let r = 0; r < height; r++) {
    let c = 0;
    while (c < width) {
      if (!mask[r * width + c]) { c++; continue; }
      let c1 = c;
      while (c1 < width && mask[r * width + c1]) c1++;
      const a = toLonLat(c, r), b = toLonLat(c1, r), d = toLonLat(c1, r + 1), e = toLonLat(c, r + 1);
      polys.push([[a, b, d, e, a]]);
      c = c1;
    }
  }
  return polys;
}

/**
 * Exposure for a set of polygons (e.g. from maskToPolygons): population and
 * buildings summed over all of them. Buildings are deduped across polygons
 * by counting once per unique tile set is not possible here, so overlapping
 * polygons should be avoided by the caller.
 */
export async function exposureForPolygons(reader, polygons, opts = {}) {
  let people = 0, cells = 0, areaKm2 = 0, buildings = 0, areaM2 = 0;
  for (const rings of polygons) {
    const p = await sumPopulationInPolygon(reader, rings, opts.population);
    people += p.people; cells += p.cells; areaKm2 += p.areaKm2;
    if (opts.buildings !== false) {
      const b = await countBuildingsInPolygon(rings, opts.buildings || {});
      buildings += b.buildings; areaM2 += b.areaM2;
    }
  }
  return { people, cells, areaKm2, buildings, buildingAreaM2: areaM2 };
}
