/**
 * DEM Loader — Copernicus GLO-30 (AWS) and FABDEM V2 (local mirror)
 *
 * Loads 1°×1° DEM tiles on demand, caches them, and provides bilinear
 * elevation sampling via sampleDEM(lat, lon).
 *
 * Sources:
 *   - glo30:     Copernicus DSM COG 30m from AWS Open Data (DSM — includes buildings/canopy)
 *   - fabdem-v2: FABDEM V2 bare-earth DEM (requires local/HTTPS mirror, env DEM_FABDEM_V2_ROOT)
 *   - auto:      Tries fabdem-v2 first, falls back to glo30 with a warning
 *
 * @module dem-loader
 */

import { fromUrl, fromArrayBuffer } from 'geotiff';

// ---------------------------------------------------------------------------
// Tile cache  —  Map<string, {data, width, height, bbox}>
// ---------------------------------------------------------------------------
const tileCache = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Floor toward negative infinity (JS Math.floor already does this). */
function tileLat(lat) { return Math.floor(lat); }
function tileLon(lon) { return Math.floor(lon); }

function nsLabel(lat) { return lat >= 0 ? 'N' : 'S'; }
function ewLabel(lon) { return lon >= 0 ? 'E' : 'W'; }

function pad2(n) { return String(Math.abs(n)).padStart(2, '0'); }
function pad3(n) { return String(Math.abs(n)).padStart(3, '0'); }

/**
 * Build the AWS URL for a Copernicus GLO-30 tile.
 * Pattern: Copernicus_DSM_COG_10_{N|S}{lat:02d}_00_{E|W}{lon:03d}_00_DEM.tif
 */
function glo30Url(lat, lon) {
  const ns = nsLabel(lat);
  const ew = ewLabel(lon);
  const sLat = pad2(Math.abs(lat));
  const sLon = pad3(Math.abs(lon));
  const name = `Copernicus_DSM_COG_10_${ns}${sLat}_00_${ew}${sLon}_00_DEM`;
  return `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
}

/**
 * Build the URL/path for a FABDEM V2 tile.
 * Pattern: {N|S}{lat:02d}{E|W}{lon:03d}_FABDEM_V2.tif
 */
function fabdemUrl(root, lat, lon) {
  const ns = nsLabel(lat);
  const ew = ewLabel(lon);
  const sLat = pad2(Math.abs(lat));
  const sLon = pad3(Math.abs(lon));
  const name = `${ns}${sLat}${ew}${sLon}_FABDEM_V2.tif`;
  // Ensure root ends with /
  const base = root.endsWith('/') ? root : root + '/';
  return `${base}${name}`;
}

/**
 * Resolve the FABDEM V2 tile root from environment or globalThis config.
 * In Node.js: process.env.DEM_FABDEM_V2_ROOT
 * In browser: globalThis.__DEM_FABDEM_V2_ROOT or import.meta.env?.VITE_DEM_FABDEM_V2_ROOT
 */
function getFabdemRoot() {
  // Node
  if (typeof process !== 'undefined' && process.env?.DEM_FABDEM_V2_ROOT) {
    return process.env.DEM_FABDEM_V2_ROOT;
  }
  // Browser global override
  if (typeof globalThis !== 'undefined' && globalThis.__DEM_FABDEM_V2_ROOT) {
    return globalThis.__DEM_FABDEM_V2_ROOT;
  }
  // Vite env
  try {
    if (import.meta.env?.VITE_DEM_FABDEM_V2_ROOT) {
      return import.meta.env.VITE_DEM_FABDEM_V2_ROOT;
    }
  } catch (_) { /* not in Vite */ }
  return null;
}

// ---------------------------------------------------------------------------
// Tile loading
// ---------------------------------------------------------------------------

/**
 * Fetch a single GeoTIFF tile and return its raster data + metadata.
 * Works with both HTTP(S) URLs and file:// URLs (via fetch → arrayBuffer).
 */
async function fetchTile(url) {
  let tiff;
  if (url.startsWith('file://')) {
    // file:// — use fetch (works in Node 18+ and some browsers)
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`DEM tile fetch failed: ${resp.status} ${url}`);
    const buf = await resp.arrayBuffer();
    tiff = await fromArrayBuffer(buf);
  } else {
    tiff = await fromUrl(url);
  }
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [data] = await image.readRasters();
  const bbox = image.getBoundingBox(); // [west, south, east, north]
  return { data: new Float32Array(data), width, height, bbox };
}

/**
 * Get a tile from cache or fetch it.
 * @param {string} source - "glo30" or "fabdem-v2"
 * @param {number} lat - tile origin latitude (integer, south edge for N tiles)
 * @param {number} lon - tile origin longitude (integer, west edge for E tiles)
 * @returns {Promise<{data: Float32Array, width: number, height: number, bbox: number[]}>}
 */
async function getTile(source, lat, lon) {
  const key = `${source}:${lat}:${lon}`;
  if (tileCache.has(key)) return tileCache.get(key);

  let url;
  if (source === 'glo30') {
    url = glo30Url(lat, lon);
  } else if (source === 'fabdem-v2') {
    const root = getFabdemRoot();
    if (!root) {
      throw new Error(
        'FABDEM V2 tile root not configured. Set DEM_FABDEM_V2_ROOT env var ' +
        '(e.g., file:///media/data/fabdem-v2/ or https://internal-mirror/fabdem-v2/). ' +
        'See docs/DEM_SOURCES.md for setup instructions.'
      );
    }
    url = fabdemUrl(root, lat, lon);
  } else {
    throw new Error(`Unknown DEM source: ${source}`);
  }

  console.log(`[DEM] Fetching ${source} tile: ${url}`);
  const tile = await fetchTile(url);
  tileCache.set(key, tile);
  return tile;
}

// ---------------------------------------------------------------------------
// Bilinear interpolation
// ---------------------------------------------------------------------------

/**
 * Bilinear interpolation of elevation at (lat, lon) within a single tile.
 */
function bilinearSample(tile, lat, lon) {
  const { data, width, height, bbox } = tile;
  const [west, south, east, north] = bbox;

  // Pixel coordinates (0,0) = top-left = (north, west)
  const xFrac = (lon - west) / (east - west) * (width - 1);
  const yFrac = (north - lat) / (north - south) * (height - 1);

  const x0 = Math.floor(xFrac);
  const y0 = Math.floor(yFrac);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const dx = xFrac - x0;
  const dy = yFrac - y0;

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  return (
    v00 * (1 - dx) * (1 - dy) +
    v10 * dx * (1 - dy) +
    v01 * (1 - dx) * dy +
    v11 * dx * dy
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load DEM data for a bounding box.
 *
 * @param {number[]} bbox - [west, south, east, north] in degrees
 * @param {Object} [options]
 * @param {string} [options.source='auto'] - 'glo30' | 'fabdem-v2' | 'auto'
 * @returns {Promise<{sampleDEM: (lat: number, lon: number) => number, bbox: number[], resolution: number, source: string, isBareEarth: boolean}>}
 */
export async function loadDEM(bbox, { source = 'auto' } = {}) {
  const [west, south, east, north] = bbox;

  // Determine effective source
  let effectiveSource = source;
  if (source === 'auto') {
    const root = getFabdemRoot();
    if (root) {
      effectiveSource = 'fabdem-v2';
    } else {
      console.warn(
        '[DEM] FABDEM V2 not configured — falling back to GLO-30 (DSM). ' +
        'DEM is not bare-earth; dihedral predictions will be biased high in urban/forested areas. ' +
        'Set DEM_FABDEM_V2_ROOT to enable bare-earth DEM.'
      );
      effectiveSource = 'glo30';
    }
  }

  // Enumerate all 1°×1° tiles needed to cover the bbox
  const latMin = tileLat(south);
  const latMax = tileLat(north);
  const lonMin = tileLon(west);
  const lonMax = tileLon(east);

  const tilePromises = [];
  for (let lat = latMin; lat <= latMax; lat++) {
    for (let lon = lonMin; lon <= lonMax; lon++) {
      tilePromises.push(getTile(effectiveSource, lat, lon).then(t => ({ lat, lon, tile: t })));
    }
  }
  const tiles = await Promise.all(tilePromises);

  // Build lookup: "lat:lon" → tile
  const tileMap = new Map();
  for (const { lat, lon, tile } of tiles) {
    tileMap.set(`${lat}:${lon}`, tile);
  }

  /**
   * Sample elevation at a point using bilinear interpolation.
   * @param {number} lat - Latitude in degrees
   * @param {number} lon - Longitude in degrees
   * @returns {number} Elevation in meters
   */
  function sampleDEM(lat, lon) {
    const tLat = tileLat(lat);
    const tLon = tileLon(lon);
    const key = `${tLat}:${tLon}`;
    const tile = tileMap.get(key);
    if (!tile) {
      throw new Error(`No DEM tile loaded for (${lat}, ${lon}) — tile ${key} not in bbox`);
    }
    return bilinearSample(tile, lat, lon);
  }

  const isBareEarth = effectiveSource === 'fabdem-v2';
  // GLO-30 is ~30m (~1 arc-second), FABDEM V2 is also ~1 arc-second
  const resolution = 1 / 3600; // degrees (~30m at equator)

  return {
    sampleDEM,
    bbox,
    resolution,
    source: effectiveSource,
    isBareEarth,
  };
}

/**
 * Clear the DEM tile cache (useful for testing or memory management).
 */
export function clearDEMCache() {
  tileCache.clear();
}

// Export internals for testing
export { glo30Url, fabdemUrl, bilinearSample, getFabdemRoot };
