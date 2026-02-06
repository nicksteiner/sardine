/**
 * h5chunk - Cloud-Optimized HDF5 Chunk Reader
 *
 * Reads NISAR-style cloud-optimized HDF5 files by:
 * 1. Fetching only the metadata page (~8MB) at the front of the file
 * 2. Parsing HDF5 structure to build a chunk index
 * 3. Fetching individual data chunks on-demand via byte-range requests
 *
 * NISAR uses "paged aggregation" which consolidates metadata at file start.
 * This enables COG-style streaming access without loading the entire file.
 *
 * Based on HDF5 File Format Specification:
 * https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html
 */

// HDF5 signature
const HDF5_SIGNATURE = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

// Object header message types
const MSG_DATASPACE = 0x0001;
const MSG_DATATYPE = 0x0003;
const MSG_FILL_VALUE = 0x0005;
const MSG_LINK = 0x0006;
const MSG_DATA_LAYOUT = 0x0008;
const MSG_FILTER_PIPELINE = 0x000B;
const MSG_ATTRIBUTE = 0x000C;
const MSG_OBJ_HEADER_CONTINUATION = 0x0010;
const MSG_SYMBOL_TABLE = 0x0011;
const MSG_LINK_INFO = 0x002A;  // not used yet, but defined for completeness

// Data layout classes
const LAYOUT_COMPACT = 0;
const LAYOUT_CONTIGUOUS = 1;
const LAYOUT_CHUNKED = 2;

// Filter IDs
const FILTER_DEFLATE = 1;
const FILTER_SHUFFLE = 2;
const FILTER_FLETCHER32 = 3;
const FILTER_SZIP = 4;
const FILTER_NBIT = 5;
const FILTER_SCALEOFFSET = 6;

/**
 * DataView wrapper with position tracking
 */
class BufferReader {
  constructor(buffer, littleEndian = true) {
    this.view = new DataView(buffer);
    this.pos = 0;
    this.le = littleEndian;
  }

  seek(pos) {
    this.pos = pos;
  }

  skip(n) {
    this.pos += n;
  }

  readUint8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readUint16() {
    const v = this.view.getUint16(this.pos, this.le);
    this.pos += 2;
    return v;
  }

  readUint32() {
    const v = this.view.getUint32(this.pos, this.le);
    this.pos += 4;
    return v;
  }

  readUint64() {
    const v = this.view.getBigUint64(this.pos, this.le);
    this.pos += 8;
    return Number(v);
  }

  readBytes(n) {
    const arr = new Uint8Array(this.view.buffer, this.pos, n);
    this.pos += n;
    return arr;
  }

  readOffset(size) {
    if (size === 8) return this.readUint64();
    if (size === 4) return this.readUint32();
    if (size === 2) return this.readUint16();
    return this.readUint8();
  }

  readLength(size) {
    return this.readOffset(size);
  }
}

/**
 * Parse HDF5 superblock
 */
function parseSuperblock(reader) {
  // Verify signature
  const sig = reader.readBytes(8);
  for (let i = 0; i < 8; i++) {
    if (sig[i] !== HDF5_SIGNATURE[i]) {
      throw new Error('Invalid HDF5 signature');
    }
  }

  const version = reader.readUint8();
  console.log(`[h5chunk] Superblock version: ${version}`);

  let superblock = { version };

  if (version === 0 || version === 1) {
    superblock.freeSpaceVersion = reader.readUint8();
    superblock.rootGroupVersion = reader.readUint8();
    reader.skip(1); // reserved
    superblock.sharedHeaderVersion = reader.readUint8();
    superblock.offsetSize = reader.readUint8();
    superblock.lengthSize = reader.readUint8();
    reader.skip(1); // reserved

    superblock.groupLeafNodeK = reader.readUint16();
    superblock.groupInternalNodeK = reader.readUint16();

    reader.skip(4); // file consistency flags

    if (version === 1) {
      superblock.indexedStorageK = reader.readUint16();
      reader.skip(2); // reserved
    }

    superblock.baseAddress = reader.readOffset(superblock.offsetSize);
    superblock.freeSpaceAddress = reader.readOffset(superblock.offsetSize);
    superblock.endOfFileAddress = reader.readOffset(superblock.offsetSize);
    superblock.driverInfoAddress = reader.readOffset(superblock.offsetSize);

    // Root group symbol table entry
    superblock.rootGroupAddress = reader.readOffset(superblock.offsetSize);

  } else if (version === 2 || version === 3) {
    superblock.offsetSize = reader.readUint8();
    superblock.lengthSize = reader.readUint8();
    superblock.fileConsistencyFlags = reader.readUint8();

    superblock.baseAddress = reader.readOffset(superblock.offsetSize);
    superblock.superblockExtAddress = reader.readOffset(superblock.offsetSize);
    superblock.endOfFileAddress = reader.readOffset(superblock.offsetSize);
    superblock.rootGroupAddress = reader.readOffset(superblock.offsetSize);

    // Superblock checksum
    reader.skip(4);
  }

  console.log(`[h5chunk] Offset size: ${superblock.offsetSize}, Length size: ${superblock.lengthSize}`);
  console.log(`[h5chunk] Root group address: 0x${superblock.rootGroupAddress.toString(16)}`);

  return superblock;
}

// ─── V1 Group Traversal (Symbol Table / B-tree / SNOD / Local Heap) ──────────

/**
 * Parse a v1 Local Heap (HEAP signature).
 * Returns the raw string data buffer from which link names are read.
 *
 * Spec: https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#LocalHeap
 *
 * @param {BufferReader} reader
 * @param {number} address - Offset where the HEAP starts
 * @param {Object} superblock
 * @returns {{dataSegment: Uint8Array}|null}
 */
function parseLocalHeap(reader, address, superblock) {
  try {
    reader.seek(address);
    const sig = reader.readBytes(4);
    if (String.fromCharCode(...sig) !== 'HEAP') return null;

    const version = reader.readUint8();
    reader.skip(3); // reserved
    const dataSize = reader.readLength(superblock.lengthSize);
    const freeOffset = reader.readLength(superblock.lengthSize);
    const dataAddr = reader.readOffset(superblock.offsetSize);

    if (dataAddr + dataSize > reader.view.byteLength) return null;

    const dataSegment = new Uint8Array(reader.view.buffer, dataAddr, dataSize);
    return { dataSegment };
  } catch (e) {
    return null;
  }
}

/**
 * Read a null-terminated string from a local heap data segment.
 */
function readHeapString(heapData, offset) {
  if (!heapData || offset >= heapData.length) return '';
  let end = offset;
  while (end < heapData.length && heapData[end] !== 0) end++;
  return String.fromCharCode(...heapData.slice(offset, end));
}

/**
 * Parse a Symbol Table Node (SNOD signature).
 * Returns an array of { name, objAddr, cacheType, btreeAddr, heapAddr } entries.
 *
 * Spec: https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#SymbolTableNode
 *
 * @param {BufferReader} reader
 * @param {number} address
 * @param {Object} superblock
 * @param {Uint8Array} heapData - Local heap data segment for name resolution
 * @returns {Array}
 */
function parseSymbolTableNode(reader, address, superblock, heapData) {
  const entries = [];
  try {
    reader.seek(address);
    const sig = reader.readBytes(4);
    if (String.fromCharCode(...sig) !== 'SNOD') return entries;

    const version = reader.readUint8();
    reader.skip(1); // reserved
    const numSymbols = reader.readUint16();

    for (let i = 0; i < numSymbols; i++) {
      const nameOffset = reader.readOffset(superblock.offsetSize);
      const objAddr = reader.readOffset(superblock.offsetSize);
      const cacheType = reader.readUint32();
      reader.skip(4); // reserved
      // Scratch pad (16 bytes) — for cached groups, contains B-tree & heap addrs
      const scratch = reader.readBytes(16);

      const name = readHeapString(heapData, nameOffset);
      let btreeAddr = null;
      let heapAddr = null;
      if (cacheType === 1) {
        // Cached group — extract B-tree address and local heap address from scratch
        const sv = new DataView(scratch.buffer, scratch.byteOffset, 16);
        btreeAddr = Number(sv.getBigUint64(0, true));
        heapAddr = Number(sv.getBigUint64(8, true));
      }

      entries.push({ name, objAddr, cacheType, btreeAddr, heapAddr });
    }
  } catch (e) {
    // Truncated SNOD
  }
  return entries;
}

/**
 * Walk a v1 Group B-tree (TREE signature, node type 0) to enumerate children.
 * Type-0 B-trees point to Symbol Table Nodes (SNODs) at the leaf level.
 *
 * @param {BufferReader} reader
 * @param {number} address - Address of TREE node
 * @param {Object} superblock
 * @param {Uint8Array} heapData - Local heap data for name resolution
 * @returns {Array} - Flat list of SNOD entries
 */
function walkGroupBTree(reader, address, superblock, heapData) {
  const results = [];
  try {
    if (address >= reader.view.byteLength) return results;

    reader.seek(address);
    const sig = reader.readBytes(4);
    if (String.fromCharCode(...sig) !== 'TREE') return results;

    const nodeType = reader.readUint8();
    if (nodeType !== 0) return results; // Not a group B-tree

    const nodeLevel = reader.readUint8();
    const entriesUsed = reader.readUint16();
    reader.skip(superblock.offsetSize); // left sibling
    reader.skip(superblock.offsetSize); // right sibling

    if (nodeLevel === 0) {
      // Leaf node: each entry is (key, childAddr) where child points to SNOD
      for (let i = 0; i < entriesUsed; i++) {
        reader.readOffset(superblock.offsetSize); // key (local heap offset — unused here)
        const childAddr = reader.readOffset(superblock.offsetSize);
        if (childAddr < reader.view.byteLength) {
          const snodEntries = parseSymbolTableNode(reader, childAddr, superblock, heapData);
          results.push(...snodEntries);
          // Restore reader position after SNOD parsing
          reader.seek(address + 4 + 1 + 1 + 2 + superblock.offsetSize * 2 +
                       (i + 1) * superblock.offsetSize * 2);
        }
      }
      // Final key
      reader.readOffset(superblock.offsetSize);
    } else {
      // Internal node: entries point to child TREE nodes
      for (let i = 0; i < entriesUsed; i++) {
        reader.readOffset(superblock.offsetSize); // key
        const childAddr = reader.readOffset(superblock.offsetSize);
        if (childAddr < reader.view.byteLength) {
          results.push(...walkGroupBTree(reader, childAddr, superblock, heapData));
          // Restore position for next entry
          reader.seek(address + 4 + 1 + 1 + 2 + superblock.offsetSize * 2 +
                       (i + 1) * superblock.offsetSize * 2);
        }
      }
    }
  } catch (e) {
    // Truncated B-tree
  }
  return results;
}

/**
 * Enumerate children of a group given its Symbol Table message data
 * (B-tree address + local heap address).
 *
 * @param {BufferReader} reader
 * @param {number} btreeAddr - Group B-tree v1 address
 * @param {number} heapAddr - Local heap address
 * @param {Object} superblock
 * @returns {Array<{name, objAddr, cacheType, btreeAddr, heapAddr}>}
 */
function enumerateGroupChildren(reader, btreeAddr, heapAddr, superblock) {
  if (btreeAddr >= reader.view.byteLength || heapAddr >= reader.view.byteLength) return [];
  const heap = parseLocalHeap(reader, heapAddr, superblock);
  if (!heap) return [];
  return walkGroupBTree(reader, btreeAddr, superblock, heap.dataSegment);
}

/**
 * Parse v1 object header continuation messages from a fetched block.
 * The continuation block contains the same packed message format as the
 * main object header, but without its own prefix.
 *
 * @param {ArrayBuffer} contBuffer - The fetched continuation data
 * @param {Object} superblock
 * @returns {Array<{type, size, flags, offset, buffer}>} messages from the continuation
 */
function parseV1ContinuationBlock(contBuffer, superblock) {
  const messages = [];
  const contReader = new BufferReader(contBuffer);
  const end = contBuffer.byteLength;

  while (contReader.pos + 8 <= end) {
    const msgType = contReader.readUint16();
    const msgSize = contReader.readUint16();
    const msgFlags = contReader.readUint8();
    contReader.skip(3); // reserved

    const msgStart = contReader.pos;

    if (msgType !== 0 && msgSize > 0 && msgStart + msgSize <= end) {
      messages.push({
        type: msgType,
        size: msgSize,
        flags: msgFlags,
        offset: msgStart,
        _reader: contReader, // reference to the continuation reader
        _buffer: contBuffer,
      });
    }

    contReader.seek(msgStart + msgSize);
    // Align to 8-byte boundary
    if (contReader.pos % 8 !== 0) {
      contReader.seek(contReader.pos + (8 - (contReader.pos % 8)));
    }
  }
  return messages;
}

/**
 * Parse an HDF5 Link message (type 0x0006) to extract child name and target address.
 * Spec: https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#LinkMessage
 *
 * @param {BufferReader} reader
 * @param {number} offset - Start of the link message payload
 * @param {Object} superblock
 * @returns {{name: string, address: number, linkType: number}|null}
 */
function parseLinkMessage(reader, offset, superblock) {
  try {
    reader.seek(offset);
    const version = reader.readUint8();
    if (version !== 1) return null;

    const flags = reader.readUint8();

    // Link type (optional, bit 3)
    let linkType = 0; // hard link
    if (flags & 0x08) {
      linkType = reader.readUint8();
    }

    // Creation order (optional, bit 2)
    if (flags & 0x04) {
      reader.skip(8);
    }

    // Link name character set (optional, bit 4)
    if (flags & 0x10) {
      reader.skip(1);
    }

    // Name length — size encoding in bits 0-1
    const nameLenSize = 1 << (flags & 0x03); // 1, 2, 4, or 8 bytes
    let nameLen;
    if (nameLenSize === 1) nameLen = reader.readUint8();
    else if (nameLenSize === 2) nameLen = reader.readUint16();
    else if (nameLenSize === 4) nameLen = reader.readUint32();
    else nameLen = Number(reader.readBigUint64?.() || reader.readUint32());

    if (nameLen <= 0 || nameLen > 1024) return null;

    // Read name bytes
    const nameBytes = reader.readBytes(nameLen);
    const name = String.fromCharCode(...nameBytes);

    // Hard link: read object header address
    if (linkType === 0) {
      const address = reader.readOffset(superblock.offsetSize);
      return { name, address, linkType };
    }

    // Soft/external links — skip for now
    return { name, address: null, linkType };
  } catch (e) {
    return null;
  }
}

/**
 * Parse an object header (v1 or v2)
 */
function parseObjectHeader(reader, superblock, address) {
  reader.seek(address);

  const sig = reader.readBytes(4);
  const sigStr = String.fromCharCode(...sig);

  let messages = [];

  if (sigStr === 'OHDR') {
    // Object Header v2
    const version = reader.readUint8();
    const flags = reader.readUint8();

    // Optional timestamps
    if (flags & 0x10) {
      reader.skip(16); // access, modification, change, birth times
    }

    // Optional max compact/min dense
    if (flags & 0x04) {
      reader.skip(4);
    }

    // Chunk 0 size
    let sizeFieldSize = 1;
    if ((flags & 0x03) === 1) sizeFieldSize = 2;
    else if ((flags & 0x03) === 2) sizeFieldSize = 4;
    else if ((flags & 0x03) === 3) sizeFieldSize = 8;

    const chunk0Size = reader.readLength(sizeFieldSize);
    const messagesStart = reader.pos;
    const messagesEnd = messagesStart + chunk0Size - 4; // -4 for checksum

    // Parse messages
    while (reader.pos < messagesEnd) {
      const msgType = reader.readUint8();
      const msgSize = reader.readUint16();
      const msgFlags = reader.readUint8();

      if (msgType === 0) {
        // Nil message, skip
        reader.skip(msgSize);
        continue;
      }

      // Creation order if present
      if (msgFlags & 0x04) {
        reader.skip(2);
      }

      const msgStart = reader.pos;
      messages.push({
        type: msgType,
        size: msgSize,
        flags: msgFlags,
        offset: msgStart,
      });

      reader.seek(msgStart + msgSize);
    }

  } else {
    // Object Header v1
    reader.seek(address);
    const version = reader.readUint8();

    if (version !== 1) {
      console.warn(`[h5chunk] Unknown object header version: ${version}`);
      return messages;
    }

    reader.skip(1); // reserved
    const numMessages = reader.readUint16();
    const refCount = reader.readUint32();
    const headerSize = reader.readUint32();
    // v1 header prefix is 12 bytes — align to 8-byte boundary (pad to 16)
    const alignedStart = address + 16;
    reader.seek(alignedStart);
    const messagesEnd = alignedStart + headerSize;

    // Parse messages within the header size, stopping at boundary
    let msgCount = 0;
    while (reader.pos + 8 <= messagesEnd && msgCount < numMessages) {
      const msgType = reader.readUint16();
      const msgSize = reader.readUint16();
      const msgFlags = reader.readUint8();
      reader.skip(3); // reserved

      const msgStart = reader.pos;

      if (msgType !== 0) {
        messages.push({
          type: msgType,
          size: msgSize,
          flags: msgFlags,
          offset: msgStart,
        });
      }

      reader.seek(msgStart + msgSize);
      // Align to 8-byte boundary
      if (reader.pos % 8 !== 0) {
        reader.seek(reader.pos + (8 - (reader.pos % 8)));
      }
      msgCount++;
    }
  }

  return messages;
}

/**
 * Parse dataspace message to get dimensions
 */
function parseDataspaceMessage(reader, offset) {
  reader.seek(offset);

  const version = reader.readUint8();
  const rank = reader.readUint8();
  const flags = reader.readUint8();

  if (version === 1) {
    reader.skip(5); // reserved
  } else if (version === 2) {
    // v2 has type field
    const type = reader.readUint8();
  }

  const dims = [];
  for (let i = 0; i < rank; i++) {
    dims.push(reader.readUint64());
  }

  // Max dims if present
  let maxDims = null;
  if (flags & 0x01) {
    maxDims = [];
    for (let i = 0; i < rank; i++) {
      maxDims.push(reader.readUint64());
    }
  }

  return { rank, dims, maxDims };
}

/**
 * Parse datatype message
 */
function parseDatatypeMessage(reader, offset) {
  reader.seek(offset);

  const classAndVersion = reader.readUint8();
  const dtClass = classAndVersion & 0x0F;
  const version = (classAndVersion >> 4) & 0x0F;

  const bitField1 = reader.readUint8();
  const bitField2 = reader.readUint8();
  const bitField3 = reader.readUint8();
  const size = reader.readUint32();

  // Interpret based on class
  let dtype = 'unknown';
  let littleEndian = true;

  switch (dtClass) {
    case 0: // Fixed-point (integer)
      littleEndian = (bitField1 & 0x01) === 0;
      const signed = (bitField1 & 0x08) !== 0;
      if (size === 1) dtype = signed ? 'int8' : 'uint8';
      else if (size === 2) dtype = signed ? 'int16' : 'uint16';
      else if (size === 4) dtype = signed ? 'int32' : 'uint32';
      else if (size === 8) dtype = signed ? 'int64' : 'uint64';
      break;

    case 1: // Floating-point
      littleEndian = (bitField1 & 0x01) === 0;
      if (size === 2) dtype = 'float16';
      else if (size === 4) dtype = 'float32';
      else if (size === 8) dtype = 'float64';
      break;

    case 3: // String
      dtype = 'string';
      break;

    default:
      dtype = `class${dtClass}`;
  }

  return { dtype, size, littleEndian };
}

/**
 * Parse data layout message to get chunk info
 */
function parseDataLayoutMessage(reader, offset, superblock) {
  reader.seek(offset);

  const version = reader.readUint8();

  if (version < 3) {
    // Version 1 or 2
    const rank = reader.readUint8();
    const layoutClass = reader.readUint8();
    reader.skip(5); // reserved

    if (layoutClass === LAYOUT_CONTIGUOUS) {
      const dataAddress = reader.readOffset(superblock.offsetSize);
      const dataSize = reader.readLength(superblock.lengthSize);
      return {
        type: 'contiguous',
        address: dataAddress,
        size: dataSize,
      };
    } else if (layoutClass === LAYOUT_CHUNKED) {
      const dataAddress = reader.readOffset(superblock.offsetSize);
      const chunkDims = [];
      for (let i = 0; i < rank; i++) {
        chunkDims.push(reader.readUint32());
      }
      return {
        type: 'chunked',
        btreeAddress: dataAddress,
        chunkDims,
        version: 1,
      };
    }
  } else if (version === 3 || version === 4) {
    // Version 3 or 4
    const layoutClass = reader.readUint8();

    if (layoutClass === LAYOUT_CONTIGUOUS) {
      const dataAddress = reader.readOffset(superblock.offsetSize);
      const dataSize = reader.readLength(superblock.lengthSize);
      return {
        type: 'contiguous',
        address: dataAddress,
        size: dataSize,
      };
    } else if (layoutClass === LAYOUT_CHUNKED) {
      if (version === 3) {
        const rank = reader.readUint8();
        const btreeAddress = reader.readOffset(superblock.offsetSize);
        const chunkDims = [];
        for (let i = 0; i < rank; i++) {
          chunkDims.push(reader.readUint32());
        }
        return {
          type: 'chunked',
          btreeAddress,
          chunkDims,
          version: 3,
        };
      } else {
        // Version 4 - indexed storage
        const flags = reader.readUint8();
        const rank = reader.readUint8();
        const dimSizeEncoded = reader.readUint8();

        const chunkDims = [];
        for (let i = 0; i < rank; i++) {
          chunkDims.push(reader.readLength(dimSizeEncoded));
        }

        const indexType = reader.readUint8();
        const btreeAddress = reader.readOffset(superblock.offsetSize);

        return {
          type: 'chunked',
          btreeAddress,
          chunkDims,
          indexType,
          version: 4,
        };
      }
    }
  }

  return { type: 'unknown' };
}

/**
 * Parse filter pipeline message
 */
function parseFilterPipelineMessage(reader, offset) {
  reader.seek(offset);

  const version = reader.readUint8();
  const numFilters = reader.readUint8();

  if (version === 1) {
    reader.skip(6); // reserved
  }

  const filters = [];

  for (let i = 0; i < numFilters; i++) {
    const filterId = reader.readUint16();
    const nameLen = version === 1 ? reader.readUint16() : 0;
    const flags = reader.readUint16();
    const numParams = reader.readUint16();

    // Skip name if present
    if (nameLen > 0) {
      reader.skip(nameLen);
      // Align to 8 bytes
      const padding = (8 - (nameLen % 8)) % 8;
      reader.skip(padding);
    }

    // Read parameters
    const params = [];
    for (let j = 0; j < numParams; j++) {
      params.push(reader.readUint32());
    }

    // Padding if odd number of params in v1
    if (version === 1 && numParams % 2 === 1) {
      reader.skip(4);
    }

    filters.push({
      id: filterId,
      flags,
      params,
      name: getFilterName(filterId),
    });
  }

  return filters;
}

function getFilterName(id) {
  switch (id) {
    case FILTER_DEFLATE: return 'deflate';
    case FILTER_SHUFFLE: return 'shuffle';
    case FILTER_FLETCHER32: return 'fletcher32';
    case FILTER_SZIP: return 'szip';
    case FILTER_NBIT: return 'nbit';
    case FILTER_SCALEOFFSET: return 'scaleoffset';
    default: return `filter_${id}`;
  }
}

/**
 * Parse a B-tree v1 for chunked data
 * Returns chunk index: Map of "i,j,..." -> {offset, size}
 */
function parseBTreeV1(reader, address, superblock, rank, chunkSize) {
  const chunks = new Map();

  function parseNode(nodeAddress) {
    reader.seek(nodeAddress);

    const sig = reader.readBytes(4);
    const sigStr = String.fromCharCode(...sig);

    if (sigStr !== 'TREE') {
      console.warn(`[h5chunk] Expected TREE signature at 0x${nodeAddress.toString(16)}, got ${sigStr}`);
      return;
    }

    const nodeType = reader.readUint8();
    const nodeLevel = reader.readUint8();
    const entriesUsed = reader.readUint16();

    const leftSibling = reader.readOffset(superblock.offsetSize);
    const rightSibling = reader.readOffset(superblock.offsetSize);

    // Read all entries first, then process.
    // This avoids reader position corruption when recursing into child nodes,
    // since the BufferReader has shared state (single pos field).
    const entries = [];
    for (let i = 0; i < entriesUsed; i++) {
      // Key: chunk size (4 bytes) + filter mask (4 bytes) + chunk offsets (rank * 8 bytes each)
      const keyChunkSize = reader.readUint32();
      const filterMask = reader.readUint32();

      const chunkOffsets = [];
      for (let d = 0; d < rank; d++) {
        chunkOffsets.push(reader.readUint64());
      }

      // Child pointer (only for internal nodes, level > 0)
      // For leaf nodes, this is the data chunk address
      const childAddress = reader.readOffset(superblock.offsetSize);

      entries.push({ keyChunkSize, filterMask, chunkOffsets, childAddress });
    }

    // Now process entries (safe to recurse since we've finished reading this node)
    for (const entry of entries) {
      if (nodeLevel === 0) {
        // Leaf node - childAddress is the actual chunk data address
        const chunkKey = entry.chunkOffsets.slice(0, -1).join(','); // Last dim is the element offset
        chunks.set(chunkKey, {
          offset: entry.childAddress,
          size: entry.keyChunkSize,
          filterMask: entry.filterMask,
          indices: entry.chunkOffsets.slice(0, -1),
        });
      } else {
        // Internal node - recurse into child
        parseNode(entry.childAddress);
      }
    }
  }

  parseNode(address);
  return chunks;
}

/**
 * Parse a B-tree v2 for chunked data
 */
function parseBTreeV2(reader, address, superblock, rank) {
  const chunks = new Map();

  reader.seek(address);

  const sig = reader.readBytes(4);
  if (String.fromCharCode(...sig) !== 'BTHD') {
    console.warn('[h5chunk] Expected B-tree v2 header');
    return chunks;
  }

  const version = reader.readUint8();
  const type = reader.readUint8();
  const nodeSize = reader.readUint32();
  const recordSize = reader.readUint16();
  const depth = reader.readUint16();
  const splitPercent = reader.readUint8();
  const mergePercent = reader.readUint8();
  const rootAddress = reader.readOffset(superblock.offsetSize);
  const numRecords = reader.readUint16();
  const totalRecords = reader.readLength(superblock.lengthSize);

  // Parse the root node
  function parseV2Node(nodeAddress, level) {
    reader.seek(nodeAddress);

    const nodeSig = reader.readBytes(4);
    const nodeSigStr = String.fromCharCode(...nodeSig);

    if (level > 0 && nodeSigStr !== 'BTIN') {
      console.warn(`[h5chunk] Expected BTIN at level ${level}`);
      return;
    }
    if (level === 0 && nodeSigStr !== 'BTLF') {
      console.warn(`[h5chunk] Expected BTLF at level 0`);
      return;
    }

    const nodeVersion = reader.readUint8();
    const nodeType = reader.readUint8();

    if (level === 0) {
      // Leaf node - read records directly
      // Record format depends on type
      // For chunked storage type 10: filtered chunk records
      // For type 11: non-filtered chunk records

      // Simplified: read until we hit end or invalid data
      // This needs proper implementation based on record size
    } else {
      // Internal node - has child pointers
    }
  }

  if (rootAddress !== 0xFFFFFFFFFFFFFFFF) {
    parseV2Node(rootAddress, depth);
  }

  return chunks;
}

/**
 * Navigate HDF5 group structure to find datasets
 * @param {BufferReader} reader
 * @param {Object} superblock
 * @param {number} groupAddress
 * @param {string} path
 * @returns {Map<string, Object>} Map of dataset paths to info
 */
function parseGroup(reader, superblock, groupAddress, path = '/') {
  const datasets = new Map();

  reader.seek(groupAddress);

  // Check if this is a symbol table or object header
  const sig = reader.readBytes(4);
  const sigStr = String.fromCharCode(...sig);

  reader.seek(groupAddress);

  // Parse as object header first
  const messages = parseObjectHeader(reader, superblock, groupAddress);

  for (const msg of messages) {
    if (msg.type === MSG_DATASPACE) {
      const dataspace = parseDataspaceMessage(reader, msg.offset);
      datasets.set(path, { ...datasets.get(path), dataspace });
    } else if (msg.type === MSG_DATATYPE) {
      const datatype = parseDatatypeMessage(reader, msg.offset);
      datasets.set(path, { ...datasets.get(path), datatype });
    } else if (msg.type === MSG_DATA_LAYOUT) {
      const layout = parseDataLayoutMessage(reader, msg.offset, superblock);
      datasets.set(path, { ...datasets.get(path), layout });
    } else if (msg.type === MSG_FILTER_PIPELINE) {
      const filters = parseFilterPipelineMessage(reader, msg.offset);
      datasets.set(path, { ...datasets.get(path), filters });
    }
  }

  return datasets;
}

/**
 * H5Chunk - Cloud-Optimized HDF5 Reader
 */
export class H5Chunk {
  constructor() {
    this.superblock = null;
    this.datasets = new Map(); // path -> {shape, dtype, layout, chunks}
    this.metadataBuffer = null;
    this.file = null;
    this.url = null;
  }

  /**
   * Open a local HDF5 file
   * @param {File} file - Local file from input[type="file"]
   * @param {number} metadataSize - Bytes to read for metadata (default 8MB)
   */
  async openFile(file, metadataSize = 8 * 1024 * 1024) {
    this.file = file;

    console.log(`[h5chunk] Opening file: ${file.name}`);
    console.log(`[h5chunk] File size: ${(file.size / 1e6).toFixed(1)} MB`);
    console.log(`[h5chunk] Reading metadata: ${(metadataSize / 1e6).toFixed(1)} MB`);

    // Read metadata portion
    const slice = file.slice(0, Math.min(metadataSize, file.size));
    this.metadataBuffer = await slice.arrayBuffer();

    await this._parseMetadata();
  }

  /**
   * Open an HDF5 file from URL
   * @param {string} url - HTTP(S) URL supporting range requests
   * @param {number} metadataSize - Bytes to read for metadata
   */
  async openUrl(url, metadataSize = 8 * 1024 * 1024) {
    this.url = url;

    console.log(`[h5chunk] Opening URL: ${url}`);
    console.log(`[h5chunk] Reading metadata: ${(metadataSize / 1e6).toFixed(1)} MB`);

    // Fetch metadata with range request
    const response = await fetch(url, {
      headers: {
        'Range': `bytes=0-${metadataSize - 1}`,
      },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch metadata: ${response.status}`);
    }

    this.metadataBuffer = await response.arrayBuffer();

    await this._parseMetadata();
  }

  /**
   * Parse the metadata buffer
   */
  async _parseMetadata() {
    const reader = new BufferReader(this.metadataBuffer);

    // Parse superblock
    this.superblock = parseSuperblock(reader);

    console.log(`[h5chunk] Superblock parsed, root at 0x${this.superblock.rootGroupAddress.toString(16)}`);

    // Parse root group and traverse structure
    // This is where we build the dataset index
    await this._scanForDatasets(reader);
  }

  /**
   * Fetch arbitrary bytes from the file (for continuation blocks outside the
   * metadata buffer). Works for both local File objects and remote URLs.
   *
   * @param {number} offset - Byte offset in the file
   * @param {number} length - Number of bytes to fetch
   * @returns {Promise<ArrayBuffer>}
   */
  async _fetchBytes(offset, length) {
    if (this.file) {
      const slice = this.file.slice(offset, offset + length);
      return slice.arrayBuffer();
    } else if (this.url) {
      const response = await fetch(this.url, {
        headers: { 'Range': `bytes=${offset}-${offset + length - 1}` },
      });
      return response.arrayBuffer();
    }
    throw new Error('No file or URL available');
  }

  /**
   * Scan for NISAR datasets
   * Uses multiple strategies:
   * 1. Parse from root group address
   * 2. Scan for v1 object headers (no signature, but known structure)
   * 3. Scan for v2 object headers (OHDR signature)
   * 4. Look for Data Layout messages that indicate chunked datasets
   */
  async _scanForDatasets(reader) {
    console.log('[h5chunk] Scanning for datasets...');

    const buffer = new Uint8Array(this.metadataBuffer);

    // Strategy 1: Parse from root group (v2 superblock points to object header)
    try {
      console.log(`[h5chunk] Parsing root group at 0x${this.superblock.rootGroupAddress.toString(16)}`);
      await this._parseObjectAtAddress(reader, this.superblock.rootGroupAddress, '/');
    } catch (e) {
      console.warn('[h5chunk] Failed to parse root group:', e.message);
    }

    // Strategy 2: Scan for OHDR signatures (v2 object headers)
    const ohdrs = [];
    for (let i = 0; i < buffer.length - 4; i++) {
      if (buffer[i] === 0x4F && buffer[i + 1] === 0x48 &&
          buffer[i + 2] === 0x44 && buffer[i + 3] === 0x52) {
        ohdrs.push(i);
      }
    }
    console.log(`[h5chunk] Found ${ohdrs.length} OHDR signatures`);

    for (const addr of ohdrs) {
      try {
        await this._parseObjectAtAddress(reader, addr, `obj_${addr.toString(16)}`);
      } catch (e) {
        // Skip invalid headers
      }
    }

    // Strategy 3: Scan for FRHP (fractal heap) which contains link messages
    const frhps = [];
    for (let i = 0; i < buffer.length - 4; i++) {
      if (buffer[i] === 0x46 && buffer[i + 1] === 0x52 &&
          buffer[i + 2] === 0x48 && buffer[i + 3] === 0x50) {
        frhps.push(i);
      }
    }
    console.log(`[h5chunk] Found ${frhps.length} FRHP (fractal heap) signatures`);

    // Strategy 4: Look for chunked data layout patterns
    // Scan for Data Layout message patterns (version 3 or 4 with chunked class)
    await this._scanForChunkedLayouts(reader, buffer);

    console.log(`[h5chunk] Found ${this.datasets.size} datasets total`);
  }

  /**
   * Parse an object (group or dataset) at a given address.
   * Handles both v1 (Symbol Table) and v2 (Link messages) group structures,
   * and follows Object Header Continuation blocks for v1 headers whose
   * messages live beyond the initial header allocation.
   */
  async _parseObjectAtAddress(reader, address, path) {
    if (address >= this.metadataBuffer.byteLength) {
      return; // Beyond our metadata buffer
    }

    const messages = parseObjectHeader(reader, this.superblock, address);

    let dataspace = null;
    let datatype = null;
    let layout = null;
    let filters = null;
    const childLinks = []; // Collect Link messages (v2 groups)
    let symbolTableBTree = null;
    let symbolTableHeap = null;
    const continuationBlocks = []; // {offset, length} for v1 continuation

    for (const msg of messages) {
      try {
        if (msg.type === MSG_DATASPACE && msg.offset < this.metadataBuffer.byteLength) {
          dataspace = parseDataspaceMessage(reader, msg.offset);
        } else if (msg.type === MSG_DATATYPE && msg.offset < this.metadataBuffer.byteLength) {
          datatype = parseDatatypeMessage(reader, msg.offset);
        } else if (msg.type === MSG_DATA_LAYOUT && msg.offset < this.metadataBuffer.byteLength) {
          layout = parseDataLayoutMessage(reader, msg.offset, this.superblock);
        } else if (msg.type === MSG_FILTER_PIPELINE && msg.offset < this.metadataBuffer.byteLength) {
          filters = parseFilterPipelineMessage(reader, msg.offset);
        } else if (msg.type === MSG_LINK && msg.offset < this.metadataBuffer.byteLength) {
          const link = parseLinkMessage(reader, msg.offset, this.superblock);
          if (link && link.address != null) {
            childLinks.push(link);
          }
        } else if (msg.type === MSG_SYMBOL_TABLE && msg.offset < this.metadataBuffer.byteLength) {
          reader.seek(msg.offset);
          symbolTableBTree = reader.readOffset(this.superblock.offsetSize);
          symbolTableHeap = reader.readOffset(this.superblock.offsetSize);
        } else if (msg.type === MSG_OBJ_HEADER_CONTINUATION) {
          reader.seek(msg.offset);
          const contOffset = reader.readOffset(this.superblock.offsetSize);
          const contLength = reader.readLength(this.superblock.lengthSize);
          if (contOffset > 0 && contLength > 0 && contLength < 64 * 1024) {
            continuationBlocks.push({ offset: contOffset, length: contLength });
          }
        }
      } catch (e) {
        // Continue with other messages
      }
    }

    // ── Follow continuation blocks (v1 headers often have these) ────────
    for (const cont of continuationBlocks) {
      try {
        let contBuffer;
        if (cont.offset < this.metadataBuffer.byteLength &&
            cont.offset + cont.length <= this.metadataBuffer.byteLength) {
          // Continuation is within our metadata buffer
          contBuffer = this.metadataBuffer.slice(cont.offset, cont.offset + cont.length);
        } else {
          // Need to fetch from file
          console.log(`[h5chunk] Fetching continuation block at 0x${cont.offset.toString(16)} (${cont.length} bytes)`);
          contBuffer = await this._fetchBytes(cont.offset, cont.length);
        }

        const contMessages = parseV1ContinuationBlock(contBuffer, this.superblock);
        for (const cmsg of contMessages) {
          try {
            const cr = cmsg._reader;
            if (cmsg.type === MSG_SYMBOL_TABLE) {
              cr.seek(cmsg.offset);
              symbolTableBTree = cr.readOffset(this.superblock.offsetSize);
              symbolTableHeap = cr.readOffset(this.superblock.offsetSize);
              console.log(`[h5chunk] Found Symbol Table in continuation: B-tree=0x${symbolTableBTree.toString(16)}, Heap=0x${symbolTableHeap.toString(16)}`);
            } else if (cmsg.type === MSG_DATASPACE) {
              dataspace = parseDataspaceMessage(cr, cmsg.offset);
            } else if (cmsg.type === MSG_DATATYPE) {
              datatype = parseDatatypeMessage(cr, cmsg.offset);
            } else if (cmsg.type === MSG_DATA_LAYOUT) {
              layout = parseDataLayoutMessage(cr, cmsg.offset, this.superblock);
            } else if (cmsg.type === MSG_FILTER_PIPELINE) {
              filters = parseFilterPipelineMessage(cr, cmsg.offset);
            }
          } catch (e) {
            // Skip bad continuation messages
          }
        }
      } catch (e) {
        console.warn(`[h5chunk] Failed to read continuation at 0x${cont.offset.toString(16)}:`, e.message);
      }
    }

    // ── Handle v1 groups via Symbol Table traversal ─────────────────────
    if (symbolTableBTree != null && symbolTableHeap != null) {
      const children = enumerateGroupChildren(
        reader, symbolTableBTree, symbolTableHeap, this.superblock
      );
      console.log(`[h5chunk] Group ${path}: ${children.length} children via Symbol Table`);

      for (const child of children) {
        const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;

        if (child.cacheType === 1 && child.btreeAddr != null && child.heapAddr != null) {
          // Cached group — use scratch-pad B-tree/heap directly
          if (child.btreeAddr < this.metadataBuffer.byteLength &&
              child.heapAddr < this.metadataBuffer.byteLength) {
            const grandChildren = enumerateGroupChildren(
              reader, child.btreeAddr, child.heapAddr, this.superblock
            );
            console.log(`[h5chunk] Group ${childPath}: ${grandChildren.length} children (cached)`);

            for (const gc of grandChildren) {
              const gcPath = `${childPath}/${gc.name}`;
              try {
                await this._parseObjectAtAddress(reader, gc.objAddr, gcPath);
              } catch (e) {
                // Skip children we can't parse
              }
            }
          }
        } else {
          // Non-cached entry — parse the object header to determine type
          try {
            await this._parseObjectAtAddress(reader, child.objAddr, childPath);
          } catch (e) {
            // Skip children we can't parse
          }
        }
      }
    }

    // If we have dataspace and datatype, this is a dataset
    if (dataspace && datatype && dataspace.rank >= 1) {
      const datasetId = `dataset_${address.toString(16)}`;

      // Skip if already found
      if (this.datasets.has(datasetId)) {
        return;
      }

      const datasetInfo = {
        address,
        path,
        shape: dataspace.dims,
        dtype: datatype.dtype,
        bytesPerElement: datatype.size,
        layout,
        filters,
        chunks: null,
      };

      // Parse chunk index if chunked and B-tree is within our metadata
      if (layout && layout.type === 'chunked' && layout.btreeAddress) {
        if (layout.btreeAddress < this.metadataBuffer.byteLength) {
          try {
            if (layout.version < 4) {
              datasetInfo.chunks = parseBTreeV1(
                reader,
                layout.btreeAddress,
                this.superblock,
                dataspace.rank + 1,
                layout.chunkDims
              );
            }
          } catch (e) {
            console.warn(`[h5chunk] B-tree parse failed at 0x${layout.btreeAddress.toString(16)}`);
          }
        }
      }

      this.datasets.set(datasetId, datasetInfo);

      if (dataspace.rank === 2) {
        console.log(`[h5chunk] Found 2D dataset: ${dataspace.dims.join('x')} ${datatype.dtype} at 0x${address.toString(16)} path=${path}`);
      }
    }

    // Recursively follow hard links to traverse group hierarchy (v2 groups)
    for (const link of childLinks) {
      const childPath = path === '/' ? `/${link.name}` : `${path}/${link.name}`;
      try {
        await this._parseObjectAtAddress(reader, link.address, childPath);
      } catch (e) {
        // Skip children we can't parse
      }
    }
  }

  /**
   * Scan for chunked data layout messages directly in the buffer
   * This catches datasets we might have missed by signature scanning
   */
  async _scanForChunkedLayouts(reader, buffer) {
    // Look for Data Layout message version 3 or 4 with chunked class (0x02)
    // Layout v3: [version=3][class=2][rank][btree_addr][chunk_dims...]
    // Layout v4: [version=4][class=2][flags][rank][dim_size_enc][chunk_dims...][index_type][btree_addr]

    const candidates = [];

    for (let i = 0; i < buffer.length - 20; i++) {
      // Check for version 3 chunked layout
      if (buffer[i] === 3 && buffer[i + 1] === 2) {
        // Version 3, class 2 (chunked)
        const rank = buffer[i + 2];
        if (rank >= 1 && rank <= 10) {
          candidates.push({ offset: i, version: 3, rank });
        }
      }

      // Check for version 4 chunked layout
      if (buffer[i] === 4 && buffer[i + 1] === 2) {
        // Version 4, class 2 (chunked)
        const flags = buffer[i + 2];
        const rank = buffer[i + 3];
        if (rank >= 1 && rank <= 10 && flags <= 0x1F) {
          candidates.push({ offset: i, version: 4, rank, flags });
        }
      }
    }

    console.log(`[h5chunk] Found ${candidates.length} potential chunked layout messages`);

    // For each candidate, try to parse the layout directly and search for nearby dataspace/datatype
    for (const cand of candidates) {
      try {
        // Parse the layout message directly
        const layout = parseDataLayoutMessage(reader, cand.offset, this.superblock);

        if (layout && layout.type === 'chunked' && layout.chunkDims) {
          // Validate B-tree address - must be non-zero and reasonable
          const isValidBtree = layout.btreeAddress > 0x100 &&
                               layout.btreeAddress < this.file?.size || layout.btreeAddress < 2e9;

          if (!isValidBtree) {
            console.log(`[h5chunk] Skipping layout at 0x${cand.offset.toString(16)}: invalid btree addr 0x${layout.btreeAddress?.toString(16)}`);
            continue;
          }
          // Now search nearby for Dataspace and Datatype messages
          // They're typically within 200 bytes before the layout message
          const searchStart = Math.max(0, cand.offset - 500);
          const searchEnd = Math.min(buffer.length, cand.offset + 100);

          let dataspace = null;
          let datatype = null;

          // Look for Dataspace message (version 1 or 2)
          for (let j = searchStart; j < searchEnd - 10; j++) {
            // Dataspace v1: [version=1][rank][flags][reserved x5][dims...]
            // Dataspace v2: [version=2][rank][flags][type][dims...]
            if ((buffer[j] === 1 || buffer[j] === 2) && buffer[j + 1] >= 1 && buffer[j + 1] <= 10) {
              const dsRank = buffer[j + 1];
              // Validate this looks like a dataspace for our layout
              if (dsRank === cand.rank || dsRank === cand.rank - 1) {
                try {
                  dataspace = parseDataspaceMessage(reader, j);
                  if (dataspace && dataspace.dims && dataspace.dims.length >= 1) {
                    break;
                  }
                } catch (e) {
                  dataspace = null;
                }
              }
            }
          }

          // Look for Datatype message (floating point)
          for (let j = searchStart; j < searchEnd - 10; j++) {
            // Datatype class 1 (float) with version in high nibble
            const classAndVersion = buffer[j];
            const dtClass = classAndVersion & 0x0F;
            const dtVersion = (classAndVersion >> 4) & 0x0F;

            // Float class (1) or Fixed-point class (0)
            if ((dtClass === 1 || dtClass === 0) && dtVersion >= 0 && dtVersion <= 4) {
              // Next 3 bytes are bit fields, then 4 bytes for size
              const size = buffer[j + 4] | (buffer[j + 5] << 8) | (buffer[j + 6] << 16) | (buffer[j + 7] << 24);
              if (size === 4 || size === 8 || size === 2) {
                try {
                  datatype = parseDatatypeMessage(reader, j);
                  if (datatype && datatype.dtype) {
                    break;
                  }
                } catch (e) {
                  datatype = null;
                }
              }
            }
          }

          // Look for Filter Pipeline message nearby
          let filters = null;
          for (let j = searchStart; j < searchEnd - 10; j++) {
            // Filter pipeline v1: version=1, numFilters=1..10
            // Filter pipeline v2: version=2, numFilters=1..10
            if ((buffer[j] === 1 || buffer[j] === 2) && buffer[j + 1] >= 1 && buffer[j + 1] <= 10) {
              // Validate: for v1, bytes 2-7 should be reserved (zeros)
              if (buffer[j] === 1 && (buffer[j + 2] !== 0 || buffer[j + 3] !== 0)) continue;
              try {
                const f = parseFilterPipelineMessage(reader, j);
                if (f && f.length > 0 && f.every(flt => flt.id >= 1 && flt.id <= 32000)) {
                  filters = f;
                  break;
                }
              } catch (e) { /* skip */ }
            }
          }

          // If we found both, create a dataset
          if (dataspace && datatype && dataspace.rank >= 1) {
            const datasetId = `layout_${cand.offset.toString(16)}`;

            if (!this.datasets.has(datasetId)) {
              // The last chunk dim is the element size in bytes (HDF5 convention).
              // Use it to correct the dtype if the nearby datatype search was wrong.
              const elemSize = layout.chunkDims?.[layout.chunkDims.length - 1];
              let dtype = datatype.dtype;
              let bytesPerElement = datatype.size;
              if (elemSize && elemSize !== datatype.size && elemSize <= 8) {
                bytesPerElement = elemSize;
                if (elemSize === 4) dtype = 'float32';
                else if (elemSize === 8) dtype = 'float64';
                else if (elemSize === 2) dtype = 'float16';
              }

              const datasetInfo = {
                address: cand.offset,
                shape: dataspace.dims,
                dtype,
                bytesPerElement,
                layout,
                filters,
                chunks: null,
              };

              // Try to parse B-tree if within metadata
              if (layout.btreeAddress && layout.btreeAddress < this.metadataBuffer.byteLength) {
                console.log(`[h5chunk] Parsing B-tree at 0x${layout.btreeAddress.toString(16)} for dataset at 0x${cand.offset.toString(16)}`);
                try {
                  datasetInfo.chunks = parseBTreeV1(
                    reader,
                    layout.btreeAddress,
                    this.superblock,
                    dataspace.rank + 1,
                    layout.chunkDims
                  );
                  console.log(`[h5chunk] B-tree parsed: ${datasetInfo.chunks?.size || 0} chunks found`);
                } catch (e) {
                  console.warn(`[h5chunk] B-tree parse failed:`, e.message);
                }
              } else if (layout.btreeAddress) {
                console.log(`[h5chunk] B-tree at 0x${layout.btreeAddress.toString(16)} is beyond metadata buffer (${this.metadataBuffer.byteLength} bytes)`);
              }

              this.datasets.set(datasetId, datasetInfo);

              if (dataspace.rank === 2) {
                console.log(`[h5chunk] Found 2D chunked dataset: ${dataspace.dims.join('x')} ${datatype.dtype} (chunks: ${layout.chunkDims?.join('x') || 'unknown'})`);
              }
            }
          }
        }
      } catch (e) {
        // Skip this candidate
      }
    }
  }

  /**
   * Parse a v1 object header (no signature, starts with version byte = 1)
   */
  async _parseV1ObjectHeader(reader, address) {
    reader.seek(address);

    const version = reader.readUint8();
    if (version !== 1) {
      return;
    }

    reader.skip(1); // reserved
    const numMessages = reader.readUint16();
    const refCount = reader.readUint32();
    const headerSize = reader.readUint32();

    if (numMessages > 100 || headerSize > 10000) {
      return; // Sanity check
    }

    let dataspace = null;
    let datatype = null;
    let layout = null;
    let filters = null;

    for (let i = 0; i < numMessages; i++) {
      const msgType = reader.readUint16();
      const msgSize = reader.readUint16();
      const msgFlags = reader.readUint8();
      reader.skip(3); // reserved

      const msgStart = reader.pos;

      try {
        if (msgType === MSG_DATASPACE && msgStart + msgSize <= this.metadataBuffer.byteLength) {
          dataspace = parseDataspaceMessage(reader, msgStart);
        } else if (msgType === MSG_DATATYPE && msgStart + msgSize <= this.metadataBuffer.byteLength) {
          datatype = parseDatatypeMessage(reader, msgStart);
        } else if (msgType === MSG_DATA_LAYOUT && msgStart + msgSize <= this.metadataBuffer.byteLength) {
          layout = parseDataLayoutMessage(reader, msgStart, this.superblock);
        } else if (msgType === MSG_FILTER_PIPELINE && msgStart + msgSize <= this.metadataBuffer.byteLength) {
          filters = parseFilterPipelineMessage(reader, msgStart);
        }
      } catch (e) {
        // Continue
      }

      reader.seek(msgStart + msgSize);
    }

    // If we found a dataset
    if (dataspace && datatype && dataspace.rank >= 1) {
      const datasetId = `dataset_${address.toString(16)}`;

      if (!this.datasets.has(datasetId)) {
        const datasetInfo = {
          address,
          shape: dataspace.dims,
          dtype: datatype.dtype,
          bytesPerElement: datatype.size,
          layout,
          filters,
          chunks: null,
        };

        // Try to parse B-tree
        if (layout && layout.type === 'chunked' && layout.btreeAddress) {
          if (layout.btreeAddress < this.metadataBuffer.byteLength) {
            try {
              datasetInfo.chunks = parseBTreeV1(
                reader,
                layout.btreeAddress,
                this.superblock,
                dataspace.rank + 1,
                layout.chunkDims
              );
            } catch (e) {
              // B-tree might be beyond metadata
            }
          }
        }

        this.datasets.set(datasetId, datasetInfo);

        if (dataspace.rank === 2) {
          console.log(`[h5chunk] Found v1 2D dataset: ${dataspace.dims.join('x')} ${datatype.dtype}`);
        }
      }
    }
  }

  /**
   * Get a list of discovered datasets
   */
  getDatasets() {
    return Array.from(this.datasets.entries()).map(([key, info]) => ({
      id: key,
      path: info.path || null,
      shape: info.shape,
      dtype: info.dtype,
      chunked: info.layout?.type === 'chunked',
      chunkDims: info.layout?.chunkDims,
      numChunks: info.chunks?.size || 0,
    }));
  }

  /**
   * Find a dataset by its HDF5 path (e.g. '/science/LSAR/GCOV/grids/frequencyA/HHHH').
   * Returns the dataset ID or null if not found.
   * @param {string} targetPath — full HDF5 path
   * @returns {string|null}
   */
  findDatasetByPath(targetPath) {
    for (const [id, info] of this.datasets.entries()) {
      if (info.path === targetPath) return id;
    }
    // Also try matching just the tail component if the full path wasn't resolved
    const targetTail = targetPath.split('/').pop();
    for (const [id, info] of this.datasets.entries()) {
      if (info.path) {
        const tail = info.path.split('/').pop();
        if (tail === targetTail) return id;
      }
    }
    return null;
  }

  /**
   * Read a small contiguous dataset from the metadata buffer.
   *
   * NISAR metadata datasets (listOfFrequencies, listOfPolarizations,
   * projection scalars, coordinate spacing, etc.) are typically small
   * enough to live entirely within the metadata page we already fetched.
   *
   * For chunked imagery datasets, use readChunk() or readRegion() instead.
   *
   * @param {string} datasetId — dataset identifier from getDatasets()/findDatasetByPath()
   * @returns {{data: any, shape: number[], dtype: string}|null}
   */
  async readSmallDataset(datasetId) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return null;

    const { layout, dtype, shape, bytesPerElement } = dataset;
    if (!layout) return null;

    // Contiguous datasets
    if (layout.type === 'contiguous') {
      if (layout.address == null) return null;

      const totalElements = shape.reduce((a, b) => a * b, 1);
      const totalBytes = totalElements * bytesPerElement;

      // Try reading from metadata buffer first (fast path)
      if (layout.address + totalBytes <= this.metadataBuffer.byteLength) {
        if (dtype === 'string') {
          return this._readStringDatasetFromBuffer(this.metadataBuffer, layout.address, totalElements, bytesPerElement, shape);
        }
        const slice = this.metadataBuffer.slice(layout.address, layout.address + totalBytes);
        const data = this._decodeData(slice, dtype);
        return { data, shape, dtype };
      }

      // Data is beyond metadata buffer — fetch it via range request
      // Only fetch small datasets (< 64KB) to avoid accidentally pulling large arrays
      if (totalBytes > 65536) return null;
      try {
        const remoteBuffer = await this._fetchBytes(layout.address, totalBytes);
        if (!remoteBuffer) return null;
        if (dtype === 'string') {
          return this._readStringDatasetFromBuffer(remoteBuffer, 0, totalElements, bytesPerElement, shape);
        }
        const data = this._decodeData(remoteBuffer, dtype);
        return { data, shape, dtype };
      } catch (e) {
        console.warn(`[h5chunk] Failed to fetch small dataset ${datasetId}:`, e.message);
        return null;
      }
    }

    // For small chunked datasets (rare for metadata, but handle it)
    if (layout.type === 'chunked' && dataset.chunks && dataset.chunks.size === 1) {
      // Single chunk — read it from metadata if possible
      const entry = dataset.chunks.values().next().value;
      if (entry && entry.offset < this.metadataBuffer.byteLength) {
        const endOffset = entry.offset + entry.size;
        if (endOffset <= this.metadataBuffer.byteLength) {
          const slice = this.metadataBuffer.slice(entry.offset, endOffset);
          const data = this._decodeData(slice, dtype);
          return { data, shape, dtype };
        }
      }
    }

    return null;
  }

  /**
   * Read a fixed-length string dataset from a given buffer.
   * @private
   */
  _readStringDatasetFromBuffer(buffer, baseOffset, numElements, elementSize, shape) {
    const strings = [];
    const view = new Uint8Array(buffer);
    for (let i = 0; i < numElements; i++) {
      const start = baseOffset + i * elementSize;
      const end = start + elementSize;
      if (end > buffer.byteLength) break;
      let str = '';
      for (let j = start; j < end; j++) {
        if (view[j] === 0) break;
        str += String.fromCharCode(view[j]);
      }
      strings.push(str.trim());
    }
    return { data: strings, shape, dtype: 'string' };
  }

  /**
   * Read a chunk of data
   * @param {string} datasetId - Dataset identifier
   * @param {number} row - Chunk row index
   * @param {number} col - Chunk column index
   * @returns {Promise<Float32Array>}
   */
  async readChunk(datasetId, row, col) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    if (!dataset.chunks) {
      throw new Error('Dataset is not chunked or chunk index not available');
    }

    // B-tree keys are pixel offsets (e.g. "0,512"), not chunk indices (e.g. "0,1").
    // Convert chunk indices to pixel offsets using chunk dimensions.
    const chunkDims = dataset.layout?.chunkDims || [];
    const rowOffset = chunkDims.length >= 1 ? row * chunkDims[0] : row;
    const colOffset = chunkDims.length >= 2 ? col * chunkDims[1] : col;
    const chunkKey = `${rowOffset},${colOffset}`;
    const chunkInfo = dataset.chunks.get(chunkKey);

    if (!chunkInfo) {
      // Chunk doesn't exist (sparse data)
      return null;
    }

    // Read chunk data
    let buffer;
    if (this.file) {
      const slice = this.file.slice(chunkInfo.offset, chunkInfo.offset + chunkInfo.size);
      buffer = await slice.arrayBuffer();
    } else if (this.url) {
      const response = await fetch(this.url, {
        headers: {
          'Range': `bytes=${chunkInfo.offset}-${chunkInfo.offset + chunkInfo.size - 1}`,
        },
      });
      buffer = await response.arrayBuffer();
    }

    // Decompress if needed
    let data = buffer;
    const chunkDimsProduct = (dataset.layout?.chunkDims || [])
      .slice(0, -1) // exclude element size dim
      .reduce((a, b) => a * b, 1);
    const expectedBytes = chunkDimsProduct * dataset.bytesPerElement;

    if (dataset.filters && chunkInfo.filterMask === 0) {
      data = await this._decompressChunk(buffer, dataset.filters);
    } else if (!dataset.filters && buffer.byteLength < expectedBytes) {
      // No filter info but data is obviously compressed — try deflate as fallback
      try {
        data = await this._decompressChunk(buffer, [{ id: FILTER_DEFLATE }]);
      } catch (e) {
        // If deflate fails, try shuffle+deflate
        try {
          data = await this._decompressChunk(buffer, [
            { id: FILTER_SHUFFLE, params: [dataset.bytesPerElement] },
            { id: FILTER_DEFLATE },
          ]);
        } catch (e2) {
          // Use raw data as-is
        }
      }
    }

    // Convert to Float32Array
    return this._decodeData(data, dataset.dtype);
  }

  /**
   * Read a region of data (spanning multiple chunks)
   * @param {string} datasetId - Dataset identifier
   * @param {number} startRow - Start row
   * @param {number} startCol - Start column
   * @param {number} numRows - Number of rows
   * @param {number} numCols - Number of columns
   * @returns {Promise<{data: Float32Array, width: number, height: number}>}
   */
  async readRegion(datasetId, startRow, startCol, numRows, numCols) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    const [chunkRows, chunkCols] = dataset.layout?.chunkDims || [numRows, numCols];

    // Determine which chunks we need
    const startChunkRow = Math.floor(startRow / chunkRows);
    const endChunkRow = Math.floor((startRow + numRows - 1) / chunkRows);
    const startChunkCol = Math.floor(startCol / chunkCols);
    const endChunkCol = Math.floor((startCol + numCols - 1) / chunkCols);

    const result = new Float32Array(numRows * numCols);

    // Read each chunk
    for (let cr = startChunkRow; cr <= endChunkRow; cr++) {
      for (let cc = startChunkCol; cc <= endChunkCol; cc++) {
        try {
          const chunkData = await this.readChunk(datasetId, cr, cc);
          if (!chunkData) continue;

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

              if (srcIdx < chunkData.length) {
                result[dstIdx] = chunkData[srcIdx];
              }
            }
          }
        } catch (e) {
          console.warn(`[h5chunk] Failed to read chunk (${cr}, ${cc}):`, e.message);
        }
      }
    }

    return {
      data: result,
      width: numCols,
      height: numRows,
    };
  }

  /**
   * Decompress chunk data
   */
  async _decompressChunk(buffer, filters) {
    let data = new Uint8Array(buffer);

    // Apply filters in reverse order
    for (let i = filters.length - 1; i >= 0; i--) {
      const filter = filters[i];

      switch (filter.id) {
        case FILTER_DEFLATE:
          data = await this._inflateData(data);
          break;

        case FILTER_SHUFFLE:
          data = this._unshuffle(data, filter.params[0] || 4);
          break;

        // Other filters would go here
      }
    }

    return data.buffer;
  }

  /**
   * Inflate (decompress) zlib-compressed data.
   * HDF5 deflate filter uses zlib format.
   * Works in both Node.js (via zlib module) and browser (via DecompressionStream).
   */
  async _inflateData(data) {
    // 1. Try browser DecompressionStream first (native, no dependencies)
    //    'deflate' format = RFC 1950 zlib, which is what HDF5 deflate uses
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(data);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return result;
      } catch (e) {
        // DecompressionStream failed, try other methods
      }
    }

    throw new Error('No deflate decompressor available (need DecompressionStream)');
  }

  /**
   * Unshuffle filter
   */
  _unshuffle(data, elementSize) {
    const count = data.length / elementSize;
    const result = new Uint8Array(data.length);

    for (let i = 0; i < count; i++) {
      for (let j = 0; j < elementSize; j++) {
        result[i * elementSize + j] = data[j * count + i];
      }
    }

    return result;
  }

  /**
   * Decode raw bytes to Float32Array
   */
  _decodeData(buffer, dtype) {
    switch (dtype) {
      case 'float32':
        return new Float32Array(buffer);
      case 'float64':
        return new Float32Array(new Float64Array(buffer));
      case 'float16':
        return this._decodeFloat16(buffer);
      case 'int16':
        return new Float32Array(new Int16Array(buffer));
      case 'uint16':
        return new Float32Array(new Uint16Array(buffer));
      case 'int32':
        return new Float32Array(new Int32Array(buffer));
      case 'uint32':
        return new Float32Array(new Uint32Array(buffer));
      default:
        console.warn(`[h5chunk] Unknown dtype: ${dtype}, assuming float32`);
        return new Float32Array(buffer);
    }
  }

  /**
   * Decode float16 to float32
   */
  _decodeFloat16(buffer) {
    const uint16 = new Uint16Array(buffer);
    const result = new Float32Array(uint16.length);

    for (let i = 0; i < uint16.length; i++) {
      const h = uint16[i];
      const sign = (h & 0x8000) >> 15;
      const exp = (h & 0x7C00) >> 10;
      const frac = h & 0x03FF;

      if (exp === 0) {
        if (frac === 0) {
          result[i] = sign ? -0 : 0;
        } else {
          result[i] = (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
        }
      } else if (exp === 31) {
        result[i] = frac ? NaN : (sign ? -Infinity : Infinity);
      } else {
        result[i] = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
      }
    }

    return result;
  }
}

/**
 * Create an H5Chunk reader for a local file
 * @param {File} file
 * @param {number} metadataSize
 * @returns {Promise<H5Chunk>}
 */
export async function openH5ChunkFile(file, metadataSize = 8 * 1024 * 1024) {
  const reader = new H5Chunk();
  await reader.openFile(file, metadataSize);
  return reader;
}

/**
 * Create an H5Chunk reader for a URL
 * @param {string} url
 * @param {number} metadataSize
 * @returns {Promise<H5Chunk>}
 */
export async function openH5ChunkUrl(url, metadataSize = 8 * 1024 * 1024) {
  const reader = new H5Chunk();
  await reader.openUrl(url, metadataSize);
  return reader;
}

export default H5Chunk;
