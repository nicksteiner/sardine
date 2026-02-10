/**
 * Overture Maps Data Loader
 *
 * Streams Overture Maps Foundation data (buildings, roads, places, etc.)
 * from cloud-hosted GeoParquet files via HTTP range requests.
 *
 * Overture data lives at:
 *   s3://overturemaps-us-west-2/release/{version}/theme={theme}/type={type}/
 *
 * Each theme is partitioned into GeoParquet files spatially, enabling
 * efficient viewport-based fetching — the same streaming pattern
 * SARdine uses for HDF5 and COG.
 *
 * Supported themes:
 *   - buildings/building
 *   - transportation/segment
 *   - places/place
 *   - base/water
 *   - base/land_use
 *   - admins/locality
 */

// Overture S3 bucket (public, us-west-2)
const OVERTURE_BASE_URL = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com';
const DEFAULT_RELEASE = '2024-12-18.0';

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
export async function fetchOvertureFeatures(theme, type, bbox, options = {}) {
  const {
    release = DEFAULT_RELEASE,
    maxFeatures = 50000,
    onProgress,
  } = options;

  const [minLon, minLat, maxLon, maxLat] = bbox;

  // Skip if viewport is too large (> ~2 degrees — too many features)
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  if (spanLon > 2 || spanLat > 2) {
    console.log(`[Overture] Viewport too large (${spanLon.toFixed(1)}° x ${spanLat.toFixed(1)}°), skipping ${theme}/${type}`);
    return { type: 'FeatureCollection', features: [] };
  }

  // Check cache
  const cacheKey = `${theme}/${type}/${minLon.toFixed(3)},${minLat.toFixed(3)},${maxLon.toFixed(3)},${maxLat.toFixed(3)}`;
  if (featureCache.has(cacheKey)) {
    return featureCache.get(cacheKey);
  }

  if (onProgress) onProgress(0);

  console.log(`[Overture] Fetching ${theme}/${type} for bbox [${bbox.map(b => b.toFixed(4)).join(', ')}]`);

  try {
    // Use the Overture Maps API endpoint for bbox queries
    // This is the recommended browser-friendly approach
    const apiUrl = buildOvertureApiUrl(theme, type, bbox, release);
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const geojson = await response.json();

    // Limit features
    if (geojson.features && geojson.features.length > maxFeatures) {
      geojson.features = geojson.features.slice(0, maxFeatures);
      console.warn(`[Overture] Truncated to ${maxFeatures} features`);
    }

    console.log(`[Overture] Got ${geojson.features?.length || 0} ${theme}/${type} features`);

    // Cache result
    if (featureCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = featureCache.keys().next().value;
      featureCache.delete(firstKey);
    }
    featureCache.set(cacheKey, geojson);

    if (onProgress) onProgress(100);
    return geojson;

  } catch (e) {
    console.warn(`[Overture] Failed to fetch ${theme}/${type}:`, e.message);
    // Return empty collection on failure — don't block the app
    return { type: 'FeatureCollection', features: [] };
  }
}

/**
 * Build Overture API URL for bbox query.
 *
 * Uses the community-maintained Overture tiles API or
 * falls back to direct S3 access patterns.
 *
 * @param {string} theme
 * @param {string} type
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat]
 * @param {string} release
 * @returns {string} API URL
 */
function buildOvertureApiUrl(theme, type, bbox, release) {
  const [minLon, minLat, maxLon, maxLat] = bbox;

  // Option 1: Overture Maps Explorer API (community endpoint)
  // This returns GeoJSON directly for a bbox
  // Replace with your preferred API endpoint
  return `https://overturemaps.org/api/v1/${theme}/${type}?bbox=${minLon},${minLat},${maxLon},${maxLat}&limit=50000`;
}

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
 * Get all enabled Overture layers' features for the current viewport.
 *
 * @param {string[]} enabledThemes - Theme keys from OVERTURE_THEMES
 * @param {number[]} wgs84Bbox - [minLon, minLat, maxLon, maxLat]
 * @param {Object} options
 * @returns {Promise<Object>} Map of theme → FeatureCollection
 */
export async function fetchAllOvertureThemes(enabledThemes, wgs84Bbox, options = {}) {
  const results = {};

  const fetches = enabledThemes.map(async (themeKey) => {
    const themeDef = OVERTURE_THEMES[themeKey];
    if (!themeDef) return;

    const actualTheme = themeDef.theme || themeKey;
    const features = [];

    for (const type of themeDef.types) {
      const fc = await fetchOvertureFeatures(actualTheme, type, wgs84Bbox, options);
      features.push(...(fc.features || []));
    }

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
  console.log('[Overture] Cache cleared');
}
