/**
 * NISAR GCOV HDF5 Loader
 *
 * Loads NISAR Level-2 Geocoded Polarimetric Covariance (GCOV) HDF5 files
 * and provides a tile fetcher compatible with the existing SARdine viewer.
 *
 * Based on JPL D-102274 Rev E - NASA SDS Product Specification L2 GCOV
 */

import h5wasm from 'h5wasm';

// NISAR GCOV HDF5 path constants
const GCOV_BASE = '/science/LSAR/GCOV';
const GRID_PATH = `${GCOV_BASE}/grids`;
const METADATA_PATH = `${GCOV_BASE}/metadata`;
const PROCESSING_PARAMS = `${METADATA_PATH}/processingInformation/parameters`;

// Standard polarization datasets in GCOV products
const POLARIZATIONS = ['HHHH', 'HVHV', 'VHVH', 'VVVV', 'HHHV', 'HHVH', 'HHVV', 'HVVH', 'HVVV', 'VHVV'];

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
 * Open an HDF5 file from a File object
 * @param {File} file - Local file from input[type="file"]
 * @returns {Promise<h5wasm.File>}
 */
async function openHDF5File(file) {
  const H5 = await initH5wasm();

  console.log(`[NISAR Loader] Loading HDF5 file: ${file.name} (${(file.size / 1e9).toFixed(2)} GB)`);

  // Warning for large files
  if (file.size > 500 * 1024 * 1024) {
    console.warn('[NISAR Loader] Large file detected. This may use significant memory.');
  }

  const arrayBuffer = await file.arrayBuffer();
  console.log('[NISAR Loader] ArrayBuffer loaded, opening HDF5...');

  return new H5.File(arrayBuffer, file.name);
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
 * List available datasets in a NISAR GCOV file
 * @param {File} file - HDF5 file
 * @returns {Promise<Array<{frequency: string, polarization: string}>>}
 */
export async function listNISARDatasets(file) {
  console.log('[NISAR Loader] Listing available datasets...');

  const h5file = await openHDF5File(file);
  const datasets = [];

  try {
    for (const freq of ['A', 'B']) {
      const freqPath = `${GRID_PATH}/frequency${freq}`;
      const freqGroup = safeGet(h5file, freqPath);

      if (freqGroup) {
        for (const pol of POLARIZATIONS) {
          const datasetPath = `${freqPath}/${pol}`;
          const dataset = safeGet(h5file, datasetPath);

          if (dataset && dataset.shape && dataset.shape.length === 2) {
            datasets.push({ frequency: freq, polarization: pol });
            console.log(`[NISAR Loader] Found dataset: frequency${freq}/${pol}`);
          }
        }
      }
    }
  } finally {
    // Note: h5wasm doesn't have a close() method for in-memory files
  }

  console.log(`[NISAR Loader] Found ${datasets.length} datasets`);
  return datasets;
}

/**
 * Extract geospatial metadata from NISAR GCOV file
 */
async function extractMetadata(h5file, frequency) {
  console.log('[NISAR Loader] Extracting metadata...');

  // Get projection info
  const projPath = `${PROCESSING_PARAMS}/frequency${frequency}/projection`;
  let projDataset = safeGet(h5file, projPath);

  // Fallback to general projection path
  if (!projDataset) {
    projDataset = safeGet(h5file, `${PROCESSING_PARAMS}/projection`);
  }

  // Also check radar grid projection
  if (!projDataset) {
    projDataset = safeGet(h5file, `${METADATA_PATH}/radarGrid/projection`);
  }

  let epsgCode = 4326; // Default to WGS84
  let utmZone = null;

  if (projDataset) {
    epsgCode = safeGetAttr(projDataset, 'epsg_code') || epsgCode;
    utmZone = safeGetAttr(projDataset, 'utm_zone_number');
    console.log(`[NISAR Loader] Projection: EPSG:${epsgCode}, UTM Zone: ${utmZone}`);
  }

  // Get coordinate arrays - try frequency-specific first, then general
  let xCoordsPath = `${PROCESSING_PARAMS}/frequency${frequency}/xCoordinates`;
  let yCoordsPath = `${PROCESSING_PARAMS}/frequency${frequency}/yCoordinates`;

  let xCoordsDataset = safeGet(h5file, xCoordsPath);
  let yCoordsDataset = safeGet(h5file, yCoordsPath);

  // Fallback to general coordinate paths
  if (!xCoordsDataset) {
    xCoordsPath = `${PROCESSING_PARAMS}/xCoordinates`;
    yCoordsPath = `${PROCESSING_PARAMS}/yCoordinates`;
    xCoordsDataset = safeGet(h5file, xCoordsPath);
    yCoordsDataset = safeGet(h5file, yCoordsPath);
  }

  // Try radar grid coordinates
  if (!xCoordsDataset) {
    xCoordsPath = `${METADATA_PATH}/radarGrid/xCoordinates`;
    yCoordsPath = `${METADATA_PATH}/radarGrid/yCoordinates`;
    xCoordsDataset = safeGet(h5file, xCoordsPath);
    yCoordsDataset = safeGet(h5file, yCoordsPath);
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
    // Get dimensions from a dataset
    const sampleDataset = safeGet(h5file, `${GRID_PATH}/frequency${frequency}/HHHH`) ||
                          safeGet(h5file, `${GRID_PATH}/frequency${frequency}/VVVV`);

    if (sampleDataset && sampleDataset.shape) {
      height = sampleDataset.shape[0];
      width = sampleDataset.shape[1];
      console.log(`[NISAR Loader] Dimensions from dataset: ${width}x${height}`);
    } else {
      throw new Error('Could not determine image dimensions');
    }

    // Try to get bounding box from metadata
    const bboxPath = `${METADATA_PATH}/ceosAnalysisReadyData/boundingBox`;
    const bboxDataset = safeGet(h5file, bboxPath);

    if (bboxDataset) {
      const bboxWKT = bboxDataset.value;
      console.log(`[NISAR Loader] Bounding box WKT: ${bboxWKT}`);
      bounds = parseBoundingBoxWKT(bboxWKT);
    } else {
      // Use dummy bounds - this shouldn't happen with valid GCOV files
      console.warn('[NISAR Loader] Could not find coordinate or bounding box info');
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
 * Bilinear resampling to target tile size
 */
function resampleToTileSize(srcData, srcWidth, srcHeight, tileSize, fillValue) {
  const dstData = new Float32Array(tileSize * tileSize);

  const scaleX = srcWidth / tileSize;
  const scaleY = srcHeight / tileSize;

  for (let dstY = 0; dstY < tileSize; dstY++) {
    for (let dstX = 0; dstX < tileSize; dstX++) {
      const srcX = dstX * scaleX;
      const srcY = dstY * scaleY;

      // Bilinear interpolation
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

      // Handle fill values
      const values = [v00, v10, v01, v11];
      const isValid = v => v !== fillValue && !isNaN(v) && isFinite(v);
      const validValues = values.filter(isValid);

      if (validValues.length === 0) {
        dstData[dstY * tileSize + dstX] = 0; // Use 0 for no-data
      } else if (validValues.length < 4) {
        // Use nearest valid value
        dstData[dstY * tileSize + dstX] = validValues[0];
      } else {
        // Full bilinear interpolation
        const value =
          v00 * (1 - fx) * (1 - fy) +
          v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy +
          v11 * fx * fy;
        dstData[dstY * tileSize + dstX] = value;
      }
    }
  }

  return dstData;
}

/**
 * Load a NISAR GCOV HDF5 file and return a tile fetcher for deck.gl
 * @param {File} file - Local File object from input[type="file"]
 * @param {Object} options - Loading options
 * @param {string} options.frequency - 'A' or 'B' (default: 'A')
 * @param {string} options.polarization - 'HHHH', 'HVHV', 'VHVH', 'VVVV', etc. (default: 'HHHH')
 * @returns {Promise<{getTile: Function, bounds: Array, crs: string, width: number, height: number, stats: Object, availableDatasets: Array}>}
 */
export async function loadNISARGCOV(file, options = {}) {
  const {
    frequency = 'A',
    polarization = 'HHHH',
  } = options;

  console.log(`[NISAR Loader] Loading NISAR GCOV: ${file.name}`);
  console.log(`[NISAR Loader] Dataset: frequency${frequency}/${polarization}`);

  const h5file = await openHDF5File(file);

  // Get available datasets
  const availableDatasets = [];
  for (const freq of ['A', 'B']) {
    for (const pol of POLARIZATIONS) {
      const dataset = safeGet(h5file, `${GRID_PATH}/frequency${freq}/${pol}`);
      if (dataset && dataset.shape && dataset.shape.length === 2) {
        availableDatasets.push({ frequency: freq, polarization: pol });
      }
    }
  }

  // Get the requested dataset
  const datasetPath = `${GRID_PATH}/frequency${frequency}/${polarization}`;
  const dataset = safeGet(h5file, datasetPath);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  console.log(`[NISAR Loader] Dataset shape: [${dataset.shape.join(', ')}]`);
  console.log(`[NISAR Loader] Dataset dtype: ${dataset.dtype}`);

  // Extract metadata
  const metadata = await extractMetadata(h5file, frequency);
  const { bounds, crs, width, height, pixelSizeX, pixelSizeY } = metadata;

  // Get dataset statistics and fill value
  const stats = getDatasetStats(dataset);
  const fillValue = safeGetAttr(dataset, '_FillValue') || NaN;

  console.log('[NISAR Loader] Stats from attributes:', stats);
  console.log('[NISAR Loader] Fill value:', fillValue);

  // Store dataset reference for getTile
  const datasetRef = { h5file, dataset, path: datasetPath };

  /**
   * Get tile data for deck.gl TileLayer
   */
  async function getTile({ x, y, z }) {
    try {
      const tileSize = 256;

      // Calculate pixel coordinates for this tile
      // For projected coordinates, we need to handle this differently
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

      // Read slice from HDF5 dataset using h5wasm
      // h5wasm slice: dataset.slice([[start, stop], [start, stop]])
      const sliceData = datasetRef.dataset.slice([[top, bottom], [left, right]]);

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
    availableDatasets,
    // Store reference for cleanup
    _h5file: h5file,
  };

  console.log('[NISAR Loader] NISAR GCOV loaded successfully:', {
    width,
    height,
    bounds,
    crs,
    frequency,
    polarization,
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

  const h5file = await openHDF5File(file);

  // Get the requested dataset
  const datasetPath = `${GRID_PATH}/frequency${frequency}/${polarization}`;
  const dataset = safeGet(h5file, datasetPath);

  if (!dataset) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  const [fullHeight, fullWidth] = dataset.shape;

  // Extract metadata
  const metadata = await extractMetadata(h5file, frequency);
  const { bounds, crs } = metadata;

  // Calculate downsample factor
  const maxDim = Math.max(fullWidth, fullHeight);
  const downsampleFactor = maxDim > maxSize ? Math.ceil(maxDim / maxSize) : 1;

  const width = Math.ceil(fullWidth / downsampleFactor);
  const height = Math.ceil(fullHeight / downsampleFactor);

  console.log(`[NISAR Loader] Downsampling ${fullWidth}x${fullHeight} to ${width}x${height} (factor: ${downsampleFactor})`);

  // Read with stride for downsampling
  // h5wasm doesn't support stride directly, so we read full and downsample
  // For very large files, we should read in chunks

  let data;
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

export default loadNISARGCOV;
