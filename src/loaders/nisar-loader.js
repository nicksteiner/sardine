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
 * Based on JPL D-102274 Rev E - NASA SDS Product Specification L2 GCOV
 */

import h5wasm from 'h5wasm';
import { openH5ChunkFile } from './h5chunk.js';

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
 * List available datasets in a NISAR GCOV file
 * Uses streaming for large files, full load for small files
 * @param {File} file - HDF5 file
 * @returns {Promise<Array<{frequency: string, polarization: string}>>}
 */
export async function listNISARDatasets(file) {
  console.log('[NISAR Loader] Listing available datasets...');
  console.log(`[NISAR Loader] File size: ${(file.size / 1e6).toFixed(1)} MB`);

  // For large files, we MUST use streaming - h5wasm will crash
  const MAX_FULL_LOAD_SIZE = 500 * 1024 * 1024; // 500MB
  if (file.size > MAX_FULL_LOAD_SIZE) {
    console.log('[NISAR Loader] Large file - using streaming mode (h5wasm would crash)');

    try {
      // Use 32MB metadata read for NISAR cloud-optimized files
      const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);
      const h5Datasets = streamReader.getDatasets();

      console.log(`[h5chunk] Found ${h5Datasets.length} datasets`);
      h5Datasets.forEach(d => {
        console.log(`[h5chunk]   - ${d.id}: ${d.shape?.join('x')} ${d.dtype}, ${d.numChunks} chunks`);
      });

      // For now, return a default NISAR dataset structure
      // TODO: Parse actual NISAR paths from h5chunk metadata
      // The user's file likely has frequencyA datasets
      const defaultDatasets = [
        { frequency: 'A', polarization: 'HHHH' },
        { frequency: 'A', polarization: 'HVHV' },
        { frequency: 'A', polarization: 'VHVH' },
        { frequency: 'A', polarization: 'VVVV' },
      ];

      console.log('[NISAR Loader] Returning default dataset list (streaming mode)');
      return defaultDatasets;

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
  } catch (e) {
    console.error('[NISAR Loader] Error listing datasets:', e);
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

  // Find a suitable 2D dataset for visualization
  let selectedDataset = null;
  let selectedDatasetId = null;

  for (const ds of h5Datasets) {
    if (ds.shape && ds.shape.length === 2) {
      const [h, w] = ds.shape;
      if (w >= 1000 && h >= 1000) {
        console.log(`[NISAR Loader] Found candidate dataset: ${ds.id} (${w}x${h})`);
        if (!selectedDataset || (w * h > selectedDataset.shape[0] * selectedDataset.shape[1])) {
          selectedDataset = ds;
          selectedDatasetId = ds.id;
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
  const crs = 'EPSG:32610';

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

  const availableDatasets = [
    { frequency: 'A', polarization: 'HHHH' },
    { frequency: 'A', polarization: 'HVHV' },
    { frequency: 'A', polarization: 'VHVH' },
    { frequency: 'A', polarization: 'VVVV' },
  ];

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
  async function getTile({ x, y, z, bbox, quality }) {
    const q = quality || 'fast';
    const tileKey = `${x},${y},${z},${q}`;
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
        tileData = resampleToTileSize(regionResult.data, sliceW, sliceH, tileSize, NaN);
      } else {
        // For large regions, sample by reading chunks
        const stepX = sliceW / tileSize;
        const stepY = sliceH / tileSize;
        tileData = new Float32Array(tileSize * tileSize);

        // High quality: block-average NxN sub-samples per output pixel
        // Fast: single nearest-neighbor sample
        const nSub = q === 'high'
          ? Math.min(Math.max(Math.round(Math.sqrt(stepX * stepY)), 2), 8)
          : 1;
        console.log(`[NISAR Loader] Tile ${tileKey}: chunk-sampled [${top}:${bottom}, ${left}:${right}] (${sliceW}x${sliceH}) quality=${q} samples=${nSub}x${nSub}`);

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

  // Find a suitable 2D dataset
  let selectedDataset = null;
  let selectedDatasetId = null;

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
  const crs = 'EPSG:32610';

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
    console.log(`[NISAR Loader]   ${d.id}: ${d.shape?.join('x')} ${d.dtype}, ${d.numChunks} chunks`);
  });

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

  // Map h5chunk dataset IDs to polarizations.
  // Strategy: read a center sample from each dataset and classify by power level.
  // Cross-pol (HV, VH) is typically 5-15 dB below co-pol (HH, VV).
  const polMap = await classifyDatasets(streamReader, matchingDatasets);

  console.log('[NISAR Loader] Dataset → polarization mapping:');
  for (const [pol, dsId] of Object.entries(polMap)) {
    console.log(`[NISAR Loader]   ${pol} → ${dsId}`);
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
  const crs = 'EPSG:32610';

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
   * Returns {r, g, b, width, height} with Float32Arrays per channel.
   */
  async function getRGBTile({ x, y, z, bbox, quality }) {
    const q = quality || 'fast';
    const tileKey = `rgb_${x},${y},${z},${q}`;
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

      // Allocate output bands
      const bandArrays = {};
      for (const pol of requiredPols) {
        bandArrays[pol] = new Float32Array(tileSize * tileSize);
      }

      const nSub = q === 'high'
        ? Math.min(Math.max(Math.round(Math.sqrt(stepX * stepY)), 2), 8)
        : 1;

      // Sample each output pixel — read all bands for each chunk position
      for (let ty = 0; ty < tileSize; ty++) {
        for (let tx = 0; tx < tileSize; tx++) {
          // For each sub-sample, we need chunks from all bands at the same position
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

              // Read all bands for this chunk position in parallel
              const chunkPromises = requiredPols.map(pol => getCachedChunk(pol, cr, cc));
              const chunks = await Promise.all(chunkPromises);

              for (let p = 0; p < requiredPols.length; p++) {
                const v = samplePixel(chunks[p], srcY, srcX, cr, cc);
                if (v > 0) {
                  sums[requiredPols[p]] += v;
                  counts[requiredPols[p]]++;
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
    frequency,
    polarization: pol,
  }));

  const result = {
    getRGBTile,
    bounds,
    crs,
    width,
    height,
    composite: compositeId,
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
 * Classify h5chunk datasets into polarization names by reading sample data.
 * Cross-pol (HV, VH) is typically 5-15 dB below co-pol (HH, VV).
 * Among co-pols, HH and VV may differ slightly but ordering is consistent.
 *
 * @param {H5Chunk} streamReader
 * @param {Array} datasets - Matching 2D datasets from h5chunk
 * @returns {Object} Map of polarization name → dataset ID
 */
async function classifyDatasets(streamReader, datasets) {
  const polMap = {};

  if (datasets.length === 0) return polMap;

  // Read a center sample from each dataset to estimate mean power
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
          if (!isNaN(v) && v > 0) {
            sum += v;
            count++;
          }
        }
        mean = count > 0 ? sum / count : 0;
      }
    } catch (e) {
      // Failed to read sample
    }

    means.push({ id: ds.id, mean, meanDb: mean > 0 ? 10 * Math.log10(mean) : -999 });
  }

  // Sort by mean power (descending) — co-pols are strongest
  means.sort((a, b) => b.mean - a.mean);

  console.log('[NISAR Loader] Dataset power levels:');
  means.forEach((m, i) => {
    console.log(`[NISAR Loader]   ${i}: ${m.id} mean=${m.mean.toExponential(3)} (${m.meanDb.toFixed(1)} dB)`);
  });

  // Classification heuristic for NISAR GCOV:
  // - NISAR files typically have 4 datasets: HHHH, HVHV, VHVH, VVVV
  // - Co-pols (HH, VV) are 5-15 dB above cross-pols (HV, VH)
  // - Among co-pols: HH is typically slightly > VV for L-band
  // - Among cross-pols: HV ≈ VH (reciprocity)
  if (means.length >= 4) {
    // 4 datasets: assume co-pol > cross-pol ordering
    polMap['HHHH'] = means[0].id;  // Strongest co-pol
    polMap['VVVV'] = means[1].id;  // Second co-pol
    polMap['HVHV'] = means[2].id;  // Cross-pol
    polMap['VHVH'] = means[3].id;  // Cross-pol (reciprocal)
  } else if (means.length === 3) {
    polMap['HHHH'] = means[0].id;
    polMap['VVVV'] = means[1].id;
    polMap['HVHV'] = means[2].id;
  } else if (means.length === 2) {
    // Dual-pol: one co-pol, one cross-pol
    const dbDiff = means[0].meanDb - means[1].meanDb;
    if (dbDiff > 3) {
      // Significant power difference → co-pol + cross-pol
      polMap['HHHH'] = means[0].id;
      polMap['HVHV'] = means[1].id;
    } else {
      // Similar power → likely two co-pols (HH + VV)
      polMap['HHHH'] = means[0].id;
      polMap['VVVV'] = means[1].id;
    }
  } else if (means.length === 1) {
    polMap['HHHH'] = means[0].id;
  }

  return polMap;
}

export default loadNISARGCOV;
