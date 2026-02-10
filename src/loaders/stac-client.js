/**
 * stac-client.js — STAC API client for SARdine.
 *
 * Searches STAC APIs (CMR-STAC, ASF, etc.) and resolves items to
 * SARdine-loadable URLs. No dependencies — pure fetch.
 *
 * STAC spec: https://github.com/radiantearth/stac-spec
 */

// ─── Preset STAC endpoints ───────────────────────────────────────────────────

export const STAC_ENDPOINTS = [
  {
    id: 'cmr-stac',
    label: 'NASA CMR-STAC',
    url: 'https://cmr.earthdata.nasa.gov/stac',
    description: 'NASA Common Metadata Repository — NISAR, Sentinel-1, ALOS, UAVSAR',
    requiresAuth: true,
    authType: 'earthdata',
  },
  {
    id: 'asf',
    label: 'ASF DAAC',
    url: 'https://stac.asf.alaska.edu',
    description: 'Alaska Satellite Facility — NISAR primary DAAC',
    requiresAuth: true,
    authType: 'earthdata',
  },
  {
    id: 'planetary-computer',
    label: 'Planetary Computer',
    url: 'https://planetarycomputer.microsoft.com/api/stac/v1',
    description: 'Microsoft — Sentinel-1 RTC, global SAR archive',
    requiresAuth: false,
  },
  {
    id: 'earth-search',
    label: 'Earth Search (Element 84)',
    url: 'https://earth-search.aws.element84.com/v1',
    description: 'Sentinel-1 GRD on AWS',
    requiresAuth: false,
  },
];

// ─── Core API calls ──────────────────────────────────────────────────────────

/**
 * Fetch the root catalog from a STAC API endpoint.
 * Returns { id, title, description, conformsTo, links }.
 */
export async function fetchCatalog(apiUrl, { token } = {}) {
  const resp = await stacFetch(apiUrl, { token });
  return resp;
}

/**
 * List collections available at a STAC API endpoint.
 * Returns array of { id, title, description, extent, links, ... }.
 */
export async function listCollections(apiUrl, { token } = {}) {
  const resp = await stacFetch(`${apiUrl}/collections`, { token });
  return resp.collections || [];
}

/**
 * Get a single collection by ID.
 */
export async function getCollection(apiUrl, collectionId, { token } = {}) {
  return stacFetch(`${apiUrl}/collections/${encodeURIComponent(collectionId)}`, { token });
}

/**
 * Search for STAC items.
 *
 * @param {string} apiUrl - STAC API root URL
 * @param {Object} params - Search parameters
 * @param {string[]} [params.collections] - Collection IDs to search
 * @param {number[]} [params.bbox] - [west, south, east, north]
 * @param {string}   [params.datetime] - RFC 3339 interval ("2025-01-01/2025-06-01" or single)
 * @param {number}   [params.limit=20] - Max items per page
 * @param {Object}   [params.query] - CQL2 property filters (e.g. {"sar:polarizations": {"contains": ["HH"]}})
 * @param {string}   [params.nextToken] - Pagination token from previous search
 * @param {string}   [params.token] - Auth bearer token
 * @returns {{ items: Object[], nextToken: string|null, matched: number|null }}
 */
export async function searchItems(apiUrl, params = {}) {
  const { collections, bbox, datetime, limit = 20, query, nextToken, token } = params;

  // Build POST body (STAC API uses POST /search for complex queries)
  const body = {};
  if (collections?.length) body.collections = collections;
  if (bbox) body.bbox = bbox;
  if (datetime) body.datetime = datetime;
  if (limit) body.limit = limit;
  if (query) body.query = query;

  // Handle pagination
  if (nextToken) {
    body.token = nextToken;
  }

  const searchUrl = `${apiUrl}/search`;

  // Try POST first (STAC API best practice), fall back to GET
  let resp;
  try {
    resp = await stacFetch(searchUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      token,
    });
  } catch (e) {
    // Some APIs (CMR-STAC) may not support POST; fall back to GET
    if (e.message?.includes('405') || e.message?.includes('Method')) {
      const qs = buildSearchQuery(body);
      resp = await stacFetch(`${searchUrl}?${qs}`, { token });
    } else {
      throw e;
    }
  }

  // Parse response
  const features = resp.features || [];
  const matched = resp.numberMatched ?? resp.context?.matched ?? null;

  // Find "next" link for pagination
  let next = null;
  const nextLink = resp.links?.find(l => l.rel === 'next');
  if (nextLink) {
    // Some APIs use token in link body, others use href with query params
    if (nextLink.body?.token) {
      next = nextLink.body.token;
    } else if (nextLink.href) {
      const url = new URL(nextLink.href);
      next = url.searchParams.get('token') || url.searchParams.get('page') || nextLink.href;
    }
  }

  return {
    items: features,
    nextToken: next,
    matched,
  };
}

// ─── Asset resolution ────────────────────────────────────────────────────────

/**
 * Known asset keys for SAR data, in priority order.
 * We look for HDF5 first (NISAR GCOV), then COG.
 */
const SAR_ASSET_KEYS = [
  // NISAR HDF5
  'data', 'hdf5', 'h5', 'gcov', 'nisar',
  // COG
  'visual', 'image', 'cog', 'data', 'B0',
  // Sentinel-1 specific
  'vv', 'vh', 'hh', 'hv',
  // Generic
  'default',
];

/**
 * Resolve the best loadable asset URL from a STAC Item.
 *
 * @param {Object} item - STAC Item (GeoJSON Feature with assets)
 * @returns {{ url: string, type: 'nisar'|'cog', key: string, title: string }|null}
 */
export function resolveAsset(item) {
  if (!item?.assets) return null;

  const assets = item.assets;

  // First pass: look for known keys in priority order
  for (const key of SAR_ASSET_KEYS) {
    if (assets[key]) {
      const asset = assets[key];
      const type = detectAssetType(asset, key);
      if (type) {
        return {
          url: asset.href,
          type,
          key,
          title: asset.title || key,
        };
      }
    }
  }

  // Second pass: scan all assets by media type
  for (const [key, asset] of Object.entries(assets)) {
    const type = detectAssetType(asset, key);
    if (type) {
      return {
        url: asset.href,
        type,
        key,
        title: asset.title || key,
      };
    }
  }

  return null;
}

/**
 * List all loadable assets from a STAC Item.
 * Useful when an item has multiple bands/polarizations as separate assets.
 */
export function listAssets(item) {
  if (!item?.assets) return [];

  const results = [];
  for (const [key, asset] of Object.entries(item.assets)) {
    const type = detectAssetType(asset, key);
    if (type) {
      results.push({
        url: asset.href,
        type,
        key,
        title: asset.title || key,
        roles: asset.roles || [],
      });
    }
  }
  return results;
}

/**
 * Detect whether an asset is a NISAR HDF5 or a COG.
 */
function detectAssetType(asset, key) {
  const href = asset.href || '';
  const mediaType = asset.type || '';

  // HDF5
  if (
    mediaType.includes('hdf5') || mediaType.includes('hdf') ||
    href.match(/\.(h5|hdf5|he5|nc)(\?|$)/i) ||
    key.toLowerCase().includes('hdf5') || key.toLowerCase().includes('gcov')
  ) {
    return 'nisar';
  }

  // COG / GeoTIFF
  if (
    mediaType.includes('geotiff') || mediaType.includes('tiff') ||
    mediaType === 'image/tiff; application=geotiff; profile=cloud-optimized' ||
    href.match(/\.(tif|tiff|geotiff)(\?|$)/i)
  ) {
    return 'cog';
  }

  // Data role with no clear type — try href extension
  if (asset.roles?.includes('data')) {
    if (href.match(/\.(h5|hdf5|he5)(\?|$)/i)) return 'nisar';
    if (href.match(/\.(tif|tiff)(\?|$)/i)) return 'cog';
  }

  return null;
}

// ─── Item → SARdine scene conversion ─────────────────────────────────────────

/**
 * Convert a STAC Item to the format expected by handleRemoteFileSelect().
 *
 * @param {Object} item - STAC Item
 * @returns {{ url, name, type, size, properties }|null}
 */
export function itemToScene(item) {
  const resolved = resolveAsset(item);
  if (!resolved) return null;

  const props = item.properties || {};

  return {
    url: resolved.url,
    name: item.id || props.title || 'Unknown',
    type: resolved.type,
    size: 0, // STAC items don't always carry file size
    // Pass through useful STAC properties
    datetime: props.datetime,
    polarizations: props['sar:polarizations'],
    frequencyBand: props['sar:frequency_band'],
    instrumentMode: props['sar:instrument_mode'],
    orbitDirection: props['sat:orbit_state'],
    platform: props.platform,
    constellation: props.constellation,
    assetKey: resolved.key,
  };
}

/**
 * Extract SAR-specific filter options from a set of STAC items.
 * Useful for building filter dropdowns after a search.
 */
export function extractItemFilters(items) {
  const polarizations = new Set();
  const platforms = new Set();
  const orbitDirections = new Set();
  const frequencyBands = new Set();

  for (const item of items) {
    const p = item.properties || {};
    if (p['sar:polarizations']) {
      for (const pol of p['sar:polarizations']) polarizations.add(pol);
    }
    if (p.platform) platforms.add(p.platform);
    if (p['sat:orbit_state']) orbitDirections.add(p['sat:orbit_state']);
    if (p['sar:frequency_band']) frequencyBands.add(p['sar:frequency_band']);
  }

  return {
    polarizations: [...polarizations].sort(),
    platforms: [...platforms].sort(),
    orbitDirections: [...orbitDirections].sort(),
    frequencyBands: [...frequencyBands].sort(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch wrapper with auth and error handling.
 */
async function stacFetch(url, { method = 'GET', body, token } = {}) {
  const headers = {
    'Accept': 'application/geo+json, application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = body;

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`STAC API ${resp.status}: ${text.slice(0, 200) || resp.statusText}`);
  }
  return resp.json();
}

/**
 * Build GET query string from search body (fallback for APIs that don't support POST).
 */
function buildSearchQuery(body) {
  const params = new URLSearchParams();
  if (body.collections) params.set('collections', body.collections.join(','));
  if (body.bbox) params.set('bbox', body.bbox.join(','));
  if (body.datetime) params.set('datetime', body.datetime);
  if (body.limit) params.set('limit', String(body.limit));
  if (body.token) params.set('token', body.token);
  return params.toString();
}

/**
 * Format a STAC datetime range for display.
 */
export function formatDatetime(datetime) {
  if (!datetime) return '';
  if (datetime.includes('/')) {
    const [start, end] = datetime.split('/');
    return `${formatSingle(start)} – ${formatSingle(end)}`;
  }
  return formatSingle(datetime);
}

function formatSingle(dt) {
  if (!dt || dt === '..') return '..';
  try {
    const d = new Date(dt);
    return d.toISOString().slice(0, 10);
  } catch {
    return dt;
  }
}

/**
 * Compute the spatial extent [west, south, east, north] of a STAC Item's geometry.
 */
export function itemBbox(item) {
  if (item.bbox) return item.bbox.slice(0, 4);
  // Fall back to geometry bounds
  if (item.geometry?.coordinates) {
    return geojsonBbox(item.geometry);
  }
  return null;
}

function geojsonBbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const coords = flattenCoords(geometry.coordinates);
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function flattenCoords(coords) {
  if (typeof coords[0] === 'number') return [coords];
  return coords.flatMap(flattenCoords);
}
