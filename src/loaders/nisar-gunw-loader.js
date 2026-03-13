/**
 * NISAR GUNW (Geocoded Unwrapped Interferogram) Loader
 *
 * Loads NISAR Level-2 GUNW HDF5 files via h5chunk streaming.
 * GUNW products contain interferometric phase, coherence, and pixel offsets
 * from InSAR processing of paired SAR acquisitions.
 *
 * Key structural difference from GCOV:
 * - Three layer groups: unwrappedInterferogram (80m), wrappedInterferogram (20m), pixelOffsets (80m)
 * - Dual resolution: unwrapped/offsets at 80m, wrapped at 20m posting
 * - Per-polarization coordinate arrays (inside each pol group, not at frequency level)
 * - CFloat32 datasets (wrappedInterferogram) require phase/magnitude extraction
 *
 * Product spec: JPL D-102272 Rev E, November 2024
 * See: docs/NISAR_GUNW.md
 */

import {
  nisarPaths,
  detectBand,
  detectFrequencies,
  extractCoordinatesAtPath,
  getRenderMode,
  extractPhaseFromComplex,
  multilookFloat32,
  openNISARReader,
} from './nisar-product.js';

// ─── GUNW Layer Definitions ─────────────────────────────────────────────

/**
 * GUNW layer groups and their datasets.
 * Per spec §2, Table 3-1 (JPL D-102272 Rev E).
 */
const GUNW_LAYERS = {
  unwrappedInterferogram: {
    datasets: [
      'unwrappedPhase',
      'coherenceMagnitude',
      'connectedComponents',
      'ionospherePhaseScreen',
      'ionospherePhaseScreenUncertainty',
    ],
    posting: '80m',
  },
  wrappedInterferogram: {
    datasets: ['wrappedInterferogram', 'coherenceMagnitude'],
    posting: '20m',
  },
  pixelOffsets: {
    datasets: ['slantRangeOffset', 'alongTrackOffset', 'correlationSurfacePeak'],
    posting: '80m',
  },
};

/** Human-readable layer names for the UI. */
export const GUNW_LAYER_LABELS = {
  unwrappedInterferogram: 'Unwrapped Interferogram (80 m)',
  wrappedInterferogram: 'Wrapped Interferogram (20 m)',
  pixelOffsets: 'Pixel Offsets (80 m)',
};

/** Human-readable dataset names for the UI. */
export const GUNW_DATASET_LABELS = {
  unwrappedPhase: 'Unwrapped Phase',
  coherenceMagnitude: 'Coherence',
  connectedComponents: 'Connected Components',
  ionospherePhaseScreen: 'Ionosphere Phase Screen',
  ionospherePhaseScreenUncertainty: 'Iono. Uncertainty',
  wrappedInterferogram: 'Wrapped Interferogram',
  slantRangeOffset: 'Slant Range Offset',
  alongTrackOffset: 'Along-Track Offset',
  correlationSurfacePeak: 'Correlation Peak',
};

// ─── Dataset Discovery ──────────────────────────────────────────────────

/**
 * List available layers and datasets in a GUNW file.
 *
 * Returns structured metadata about all discoverable datasets,
 * including per-layer coordinates (which may differ in resolution).
 *
 * @param {File|Object|string} file — HDF5 file or URL
 * @param {Object} [options]
 * @param {string} [options.band='LSAR']
 * @param {Object} [options._streamReader] — pre-opened h5chunk reader
 * @returns {Promise<Object>} Dataset listing
 */
/**
 * Read GUNW-specific metadata from HDF5.
 * Reads identification fields + GUNW-specific fields (centerFrequency, temporal baseline, dates).
 */
async function readGUNWMetadata(streamReader, paths, freq = 'A') {
  const meta = {};
  const base = paths.base;

  // Helper: read a small scalar dataset
  const readScalar = async (path) => {
    try {
      const dsId = streamReader.findDatasetByPath(path);
      if (dsId == null) return undefined;
      const result = await streamReader.readSmallDataset(dsId);
      if (!result?.data?.length) return undefined;
      const v = result.data[0];
      if (typeof v === 'string') return v.trim() || undefined;
      if (typeof v === 'number' && !isNaN(v)) return v;
      // Try decoding raw bytes as string
      if (result.data.buffer) {
        const bytes = new Uint8Array(result.data.buffer);
        let str = '';
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] === 0) break;
          str += String.fromCharCode(bytes[i]);
        }
        return str.trim() || undefined;
      }
      return v;
    } catch { return undefined; }
  };

  // Read all fields in parallel
  const fields = [
    // Identification
    { key: 'lookDirection', path: paths.lookDirection },
    { key: 'orbitPassDirection', path: paths.orbitPassDirection },
    { key: 'trackNumber', path: paths.trackNumber },
    { key: 'frameNumber', path: paths.frameNumber },
    { key: 'boundingPolygon', path: paths.boundingPolygon },
    { key: 'granuleId', path: paths.granuleId },
    { key: 'productVersion', path: paths.productVersion },
    // GUNW-specific identification
    { key: 'referenceZeroDopplerStartTime', path: `${paths.identification}/referenceZeroDopplerStartTime` },
    { key: 'secondaryZeroDopplerStartTime', path: `${paths.identification}/secondaryZeroDopplerStartTime` },
    { key: 'referenceAbsoluteOrbitNumber', path: `${paths.identification}/referenceAbsoluteOrbitNumber` },
    { key: 'secondaryAbsoluteOrbitNumber', path: `${paths.identification}/secondaryAbsoluteOrbitNumber` },
    // Frequency metadata
    { key: 'centerFrequency', path: `${base}/grids/frequency${freq}/centerFrequency` },
    // Orbit metadata
    { key: 'temporalBaseline', path: `${base}/metadata/orbit/temporalBaseline` },
  ];

  const results = await Promise.all(fields.map(f => readScalar(f.path)));
  for (let i = 0; i < fields.length; i++) {
    if (results[i] != null && results[i] !== undefined) {
      meta[fields[i].key] = results[i];
    }
  }

  // Compute wavelength from center frequency (speed of light / freq)
  if (meta.centerFrequency && typeof meta.centerFrequency === 'number') {
    meta.wavelength = 299792458.0 / meta.centerFrequency;
  }

  return meta;
}

export async function listNISARGUNWDatasets(file, options = {}) {
  const { band = 'LSAR', _streamReader } = options;
  const streamReader = _streamReader || await openNISARReader(file);
  const paths = nisarPaths(band, 'GUNW');
  const h5Datasets = streamReader.getDatasets();

  // Discover frequencies
  const frequencies = await detectFrequencies(streamReader, h5Datasets, paths);

  // Read product metadata in parallel with dataset discovery
  const activeFreq = frequencies[0] || 'A';
  const metadataPromise = readGUNWMetadata(streamReader, paths, activeFreq);

  const datasets = [];
  const coordinatesByLayer = {};

  for (const freq of frequencies) {
    const freqGrid = paths.freqGrid(freq);

    for (const [layerName, layerConfig] of Object.entries(GUNW_LAYERS)) {
      const layerPath = `${freqGrid}/${layerName}`;

      // Discover polarizations in this layer by scanning dataset paths
      const polsInLayer = new Set();
      for (const ds of h5Datasets) {
        if (!ds.path || !ds.path.startsWith(layerPath + '/')) continue;
        const relPath = ds.path.slice(layerPath.length + 1);
        const parts = relPath.split('/');
        // Polarization is the first path component under the layer
        // Skip 'mask' which is at the layer level, not under a pol
        if (parts.length >= 2 && parts[0] !== 'mask') {
          polsInLayer.add(parts[0]);
        }
      }

      for (const pol of polsInLayer) {
        const polPath = `${layerPath}/${pol}`;

        // Extract per-polarization coordinates
        const coordKey = `${freq}/${layerName}/${pol}`;
        const coords = await extractCoordinatesAtPath(streamReader, polPath, paths, freq);
        if (coords) {
          coordinatesByLayer[coordKey] = coords;
        }

        // Enumerate datasets for this polarization
        for (const dsName of layerConfig.datasets) {
          const dsPath = `${polPath}/${dsName}`;
          const dsId = streamReader.findDatasetByPath(dsPath);
          if (dsId !== null) {
            const dsMeta = h5Datasets.find(d => d.id === dsId);
            datasets.push({
              frequency: freq,
              layer: layerName,
              polarization: pol,
              dataset: dsName,
              path: dsPath,
              shape: dsMeta?.shape,
              dtype: dsMeta?.dtype,
              posting: layerConfig.posting,
              renderMode: getRenderMode('GUNW', dsName),
            });
          }
        }
      }
    }
  }

  // Await metadata (was started in parallel with dataset discovery)
  const metadata = await metadataPromise;

  console.log('[nisar-gunw] Product metadata:', metadata);

  return {
    source: file.name || file,
    productType: 'GUNW',
    band,
    frequencies: [...frequencies],
    datasets,
    coordinatesByLayer,
    metadata,
    _streamReader: streamReader,
  };
}

// ─── Dataset Loading ────────────────────────────────────────────────────

/**
 * Load a GUNW dataset for tile access and export.
 *
 * @param {File|Object|string} file
 * @param {Object} options
 * @param {string} [options.band='LSAR']
 * @param {string} [options.layer='unwrappedInterferogram']
 * @param {string} [options.polarization='HH']
 * @param {string} [options.dataset='unwrappedPhase']
 * @param {string} [options.frequency='A']
 * @param {number} [options.multilook=1]
 * @param {Object} [options._streamReader]
 * @returns {Promise<Object>} Loaded dataset with getTile/getExportStripe
 */
export async function loadNISARGUNW(file, options = {}) {
  const {
    band = 'LSAR',
    layer = 'unwrappedInterferogram',
    polarization = 'HH',
    dataset = 'unwrappedPhase',
    frequency = 'A',
    multilook = 1,
    withCoherence = false,
    _streamReader,
  } = options;

  const streamReader = _streamReader || await openNISARReader(file);
  const paths = nisarPaths(band, 'GUNW');

  // Build dataset path
  const polPath = `${paths.freqGrid(frequency)}/${layer}/${polarization}`;
  const dsPath = `${polPath}/${dataset}`;
  const dsId = streamReader.findDatasetByPath(dsPath);
  if (dsId === null) {
    throw new Error(`Dataset not found: ${dsPath}`);
  }

  // Get dataset metadata
  const h5Datasets = streamReader.getDatasets();
  const dsMeta = h5Datasets.find(d => d.id === dsId);
  if (!dsMeta?.shape || dsMeta.shape.length < 2) {
    throw new Error(`Invalid dataset shape for ${dsPath}`);
  }
  const [height, width] = dsMeta.shape;

  // Get per-polarization coordinates
  const coords = await extractCoordinatesAtPath(streamReader, polPath, paths, frequency);

  // Render mode for this dataset type
  const renderMode = getRenderMode('GUNW', dataset);

  // Read dataset attributes (valid_min, valid_max, units, _FillValue, etc.)
  const dsAttrs = streamReader.getDatasetAttributes?.(dsId)
    || streamReader.getAttributes?.(dsPath) || null;

  // Resolve coherence dataset ID if requested (same layer + pol, coherenceMagnitude)
  let cohDsId = null;
  if (withCoherence && dataset !== 'coherenceMagnitude') {
    // Coherence lives in unwrappedInterferogram layer at the same polarization
    const cohLayer = 'unwrappedInterferogram';
    const cohPolPath = `${paths.freqGrid(frequency)}/${cohLayer}/${polarization}`;
    const cohPath = `${cohPolPath}/coherenceMagnitude`;
    cohDsId = streamReader.findDatasetByPath(cohPath);
    if (cohDsId === null) {
      console.warn(`[nisar-gunw] Coherence dataset not found at ${cohPath}`);
    }
  }

  // Bounds for bbox → pixel conversion (same as GCOV loader)
  const bounds = coords?.bounds || [0, 0, width, height];

  // Build getTile function — supports both pixel-grid and bbox-based access.
  // bbox-based access is used by histogram sampling (sampleViewportStats).
  async function getTile({ x, y, z, bbox, tileSize = 256 }) {
    let left, top, right, bottom;

    if (bbox && bbox.left !== undefined) {
      // World-coordinate bbox → pixel coordinates
      const [bMinX, bMinY, bMaxX, bMaxY] = bounds;
      const bSpanX = bMaxX - bMinX || 1;
      const bSpanY = bMaxY - bMinY || 1;
      left = Math.max(0, Math.floor(((bbox.left - bMinX) / bSpanX) * width));
      right = Math.min(width, Math.ceil(((bbox.right - bMinX) / bSpanX) * width));
      // Y: world Y increases north, image rows increase south
      top = Math.max(0, Math.floor(((bMaxY - bbox.bottom) / bSpanY) * height));
      bottom = Math.min(height, Math.ceil(((bMaxY - bbox.top) / bSpanY) * height));
    } else {
      // Pixel tile-grid access
      left = x * tileSize;
      top = y * tileSize;
      right = Math.min(left + tileSize, width);
      bottom = Math.min(top + tileSize, height);
    }

    const numCols = right - left;
    const numRows = bottom - top;
    if (numRows <= 0 || numCols <= 0) return null;

    const region = await streamReader.readRegion(dsId, top, left, numRows, numCols);
    let data = region.data || region;

    // Handle complex data: extract phase from CFloat32
    if (renderMode.isComplex && renderMode.transform === 'complexPhase') {
      data = extractPhaseFromComplex(data, numRows, numCols);
    }

    const result = { data, width: numCols, height: numRows };

    // Fetch coherence data for the same tile region
    if (cohDsId !== null) {
      try {
        const cohRegion = await streamReader.readRegion(cohDsId, top, left, numRows, numCols);
        result.coherenceData = cohRegion.data || cohRegion;
      } catch (e) {
        // Non-fatal: proceed without coherence
      }
    }

    return result;
  }

  // Build getExportStripe for full-width row export
  async function getExportStripe({ startRow, numRows, ml = 1 }) {
    const region = await streamReader.readRegion(dsId, startRow, 0, numRows, width);
    let data = region.data || region;

    // Handle complex data
    if (renderMode.isComplex && renderMode.transform === 'complexPhase') {
      data = extractPhaseFromComplex(data, numRows, width);
    }

    if (ml > 1) {
      return multilookFloat32(data, numRows, width, ml);
    }
    return { data, width, height: numRows };
  }

  // Coherence loader: reads coherenceMagnitude from the same layer+pol path.
  // Returns full-extent Float32Array for GPU texture upload.
  async function loadCoherenceData() {
    // Coherence lives in the unwrappedInterferogram layer at the same pol
    const cohLayer = 'unwrappedInterferogram';
    const cohPolPath = `${paths.freqGrid(frequency)}/${cohLayer}/${polarization}`;
    const cohDsPath = `${cohPolPath}/coherenceMagnitude`;
    const cohDsId = streamReader.findDatasetByPath(cohDsPath);
    if (cohDsId === null) return null;

    const cohMeta = h5Datasets.find(d => d.id === cohDsId);
    if (!cohMeta?.shape || cohMeta.shape.length < 2) return null;

    const [cohH, cohW] = cohMeta.shape;
    try {
      const region = await streamReader.readRegion(cohDsId, 0, 0, cohH, cohW);
      return {
        data: region.data || region,
        width: cohW,
        height: cohH,
      };
    } catch (e) {
      console.warn('[nisar-gunw] Failed to load coherence data:', e.message);
      return null;
    }
  }

  // Build getPixelValue for the pixel explorer tooltip
  async function getPixelValue(row, col, windowSize = 1) {
    if (row < 0 || row >= height || col < 0 || col >= width) return null;
    const half = Math.floor(windowSize / 2);
    const r0 = Math.max(0, row - half);
    const c0 = Math.max(0, col - half);
    const r1 = Math.min(height, r0 + windowSize);
    const c1 = Math.min(width, c0 + windowSize);
    const nRows = r1 - r0;
    const nCols = c1 - c0;

    try {
      const region = await streamReader.readRegion(dsId, r0, c0, nRows, nCols);
      let data = region.data || region;

      // Handle complex data: extract phase
      if (renderMode.isComplex && renderMode.transform === 'complexPhase') {
        data = extractPhaseFromComplex(data, nRows, nCols);
      }

      if (windowSize <= 1) return data[0];

      // Average the window (skip NaN/nodata)
      let sum = 0, count = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!isNaN(v)) { sum += v; count++; }
      }
      return count > 0 ? sum / count : NaN;
    } catch {
      return null;
    }
  }

  return {
    productType: 'GUNW',
    band,
    layer,
    polarization,
    dataset,
    frequency,
    bounds,
    worldBounds: coords?.bounds || null,
    crs: coords?.crs,
    epsg: coords?.epsg,
    xCoords: coords?.xCoords || null,
    yCoords: coords?.yCoords || null,
    width,
    height,
    shape: [height, width],
    renderMode,
    attributes: dsAttrs,
    getTile,
    getPixelValue,
    getExportStripe,
    loadCoherenceData,
    _streamReader: streamReader,
  };
}
