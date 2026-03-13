/**
 * Shared NISAR L2 Product Utilities
 *
 * Product-agnostic infrastructure used by GCOV, GUNW loaders.
 * Handles product auto-detection, coordinate extraction, and render mode definitions.
 *
 * h5chunk is product-agnostic — all product-specific logic belongs here
 * or in the individual product loaders.
 */

import { openH5ChunkFile, openH5ChunkUrl } from './h5chunk.js';

// ─── SAR Band Constants ─────────────────────────────────────────────────

/** SAR bands — NISAR carries L-band (LSAR) and S-band (SSAR). */
export const SAR_BANDS = ['LSAR', 'SSAR'];

/** Known NISAR L2 product types. */
export const PRODUCT_TYPES = ['GCOV', 'GUNW', 'GOFF'];

// ─── Path Builders ──────────────────────────────────────────────────────

/**
 * Build spec-compliant HDF5 paths for any NISAR L2 product.
 *
 * @param {string} band — 'LSAR' or 'SSAR'
 * @param {string} productType — 'GCOV', 'GUNW', or 'GOFF'
 * @returns {Object} Path templates for product groups
 */
export function nisarPaths(band = 'LSAR', productType = 'GCOV') {
  const base = `/science/${band}/${productType}`;
  return {
    base,
    identification: `/science/${band}/identification`,
    grids: `${base}/grids`,
    freqGrid: (f) => `${base}/grids/frequency${f}`,
    dataset: (f, term) => `${base}/grids/frequency${f}/${term}`,
    metadata: `${base}/metadata`,
    processing: `${base}/metadata/processingInformation/parameters`,
    radarGrid: `${base}/metadata/radarGrid`,
    // Per-frequency grid metadata
    listOfPolarizations: (f) => `${base}/grids/frequency${f}/listOfPolarizations`,
    projection: (f) => `${base}/grids/frequency${f}/projection`,
    xCoordinates: (f) => `${base}/grids/frequency${f}/xCoordinates`,
    yCoordinates: (f) => `${base}/grids/frequency${f}/yCoordinates`,
    // Identification-level metadata
    listOfFrequencies: `/science/${band}/identification/listOfFrequencies`,
    productType: `/science/${band}/identification/productType`,
    boundingPolygon: `/science/${band}/identification/boundingPolygon`,
    absoluteOrbitNumber: `/science/${band}/identification/absoluteOrbitNumber`,
    trackNumber: `/science/${band}/identification/trackNumber`,
    frameNumber: `/science/${band}/identification/frameNumber`,
    lookDirection: `/science/${band}/identification/lookDirection`,
    orbitPassDirection: `/science/${band}/identification/orbitPassDirection`,
    zeroDopplerStartTime: `/science/${band}/identification/zeroDopplerStartTime`,
    zeroDopplerEndTime: `/science/${band}/identification/zeroDopplerEndTime`,
    missionId: `/science/${band}/identification/missionId`,
    granuleId: `/science/${band}/identification/granuleId`,
    productVersion: `/science/${band}/identification/productVersion`,
    isGeocoded: `/science/${band}/identification/isGeocoded`,
  };
}

// ─── Product Auto-Detection ─────────────────────────────────────────────

/**
 * Detect which SAR band (LSAR or SSAR) is present.
 *
 * @param {Array} h5Datasets — from streamReader.getDatasets()
 * @returns {string} 'LSAR' or 'SSAR'
 */
export function detectBand(h5Datasets) {
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    if (ds.path.includes('/SSAR/')) return 'SSAR';
    if (ds.path.includes('/LSAR/')) return 'LSAR';
  }
  return 'LSAR';
}

/**
 * Detect NISAR product type from an open h5chunk reader.
 * Reads /science/{band}/identification/productType, with fallback
 * to scanning dataset paths.
 *
 * @param {Object} streamReader — h5chunk reader
 * @returns {Promise<{band: string, productType: string}>}
 */
export async function detectNISARProduct(streamReader) {
  const h5Datasets = streamReader.getDatasets();
  const band = detectBand(h5Datasets);

  // Strategy 1: read productType dataset
  for (const b of [band, ...SAR_BANDS.filter(x => x !== band)]) {
    const path = `/science/${b}/identification/productType`;
    const dsId = streamReader.findDatasetByPath(path);
    if (dsId !== null) {
      try {
        const result = await streamReader.readSmallDataset(dsId);
        if (result?.data?.[0]) {
          const raw = String(result.data[0]).trim();
          // Normalize: "L2_GCOV" → "GCOV", "GCOV" → "GCOV"
          const productType = raw.replace(/^L2_/, '');
          if (PRODUCT_TYPES.includes(productType)) {
            return { band: b, productType };
          }
        }
      } catch (e) {
        console.warn(`[nisar-product] Failed to read productType at ${path}: ${e.message}`);
      }
    }
  }

  // Strategy 2: scan dataset paths for product-specific markers
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    if (ds.path.includes('/GUNW/')) return { band, productType: 'GUNW' };
    if (ds.path.includes('/GOFF/')) return { band, productType: 'GOFF' };
    if (ds.path.includes('/GCOV/')) return { band, productType: 'GCOV' };
  }

  return { band, productType: 'GCOV' }; // default
}

// ─── Frequency Detection ────────────────────────────────────────────────

/**
 * Detect which frequencies (A, B, or both) are present.
 */
export async function detectFrequencies(streamReader, h5Datasets, paths) {
  // Strategy 1: read listOfFrequencies metadata dataset
  const dsId = streamReader.findDatasetByPath(paths.listOfFrequencies);
  if (dsId) {
    try {
      const result = await streamReader.readSmallDataset(dsId);
      if (result?.data?.length > 0) {
        const freqs = result.data.filter(f => f === 'A' || f === 'B');
        if (freqs.length > 0) return freqs;
      }
    } catch (e) {
      // Fall through
    }
  }

  // Strategy 2: infer from dataset paths
  const freqs = new Set();
  for (const ds of h5Datasets) {
    if (!ds.path) continue;
    const m = ds.path.match(/frequency([AB])/);
    if (m) freqs.add(m[1]);
  }

  if (freqs.size > 0) return Array.from(freqs).sort();
  return ['A'];
}

// ─── EPSG Reading ───────────────────────────────────────────────────────

async function readEpsgFromProjection(streamReader, projPath) {
  // Strategy 1: read projection/epsg sub-dataset
  const epsgId = streamReader.findDatasetByPath(`${projPath}/epsg`);
  if (epsgId !== null) {
    try {
      const epsgResult = await streamReader.readSmallDataset(epsgId);
      if (epsgResult?.data?.[0]) return Number(epsgResult.data[0]);
    } catch (e) { /* fallback below */ }
  }

  // Strategy 2: projection dataset stores EPSG as scalar value
  const projDsId = streamReader.findDatasetByPath(projPath);
  if (projDsId !== null) {
    try {
      const projResult = await streamReader.readSmallDataset(projDsId);
      if (projResult?.data?.[0]) {
        const val = Number(projResult.data[0]);
        if (val > 1000) return val;
      }
    } catch (e) { /* fallback below */ }
  }

  return null;
}

function buildCoordResult(xArr, yArr, epsg) {
  const minX = Math.min(xArr[0], xArr[xArr.length - 1]);
  const maxX = Math.max(xArr[0], xArr[xArr.length - 1]);
  const minY = Math.min(yArr[0], yArr[yArr.length - 1]);
  const maxY = Math.max(yArr[0], yArr[yArr.length - 1]);

  return {
    bounds: [minX, minY, maxX, maxY],
    crs: `EPSG:${epsg}`,
    epsg,
    pixelSizeX: xArr.length > 1 ? Math.abs(xArr[1] - xArr[0]) : 1,
    pixelSizeY: yArr.length > 1 ? Math.abs(yArr[1] - yArr[0]) : 1,
    width: xArr.length,
    height: yArr.length,
    xCoords: xArr,
    yCoords: yArr,
  };
}

// ─── Coordinate Extraction ──────────────────────────────────────────────

/**
 * Extract coordinates for a specific sub-path (e.g. a GUNW layer).
 * Some products have per-layer coordinates at non-standard locations.
 */
export async function extractCoordinatesAtPath(streamReader, coordBasePath, paths, freq = 'A') {
  const xId = streamReader.findDatasetByPath(`${coordBasePath}/xCoordinates`);
  const yId = streamReader.findDatasetByPath(`${coordBasePath}/yCoordinates`);

  if (xId !== null && yId !== null) {
    const projPath = typeof paths.projection === 'function' ? paths.projection(freq) : paths.projection;
    let epsg = await readEpsgFromProjection(streamReader, projPath);
    if (!epsg) epsg = 4326;

    const coordOpts = { maxFetchSize: 256 * 1024 };
    const xCoords = await streamReader.readSmallDataset(xId, coordOpts);
    const yCoords = await streamReader.readSmallDataset(yId, coordOpts);
    if (!xCoords?.data || !yCoords?.data) return null;

    return buildCoordResult(xCoords.data, yCoords.data, epsg);
  }

  return null;
}

// ─── Render Mode Definitions ────────────────────────────────────────────

export const RENDER_MODES = {
  // GCOV — backscatter power (diagonal covariance terms)
  'gcov:diagonal': {
    transform: 'dB',
    colormap: 'grayscale',
    defaultRange: [-30, 0],
    unit: 'dB',
    nodata: [0, NaN],
  },
  'gcov:offdiagonal': {
    transform: 'dB',
    colormap: 'grayscale',
    defaultRange: [-40, -10],
    unit: 'dB',
    nodata: [0, NaN],
    isComplex: true,
  },

  // GUNW — interferometric products
  'gunw:unwrappedPhase': {
    transform: 'linear',
    colormap: 'rdbu',
    defaultRange: [-50, 50],  // ~6 fringes at L-band; refined from metadata if available
    unit: 'radians',
    nodata: [NaN],
  },
  'gunw:coherenceMagnitude': {
    transform: 'linear',
    colormap: 'viridis',
    defaultRange: [0, 1],
    unit: '',
    nodata: [NaN],
  },
  'gunw:connectedComponents': {
    transform: 'linear',
    colormap: 'label',
    defaultRange: [0, 255],
    unit: '',
    nodata: [0],
    isInteger: true,
  },
  'gunw:wrappedInterferogram': {
    transform: 'complexPhase',
    colormap: 'romaO',
    defaultRange: [-Math.PI, Math.PI],
    unit: 'radians',
    nodata: [NaN],
    isComplex: true,
  },
  'gunw:ionospherePhaseScreen': {
    transform: 'linear',
    colormap: 'rdbu',
    defaultRange: [-20, 20],
    unit: 'radians',
    nodata: [NaN],
  },
  'gunw:ionospherePhaseScreenUncertainty': {
    transform: 'linear',
    colormap: 'viridis',
    defaultRange: [0, 10],
    unit: 'radians',
    nodata: [NaN],
  },

  // GUNW — pixel offsets
  'gunw:slantRangeOffset': {
    transform: 'linear',
    colormap: 'rdbu',
    defaultRange: [-50, 50],
    unit: 'meters',
    nodata: [NaN],
  },
  'gunw:alongTrackOffset': {
    transform: 'linear',
    colormap: 'rdbu',
    defaultRange: [-100, 100],
    unit: 'meters',
    nodata: [NaN],
  },
  'gunw:correlationSurfacePeak': {
    transform: 'linear',
    colormap: 'viridis',
    defaultRange: [0, 1],
    unit: '',
    nodata: [NaN],
  },
};

/**
 * Get render mode for a given product + dataset combination.
 */
export function getRenderMode(productType, datasetName) {
  const key = `${productType.toLowerCase()}:${datasetName}`;
  if (RENDER_MODES[key]) return RENDER_MODES[key];

  // GCOV: classify diagonal vs off-diagonal by term name
  if (productType === 'GCOV') {
    const DIAGONAL = new Set(['HHHH', 'HVHV', 'VHVH', 'VVVV', 'RHRH', 'RVRV']);
    if (DIAGONAL.has(datasetName)) return RENDER_MODES['gcov:diagonal'];
    return RENDER_MODES['gcov:offdiagonal'];
  }

  // Default fallback
  return {
    transform: 'linear',
    colormap: 'grayscale',
    defaultRange: null,
    unit: '',
    nodata: [NaN],
  };
}

// ─── Shared Processing Utilities ────────────────────────────────────────

/**
 * Extract phase from interleaved CFloat32 data.
 * Input: Float32Array [r1, i1, r2, i2, ...]
 * Output: Float32Array [phase1, phase2, ...]
 */
export function extractPhaseFromComplex(data, rows, cols) {
  const pixelCount = rows * cols;
  const phase = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const re = data[2 * i];
    const im = data[2 * i + 1];
    phase[i] = Math.atan2(im, re);
  }
  return phase;
}

/**
 * Extract magnitude from interleaved CFloat32 data.
 */
export function extractMagnitudeFromComplex(data, rows, cols) {
  const pixelCount = rows * cols;
  const mag = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const re = data[2 * i];
    const im = data[2 * i + 1];
    mag[i] = Math.sqrt(re * re + im * im);
  }
  return mag;
}

/**
 * Simple box-filter multilook for Float32 data.
 */
export function multilookFloat32(data, rows, cols, ml) {
  const outRows = Math.floor(rows / ml);
  const outCols = Math.floor(cols / ml);
  const out = new Float32Array(outRows * outCols);
  for (let r = 0; r < outRows; r++) {
    for (let c = 0; c < outCols; c++) {
      let sum = 0, count = 0;
      for (let dr = 0; dr < ml; dr++) {
        for (let dc = 0; dc < ml; dc++) {
          const val = data[(r * ml + dr) * cols + (c * ml + dc)];
          if (!isNaN(val)) { sum += val; count++; }
        }
      }
      out[r * outCols + c] = count > 0 ? sum / count : NaN;
    }
  }
  return { data: out, width: outCols, height: outRows };
}

// ─── Reader Entry Point ─────────────────────────────────────────────────

/**
 * Open an h5chunk reader for a file or URL.
 */
export async function openNISARReader(source) {
  if (typeof source === 'string' && (source.startsWith('http://') || source.startsWith('https://'))) {
    return await openH5ChunkUrl(source);
  }
  return await openH5ChunkFile(source);
}
