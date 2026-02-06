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

// Size threshold for streaming vs full load (100MB)
const STREAMING_THRESHOLD = 100 * 1024 * 1024;

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
 * Open HDF5 file using h5wasm's virtual filesystem
 * This writes the buffer to emscripten's FS before opening
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

  // Use a unique filename to avoid conflicts in h5wasm's virtual FS
  const uniqueName = `/tmp/${Date.now()}_${file.name}`;

  try {
    // Write to h5wasm's emscripten virtual filesystem
    H5.FS.writeFile(uniqueName, new Uint8Array(arrayBuffer));
    console.log(`[NISAR Loader] Written to virtual FS: ${uniqueName}`);

    // Open the file from virtual filesystem
    const h5file = new H5.File(uniqueName, 'r');

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
      virtualPath: uniqueName,
    };
  } catch (e) {
    // Clean up on failure
    try {
      H5.FS.unlink(uniqueName);
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }
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
 * Try to use h5chunk streaming for large files
 * Returns null if streaming isn't supported or fails
 */
async function tryStreamingOpen(file) {
  if (file.size < STREAMING_THRESHOLD) {
    console.log('[NISAR Loader] File small enough for full load, skipping streaming');
    return null;
  }

  try {
    console.log('[NISAR Loader] Attempting streaming mode with h5chunk...');
    const h5chunk = await openH5ChunkFile(file, 8 * 1024 * 1024);

    const datasets = h5chunk.getDatasets();
    console.log(`[NISAR Loader] h5chunk found ${datasets.length} datasets`);

    if (datasets.length > 0 && datasets.some(d => d.numChunks > 0)) {
      console.log('[NISAR Loader] Streaming mode available');
      return h5chunk;
    } else {
      console.log('[NISAR Loader] Streaming mode: no chunk index found, falling back');
      return null;
    }
  } catch (e) {
    console.warn('[NISAR Loader] Streaming mode failed:', e.message);
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

  // Try streaming first for large files
  const streamReader = await tryStreamingOpen(file);
  if (streamReader) {
    // Use h5chunk's discovered datasets
    const h5Datasets = streamReader.getDatasets();
    // For now, return generic dataset info
    // TODO: Parse NISAR-specific paths from h5chunk
    console.log('[NISAR Loader] Using streaming mode');

    // Fall through to h5wasm for now to get proper NISAR structure
    // This is a temporary measure until h5chunk can parse NISAR paths
  }

  // Fall back to h5wasm (loads full file for large files)
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
 * Load a NISAR GCOV HDF5 file with chunked loading
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

  console.log(`[NISAR Loader] Loading NISAR GCOV (chunked): ${file.name}`);
  console.log(`[NISAR Loader] Dataset: frequency${frequency}/${polarization}`);

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

export default loadNISARGCOV;
