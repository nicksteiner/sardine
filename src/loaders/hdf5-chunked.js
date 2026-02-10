/**
 * HDF5 Chunked Reader
 *
 * Implements efficient partial reading of HDF5 files by:
 * 1. Reading only the superblock and metadata (first ~1-2MB)
 * 2. Building an index of dataset chunk locations
 * 3. Using File.slice() to read chunks on-demand
 *
 * This avoids loading entire multi-GB files into memory.
 *
 * Based on HDF5 file format specification:
 * https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html
 */

// HDF5 signature bytes
const HDF5_SIGNATURE = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

// Superblock versions
const SUPERBLOCK_V0 = 0;
const SUPERBLOCK_V1 = 1;
const SUPERBLOCK_V2 = 2;
const SUPERBLOCK_V3 = 3;

/**
 * Read bytes from a File at a specific offset
 * @param {File} file - The file to read from
 * @param {number} offset - Byte offset
 * @param {number} length - Number of bytes to read
 * @returns {Promise<ArrayBuffer>}
 */
async function readBytes(file, offset, length) {
  const slice = file.slice(offset, offset + length);
  return slice.arrayBuffer();
}

/**
 * Read a DataView from file
 */
async function readDataView(file, offset, length) {
  const buffer = await readBytes(file, offset, length);
  return new DataView(buffer);
}

/**
 * Validate HDF5 signature
 */
async function validateHDF5Signature(file) {
  const buffer = await readBytes(file, 0, 8);
  const signature = new Uint8Array(buffer);

  for (let i = 0; i < 8; i++) {
    if (signature[i] !== HDF5_SIGNATURE[i]) {
      throw new Error('Invalid HDF5 file: signature mismatch');
    }
  }
  return true;
}

/**
 * Parse HDF5 superblock to get root group address and metadata
 */
async function parseSuperblock(file) {
  await validateHDF5Signature(file);

  // Read enough for superblock (version 0-3 have different sizes, max ~96 bytes)
  const view = await readDataView(file, 0, 256);

  // Skip signature (8 bytes)
  let offset = 8;

  const version = view.getUint8(offset);
  console.log(`[HDF5 Chunked] Superblock version: ${version}`);

  let superblock = { version };

  if (version === SUPERBLOCK_V0 || version === SUPERBLOCK_V1) {
    // Version 0/1 superblock
    superblock.freeSpaceVersion = view.getUint8(offset + 1);
    superblock.rootGroupVersion = view.getUint8(offset + 2);
    superblock.sharedHeaderVersion = view.getUint8(offset + 4);
    superblock.offsetSize = view.getUint8(offset + 5);
    superblock.lengthSize = view.getUint8(offset + 6);

    offset += 8; // Fixed header

    // Group leaf/internal node K values (2 bytes each)
    superblock.groupLeafNodeK = view.getUint16(offset, true);
    superblock.groupInternalNodeK = view.getUint16(offset + 2, true);
    offset += 4;

    // File consistency flags (4 bytes)
    offset += 4;

    // Indexed storage internal node K (v1 only)
    if (version === SUPERBLOCK_V1) {
      superblock.indexedStorageK = view.getUint16(offset, true);
      offset += 4; // 2 bytes + 2 reserved
    }

    // Addresses (size depends on offsetSize)
    const readAddress = (off) => {
      if (superblock.offsetSize === 8) {
        return Number(view.getBigUint64(off, true));
      } else {
        return view.getUint32(off, true);
      }
    };

    superblock.baseAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.freeSpaceAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.endOfFileAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.driverInfoAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.rootGroupAddress = readAddress(offset);

  } else if (version === SUPERBLOCK_V2 || version === SUPERBLOCK_V3) {
    // Version 2/3 superblock (more compact)
    superblock.offsetSize = view.getUint8(offset + 1);
    superblock.lengthSize = view.getUint8(offset + 2);
    superblock.fileConsistencyFlags = view.getUint8(offset + 3);

    offset += 4;

    const readAddress = (off) => {
      if (superblock.offsetSize === 8) {
        return Number(view.getBigUint64(off, true));
      } else {
        return view.getUint32(off, true);
      }
    };

    superblock.baseAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.superblockExtensionAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.endOfFileAddress = readAddress(offset);
    offset += superblock.offsetSize;

    superblock.rootGroupAddress = readAddress(offset);
  }

  console.log('[HDF5 Chunked] Superblock parsed:', superblock);
  return superblock;
}

/**
 * Lightweight HDF5 metadata reader
 * Reads just enough to understand the file structure without loading all data
 */
export class HDF5ChunkedReader {
  constructor(file) {
    this.file = file;
    this.superblock = null;
    this.datasetIndex = new Map(); // path -> { offset, shape, dtype, chunks, chunkIndex }
    this.metadataLoaded = false;
  }

  /**
   * Initialize by reading metadata (first few MB)
   * @param {number} metadataSize - How many bytes to read for metadata (default 2MB)
   */
  async initialize(metadataSize = 2 * 1024 * 1024) {
    console.log(`[HDF5 Chunked] Initializing with ${(metadataSize / 1024 / 1024).toFixed(1)}MB metadata read`);

    // Parse superblock
    this.superblock = await parseSuperblock(this.file);

    // Read metadata portion into memory for h5wasm parsing
    // This gives us the structure without loading all the data
    const metadataBytes = Math.min(metadataSize, this.file.size);
    const metadataBuffer = await readBytes(this.file, 0, metadataBytes);

    console.log(`[HDF5 Chunked] Read ${(metadataBytes / 1024 / 1024).toFixed(2)}MB of metadata`);

    // Store for later use
    this.metadataBuffer = metadataBuffer;
    this.metadataLoaded = true;

    return this;
  }

  /**
   * Get the metadata buffer for h5wasm initialization
   * h5wasm will use this to understand the file structure
   */
  getMetadataBuffer() {
    return this.metadataBuffer;
  }

  /**
   * Read a chunk of data at a specific byte range
   * @param {number} offset - Byte offset in file
   * @param {number} length - Number of bytes
   * @returns {Promise<ArrayBuffer>}
   */
  async readChunk(offset, length) {
    return readBytes(this.file, offset, length);
  }

  /**
   * Read a rectangular region from a dataset
   * This is the key method for efficient partial reading
   *
   * @param {Object} datasetInfo - Dataset metadata from h5wasm
   * @param {Array} start - Start indices [row, col]
   * @param {Array} count - Number of elements [rows, cols]
   * @returns {Promise<TypedArray>}
   */
  async readDatasetRegion(datasetInfo, start, count) {
    const { offset, shape, dtype, chunkShape, filters } = datasetInfo;

    // If dataset is contiguous (not chunked), calculate byte offset directly
    if (!chunkShape) {
      return this.readContiguousRegion(datasetInfo, start, count);
    }

    // For chunked datasets, determine which chunks overlap the region
    return this.readChunkedRegion(datasetInfo, start, count);
  }

  /**
   * Read from a contiguous (non-chunked) dataset
   */
  async readContiguousRegion(datasetInfo, start, count) {
    const { offset, shape, dtype, bytesPerElement } = datasetInfo;
    const [startRow, startCol] = start;
    const [numRows, numCols] = count;
    const totalCols = shape[1];

    // Calculate total bytes needed
    const totalElements = numRows * numCols;
    const result = new Float32Array(totalElements);

    // Read row by row (for potentially large datasets)
    for (let r = 0; r < numRows; r++) {
      const rowOffset = offset + ((startRow + r) * totalCols + startCol) * bytesPerElement;
      const rowBytes = numCols * bytesPerElement;

      const buffer = await this.readChunk(rowOffset, rowBytes);
      const rowData = this.decodeData(buffer, dtype, numCols);

      result.set(rowData, r * numCols);
    }

    return result;
  }

  /**
   * Read from a chunked dataset
   */
  async readChunkedRegion(datasetInfo, start, count) {
    const { shape, dtype, chunkShape, chunkIndex, bytesPerElement } = datasetInfo;
    const [startRow, startCol] = start;
    const [numRows, numCols] = count;
    const [chunkRows, chunkCols] = chunkShape;

    // Determine which chunks overlap with the requested region
    const startChunkRow = Math.floor(startRow / chunkRows);
    const endChunkRow = Math.floor((startRow + numRows - 1) / chunkRows);
    const startChunkCol = Math.floor(startCol / chunkCols);
    const endChunkCol = Math.floor((startCol + numCols - 1) / chunkCols);

    // Result array
    const result = new Float32Array(numRows * numCols);

    // Read each overlapping chunk
    for (let cr = startChunkRow; cr <= endChunkRow; cr++) {
      for (let cc = startChunkCol; cc <= endChunkCol; cc++) {
        const chunkKey = `${cr},${cc}`;
        const chunkInfo = chunkIndex.get(chunkKey);

        if (!chunkInfo) {
          // Chunk doesn't exist (sparse dataset or out of bounds)
          continue;
        }

        // Read chunk data
        const chunkBuffer = await this.readChunk(chunkInfo.offset, chunkInfo.size);
        const chunkData = this.decodeData(chunkBuffer, dtype, chunkRows * chunkCols);

        // Copy relevant portion to result
        const chunkStartRow = cr * chunkRows;
        const chunkStartCol = cc * chunkCols;

        for (let r = 0; r < chunkRows; r++) {
          const srcRow = chunkStartRow + r;
          if (srcRow < startRow || srcRow >= startRow + numRows) continue;

          for (let c = 0; c < chunkCols; c++) {
            const srcCol = chunkStartCol + c;
            if (srcCol < startCol || srcCol >= startCol + numCols) continue;

            const srcIdx = r * chunkCols + c;
            const dstIdx = (srcRow - startRow) * numCols + (srcCol - startCol);
            result[dstIdx] = chunkData[srcIdx];
          }
        }
      }
    }

    return result;
  }

  /**
   * Decode raw bytes to typed array based on dtype
   */
  decodeData(buffer, dtype, count) {
    switch (dtype) {
      case 'float32':
      case '<f4':
        return new Float32Array(buffer);
      case 'float64':
      case '<f8':
        return new Float32Array(new Float64Array(buffer)); // Convert to f32
      case 'int16':
      case '<i2':
        return new Float32Array(new Int16Array(buffer));
      case 'uint16':
      case '<u2':
        return new Float32Array(new Uint16Array(buffer));
      case 'int32':
      case '<i4':
        return new Float32Array(new Int32Array(buffer));
      case 'uint32':
      case '<u4':
        return new Float32Array(new Uint32Array(buffer));
      default:
        console.warn(`[HDF5 Chunked] Unknown dtype: ${dtype}, assuming float32`);
        return new Float32Array(buffer);
    }
  }
}

/**
 * Create a chunked reader for an HDF5 file
 * @param {File} file - Local file from input[type="file"]
 * @param {number} metadataSize - Bytes to read for metadata (default 2MB)
 * @returns {Promise<HDF5ChunkedReader>}
 */
export async function createChunkedReader(file, metadataSize = 2 * 1024 * 1024) {
  const reader = new HDF5ChunkedReader(file);
  await reader.initialize(metadataSize);
  return reader;
}

export default HDF5ChunkedReader;
