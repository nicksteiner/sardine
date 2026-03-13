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
];

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
    const start = dateStart ? `${dateStart}T00:00:00Z` : '';
    const end = dateEnd ? `${dateEnd}T23:59:59Z` : '';
    qs.set('temporal', `${start},${end}`);
  }

  // Track/frame via granule_ur wildcard or readable_granule_name
  if (track) {
    // NISAR granule naming: ..._TTT_... where TTT is zero-padded track
    const trackPad = String(track).padStart(3, '0');
    qs.append('options[readable_granule_name][pattern]', 'true');
    qs.append('readable_granule_name', `*_${trackPad}_*`);
  }
  if (frame) {
    const framePad = String(frame).padStart(3, '0');
    qs.append('options[readable_granule_name][pattern]', 'true');
    qs.append('readable_granule_name', `*_${framePad}_*`);
  }

  const url = `${CMR_SEARCH_URL}?${qs.toString()}`;
  const resp = await fetch(url, {
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
  const dataUrl = findDataUrl(relatedUrls);
  const browseUrl = findBrowseUrl(relatedUrls);

  // Parse NISAR-specific fields from granule name
  const parsed = parseNisarGranuleName(id);

  return {
    id,
    conceptId: meta['concept-id'],
    datetime,
    bbox,
    geometry,
    dataUrl,
    browseUrl,
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

function extractBbox(spatial) {
  if (!spatial) return null;
  const boxes = spatial.BoundingRectangles;
  if (boxes && boxes.length > 0) {
    const b = boxes[0];
    return [b.WestBoundingCoordinate, b.SouthBoundingCoordinate,
            b.EastBoundingCoordinate, b.NorthBoundingCoordinate];
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
