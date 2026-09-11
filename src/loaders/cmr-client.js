/**
 * cmr-client.js — NASA CMR Granule Search client for SARdine.
 *
 * Searches CMR (https://cmr.earthdata.nasa.gov/search) for NISAR
 * GCOV and GUNW granules. CMR serves CORS headers, so this works
 * directly from the browser with no proxy needed.
 *
 * CMR API docs: https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html
 */

// ─── NISAR product short names in CMR ────────────────────────────────────────

export const NISAR_PRODUCTS = [
  {
    id: 'NISAR_L2_GCOV_BETA_V1',
    label: 'NISAR L2 GCOV (Beta)',
    description: 'Geocoded Covariance — calibrated backscatter',
    type: 'nisar',
  },
  {
    id: 'NISAR_L2_GUNW_BETA_V1',
    label: 'NISAR L2 GUNW (Beta)',
    description: 'Geocoded Unwrapped Interferogram',
    type: 'nisar-gunw',
  },
  {
    // OPERA RTC-S1 is COG-native: each granule is one Sentinel-1 IW burst at
    // 30 m, gamma-0 power, with one single-band float32 COG per polarization
    // plus a mask COG. The .h5 sibling holds orbit metadata only - it is NOT
    // the image, so this product routes to the COG path, not h5chunk.
    id: 'OPERA_L2_RTC-S1_V1',
    label: 'OPERA RTC-S1 (Sentinel-1)',
    description: 'Radiometric Terrain Corrected gamma-0 backscatter - 30 m COG bursts',
    type: 'cog',
  },
  {
    id: 'OPERA_L2_RTC-S1-STATIC_V1',
    label: 'OPERA RTC-S1 Static Layers',
    description: 'Per-burst incidence angle, mask, number of looks, RTC ANF',
    type: 'cog',
  },
];

/** CMR short_names that are OPERA RTC-S1 (COG-native, burst-based). */
export const OPERA_RTC_PRODUCTS = new Set([
  'OPERA_L2_RTC-S1_V1',
  'OPERA_L2_RTC-S1-STATIC_V1',
]);

// ─── Core search ─────────────────────────────────────────────────────────────

const CMR_SEARCH_URL = 'https://cmr.earthdata.nasa.gov/search/granules.umm_json';

/**
 * Search CMR for NISAR granules.
 *
 * @param {Object} params
 * @param {string}   params.shortName - CMR collection short_name (e.g. NISAR_L2_GCOV_BETA_V1)
 * @param {number[]} [params.bbox] - [west, south, east, north]
 * @param {string}   [params.dateStart] - ISO date string (YYYY-MM-DD)
 * @param {string}   [params.dateEnd] - ISO date string (YYYY-MM-DD)
 * @param {number}   [params.track] - NISAR track number
 * @param {number}   [params.frame] - NISAR frame number
 * @param {number}   [params.pageSize=25] - Results per page
 * @param {number}   [params.pageNum=1] - Page number (1-based)
 * @param {Function} [params.fetchFn] - Injectable fetch (for unit tests); defaults to global fetch
 * @returns {{ granules: Object[], hits: number }}
 */
export async function searchGranules(params = {}) {
  const {
    shortName,
    bbox,
    dateStart,
    dateEnd,
    track,
    frame,
    pageSize = 25,
    pageNum = 1,
    fetchFn,
  } = params;

  const qs = new URLSearchParams();
  if (shortName) qs.set('short_name', shortName);
  qs.set('provider', 'ASF');
  qs.set('sort_key', '-start_date');
  qs.set('page_size', String(pageSize));
  qs.set('page_num', String(pageNum));

  if (bbox && bbox.length === 4) {
    qs.set('bounding_box', bbox.join(','));
  }

  if (dateStart || dateEnd) {
    // Date-only values (YYYY-MM-DD) get the day's boundaries appended; full
    // ISO datetimes (anything with a 'T') pass through untouched.
    const start = dateStart ? (String(dateStart).includes('T') ? dateStart : `${dateStart}T00:00:00Z`) : '';
    const end = dateEnd ? (String(dateEnd).includes('T') ? dateEnd : `${dateEnd}T23:59:59Z`) : '';
    qs.set('temporal', `${start},${end}`);
  }

  // Track/frame via granule_ur wildcard or readable_granule_name. The two
  // product families encode track differently, so the pattern has to follow
  // the naming convention or it silently matches zero granules.
  const isOperaSearch = OPERA_RTC_PRODUCTS.has(shortName);
  if (track) {
    const trackPad = String(track).padStart(3, '0');
    qs.append('options[readable_granule_name][pattern]', 'true');
    // OPERA: ..._RTC-S1_T022-046044-IW3_... ; NISAR: ..._TTT_...
    qs.append('readable_granule_name', isOperaSearch ? `*_T${trackPad}-*` : `*_${trackPad}_*`);
  }
  if (frame && !isOperaSearch) {
    // OPERA RTC-S1 is burst-based and has no frame number; applying the NISAR
    // frame pattern would return zero hits rather than simply being ignored.
    const framePad = String(frame).padStart(3, '0');
    qs.append('options[readable_granule_name][pattern]', 'true');
    qs.append('readable_granule_name', `*_${framePad}_*`);
  }

  const url = `${CMR_SEARCH_URL}?${qs.toString()}`;
  const doFetch = fetchFn || ((...args) => fetch(...args));
  const resp = await doFetch(url, {
    headers: { 'Accept': 'application/vnd.nasa.cmr.umm_results+json' },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`CMR ${resp.status}: ${text.slice(0, 200) || resp.statusText}`);
  }

  const hits = parseInt(resp.headers.get('CMR-Hits') || '0', 10);
  const data = await resp.json();
  const items = (data.items || []).map(parseUmmGranule);

  return { granules: items, hits };
}

// ─── UMM-G granule parser ────────────────────────────────────────────────────

function parseUmmGranule(item) {
  const umm = item.umm || {};
  const meta = item.meta || {};

  // Extract granule ID
  const id = umm.GranuleUR || meta['concept-id'] || '';

  // Temporal
  const temporal = umm.TemporalExtent?.RangeDateTime || umm.TemporalExtent?.SingleDateTime;
  const datetime = temporal?.BeginningDateTime || temporal || umm.TemporalExtent?.SingleDateTime?.Date || null;

  // Spatial — extract bounding box or polygon
  const spatialExtent = umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry;
  const bbox = extractBbox(spatialExtent);
  const geometry = extractGeometry(spatialExtent);

  // Data URLs
  const relatedUrls = umm.RelatedUrls || [];
  const browseUrl = findBrowseUrl(relatedUrls);

  // OPERA RTC-S1 is COG-native and multi-asset (one float32 COG per
  // polarization plus a mask); NISAR products are single-file HDF5.
  const isOpera = id.startsWith('OPERA_L2_RTC-S1');
  const assets = isOpera ? findOperaAssets(relatedUrls) : null;
  const dataUrl = isOpera ? (assets.primaryUrl || null) : findDataUrl(relatedUrls);

  // Parse product-specific fields from the granule name
  const parsed = isOpera ? parseOperaGranuleName(id) : parseNisarGranuleName(id);

  return {
    id,
    conceptId: meta['concept-id'],
    datetime,
    bbox,
    geometry,
    dataUrl,
    browseUrl,
    ...(assets ? { assets: assets.byLayer, polarizations: assets.polarizations } : {}),
    collection: meta['collection-concept-id'],
    size: umm.DataGranule?.ArchiveAndDistributionInformation?.[0]?.SizeInBytes || null,
    ...parsed,
  };
}

/**
 * Parse NISAR granule naming convention:
 * NISAR_L2_PR_GCOV_002_109_D_063_4005_DHDH_A_20251012T182508_20251012T182531_X05010_N_P_J_001
 */
function parseNisarGranuleName(name) {
  const parts = name.split('_');
  if (parts.length < 12 || parts[0] !== 'NISAR') return {};

  // Find product type (GCOV, GUNW, etc.)
  const productType = parts[3]; // GCOV, GUNW, etc.
  const track = parts[5] ? parseInt(parts[5], 10) : null;
  const direction = parts[6]; // D=descending, A=ascending
  const frame = parts[7] ? parseInt(parts[7], 10) : null;
  const polarization = parts[9]; // DHDH, DVDV, etc.

  return { productType, track, direction, frame, polarization };
}

/**
 * Parse the OPERA RTC-S1 granule naming convention:
 *   OPERA_L2_RTC-S1_T022-046044-IW3_20260911T051622Z_20260911T124056Z_S1C_30_v1.0
 *   OPERA_L2_RTC-S1-STATIC_T004-006637-IW3_20140403_S1A_30_v1.0
 *
 * RTC-S1 carries both an acquisition and a generation timestamp while the
 * STATIC variant carries only a date, so the trailing fields sit one slot
 * earlier. Anchor on the tail rather than a fixed index so both shapes parse.
 */
export function parseOperaGranuleName(name) {
  const parts = String(name).split('_');
  if (parts.length < 8 || parts[0] !== 'OPERA') return {};

  const burstId = parts[3] || null;              // T022-046044-IW3
  const burstMatch = /^T(\d+)-(\d+)-(IW[1-3]|EW[1-5]|S[1-6])$/.exec(burstId || '');
  if (!burstMatch) return {};

  const tail = parts.slice(-3);                  // [sensor, spacing, version]

  return {
    productType: parts[2] || null,               // RTC-S1 | RTC-S1-STATIC
    burstId,
    track: parseInt(burstMatch[1], 10),
    // OPERA bursts have no NISAR-style frame number; the burst index is the
    // closest analogue and is what the ASF burst map keys on.
    burstIndex: burstMatch[2],
    subswath: burstMatch[3],
    sensor: tail[0] || null,                     // S1A / S1B / S1C
    pixelSpacing: tail[1] ? parseInt(tail[1], 10) : null,
    productVersion: tail[2] || null,
  };
}

/** Polarization layer suffixes an RTC-S1 granule may carry. */
const OPERA_POL_LAYERS = ['VV', 'VH', 'HH', 'HV'];

/**
 * Map an OPERA granule's RelatedUrls to its COG layers.
 *
 * Returns `{ byLayer, polarizations, primaryUrl }`. The `.h5` sibling is
 * deliberately excluded from primaryUrl - for RTC-S1 it holds orbit metadata
 * only, so loading it as the image would show nothing.
 */
export function findOperaAssets(urls) {
  const byLayer = {};
  for (const u of urls || []) {
    if (u.Type !== 'GET DATA') continue;
    const href = u.URL || '';
    if (!href.startsWith('http') || !href.endsWith('.tif')) continue;
    // ..._v1.0_VV.tif -> VV ; ..._v1.0_number_of_looks.tif -> number_of_looks
    const m = /_v[\d.]+_(.+)\.tif$/.exec(href);
    const layer = m ? m[1] : href.split('/').pop().replace(/\.tif$/, '');
    if (!(layer in byLayer)) byLayer[layer] = href;
  }

  const polarizations = OPERA_POL_LAYERS.filter(p => p in byLayer);
  // Co-pol first - the better default single-band view; fall back to whatever
  // layer exists so STATIC granules (no polarizations) still resolve.
  const primaryUrl = byLayer[polarizations[0]] || Object.values(byLayer)[0] || null;

  return { byLayer, polarizations, primaryUrl };
}

function extractBbox(spatial) {
  if (!spatial) return null;
  const boxes = spatial.BoundingRectangles;
  if (boxes && boxes.length > 0) {
    const b = boxes[0];
    return [b.WestBoundingCoordinate, b.SouthBoundingCoordinate,
            b.EastBoundingCoordinate, b.NorthBoundingCoordinate];
  }

  // OPERA (and some NISAR) granules carry only a GPolygon footprint. Derive
  // the bbox from it so bbox consumers - "zoom to results", coverage ranking -
  // see every granule rather than silently skipping the polygon-only ones.
  const boundary = spatial.GPolygons?.[0]?.Boundary?.Points;
  if (boundary && boundary.length > 0) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const pt of boundary) {
      if (typeof pt.Longitude !== 'number' || typeof pt.Latitude !== 'number') continue;
      west = Math.min(west, pt.Longitude);
      east = Math.max(east, pt.Longitude);
      south = Math.min(south, pt.Latitude);
      north = Math.max(north, pt.Latitude);
    }
    if (Number.isFinite(west) && Number.isFinite(south)) return [west, south, east, north];
  }

  return null;
}

function extractGeometry(spatial) {
  if (!spatial) return null;

  // Prefer polygon for footprint display
  const polygons = spatial.GPolygons;
  if (polygons && polygons.length > 0) {
    const boundary = polygons[0].Boundary?.Points;
    if (boundary && boundary.length > 0) {
      const coords = boundary.map(p => [p.Longitude, p.Latitude]);
      // Close ring if needed
      if (coords.length > 0 &&
          (coords[0][0] !== coords[coords.length - 1][0] ||
           coords[0][1] !== coords[coords.length - 1][1])) {
        coords.push(coords[0]);
      }
      return { type: 'Polygon', coordinates: [coords] };
    }
  }

  // Fall back to bbox as polygon
  const boxes = spatial.BoundingRectangles;
  if (boxes && boxes.length > 0) {
    const b = boxes[0];
    return {
      type: 'Polygon',
      coordinates: [[
        [b.WestBoundingCoordinate, b.SouthBoundingCoordinate],
        [b.EastBoundingCoordinate, b.SouthBoundingCoordinate],
        [b.EastBoundingCoordinate, b.NorthBoundingCoordinate],
        [b.WestBoundingCoordinate, b.NorthBoundingCoordinate],
        [b.WestBoundingCoordinate, b.SouthBoundingCoordinate],
      ]],
    };
  }

  return null;
}

function findDataUrl(urls) {
  // Priority: GET DATA > USE SERVICE API > direct link
  for (const u of urls) {
    if (u.Type === 'GET DATA' && u.URL?.endsWith('.h5')) return u.URL;
  }
  for (const u of urls) {
    if (u.Type === 'GET DATA') return u.URL;
  }
  return null;
}

function findBrowseUrl(urls) {
  for (const u of urls) {
    if (u.Type === 'GET RELATED VISUALIZATION') return u.URL;
  }
  return null;
}
