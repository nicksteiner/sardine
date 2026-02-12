/**
 * NISAR GCOV HDF5 Loader
 *
 * Loads NISAR Level-2 Geocoded Polarimetric Covariance (GCOV) HDF5 files
 * using two approaches:
 *
 * 1. STREAMING (h5chunk): For large files (>100MB)
 *    - Reads only metadata page (~8MB) at file start
 *    - Builds chunk index from HDF5 B-tree
 *    - Fetches data chunks on-demand via File.slice()
 *    - Works like Cloud Optimized GeoTIFF streaming
 *
 * 2. FULL LOAD (h5wasm): For smaller files (<100MB)
 *    - Loads entire file into memory
 *    - Uses h5wasm for full HDF5 feature support
 *
 * NISAR files use "paged aggregation" which consolidates metadata at the
 * front of the file, enabling efficient streaming access.
 *
 * Product path hierarchy (JPL D-102274 Rev E, §3.5, §5):
 *
 *   /science/{band}/identification/         — file-level metadata
 *   /science/{band}/GCOV/grids/frequency{A|B}/  — imagery + grid metadata
 *   /science/{band}/GCOV/metadata/          — calibration, processing, radar grid
 *
 * where {band} ∈ {LSAR, SSAR} (never both in one granule).
 */

import h5wasm from 'h5wasm';
import { openH5ChunkFile, openH5ChunkUrl } from './h5chunk.js';
import { loadMetadataCube } from '../utils/metadata-cube.js';

// ─── NISAR GCOV Product Specification (JPL D-102274 Rev E) ──────────────
// All paths below are derived from Tables 5-1 through 5-8 of the spec.

/** SAR bands — NISAR carries L-band (LSAR) and S-band (SSAR). */
const SAR_BANDS = ['LSAR', 'SSAR'];

/**
 * Diagonal (real-valued) covariance terms — backscatter power.
 * Type: Float32, Shape: (length, width), units: gamma0 (linear).
 */
const DIAGONAL_TERMS = ['HHHH', 'HVHV', 'VHVH', 'VVVV', 'RHRH', 'RVRV'];

/**
 * Off-diagonal (complex-valued) covariance terms.
 * Type: CFloat32, Shape: (length, width).
 * Present only when isFullCovariance = true.
 */
const OFFDIAG_TERMS = ['HHHV', 'HHVH', 'HHVV', 'HVVH', 'HVVV', 'VHVV', 'RHRV'];

/** All possible covariance term names. */
const ALL_COV_TERMS = [...DIAGONAL_TERMS, ...OFFDIAG_TERMS];

/** Set for O(1) membership checks. */
const COV_TERM_SET = new Set(ALL_COV_TERMS);

/**
 * Build spec-compliant HDF5 paths for a given band and product type.
 *
 * @param {string} band  — 'LSAR' or 'SSAR'
 * @param {string} productType — 'GCOV' (future: 'GSLC', 'GUNW')
 * @returns {Object} Path templates for product groups
 */
function nisarPaths(band = 'LSAR', productType = 'GCOV') {
  const base = `/science/${band}/${productType}`;
  return {
    base,
    identification:  `/science/${band}/identification`,
    grids:           `${base}/grids`,
    freqGrid: (f) => `${base}/grids/frequency${f}`,
    dataset:  (f, term) => `${base}/grids/frequency${f}/${term}`,
    metadata:        `${base}/metadata`,
    processing:      `${base}/metadata/processingInformation/parameters`,
    calibration: (f) => `${base}/metadata/calibrationInformation/frequency${f}`,
    radarGrid:       `${base}/metadata/radarGrid`,
    sourceData:      `${base}/metadata/sourceData`,
    // Per-frequency grid metadata datasets
    listOfPolarizations: (f) => `${base}/grids/frequency${f}/listOfPolarizations`,
    listOfCovarianceTerms: (f) => `${base}/grids/frequency${f}/listOfCovarianceTerms`,
    numberOfLooks:   (f) => `${base}/grids/frequency${f}/numberOfLooks`,
    mask:            (f) => `${base}/grids/frequency${f}/mask`,
    projection:      (f) => `${base}/grids/frequency${f}/projection`,
    xCoordinates:    (f) => `${base}/grids/frequency${f}/xCoordinates`,
    yCoordinates:    (f) => `${base}/grids/frequency${f}/yCoordinates`,
    xCoordinateSpacing: (f) => `${base}/grids/frequency${f}/xCoordinateSpacing`,
    yCoordinateSpacing: (f) => `${base}/grids/frequency${f}/yCoordinateSpacing`,
    rtcFactor:       (f) => `${base}/grids/frequency${f}/rtcGammaToSigmaFactor`,
    // Identification-level metadata (Table 5-2, JPL D-102274 Rev E §5.2)
    listOfFrequencies: `/science/${band}/identification/listOfFrequencies`,
    productType:     `/science/${band}/identification/productType`,
    absoluteOrbitNumber: `/science/${band}/identification/absoluteOrbitNumber`,
    trackNumber:     `/science/${band}/identification/trackNumber`,
    frameNumber:     `/science/${band}/identification/frameNumber`,
    missionId:       `/science/${band}/identification/missionId`,
    processingCenter: `/science/${band}/identification/processingCenter`,
    granuleId:       `/science/${band}/identification/granuleId`,
    productDoi:      `/science/${band}/identification/productDoi`,
    productVersion:  `/science/${band}/identification/productVersion`,
    productSpecificationVersion: `/science/${band}/identification/productSpecificationVersion`,
    lookDirection:   `/science/${band}/identification/lookDirection`,
    orbitPassDirection: `/science/${band}/identification/orbitPassDirection`,
    zeroDopplerStartTime: `/science/${band}/identification/zeroDopplerStartTime`,
    zeroDopplerEndTime: `/science/${band}/identification/zeroDopplerEndTime`,
    processingDateTime: `/science/${band}/identification/processingDateTime`,
    radarBand:       `/science/${band}/identification/radarBand`,
    platformName:    `/science/${band}/identification/platformName`,
    instrumentName:  `/science/${band}/identification/instrumentName`,
    processingType:  `/science/${band}/identification/processingType`,
    productLevel:    `/science/${band}/identification/productLevel`,
    isGeocoded:      `/science/${band}/identification/isGeocoded`,
    isUrgentObservation: `/science/${band}/identification/isUrgentObservation`,
    isDithered:      `/science/${band}/identification/isDithered`,
    isMixedMode:     `/science/${band}/identification/isMixedMode`,
    isFullFrame:     `/science/${band}/identification/isFullFrame`,
    isJointObservation: `/science/${band}/identification/isJointObservation`,
    compositeReleaseId: `/science/${band}/identification/compositeReleaseId`,
    boundingPolygon: `/science/${band}/identification/boundingPolygon`,
    diagnosticModeFlag: `/science/${band}/identification/diagnosticModeFlag`,
    // Processing flags (§5.6)
    isFullCovariance: `${base}/metadata/processingInformation/parameters/isFullCovariance`,
    polSymApplied: `${base}/metadata/processingInformation/parameters/polarimetricSymmetrizationApplied`,
    rtcApplied:    `${base}/metadata/processingInformation/parameters/radiometricTerrainCorrectionApplied`,
    rfiApplied:    `${base}/metadata/processingInformation/parameters/rfiCorrectionApplied`,
    ionoRangeApplied: `${base}/metadata/processingInformation/parameters/rangeIonosphericGeolocationCorrectionApplied`,
    ionoAzApplied: `${base}/metadata/processingInformation/parameters/azimuthIonosphericGeolocationCorrectionApplied`,
    dryTropoApplied: `${base}/metadata/processingInformation/parameters/dryTroposphericGeolocationCorrectionApplied`,
    wetTropoApplied: `${base}/metadata/processingInformation/parameters/wetTroposphericGeolocationCorrectionApplied`,
    backscatterConvention: `${base}/metadata/processingInformation/parameters/outputBackscatterExpressionConvention`,
    softwareVersion: `${base}/metadata/processingInformation/algorithms/softwareVersion`,
    // Orbit metadata (§5.7)
    orbitType:       `${base}/metadata/orbit/orbitType`,
  };
}

// Legacy aliases — keep for backward compat during transition
const GCOV_BASE = '/science/LSAR/GCOV';
const GRID_PATH = `${GCOV_BASE}/grids`;
const METADATA_PATH = `${GCOV_BASE}/metadata`;
const PROCESSING_PARAMS = `${METADATA_PATH}/processingInformation/parameters`;
const POLARIZATIONS = ALL_COV_TERMS;

/**
 * Read product identification metadata from HDF5 file.
 *
 * Reads from /science/{band}/identification/ (§5.1, Table 5-1) and
 * processing flags from /science/{band}/GCOV/metadata/ (§5.2).
 *
 * Works with both h5chunk (streaming) and h5wasm readers.
 *
 * @param {Object} reader — h5chunk streamReader or h5wasm File object
 * @param {Object} paths — from nisarPaths()
 * @param {string} freq — active frequency letter ('A' or 'B')
 * @param {'streaming'|'h5wasm'} mode — which reader type
 * @returns {Object} identification metadata
 */
async function readProductIdentification(reader, paths, freq = 'A', mode = 'streaming') {
  const id = {};

  console.log(`[NISAR Loader] Reading product identification (mode=${mode})...`);

  if (mode === 'streaming') {
    // h5chunk streaming reader — use same proven pattern as detectFrequencies.
    // Read a small dataset by path, returning { data, shape, dtype } or null.
    const readDs = async (path) => {
      try {
        const dsId = reader.findDatasetByPath(path);
        if (dsId == null) return null;
        return await reader.readSmallDataset(dsId);
      } catch (e) {
        console.warn(`[NISAR Loader] Failed to read ${path}:`, e.message);
        return null;
      }
    };

    // Extract string value from readSmallDataset result
    const asString = (result) => {
      if (!result || !result.data) return undefined;
      const d = result.data;
      // readSmallDataset returns { data: ['string'], dtype: 'string' } for string datasets
      if (d.length > 0 && typeof d[0] === 'string') return d[0].trim() || undefined;
      // For non-string dtypes, try decoding raw bytes as text
      if (d.length > 0 && typeof d[0] === 'number') {
        try {
          const bytes = new Uint8Array(d.buffer ? d.buffer : d);
          let str = '';
          for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0) break;
            str += String.fromCharCode(bytes[i]);
          }
          return str.trim() || undefined;
        } catch { return undefined; }
      }
      return undefined;
    };

    // Extract numeric value
    const asNumber = (result) => {
      if (!result || !result.data || result.data.length === 0) return undefined;
      const v = result.data[0];
      if (typeof v === 'string') { const n = Number(v); return isNaN(n) ? undefined : n; }
      if (typeof v === 'number' && !isNaN(v)) return v;
      return undefined;
    };

    // Extract boolean value
    const asBool = (result) => {
      if (!result || !result.data || result.data.length === 0) return undefined;
      const v = result.data[0];
      if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'boolean') return v;
      return undefined;
    };

    // ── Identification string fields (§5.2, Table 5-2) ──
    const stringFieldPaths = [
      ['productType', paths.productType],
      ['lookDirection', paths.lookDirection],
      ['orbitPassDirection', paths.orbitPassDirection],
      ['zeroDopplerStartTime', paths.zeroDopplerStartTime],
      ['zeroDopplerEndTime', paths.zeroDopplerEndTime],
      ['missionId', paths.missionId],
      ['processingCenter', paths.processingCenter],
      ['granuleId', paths.granuleId],
      ['productDoi', paths.productDoi],
      ['productVersion', paths.productVersion],
      ['productSpecificationVersion', paths.productSpecificationVersion],
      ['processingDateTime', paths.processingDateTime],
      ['radarBand', paths.radarBand],
      ['platformName', paths.platformName],
      ['instrumentName', paths.instrumentName],
      ['processingType', paths.processingType],
      ['productLevel', paths.productLevel],
      ['compositeReleaseId', paths.compositeReleaseId],
      ['boundingPolygon', paths.boundingPolygon],
    ];
    for (const [key, path] of stringFieldPaths) {
      const v = asString(await readDs(path));
      if (v) id[key] = v;
    }

    // ── Identification numeric fields ──
    const numericFieldPaths = [
      ['absoluteOrbitNumber', paths.absoluteOrbitNumber],
      ['trackNumber', paths.trackNumber],
      ['frameNumber', paths.frameNumber],
      ['diagnosticModeFlag', paths.diagnosticModeFlag],
    ];
    for (const [key, path] of numericFieldPaths) {
      const v = asNumber(await readDs(path));
      if (v != null) id[key] = v;
    }

    // ── Identification boolean fields ──
    const boolFieldPaths = [
      ['isGeocoded', paths.isGeocoded],
      ['isUrgentObservation', paths.isUrgentObservation],
      ['isDithered', paths.isDithered],
      ['isMixedMode', paths.isMixedMode],
      ['isFullFrame', paths.isFullFrame],
      ['isJointObservation', paths.isJointObservation],
    ];
    for (const [key, path] of boolFieldPaths) {
      const v = asBool(await readDs(path));
      if (v != null) id[key] = v;
    }

    // ── Processing parameters (§5.6) ──
    const procStringPaths = [
      ['softwareVersion', paths.softwareVersion],
      ['backscatterConvention', paths.backscatterConvention],
      ['orbitType', paths.orbitType],
    ];
    for (const [key, path] of procStringPaths) {
      const v = asString(await readDs(path));
      if (v) id[key] = v;
    }

    const procBoolPaths = [
      ['isFullCovariance', paths.isFullCovariance],
      ['polSymApplied', paths.polSymApplied],
      ['rtcApplied', paths.rtcApplied],
      ['rfiApplied', paths.rfiApplied],
      ['ionoRangeApplied', paths.ionoRangeApplied],
      ['ionoAzApplied', paths.ionoAzApplied],
      ['dryTropoApplied', paths.dryTropoApplied],
      ['wetTropoApplied', paths.wetTropoApplied],
    ];
    for (const [key, path] of procBoolPaths) {
      const v = asBool(await readDs(path));
      if (v != null) id[key] = v;
    }

    // ── Fallback: try h5chunk attributes on the identification group ──
    // Some HDF5 files store metadata as group attributes rather than datasets.
    if (Object.keys(id).length === 0) {
      console.warn('[NISAR Loader] No identification datasets found, trying group attributes...');
      const attrs = reader.getAttributes?.(paths.identification);
      if (attrs) {
        console.log('[NISAR Loader] Found identification group attributes:', Object.keys(attrs));
        for (const [key, val] of Object.entries(attrs)) {
          if (val != null && val !== '') id[key] = val;
        }
      }
    }

  } else {
    // h5wasm reader — use safeGet-like pattern
    const tryRead = (path) => {
      try {
        const ds = reader.get(path);
        if (!ds) return undefined;
        const val = ds.value;
        return Array.isArray(val) ? val[0] : val;
      } catch { return undefined; }
    };

    // String fields
    const stringKeys = [
      ['productType', paths.productType],
      ['lookDirection', paths.lookDirection],
      ['orbitPassDirection', paths.orbitPassDirection],
      ['zeroDopplerStartTime', paths.zeroDopplerStartTime],
      ['zeroDopplerEndTime', paths.zeroDopplerEndTime],
      ['missionId', paths.missionId],
      ['processingCenter', paths.processingCenter],
      ['granuleId', paths.granuleId],
      ['productDoi', paths.productDoi],
      ['productVersion', paths.productVersion],
      ['productSpecificationVersion', paths.productSpecificationVersion],
      ['processingDateTime', paths.processingDateTime],
      ['radarBand', paths.radarBand],
      ['platformName', paths.platformName],
      ['instrumentName', paths.instrumentName],
      ['processingType', paths.processingType],
      ['productLevel', paths.productLevel],
      ['compositeReleaseId', paths.compositeReleaseId],
      ['boundingPolygon', paths.boundingPolygon],
      ['softwareVersion', paths.softwareVersion],
      ['backscatterConvention', paths.backscatterConvention],
      ['orbitType', paths.orbitType],
    ];
    for (const [key, path] of stringKeys) {
      const v = tryRead(path);
      if (v != null) id[key] = v.toString().trim();
    }

    // Numeric fields
    const numKeys = [
      ['absoluteOrbitNumber', paths.absoluteOrbitNumber],
      ['trackNumber', paths.trackNumber],
      ['frameNumber', paths.frameNumber],
      ['diagnosticModeFlag', paths.diagnosticModeFlag],
    ];
    for (const [key, path] of numKeys) {
      const v = tryRead(path);
      if (v != null) id[key] = Number(v);
    }

    // Boolean fields (identification + processing)
    const boolKeys = [
      ['isGeocoded', paths.isGeocoded],
      ['isUrgentObservation', paths.isUrgentObservation],
      ['isDithered', paths.isDithered],
      ['isMixedMode', paths.isMixedMode],
      ['isFullFrame', paths.isFullFrame],
      ['isJointObservation', paths.isJointObservation],
      ['isFullCovariance', paths.isFullCovariance],
      ['polSymApplied', paths.polSymApplied],
      ['rtcApplied', paths.rtcApplied],
      ['rfiApplied', paths.rfiApplied],
      ['ionoRangeApplied', paths.ionoRangeApplied],
      ['ionoAzApplied', paths.ionoAzApplied],
      ['dryTropoApplied', paths.dryTropoApplied],
      ['wetTropoApplied', paths.wetTropoApplied],
    ];
    for (const [key, path] of boolKeys) {
      const v = tryRead(path);
      if (v != null) {
        id[key] = typeof v === 'string' ? v.trim().toLowerCase() === 'true' : Boolean(v);
      }
    }
  }

  // Clean undefined/null/empty values
  for (const k of Object.keys(id)) {
    if (id[k] === undefined || id[k] === null || id[k] === '') delete id[k];
  }

  const count = Object.keys(id).length;
  console.log(`[NISAR Loader] Product identification: ${count} fields`, count > 0 ? id : '(empty — datasets may not be in h5chunk catalog)');
  return id;
}

// h5wasm module singleton
let h5wasmModule = null;

/**
 * Initialize h5wasm module (loads WASM, cached for reuse)
 */
async function initH5wasm() {
  if (!h5wasmModule) {
    console.log('[NISAR Loader] Initializing h5wasm...');
    await h5wasm.ready;
    h5wasmModule = h5wasm;
    console.log('[NISAR Loader] h5wasm ready');
  }
  return h5wasmModule;
}

/**
 * Read a portion of a file
 * @param {File} file - Local file
 * @param {number} offset - Start byte offset
 * @param {number} length - Number of bytes to read
 * @returns {Promise<ArrayBuffer>}
 */
async function readFileRange(file, offset, length) {
  const slice = file.slice(offset, offset + length);
  return slice.arrayBuffer();
}

/**
 * Open HDF5 file by loading it into memory
 * @param {File} file - Local file from input[type="file"]
 * @returns {Promise<{h5file: h5wasm.File, file: File, fullLoaded: boolean, loadedSize: number}>}
 */
async function openHDF5File(file) {
  const H5 = await initH5wasm();

  console.log(`[NISAR Loader] Opening HDF5: ${file.name}`);
  console.log(`[NISAR Loader] File size: ${(file.size / 1e9).toFixed(2)} GB`);

  // Check file size - warn for very large files
  const MAX_RECOMMENDED_SIZE = 500 * 1024 * 1024; // 500MB
  if (file.size > MAX_RECOMMENDED_SIZE) {
    console.warn(`[NISAR Loader] Large file (${(file.size / 1e9).toFixed(2)} GB) - this may use significant memory`);
  }

  // Load the entire file - h5wasm requires complete files
  console.log('[NISAR Loader] Loading file into memory...');
  const startTime = performance.now();

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (e) {
    throw new Error(`Failed to read file into memory: ${e.message}. File may be too large for browser.`);
  }

  const loadTime = performance.now() - startTime;
  console.log(`[NISAR Loader] File loaded in ${(loadTime / 1000).toFixed(1)}s`);

  try {
    // Create h5wasm File directly from buffer
    // h5wasm handles the virtual filesystem internally
    const h5file = new H5.File(arrayBuffer, file.name);

    // Test if we can access the root group
    const root = h5file.get('/');
    if (!root) {
      throw new Error('Failed to access root group');
    }

    console.log('[NISAR Loader] HDF5 file opened successfully');

    return {
      h5file,
      file,
      fullLoaded: true,
      loadedSize: file.size,
    };
  } catch (e) {
    throw new Error(`Failed to open HDF5 file: ${e.message}`);
  }
}

/**
 * Open HDF5 file - wrapper that handles errors gracefully
 * @param {File} file - Local file from input[type="file"]
 * @returns {Promise<{h5file: h5wasm.File, file: File, fullLoaded: boolean, loadedSize: number}>}
 */
async function openHDF5Chunked(file) {
  // Note: Chunked/partial loading is not supported by h5wasm
  // The file must be loaded entirely into memory
  return openHDF5File(file);
}

/**
 * Safely get an HDF5 dataset or group
 */
function safeGet(h5file, path) {
  try {
    return h5file.get(path);
  } catch (e) {
    return null;
  }
}

/**
 * Safely get an attribute value from an HDF5 object
 */
function safeGetAttr(obj, attrName) {
  try {
    if (obj && obj.attrs && obj.attrs[attrName]) {
      return obj.attrs[attrName].value;
    }
  } catch (e) {
    // Attribute doesn't exist
  }
  return undefined;
}

/**
 * Get dataset layout info (for chunked reading)
 */
function getDatasetLayout(dataset) {
  try {
    return {
      shape: dataset.shape,
      dtype: dataset.dtype,
      chunks: dataset.chunks, // Chunk dimensions if chunked storage
      filters: dataset.filters,
      // h5wasm doesn't expose raw offset, but we can get chunk info
    };
  } catch (e) {
    return null;
  }
}

/**
 * Detect which SAR band (LSAR or SSAR) is present in the HDF5 file.
 *
 * NISAR products never contain both bands in one granule (§3.3).
 * This checks dataset paths discovered by h5chunk for '/science/LSAR/' or
 * '/science/SSAR/' prefixes. Falls back to 'LSAR' (L-band, primary mission).
 *
 * @param {Array} h5Datasets — from streamReader.getDatasets()
 * @returns {string} 'LSAR' or 'SSAR'
 */
function detectBand(h5Datasets) {
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    if (ds.path.includes('/SSAR/')) return 'SSAR';
    if (ds.path.includes('/LSAR/')) return 'LSAR';
  }
  return 'LSAR'; // default: L-band
}

/**
 * Detect which frequencies (A, B, or both) are present.
 *
 * Per spec §5.2, `/science/{band}/identification/listOfFrequencies` is a
 * string array of available frequency designators. We try to read that first;
 * if unavailable, we infer from dataset paths.
 *
 * @param {Object} streamReader — h5chunk reader
 * @param {Array} h5Datasets — from streamReader.getDatasets()
 * @param {Object} paths — from nisarPaths()
 * @returns {string[]} e.g. ['A'], ['A', 'B']
 */
async function detectFrequencies(streamReader, h5Datasets, paths) {
  // Strategy 1: read listOfFrequencies metadata dataset
  const dsId = streamReader.findDatasetByPath(paths.listOfFrequencies);
  if (dsId) {
    const result = await streamReader.readSmallDataset(dsId);
    if (result && result.data && result.data.length > 0) {
      const freqs = result.data.filter(f => f === 'A' || f === 'B');
      if (freqs.length > 0) {
        console.log(`[NISAR Loader] Frequencies from metadata: [${freqs.join(', ')}]`);
        return freqs;
      }
    }
  }

  // Strategy 2: infer from dataset paths
  const freqs = new Set();
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    const m = ds.path.match(/frequency([AB])/);
    if (m) freqs.add(m[1]);
  }

  if (freqs.size > 0) {
    const result = Array.from(freqs).sort();
    console.log(`[NISAR Loader] Frequencies from paths: [${result.join(', ')}]`);
    return result;
  }

  return ['A']; // default
}

/**
 * Detect which covariance terms are present for a given frequency.
 *
 * Per spec §5.3, `listOfCovarianceTerms` and `listOfPolarizations` at
 * `/science/{band}/GCOV/grids/frequency{f}/` enumerate the available terms.
 * We try those first; if unavailable, we scan dataset paths.
 *
 * @param {Object} streamReader
 * @param {Array} h5Datasets
 * @param {Object} paths — from nisarPaths()
 * @param {string} freq — 'A' or 'B'
 * @returns {string[]} e.g. ['HHHH', 'HVHV', 'VHVH', 'VVVV']
 */
async function detectCovarianceTerms(streamReader, h5Datasets, paths, freq) {
  // Strategy 1: listOfCovarianceTerms (covers both diagonal + off-diagonal)
  let dsId = streamReader.findDatasetByPath(paths.listOfCovarianceTerms(freq));
  if (dsId) {
    const result = await streamReader.readSmallDataset(dsId);
    if (result && result.data && result.data.length > 0) {
      const terms = result.data.filter(t => COV_TERM_SET.has(t));
      if (terms.length > 0) {
        console.log(`[NISAR Loader] Covariance terms (freq ${freq}) from metadata: [${terms.join(', ')}]`);
        return terms;
      }
    }
  }

  // Strategy 2: listOfPolarizations (subset — only diagonal terms HH, HV, VH, VV)
  dsId = streamReader.findDatasetByPath(paths.listOfPolarizations(freq));
  if (dsId) {
    const result = await streamReader.readSmallDataset(dsId);
    if (result && result.data && result.data.length > 0) {
      // listOfPolarizations contains e.g. ['HH', 'HV', 'VH', 'VV']
      // Map to diagonal covariance terms: HH → HHHH, HV → HVHV, etc.
      const terms = result.data
        .map(p => p.trim())
        .filter(p => p.length === 2)
        .map(p => `${p}${p}`); // HH → HHHH
      if (terms.length > 0) {
        console.log(`[NISAR Loader] Polarizations (freq ${freq}) from metadata: [${terms.join(', ')}]`);
        return terms;
      }
    }
  }

  // Strategy 3: scan dataset paths for known term names
  const freqPrefix = paths.freqGrid(freq);
  const found = [];
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    if (!ds.path.startsWith(freqPrefix)) continue;
    const tail = ds.path.slice(freqPrefix.length + 1); // +1 for '/'
    if (COV_TERM_SET.has(tail)) {
      found.push(tail);
    }
  }
  if (found.length > 0) {
    console.log(`[NISAR Loader] Covariance terms (freq ${freq}) from paths: [${found.join(', ')}]`);
    return found;
  }

  // Strategy 4: look at dataset shapes — 2D Float32 datasets under this frequency
  // whose names match known patterns
  const shapeCandidates = h5Datasets.filter(ds =>
    ds.shape?.length === 2 && ds.dtype === 'float32'
  );
  if (shapeCandidates.length >= 4) {
    console.log(`[NISAR Loader] Falling back to shape-based detection (${shapeCandidates.length} 2D float32 datasets)`);
    return DIAGONAL_TERMS.slice(0, 4); // conservative default
  }

  return ['HHHH', 'HVHV', 'VHVH', 'VVVV']; // last-resort default
}

/**
 * List available datasets in a NISAR GCOV file
 * Uses streaming for large files, full load for small files.
 *
 * Reads product structure from spec-defined metadata paths:
 *   - listOfFrequencies → which frequencies exist
 *   - listOfCovarianceTerms / listOfPolarizations → which terms per frequency
 *
 * @param {File} file - HDF5 file
 * @returns {Promise<Array<{frequency: string, polarization: string, band: string}>>}
 */
export async function listNISARDatasets(file) {
  console.log('[NISAR Loader] Listing available datasets...');
  console.log(`[NISAR Loader] File size: ${(file.size / 1e6).toFixed(1)} MB`);

  // For large files, we MUST use streaming - h5wasm will crash
  const MAX_FULL_LOAD_SIZE = 500 * 1024 * 1024; // 500MB
  if (file.size > MAX_FULL_LOAD_SIZE) {
    console.log('[NISAR Loader] Large file - using streaming mode');

    try {
      // Use lazy tree-walking for fast, efficient metadata loading
      const streamReader = await openH5ChunkFile(file);
      const h5Datasets = streamReader.getDatasets();

      console.log(`[h5chunk] Found ${h5Datasets.length} datasets`);
      h5Datasets.forEach(d => {
        console.log(`[h5chunk]   - ${d.path || d.id}: ${d.shape?.join('x')} ${d.dtype}, ${d.numChunks} chunks`);
      });

      // Detect product structure from spec paths
      const band = detectBand(h5Datasets);
      const paths = nisarPaths(band, 'GCOV');
      const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);

      const datasets = [];
      for (const freq of frequencies) {
        const terms = await detectCovarianceTerms(streamReader, h5Datasets, paths, freq);
        for (const term of terms) {
          datasets.push({ frequency: freq, polarization: term, band });
        }
      }

      console.log(`[NISAR Loader] Detected ${datasets.length} datasets (${band}, freq ${frequencies.join('+')})`);
      return datasets;

    } catch (e) {
      console.error('[NISAR Loader] Streaming mode failed:', e);
      throw new Error(`File too large for browser (${(file.size / 1e9).toFixed(2)} GB). ` +
        `Streaming mode failed: ${e.message}. ` +
        `Consider using a smaller file (<500MB) or converting to Cloud Optimized GeoTIFF.`);
    }
  }

  // Small files: use h5wasm
  const { h5file, loadedSize } = await openHDF5Chunked(file);
  console.log(`[NISAR Loader] File opened with ${(loadedSize / 1e6).toFixed(1)} MB loaded`);

  // Detect band
  let band = 'LSAR';
  if (safeGet(h5file, '/science/SSAR')) band = 'SSAR';

  const paths = nisarPaths(band, 'GCOV');
  const datasets = [];

  try {
    // Read listOfFrequencies if available
    let frequencies = ['A', 'B']; // check both
    const freqDs = safeGet(h5file, paths.listOfFrequencies);
    if (freqDs) {
      try {
        const val = freqDs.value;
        if (val && val.length > 0) {
          frequencies = Array.isArray(val) ? val : [val];
        }
      } catch (e) { /* use default */ }
    }

    for (const freq of frequencies) {
      const freqPath = paths.freqGrid(freq);
      const freqGroup = safeGet(h5file, freqPath);

      if (freqGroup) {
        // Try to read listOfCovarianceTerms first
        let terms = null;
        const termsDs = safeGet(h5file, paths.listOfCovarianceTerms(freq));
        if (termsDs) {
          try {
            const val = termsDs.value;
            if (val && val.length > 0) {
              terms = Array.isArray(val) ? val : [val];
            }
          } catch (e) { /* fall through */ }
        }

        // Fall back to scanning for known polarization datasets
        if (!terms) {
          terms = ALL_COV_TERMS;
        }

        for (const term of terms) {
          const datasetPath = `${freqPath}/${term}`;
          const dataset = safeGet(h5file, datasetPath);

          if (dataset && dataset.shape && dataset.shape.length === 2) {
            datasets.push({ frequency: freq, polarization: term, band });
            console.log(`[NISAR Loader] Found dataset: frequency${freq}/${term}`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[NISAR Loader] Error listing datasets:', e);
  }

  console.log(`[NISAR Loader] Found ${datasets.length} datasets`);
  return datasets;
}

/**
 * Extract geospatial metadata from NISAR GCOV file
 */
/**
 * Extract geospatial metadata from NISAR GCOV file.
 *
 * Per spec §5.3, projection and coordinates live directly under the
 * frequency grid group:
 *   .../grids/frequency{f}/projection   (UInt32 scalar, EPSG + attrs)
 *   .../grids/frequency{f}/xCoordinates (Float64 1D, meters in projection)
 *   .../grids/frequency{f}/yCoordinates (Float64 1D, meters in projection)
 *   .../grids/frequency{f}/xCoordinateSpacing (Float64 scalar, meters)
 *   .../grids/frequency{f}/yCoordinateSpacing (Float64 scalar, meters)
 *
 * @param {h5wasm.File} h5file
 * @param {string} frequency — 'A' or 'B'
 * @param {string} [band='LSAR'] — 'LSAR' or 'SSAR'
 */
async function extractMetadata(h5file, frequency, band = 'LSAR') {
  console.log(`[NISAR Loader] Extracting metadata (${band}, freq ${frequency})...`);

  const paths = nisarPaths(band, 'GCOV');

  // ── 1. Projection (spec §5.3, Table 5-3) ──
  // Primary location per spec: grids/frequency{f}/projection
  let projDataset = safeGet(h5file, paths.projection(frequency));

  // Fallback: try the other frequency
  if (!projDataset) {
    const otherFreq = frequency === 'A' ? 'B' : 'A';
    projDataset = safeGet(h5file, paths.projection(otherFreq));
  }

  // Last resort fallbacks (legacy/non-standard files)
  if (!projDataset) {
    projDataset = safeGet(h5file, `${paths.processing}/projection`);
  }
  if (!projDataset) {
    projDataset = safeGet(h5file, `${paths.radarGrid}/projection`);
  }

  let epsgCode = null;
  let utmZone = null;

  if (projDataset) {
    // Try reading the projection dataset value (UInt32 scalar = EPSG code)
    try {
      const projVal = projDataset.value;
      if (typeof projVal === 'number' && projVal > 1000) {
        epsgCode = projVal;
      }
    } catch (e) { /* attribute fallback below */ }

    // Also check attributes (some files store EPSG as attribute)
    const attrEpsg = safeGetAttr(projDataset, 'epsg_code');
    if (!epsgCode && attrEpsg > 1000) epsgCode = attrEpsg;

    // Parse spatial_ref WKT for EPSG code
    if (!epsgCode) {
      const spatialRef = safeGetAttr(projDataset, 'spatial_ref');
      if (spatialRef) {
        const wktEpsg = parseEpsgFromWkt(String(spatialRef));
        if (wktEpsg) epsgCode = wktEpsg;
      }
    }

    utmZone = safeGetAttr(projDataset, 'utm_zone_number');
    console.log(`[NISAR Loader] Projection: EPSG:${epsgCode}, UTM Zone: ${utmZone}`);
  }

  // ── 2. Coordinate arrays (spec §5.3, Table 5-3) ──
  // Primary: grids/frequency{f}/xCoordinates, yCoordinates
  let xCoordsDataset = safeGet(h5file, paths.xCoordinates(frequency));
  let yCoordsDataset = safeGet(h5file, paths.yCoordinates(frequency));

  // Fallback: other frequency
  if (!xCoordsDataset) {
    const otherFreq = frequency === 'A' ? 'B' : 'A';
    xCoordsDataset = safeGet(h5file, paths.xCoordinates(otherFreq));
    yCoordsDataset = safeGet(h5file, paths.yCoordinates(otherFreq));
  }

  // Legacy fallbacks
  if (!xCoordsDataset) {
    xCoordsDataset = safeGet(h5file, `${paths.processing}/xCoordinates`);
    yCoordsDataset = safeGet(h5file, `${paths.processing}/yCoordinates`);
  }
  if (!xCoordsDataset) {
    xCoordsDataset = safeGet(h5file, `${paths.radarGrid}/xCoordinates`);
    yCoordsDataset = safeGet(h5file, `${paths.radarGrid}/yCoordinates`);
  }

  let xCoords = null, yCoords = null;
  let width, height;
  let bounds;

  if (xCoordsDataset && yCoordsDataset) {
    xCoords = xCoordsDataset.value;
    yCoords = yCoordsDataset.value;

    width = xCoords.length;
    height = yCoords.length;

    // Calculate bounds from coordinate arrays
    const minX = Math.min(xCoords[0], xCoords[xCoords.length - 1]);
    const maxX = Math.max(xCoords[0], xCoords[xCoords.length - 1]);
    const minY = Math.min(yCoords[0], yCoords[yCoords.length - 1]);
    const maxY = Math.max(yCoords[0], yCoords[yCoords.length - 1]);

    bounds = [minX, minY, maxX, maxY];
    console.log(`[NISAR Loader] Bounds from coordinates: [${bounds.join(', ')}]`);
  } else {
    // Get dimensions from a dataset — try spec-standard diagonal terms
    const freqGridPath = paths.freqGrid(frequency);
    const sampleDataset =
      safeGet(h5file, `${freqGridPath}/HHHH`) ||
      safeGet(h5file, `${freqGridPath}/VVVV`) ||
      safeGet(h5file, `${freqGridPath}/RHRH`) ||
      safeGet(h5file, `${freqGridPath}/RVRV`);

    if (sampleDataset && sampleDataset.shape) {
      height = sampleDataset.shape[0];
      width = sampleDataset.shape[1];
      console.log(`[NISAR Loader] Dimensions from dataset: ${width}x${height}`);
    } else {
      throw new Error('Could not determine image dimensions');
    }

    // Try coordinate spacing to compute bounds (spec §5.3)
    const xSpacingDs = safeGet(h5file, paths.xCoordinateSpacing(frequency));
    const ySpacingDs = safeGet(h5file, paths.yCoordinateSpacing(frequency));

    if (xSpacingDs && ySpacingDs) {
      const dx = xSpacingDs.value;
      const dy = ySpacingDs.value; // negative for north-up
      // Without origin coordinates, use pixel-coordinate bounds
      bounds = [0, 0, width * Math.abs(dx), height * Math.abs(dy)];
      console.log(`[NISAR Loader] Bounds from spacing: [${bounds.join(', ')}]`);
    } else {
      // Use dummy bounds - this shouldn't happen with valid GCOV files
      console.warn('[NISAR Loader] Could not find coordinate or spacing info');
      bounds = [0, 0, width, height];
    }
  }

  // Finalize EPSG: infer from UTM zone + bounds if not yet determined
  if (!epsgCode && utmZone && bounds) {
    epsgCode = inferUtmEpsg(utmZone, bounds);
    console.log(`[NISAR Loader] EPSG inferred from utm_zone=${utmZone}: ${epsgCode}`);
  }
  if (!epsgCode) {
    epsgCode = 4326;
    if (bounds[0] >= 100000 && bounds[2] <= 900000) {
      console.warn(`[NISAR Loader] Coordinates appear UTM but no CRS detected!`);
    }
    console.warn(`[NISAR Loader] No projection found, using fallback: EPSG:${epsgCode}`);
  }

  // Calculate pixel size
  const pixelSizeX = (bounds[2] - bounds[0]) / (width - 1 || 1);
  const pixelSizeY = (bounds[3] - bounds[1]) / (height - 1 || 1);

  return {
    bounds,
    crs: `EPSG:${epsgCode}`,
    width,
    height,
    xCoords,
    yCoords,
    utmZone,
    pixelSizeX,
    pixelSizeY,
  };
}

/**
 * Extract EPSG code from a WKT CRS string (spatial_ref attribute).
 * Handles both WKT1 (AUTHORITY["EPSG","32718"]) and WKT2 (ID["EPSG",32718]) formats.
 * @param {string} wkt
 * @returns {number|null}
 */
function parseEpsgFromWkt(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  // WKT1: AUTHORITY["EPSG","32718"]
  const wkt1 = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/i);
  if (wkt1) return parseInt(wkt1[1]);
  // WKT2: ID["EPSG",32718]
  const wkt2 = wkt.match(/ID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]/i);
  if (wkt2) return parseInt(wkt2[1]);
  return null;
}

/**
 * Infer UTM EPSG code from UTM zone number and coordinate bounds.
 * @param {number} zone — UTM zone (1-60)
 * @param {number[]} bounds — [minX, minY, maxX, maxY] in meters
 * @returns {number} EPSG code (326xx for north, 327xx for south)
 */
function inferUtmEpsg(zone, bounds) {
  // Southern hemisphere: northing < ~5,500,000 with false northing 10M → actual northing > 5M
  // In practice: southern hemisphere has northing values > 1,100,000 and < 10,000,000
  // Northern hemisphere: northing < 9,400,000 (typically < 5,000,000)
  const maxY = bounds[3];
  const isSouth = maxY > 5500000; // southern hemisphere UTM uses 10M false northing
  return isSouth ? 32700 + zone : 32600 + zone;
}

/**
 * Parse WKT POLYGON to bounds [minX, minY, maxX, maxY]
 */
function parseBoundingBoxWKT(wkt) {
  // WKT format: POLYGON ((x1 y1, x2 y2, x3 y3, x4 y4, x1 y1))
  const match = wkt.match(/POLYGON\s*\(\(([^)]+)\)\)/i);
  if (!match) {
    console.warn('[NISAR Loader] Could not parse WKT:', wkt);
    return [0, 0, 1, 1];
  }

  const coords = match[1].split(',').map(pair => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return { x, y };
  });

  const xs = coords.map(c => c.x);
  const ys = coords.map(c => c.y);

  return [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
}

/**
 * Get statistics from dataset attributes
 */
function getDatasetStats(dataset) {
  return {
    min_value: safeGetAttr(dataset, 'min_value'),
    max_value: safeGetAttr(dataset, 'max_value'),
    mean_value: safeGetAttr(dataset, 'mean_value'),
    sample_stddev: safeGetAttr(dataset, 'sample_stddev'),
  };
}

/**
 * Resample source data to a fixed tile size.
 *
 * Two modes controlled by `multiLook`:
 *   false → nearest-neighbour (fast preview, raw speckle)
 *   true  → box-filter area average (spatial multi-looking, suppresses
 *           speckle by ~1/√N where N = source pixels per output pixel)
 *
 * All averaging is done in LINEAR POWER space.  The dB transform is
 * applied later in createSARTexture, which is the correct order —
 * mean(log(x)) ≠ log(mean(x)).
 *
 * When upsampling (src smaller than dst) always uses bilinear
 * interpolation since there's no averaging to do.
 */
function resampleToTileSize(srcData, srcWidth, srcHeight, tileSize, fillValue, multiLook = false) {
  const dstData = new Float32Array(tileSize * tileSize);

  const scaleX = srcWidth / tileSize;
  const scaleY = srcHeight / tileSize;

  // If upsampling or 1:1, use bilinear (same for both modes)
  if (scaleX <= 1 && scaleY <= 1) {
    for (let dstY = 0; dstY < tileSize; dstY++) {
      for (let dstX = 0; dstX < tileSize; dstX++) {
        const srcX = dstX * scaleX;
        const srcY = dstY * scaleY;
        const x0 = Math.floor(srcX);
        const y0 = Math.floor(srcY);
        const x1 = Math.min(x0 + 1, srcWidth - 1);
        const y1 = Math.min(y0 + 1, srcHeight - 1);
        const fx = srcX - x0;
        const fy = srcY - y0;
        const v00 = srcData[y0 * srcWidth + x0];
        const v10 = srcData[y0 * srcWidth + x1];
        const v01 = srcData[y1 * srcWidth + x0];
        const v11 = srcData[y1 * srcWidth + x1];
        const isValid = v => v !== fillValue && !isNaN(v) && isFinite(v);
        if (isValid(v00) && isValid(v10) && isValid(v01) && isValid(v11)) {
          dstData[dstY * tileSize + dstX] =
            v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
            v01 * (1 - fx) * fy + v11 * fx * fy;
        } else {
          const vals = [v00, v10, v01, v11].filter(isValid);
          dstData[dstY * tileSize + dstX] = vals.length > 0 ? vals[0] : 0;
        }
      }
    }
    return dstData;
  }

  // Fast preview: nearest-neighbour (one sample per output pixel)
  if (!multiLook) {
    for (let dstY = 0; dstY < tileSize; dstY++) {
      const srcY = Math.min(Math.floor((dstY + 0.5) * scaleY), srcHeight - 1);
      const rowOffset = srcY * srcWidth;
      for (let dstX = 0; dstX < tileSize; dstX++) {
        const srcX = Math.min(Math.floor((dstX + 0.5) * scaleX), srcWidth - 1);
        const v = srcData[rowOffset + srcX];
        dstData[dstY * tileSize + dstX] = (v > 0 && !isNaN(v) && isFinite(v)) ? v : 0;
      }
    }
    return dstData;
  }

  // Multi-look: box-filter (area average)
  // Average ALL source pixels whose centers fall inside the output pixel footprint.
  for (let dstY = 0; dstY < tileSize; dstY++) {
    const srcY0 = Math.floor(dstY * scaleY);
    const srcY1 = Math.min(Math.floor((dstY + 1) * scaleY), srcHeight);

    for (let dstX = 0; dstX < tileSize; dstX++) {
      const srcX0 = Math.floor(dstX * scaleX);
      const srcX1 = Math.min(Math.floor((dstX + 1) * scaleX), srcWidth);

      let sum = 0;
      let count = 0;

      for (let sy = srcY0; sy < srcY1; sy++) {
        const rowOffset = sy * srcWidth;
        for (let sx = srcX0; sx < srcX1; sx++) {
          const v = srcData[rowOffset + sx];
          if (v !== fillValue && !isNaN(v) && isFinite(v) && v > 0) {
            sum += v;
            count++;
          }
        }
      }

      dstData[dstY * tileSize + dstX] = count > 0 ? sum / count : 0;
    }
  }

  return dstData;
}

/**
 * ChunkedDatasetReader - reads data from HDF5 dataset using file slicing
 *
 * This is the key class for efficient large file handling.
 * It reads raw bytes from the file and decodes them, bypassing h5wasm's
 * full-file loading requirement.
 *
 * NOTE: Currently scaffolded for future optimization. The main challenge is
 * that h5wasm doesn't expose raw dataset offsets. To use this class, we would
 * need to either:
 * 1. Parse HDF5 B-tree structure to find dataset chunk offsets
 * 2. Use a modified h5wasm that exposes this information
 *
 * For now, we use progressive loading via reloadWithMoreData() instead.
 *
 * @private
 */
// eslint-disable-next-line no-unused-vars
class ChunkedDatasetReader {
  constructor(file, datasetInfo) {
    this.file = file;
    this.info = datasetInfo;
    this.cache = new Map(); // Simple tile cache
    this.maxCacheSize = 100;
  }

  /**
   * Read a rectangular region from the dataset
   * @param {number} startRow - Start row index
   * @param {number} startCol - Start column index
   * @param {number} numRows - Number of rows to read
   * @param {number} numCols - Number of columns to read
   * @returns {Promise<Float32Array>}
   */
  async readRegion(startRow, startCol, numRows, numCols) {
    const { shape, dtype, dataOffset, bytesPerElement, chunks } = this.info;
    const [totalRows, totalCols] = shape;

    // Clamp to dataset bounds
    const endRow = Math.min(startRow + numRows, totalRows);
    const endCol = Math.min(startCol + numCols, totalCols);
    const actualRows = endRow - startRow;
    const actualCols = endCol - startCol;

    if (actualRows <= 0 || actualCols <= 0) {
      return null;
    }

    // For contiguous (non-chunked) datasets
    if (!chunks) {
      return this.readContiguousRegion(startRow, startCol, actualRows, actualCols);
    }

    // For chunked datasets
    return this.readChunkedRegion(startRow, startCol, actualRows, actualCols);
  }

  /**
   * Read from contiguous dataset storage
   */
  async readContiguousRegion(startRow, startCol, numRows, numCols) {
    const { shape, dataOffset, bytesPerElement } = this.info;
    const totalCols = shape[1];

    const result = new Float32Array(numRows * numCols);

    // Read row by row
    for (let r = 0; r < numRows; r++) {
      const rowIdx = startRow + r;
      const byteOffset = dataOffset + (rowIdx * totalCols + startCol) * bytesPerElement;
      const byteLength = numCols * bytesPerElement;

      const buffer = await readFileRange(this.file, byteOffset, byteLength);
      const rowData = this.decodeBuffer(buffer);

      result.set(rowData, r * numCols);
    }

    return result;
  }

  /**
   * Read from chunked dataset storage
   */
  async readChunkedRegion(startRow, startCol, numRows, numCols) {
    const { shape, chunks, chunkOffsets } = this.info;
    const [chunkRows, chunkCols] = chunks;

    // Determine which chunks we need
    const startChunkRow = Math.floor(startRow / chunkRows);
    const endChunkRow = Math.floor((startRow + numRows - 1) / chunkRows);
    const startChunkCol = Math.floor(startCol / chunkCols);
    const endChunkCol = Math.floor((startCol + numCols - 1) / chunkCols);

    const result = new Float32Array(numRows * numCols);

    // Read each needed chunk
    for (let cr = startChunkRow; cr <= endChunkRow; cr++) {
      for (let cc = startChunkCol; cc <= endChunkCol; cc++) {
        const chunkKey = `${cr},${cc}`;

        // Get chunk offset from index
        const chunkInfo = chunkOffsets?.get(chunkKey);
        if (!chunkInfo) continue;

        // Read chunk data
        const chunkBuffer = await readFileRange(this.file, chunkInfo.offset, chunkInfo.size);
        const chunkData = this.decodeBuffer(chunkBuffer);

        // Copy relevant portion to result
        const chunkStartRow = cr * chunkRows;
        const chunkStartCol = cc * chunkCols;

        for (let r = 0; r < chunkRows && chunkStartRow + r < startRow + numRows; r++) {
          const srcRow = chunkStartRow + r;
          if (srcRow < startRow) continue;

          for (let c = 0; c < chunkCols && chunkStartCol + c < startCol + numCols; c++) {
            const srcCol = chunkStartCol + c;
            if (srcCol < startCol) continue;

            const srcIdx = r * chunkCols + c;
            const dstIdx = (srcRow - startRow) * numCols + (srcCol - startCol);

            if (srcIdx < chunkData.length && dstIdx < result.length) {
              result[dstIdx] = chunkData[srcIdx];
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Decode raw bytes to Float32Array
   */
  decodeBuffer(buffer) {
    const { dtype } = this.info;

    switch (dtype) {
      case '<f4':
      case 'float32':
        return new Float32Array(buffer);
      case '<f8':
      case 'float64':
        return new Float32Array(new Float64Array(buffer));
      case '<f2':
      case 'float16':
        // Float16 needs special handling
        return this.decodeFloat16(buffer);
      case '<i2':
      case 'int16':
        return new Float32Array(new Int16Array(buffer));
      case '<u2':
      case 'uint16':
        return new Float32Array(new Uint16Array(buffer));
      case '<i4':
      case 'int32':
        return new Float32Array(new Int32Array(buffer));
      case '<u4':
      case 'uint32':
        return new Float32Array(new Uint32Array(buffer));
      default:
        console.warn(`[NISAR Loader] Unknown dtype: ${dtype}, assuming float32`);
        return new Float32Array(buffer);
    }
  }

  /**
   * Decode float16 buffer to Float32Array
   */
  decodeFloat16(buffer) {
    const uint16 = new Uint16Array(buffer);
    const result = new Float32Array(uint16.length);

    for (let i = 0; i < uint16.length; i++) {
      result[i] = this.float16ToFloat32(uint16[i]);
    }

    return result;
  }

  /**
   * Convert float16 bits to float32
   */
  float16ToFloat32(h) {
    const sign = (h & 0x8000) >> 15;
    const exp = (h & 0x7C00) >> 10;
    const frac = h & 0x03FF;

    if (exp === 0) {
      if (frac === 0) return sign ? -0 : 0;
      // Subnormal
      const f = frac / 1024;
      return (sign ? -1 : 1) * f * Math.pow(2, -14);
    } else if (exp === 31) {
      return frac ? NaN : (sign ? -Infinity : Infinity);
    }

    return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
  }
}

/**
 * Load a NISAR GCOV HDF5 file using streaming mode (h5chunk)
 * This is used for large files that would crash h5wasm
 * @private
 */
async function loadNISARGCOVStreaming(file, options = {}) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
  } = options;

  console.log('[NISAR Loader] Opening with h5chunk streaming...');

  // Open with h5chunk - uses lazy tree-walking by default
  // With lazy mode: reads ~10KB + remote object headers (~1-2MB) + on-demand B-trees
  const streamReader = await openH5ChunkFile(file); // Let h5chunk decide based on lazyTreeWalking flag

  // Get discovered datasets
  const h5Datasets = streamReader.getDatasets();
  console.log(`[NISAR Loader] h5chunk discovered ${h5Datasets.length} datasets`);

  // Detect product structure from spec paths
  const band = detectBand(h5Datasets);
  const paths = nisarPaths(band, 'GCOV');
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);
  const activeFreq = frequencies.includes(frequency) ? frequency : frequencies[0];

  console.log(`[NISAR Loader] Detected: band=${band}, frequencies=[${frequencies}], active=${activeFreq}`);

  // Read product identification metadata EARLY (before coordinate loading)
  // This allows metadata panel to populate instantly while other data loads
  const identification = await readProductIdentification(streamReader, paths, activeFreq, 'streaming');
  console.log(`[NISAR Loader] Product identification loaded: ${Object.keys(identification).length} fields`);

  // Find the requested dataset by spec path
  let selectedDataset = null;
  let selectedDatasetId = null;

  // Strategy 1: Find by exact spec path
  const targetPath = paths.dataset(activeFreq, polarization);
  selectedDatasetId = streamReader.findDatasetByPath(targetPath);
  if (selectedDatasetId) {
    const ds = h5Datasets.find(d => d.id === selectedDatasetId);
    if (ds && ds.shape?.length === 2) {
      selectedDataset = ds;
      console.log(`[NISAR Loader] Matched ${polarization} by spec path: ${targetPath}`);
    }
  }

  // Strategy 2: Match by path tail, preferring the correct frequency
  if (!selectedDataset) {
    let fallback = null;
    for (const ds of h5Datasets) {
      if (ds.shape?.length === 2 && ds.path) {
        const tail = ds.path.split('/').pop();
        if (tail === polarization) {
          // Prefer datasets under the active frequency
          if (ds.path.includes(`frequency${activeFreq}`)) {
            selectedDataset = ds;
            selectedDatasetId = ds.id;
            console.log(`[NISAR Loader] Matched ${polarization} by path tail (freq ${activeFreq}): ${ds.path}`);
            break;
          } else if (!fallback) {
            fallback = ds;
          }
        }
      }
    }
    if (!selectedDataset && fallback) {
      selectedDataset = fallback;
      selectedDatasetId = fallback.id;
      console.log(`[NISAR Loader] Matched ${polarization} by path tail (fallback freq): ${fallback.path}`);
    }
  }

  // Strategy 3: Fall back to largest 2D dataset
  if (!selectedDataset) {
    for (const ds of h5Datasets) {
      if (ds.shape?.length === 2) {
        const [h, w] = ds.shape;
        if (w >= 1000 && h >= 1000) {
          if (!selectedDataset || (w * h > selectedDataset.shape[0] * selectedDataset.shape[1])) {
            selectedDataset = ds;
            selectedDatasetId = ds.id;
          }
        }
      }
    }
  }

  if (!selectedDataset) {
    const datasets2D = h5Datasets.filter(d => d.shape?.length === 2);
    if (datasets2D.length > 0) {
      datasets2D.sort((a, b) => (b.shape[0] * b.shape[1]) - (a.shape[0] * a.shape[1]));
      selectedDataset = datasets2D[0];
      selectedDatasetId = selectedDataset.id;
    }
  }

  if (!selectedDataset) {
    throw new Error('No suitable 2D dataset found in HDF5 file');
  }

  const [height, width] = selectedDataset.shape;
  const chunkH = selectedDataset.chunkDims?.[0] || 512;
  const chunkW = selectedDataset.chunkDims?.[1] || 512;

  console.log(`[NISAR Loader] Selected dataset: ${selectedDatasetId}`);
  console.log(`[NISAR Loader] Dimensions: ${width}x${height}`);
  console.log(`[NISAR Loader] Data type: ${selectedDataset.dtype}`);
  console.log(`[NISAR Loader] Chunk size: ${chunkW}x${chunkH}`);
  console.log(`[NISAR Loader] Chunks: ${selectedDataset.numChunks}`);

  // ── Read CRS from projection dataset + attributes (NISAR spec §3.2.5) ──
  let crs = null;
  let utmZoneFromAttr = null;
  const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
  try {
    if (projId != null) {
      // Primary: read the projection dataset value (EPSG code as uint32 scalar)
      const projData = await streamReader.readSmallDataset(projId);
      if (projData?.data?.[0] > 0) {
        // _decodeData converts uint32→float32, so round to integer EPSG code
        const epsgVal = Math.round(projData.data[0]);
        if (epsgVal > 1000 && epsgVal < 100000) {
          crs = `EPSG:${epsgVal}`;
          console.log(`[NISAR Loader] CRS from projection dataset value: ${crs}`);
        }
      }
      // Also read projection attributes (epsg_code, spatial_ref, utm_zone_number, etc.)
      const projAttrs = streamReader.getDatasetAttributes(projId);
      if (projAttrs) {
        console.log(`[NISAR Loader] Projection attributes:`, Object.keys(projAttrs).join(', '));
        // Use epsg_code attribute as fallback if dataset value wasn't readable
        if (!crs && projAttrs.epsg_code > 0) {
          crs = `EPSG:${Math.round(projAttrs.epsg_code)}`;
          console.log(`[NISAR Loader] CRS from epsg_code attribute: ${crs}`);
        }
        // Parse spatial_ref WKT for EPSG code
        if (!crs && projAttrs.spatial_ref) {
          console.log(`[NISAR Loader] spatial_ref: ${String(projAttrs.spatial_ref).substring(0, 100)}...`);
          const epsgFromWkt = parseEpsgFromWkt(String(projAttrs.spatial_ref));
          if (epsgFromWkt) {
            crs = `EPSG:${epsgFromWkt}`;
            console.log(`[NISAR Loader] CRS from spatial_ref WKT: ${crs}`);
          }
        }
        // Store utm_zone_number for later inference
        if (projAttrs.utm_zone_number > 0) {
          utmZoneFromAttr = Math.round(projAttrs.utm_zone_number);
          console.log(`[NISAR Loader] UTM zone from attribute: ${utmZoneFromAttr}`);
        }
      }
    } else {
      console.warn(`[NISAR Loader] Projection dataset not found at: ${paths.projection(activeFreq)}`);
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Could not read projection:`, e.message);
  }
  // CRS will be finalized after reading coordinates (UTM inference needs worldBounds)

  // ── Read geolocation: coordinate arrays + spacing (NISAR spec §3.2.5) ──
  // Uses a 3-tier fallback chain per CF 1.7 conventions:
  //   1. Full xCoordinates/yCoordinates arrays (exact bounds)
  //   2. Endpoint reading: just first/last element of coordinate arrays (efficient)
  //   3. Spacing datasets + first coordinate element (computed bounds)
  const bounds = [0, 0, width, height];
  let worldBounds = null;
  let pixelSizeX = 1;
  let pixelSizeY = 1;
  let xCoords = null;
  let yCoords = null;

  const xCoordId = streamReader.findDatasetByPath(paths.xCoordinates(activeFreq));
  const yCoordId = streamReader.findDatasetByPath(paths.yCoordinates(activeFreq));

  // ── Authoritative pixel spacing from xCoordinateSpacing / yCoordinateSpacing ──
  // These scalar datasets encode the true posting (bandwidth-dependent: 20m for
  // 80/20 MHz, 10m for 40 MHz).  Read them FIRST so Tiers 1–2 don't need to
  // infer spacing from extent / dimensions (which fails when coordinate arrays
  // have more elements than the data grid).
  let spacingFromFile = false;
  try {
    const xSpacingId = streamReader.findDatasetByPath(paths.xCoordinateSpacing(activeFreq));
    const ySpacingId = streamReader.findDatasetByPath(paths.yCoordinateSpacing(activeFreq));
    if (xSpacingId != null && ySpacingId != null) {
      const xSpData = await streamReader.readSmallDataset(xSpacingId);
      const ySpData = await streamReader.readSmallDataset(ySpacingId);
      if (xSpData?.data?.[0] && ySpData?.data?.[0]) {
        pixelSizeX = Math.abs(xSpData.data[0]);
        pixelSizeY = Math.abs(ySpData.data[0]);
        spacingFromFile = true;
        console.log(`[NISAR Loader] Pixel spacing from file: ${pixelSizeX.toFixed(1)}m x ${pixelSizeY.toFixed(1)}m`);
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Could not read spacing datasets:`, e.message);
  }

  // ── Bounds extraction (3-tier fallback) ──

  // Tier 1: Try reading full coordinate arrays
  try {
    if (xCoordId != null && yCoordId != null) {
      const xCoordsResult = await streamReader.readSmallDataset(xCoordId);
      const yCoordsResult = await streamReader.readSmallDataset(yCoordId);

      if (xCoordsResult?.data?.length > 0 && yCoordsResult?.data?.length > 0) {
        xCoords = xCoordsResult.data;
        yCoords = yCoordsResult.data;
        const minX = Math.min(xCoords[0], xCoords[xCoords.length - 1]);
        const maxX = Math.max(xCoords[0], xCoords[xCoords.length - 1]);
        const minY = Math.min(yCoords[0], yCoords[yCoords.length - 1]);
        const maxY = Math.max(yCoords[0], yCoords[yCoords.length - 1]);
        worldBounds = [minX, minY, maxX, maxY];
        if (!spacingFromFile) {
          // Fall back: derive spacing from coordinate array lengths
          pixelSizeX = (maxX - minX) / (xCoords.length - 1 || 1);
          pixelSizeY = (maxY - minY) / (yCoords.length - 1 || 1);
        }
        console.log(`[NISAR Loader] World bounds from full coordinate arrays: [${worldBounds.join(', ')}]`);
        console.log(`[NISAR Loader] Pixel spacing: ${pixelSizeX.toFixed(1)}m x ${pixelSizeY.toFixed(1)}m`);
        if (xCoords.length !== width || yCoords.length !== height) {
          console.warn(`[NISAR Loader] Coordinate/data dimension mismatch: coords=${xCoords.length}x${yCoords.length}, data=${width}x${height}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Tier 1 (full arrays) failed:`, e.message);
  }

  // Tier 2: Read just the endpoints of coordinate arrays (handles large arrays)
  if (!worldBounds && xCoordId != null && yCoordId != null) {
    try {
      const xEndpoints = await streamReader.readDatasetEndpoints(xCoordId);
      const yEndpoints = await streamReader.readDatasetEndpoints(yCoordId);

      if (xEndpoints && yEndpoints) {
        const minX = Math.min(xEndpoints.first, xEndpoints.last);
        const maxX = Math.max(xEndpoints.first, xEndpoints.last);
        const minY = Math.min(yEndpoints.first, yEndpoints.last);
        const maxY = Math.max(yEndpoints.first, yEndpoints.last);
        worldBounds = [minX, minY, maxX, maxY];
        if (!spacingFromFile) {
          // Fall back: derive spacing from coordinate array lengths
          pixelSizeX = (maxX - minX) / (xEndpoints.length - 1 || 1);
          pixelSizeY = (maxY - minY) / (yEndpoints.length - 1 || 1);
        }
        console.log(`[NISAR Loader] World bounds from coordinate endpoints: [${worldBounds.join(', ')}]`);
        console.log(`[NISAR Loader] Pixel spacing: ${pixelSizeX.toFixed(1)}m x ${pixelSizeY.toFixed(1)}m`);
        if (xEndpoints.length !== width || yEndpoints.length !== height) {
          console.warn(`[NISAR Loader] Coordinate/data dimension mismatch: coords=${xEndpoints.length}x${yEndpoints.length}, data=${width}x${height}`);
        }
      }
    } catch (e) {
      console.warn(`[NISAR Loader] Tier 2 (endpoints) failed:`, e.message);
    }
  }

  // Tier 3: Use first coordinate element + spacing to compute bounds
  if (!worldBounds && spacingFromFile) {
    try {
      let x0 = null, y0 = null;
      let xLen = width, yLen = height;
      if (xCoordId != null) {
        const xEp = await streamReader.readDatasetEndpoints(xCoordId);
        if (xEp) { x0 = xEp.first; xLen = xEp.length; }
      }
      if (yCoordId != null) {
        const yEp = await streamReader.readDatasetEndpoints(yCoordId);
        if (yEp) { y0 = yEp.first; yLen = yEp.length; }
      }
      if (x0 != null && y0 != null) {
        // Use coordinate array lengths — may differ from data dimensions
        const xEnd = x0 + (xLen - 1) * pixelSizeX;
        const yEnd = y0 - (yLen - 1) * pixelSizeY;
        worldBounds = [
          Math.min(x0, xEnd),
          Math.min(y0, yEnd),
          Math.max(x0, xEnd),
          Math.max(y0, yEnd),
        ];
        console.log(`[NISAR Loader] World bounds from spacing + first coord: [${worldBounds.join(', ')}]`);
      }
    } catch (e) {
      console.warn(`[NISAR Loader] Tier 3 (spacing + origin) failed:`, e.message);
    }
  }

  if (!worldBounds) {
    console.warn(`[NISAR Loader] WARNING: Could not determine world coordinates. Export will lack georeferencing.`);
  }

  // ── Finalize CRS: infer from UTM zone + coordinates if not yet determined ──
  if (!crs && utmZoneFromAttr && worldBounds) {
    const epsg = inferUtmEpsg(utmZoneFromAttr, worldBounds);
    crs = `EPSG:${epsg}`;
    console.log(`[NISAR Loader] CRS inferred from utm_zone_number=${utmZoneFromAttr} + bounds hemisphere: ${crs}`);
  }
  if (!crs && worldBounds) {
    // Coordinates are clearly UTM if easting is in [100000, 900000] range
    const [minX, , maxX] = worldBounds;
    if (minX >= 100000 && maxX <= 900000) {
      console.warn(`[NISAR Loader] Coordinates appear to be UTM but no CRS detected. Easting: ${minX.toFixed(0)}-${maxX.toFixed(0)}`);
      // Without zone info, we can't determine exact EPSG — flag it clearly
      console.warn(`[NISAR Loader] Using EPSG:4326 fallback — exported GeoTIFF will have wrong CRS!`);
      console.warn(`[NISAR Loader] To fix: check that projection dataset is readable in HDF5 file`);
    }
  }
  if (!crs) {
    crs = 'EPSG:4326';
    console.warn(`[NISAR Loader] No projection found, using fallback: ${crs}`);
  }

  // Compute initial stats from a center chunk for auto-contrast
  const stats = { min_value: undefined, max_value: undefined, mean_value: undefined, sample_stddev: undefined };
  try {
    const midRow = Math.floor(height / chunkH / 2);
    const midCol = Math.floor(width / chunkW / 2);
    const sampleChunk = await streamReader.readChunk(selectedDatasetId, midRow, midCol);
    if (sampleChunk) {
      let sum = 0, sumSq = 0, count = 0, min = Infinity, max = -Infinity;
      for (let i = 0; i < sampleChunk.length; i++) {
        const v = sampleChunk[i];
        if (isNaN(v) || v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        sumSq += v * v;
        count++;
      }
      if (count > 0) {
        stats.min_value = min;
        stats.max_value = max;
        stats.mean_value = sum / count;
        stats.sample_stddev = Math.sqrt(sumSq / count - (sum / count) ** 2);
        console.log(`[NISAR Loader] Stats from center chunk: mean=${stats.mean_value.toFixed(4)}, std=${stats.sample_stddev.toFixed(4)}`);
      }
    }
  } catch (e) {
    console.warn('[NISAR Loader] Could not compute initial stats:', e.message);
  }

  // Build availableDatasets using spec-driven detection
  const detectedTerms = await detectCovarianceTerms(streamReader, h5Datasets, paths, activeFreq);

  const availableDatasets = detectedTerms.map(term => ({
    frequency: activeFreq,
    polarization: term,
    band,
  }));

  // ── Mask dataset (NISAR spec §4.3.3) ──
  // uint8 layer with same grid/chunks as data: 0=invalid, 1-5=valid, 255=fill
  let maskDatasetId = null;
  try {
    const maskId = streamReader.findDatasetByPath(paths.mask(activeFreq));
    if (maskId != null) {
      const maskDs = h5Datasets.find(d => d.id === maskId);
      if (maskDs?.shape?.length === 2) {
        maskDatasetId = maskId;
        console.log(`[NISAR Loader] Mask dataset found: ${maskDs.path} [${maskDs.shape.join(', ')}] dtype=${maskDs.dtype}`);
      }
    }
  } catch (e) {
    console.warn('[NISAR Loader] Could not find mask dataset:', e.message);
  }

  // Chunk-level cache: shared across tiles so zoomed views reuse data
  // LRU cache: Map maintains insertion order, move accessed items to end
  const chunkCache = new Map();
  const MAX_CHUNK_CACHE = 500;

  // Mask chunk cache (separate from data to avoid key collisions)
  const maskChunkCache = new Map();

  // Tile cache for rendered tiles (LRU with bounded size)
  const tileCache = new Map();
  const MAX_TILE_CACHE = 200;  // ~200MB at 256x256 Float32 tiles

  /**
   * Read a single chunk with caching (LRU)
   */
  async function getCachedChunk(chunkRow, chunkCol) {
    const key = `${chunkRow},${chunkCol}`;

    // LRU: If chunk exists, move it to end (most recently used)
    if (chunkCache.has(key)) {
      const chunk = chunkCache.get(key);
      chunkCache.delete(key);
      chunkCache.set(key, chunk);
      return chunk;
    }

    let chunk;
    try {
      chunk = await streamReader.readChunk(selectedDatasetId, chunkRow, chunkCol);
    } catch (e) {
      // Chunk read failed — do NOT cache the error so it can be retried
      console.warn(`[NISAR Loader] Chunk (${chunkRow},${chunkCol}) read failed:`, e.message);
      return null;
    }
    // Only cache successful reads (including null for sparse/missing chunks)
    // LRU cache eviction: remove oldest entries (from beginning of Map)
    if (chunkCache.size >= MAX_CHUNK_CACHE) {
      const oldestKeys = Array.from(chunkCache.keys()).slice(0, 100);
      oldestKeys.forEach(k => chunkCache.delete(k));
    }
    chunkCache.set(key, chunk);
    return chunk;
  }

  /**
   * Read a mask chunk with caching (LRU). Returns null if no mask dataset.
   */
  async function getCachedMaskChunk(chunkRow, chunkCol) {
    if (!maskDatasetId) return null;
    const key = `${chunkRow},${chunkCol}`;
    if (maskChunkCache.has(key)) {
      const chunk = maskChunkCache.get(key);
      maskChunkCache.delete(key);
      maskChunkCache.set(key, chunk);
      return chunk;
    }
    let chunk;
    try {
      chunk = await streamReader.readChunk(maskDatasetId, chunkRow, chunkCol);
    } catch (e) {
      return null;
    }
    if (maskChunkCache.size >= MAX_CHUNK_CACHE) {
      const oldestKeys = Array.from(maskChunkCache.keys()).slice(0, 100);
      oldestKeys.forEach(k => maskChunkCache.delete(k));
    }
    maskChunkCache.set(key, chunk);
    return chunk;
  }

  /**
   * Get tile data using h5chunk streaming.
   * For small regions (high zoom): reads full region via readRegion.
   * For large regions (low zoom): samples individual chunks for efficiency.
   */
  async function getTile({ x, y, z, bbox, multiLook = false }) {
    const ml = multiLook ? 'ml' : 'nn';
    const tileKey = `${x},${y},${z},${ml}`;

    // LRU: If tile exists, move it to end (most recently used)
    if (tileCache.has(tileKey)) {
      const tile = tileCache.get(tileKey);
      tileCache.delete(tileKey);
      tileCache.set(tileKey, tile);
      return tile;
    }

    try {
      const tileSize = 256;

      // Use bbox from deck.gl (world coordinates = pixel coordinates)
      // For OrthographicView: bbox = {left, top, right, bottom}
      // For geographic view: bbox = {west, south, east, north}
      let left, top, right, bottom;
      if (bbox) {
        if (bbox.left !== undefined) {
          // OrthographicView: Y increases upward in world, but image rows increase downward.
          // bbox.top = min world Y (bottom of view), bbox.bottom = max world Y (top of view).
          // Flip Y: imageRow = height - worldY
          left = Math.max(0, Math.floor(bbox.left));
          right = Math.min(width, Math.ceil(bbox.right));
          top = Math.max(0, height - Math.ceil(bbox.bottom));
          bottom = Math.min(height, height - Math.floor(bbox.top));
        } else {
          left = Math.max(0, Math.floor(bbox.west));
          top = Math.max(0, Math.floor(bbox.south));
          right = Math.min(width, Math.ceil(bbox.east));
          bottom = Math.min(height, Math.ceil(bbox.north));
        }
      } else {
        // Fallback: geographic tile scheme
        const scale = Math.pow(2, z);
        const pixelX = x * width / scale;
        const pixelY = y * height / scale;
        const pixelW = width / scale;
        const pixelH = height / scale;
        left = Math.max(0, Math.floor(pixelX));
        top = Math.max(0, Math.floor(pixelY));
        right = Math.min(width, Math.ceil(pixelX + pixelW));
        bottom = Math.min(height, Math.ceil(pixelY + pixelH));
      }

      if (left >= width || top >= height || right <= 0 || bottom <= 0) return null;

      const sliceW = right - left;
      const sliceH = bottom - top;
      if (sliceW <= 0 || sliceH <= 0) return null;

      let tileData;
      let maskData = null;

      // For small regions, read directly with readRegion (fast path)
      const MAX_DIRECT_PIXELS = 1024 * 1024; // 1M pixels max for direct read
      if (sliceW * sliceH <= MAX_DIRECT_PIXELS) {
        console.log(`[NISAR Loader] Tile ${tileKey}: direct read [${top}:${bottom}, ${left}:${right}] (${sliceW}x${sliceH})`);
        const readPromises = [streamReader.readRegion(selectedDatasetId, top, left, sliceH, sliceW)];
        if (maskDatasetId) readPromises.push(streamReader.readRegion(maskDatasetId, top, left, sliceH, sliceW));
        const [regionResult, maskRegion] = await Promise.all(readPromises);
        if (!regionResult?.data) return null;
        tileData = resampleToTileSize(regionResult.data, sliceW, sliceH, tileSize, NaN, multiLook);
        if (maskRegion?.data) {
          // Nearest-neighbor resample for mask (categorical, no averaging)
          maskData = resampleToTileSize(maskRegion.data, sliceW, sliceH, tileSize, 0, false);
        }
      } else {
        // For large regions, sample by reading chunks
        const stepX = sliceW / tileSize;
        const stepY = sliceH / tileSize;
        tileData = new Float32Array(tileSize * tileSize);
        if (maskDatasetId) maskData = new Float32Array(tileSize * tileSize);

        // multiLook=false → 1 sample (nearest-neighbour, instant preview)
        // multiLook=true  → 4–8 sub-samples per axis (16–64 look area average)
        const nSub = multiLook
          ? Math.min(Math.max(Math.round(Math.sqrt(stepX * stepY)), 4), 8)
          : 1;
        console.log(`[NISAR Loader] Tile ${tileKey}: chunk-sampled [${top}:${bottom}, ${left}:${right}] (${sliceW}x${sliceH}) ${multiLook ? 'multi-look' : 'preview'} samples=${nSub}x${nSub}`);

        for (let ty = 0; ty < tileSize; ty++) {
          for (let tx = 0; tx < tileSize; tx++) {
            let sum = 0, count = 0;

            // For mask: nearest-neighbor (center sample only, no averaging)
            const centerSrcY = top + Math.floor((ty + 0.5) * stepY);
            const centerSrcX = left + Math.floor((tx + 0.5) * stepX);

            for (let sy = 0; sy < nSub; sy++) {
              const srcY = top + Math.floor(ty * stepY + (sy + 0.5) * stepY / nSub);
              if (srcY < 0 || srcY >= height) continue;
              const cr = Math.floor(srcY / chunkH);

              for (let sx = 0; sx < nSub; sx++) {
                const srcX = left + Math.floor(tx * stepX + (sx + 0.5) * stepX / nSub);
                if (srcX < 0 || srcX >= width) continue;
                const cc = Math.floor(srcX / chunkW);

                const chunk = await getCachedChunk(cr, cc);
                if (chunk) {
                  const localY = srcY - cr * chunkH;
                  const localX = srcX - cc * chunkW;
                  const idx = localY * chunkW + localX;
                  if (idx >= 0 && idx < chunk.length) {
                    const v = chunk[idx];
                    if (!isNaN(v) && v > 0) {
                      sum += v;
                      count++;
                    }
                  }
                }
              }
            }

            tileData[ty * tileSize + tx] = count > 0 ? sum / count : 0;

            // Mask: nearest-neighbor from center pixel
            if (maskData && centerSrcY >= 0 && centerSrcY < height && centerSrcX >= 0 && centerSrcX < width) {
              const cr = Math.floor(centerSrcY / chunkH);
              const cc = Math.floor(centerSrcX / chunkW);
              const mChunk = await getCachedMaskChunk(cr, cc);
              if (mChunk) {
                const localY = centerSrcY - cr * chunkH;
                const localX = centerSrcX - cc * chunkW;
                const idx = localY * chunkW + localX;
                if (idx >= 0 && idx < mChunk.length) {
                  maskData[ty * tileSize + tx] = mChunk[idx];
                }
              }
            }
          }
        }
      }

      const tile = { data: tileData, width: tileSize, height: tileSize };
      if (maskData) tile.mask = maskData;

      // LRU cache eviction: remove oldest entries (from beginning of Map)
      if (tileCache.size >= MAX_TILE_CACHE) {
        const oldestKeys = Array.from(tileCache.keys()).slice(0, 50);
        oldestKeys.forEach(k => tileCache.delete(k));
      }
      tileCache.set(tileKey, tile);
      return tile;
    } catch (error) {
      console.error(`[NISAR Loader] Failed to load tile ${tileKey}:`, error);
      return null;
    }
  }

  /**
   * Export stripe reader for single-band mode — reads source data in horizontal
   * stripes and applies exact ml×ml box-filter averaging for GeoTIFF export.
   *
   * Same interface as the RGB composite's getExportStripe, but for a single
   * polarization. Returns {bands: {POL: Float32Array}, width, height}.
   */
  async function getExportStripe({ startRow, numRows, ml, exportWidth }) {
    const srcTop = startRow * ml;
    const srcBottom = Math.min((startRow + numRows) * ml, height);

    // Pre-fetch all chunks covering this stripe region
    const minChunkRow = Math.floor(srcTop / chunkH);
    const maxChunkRow = Math.floor(Math.min(srcBottom - 1, height - 1) / chunkH);
    const minChunkCol = 0;
    const maxChunkCol = Math.floor((width - 1) / chunkW);

    const fetches = [];
    for (let cr = minChunkRow; cr <= maxChunkRow; cr++) {
      for (let cc = minChunkCol; cc <= maxChunkCol; cc++) {
        fetches.push(getCachedChunk(cr, cc));
      }
    }
    await Promise.all(fetches);

    // Allocate output array for the single band
    const output = new Float32Array(exportWidth * numRows);

    // Exact box-filter averaging: each output pixel averages ALL ml×ml source pixels
    for (let oy = 0; oy < numRows; oy++) {
      for (let ox = 0; ox < exportWidth; ox++) {
        const sx0 = ox * ml;
        const sy0 = (startRow + oy) * ml;
        const sx1 = Math.min(sx0 + ml, width);
        const sy1 = Math.min(sy0 + ml, height);

        let sum = 0;
        let count = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          const cr = Math.floor(sy / chunkH);
          for (let sx = sx0; sx < sx1; sx++) {
            const cc = Math.floor(sx / chunkW);
            const chunk = chunkCache.get(`${cr},${cc}`);
            if (chunk) {
              const localY = sy - cr * chunkH;
              const localX = sx - cc * chunkW;
              const idx = localY * chunkW + localX;
              if (idx >= 0 && idx < chunk.length) {
                const v = chunk[idx];
                if (!isNaN(v) && v > 0) {
                  sum += v;
                  count++;
                }
              }
            }
          }
        }
        output[oy * exportWidth + ox] = count > 0 ? sum / count : NaN;
      }
    }

    return { bands: { [polarization]: output }, width: exportWidth, height: numRows };
  }

  // Load metadata cube (incidence angle, slant range, elevation angle, etc.)
  // This is optional - if not found, metadataCube will be null
  // (Product identification was already loaded earlier for instant metadata display)
  let metadataCube = null;
  try {
    metadataCube = await loadMetadataCube(streamReader, band);
    if (metadataCube) {
      console.log(`[NISAR Loader] Metadata cube loaded: ${metadataCube.getFieldNames().join(', ')}`);
    }
  } catch (e) {
    console.warn('[NISAR Loader] Could not load metadata cube:', e.message);
  }

  const result = {
    getTile,
    getExportStripe,
    bounds,
    worldBounds,
    crs,
    width,
    height,
    pixelSpacing: { x: Math.abs(pixelSizeX), y: Math.abs(pixelSizeY) },
    stats,
    fillValue: NaN,
    frequency,
    polarization,
    band,
    identification,
    availableDatasets,
    /** Full-resolution easting coordinates (Float64Array, length = width). */
    xCoords,

    /** Full-resolution northing coordinates (Float64Array, length = height). */
    yCoords,
    metadataCube,  // NEW: Metadata cube for incidence angle, slant range, etc.
    hasMask: maskDatasetId != null,
    _streaming: true,
    _h5chunk: streamReader,
  };

  console.log('[NISAR Loader] NISAR GCOV loaded successfully (streaming mode):', {
    width, height, bounds, worldBounds, crs, frequency, polarization,
    pixelSpacing: `${Math.abs(pixelSizeX).toFixed(1)}m x ${Math.abs(pixelSizeY).toFixed(1)}m`,
    stats: stats.mean_value !== undefined ? `mean=${stats.mean_value.toFixed(4)}` : 'none',
  });

  return result;
}

/**
 * Load full image using streaming mode for large files
 * Reads a grid of samples to create a downsampled preview
 * @private
 */
async function loadNISARGCOVFullImageStreaming(file, options = {}, maxSize = 2048) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
  } = options;

  console.log('[NISAR Loader] Loading full image via streaming...');

  // Open with h5chunk using lazy tree-walking
  const streamReader = await openH5ChunkFile(file);
  const h5Datasets = streamReader.getDatasets();

  // Detect product structure from spec paths
  const band = detectBand(h5Datasets);
  const paths = nisarPaths(band, 'GCOV');
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);
  const activeFreq = frequencies.includes(frequency) ? frequency : frequencies[0];

  // Find the requested dataset by spec path first
  let selectedDataset = null;
  let selectedDatasetId = null;

  const targetPath = paths.dataset(activeFreq, polarization);
  selectedDatasetId = streamReader.findDatasetByPath(targetPath);
  if (selectedDatasetId) {
    const ds = h5Datasets.find(d => d.id === selectedDatasetId);
    if (ds && ds.shape?.length === 2) {
      selectedDataset = ds;
      console.log(`[NISAR Loader] Full image: matched ${polarization} by spec path`);
    }
  }

  // Fallback: largest 2D dataset
  if (!selectedDataset) {
    for (const ds of h5Datasets) {
      if (ds.shape && ds.shape.length === 2) {
        const [height, width] = ds.shape;
        if (width >= 1000 && height >= 1000) {
          if (!selectedDataset || (width * height > selectedDataset.shape[0] * selectedDataset.shape[1])) {
            selectedDataset = ds;
            selectedDatasetId = ds.id;
          }
        }
      }
    }
  }

  if (!selectedDataset) {
    const datasets2D = h5Datasets.filter(d => d.shape && d.shape.length === 2);
    if (datasets2D.length > 0) {
      datasets2D.sort((a, b) => (b.shape[0] * b.shape[1]) - (a.shape[0] * a.shape[1]));
      selectedDataset = datasets2D[0];
      selectedDatasetId = selectedDataset.id;
    }
  }

  if (!selectedDataset) {
    throw new Error('No suitable 2D dataset found for full image');
  }

  const [fullHeight, fullWidth] = selectedDataset.shape;

  // Calculate output dimensions
  const maxDim = Math.max(fullWidth, fullHeight);
  const downsampleFactor = maxDim > maxSize ? Math.ceil(maxDim / maxSize) : 1;
  const width = Math.ceil(fullWidth / downsampleFactor);
  const height = Math.ceil(fullHeight / downsampleFactor);

  console.log(`[NISAR Loader] Streaming ${fullWidth}x${fullHeight} to ${width}x${height} (factor: ${downsampleFactor})`);

  // Read a grid of sample points to build the downsampled image
  // For efficiency, read in larger blocks and subsample
  const data = new Float32Array(width * height);
  const blockSize = 256; // Read 256x256 blocks
  const blocksX = Math.ceil(fullWidth / blockSize);
  const blocksY = Math.ceil(fullHeight / blockSize);

  let samplesRead = 0;
  const totalBlocks = blocksX * blocksY;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      try {
        const startRow = by * blockSize;
        const startCol = bx * blockSize;
        const blockHeight = Math.min(blockSize, fullHeight - startRow);
        const blockWidth = Math.min(blockSize, fullWidth - startCol);

        // Read block
        const regionResult = await streamReader.readRegion(
          selectedDatasetId,
          startRow,
          startCol,
          blockHeight,
          blockWidth
        );

        if (regionResult && regionResult.data) {
          // Sample points from this block into the output
          for (let y = 0; y < blockHeight; y += downsampleFactor) {
            for (let x = 0; x < blockWidth; x += downsampleFactor) {
              const srcY = startRow + y;
              const srcX = startCol + x;
              const dstY = Math.floor(srcY / downsampleFactor);
              const dstX = Math.floor(srcX / downsampleFactor);

              if (dstY < height && dstX < width) {
                const srcIdx = y * blockWidth + x;
                const dstIdx = dstY * width + dstX;
                if (srcIdx < regionResult.data.length) {
                  data[dstIdx] = regionResult.data[srcIdx];
                }
              }
            }
          }
          samplesRead++;
        }
      } catch (e) {
        console.warn(`[NISAR Loader] Failed to read block (${bx}, ${by}):`, e.message);
      }

      // Progress logging every 10%
      const progress = ((by * blocksX + bx + 1) / totalBlocks * 100).toFixed(0);
      if ((by * blocksX + bx + 1) % Math.ceil(totalBlocks / 10) === 0) {
        console.log(`[NISAR Loader] Full image progress: ${progress}%`);
      }
    }
  }

  console.log(`[NISAR Loader] Full image loaded: ${samplesRead}/${totalBlocks} blocks read`);

  // Default bounds (pixel coordinates)
  const bounds = [0, 0, fullWidth, fullHeight];

  // Read CRS from spec path
  let crs = 'EPSG:32610'; // fallback
  try {
    const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
    if (projId != null) {
      const projData = await streamReader.readSmallDataset(projId);
      if (projData?.data?.[0] > 0) {
        crs = `EPSG:${projData.data[0]}`;
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Could not read projection, using fallback: ${crs}`);
  }

  return {
    data,
    width,
    height,
    bounds,
    crs,
  };
}

/**
 * Load a NISAR GCOV HDF5 file with chunked loading
 * Uses streaming (h5chunk) for large files to avoid memory issues
 * @param {File} file - Local File object from input[type="file"]
 * @param {Object} options - Loading options
 * @param {string} options.frequency - 'A' or 'B' (default: 'A')
 * @param {string} options.polarization - 'HHHH', 'HVHV', etc. (default: 'HHHH')
 * @returns {Promise<{getTile: Function, bounds: Array, crs: string, width: number, height: number, stats: Object}>}
 */
export async function loadNISARGCOV(file, options = {}) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
  } = options;

  console.log(`[NISAR Loader] Loading NISAR GCOV: ${file.name}`);
  console.log(`[NISAR Loader] File size: ${(file.size / 1e9).toFixed(2)} GB`);
  console.log(`[NISAR Loader] Dataset: frequency${frequency}/${polarization}`);

  // For large files, use streaming mode with h5chunk
  const MAX_FULL_LOAD_SIZE = 500 * 1024 * 1024; // 500MB
  if (file.size > MAX_FULL_LOAD_SIZE) {
    console.log('[NISAR Loader] Large file - using streaming mode with h5chunk');
    return loadNISARGCOVStreaming(file, options);
  }

  // For smaller files, use h5wasm (full load into memory)
  console.log('[NISAR Loader] Using h5wasm (full load) for smaller file');

  // Open HDF5 file (loads entire file into memory)
  const { h5file, fullLoaded, loadedSize } = await openHDF5Chunked(file);

  console.log(`[NISAR Loader] Loaded: ${(loadedSize / 1e6).toFixed(1)} MB, Full: ${fullLoaded}`);

  // Detect band (LSAR/SSAR) from file structure
  let band = 'LSAR';
  if (safeGet(h5file, '/science/SSAR')) band = 'SSAR';
  const paths = nisarPaths(band, 'GCOV');

  // Get available datasets using spec paths
  const availableDatasets = [];
  const freqsToCheck = ['A', 'B'];

  // Try to read listOfFrequencies
  const freqDs = safeGet(h5file, paths.listOfFrequencies);
  if (freqDs) {
    try {
      const val = freqDs.value;
      if (val && val.length > 0) {
        freqsToCheck.length = 0;
        (Array.isArray(val) ? val : [val]).forEach(f => freqsToCheck.push(f));
      }
    } catch (e) { /* use default A, B */ }
  }

  for (const freq of freqsToCheck) {
    // Try to read listOfCovarianceTerms for this frequency
    let terms = null;
    const termsDs = safeGet(h5file, paths.listOfCovarianceTerms(freq));
    if (termsDs) {
      try {
        const val = termsDs.value;
        if (val && val.length > 0) terms = Array.isArray(val) ? val : [val];
      } catch (e) { /* fall through */ }
    }

    // Fall back to scanning for known terms
    if (!terms) terms = ALL_COV_TERMS;

    for (const term of terms) {
      const dataset = safeGet(h5file, paths.dataset(freq, term));
      if (dataset && dataset.shape && dataset.shape.length === 2) {
        availableDatasets.push({ frequency: freq, polarization: term, band });
      }
    }
  }

  // Get the requested dataset — use spec path
  const datasetPath = paths.dataset(frequency, polarization);
  const dataset = safeGet(h5file, datasetPath);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  console.log(`[NISAR Loader] Dataset shape: [${dataset.shape.join(', ')}]`);
  console.log(`[NISAR Loader] Dataset dtype: ${dataset.dtype}`);

  // Extract metadata using spec-driven paths
  const metadata = await extractMetadata(h5file, frequency, band);
  const { bounds, crs, width, height, pixelSizeX, pixelSizeY } = metadata;

  // Get dataset statistics and fill value
  const stats = getDatasetStats(dataset);
  const fillValue = safeGetAttr(dataset, '_FillValue') || NaN;

  console.log('[NISAR Loader] Stats from attributes:', stats);
  console.log('[NISAR Loader] Fill value:', fillValue);

  // Get dataset layout for chunked reading
  const layout = getDatasetLayout(dataset);
  console.log('[NISAR Loader] Dataset layout:', layout);

  // Determine bytes per element based on dtype
  const bytesPerElement = {
    '<f4': 4, 'float32': 4,
    '<f8': 8, 'float64': 8,
    '<f2': 2, 'float16': 2,
    '<i2': 2, 'int16': 2,
    '<u2': 2, 'uint16': 2,
    '<i4': 4, 'int32': 4,
    '<u4': 4, 'uint32': 4,
  }[dataset.dtype] || 4;

  // Dataset info for reference
  const datasetInfo = {
    shape: dataset.shape,
    dtype: dataset.dtype,
    chunks: layout?.chunks,
    bytesPerElement,
  };

  // Store references for getTile
  const readerState = {
    h5file,
    dataset,
    datasetInfo,
  };

  /**
   * Get tile data for deck.gl TileLayer
   * Uses chunked reading when possible
   */
  async function getTile({ x, y, z }) {
    try {
      const tileSize = 256;

      // Calculate pixel coordinates for this tile
      const scale = Math.pow(2, z);

      // Convert tile coordinates to pixel coordinates
      const pixelX = (x * tileSize * width) / (scale * 256);
      const pixelY = (y * tileSize * height) / (scale * 256);
      const pixelWidth = (tileSize * width) / (scale * 256);
      const pixelHeight = (tileSize * height) / (scale * 256);

      // Clamp to image bounds
      const left = Math.max(0, Math.floor(pixelX));
      const top = Math.max(0, Math.floor(pixelY));
      const right = Math.min(width, Math.ceil(pixelX + pixelWidth));
      const bottom = Math.min(height, Math.ceil(pixelY + pixelHeight));

      // Check if tile is out of bounds
      if (left >= width || top >= height || right <= 0 || bottom <= 0) {
        return null;
      }

      const sliceWidth = right - left;
      const sliceHeight = bottom - top;

      if (sliceWidth <= 0 || sliceHeight <= 0) {
        return null;
      }

      // Read tile data from dataset
      const sliceData = readerState.dataset.slice([[top, bottom], [left, right]]);

      // Convert to Float32Array if needed
      let data;
      if (sliceData instanceof Float32Array) {
        data = sliceData;
      } else {
        data = new Float32Array(sliceData);
      }

      // Resample to tile size
      const resampledData = resampleToTileSize(
        data,
        sliceWidth,
        sliceHeight,
        tileSize,
        fillValue
      );

      return {
        data: resampledData,
        width: tileSize,
        height: tileSize,
      };
    } catch (error) {
      console.error(`[NISAR Loader] Failed to load tile x:${x}, y:${y}, z:${z}:`, error);
      return null;
    }
  }

  // Read product identification metadata
  const identification = await readProductIdentification(h5file, paths, frequency, 'h5wasm');

  // Load metadata cube (incidence angle, slant range, elevation angle, etc.)
  let metadataCube = null;
  try {
    metadataCube = await loadMetadataCube(h5file, band);
    if (metadataCube) {
      console.log(`[NISAR Loader] Metadata cube loaded: ${metadataCube.getFieldNames().join(', ')}`);
    }
  } catch (e) {
    console.warn('[NISAR Loader] Could not load metadata cube:', e.message);
  }

  const result = {
    getTile,
    bounds,
    crs,
    width,
    height,
    pixelSpacing: { x: Math.abs(pixelSizeX), y: Math.abs(pixelSizeY) },
    stats,
    fillValue,
    frequency,
    polarization,
    band,
    identification,
    availableDatasets,
    /** Full-resolution easting coordinates (Float64Array, length = width). */
    xCoords,

    /** Full-resolution northing coordinates (Float64Array, length = height). */
    yCoords,
    metadataCube,  // NEW: Metadata cube for incidence angle, slant range, etc.
    _fullLoaded: fullLoaded,
    _h5file: h5file,
  };

  console.log('[NISAR Loader] NISAR GCOV loaded successfully (chunked):', {
    width,
    height,
    bounds,
    crs,
    frequency,
    polarization,
    fullLoaded,
    availableDatasets: availableDatasets.length,
  });

  return result;
}

/**
 * Load full image from NISAR GCOV (downsampled for statistics/preview)
 * @param {File} file - HDF5 file
 * @param {Object} options - Loading options
 * @param {number} maxSize - Maximum dimension (default 2048)
 * @returns {Promise<{data: Float32Array, width: number, height: number, bounds: Array, crs: string}>}
 */
export async function loadNISARGCOVFullImage(file, options = {}, maxSize = 2048) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
  } = options;

  console.log(`[NISAR Loader] Loading full image (max ${maxSize}px): ${file.name}`);

  // For large files, use streaming to read a sampled subset
  const MAX_FULL_LOAD_SIZE = 500 * 1024 * 1024; // 500MB
  if (file.size > MAX_FULL_LOAD_SIZE) {
    console.log('[NISAR Loader] Large file - using streaming mode for full image');
    return loadNISARGCOVFullImageStreaming(file, options, maxSize);
  }

  // Open HDF5 file (loads entire file into memory)
  const { h5file } = await openHDF5Chunked(file);

  // Detect band
  let band = 'LSAR';
  if (safeGet(h5file, '/science/SSAR')) band = 'SSAR';
  const paths = nisarPaths(band, 'GCOV');

  // Get the requested dataset using spec path
  const datasetPath = paths.dataset(frequency, polarization);
  const dataset = safeGet(h5file, datasetPath);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  const [fullHeight, fullWidth] = dataset.shape;

  // Extract metadata using spec-driven paths
  const metadata = await extractMetadata(h5file, frequency, band);
  const { bounds, crs, pixelSizeX, pixelSizeY } = metadata;

  // Calculate downsample factor
  const maxDim = Math.max(fullWidth, fullHeight);
  const downsampleFactor = maxDim > maxSize ? Math.ceil(maxDim / maxSize) : 1;

  const width = Math.ceil(fullWidth / downsampleFactor);
  const height = Math.ceil(fullHeight / downsampleFactor);

  console.log(`[NISAR Loader] Downsampling ${fullWidth}x${fullHeight} to ${width}x${height} (factor: ${downsampleFactor})`);

  // Read with stride for downsampling
  let data;
  try {
    if (downsampleFactor === 1) {
      // Read full dataset
      data = new Float32Array(dataset.value);
    } else {
      // Read and downsample
      const fullData = dataset.value;
      data = new Float32Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcY = Math.min(y * downsampleFactor, fullHeight - 1);
          const srcX = Math.min(x * downsampleFactor, fullWidth - 1);
          data[y * width + x] = fullData[srcY * fullWidth + srcX];
        }
      }
    }
  } catch (e) {
    console.error('[NISAR Loader] Failed to read full image:', e);
    throw e;
  }

  console.log('[NISAR Loader] Full image loaded:', {
    width,
    height,
    bounds,
    crs,
    dataSize: data.length,
  });

  return {
    data,
    width,
    height,
    bounds,
    crs,
  };
}

/**
 * Load NISAR GCOV as an RGB composite using multiple polarization datasets.
 * Opens the file once and reads tiles from multiple datasets in parallel.
 *
 * @param {File} file - Local File object
 * @param {Object} options
 * @param {string} options.frequency - 'A' or 'B' (default: 'A')
 * @param {string} options.compositeId - Composite preset ID from SAR_COMPOSITES
 * @param {string[]} options.requiredPols - Polarization names needed (e.g. ['HHHH','HVHV','VVVV'])
 * @returns {Promise<{getRGBTile, bounds, crs, width, height, composite, availableDatasets}>}
 */
export async function loadNISARRGBComposite(file, options = {}) {
  const {
    frequency = 'A',
    compositeId = 'hh-hv-vv',
    requiredPols = ['HHHH', 'HVHV', 'VVVV'],
  } = options;

  console.log(`[NISAR Loader] Loading RGB composite: ${compositeId}`);
  console.log(`[NISAR Loader] Required polarizations: ${requiredPols.join(', ')}`);

  // Open with h5chunk streaming with lazy tree-walking (fast for all file sizes)
  const streamReader = await openH5ChunkFile(file); // Use lazy mode default
  const h5Datasets = streamReader.getDatasets();

  console.log(`[NISAR Loader] h5chunk found ${h5Datasets.length} datasets`);
  h5Datasets.forEach(d => {
    console.log(`[NISAR Loader]   ${d.path || d.id}: ${d.shape?.join('x')} ${d.dtype}, ${d.numChunks} chunks`);
  });

  // Detect product structure from spec
  const band = detectBand(h5Datasets);
  const paths = nisarPaths(band, 'GCOV');
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);
  const activeFreq = frequencies.includes(frequency) ? frequency : frequencies[0];

  // Find all 2D datasets with the same shape (these are the polarization bands)
  const datasets2D = h5Datasets
    .filter(d => d.shape && d.shape.length === 2)
    .sort((a, b) => (b.shape[0] * b.shape[1]) - (a.shape[0] * a.shape[1]));

  if (datasets2D.length === 0) {
    throw new Error('No 2D datasets found in HDF5 file');
  }

  // Group by shape to find matching polarization bands
  const targetShape = datasets2D[0].shape;
  const matchingDatasets = datasets2D.filter(
    d => d.shape[0] === targetShape[0] && d.shape[1] === targetShape[1]
  );

  console.log(`[NISAR Loader] Found ${matchingDatasets.length} datasets with shape ${targetShape.join('x')}`);

  // Map h5chunk dataset IDs to covariance terms using spec-driven approach
  const polMap = await classifyDatasets(streamReader, matchingDatasets, paths, activeFreq);

  console.log('[NISAR Loader] Dataset → covariance term mapping:');
  for (const [term, dsId] of Object.entries(polMap)) {
    const ds = h5Datasets.find(d => d.id === dsId);
    const shapeStr = ds?.shape?.join('x') || 'unknown';
    const chunkStr = ds?.chunkDims?.join('x') || 'unknown';
    console.log(`[NISAR Loader]   ${term} → ${dsId} (${shapeStr}, chunks: ${chunkStr})`);
  }

  // Verify we have the required polarizations
  const missingPols = requiredPols.filter(p => !polMap[p]);
  if (missingPols.length > 0) {
    console.warn(`[NISAR Loader] Missing polarizations: ${missingPols.join(', ')}`);
    console.warn('[NISAR Loader] Will use zeros for missing bands');
  }

  const [height, width] = targetShape;
  const chunkH = matchingDatasets[0].chunkDims?.[0] || 512;
  const chunkW = matchingDatasets[0].chunkDims?.[1] || 512;

  // ── Extract CRS from projection dataset + attributes (NISAR spec §3.2.5) ──
  let crs = null;
  let utmZoneFromAttr = null;
  try {
    const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
    if (projId != null) {
      const projData = await streamReader.readSmallDataset(projId);
      if (projData?.data?.[0] > 0) {
        const epsgVal = Math.round(projData.data[0]);
        if (epsgVal > 1000 && epsgVal < 100000) {
          crs = `EPSG:${epsgVal}`;
          console.log(`[NISAR Loader] RGB CRS from projection value: ${crs}`);
        }
      }
      const projAttrs = streamReader.getDatasetAttributes(projId);
      if (projAttrs) {
        if (!crs && projAttrs.epsg_code > 0) {
          crs = `EPSG:${Math.round(projAttrs.epsg_code)}`;
          console.log(`[NISAR Loader] RGB CRS from epsg_code attribute: ${crs}`);
        }
        if (!crs && projAttrs.spatial_ref) {
          const epsgFromWkt = parseEpsgFromWkt(String(projAttrs.spatial_ref));
          if (epsgFromWkt) {
            crs = `EPSG:${epsgFromWkt}`;
            console.log(`[NISAR Loader] RGB CRS from spatial_ref WKT: ${crs}`);
          }
        }
        if (projAttrs.utm_zone_number > 0) {
          utmZoneFromAttr = Math.round(projAttrs.utm_zone_number);
        }
      }
    } else {
      console.warn(`[NISAR Loader] RGB: Projection dataset not found at: ${paths.projection(activeFreq)}`);
    }
  } catch (e) {
    console.warn(`[NISAR Loader] RGB: Could not read projection:`, e.message);
  }
  // CRS finalized after bounds extraction (UTM inference needs coordinates)

  // ── Extract bounds using 3-tier fallback (same as single-band) ──
  let bounds = [0, 0, width, height];
  let worldBounds = null;
  let xCoords = null;
  let yCoords = null;

  const xCoordId = streamReader.findDatasetByPath(paths.xCoordinates(activeFreq));
  const yCoordId = streamReader.findDatasetByPath(paths.yCoordinates(activeFreq));
  console.log(`[NISAR Loader] RGB coordinate dataset IDs: x=${xCoordId}, y=${yCoordId}, paths: ${paths.xCoordinates(activeFreq)}, ${paths.yCoordinates(activeFreq)}`);

  // ── Authoritative pixel spacing from xCoordinateSpacing / yCoordinateSpacing ──
  let pixelSizeX = 1;
  let pixelSizeY = 1;
  let spacingFromFile = false;
  try {
    const xSpId = streamReader.findDatasetByPath(paths.xCoordinateSpacing(activeFreq));
    const ySpId = streamReader.findDatasetByPath(paths.yCoordinateSpacing(activeFreq));
    if (xSpId != null && ySpId != null) {
      const xSpData = await streamReader.readSmallDataset(xSpId);
      const ySpData = await streamReader.readSmallDataset(ySpId);
      if (xSpData?.data?.[0] && ySpData?.data?.[0]) {
        pixelSizeX = Math.abs(xSpData.data[0]);
        pixelSizeY = Math.abs(ySpData.data[0]);
        spacingFromFile = true;
        console.log(`[NISAR Loader] RGB pixel spacing from file: ${pixelSizeX.toFixed(1)}m x ${pixelSizeY.toFixed(1)}m`);
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] RGB: Could not read spacing datasets:`, e.message);
  }

  // Tier 1: Full coordinate arrays
  try {
    if (xCoordId != null && yCoordId != null) {
      const xCoordsResult = await streamReader.readSmallDataset(xCoordId);
      const yCoordsResult = await streamReader.readSmallDataset(yCoordId);
      if (xCoordsResult?.data?.length > 0 && yCoordsResult?.data?.length > 0) {
        xCoords = xCoordsResult.data;
        yCoords = yCoordsResult.data;
        const minX = Math.min(xCoords[0], xCoords[xCoords.length - 1]);
        const maxX = Math.max(xCoords[0], xCoords[xCoords.length - 1]);
        const minY = Math.min(yCoords[0], yCoords[yCoords.length - 1]);
        const maxY = Math.max(yCoords[0], yCoords[yCoords.length - 1]);
        worldBounds = [minX, minY, maxX, maxY];
        if (!spacingFromFile) {
          pixelSizeX = (maxX - minX) / (xCoords.length - 1 || 1);
          pixelSizeY = (maxY - minY) / (yCoords.length - 1 || 1);
        }
        console.log(`[NISAR Loader] RGB bounds from full arrays: [${worldBounds.join(', ')}]`);
        if (xCoords.length !== width || yCoords.length !== height) {
          console.warn(`[NISAR Loader] RGB: Coordinate/data dimension mismatch: coords=${xCoords.length}x${yCoords.length}, data=${width}x${height}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] RGB Tier 1 failed:`, e.message);
  }

  // Tier 2: Endpoint reading
  if (!worldBounds && xCoordId != null && yCoordId != null) {
    try {
      const xEp = await streamReader.readDatasetEndpoints(xCoordId);
      const yEp = await streamReader.readDatasetEndpoints(yCoordId);
      if (xEp && yEp) {
        worldBounds = [
          Math.min(xEp.first, xEp.last), Math.min(yEp.first, yEp.last),
          Math.max(xEp.first, xEp.last), Math.max(yEp.first, yEp.last),
        ];
        if (!spacingFromFile) {
          pixelSizeX = (worldBounds[2] - worldBounds[0]) / (xEp.length - 1 || 1);
          pixelSizeY = (worldBounds[3] - worldBounds[1]) / (yEp.length - 1 || 1);
        }
        console.log(`[NISAR Loader] RGB bounds from endpoints: [${worldBounds.join(', ')}]`);
        if (xEp.length !== width || yEp.length !== height) {
          console.warn(`[NISAR Loader] RGB: Coordinate/data dimension mismatch: coords=${xEp.length}x${yEp.length}, data=${width}x${height}`);
        }
      }
    } catch (e) {
      console.warn(`[NISAR Loader] RGB Tier 2 failed:`, e.message);
    }
  }

  // Tier 3: Use first coordinate + spacing for bounds
  if (!worldBounds && spacingFromFile) {
    try {
      let x0 = null, y0 = null;
      let xLen = width, yLen = height;
      if (xCoordId) { const ep = await streamReader.readDatasetEndpoints(xCoordId); if (ep) { x0 = ep.first; xLen = ep.length; } }
      if (yCoordId) { const ep = await streamReader.readDatasetEndpoints(yCoordId); if (ep) { y0 = ep.first; yLen = ep.length; } }
      if (x0 != null && y0 != null) {
        const xEnd = x0 + (xLen - 1) * pixelSizeX;
        const yEnd = y0 - (yLen - 1) * pixelSizeY;
        worldBounds = [Math.min(x0, xEnd), Math.min(y0, yEnd), Math.max(x0, xEnd), Math.max(y0, yEnd)];
        console.log(`[NISAR Loader] RGB bounds from spacing: [${worldBounds.join(', ')}]`);
      }
    } catch (e) {
      console.warn(`[NISAR Loader] RGB Tier 3 failed:`, e.message);
    }
  }

  // Note: Keep bounds as pixel coordinates [0,0,width,height] like single-band mode
  // worldBounds contains world coordinates (meters) for georeferencing

  // ── Finalize CRS: infer from UTM zone + coordinates if not yet determined ──
  if (!crs && utmZoneFromAttr && worldBounds) {
    const epsg = inferUtmEpsg(utmZoneFromAttr, worldBounds);
    crs = `EPSG:${epsg}`;
    console.log(`[NISAR Loader] RGB CRS inferred from utm_zone=${utmZoneFromAttr}: ${crs}`);
  }
  if (!crs) {
    crs = 'EPSG:4326';
    if (worldBounds) {
      const [minX, , maxX] = worldBounds;
      if (minX >= 100000 && maxX <= 900000) {
        console.warn(`[NISAR Loader] RGB: Coordinates appear UTM but no CRS detected!`);
      }
    }
    console.warn(`[NISAR Loader] RGB: No projection found, using fallback: ${crs}`);
  }
  console.log(`[NISAR Loader] RGB composite CRS: ${crs}`);

  console.log(`[NISAR Loader] RGB composite metadata:`, {
    bounds,
    worldBounds,
    crs,
    pixelSpacing: { x: Math.abs(pixelSizeX), y: Math.abs(pixelSizeY) }
  });

  // Per-dataset chunk caches
  const chunkCaches = {};
  for (const pol of requiredPols) {
    chunkCaches[pol] = new Map();
  }
  const MAX_CHUNK_CACHE_PER_BAND = 300;

  // Tile cache
  const tileCache = new Map();
  const MAX_TILE_CACHE = 100;

  /**
   * Read a chunk with caching for a specific polarization dataset
   */
  async function getCachedChunk(pol, chunkRow, chunkCol) {
    const dsId = polMap[pol];
    if (!dsId) return null;

    const cache = chunkCaches[pol];
    const key = `${chunkRow},${chunkCol}`;
    if (cache.has(key)) return cache.get(key);

    let chunk;
    try {
      chunk = await streamReader.readChunk(dsId, chunkRow, chunkCol);
      // Debug: log first chunk read
      if (chunkRow === 0 && chunkCol === 0 && chunk) {
        console.log(`[NISAR RGB Export] First chunk ${pol}(0,0): length=${chunk.length}, expected=${chunkW * chunkH}`);
      }
    } catch (e) {
      // Chunk read failed — do NOT cache the error so it can be retried
      console.warn(`[NISAR RGB] Chunk ${pol}(${chunkRow},${chunkCol}) read failed:`, e.message);
      return null;
    }

    // Only cache successful reads (including null for sparse/missing chunks)
    if (cache.size >= MAX_CHUNK_CACHE_PER_BAND) {
      const keys = Array.from(cache.keys()).slice(0, 50);
      keys.forEach(k => cache.delete(k));
    }
    cache.set(key, chunk);
    return chunk;
  }

  /**
   * Sample a single pixel from a specific band at the given image coordinates
   */
  function samplePixel(chunk, srcY, srcX, chunkRow, chunkCol) {
    if (!chunk) return 0;
    const localY = srcY - chunkRow * chunkH;
    const localX = srcX - chunkCol * chunkW;
    const idx = localY * chunkW + localX;
    if (idx >= 0 && idx < chunk.length) {
      const v = chunk[idx];
      return (!isNaN(v) && v > 0) ? v : 0;
    }
    return 0;
  }

  /**
   * Get RGB tile data — reads from multiple datasets in parallel.
   * Returns {bands, width, height, compositeId} with Float32Arrays per channel.
   *
   * Performance: pre-fetches all needed chunks for all bands concurrently,
   * then samples pixels synchronously from the pre-fetched data.
   */
  async function getRGBTile({ x, y, z, bbox, multiLook = false }) {
    const ml = multiLook ? 'ml' : 'nn';
    const tileKey = `rgb_${x},${y},${z},${ml}`;

    console.log(`[NISAR Tile] Request: tile(${x},${y},${z}), multiLook=${multiLook}, bbox=`, bbox ? `[${bbox.left?.toFixed(0)}, ${bbox.top?.toFixed(0)}, ${bbox.right?.toFixed(0)}, ${bbox.bottom?.toFixed(0)}]` : 'none');

    // LRU: If tile exists, move it to end (most recently used)
    if (tileCache.has(tileKey)) {
      console.log(`[NISAR Tile] Cache hit: ${tileKey}`);
      const tile = tileCache.get(tileKey);
      tileCache.delete(tileKey);
      tileCache.set(tileKey, tile);
      return tile;
    }

    try {
      const tileSize = 256;

      // Compute pixel region from bbox
      // bbox can be in either pixel or world coordinates - auto-detect
      let left, top, right, bottom;
      if (bbox) {
        if (bbox.left !== undefined) {
          // Auto-detect coordinate system based on magnitude
          // If values >> image dimensions, assume world coords (UTM meters)
          const isWorldCoords = bbox.left > width * 2 || bbox.right > width * 2 ||
                                Math.abs(bbox.top) > height * 2 || Math.abs(bbox.bottom) > height * 2;

          if (isWorldCoords) {
            // World coordinates from deck.gl (UTM meters)
            // bbox.top = min world Y, bbox.bottom = max world Y (confusing naming!)
            const [minX, minY, maxX, maxY] = bounds;
            const worldLeft = bbox.left;
            const worldRight = bbox.right;
            const worldMinY = bbox.top;      // min Y in world (despite "top" name)
            const worldMaxY = bbox.bottom;   // max Y in world (despite "bottom" name)

            // Convert to pixel coordinates
            // Y axis is flipped: world Y increases upward, pixel row increases downward
            const pixelLeft = (worldLeft - minX) / pixelSizeX;
            const pixelRight = (worldRight - minX) / pixelSizeX;
            const pixelTop = (maxY - worldMaxY) / pixelSizeY;     // top of image (row 0)
            const pixelBottom = (maxY - worldMinY) / pixelSizeY;  // bottom of image

            left = Math.max(0, Math.floor(pixelLeft));
            right = Math.min(width, Math.ceil(pixelRight));
            top = Math.max(0, Math.floor(pixelTop));
            bottom = Math.min(height, Math.ceil(pixelBottom));
          } else {
            // Pixel coordinates - flip Y axis to match OrthographicView
            // bbox.top = min world Y (bottom), bbox.bottom = max world Y (top)
            left = Math.max(0, Math.floor(bbox.left));
            right = Math.min(width, Math.ceil(bbox.right));
            top = Math.max(0, height - Math.ceil(bbox.bottom));
            bottom = Math.min(height, height - Math.floor(bbox.top));
          }
        } else {
          // Geographic coordinates (west, south, east, north)
          const [minX, minY, maxX, maxY] = bounds;
          const pixelLeft = (bbox.west - minX) / pixelSizeX;
          const pixelRight = (bbox.east - minX) / pixelSizeX;
          const pixelTop = (maxY - bbox.north) / pixelSizeY;
          const pixelBottom = (maxY - bbox.south) / pixelSizeY;

          left = Math.max(0, Math.floor(pixelLeft));
          top = Math.max(0, Math.floor(pixelTop));
          right = Math.min(width, Math.ceil(pixelLeft + pixelWidth));
          bottom = Math.min(height, Math.ceil(pixelBottom + pixelHeight));
        }
      } else {
        const scale = Math.pow(2, z);
        const pixelX = x * width / scale;
        const pixelY = y * height / scale;
        const pixelW = width / scale;
        const pixelH = height / scale;
        left = Math.max(0, Math.floor(pixelX));
        top = Math.max(0, Math.floor(pixelY));
        right = Math.min(width, Math.ceil(pixelX + pixelW));
        bottom = Math.min(height, Math.ceil(pixelY + pixelH));
      }

      if (left >= width || top >= height || right <= 0 || bottom <= 0) return null;

      const sliceW = right - left;
      const sliceH = bottom - top;
      if (sliceW <= 0 || sliceH <= 0) return null;

      const stepX = sliceW / tileSize;
      const stepY = sliceH / tileSize;

      // multiLook=false → 1 sample (nearest-neighbour, instant preview)
      // multiLook=true  → 4–8 sub-samples per axis (16–64 look area average)
      const nSub = multiLook
        ? Math.min(Math.max(Math.round(Math.sqrt(stepX * stepY)), 4), 8)
        : 1;

      // --- Phase 1: determine which chunks cover this tile region ---
      const minChunkRow = Math.floor(top / chunkH);
      const maxChunkRow = Math.floor(Math.min(bottom - 1, height - 1) / chunkH);
      const minChunkCol = Math.floor(left / chunkW);
      const maxChunkCol = Math.floor(Math.min(right - 1, width - 1) / chunkW);

      // --- Phase 2: pre-fetch ALL chunks for ALL bands concurrently ---
      const chunkFetches = [];
      const chunkKeys = [];
      for (let cr = minChunkRow; cr <= maxChunkRow; cr++) {
        for (let cc = minChunkCol; cc <= maxChunkCol; cc++) {
          for (const pol of requiredPols) {
            chunkKeys.push({ pol, cr, cc });
            chunkFetches.push(getCachedChunk(pol, cr, cc));
          }
        }
      }

      const fetchedChunks = await Promise.all(chunkFetches);

      // Build lookup: prefetched[pol][`row,col`] = chunk
      const prefetched = {};
      for (const pol of requiredPols) {
        prefetched[pol] = {};
      }
      for (let i = 0; i < chunkKeys.length; i++) {
        const { pol, cr, cc } = chunkKeys[i];
        prefetched[pol][`${cr},${cc}`] = fetchedChunks[i];
      }

      // --- Phase 3: sample pixels synchronously from pre-fetched chunks ---
      const bandArrays = {};
      for (const pol of requiredPols) {
        bandArrays[pol] = new Float32Array(tileSize * tileSize);
      }

      for (let ty = 0; ty < tileSize; ty++) {
        for (let tx = 0; tx < tileSize; tx++) {
          const sums = {};
          const counts = {};
          for (const pol of requiredPols) {
            sums[pol] = 0;
            counts[pol] = 0;
          }

          for (let sy = 0; sy < nSub; sy++) {
            const srcY = top + Math.floor(ty * stepY + (sy + 0.5) * stepY / nSub);
            if (srcY < 0 || srcY >= height) continue;
            const cr = Math.floor(srcY / chunkH);

            for (let sx = 0; sx < nSub; sx++) {
              const srcX = left + Math.floor(tx * stepX + (sx + 0.5) * stepX / nSub);
              if (srcX < 0 || srcX >= width) continue;
              const cc = Math.floor(srcX / chunkW);

              const chunkKey = `${cr},${cc}`;
              for (const pol of requiredPols) {
                const chunk = prefetched[pol][chunkKey];
                const v = samplePixel(chunk, srcY, srcX, cr, cc);
                if (v > 0) {
                  sums[pol] += v;
                  counts[pol]++;
                }
              }
            }
          }

          const pixIdx = ty * tileSize + tx;
          for (const pol of requiredPols) {
            bandArrays[pol][pixIdx] = counts[pol] > 0 ? sums[pol] / counts[pol] : 0;
          }
        }
      }

      // Return raw band data — the composite formula and RGB conversion
      // are applied downstream by SARTileLayer + createRGBTexture
      const tile = {
        bands: bandArrays,
        width: tileSize,
        height: tileSize,
        compositeId,
      };

      // LRU cache eviction: remove oldest entries (from beginning of Map)
      if (tileCache.size >= MAX_TILE_CACHE) {
        const oldestKeys = Array.from(tileCache.keys()).slice(0, 25);
        oldestKeys.forEach(k => tileCache.delete(k));
      }
      tileCache.set(tileKey, tile);

      console.log(`[NISAR Tile] Success: ${tileKey}, region=[${left},${top},${right},${bottom}], samples=${Object.keys(bandArrays)[0] ? bandArrays[Object.keys(bandArrays)[0]].length : 0}`);

      return tile;

    } catch (error) {
      console.error(`[NISAR Tile] Failed: ${tileKey}`, error);
      return null;
    }
  }

  /**
   * Export stripe reader — reads source data in horizontal stripes and applies
   * exact ml×ml box-filter averaging for GeoTIFF export.
   *
   * Unlike getRGBTile (designed for display tiles), this function:
   * - Uses exact integer source coordinates (no floor/ceil quantization)
   * - Averages ALL ml×ml source pixels per output pixel (no sub-sampling)
   * - Returns raw Float32 band data (no RGB conversion or contrast scaling)
   *
   * @param {Object} params
   * @param {number} params.startRow - First output row in this stripe
   * @param {number} params.numRows - Number of output rows to produce
   * @param {number} params.ml - Multilook factor (integer)
   * @param {number} params.exportWidth - Output width in pixels
   * @returns {Promise<{bands: Object, width: number, height: number}>}
   */
  async function getExportStripe({ startRow, numRows, ml, exportWidth }) {
    // Debug: log export parameters
    if (startRow === 0) {
      console.log(`[NISAR RGB Export] Starting export with:`, {
        sourceWidth: width,
        sourceHeight: height,
        chunkDims: [chunkH, chunkW],
        ml,
        exportWidth,
        requestedRows: numRows
      });
    }

    // Source region for this stripe
    const srcTop = startRow * ml;
    const srcBottom = Math.min((startRow + numRows) * ml, height);

    // Pre-fetch all chunks covering this stripe region (all columns, all bands)
    const minChunkRow = Math.floor(srcTop / chunkH);
    const maxChunkRow = Math.floor(Math.min(srcBottom - 1, height - 1) / chunkH);
    const minChunkCol = 0;
    const maxChunkCol = Math.floor((width - 1) / chunkW);

    const fetches = [];
    for (let cr = minChunkRow; cr <= maxChunkRow; cr++) {
      for (let cc = minChunkCol; cc <= maxChunkCol; cc++) {
        for (const pol of requiredPols) {
          fetches.push(getCachedChunk(pol, cr, cc));
        }
      }
    }
    await Promise.all(fetches);

    // Allocate output arrays
    const bandArrays = {};
    for (const pol of requiredPols) {
      bandArrays[pol] = new Float32Array(exportWidth * numRows);
    }

    // Exact box-filter averaging: each output pixel averages ALL ml×ml source pixels
    for (let oy = 0; oy < numRows; oy++) {
      for (let ox = 0; ox < exportWidth; ox++) {
        const sx0 = ox * ml;
        const sy0 = (startRow + oy) * ml;
        const sx1 = Math.min(sx0 + ml, width);
        const sy1 = Math.min(sy0 + ml, height);

        for (const pol of requiredPols) {
          let sum = 0;
          let count = 0;
          for (let sy = sy0; sy < sy1; sy++) {
            const cr = Math.floor(sy / chunkH);
            for (let sx = sx0; sx < sx1; sx++) {
              const cc = Math.floor(sx / chunkW);
              const v = samplePixel(
                chunkCaches[pol].get(`${cr},${cc}`),
                sy, sx, cr, cc
              );
              if (v > 0) {
                sum += v;
                count++;
              }
            }
          }
          bandArrays[pol][oy * exportWidth + ox] = count > 0 ? sum / count : NaN;
        }
      }
    }

    return { bands: bandArrays, width: exportWidth, height: numRows };
  }

  // Build available datasets list
  const availableDatasets = Object.keys(polMap).map(pol => ({
    frequency: activeFreq,
    polarization: pol,
    band,
  }));

  // Read product identification metadata
  const identification = await readProductIdentification(streamReader, paths, activeFreq, 'streaming');

  const result = {
    getRGBTile,
    getExportStripe,
    bounds,
    worldBounds,
    crs,
    width,
    height,
    pixelSpacing: { x: Math.abs(pixelSizeX), y: Math.abs(pixelSizeY) },
    requiredPols,
    composite: compositeId,
    band,
    identification,
    availableDatasets,
    _streaming: true,
    _h5chunk: streamReader,
  };

  console.log('[NISAR Loader] RGB composite loaded:', {
    width, height, bounds, worldBounds, crs, compositeId,
    mappedPols: Object.keys(polMap),
  });

  return result;
}

/**
 * Classify h5chunk datasets into covariance term → dataset ID mapping.
 *
 * Uses a three-tier strategy:
 *
 * 1. **Spec paths** (§5.3): Match dataset path tails against the known
 *    covariance term names (HHHH, HVHV, VHVH, VVVV, etc.).
 *    This is authoritative when h5chunk resolves group paths.
 *
 * 2. **Metadata datasets**: Read `listOfCovarianceTerms` or
 *    `listOfPolarizations` from h5chunk if available, then
 *    match term names to datasets by path or by shape ordering.
 *
 * 3. **Power-level heuristic** (last resort): Sample center chunk from
 *    each dataset and sort by backscatter power. Co-pol > cross-pol.
 *
 * @param {H5Chunk} streamReader
 * @param {Array} datasets — Matching 2D datasets from h5chunk
 * @param {Object} [paths] — from nisarPaths() (optional, for metadata reads)
 * @param {string} [freq='A'] — frequency to check for metadata datasets
 * @returns {Object} Map of covariance term name → dataset ID
 */
async function classifyDatasets(streamReader, datasets, paths = null, freq = 'A') {
  const polMap = {};

  if (datasets.length === 0) return polMap;

  // ── Strategy 1: Match from HDF5 path tail, preferring active frequency ──
  // NISAR paths: /science/{band}/GCOV/grids/frequency{f}/{term}
  let matchedFromPath = 0;
  const freqTag = `frequency${freq}`;

  for (const ds of datasets) {
    if (ds.path) {
      const tail = ds.path.split('/').pop();
      if (COV_TERM_SET.has(tail)) {
        const isActiveFreq = ds.path.includes(freqTag);
        // Only overwrite if we don't have this term yet OR the new match
        // belongs to the active frequency (and the existing one doesn't)
        if (!polMap[tail] || (isActiveFreq && !polMap[`_freq_${tail}`])) {
          polMap[tail] = ds.id;
          if (isActiveFreq) polMap[`_freq_${tail}`] = true;
          matchedFromPath++;
          console.log(`[NISAR Loader] Matched ${tail} → ${ds.id} (path: ${ds.path})`);
        }
      }
    }
  }

  // Clean up internal frequency tracking keys
  for (const key of Object.keys(polMap)) {
    if (key.startsWith('_freq_')) delete polMap[key];
  }

  if (matchedFromPath > 0) {
    console.log(`[NISAR Loader] Identified ${matchedFromPath} terms from HDF5 paths`);
    return polMap;
  }

  // ── Strategy 2: Read metadata datasets ──
  if (paths) {
    const terms = await detectCovarianceTerms(streamReader, streamReader.getDatasets(), paths, freq);
    if (terms.length > 0 && terms.length <= datasets.length) {
      // Match terms to datasets in order (spec says datasets appear
      // in the same order as listOfCovarianceTerms)
      for (let i = 0; i < terms.length && i < datasets.length; i++) {
        polMap[terms[i]] = datasets[i].id;
        console.log(`[NISAR Loader] Matched ${terms[i]} → ${datasets[i].id} (metadata ordering)`);
      }
      if (Object.keys(polMap).length > 0) {
        console.log(`[NISAR Loader] Identified ${Object.keys(polMap).length} terms from metadata ordering`);
        return polMap;
      }
    }
  }

  // ── Strategy 3: Power-level heuristic (last resort) ──
  console.warn('[NISAR Loader] Falling back to power-level classification');

  const means = [];
  for (const ds of datasets) {
    const [h, w] = ds.shape;
    const chunkH = ds.chunkDims?.[0] || 512;
    const chunkW = ds.chunkDims?.[1] || 512;
    const midRow = Math.floor(h / chunkH / 2);
    const midCol = Math.floor(w / chunkW / 2);

    let mean = 0;
    try {
      const chunk = await streamReader.readChunk(ds.id, midRow, midCol);
      if (chunk) {
        let sum = 0, count = 0;
        for (let i = 0; i < chunk.length; i++) {
          const v = chunk[i];
          if (!isNaN(v) && v > 0) { sum += v; count++; }
        }
        mean = count > 0 ? sum / count : 0;
      }
    } catch (e) { /* skip */ }

    means.push({ id: ds.id, mean, meanDb: mean > 0 ? 10 * Math.log10(mean) : -999 });
  }

  means.sort((a, b) => b.mean - a.mean);

  console.log('[NISAR Loader] Dataset power levels (heuristic):');
  means.forEach((m, i) => {
    console.log(`[NISAR Loader]   ${i}: ${m.id} mean=${m.mean.toExponential(3)} (${m.meanDb.toFixed(1)} dB)`);
  });

  if (means.length >= 4) {
    polMap['HHHH'] = means[0].id;
    polMap['VVVV'] = means[1].id;
    polMap['HVHV'] = means[2].id;
    polMap['VHVH'] = means[3].id;
  } else if (means.length === 3) {
    polMap['HHHH'] = means[0].id;
    polMap['VVVV'] = means[1].id;
    polMap['HVHV'] = means[2].id;
  } else if (means.length === 2) {
    const dbDiff = means[0].meanDb - means[1].meanDb;
    // Strongest signal is always co-pol (HHHH)
    polMap['HHHH'] = means[0].id;
    // If power gap > 3 dB, weaker is cross-pol (HVHV); otherwise second co-pol (VVVV)
    polMap[dbDiff > 3 ? 'HVHV' : 'VVVV'] = means[1].id;
  } else if (means.length === 1) {
    polMap['HHHH'] = means[0].id;
  }

  return polMap;
}

// ─── URL-based Remote Loading ────────────────────────────────────────────

/**
 * List NISAR datasets from a remote URL (HTTP Range-request streaming).
 * Same as listNISARDatasets but works with a URL instead of a File.
 *
 * @param {string} url — HTTPS URL to a NISAR HDF5 file
 * @returns {Promise<Array<{frequency: string, polarization: string, band: string}>>}
 */
export async function listNISARDatasetsFromUrl(url) {
  console.log(`[NISAR Loader] Listing datasets from URL: ${url}`);

  try {
    const streamReader = await openH5ChunkUrl(url); // Use lazy tree-walking
    const h5Datasets = streamReader.getDatasets();

    console.log(`[h5chunk] Found ${h5Datasets.length} datasets from URL`);
    h5Datasets.forEach(d => {
      console.log(`[h5chunk]   - ${d.path || d.id}: ${d.shape?.join('x')} ${d.dtype}, ${d.numChunks} chunks`);
    });

    const band = detectBand(h5Datasets);
    const paths = nisarPaths(band, 'GCOV');
    const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);

    const datasets = [];
    for (const freq of frequencies) {
      const terms = await detectCovarianceTerms(streamReader, h5Datasets, paths, freq);
      for (const term of terms) {
        datasets.push({ frequency: freq, polarization: term, band });
      }
    }

    console.log(`[NISAR Loader] Detected ${datasets.length} datasets from URL (${band}, freq ${frequencies.join('+')})`);
    // Return the streamReader so loadNISARGCOVFromUrl can reuse it (avoid re-downloading metadata)
    return { datasets, _streamReader: streamReader };
  } catch (e) {
    console.error('[NISAR Loader] URL streaming failed:', e);
    throw new Error(`Failed to read remote NISAR file: ${e.message}`);
  }
}


/**
 * Load a NISAR GCOV dataset from a remote URL via h5chunk streaming.
 *
 * @param {string} url — HTTPS URL to a NISAR HDF5 file
 * @param {Object} options
 * @param {string} [options.frequency='A']
 * @param {string} [options.polarization='HHHH']
 * @returns {Promise<Object>} Same format as loadNISARGCOV
 */
export async function loadNISARGCOVFromUrl(url, options = {}) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
    _streamReader: existingReader = null,
  } = options;

  console.log(`[NISAR Loader] Loading from URL: ${url}`);
  console.log(`[NISAR Loader] Dataset: frequency${frequency}/${polarization}`);

  // Reuse reader from listNISARDatasetsFromUrl if available (avoids re-downloading metadata)
  const streamReader = existingReader || await openH5ChunkUrl(url); // Use lazy tree-walking
  const h5Datasets = streamReader.getDatasets();

  console.log(`[NISAR Loader] h5chunk discovered ${h5Datasets.length} datasets from URL`);

  const band = detectBand(h5Datasets);
  const paths = nisarPaths(band, 'GCOV');
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);
  const activeFreq = frequencies.includes(frequency) ? frequency : frequencies[0];

  // Find the requested dataset
  let selectedDataset = null;
  let selectedDatasetId = null;

  const targetPath = paths.dataset(activeFreq, polarization);
  selectedDatasetId = streamReader.findDatasetByPath(targetPath);
  if (selectedDatasetId != null) {
    const ds = h5Datasets.find(d => d.id === selectedDatasetId);
    if (ds && ds.shape?.length === 2) {
      selectedDataset = ds;
    }
  }

  // Strategy 2: Match by path tail, preferring the correct frequency
  if (!selectedDataset) {
    let fallback = null;
    for (const ds of h5Datasets) {
      if (ds.shape?.length === 2 && ds.path) {
        const tail = ds.path.split('/').pop();
        if (tail === polarization) {
          if (ds.path.includes(`frequency${activeFreq}`)) {
            selectedDataset = ds;
            selectedDatasetId = ds.id;
            console.log(`[NISAR Loader] URL: Matched ${polarization} by path tail (freq ${activeFreq}): ${ds.path}`);
            break;
          } else if (!fallback) {
            fallback = ds;
          }
        }
      }
    }
    if (!selectedDataset && fallback) {
      selectedDataset = fallback;
      selectedDatasetId = fallback.id;
      console.warn(`[NISAR Loader] URL: Using fallback frequency for ${polarization}: ${fallback.path}`);
    }
  }

  if (!selectedDataset) {
    throw new Error(`Dataset frequency${activeFreq}/${polarization} not found in remote file`);
  }

  const [height, width] = selectedDataset.shape;
  console.log(`[NISAR Loader] Selected: ${selectedDataset.path || selectedDatasetId} [${height}×${width}]`);

  // Read coordinate arrays
  let xCoords = null, yCoords = null;
  const xId = streamReader.findDatasetByPath(paths.xCoordinates(activeFreq));
  const yId = streamReader.findDatasetByPath(paths.yCoordinates(activeFreq));
  if (xId != null) {
    try {
      const xResult = await streamReader.readSmallDataset(xId);
      if (xResult?.data) xCoords = xResult.data;
    } catch { /* ignore */ }
  }
  if (yId != null) {
    try {
      const yResult = await streamReader.readSmallDataset(yId);
      if (yResult?.data) yCoords = yResult.data;
    } catch { /* ignore */ }
  }

  // Compute bounds
  let bounds, worldBounds, crs = 'EPSG:4326';
  let epsgCode = null;
  const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
  if (projId != null) {
    try {
      const projResult = await streamReader.readSmallDataset(projId);
      if (projResult?.data?.[0] > 1000) epsgCode = projResult.data[0];
    } catch { /* ignore */ }
  }
  if (epsgCode) crs = `EPSG:${epsgCode}`;

  if (xCoords && yCoords) {
    const minX = Math.min(xCoords[0], xCoords[xCoords.length - 1]);
    const maxX = Math.max(xCoords[0], xCoords[xCoords.length - 1]);
    const minY = Math.min(yCoords[0], yCoords[yCoords.length - 1]);
    const maxY = Math.max(yCoords[0], yCoords[yCoords.length - 1]);
    bounds = [minX, minY, maxX, maxY];
    worldBounds = bounds;
  } else {
    bounds = [0, 0, width, height];
    worldBounds = bounds;
  }

  // Chunk dimensions for per-chunk streaming access
  const chunkH = selectedDataset.chunkDims?.[0] || 512;
  const chunkW = selectedDataset.chunkDims?.[1] || 512;

  // ── Mask dataset (NISAR spec §4.3.3) ──
  let maskDatasetId = null;
  try {
    const maskId = streamReader.findDatasetByPath(paths.mask(activeFreq));
    if (maskId != null) {
      const maskDs = h5Datasets.find(d => d.id === maskId);
      if (maskDs?.shape?.length === 2) {
        maskDatasetId = maskId;
        console.log(`[NISAR Loader] URL: Mask dataset found: ${maskDs.path} [${maskDs.shape.join(', ')}]`);
      }
    }
  } catch { /* ignore */ }

  // Per-chunk cache for streaming (keyed by "cr,cc")
  // Sized to hold a full fine grid (24×24 = 576) plus headroom
  const chunkCache = new Map();
  const MAX_CHUNK_CACHE = 600;
  const maskChunkCache = new Map();

  async function getStreamChunk(cr, cc) {
    const key = `${cr},${cc}`;
    if (chunkCache.has(key)) return chunkCache.get(key);
    try {
      const data = await streamReader.readChunk(selectedDatasetId, cr, cc);
      const result = data?.data || data;
      if (chunkCache.size >= MAX_CHUNK_CACHE) {
        // Evict oldest entry
        const first = chunkCache.keys().next().value;
        chunkCache.delete(first);
      }
      chunkCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  async function getStreamMaskChunk(cr, cc) {
    if (!maskDatasetId) return null;
    const key = `${cr},${cc}`;
    if (maskChunkCache.has(key)) return maskChunkCache.get(key);
    try {
      const data = await streamReader.readChunk(maskDatasetId, cr, cc);
      const result = data?.data || data;
      if (maskChunkCache.size >= MAX_CHUNK_CACHE) {
        const first = maskChunkCache.keys().next().value;
        maskChunkCache.delete(first);
      }
      maskChunkCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  // Progressive refinement: coarse tiles are shown first, refined tiles replace them
  const refinedTiles = new Map();
  let _onRefine = null;

  // Helper: build a 256×256 tile from a sparse chunk grid via mosaic + bilinear
  function buildMosaicTile(grid, rows, cols, pxTop, pxLeft, sliceH, sliceW, tileSize) {
    const gR = rows.length, gC = cols.length;
    if (gR === 0 || gC === 0) return new Float32Array(tileSize * tileSize);

    const subN = Math.min(16, Math.max(4,
      Math.ceil(tileSize / Math.max(gR, gC))));
    const bH = Math.floor(chunkH / subN);
    const bW = Math.floor(chunkW / subN);
    const mH = gR * subN, mW = gC * subN;
    const mosaic = new Float32Array(mH * mW);
    const mY = new Float64Array(mH);
    const mX = new Float64Array(mW);

    for (let ri = 0; ri < gR; ri++) {
      const cr = rows[ri];
      for (let si = 0; si < subN; si++)
        mY[ri * subN + si] = cr * chunkH + (si + 0.5) * bH;
    }
    for (let ci = 0; ci < gC; ci++) {
      const cc = cols[ci];
      for (let sj = 0; sj < subN; sj++)
        mX[ci * subN + sj] = cc * chunkW + (sj + 0.5) * bW;
    }

    for (let ri = 0; ri < gR; ri++) {
      for (let ci = 0; ci < gC; ci++) {
        const chunk = grid.get(`${rows[ri]},${cols[ci]}`);
        if (!chunk) continue;
        for (let si = 0; si < subN; si++) {
          const y0 = si * bH, y1 = y0 + bH;
          for (let sj = 0; sj < subN; sj++) {
            const x0 = sj * bW, x1 = x0 + bW;
            let sum = 0, cnt = 0;
            for (let yy = y0; yy < y1; yy++) {
              const row = yy * chunkW;
              for (let xx = x0; xx < x1; xx++) {
                const v = chunk[row + xx];
                if (v > 0 && v === v) { sum += v; cnt++; }
              }
            }
            mosaic[(ri * subN + si) * mW + (ci * subN + sj)] =
              cnt > 0 ? sum / cnt : 0;
          }
        }
      }
    }

    const out = new Float32Array(tileSize * tileSize);
    let yi0 = 0;
    for (let ty = 0; ty < tileSize; ty++) {
      const srcY = pxTop + (ty + 0.5) * sliceH / tileSize;
      while (yi0 < mH - 2 && mY[yi0 + 1] <= srcY) yi0++;
      const yi1 = Math.min(yi0 + 1, mH - 1);
      const fy = yi0 === yi1 ? 0 :
        Math.max(0, Math.min(1, (srcY - mY[yi0]) / (mY[yi1] - mY[yi0])));
      let xi0 = 0;
      for (let tx = 0; tx < tileSize; tx++) {
        const srcX = pxLeft + (tx + 0.5) * sliceW / tileSize;
        while (xi0 < mW - 2 && mX[xi0 + 1] <= srcX) xi0++;
        const xi1 = Math.min(xi0 + 1, mW - 1);
        const fx = xi0 === xi1 ? 0 :
          Math.max(0, Math.min(1, (srcX - mX[xi0]) / (mX[xi1] - mX[xi0])));
        const v00 = mosaic[yi0 * mW + xi0];
        const v01 = mosaic[yi0 * mW + xi1];
        const v10 = mosaic[yi1 * mW + xi0];
        const v11 = mosaic[yi1 * mW + xi1];
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy);
        const w10 = (1 - fx) * fy, w11 = fx * fy;
        let wS = 0, vS = 0;
        if (v00 > 0) { vS += v00 * w00; wS += w00; }
        if (v01 > 0) { vS += v01 * w01; wS += w01; }
        if (v10 > 0) { vS += v10 * w10; wS += w10; }
        if (v11 > 0) { vS += v11 * w11; wS += w11; }
        out[ty * tileSize + tx] = wS > 0 ? vS / wS : 0;
      }
    }
    return out;
  }

  // Build getTile function for on-demand chunk reading
  const getTile = async ({ x, y, z, bbox }) => {
    const tileSize = 256;
    try {
      // Auto-detect coordinate system: pixel coords vs world coords
      // Check if bbox values are within image pixel bounds [0, width]×[0, height]
      // If yes → pixel coordinates, if no → world coordinates (need conversion)
      let pxLeft, pxRight, pxTop, pxBottom;

      const isPixelCoords = (
        bbox.left >= 0 && bbox.left <= width &&
        bbox.right >= 0 && bbox.right <= width &&
        bbox.top >= 0 && bbox.top <= height &&
        bbox.bottom >= 0 && bbox.bottom <= height
      );

      if (isPixelCoords) {
        // Direct pixel coordinates (from histogram sampling or direct pixel access)
        pxLeft = Math.max(0, Math.floor(bbox.left));
        pxRight = Math.min(width, Math.ceil(bbox.right));
        pxTop = Math.max(0, Math.floor(Math.min(bbox.top, bbox.bottom)));
        pxBottom = Math.min(height, Math.ceil(Math.max(bbox.top, bbox.bottom)));
      } else {
        // World coordinates (CRS-specific: UTM meters, lat/lon degrees, etc.)
        // Convert to pixels using worldBounds
        pxLeft = Math.max(0, Math.round(((bbox.left - bounds[0]) / (bounds[2] - bounds[0])) * width));
        pxRight = Math.min(width, Math.round(((bbox.right - bounds[0]) / (bounds[2] - bounds[0])) * width));
        pxTop = Math.max(0, Math.round(((bounds[3] - bbox.bottom) / (bounds[3] - bounds[1])) * height));
        pxBottom = Math.min(height, Math.round(((bounds[3] - bbox.top) / (bounds[3] - bounds[1])) * height));
      }

      const sliceW = pxRight - pxLeft;
      const sliceH = pxBottom - pxTop;

      if (sliceW <= 0 || sliceH <= 0) return null;

      let tileData;
      let maskData = null;

      // Small regions: read directly with readRegion (contiguous, fast)
      const MAX_DIRECT_PIXELS = 1024 * 1024;
      if (sliceW * sliceH <= MAX_DIRECT_PIXELS) {
        const readPromises = [streamReader.readRegion(selectedDatasetId, pxTop, pxLeft, sliceH, sliceW)];
        if (maskDatasetId) readPromises.push(streamReader.readRegion(maskDatasetId, pxTop, pxLeft, sliceH, sliceW));
        const [result, maskRegion] = await Promise.all(readPromises);
        if (!result) return null;
        tileData = result.data || result;
        const maskRaw = maskRegion ? (maskRegion.data || maskRegion) : null;

        // Resample to tileSize if region is larger than tile
        if (sliceW > tileSize || sliceH > tileSize) {
          const resampled = new Float32Array(tileSize * tileSize);
          const scaleX = sliceW / tileSize;
          const scaleY = sliceH / tileSize;
          let maskResampled = maskRaw ? new Float32Array(tileSize * tileSize) : null;
          for (let ty = 0; ty < tileSize; ty++) {
            const srcY = Math.min(Math.floor(ty * scaleY), sliceH - 1);
            for (let tx = 0; tx < tileSize; tx++) {
              const srcX = Math.min(Math.floor(tx * scaleX), sliceW - 1);
              resampled[ty * tileSize + tx] = tileData[srcY * sliceW + srcX];
              if (maskResampled) maskResampled[ty * tileSize + tx] = maskRaw[srcY * sliceW + srcX];
            }
          }
          tileData = resampled;
          const tile = { data: tileData, width: tileSize, height: tileSize };
          if (maskResampled) tile.mask = maskResampled;
          return tile;
        }

        const tile = { data: tileData, width: sliceW, height: sliceH };
        if (maskRaw) tile.mask = maskRaw;
        return tile;
      }

      // Large regions: progressive mosaic + bilinear.
      // Phase 1: coarse grid (8×8 max) → show fast.
      // Phase 2: full grid (24×24 max) → refine in background.
      const tileKey = `${x},${y},${z}`;

      // Return refined data if Phase 2 already completed
      if (refinedTiles.has(tileKey)) {
        return refinedTiles.get(tileKey);
      }

      const startCR = Math.floor(pxTop / chunkH);
      const endCR = Math.floor((pxBottom - 1) / chunkH);
      const startCC = Math.floor(pxLeft / chunkW);
      const endCC = Math.floor((pxRight - 1) / chunkW);
      const totalCR = endCR - startCR + 1;
      const totalCC = endCC - startCC + 1;

      // Phase 1: coarse grid (max 8×8 = 64 chunks)
      const COARSE_MAX = 8;
      const coarseStrideR = Math.max(1, Math.ceil(totalCR / COARSE_MAX));
      const coarseStrideC = Math.max(1, Math.ceil(totalCC / COARSE_MAX));
      const coarseRows = [];
      for (let cr = startCR; cr <= endCR; cr += coarseStrideR) coarseRows.push(cr);
      const coarseCols = [];
      for (let cc = startCC; cc <= endCC; cc += coarseStrideC) coarseCols.push(cc);

      const coarseGrid = new Map();
      const coarsePromises = [];
      for (const cr of coarseRows) {
        for (const cc of coarseCols) {
          coarsePromises.push(
            getStreamChunk(cr, cc).then(data => {
              if (data) coarseGrid.set(`${cr},${cc}`, data);
            })
          );
        }
      }
      await Promise.all(coarsePromises);

      tileData = buildMosaicTile(coarseGrid, coarseRows, coarseCols,
        pxTop, pxLeft, sliceH, sliceW, tileSize);

      // Build mask tile via nearest-neighbor from coarse grid chunks
      if (maskDatasetId) {
        const maskPromises = [];
        for (const cr of coarseRows) {
          for (const cc of coarseCols) {
            maskPromises.push(getStreamMaskChunk(cr, cc));
          }
        }
        await Promise.all(maskPromises);

        maskData = new Float32Array(tileSize * tileSize);
        const stepX = sliceW / tileSize;
        const stepY = sliceH / tileSize;
        for (let ty = 0; ty < tileSize; ty++) {
          const srcY = Math.min(Math.floor(pxTop + (ty + 0.5) * stepY), height - 1);
          const cr = Math.floor(srcY / chunkH);
          for (let tx = 0; tx < tileSize; tx++) {
            const srcX = Math.min(Math.floor(pxLeft + (tx + 0.5) * stepX), width - 1);
            const cc = Math.floor(srcX / chunkW);
            const mChunk = maskChunkCache.get(`${cr},${cc}`);
            if (mChunk) {
              const idx = (srcY - cr * chunkH) * chunkW + (srcX - cc * chunkW);
              if (idx >= 0 && idx < mChunk.length) maskData[ty * tileSize + tx] = mChunk[idx];
            }
          }
        }
      }

      // Schedule Phase 2 refinement if coarse was significantly sub-sampled
      const FINE_MAX = 24;
      const fineStrideR = Math.max(1, Math.ceil(totalCR / FINE_MAX));
      const fineStrideC = Math.max(1, Math.ceil(totalCC / FINE_MAX));

      if (coarseStrideR > fineStrideR || coarseStrideC > fineStrideC) {
        // Fire-and-forget background refinement
        (async () => {
          try {
            const fineRows = [];
            for (let cr = startCR; cr <= endCR; cr += fineStrideR) fineRows.push(cr);
            const fineCols = [];
            for (let cc = startCC; cc <= endCC; cc += fineStrideC) fineCols.push(cc);

            const fineGrid = new Map();
            const finePromises = [];
            for (const cr of fineRows) {
              for (const cc of fineCols) {
                finePromises.push(
                  getStreamChunk(cr, cc).then(data => {
                    if (data) fineGrid.set(`${cr},${cc}`, data);
                  })
                );
              }
            }
            await Promise.all(finePromises);

            const fineData = buildMosaicTile(fineGrid, fineRows, fineCols,
              pxTop, pxLeft, sliceH, sliceW, tileSize);
            const refinedTile = { data: fineData, width: tileSize, height: tileSize };
            if (maskData) refinedTile.mask = maskData;
            refinedTiles.set(tileKey, refinedTile);
            if (_onRefine) _onRefine(tileKey);
          } catch (e) {
            console.warn('[NISAR URL] Tile refinement error:', e.message);
          }
        })();
      }

      const tile = { data: tileData, width: tileSize, height: tileSize };
      if (maskData) tile.mask = maskData;
      return tile;
    } catch (e) {
      console.warn(`[NISAR URL] Tile error (${x},${y},${z}):`, e.message);
      return null;
    }
  };

  // Read identification metadata
  let identification = {};
  try {
    identification = await readProductIdentification(streamReader, paths, activeFreq, 'streaming');
  } catch { /* ignore */ }

  const result = {
    width,
    height,
    bounds,
    worldBounds,
    crs,
    epsgCode,
    getTile,
    mode: 'streaming',
    source: 'url',
    sourceUrl: url,
    band,
    frequency: activeFreq,
    polarization,
    xCoords,
    yCoords,
    identification,
    hasMask: maskDatasetId != null,
    /** Set a callback to be notified when a tile's refined data is ready. */
    set onRefine(fn) { _onRefine = fn; },
    get onRefine() { return _onRefine; },
    /**
     * Eagerly fetch a coarse grid of chunks covering the full image.
     * Warms the chunk cache so the first overview render is near-instant.
     * Returns a promise that resolves when all overview chunks are cached.
     */
    async prefetchOverviewChunks() {
      const totalCR = Math.ceil(height / chunkH);
      const totalCC = Math.ceil(width / chunkW);
      const COARSE_MAX = 8;
      const strideR = Math.max(1, Math.ceil(totalCR / COARSE_MAX));
      const strideC = Math.max(1, Math.ceil(totalCC / COARSE_MAX));
      const fetches = [];
      for (let cr = 0; cr < totalCR; cr += strideR) {
        for (let cc = 0; cc < totalCC; cc += strideC) {
          fetches.push(getStreamChunk(cr, cc));
        }
      }
      console.log(`[NISAR Loader] Prefetching ${fetches.length} overview chunks (${totalCR}×${totalCC} grid, stride ${strideR}×${strideC})`);
      await Promise.all(fetches);
      console.log(`[NISAR Loader] Overview prefetch complete (${chunkCache.size} chunks cached)`);
    },
  };
  return result;
}


export default loadNISARGCOV;
