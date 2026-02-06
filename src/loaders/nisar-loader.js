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
import { openH5ChunkFile } from './h5chunk.js';

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
    // Identification-level metadata
    listOfFrequencies: `/science/${band}/identification/listOfFrequencies`,
    productType:     `/science/${band}/identification/productType`,
    absoluteOrbitNumber: `/science/${band}/identification/absoluteOrbitNumber`,
    trackNumber:     `/science/${band}/identification/trackNumber`,
    frameNumber:     `/science/${band}/identification/frameNumber`,
    lookDirection:   `/science/${band}/identification/lookDirection`,
    orbitPassDirection: `/science/${band}/identification/orbitPassDirection`,
    zeroDopplerStartTime: `/science/${band}/identification/zeroDopplerStartTime`,
    zeroDopplerEndTime: `/science/${band}/identification/zeroDopplerEndTime`,
    // Processing flags
    isFullCovariance: `${base}/metadata/processingInformation/parameters/isFullCovariance`,
    polSymApplied: `${base}/metadata/processingInformation/parameters/polarimetricSymmetrizationApplied`,
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

  if (mode === 'streaming') {
    // h5chunk streaming reader
    const stringFields = [
      ['productType', paths.productType],
      ['lookDirection', paths.lookDirection],
      ['orbitPassDirection', paths.orbitPassDirection],
      ['zeroDopplerStartTime', paths.zeroDopplerStartTime],
      ['zeroDopplerEndTime', paths.zeroDopplerEndTime],
    ];
    const numericFields = [
      ['absoluteOrbitNumber', paths.absoluteOrbitNumber],
      ['trackNumber', paths.trackNumber],
      ['frameNumber', paths.frameNumber],
    ];

    for (const [key, path] of stringFields) {
      try {
        const dsId = reader.findDatasetByPath(path);
        if (dsId != null) {
          const result = await reader.readSmallDataset(dsId);
          if (result?.data?.length > 0) {
            id[key] = typeof result.data[0] === 'string'
              ? result.data[0].trim()
              : String.fromCharCode(...new Uint8Array(result.data.buffer || result.data)).replace(/\0/g, '').trim();
          }
        }
      } catch (e) { /* skip */ }
    }

    for (const [key, path] of numericFields) {
      try {
        const dsId = reader.findDatasetByPath(path);
        if (dsId != null) {
          const result = await reader.readSmallDataset(dsId);
          if (result?.data?.length > 0) {
            id[key] = Number(result.data[0]);
          }
        }
      } catch (e) { /* skip */ }
    }

    // Processing flags
    try {
      const fcId = reader.findDatasetByPath(paths.isFullCovariance);
      if (fcId != null) {
        const result = await reader.readSmallDataset(fcId);
        if (result?.data?.length > 0) {
          id.isFullCovariance = Boolean(result.data[0]);
        }
      }
    } catch (e) { /* skip */ }

  } else {
    // h5wasm reader
    const tryRead = (path) => {
      try {
        const ds = reader.get(path);
        if (!ds) return undefined;
        const val = ds.value;
        return Array.isArray(val) ? val[0] : val;
      } catch { return undefined; }
    };

    id.productType = tryRead(paths.productType)?.toString().trim();
    id.absoluteOrbitNumber = tryRead(paths.absoluteOrbitNumber);
    id.trackNumber = tryRead(paths.trackNumber);
    id.frameNumber = tryRead(paths.frameNumber);
    id.lookDirection = tryRead(paths.lookDirection)?.toString().trim();
    id.orbitPassDirection = tryRead(paths.orbitPassDirection)?.toString().trim();
    id.zeroDopplerStartTime = tryRead(paths.zeroDopplerStartTime)?.toString().trim();
    id.zeroDopplerEndTime = tryRead(paths.zeroDopplerEndTime)?.toString().trim();
    id.isFullCovariance = Boolean(tryRead(paths.isFullCovariance));
  }

  // Clean undefined values
  for (const k of Object.keys(id)) {
    if (id[k] === undefined || id[k] === null) delete id[k];
  }

  console.log('[NISAR Loader] Product identification:', id);
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
      // Use 32MB metadata read for NISAR cloud-optimized files
      const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);
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

  let epsgCode = 4326; // Default to WGS84
  let utmZone = null;

  if (projDataset) {
    // Try reading the projection dataset value (UInt32 scalar = EPSG code)
    try {
      const projVal = projDataset.value;
      if (typeof projVal === 'number' && projVal > 0) {
        epsgCode = projVal;
      }
    } catch (e) { /* attribute fallback below */ }

    // Also check attributes (some files store EPSG as attribute)
    epsgCode = safeGetAttr(projDataset, 'epsg_code') || epsgCode;
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

  let xCoords, yCoords;
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
 *   false → nearest-neighbour (blazing fast preview, raw speckle)
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

  // Open with h5chunk - reads metadata
  // NISAR cloud-optimized files have metadata + B-trees at front
  // Use larger size (32MB) to capture chunk indices
  const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);

  // Get discovered datasets
  const h5Datasets = streamReader.getDatasets();
  console.log(`[NISAR Loader] h5chunk discovered ${h5Datasets.length} datasets`);

  // Detect product structure from spec paths
  const band = detectBand(h5Datasets);
  const paths = nisarPaths(band, 'GCOV');
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);
  const activeFreq = frequencies.includes(frequency) ? frequency : frequencies[0];

  console.log(`[NISAR Loader] Detected: band=${band}, frequencies=[${frequencies}], active=${activeFreq}`);

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

  // Strategy 2: Match by path tail
  if (!selectedDataset) {
    for (const ds of h5Datasets) {
      if (ds.shape?.length === 2 && ds.path) {
        const tail = ds.path.split('/').pop();
        if (tail === polarization) {
          selectedDataset = ds;
          selectedDatasetId = ds.id;
          console.log(`[NISAR Loader] Matched ${polarization} by path tail: ${ds.path}`);
          break;
        }
      }
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

  // Bounds in pixel coordinates
  const bounds = [0, 0, width, height];

  // Read CRS from spec path: /science/{band}/GCOV/grids/frequency{f}/projection
  let crs = 'EPSG:32610'; // fallback
  try {
    const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
    if (projId != null) {
      const projData = await streamReader.readSmallDataset(projId);
      if (projData?.data?.[0] > 0) {
        crs = `EPSG:${projData.data[0]}`;
        console.log(`[NISAR Loader] CRS from projection dataset: ${crs}`);
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Could not read projection, using fallback: ${crs}`);
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

  // Chunk-level cache: shared across tiles so zoomed views reuse data
  const chunkCache = new Map();
  const MAX_CHUNK_CACHE = 500;

  // Tile cache for rendered tiles
  const tileCache = new Map();
  const MAX_TILE_CACHE = 200;

  /**
   * Read a single chunk with caching
   */
  async function getCachedChunk(chunkRow, chunkCol) {
    const key = `${chunkRow},${chunkCol}`;
    if (chunkCache.has(key)) return chunkCache.get(key);

    let chunk = null;
    try {
      chunk = await streamReader.readChunk(selectedDatasetId, chunkRow, chunkCol);
    } catch (e) {
      // Chunk read failed
    }
    if (chunkCache.size >= MAX_CHUNK_CACHE) {
      // Evict oldest entries
      const keys = Array.from(chunkCache.keys()).slice(0, 100);
      keys.forEach(k => chunkCache.delete(k));
    }
    chunkCache.set(key, chunk);
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
    if (tileCache.has(tileKey)) return tileCache.get(tileKey);

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

      // For small regions, read directly with readRegion (fast path)
      const MAX_DIRECT_PIXELS = 1024 * 1024; // 1M pixels max for direct read
      if (sliceW * sliceH <= MAX_DIRECT_PIXELS) {
        console.log(`[NISAR Loader] Tile ${tileKey}: direct read [${top}:${bottom}, ${left}:${right}] (${sliceW}x${sliceH})`);
        const regionResult = await streamReader.readRegion(selectedDatasetId, top, left, sliceH, sliceW);
        if (!regionResult?.data) return null;
        tileData = resampleToTileSize(regionResult.data, sliceW, sliceH, tileSize, NaN, multiLook);
      } else {
        // For large regions, sample by reading chunks
        const stepX = sliceW / tileSize;
        const stepY = sliceH / tileSize;
        tileData = new Float32Array(tileSize * tileSize);

        // multiLook=false → 1 sample (nearest-neighbour, instant preview)
        // multiLook=true  → 4–8 sub-samples per axis (16–64 look area average)
        const nSub = multiLook
          ? Math.min(Math.max(Math.round(Math.sqrt(stepX * stepY)), 4), 8)
          : 1;
        console.log(`[NISAR Loader] Tile ${tileKey}: chunk-sampled [${top}:${bottom}, ${left}:${right}] (${sliceW}x${sliceH}) ${multiLook ? 'multi-look' : 'preview'} samples=${nSub}x${nSub}`);

        for (let ty = 0; ty < tileSize; ty++) {
          for (let tx = 0; tx < tileSize; tx++) {
            let sum = 0, count = 0;

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
          }
        }
      }

      const tile = { data: tileData, width: tileSize, height: tileSize };

      // Cache tile
      if (tileCache.size >= MAX_TILE_CACHE) {
        const keys = Array.from(tileCache.keys()).slice(0, 50);
        keys.forEach(k => tileCache.delete(k));
      }
      tileCache.set(tileKey, tile);
      return tile;
    } catch (error) {
      console.error(`[NISAR Loader] Failed to load tile ${tileKey}:`, error);
      return null;
    }
  }

  // Read product identification metadata
  const identification = await readProductIdentification(streamReader, paths, activeFreq, 'streaming');

  const result = {
    getTile,
    bounds,
    crs,
    width,
    height,
    stats,
    fillValue: NaN,
    frequency,
    polarization,
    band,
    identification,
    availableDatasets,
    _streaming: true,
    _h5chunk: streamReader,
  };

  console.log('[NISAR Loader] NISAR GCOV loaded successfully (streaming mode):', {
    width, height, bounds, crs, frequency, polarization,
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

  // Open with h5chunk - use 32MB for cloud-optimized files
  const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);
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
  const { bounds, crs, width, height } = metadata;

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

  const result = {
    getTile,
    bounds,
    crs,
    width,
    height,
    stats,
    fillValue,
    frequency,
    polarization,
    band,
    identification,
    availableDatasets,
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
  const { bounds, crs } = metadata;

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

  // Open with h5chunk streaming (works for all file sizes)
  const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);
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
    console.log(`[NISAR Loader]   ${term} → ${dsId}`);
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

  const bounds = [0, 0, width, height];

  // Read CRS from spec path
  let crs = 'EPSG:32610'; // fallback
  try {
    const projId = streamReader.findDatasetByPath(paths.projection(activeFreq));
    if (projId != null) {
      const projData = await streamReader.readSmallDataset(projId);
      if (projData?.data?.[0] > 0) {
        crs = `EPSG:${projData.data[0]}`;
        console.log(`[NISAR Loader] RGB composite CRS: ${crs}`);
      }
    }
  } catch (e) {
    console.warn(`[NISAR Loader] Could not read projection, using fallback: ${crs}`);
  }

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

    let chunk = null;
    try {
      chunk = await streamReader.readChunk(dsId, chunkRow, chunkCol);
    } catch (e) {
      // Chunk read failed
    }

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
    if (tileCache.has(tileKey)) return tileCache.get(tileKey);

    try {
      const tileSize = 256;

      // Compute pixel region from bbox (same logic as single-band getTile)
      let left, top, right, bottom;
      if (bbox) {
        if (bbox.left !== undefined) {
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

      // multiLook=false → 1 sample (nearest); true → 4–8 sub-samples (area avg)
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

      if (tileCache.size >= MAX_TILE_CACHE) {
        const keys = Array.from(tileCache.keys()).slice(0, 25);
        keys.forEach(k => tileCache.delete(k));
      }
      tileCache.set(tileKey, tile);
      return tile;

    } catch (error) {
      console.error(`[NISAR Loader] Failed to load RGB tile:`, error);
      return null;
    }
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
    bounds,
    crs,
    width,
    height,
    composite: compositeId,
    band,
    identification,
    availableDatasets,
    _streaming: true,
    _h5chunk: streamReader,
  };

  console.log('[NISAR Loader] RGB composite loaded:', {
    width, height, bounds, crs, compositeId,
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

  // ── Strategy 1: Match from HDF5 path tail ──
  // NISAR paths: /science/{band}/GCOV/grids/frequency{f}/{term}
  let matchedFromPath = 0;

  for (const ds of datasets) {
    if (ds.path) {
      const tail = ds.path.split('/').pop();
      if (COV_TERM_SET.has(tail) && !polMap[tail]) {
        polMap[tail] = ds.id;
        matchedFromPath++;
        console.log(`[NISAR Loader] Matched ${tail} → ${ds.id} (path: ${ds.path})`);
      }
    }
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

export default loadNISARGCOV;
