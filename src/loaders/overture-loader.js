/**
 * Overture Maps Data Loader
 *
 * Streams Overture Maps Foundation data (buildings, roads, places, etc.)
 * from cloud-hosted GeoParquet files via HTTP range requests, and provides
 * vector tile access via PMTiles for map overlays and mini-map context.
 *
 * Overture data lives at:
 *   Parquet: s3://overturemaps-us-west-2/release/{version}/theme={theme}/type={type}/
 *   PMTiles: s3://overturemaps-tiles-us-west-2-beta/{release_date}/{theme}.pmtiles
 *
 * Each theme is partitioned into GeoParquet files spatially, enabling
 * efficient viewport-based fetching — the same streaming pattern
 * SARdine uses for HDF5 and COG.
 *
 * Supported themes:
 *   - buildings/building
 *   - transportation/segment
 *   - places/place
 *   - base/water, base/land, base/land_use, base/infrastructure
 *   - divisions/division
 */

import { PMTiles } from 'pmtiles';

// ── Overture S3 endpoints ──
const OVERTURE_BASE_URL = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com';
const OVERTURE_TILES_URL = 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com';
const DEFAULT_RELEASE = '2024-12-18.0';
const DEFAULT_TILES_RELEASE = '2024-12-18';  // PMTiles use date without minor version

/**
 * Available Overture themes and their types.
 */
export const OVERTURE_THEMES = {
  buildings: {
    label: 'Buildings',
    types: ['building'],
    color: [255, 140, 0, 180],      // orange
    lineColor: [255, 140, 0, 220],
  },
  transportation: {
    label: 'Roads',
    types: ['segment'],
    color: [100, 100, 100, 150],
    lineColor: [200, 200, 200, 200],
    lineWidth: 1,
  },
  places: {
    label: 'Places',
    types: ['place'],
    color: [78, 201, 212, 200],      // sardine cyan
    pointRadius: 4,
  },
  base_water: {
    label: 'Water',
    types: ['water'],
    theme: 'base',
    color: [30, 100, 200, 120],
  },
  base_land_use: {
    label: 'Land Use',
    types: ['land_use'],
    theme: 'base',
    color: [60, 180, 75, 80],
  },
};

/**
 * Feature cache — keyed by "{theme}/{type}/{bbox_hash}"
 * Prevents re-fetching when panning back to previously viewed areas.
 */
const featureCache = new Map();
const MAX_CACHE_ENTRIES = 200;

/**
 * Build the Overture PMTiles or Parquet URL for a theme/type.
 *
 * Overture now also publishes PMTiles which are more efficient for
 * tiled access. We prefer PMTiles when available.
 *
 * @param {string} theme - e.g. 'buildings', 'transportation'
 * @param {string} type - e.g. 'building', 'segment'
 * @param {string} release - Release version
 * @returns {string} URL
 */
export function getOvertureUrl(theme, type, release = DEFAULT_RELEASE) {
  // PMTiles URL (preferred — single file, tiled access)
  return `${OVERTURE_BASE_URL}/release/${release}/theme=${theme}/type=${type}`;
}

/**
 * Fetch Overture features for a bounding box using the Overture API.
 *
 * For browser use, the most practical approach is to use the DuckDB WASM
 * spatial query or a lightweight GeoParquet reader. Since we want to keep
 * dependencies minimal, we use a two-tier approach:
 *
 * 1. For small viewports (high zoom): fetch from Overture's PMTiles endpoint
 * 2. For large viewports: skip (too many features to render)
 *
 * @param {string} theme - Overture theme name
 * @param {string} type - Overture type name
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat] in WGS84
 * @param {Object} options
 * @param {string} options.release - Overture release version
 * @param {number} options.maxFeatures - Max features to return (default 50000)
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
/**
 * Convert projected coordinates (UTM, etc.) to WGS84 for Overture queries.
 *
 * SARdine internally uses projected coordinates (e.g., UTM meters) for
 * NISAR data. Overture data is in WGS84 (EPSG:4326). This function
 * does a simple approximate conversion for bbox queries.
 *
 * For precise conversion, use proj4js. This approximation is sufficient
 * for determining which Overture tiles to fetch.
 *
 * @param {number[]} bounds - [minX, minY, maxX, maxY] in projected CRS
 * @param {string} crs - CRS string like "EPSG:32610"
 * @returns {number[]} [minLon, minLat, maxLon, maxLat] in WGS84
 */
export function projectedToWGS84(bounds, crs) {
  const epsgMatch = crs?.match(/EPSG:(\d+)/);
  if (!epsgMatch) return bounds; // Assume already WGS84

  const epsg = parseInt(epsgMatch[1]);

  // Already WGS84
  if (epsg === 4326) return bounds;

  // UTM zones (326xx for north, 327xx for south)
  if (epsg >= 32601 && epsg <= 32660) {
    const zone = epsg - 32600;
    return utmToWGS84(bounds, zone, true);
  }
  if (epsg >= 32701 && epsg <= 32760) {
    const zone = epsg - 32700;
    return utmToWGS84(bounds, zone, false);
  }

  // Unknown CRS — return as-is and hope for the best
  console.warn(`[Overture] Unknown CRS ${crs}, cannot convert to WGS84`);
  return bounds;
}

/**
 * Approximate UTM → WGS84 conversion (sufficient for bbox queries).
 */
function utmToWGS84(bounds, zone, isNorth) {
  const [minX, minY, maxX, maxY] = bounds;

  // Central meridian of UTM zone
  const lon0 = (zone - 1) * 6 - 180 + 3;

  // Approximate conversion (good to ~0.01° for bbox purposes)
  const k0 = 0.9996;
  const a = 6378137; // WGS84 semi-major axis

  function utmToLatLon(easting, northing) {
    const x = (easting - 500000) / k0;
    const y = isNorth ? northing / k0 : (northing - 10000000) / k0;

    const lat = y / a * (180 / Math.PI);
    const lon = lon0 + x / (a * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);

    return [lon, lat];
  }

  const [minLon, minLat] = utmToLatLon(minX, minY);
  const [maxLon, maxLat] = utmToLatLon(maxX, maxY);

  return [
    Math.min(minLon, maxLon),
    Math.min(minLat, maxLat),
    Math.max(minLon, maxLon),
    Math.max(minLat, maxLat),
  ];
}

/**
 * Convert lon/lat to tile coordinates at a given zoom level.
 */
function lon2tile(lon, zoom) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
}

/**
 * Get tile coordinates that cover a bbox at a given zoom level.
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat]
 * @param {number} zoom - Tile zoom level
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, zoom: number }}
 */
function bboxToTiles(bbox, zoom) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return {
    minX: lon2tile(minLon, zoom),
    maxX: lon2tile(maxLon, zoom),
    minY: lat2tile(maxLat, zoom), // Note: lat2tile is inverted (north = smaller Y)
    maxY: lat2tile(minLat, zoom),
    zoom,
  };
}

/**
 * Determine appropriate zoom level for a bbox viewport.
 * Too high = too many tiles, too low = too coarse features.
 */
function getZoomForBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  const span = Math.max(spanLon, spanLat);

  // Heuristic: pick zoom level where viewport ≈ 1–16 tiles
  if (span > 180) return 0;  // Global view (1 tile)
  if (span > 90) return 1;   // Hemisphere (4 tiles)
  if (span > 45) return 2;   // Continent (16 tiles)
  if (span > 20) return 3;   // Large country
  if (span > 10) return 4;   // Country
  if (span > 5) return 5;    // Region
  if (span > 2) return 6;    // Large area
  if (span > 1) return 7;
  if (span > 0.5) return 8;
  if (span > 0.2) return 9;
  if (span > 0.1) return 10;
  return 11;  // Close zoom (capped at 11 to avoid too many tiles)
}

/**
 * Get all enabled Overture layers' features for the current viewport.
 *
 * Now uses PMTiles vector tiles instead of the non-existent bbox API.
 *
 * @param {string[]} enabledThemes - Theme keys from OVERTURE_THEMES
 * @param {number[]} wgs84Bbox - [minLon, minLat, maxLon, maxLat]
 * @param {Object} options
 * @param {string} [options.release] - PMTiles release date
 * @param {number} [options.maxTiles] - Max tiles to fetch (default 50)
 * @returns {Promise<Object>} Map of theme → FeatureCollection
 */
export async function fetchAllOvertureThemes(enabledThemes, wgs84Bbox, options = {}) {
  const { release = DEFAULT_TILES_RELEASE, maxTiles = 100 } = options;
  const results = {};

  const [minLon, minLat, maxLon, maxLat] = wgs84Bbox;
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;

  const zoom = getZoomForBbox(wgs84Bbox);
  const tiles = bboxToTiles(wgs84Bbox, zoom);
  const tileCount = (tiles.maxX - tiles.minX + 1) * (tiles.maxY - tiles.minY + 1);

  // Skip if too many tiles even at low zoom
  if (tileCount > maxTiles) {
    console.warn(`[Overture] Too many tiles (${tileCount}) for bbox at zoom ${zoom}, skipping. Try zooming in.`);
    enabledThemes.forEach(key => {
      results[key] = { type: 'FeatureCollection', features: [] };
    });
    return results;
  }

  console.log(`[Overture] Fetching ${enabledThemes.length} themes at zoom ${zoom} (${tileCount} tiles, span ${spanLon.toFixed(1)}° x ${spanLat.toFixed(1)}°)`);

  const fetches = enabledThemes.map(async (themeKey) => {
    const themeDef = OVERTURE_THEMES[themeKey];
    if (!themeDef) return;

    const actualTheme = themeDef.theme || themeKey;
    const features = [];

    let tilesLoaded = 0;
    // Fetch all tiles that cover the bbox
    for (let x = tiles.minX; x <= tiles.maxX && tilesLoaded < maxTiles; x++) {
      for (let y = tiles.minY; y <= tiles.maxY && tilesLoaded < maxTiles; y++) {
        try {
          const tileData = await fetchOvertureTile(actualTheme, zoom, x, y, release);
          // PMTiles MVT tiles have multiple layers — extract all features
          for (const layerFeatures of Object.values(tileData.layers || {})) {
            features.push(...layerFeatures);
          }
          tilesLoaded++;
        } catch (e) {
          console.warn(`[Overture] Failed to load tile ${actualTheme}/${zoom}/${x}/${y}:`, e.message);
        }
      }
    }

    console.log(`[Overture] Got ${features.length} features for ${themeKey} from ${tilesLoaded} tiles`);

    results[themeKey] = {
      type: 'FeatureCollection',
      features,
    };
  });

  await Promise.all(fetches);
  return results;
}

/**
 * Clear the feature cache (e.g., on release version change).
 */
export function clearOvertureCache() {
  featureCache.clear();
  pmtilesGeoJSONCache.clear();
  console.log('[Overture] Cache cleared');
}

// ═══════════════════════════════════════════════════════════════════
// PMTiles Vector Tile Reader — for mini-map and scene context
// ═══════════════════════════════════════════════════════════════════

/**
 * PMTiles instances cache (one per theme).
 * @type {Map<string, PMTiles>}
 */
const pmtilesInstances = new Map();

/**
 * Get or create a PMTiles instance for a theme.
 * @param {string} theme - e.g. 'base', 'buildings', 'transportation'
 * @param {string} release - e.g. '2024-12-18'
 * @returns {PMTiles}
 */
function getPMTiles(theme, release = DEFAULT_TILES_RELEASE) {
  const key = `${release}/${theme}`;
  if (!pmtilesInstances.has(key)) {
    const url = `${OVERTURE_TILES_URL}/${release}/${theme}.pmtiles`;
    console.log(`[Overture PMTiles] Opening: ${url}`);
    pmtilesInstances.set(key, new PMTiles(url));
  }
  return pmtilesInstances.get(key);
}

/**
 * Cache for decoded GeoJSON from PMTiles vector tiles.
 * @type {Map<string, Object>}
 */
const pmtilesGeoJSONCache = new Map();

/**
 * Decode an MVT (Mapbox Vector Tile) protobuf buffer into GeoJSON features.
 *
 * MVT is a compact binary format (protobuf) encoding vector geometries
 * in tile-local coordinates (0–4096). We decode the protobuf manually
 * to avoid adding a full MVT library dependency.
 *
 * Simplified decoder — handles Polygon, MultiPolygon, LineString, Point
 * geometries which is all we need for coastlines and context layers.
 *
 * @param {ArrayBuffer} buffer — raw MVT protobuf bytes
 * @param {number} tileX — tile X coordinate
 * @param {number} tileY — tile Y coordinate
 * @param {number} tileZ — tile zoom level
 * @returns {{ layers: Object<string, GeoJSON.Feature[]> }}
 */
function decodeMVT(buffer, tileX, tileY, tileZ) {
  const extent = 4096;
  const size = extent * Math.pow(2, tileZ);
  const x0 = extent * tileX;
  const y0 = extent * tileY;

  // Convert tile-local coordinates to WGS84
  function toWGS84(cx, cy) {
    const lon = ((cx + x0) / size) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (cy + y0)) / size)));
    const lat = (latRad * 180) / Math.PI;
    return [lon, lat];
  }

  // Minimal protobuf varint decoder
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  function readVarint() {
    let result = 0, shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  }

  function readSVarint() {
    const n = readVarint();
    return (n >>> 1) ^ -(n & 1);
  }

  function readBytes() {
    const len = readVarint();
    const data = bytes.subarray(pos, pos + len);
    pos += len;
    return data;
  }

  function skipField(wireType) {
    if (wireType === 0) readVarint();
    else if (wireType === 1) pos += 8;
    else if (wireType === 2) { const len = readVarint(); pos += len; }
    else if (wireType === 5) pos += 4;
  }

  const result = { layers: {} };

  // Parse top-level: repeated Layer messages (field 3)
  while (pos < bytes.length) {
    const tag = readVarint();
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (fieldNum === 3 && wireType === 2) {
      const layerBytes = readBytes();
      const layer = parseLayer(layerBytes);
      if (layer) {
        result.layers[layer.name] = layer.features;
      }
    } else {
      skipField(wireType);
    }
  }

  function parseLayer(data) {
    const savedPos = pos;
    pos = 0;
    const layerBytes = data;
    let lPos = 0;
    let name = '';
    const keys = [];
    const values = [];
    const rawFeatures = [];
    let layerExtent = 4096;

    while (lPos < layerBytes.length) {
      const tag = readVarintFrom(layerBytes, lPos);
      lPos = tag.newPos;
      const fieldNum = tag.value >>> 3;
      const wireType = tag.value & 0x7;

      if (fieldNum === 1 && wireType === 2) {
        // name
        const len = readVarintFrom(layerBytes, lPos);
        lPos = len.newPos;
        name = new TextDecoder().decode(layerBytes.subarray(lPos, lPos + len.value));
        lPos += len.value;
      } else if (fieldNum === 2 && wireType === 2) {
        // feature
        const len = readVarintFrom(layerBytes, lPos);
        lPos = len.newPos;
        rawFeatures.push(layerBytes.subarray(lPos, lPos + len.value));
        lPos += len.value;
      } else if (fieldNum === 3 && wireType === 2) {
        // key
        const len = readVarintFrom(layerBytes, lPos);
        lPos = len.newPos;
        keys.push(new TextDecoder().decode(layerBytes.subarray(lPos, lPos + len.value)));
        lPos += len.value;
      } else if (fieldNum === 4 && wireType === 2) {
        // value
        const len = readVarintFrom(layerBytes, lPos);
        lPos = len.newPos;
        values.push(parseValue(layerBytes.subarray(lPos, lPos + len.value)));
        lPos += len.value;
      } else if (fieldNum === 5 && wireType === 0) {
        // extent
        const v = readVarintFrom(layerBytes, lPos);
        lPos = v.newPos;
        layerExtent = v.value;
      } else {
        lPos = skipFieldFrom(layerBytes, lPos, wireType);
      }
    }

    const features = [];
    for (const fBytes of rawFeatures) {
      const feat = parseFeature(fBytes, keys, values, layerExtent);
      if (feat) features.push(feat);
    }

    pos = savedPos;
    return { name, features };
  }

  function parseFeature(data, keys, values, ext) {
    let fPos = 0;
    let geomType = 0;
    let geomData = null;
    const tags = [];

    while (fPos < data.length) {
      const tag = readVarintFrom(data, fPos);
      fPos = tag.newPos;
      const fieldNum = tag.value >>> 3;
      const wireType = tag.value & 0x7;

      if (fieldNum === 2 && wireType === 2) {
        // tags
        const len = readVarintFrom(data, fPos);
        fPos = len.newPos;
        let tPos = fPos;
        const tEnd = fPos + len.value;
        while (tPos < tEnd) {
          const ki = readVarintFrom(data, tPos); tPos = ki.newPos;
          const vi = readVarintFrom(data, tPos); tPos = vi.newPos;
          tags.push([ki.value, vi.value]);
        }
        fPos = tEnd;
      } else if (fieldNum === 3 && wireType === 0) {
        // type
        const v = readVarintFrom(data, fPos);
        fPos = v.newPos;
        geomType = v.value;
      } else if (fieldNum === 4 && wireType === 2) {
        // geometry
        const len = readVarintFrom(data, fPos);
        fPos = len.newPos;
        geomData = data.subarray(fPos, fPos + len.value);
        fPos += len.value;
      } else {
        fPos = skipFieldFrom(data, fPos, wireType);
      }
    }

    if (!geomData) return null;

    // Decode geometry commands
    const coords = decodeGeometry(geomData, geomType, ext);
    if (!coords) return null;

    const props = {};
    for (const [ki, vi] of tags) {
      if (ki < keys.length && vi < values.length) {
        props[keys[ki]] = values[vi];
      }
    }

    const typeNames = { 1: 'Point', 2: 'LineString', 3: 'Polygon' };
    return {
      type: 'Feature',
      geometry: coords,
      properties: props,
    };
  }

  function decodeGeometry(data, geomType, ext) {
    let gPos = 0;
    const commands = [];
    while (gPos < data.length) {
      const v = readVarintFrom(data, gPos);
      gPos = v.newPos;
      commands.push(v.value);
    }

    let cx = 0, cy = 0;
    let i = 0;
    const rings = [];
    let ring = [];

    while (i < commands.length) {
      const cmdId = commands[i] & 0x7;
      const count = commands[i] >> 3;
      i++;

      if (cmdId === 1) {
        // MoveTo
        for (let j = 0; j < count; j++) {
          const dx = (commands[i] >> 1) ^ -(commands[i] & 1); i++;
          const dy = (commands[i] >> 1) ^ -(commands[i] & 1); i++;
          cx += dx;
          cy += dy;
          if (ring.length > 0) rings.push(ring);
          ring = [toWGS84(cx * extent / ext, cy * extent / ext)];
        }
      } else if (cmdId === 2) {
        // LineTo
        for (let j = 0; j < count; j++) {
          const dx = (commands[i] >> 1) ^ -(commands[i] & 1); i++;
          const dy = (commands[i] >> 1) ^ -(commands[i] & 1); i++;
          cx += dx;
          cy += dy;
          ring.push(toWGS84(cx * extent / ext, cy * extent / ext));
        }
      } else if (cmdId === 7) {
        // ClosePath
        if (ring.length > 0) {
          ring.push(ring[0]);
          rings.push(ring);
          ring = [];
        }
      }
    }
    if (ring.length > 0) rings.push(ring);

    if (rings.length === 0) return null;

    if (geomType === 1) {
      // Point
      return rings.length === 1 && rings[0].length === 1
        ? { type: 'Point', coordinates: rings[0][0] }
        : { type: 'MultiPoint', coordinates: rings.map(r => r[0]) };
    } else if (geomType === 2) {
      // LineString
      return rings.length === 1
        ? { type: 'LineString', coordinates: rings[0] }
        : { type: 'MultiLineString', coordinates: rings };
    } else if (geomType === 3) {
      // Polygon / MultiPolygon
      // Each ring is a polygon ring; outer rings are CW, inner CCW in MVT
      return rings.length === 1
        ? { type: 'Polygon', coordinates: [rings[0]] }
        : { type: 'MultiPolygon', coordinates: rings.map(r => [r]) };
    }
    return null;
  }

  function parseValue(data) {
    let vPos = 0;
    while (vPos < data.length) {
      const tag = readVarintFrom(data, vPos);
      vPos = tag.newPos;
      const fieldNum = tag.value >>> 3;
      const wireType = tag.value & 0x7;

      if (fieldNum === 1 && wireType === 2) {
        const len = readVarintFrom(data, vPos); vPos = len.newPos;
        return new TextDecoder().decode(data.subarray(vPos, vPos + len.value));
      } else if (fieldNum === 2 && wireType === 5) {
        const dv = new DataView(data.buffer, data.byteOffset + vPos, 4);
        return dv.getFloat32(0, true);
      } else if (fieldNum === 3 && wireType === 1) {
        const dv = new DataView(data.buffer, data.byteOffset + vPos, 8);
        return dv.getFloat64(0, true);
      } else if (fieldNum === 4 && wireType === 0) {
        const v = readVarintFrom(data, vPos);
        return Number(BigInt(v.value));
      } else if (fieldNum === 5 && wireType === 0) {
        const v = readVarintFrom(data, vPos);
        return Number(v.value);
      } else if (fieldNum === 6 && wireType === 0) {
        const v = readVarintFrom(data, vPos);
        return (v.value >> 1) ^ -(v.value & 1);
      } else if (fieldNum === 7 && wireType === 0) {
        const v = readVarintFrom(data, vPos);
        return Boolean(v.value);
      } else {
        vPos = skipFieldFrom(data, vPos, wireType);
      }
    }
    return null;
  }

  function readVarintFrom(data, p) {
    let result = 0, shift = 0;
    while (p < data.length) {
      const b = data[p++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value: result, newPos: p };
      shift += 7;
    }
    return { value: result, newPos: p };
  }

  function skipFieldFrom(data, p, wireType) {
    if (wireType === 0) { const v = readVarintFrom(data, p); return v.newPos; }
    if (wireType === 1) return p + 8;
    if (wireType === 2) { const len = readVarintFrom(data, p); return len.newPos + len.value; }
    if (wireType === 5) return p + 4;
    return data.length; // unknown — skip rest
  }

  return result;
}


/**
 * Fetch Overture vector tile data for a specific tile coordinate.
 *
 * @param {string} theme - PMTiles theme name: 'base', 'buildings', 'transportation', etc.
 * @param {number} z - Zoom level
 * @param {number} x - Tile X
 * @param {number} y - Tile Y
 * @param {string} release - Tiles release date
 * @returns {Promise<Object>} Decoded MVT layers → GeoJSON features
 */
export async function fetchOvertureTile(theme, z, x, y, release = DEFAULT_TILES_RELEASE) {
  const cacheKey = `tile:${theme}/${z}/${x}/${y}`;
  if (pmtilesGeoJSONCache.has(cacheKey)) {
    console.log(`[Overture PMTiles] Cache hit: ${cacheKey}`);
    return pmtilesGeoJSONCache.get(cacheKey);
  }

  console.log(`[Overture PMTiles] Fetching ${theme}/${z}/${x}/${y} from ${OVERTURE_TILES_URL}/${release}/${theme}.pmtiles`);

  try {
    const pm = getPMTiles(theme, release);
    const tileData = await pm.getZxy(z, x, y);

    if (!tileData || !tileData.data) {
      console.log(`[Overture PMTiles] No data for ${theme}/${z}/${x}/${y} (tile may be empty)`);
      return { layers: {} };
    }

    console.log(`[Overture PMTiles] Got ${tileData.data.byteLength} bytes for ${theme}/${z}/${x}/${y}`);
    const decoded = decodeMVT(tileData.data, x, y, z);
    const featureCount = Object.values(decoded.layers || {}).reduce((sum, features) => sum + features.length, 0);
    console.log(`[Overture PMTiles] Decoded ${featureCount} features from ${theme}/${z}/${x}/${y}`);

    pmtilesGeoJSONCache.set(cacheKey, decoded);
    return decoded;
  } catch (e) {
    console.error(`[Overture PMTiles] Failed to read ${theme}/${z}/${x}/${y}:`, e);
    return { layers: {} };
  }
}


/**
 * Fetch world overview coastline polygons from Overture base theme.
 *
 * Returns land and water polygons at low zoom (0-1) — sufficient for
 * a mini-map world overview. Fetches only a few KB of tile data.
 *
 * @param {Object} options
 * @param {number} options.zoom - Zoom level for world overview (default 1)
 * @param {string} options.release - Tiles release date
 * @returns {Promise<{ land: GeoJSON.Feature[], water: GeoJSON.Feature[] }>}
 */
export async function fetchWorldCoastlines(options = {}) {
  const { zoom = 1, release = DEFAULT_TILES_RELEASE } = options;

  const cacheKey = `coastlines:z${zoom}`;
  if (pmtilesGeoJSONCache.has(cacheKey)) {
    return pmtilesGeoJSONCache.get(cacheKey);
  }

  console.log(`[Overture] Fetching world coastlines at z${zoom}...`);

  const land = [];
  const water = [];

  // At z=1 there are 4 tiles (2x2); at z=0 just 1 tile
  const numTiles = Math.pow(2, zoom);

  const fetches = [];
  for (let x = 0; x < numTiles; x++) {
    for (let y = 0; y < numTiles; y++) {
      fetches.push(
        fetchOvertureTile('base', zoom, x, y, release).then(decoded => {
          // Collect land and water features from all layer names
          for (const [layerName, features] of Object.entries(decoded.layers)) {
            for (const f of features) {
              const subtype = f.properties?.subtype || f.properties?.class || layerName;
              if (layerName === 'water' || subtype === 'ocean' || subtype === 'sea' || subtype === 'lake') {
                water.push(f);
              } else if (layerName === 'land' || subtype === 'continent' || subtype === 'island') {
                land.push(f);
              } else {
                // Other base features (infrastructure, etc.) — include as land context
                land.push(f);
              }
            }
          }
        })
      );
    }
  }

  await Promise.all(fetches);

  const result = { land, water };
  pmtilesGeoJSONCache.set(cacheKey, result);

  console.log(`[Overture] Coastlines loaded: ${land.length} land, ${water.length} water features`);
  return result;
}


/**
 * Fetch Overture context features near a scene footprint.
 *
 * Gets buildings, roads, and admin boundaries from Overture PMTiles
 * at an appropriate zoom level for the scene extent.
 *
 * @param {Object} wgs84Bounds - { minLon, minLat, maxLon, maxLat }
 * @param {Object} options
 * @param {string[]} options.themes - Themes to fetch (default: ['base', 'buildings', 'transportation'])
 * @param {string} options.release - Tiles release date
 * @returns {Promise<Object>} { theme: { layers: { layerName: Feature[] } } }
 */
export async function fetchSceneContext(wgs84Bounds, options = {}) {
  const {
    themes = ['base'],
    release = DEFAULT_TILES_RELEASE,
  } = options;

  if (!wgs84Bounds) return {};

  // Choose zoom level based on scene extent
  const spanLon = wgs84Bounds.maxLon - wgs84Bounds.minLon;
  const spanLat = wgs84Bounds.maxLat - wgs84Bounds.minLat;
  const maxSpan = Math.max(spanLon, spanLat);

  // Pick zoom: ~2° span → z6, ~0.5° → z8, ~0.1° → z10
  const zoom = Math.max(2, Math.min(10, Math.round(Math.log2(360 / maxSpan) - 1)));

  console.log(`[Overture] Fetching scene context at z${zoom} for [${wgs84Bounds.minLon.toFixed(2)}, ${wgs84Bounds.minLat.toFixed(2)}, ${wgs84Bounds.maxLon.toFixed(2)}, ${wgs84Bounds.maxLat.toFixed(2)}]`);

  // Convert bbox to tile coordinates
  const n = Math.pow(2, zoom);
  const xMin = Math.floor(((wgs84Bounds.minLon + 180) / 360) * n);
  const xMax = Math.floor(((wgs84Bounds.maxLon + 180) / 360) * n);
  const yMin = Math.floor((1 - Math.log(Math.tan(wgs84Bounds.maxLat * Math.PI / 180) + 1 / Math.cos(wgs84Bounds.maxLat * Math.PI / 180)) / Math.PI) / 2 * n);
  const yMax = Math.floor((1 - Math.log(Math.tan(wgs84Bounds.minLat * Math.PI / 180) + 1 / Math.cos(wgs84Bounds.minLat * Math.PI / 180)) / Math.PI) / 2 * n);

  const result = {};

  for (const theme of themes) {
    const allLayers = {};
    const fetches = [];

    for (let x = Math.max(0, xMin); x <= Math.min(n - 1, xMax); x++) {
      for (let y = Math.max(0, yMin); y <= Math.min(n - 1, yMax); y++) {
        fetches.push(
          fetchOvertureTile(theme, zoom, x, y, release).then(decoded => {
            for (const [layerName, features] of Object.entries(decoded.layers)) {
              if (!allLayers[layerName]) allLayers[layerName] = [];
              allLayers[layerName].push(...features);
            }
          })
        );
      }
    }

    await Promise.all(fetches);
    result[theme] = { layers: allLayers };
  }

  const totalFeatures = Object.values(result).reduce(
    (sum, r) => sum + Object.values(r.layers).reduce((s, fs) => s + fs.length, 0), 0
  );
  console.log(`[Overture] Scene context: ${totalFeatures} features across ${themes.join(', ')}`);

  return result;
}
