/**
 * S3/HTTP Bucket Browser
 *
 * Lists objects in S3-compatible buckets using the ListObjectsV2 REST API.
 * Works with public buckets (no auth) and pre-signed URLs.
 * Supports prefix-based directory navigation and pagination via continuation tokens.
 *
 * Also supports plain HTTP directory listings (Apache/nginx autoindex)
 * as a fallback.
 */

// ─── S3 ListObjectsV2 ───────────────────────────────────────────────────

/**
 * List objects in an S3-compatible bucket.
 *
 * @param {string} bucketUrl — Bucket root URL, e.g. 'https://bucket.s3.amazonaws.com'
 *                              or 'https://s3.amazonaws.com/bucket'
 * @param {Object} [opts]
 * @param {string} [opts.prefix=''] — Directory prefix (e.g. 'L2_GCOV/')
 * @param {string} [opts.delimiter='/'] — Delimiter for directory grouping
 * @param {number} [opts.maxKeys=100] — Max results per page
 * @param {string} [opts.continuationToken] — Token for next page
 * @returns {Promise<{
 *   directories: string[],
 *   files: Array<{key: string, size: number, lastModified: string, etag: string}>,
 *   isTruncated: boolean,
 *   nextToken: string|null,
 *   prefix: string,
 *   totalKeys: number
 * }>}
 */
export async function listBucket(bucketUrl, opts = {}) {
  const {
    prefix = '',
    delimiter = '/',
    maxKeys = 100,
    continuationToken = null,
  } = opts;

  // Normalize bucket URL (strip trailing slash)
  const base = bucketUrl.replace(/\/+$/, '');

  // Detect sardine-launch server (JSON API at /api/files)
  if (base.includes('/api/files')) {
    return listSardineServer(base, prefix);
  }

  // Build query string for ListObjectsV2
  const params = new URLSearchParams();
  params.set('list-type', '2');
  if (prefix) params.set('prefix', prefix);
  if (delimiter) params.set('delimiter', delimiter);
  params.set('max-keys', String(maxKeys));
  if (continuationToken) params.set('continuation-token', continuationToken);

  const url = `${base}?${params.toString()}`;
  console.log(`[Bucket] Listing: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    // If S3 listing fails, try HTML directory listing fallback
    if (response.status === 403 || response.status === 404) {
      console.log('[Bucket] S3 listing denied, trying HTTP directory index...');
      return listHTTPDirectory(base, prefix);
    }
    throw new Error(`Bucket listing failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  // Check if we got XML (S3) or HTML (directory index)
  if (text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<ListBucket')) {
    return parseS3ListResponse(text, base, prefix);
  } else if (text.includes('<html') || text.includes('<HTML')) {
    return parseHTMLDirectoryListing(text, base, prefix);
  }

  throw new Error('Unexpected response format — not S3 XML or HTML directory listing');
}


/**
 * Parse S3 ListObjectsV2 XML response.
 */
function parseS3ListResponse(xml, baseUrl, requestedPrefix) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Check for errors
  const errorNode = doc.querySelector('Error');
  if (errorNode) {
    const code = errorNode.querySelector('Code')?.textContent || 'Unknown';
    const message = errorNode.querySelector('Message')?.textContent || '';
    throw new Error(`S3 error: ${code} — ${message}`);
  }

  const getTag = (parent, tag) => parent.querySelector(tag)?.textContent || '';

  // Directories (CommonPrefixes)
  const directories = [];
  doc.querySelectorAll('CommonPrefixes').forEach(cp => {
    const pfx = getTag(cp, 'Prefix');
    if (pfx) directories.push(pfx);
  });

  // Files (Contents)
  const files = [];
  doc.querySelectorAll('Contents').forEach(item => {
    const key = getTag(item, 'Key');
    const size = parseInt(getTag(item, 'Size') || '0');
    const lastModified = getTag(item, 'LastModified');
    const etag = getTag(item, 'ETag').replace(/"/g, '');

    // Skip the prefix itself (S3 sometimes returns the prefix as an object)
    if (key === requestedPrefix) return;
    // Skip zero-byte directory markers
    if (key.endsWith('/') && size === 0) return;

    files.push({ key, size, lastModified, etag });
  });

  const isTruncated = getTag(doc.documentElement, 'IsTruncated') === 'true';
  const nextToken = getTag(doc.documentElement, 'NextContinuationToken') || null;
  const keyCount = parseInt(getTag(doc.documentElement, 'KeyCount') || '0');

  return {
    directories,
    files,
    isTruncated,
    nextToken,
    prefix: requestedPrefix,
    totalKeys: keyCount || (directories.length + files.length),
    baseUrl,
  };
}


// ─── HTTP Directory Listing Fallback ─────────────────────────────────────

/**
 * Fetch and parse an HTTP directory listing (Apache/nginx autoindex).
 */
async function listHTTPDirectory(baseUrl, prefix) {
  const url = prefix ? `${baseUrl}/${prefix}` : baseUrl;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP directory listing failed: ${response.status}`);
  }

  const html = await response.text();
  return parseHTMLDirectoryListing(html, baseUrl, prefix);
}

/**
 * Parse HTML directory listing (Apache/nginx style).
 * Looks for <a href="..."> links.
 */
function parseHTMLDirectoryListing(html, baseUrl, prefix) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const links = doc.querySelectorAll('a[href]');

  const directories = [];
  const files = [];

  links.forEach(link => {
    const href = link.getAttribute('href');
    if (!href || href === '../' || href === '/' || href.startsWith('?') || href.startsWith('#')) return;
    // Skip absolute URLs to other domains
    if (href.startsWith('http') && !href.startsWith(baseUrl)) return;

    const name = decodeURIComponent(href);
    const fullPrefix = prefix ? `${prefix}${name}` : name;

    if (name.endsWith('/')) {
      directories.push(fullPrefix);
    } else {
      // Try to extract size from the listing text
      const text = link.parentElement?.textContent || '';
      const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B?)\s*$/i);
      let size = 0;
      if (sizeMatch) {
        size = parseFloat(sizeMatch[1]);
        const unit = (sizeMatch[2] || '').toUpperCase();
        if (unit.startsWith('K')) size *= 1024;
        else if (unit.startsWith('M')) size *= 1024 * 1024;
        else if (unit.startsWith('G')) size *= 1024 * 1024 * 1024;
        else if (unit.startsWith('T')) size *= 1024 * 1024 * 1024 * 1024;
      }
      files.push({ key: fullPrefix, size, lastModified: '', etag: '' });
    }
  });

  return {
    directories,
    files,
    isTruncated: false,
    nextToken: null,
    prefix,
    totalKeys: directories.length + files.length,
    baseUrl,
  };
}


// ─── sardine-launch Server API ───────────────────────────────────────────

/**
 * List files via the sardine-launch JSON API.
 * Server returns the same shape as our standard result, so we pass it through.
 */
async function listSardineServer(apiUrl, prefix) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);

  const url = params.toString() ? `${apiUrl}?${params}` : apiUrl;
  console.log(`[Bucket] sardine-launch listing: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    let msg = `Server error: ${response.status}`;
    try { msg = JSON.parse(body).error || msg; } catch {}
    throw new Error(msg);
  }

  const result = await response.json();

  // Server returns { directories, files, isTruncated, nextToken, prefix, totalKeys }
  // which matches our standard shape exactly.
  return { ...result, baseUrl: apiUrl };
}


// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Detect if a URL points to a sardine-launch server.
 */
function isSardineServer(url) {
  return url && url.includes('/api/files');
}

/**
 * Get the server origin from a sardine-launch API URL.
 * 'http://localhost:8050/api/files' → 'http://localhost:8050'
 */
function sardineOrigin(apiUrl) {
  const i = apiUrl.indexOf('/api/files');
  return i >= 0 ? apiUrl.substring(0, i) : apiUrl;
}

/**
 * Build the full URL for a file in a bucket.
 * For sardine-launch servers, routes through /data/ for Range-request support.
 * @param {string} baseUrl — Bucket root URL (or sardine-launch /api/files URL)
 * @param {string} key — Object key (file path within bucket)
 * @returns {string} Full URL
 */
export function buildFileUrl(baseUrl, key) {
  const base = baseUrl.replace(/\/+$/, '');
  const path = key.replace(/^\/+/, '');

  // sardine-launch server: route via /data/ for Range-request support
  if (isSardineServer(base)) {
    return `${sardineOrigin(base)}/data/${path}`;
  }

  return `${base}/${path}`;
}


/**
 * Extract display name from a key or prefix.
 * 'path/to/file.h5' → 'file.h5'
 * 'path/to/dir/' → 'dir'
 */
export function displayName(keyOrPrefix) {
  const trimmed = keyOrPrefix.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
}


/**
 * Format file size for display.
 */
export function formatSize(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


/**
 * Check if a filename looks like a NISAR HDF5 product.
 */
export function isNISARFile(key) {
  const name = displayName(key).toUpperCase();
  return name.startsWith('NISAR') && (name.endsWith('.H5') || name.endsWith('.HDF5') || name.endsWith('.HE5'));
}


/**
 * Check if a filename looks like a GeoTIFF / COG.
 */
export function isCOGFile(key) {
  const name = displayName(key).toLowerCase();
  return name.endsWith('.tif') || name.endsWith('.tiff') || name.endsWith('.geotiff');
}


// ─── NISAR Filename Parser (JPL D-102274 Rev E §3.4) ────────────────────

/** Polarization code → human-readable label. */
const POL_CODES = {
  SH: 'HH (Single-H)',
  SV: 'VV (Single-V)',
  DH: 'HH/HV (Dual-H)',
  DV: 'VV/VH (Dual-V)',
  CL: 'LH/LV (Compact-L)',
  CR: 'RH/RV (Compact-R)',
  QP: 'Quad-pol',
  NA: 'N/A',
};

/**
 * Parse a NISAR GCOV filename into its constituent fields per §3.4.
 *
 * Syntax:
 *   NISAR_IL_PT_PROD_CYL_REL_P_FRM_MODE_POLE_S_Start_End_CRID_A_C_LOC_CTR.EXT
 *
 * @param {string} filename — filename (with or without path prefix)
 * @returns {Object|null} Parsed fields, or null if not a valid NISAR filename
 */
export function parseNISARFilename(filename) {
  // Strip any directory path, keep just the basename (with extension)
  const base = filename.replace(/^.*[\\/]/, '');

  //  NISAR _ IL _ PT _ PROD _ CYL _ REL _ P _ FRM _ MODE _ POLE _ S _ Start           _ End             _ CRID   _ A _ C _ LOC _ CTR . EXT
  const re = /^NISAR_([LS])(\d)_([A-Z]{2})_([A-Z]{4})_(\d{3})_(\d{3})_([AD])_(\d{3})_(\d{4})_([A-Z]{4})_([AM])_(\d{8}T\d{6})_(\d{8}T\d{6})_([A-Z]\d{5})_([PMNF])_([FP])_([A-Z])_(\d{3})\.(.+)$/;

  const m = base.match(re);
  if (!m) return null;

  const polCode = m[10]; // 4 chars, e.g. DHDH, DHDV, SHNA
  const pol1 = polCode.substring(0, 2);
  const pol2 = polCode.substring(2, 4);

  return {
    filename:      base,
    instrument:    m[1] === 'L' ? 'L-SAR' : 'S-SAR',
    instrumentCode: m[1],
    level:         parseInt(m[2]),
    processingType: m[3],          // PR, UR, OD
    product:       m[4],           // GCOV, GSLC, GUNW ...
    cycle:         parseInt(m[5]),
    track:         parseInt(m[6]),  // relative orbit (1-173)
    direction:     m[7],           // A or D
    directionName: m[7] === 'A' ? 'Ascending' : 'Descending',
    frame:         parseInt(m[8]),
    mode:          m[9],           // bandwidth mode code (4 chars)
    polCode,
    pol1,
    pol2,
    pol1Name:      POL_CODES[pol1] || pol1,
    pol2Name:      POL_CODES[pol2] || pol2,
    source:        m[11],          // A=Acquired, M=Mixed
    startTime:     parseNISARDateTime(m[12]),
    endTime:       parseNISARDateTime(m[13]),
    startStr:      m[12],
    endStr:        m[13],
    crid:          m[14],          // Composite Release ID
    accuracy:      m[15],          // P, M, N, F
    coverage:      m[16],          // F=Full, P=Partial
    location:      m[17],          // J=JPL, N=NRSC
    counter:       parseInt(m[18]),
    extension:     m[19],
  };
}


/**
 * Parse NISAR datetime string YYYYMMDDTHHMMSS → Date.
 */
function parseNISARDateTime(s) {
  if (!s || s.length < 15) return null;
  return new Date(
    `${s.substring(0,4)}-${s.substring(4,6)}-${s.substring(6,8)}T` +
    `${s.substring(9,11)}:${s.substring(11,13)}:${s.substring(13,15)}Z`
  );
}


/**
 * Given a list of parsed NISAR filenames, extract the distinct values for each
 * filterable field.  Used to populate filter dropdowns.
 *
 * @param {Array<Object>} parsedFiles — Array of parseNISARFilename() results
 * @returns {Object} { cycles, tracks, directions, polCodes, frames, modes }
 */
export function extractFilterOptions(parsedFiles) {
  const cycles     = [...new Set(parsedFiles.map(p => p.cycle))].sort((a, b) => a - b);
  const tracks     = [...new Set(parsedFiles.map(p => p.track))].sort((a, b) => a - b);
  const directions = [...new Set(parsedFiles.map(p => p.direction))].sort();
  const polCodes   = [...new Set(parsedFiles.map(p => p.polCode))].sort();
  const frames     = [...new Set(parsedFiles.map(p => p.frame))].sort((a, b) => a - b);
  const modes      = [...new Set(parsedFiles.map(p => p.mode))].sort();
  return { cycles, tracks, directions, polCodes, frames, modes };
}


/**
 * Detect the sardine-launch server base URL.
 * Uses the current page origin when served from sardine-launch (ODS/JupyterHub proxy).
 * Falls back to relative URL so it works behind any reverse proxy.
 */
function autoDetectServerUrl() {
  // Use a relative URL so the browser resolves it through whatever proxy
  // is serving the page (JupyterHub, reverse proxy, or direct).
  // document.baseURI respects <base href="./"> from Vite's base: './' config.
  try {
    const base = new URL(document.baseURI || window.location.href);
    // Ensure trailing slash on the directory path
    const dir = base.pathname.replace(/\/?$/, '/');
    return `${base.origin}${dir}api/files`;
  } catch {
    return './api/files';
  }
}

/**
 * Predefined bucket endpoints that are commonly used with NISAR data.
 */
export const PRESET_BUCKETS = [
  {
    label: 'SARdine Server (auto-detect)',
    url: '__AUTO__',
    description: 'sardine-launch — auto-detects URL through proxy',
  },
  {
    label: 'SARdine Server (localhost:8050)',
    url: 'http://localhost:8050/api/files',
    description: 'sardine-launch — direct localhost connection',
  },
  {
    label: 'ASF DAAC (Earthdata)',
    url: 'https://nisar.asf.alaska.edu',
    description: 'Alaska Satellite Facility — requires Earthdata login',
    requiresAuth: true,
  },
];

/**
 * Resolve a preset URL — replaces __AUTO__ with the auto-detected server URL.
 */
export function resolvePresetUrl(url) {
  return url === '__AUTO__' ? autoDetectServerUrl() : url;
}
