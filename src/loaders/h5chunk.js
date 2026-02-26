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
const MSG_LINK_INFO = 0x0002;
const MSG_GROUP_INFO = 0x000A;

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
  /**
   * @param {ArrayBuffer} buffer
   * @param {boolean} littleEndian
   * @param {number} baseOffset — logical file position that buffer[0] maps to.
   *   When 0 (default), pos == buffer index (backward compatible).
   *   When >0, all seek/read operations use absolute file positions while
   *   internal buffer access is adjusted by subtracting baseOffset.
   */
  constructor(buffer, littleEndian = true, baseOffset = 0) {
    this.view = new DataView(buffer);
    this.pos = baseOffset;
    this.le = littleEndian;
    this._base = baseOffset;
  }

  /** Buffer-relative offset (for internal DataView access). */
  get _off() { return this.pos - this._base; }

  /** Check if n bytes are available from current position. */
  canRead(n) { return this._off >= 0 && this._off + n <= this.view.byteLength; }

  seek(pos) {
    this.pos = pos;
  }

  skip(n) {
    this.pos += n;
  }

  readUint8() {
    const v = this.view.getUint8(this._off);
    this.pos += 1;
    return v;
  }

  readUint16() {
    const v = this.view.getUint16(this._off, this.le);
    this.pos += 2;
    return v;
  }

  readUint32() {
    const v = this.view.getUint32(this._off, this.le);
    this.pos += 4;
    return v;
  }

  readUint64() {
    const v = this.view.getBigUint64(this._off, this.le);
    this.pos += 8;
    return Number(v);
  }

  readBytes(n) {
    const arr = new Uint8Array(this.view.buffer, this._off, n);
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
  // Superblock version parsed

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

    if (dataAddr + dataSize > reader.view.byteLength) {
      console.warn(`[h5chunk] Local heap at 0x${address.toString(16)} overflows buffer ` +
        `(data at 0x${dataAddr.toString(16)}, size ${dataSize}, buffer ${reader.view.byteLength})`);
      return null;
    }

    const dataSegment = new Uint8Array(reader.view.buffer, dataAddr, dataSize);
    return { dataSegment };
  } catch (e) {
    console.warn(`[h5chunk] Failed to parse local heap at 0x${address.toString(16)}: ${e.message}`);
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
function walkGroupBTree(reader, address, superblock, heapData, visited) {
  if (!visited) visited = new Set();
  const results = [];
  try {
    if (address >= reader.view.byteLength) return results;
    if (visited.has(address)) return results; // cycle detection
    visited.add(address);

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
          results.push(...walkGroupBTree(reader, childAddr, superblock, heapData, visited));
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

    // Optional timestamps (bit 5 per HDF5 spec §III.C)
    if (flags & 0x20) {
      reader.skip(16); // access, modification, change, birth times
    }

    // Optional non-default attribute storage phase change values (bit 4)
    if (flags & 0x10) {
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

    case 6: // Compound — detect complex number types (CFloat32, CFloat64)
      // NISAR GCOV off-diagonal terms are CFloat32: {r: float32, i: float32}
      littleEndian = true; // compound members inherit file byte order
      if (size === 8) dtype = 'cfloat32';
      else if (size === 16) dtype = 'cfloat64';
      else dtype = `compound${size}`;
      break;

    default:
      dtype = `class${dtClass}`;
  }

  return { dtype, size, littleEndian };
}

/**
 * Parse an HDF5 attribute message (MSG_ATTRIBUTE = 0x000C).
 *
 * Returns { name, value } where value is a decoded JS value:
 *   - Number or TypedArray for numeric attributes
 *   - String for string attributes
 *   - null if parsing fails
 *
 * Supports attribute message versions 1, 2, and 3.
 * See HDF5 spec: IV.A.2.m "Attribute Message"
 */
function parseAttributeMessage(reader, offset, _metadataBuffer) {
  try {
    reader.seek(offset);
    const version = reader.readUint8();

    if (version < 1 || version > 3) return null;

    let nameSize, dtypeSize, dspaceSize;
    let encoding = 0;

    if (version === 1) {
      reader.readUint8(); // reserved
      nameSize = reader.readUint16();
      dtypeSize = reader.readUint16();
      dspaceSize = reader.readUint16();
    } else {
      // version 2 or 3
      const flags = reader.readUint8();
      nameSize = reader.readUint16();
      dtypeSize = reader.readUint16();
      dspaceSize = reader.readUint16();
      if (version === 3 && (flags & 0x04)) {
        encoding = reader.readUint8();
      }
    }

    // Read attribute name
    const nameBytes = reader.readBytes(nameSize);
    let name = '';
    for (let i = 0; i < nameBytes.length; i++) {
      if (nameBytes[i] === 0) break;
      name += String.fromCharCode(nameBytes[i]);
    }

    // v1 pads name to 8-byte boundary
    if (version === 1) {
      const padded = Math.ceil(nameSize / 8) * 8;
      reader.seek(offset + 8 + padded);
    }

    // Parse datatype
    const dtypeOffset = reader.pos;
    const datatype = parseDatatypeMessage(reader, dtypeOffset);
    if (version === 1) {
      const dtypePadded = Math.ceil(dtypeSize / 8) * 8;
      reader.seek(dtypeOffset + dtypePadded);
    } else {
      reader.seek(dtypeOffset + dtypeSize);
    }

    // Parse dataspace
    const dspaceOffset = reader.pos;
    const dataspace = parseDataspaceMessage(reader, dspaceOffset);
    if (version === 1) {
      const dspacePadded = Math.ceil(dspaceSize / 8) * 8;
      reader.seek(dspaceOffset + dspacePadded);
    } else {
      reader.seek(dspaceOffset + dspaceSize);
    }

    // Read raw data via reader (works with both local metadata buffer
    // and remote buffers that have a non-zero baseOffset)
    const totalElements = dataspace.dims.reduce((a, b) => a * b, 1) || 1;
    const dataBytes = totalElements * datatype.size;

    if (!reader.canRead(dataBytes)) return null;

    // Decode the attribute value
    if (datatype.dtype === 'string') {
      const view = reader.readBytes(dataBytes);
      let str = '';
      for (let i = 0; i < view.length; i++) {
        if (view[i] === 0) break;
        str += String.fromCharCode(view[i]);
      }
      return { name, value: str.trim() };
    }

    const rawBytes = reader.readBytes(dataBytes);
    const slice = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);
    let value;
    if (datatype.dtype === 'float64') {
      value = new Float64Array(slice);
    } else if (datatype.dtype === 'float32') {
      value = new Float32Array(slice);
    } else if (datatype.dtype === 'uint32') {
      value = new Uint32Array(slice);
    } else if (datatype.dtype === 'int32') {
      value = new Int32Array(slice);
    } else if (datatype.dtype === 'uint16') {
      value = new Uint16Array(slice);
    } else if (datatype.dtype === 'int16') {
      value = new Int16Array(slice);
    } else {
      return { name, value: null };
    }

    // Return scalar for single-element arrays
    if (totalElements === 1) {
      return { name, value: value[0] };
    }
    return { name, value };
  } catch (e) {
    return null;
  }
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

    if (layoutClass === LAYOUT_COMPACT) {
      const dataSize = reader.readUint16();
      const dataOffset = reader.pos; // data follows inline
      return {
        type: 'compact',
        address: dataOffset,
        size: dataSize,
        _reader: reader, // keep reference to read inline data
      };
    } else if (layoutClass === LAYOUT_CONTIGUOUS) {
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

    if (layoutClass === LAYOUT_COMPACT) {
      const dataSize = reader.readUint16();
      const dataOffset = reader.pos;
      return {
        type: 'compact',
        address: dataOffset,
        size: dataSize,
        _reader: reader,
      };
    } else if (layoutClass === LAYOUT_CONTIGUOUS) {
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
  const MAX_DEPTH = 100; // Prevent stack overflow from malicious/corrupted files

  function parseNode(nodeAddress, depth = 0) {
    if (depth > MAX_DEPTH) {
      throw new Error(`[h5chunk] B-tree depth exceeded ${MAX_DEPTH} — possible infinite recursion or corrupted file`);
    }

    reader.seek(nodeAddress);

    const sig = reader.readBytes(4);
    const sigStr = String.fromCharCode(...sig);

    if (sigStr !== 'TREE') {
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
        // Internal node - recurse into child.
        // Wrap individually so one out-of-range child doesn't lose
        // chunks that were already collected from other children.
        try {
          parseNode(entry.childAddress, depth + 1);
        } catch (e) {
          console.warn(`[h5chunk] B-tree child at 0x${entry.childAddress.toString(16)} failed: ${e.message}`);
        }
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
    this.objectAttributes = new Map(); // path -> {attrName: value}
    this.metadataBuffer = null;
    this.file = null;
    this.url = null;
    this._shardUrls = null; // Array of presigned URLs for connection sharding
    this._shardIdx = 0;     // Round-robin index for shard rotation
    // Global fetch semaphore — limits total in-flight HTTP requests across
    // ALL concurrent readChunksBatch/readChunk calls sharing this instance.
    // Without this, dozens of tile requests compete for 2 TCP connections,
    // causing tile starvation (no single tile can complete).
    this._fetchActive = 0;
    this._fetchLimit = 8;   // max concurrent HTTP requests (across all tiles)
    this._fetchQueue = [];  // pending resolve callbacks
    this.lazyTreeWalking = true; // Enable lazy tree-walking (fetch B-trees on-demand)
  }

  /**
   * Open a local HDF5 file
   * @param {File} file - Local file from input[type="file"]
   * @param {number} metadataSize - Bytes to read for metadata (default 8MB for bulk, or auto for lazy)
   */
  async openFile(file, metadataSize = null) {
    this.file = file;

    console.log(`[h5chunk] Opening file: ${file.name}`);
    console.log(`[h5chunk] File size: ${(file.size / 1e6).toFixed(1)} MB`);

    // Local files: read 1MB upfront (covers full tree structure for most NISAR products).
    // This is cheap for local I/O and avoids missing groups during lazy tree-walking
    // that would require many small remote fetches.
    // Bulk mode: read full metadata page (8 MB).
    const readSize = metadataSize || (this.lazyTreeWalking ? 1024 * 1024 : 8 * 1024 * 1024);
    console.log(`[h5chunk] Reading initial metadata: ${(readSize / 1024).toFixed(1)} KB (lazy=${this.lazyTreeWalking})`);

    // Read metadata portion
    const slice = file.slice(0, Math.min(readSize, file.size));
    this.metadataBuffer = await slice.arrayBuffer();

    await this._parseMetadata();
  }

  /**
   * Open an HDF5 file from URL
   * @param {string} url - HTTP(S) URL supporting range requests
   * @param {number} metadataSize - Bytes to read for metadata (default auto-sized for lazy/bulk)
   */
  async openUrl(url, metadataSize = null) {
    this.url = url;

    console.log(`[h5chunk] Opening URL: ${url}`);

    // Remote URLs: read 8 MB upfront in lazy mode. NISAR HDF5 files have 150+
    // datasets whose object headers, B-tree nodes and heap data span 4-6 MB.
    // At 1 MB only a fraction fits in-buffer, forcing ~280 sequential HTTP
    // round-trips during tree walking (each ~130 ms to S3 = 36+ seconds).
    // 8 MB captures virtually all structural metadata in a single request.
    const readSize = metadataSize || 8 * 1024 * 1024;
    console.log(`[h5chunk] Reading initial metadata: ${(readSize / 1024).toFixed(1)} KB (lazy=${this.lazyTreeWalking})`);

    // Fetch metadata with range request
    const response = await fetch(url, {
      headers: {
        'Range': `bytes=0-${readSize - 1}`,
      },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch metadata: ${response.status}`);
    }

    this.metadataBuffer = await response.arrayBuffer();

    await this._parseMetadata();
  }

  /**
   * Set shard URLs for connection sharding.
   * Presigned URLs for different S3 hostnames force separate TCP connections.
   * @param {string[]} urls — Array of presigned URLs (one per shard)
   */
  setShardUrls(urls) {
    if (urls && urls.length > 0) {
      this._shardUrls = urls;
      this._shardIdx = 0;
      console.log(`[h5chunk] Shard URLs set: ${urls.length} shards`);
    }
  }

  /** Acquire a fetch slot (blocks if at limit). Throws if signal is aborted. */
  async _acquireSlot(signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this._fetchActive < this._fetchLimit) {
      this._fetchActive++;
      return;
    }
    await new Promise((resolve, reject) => {
      if (signal) {
        const onAbort = () => {
          const idx = this._fetchQueue.indexOf(resolve);
          if (idx >= 0) this._fetchQueue.splice(idx, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this._fetchQueue.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      } else {
        this._fetchQueue.push(resolve);
      }
    });
    this._fetchActive++;
  }

  /** Release a fetch slot */
  _releaseSlot() {
    this._fetchActive--;
    if (this._fetchQueue.length > 0) {
      this._fetchQueue.shift()();
    }
  }

  /** Gated fetch: acquires slot, fetches, releases slot. Supports AbortSignal. */
  async _gatedFetch(url, start, end, signal) {
    await this._acquireSlot(signal);
    try {
      const response = await fetch(url, {
        headers: { 'Range': `bytes=${start}-${end}` },
        signal,
      });
      if (!response.ok && response.status !== 206) {
        console.warn(`[h5chunk] Range fetch failed: ${response.status}`);
        return null;
      }
      return await response.arrayBuffer();
    } finally {
      this._releaseSlot();
    }
  }

  /** Get next URL via round-robin shard rotation */
  _nextUrl() {
    if (this._shardUrls && this._shardUrls.length > 1) {
      const url = this._shardUrls[this._shardIdx % this._shardUrls.length];
      this._shardIdx++;
      return url;
    }
    return (this._shardUrls && this._shardUrls[0]) || this.url;
  }

  /**
   * Parse the metadata buffer
   */
  async _parseMetadata() {
    const reader = new BufferReader(this.metadataBuffer);

    // Parse superblock
    this.superblock = parseSuperblock(reader);


    // Parse root group and traverse structure
    // This is where we build the dataset index
    await this._scanForDatasets(reader);
  }

  /**
   * Fetch arbitrary bytes from the file (for continuation blocks outside the
   * metadata buffer). Works for both local File objects and remote URLs.
   *
   * For remote URLs, uses a read-ahead cache: small reads (< 64 KB) are
   * promoted to 512 KB fetches, and the surplus is cached. This coalesces
   * many sequential tiny tree-walking reads into far fewer HTTP round-trips.
   *
   * @param {number} offset - Byte offset in the file
   * @param {number} length - Number of bytes to fetch
   * @returns {Promise<ArrayBuffer>}
   */
  async _fetchBytes(offset, length) {
    // Guard against overflow offsets from readUint64 exceeding MAX_SAFE_INTEGER
    if (offset > Number.MAX_SAFE_INTEGER || offset < 0 || length <= 0) {
      throw new Error(`Invalid fetch range: offset=${offset}, length=${length}`);
    }
    if (this.file) {
      const slice = this.file.slice(offset, offset + length);
      return slice.arrayBuffer();
    } else if (this.url) {
      // Check the read-ahead cache first
      if (this._readAheadCache) {
        const { start, buffer } = this._readAheadCache;
        const end = start + buffer.byteLength;
        if (offset >= start && offset + length <= end) {
          return buffer.slice(offset - start, offset - start + length);
        }
      }

      // For small reads, fetch a larger region and cache the surplus
      const READ_AHEAD = 512 * 1024; // 512 KB
      const actualLength = length < 65536 ? Math.max(length, READ_AHEAD) : length;
      const response = await fetch(this.url, {
        headers: { 'Range': `bytes=${offset}-${offset + actualLength - 1}` },
      });
      const fullBuffer = await response.arrayBuffer();

      // Cache the full fetch for subsequent reads in the same region
      if (actualLength > length) {
        this._readAheadCache = { start: offset, buffer: fullBuffer };
      }

      return length < fullBuffer.byteLength
        ? fullBuffer.slice(0, length)
        : fullBuffer;
    }
    throw new Error('No file or URL available');
  }

  /**
   * Scan for NISAR datasets
   * Uses multiple strategies:
   * 1. Parse from root group address
   * 2. Scan for v1 object headers (no signature, but known structure) [disabled in lazy mode]
   * 3. Scan for v2 object headers (OHDR signature) [disabled in lazy mode]
   * 4. Look for Data Layout messages that indicate chunked datasets [disabled in lazy mode]
   */
  async _scanForDatasets(reader) {

    const buffer = new Uint8Array(this.metadataBuffer);

    // Strategy 1: Parse from root group (v2 superblock points to object header)
    try {
      await this._parseObjectAtAddress(reader, this.superblock.rootGroupAddress, '/');
    } catch (e) {
      console.warn('[h5chunk] Failed to parse root group:', e.message);
    }

    // Skip signature scanning in lazy tree-walking mode (saves bandwidth + time)
    if (this.lazyTreeWalking) {
      console.log(`[h5chunk] Lazy mode: skipping signature scans, found ${this.datasets.size} datasets from root group`);
      return;
    }

    // Strategy 2: Scan for OHDR signatures (v2 object headers)
    const ohdrs = [];
    for (let i = 0; i < buffer.length - 4; i++) {
      if (buffer[i] === 0x4F && buffer[i + 1] === 0x48 &&
          buffer[i + 2] === 0x44 && buffer[i + 3] === 0x52) {
        ohdrs.push(i);
      }
    }

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
    // Determine which reader to use: the metadata reader or a remote one
    let activeReader = reader;
    const isRemote = address >= this.metadataBuffer.byteLength;

    if (isRemote) {
      // Initial fetch: 8KB covers most object headers (scalar datasets,
      // small groups). Groups with many children (e.g. NISAR frequencyA
      // with 15+ datasets) may need more — we re-fetch if the v1 header
      // declares a larger size.
      let fetchSize = 8192;
      let buf = await this._fetchBytes(address, fetchSize);

      // Check v1 object header size — if the declared headerSize exceeds
      // our fetch, re-fetch with enough data to capture all messages.
      const firstByte = new Uint8Array(buf)[0];
      if (firstByte === 1) {
        // v1 header: version(1) + reserved(1) + numMessages(2) + refCount(4) + headerSize(4) = 12 bytes prefix
        if (buf.byteLength >= 16) {
          const dv = new DataView(buf);
          const declaredHeaderSize = dv.getUint32(8, true); // headerSize at offset 8
          const needed = 16 + declaredHeaderSize; // prefix (aligned to 16) + messages
          if (needed > fetchSize) {
            fetchSize = Math.min(needed + 256, 256 * 1024); // cap at 256KB
            buf = await this._fetchBytes(address, fetchSize);
          }
        }
      }

      activeReader = new BufferReader(buf, true, address);
    }

    const messages = parseObjectHeader(activeReader, this.superblock, address);
    let dataspace = null;
    let datatype = null;
    let layout = null;
    let filters = null;
    const childLinks = []; // Collect Link messages (v2 groups)
    let symbolTableBTree = null;
    let symbolTableHeap = null;
    let linkInfoFheapAddr = null; // Fractal heap address from Link Info (v2 groups)
    const continuationBlocks = []; // {offset, length} for v1 continuation
    const attributes = new Map(); // Collect attribute messages

    for (const msg of messages) {
      try {
        if (msg.type === MSG_DATASPACE) {
          dataspace = parseDataspaceMessage(activeReader, msg.offset);
        } else if (msg.type === MSG_DATATYPE) {
          datatype = parseDatatypeMessage(activeReader, msg.offset);
        } else if (msg.type === MSG_DATA_LAYOUT) {
          layout = parseDataLayoutMessage(activeReader, msg.offset, this.superblock);
        } else if (msg.type === MSG_FILTER_PIPELINE) {
          filters = parseFilterPipelineMessage(activeReader, msg.offset);
        } else if (msg.type === MSG_ATTRIBUTE) {
          const attr = parseAttributeMessage(activeReader, msg.offset, null);
          if (attr && attr.name) {
            attributes.set(attr.name, attr.value);
          }
        } else if (msg.type === MSG_LINK) {
          const link = parseLinkMessage(activeReader, msg.offset, this.superblock);
          if (link && link.address != null) {
            childLinks.push(link);
          }
        } else if (msg.type === MSG_LINK_INFO) {
          // v2 group: Link Info message → fractal heap + B-tree v2
          activeReader.seek(msg.offset);
          const liVersion = activeReader.readUint8();
          const liFlags = activeReader.readUint8();
          if (liFlags & 0x01) activeReader.skip(8); // max creation index
          linkInfoFheapAddr = activeReader.readOffset(this.superblock.offsetSize);
          // name index B-tree v2 address (skip — we parse the heap directly)
          activeReader.readOffset(this.superblock.offsetSize);
        } else if (msg.type === MSG_SYMBOL_TABLE) {
          activeReader.seek(msg.offset);
          symbolTableBTree = activeReader.readOffset(this.superblock.offsetSize);
          symbolTableHeap = activeReader.readOffset(this.superblock.offsetSize);
        } else if (msg.type === MSG_OBJ_HEADER_CONTINUATION) {
          activeReader.seek(msg.offset);
          const contOffset = activeReader.readOffset(this.superblock.offsetSize);
          const contLength = activeReader.readLength(this.superblock.lengthSize);
          if (contOffset > 0 && contLength > 0 && contLength < 64 * 1024) {
            continuationBlocks.push({ offset: contOffset, length: contLength });
          }
        }
      } catch (e) {
        // Continue with other messages
      }
    }

    // ── Follow continuation blocks (v1 headers often have these) ────────
    // Use index-based loop because nested continuations may append entries.
    for (let ci = 0; ci < continuationBlocks.length; ci++) {
      const cont = continuationBlocks[ci];
      try {
        let contBuffer;
        if (cont.offset < this.metadataBuffer.byteLength &&
            cont.offset + cont.length <= this.metadataBuffer.byteLength) {
          // Continuation is within our metadata buffer
          contBuffer = this.metadataBuffer.slice(cont.offset, cont.offset + cont.length);
        } else {
          // Need to fetch from file
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
            } else if (cmsg.type === MSG_DATASPACE) {
              dataspace = parseDataspaceMessage(cr, cmsg.offset);
            } else if (cmsg.type === MSG_DATATYPE) {
              datatype = parseDatatypeMessage(cr, cmsg.offset);
            } else if (cmsg.type === MSG_DATA_LAYOUT) {
              layout = parseDataLayoutMessage(cr, cmsg.offset, this.superblock);
            } else if (cmsg.type === MSG_FILTER_PIPELINE) {
              filters = parseFilterPipelineMessage(cr, cmsg.offset);
            } else if (cmsg.type === MSG_ATTRIBUTE) {
              const attr = parseAttributeMessage(cr, cmsg.offset, contBuffer);
              if (attr && attr.name) {
                attributes.set(attr.name, attr.value);
              }
            } else if (cmsg.type === MSG_OBJ_HEADER_CONTINUATION) {
              // Nested continuation — follow the chain
              cr.seek(cmsg.offset);
              const nestedOffset = cr.readOffset(this.superblock.offsetSize);
              const nestedLength = cr.readLength(this.superblock.lengthSize);
              if (nestedOffset > 0 && nestedLength > 0 && nestedLength < 64 * 1024) {
                continuationBlocks.push({ offset: nestedOffset, length: nestedLength });
              }
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
      let children;
      if (symbolTableBTree < this.metadataBuffer.byteLength &&
          symbolTableHeap < this.metadataBuffer.byteLength) {
        children = enumerateGroupChildren(
          reader, symbolTableBTree, symbolTableHeap, this.superblock
        );
      } else {
        // Symbol table B-tree/heap are beyond metadata buffer — fetch remotely
        try {
          children = await this._enumerateRemoteGroup(symbolTableBTree, symbolTableHeap);
        } catch (e) {
          console.warn(`[h5chunk] Failed to enumerate remote group ${path}:`, e.message);
          children = [];
        }
      }
      // Parse children in parallel (critical for remote URLs — avoids sequential round-trips)
      const childPromises = children.map(async (child) => {
        const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;

        if (child.cacheType === 1 && child.btreeAddr != null && child.heapAddr != null) {
          // Cached group — use scratch-pad B-tree/heap directly
          if (child.btreeAddr < this.metadataBuffer.byteLength &&
              child.heapAddr < this.metadataBuffer.byteLength) {
            const grandChildren = enumerateGroupChildren(
              reader, child.btreeAddr, child.heapAddr, this.superblock
            );
            await Promise.all(grandChildren.map(gc => {
              const gcPath = `${childPath}/${gc.name}`;
              return this._parseObjectAtAddress(reader, gc.objAddr, gcPath).catch(() => {});
            }));
          } else {
            // Cached group but B-tree/heap beyond metadata buffer —
            // fetch the needed regions and enumerate children remotely.
            try {
              const grandChildren = await this._enumerateRemoteGroup(
                child.btreeAddr, child.heapAddr
              );
              await Promise.all(grandChildren.map(gc => {
                const gcPath = `${childPath}/${gc.name}`;
                return this._parseObjectAtAddress(reader, gc.objAddr, gcPath).catch(() => {});
              }));
            } catch (e) {
              console.warn(`[h5chunk] Failed to enumerate remote group ${childPath}:`, e.message);
            }
          }
        } else {
          // Non-cached entry — parse the object header to determine type
          try {
            await this._parseObjectAtAddress(reader, child.objAddr, childPath);
          } catch (e) {
            console.warn(`[h5chunk] Failed to parse ${childPath}:`, e.message);
          }
        }
      });
      await Promise.all(childPromises);
    }

    // ── Handle v2 groups via Link Info / fractal heap ───────────────────
    if (linkInfoFheapAddr != null && linkInfoFheapAddr !== 0xffffffffffffffff) {
      try {
        const v2Links = await this._enumerateV2GroupLinks(linkInfoFheapAddr);
        // Parse all v2 children in parallel
        await Promise.all(v2Links.map(link => {
          const childPath = path === '/' ? `/${link.name}` : `${path}/${link.name}`;
          return this._parseObjectAtAddress(reader, link.address, childPath).catch(() => {});
        }));
      } catch (e) {
        console.warn(`[h5chunk] Failed to enumerate v2 group ${path}:`, e.message);
      }
    }

    // If we have dataspace and datatype, this is a dataset
    if (dataspace && datatype && dataspace.rank >= 0) {
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
        attributes: attributes.size > 0 ? Object.fromEntries(attributes) : null,
      };

      // Parse chunk index if chunked and B-tree is within our metadata
      // In lazy mode, skip B-tree parsing (will be fetched on-demand)
      if (layout && layout.type === 'chunked' && layout.btreeAddress && !this.lazyTreeWalking) {
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

    }

    // Store attributes for any object (dataset or group) that has them
    if (attributes.size > 0 && path) {
      this.objectAttributes.set(path, Object.fromEntries(attributes));
    }

    // Recursively follow hard links in parallel (v2 groups)
    if (childLinks.length > 0) {
      await Promise.all(childLinks.map(link => {
        const childPath = path === '/' ? `/${link.name}` : `${path}/${link.name}`;
        return this._parseObjectAtAddress(reader, link.address, childPath).catch(() => {});
      }));
    }
  }

  /**
   * Enumerate children of a v2-style group by parsing its fractal heap.
   * v2 groups store links in a fractal heap referenced by a Link Info message.
   * This method fetches the FRHP header, walks indirect/direct blocks, and
   * extracts HDF5 Link messages containing child names and target addresses.
   *
   * @param {number} fheapAddr — Fractal heap (FRHP) address from Link Info msg
   * @returns {Promise<Array<{name: string, address: number}>>}
   */
  async _enumerateV2GroupLinks(fheapAddr) {
    const oSize = this.superblock.offsetSize;

    // ── 1. Parse FRHP header ──
    // sig(4) + ver(1) + heapIdLen(2) + ioFilterLen(2) + flags(1) + maxManaged(4)
    // + 12 × length/offset fields (8 bytes each) + tableWidth(2) + startBlock(8)
    // + maxDirect(8) + maxHeapSize(2) + startRows(2) + rootAddr(oSize) + curRows(2)
    // + checksum(4) ≈ 150 bytes. Fetch 256 to be safe.
    const frhpBuf = await this._fetchBytes(fheapAddr, 256);
    const fv = new DataView(frhpBuf);

    const sig = String.fromCharCode(fv.getUint8(0), fv.getUint8(1), fv.getUint8(2), fv.getUint8(3));
    if (sig !== 'FRHP') throw new Error(`Bad fractal heap signature: ${sig}`);

    let fo = 4;
    fo += 1; // version
    const heapIdLen = fv.getUint16(fo, true); fo += 2;
    const ioFilterLen = fv.getUint16(fo, true); fo += 2;
    fo += 1; // flags
    fo += 4; // max managed object size
    fo += 8; // next huge ID
    fo += 8; // huge objects B-tree v2 addr
    fo += 8; // free space in managed blocks
    fo += 8; // managed objects address
    fo += 8; // managed space
    fo += 8; // managed alloc
    fo += 8; // managed iteration offset
    const managedNobjs = Number(fv.getBigUint64(fo, true)); fo += 8;
    fo += 8; // huge space
    fo += 8; // huge nobjs
    fo += 8; // tiny space
    fo += 8; // tiny nobjs

    const tableWidth = fv.getUint16(fo, true); fo += 2;
    const startingBlockSize = Number(fv.getBigUint64(fo, true)); fo += 8;
    fo += 8; // max direct block size
    const maxHeapSize = fv.getUint16(fo, true); fo += 2;
    fo += 2; // starting num rows
    const rootBlockAddr = oSize === 8
      ? Number(fv.getBigUint64(fo, true)) : fv.getUint32(fo, true);
    fo += oSize;
    const curNumRows = fv.getUint16(fo, true);

    const blockOffsetBytes = Math.ceil(maxHeapSize / 8);

    // ── 2. Collect direct block addresses ──
    const directBlocks = []; // {addr, size}

    if (curNumRows === 0) {
      // Root IS a direct block
      directBlocks.push({ addr: rootBlockAddr, size: startingBlockSize });
    } else {
      // Root is an indirect block — parse it to find direct blocks
      const ibHeaderSize = 4 + 1 + oSize + blockOffsetBytes;
      // Row 0 has tableWidth entries of startingBlockSize
      const maxEntries = tableWidth * (curNumRows + 1); // conservative
      const ibBufSize = ibHeaderSize + maxEntries * oSize + 32;
      const ibBuf = await this._fetchBytes(rootBlockAddr, ibBufSize);
      const iv = new DataView(ibBuf);

      const ibSig = String.fromCharCode(iv.getUint8(0), iv.getUint8(1), iv.getUint8(2), iv.getUint8(3));
      if (ibSig !== 'FHIB') throw new Error(`Bad indirect block sig: ${ibSig}`);

      let io = 4 + 1 + oSize + blockOffsetBytes; // skip header
      // Row 0: tableWidth direct blocks of startingBlockSize
      for (let i = 0; i < tableWidth; i++) {
        const addr = oSize === 8
          ? Number(iv.getBigUint64(io, true)) : iv.getUint32(io, true);
        io += oSize;
        if (addr !== 0 && addr !== 0xffffffffffffffff) {
          directBlocks.push({ addr, size: startingBlockSize });
        }
      }
      // Row 1+: larger blocks (2×, 4×, etc.) — only if curNumRows > 1
      let blockSize = startingBlockSize * 2;
      for (let row = 1; row < curNumRows; row++) {
        for (let i = 0; i < tableWidth; i++) {
          if (io + oSize > ibBuf.byteLength) break;
          const addr = oSize === 8
            ? Number(iv.getBigUint64(io, true)) : iv.getUint32(io, true);
          io += oSize;
          if (addr !== 0 && addr !== 0xffffffffffffffff) {
            directBlocks.push({ addr, size: blockSize });
          }
        }
        blockSize *= 2;
      }
    }

    // ── 3. Parse link messages from each direct block ──
    const results = [];
    const dbHeaderSize = 4 + 1 + oSize + blockOffsetBytes; // FHDB sig+ver+heapAddr+blockOffset

    for (const db of directBlocks) {
      const dbBuf = await this._fetchBytes(db.addr, db.size);
      const dbSig = String.fromCharCode(
        new Uint8Array(dbBuf)[0], new Uint8Array(dbBuf)[1],
        new Uint8Array(dbBuf)[2], new Uint8Array(dbBuf)[3]
      );
      if (dbSig !== 'FHDB') continue;

      const data = new Uint8Array(dbBuf);
      // Link messages start after the header + 4 bytes (observed padding)
      let off = dbHeaderSize + 4;

      while (off < data.length - 12 && results.length < managedNobjs) {
        // Parse HDF5 Link message (same format as MSG_LINK = 0x06)
        const ver = data[off]; off += 1;
        if (ver !== 1) break;
        const flags = data[off]; off += 1;

        if (flags & 0x08) off += 1; // link type (skip, assume hard=0)
        if (flags & 0x04) off += 8; // creation order
        if (flags & 0x10) off += 1; // charset

        const nameLenSize = 1 << (flags & 0x03);
        let nameLen;
        if (nameLenSize === 1) {
          nameLen = data[off]; off += 1;
        } else if (nameLenSize === 2) {
          nameLen = data[off] | (data[off+1] << 8); off += 2;
        } else if (nameLenSize === 4) {
          nameLen = data[off] | (data[off+1] << 8) | (data[off+2] << 16) | (data[off+3] << 24);
          off += 4;
        } else {
          break; // 8-byte name length — unlikely for group members
        }

        if (nameLen <= 0 || nameLen > 1024 || off + nameLen + oSize > data.length) break;

        let name = '';
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(data[off + i]);
        off += nameLen;

        // Hard link: object header address
        let address;
        if (oSize === 8) {
          const dv = new DataView(data.buffer, data.byteOffset + off, 8);
          address = Number(dv.getBigUint64(0, true));
        } else {
          const dv = new DataView(data.buffer, data.byteOffset + off, 4);
          address = dv.getUint32(0, true);
        }
        off += oSize;

        if (name && address > 0) {
          results.push({ name, address });
        }
      }
    }

    return results;
  }

  /**
   * Enumerate children of a remote group whose B-tree and local heap are
   * beyond the metadata buffer. Fetches just the needed bytes.
   *
   *
   * @param {number} btreeAddr — Group B-tree v1 address
   * @param {number} heapAddr — Local heap address
   * @returns {Promise<Array<{name, objAddr, cacheType, btreeAddr, heapAddr}>>}
   */
  async _enumerateRemoteGroup(btreeAddr, heapAddr) {
    const oSize = this.superblock.offsetSize;
    const lSize = this.superblock.lengthSize;

    // ── 1. Parse the local heap to get the name data segment ──
    const heapHeaderSize = 4 + 1 + 3 + lSize + lSize + oSize; // sig+ver+res+dataSize+freeOfs+dataAddr
    const heapHeader = await this._fetchBytes(heapAddr, heapHeaderSize + 16); // +16 padding
    const hv = new DataView(heapHeader);
    const heapSig = String.fromCharCode(hv.getUint8(0), hv.getUint8(1), hv.getUint8(2), hv.getUint8(3));
    if (heapSig !== 'HEAP') throw new Error(`Bad heap signature: ${heapSig}`);
    // version at offset 4, skip reserved (3 bytes)
    let ho = 8; // past sig + version + reserved
    const dataSize = lSize === 8 ? Number(hv.getBigUint64(ho, true)) : hv.getUint32(ho, true);
    ho += lSize;
    ho += lSize; // skip free list offset
    const dataAddr = oSize === 8 ? Number(hv.getBigUint64(ho, true)) : hv.getUint32(ho, true);

    // Fetch the heap data segment (contains names)
    const heapData = new Uint8Array(await this._fetchBytes(dataAddr, dataSize));

    // Helper: read null-terminated string from heap
    const readName = (offset) => {
      if (offset >= heapData.length) return '';
      let end = offset;
      while (end < heapData.length && heapData[end] !== 0) end++;
      return String.fromCharCode(...heapData.slice(offset, end));
    };

    // ── 2. Walk the B-tree to find SNOD addresses ──
    const snodAddrs = [];

    const walkTree = async (addr) => {
      const headerSize = 4 + 1 + 1 + 2 + oSize + oSize; // sig+type+level+entries+left+right
      const hdrBuf = await this._fetchBytes(addr, headerSize);
      const tv = new DataView(hdrBuf);
      const sig = String.fromCharCode(tv.getUint8(0), tv.getUint8(1), tv.getUint8(2), tv.getUint8(3));
      if (sig !== 'TREE') return;

      const nodeType = tv.getUint8(4);
      if (nodeType !== 0) return; // group B-tree only
      const nodeLevel = tv.getUint8(5);
      const entriesUsed = tv.getUint16(6, true);

      // Entries start after header. Each entry: key (oSize) + childAddr (oSize).
      // Plus one final key at the end.
      const entrySize = oSize * 2;
      const entriesBuf = await this._fetchBytes(
        addr + headerSize,
        (entriesUsed + 1) * entrySize
      );
      const ev = new DataView(entriesBuf);

      for (let i = 0; i < entriesUsed; i++) {
        const childAddr = oSize === 8
          ? Number(ev.getBigUint64(i * entrySize + oSize, true))
          : ev.getUint32(i * entrySize + oSize, true);

        if (nodeLevel === 0) {
          snodAddrs.push(childAddr);
        } else {
          await walkTree(childAddr);
        }
      }
    };

    await walkTree(btreeAddr);

    // ── 3. Parse each SNOD to get children ──
    const results = [];
    const snodEntrySize = oSize + oSize + 4 + 4 + 16; // nameOfs+objAddr+cacheType+reserved+scratch

    for (const snodAddr of snodAddrs) {
      const snodHeader = await this._fetchBytes(snodAddr, 8); // sig+ver+reserved+numSymbols
      const sv = new DataView(snodHeader);
      const sig = String.fromCharCode(sv.getUint8(0), sv.getUint8(1), sv.getUint8(2), sv.getUint8(3));
      if (sig !== 'SNOD') continue;

      const numSymbols = sv.getUint16(6, true);
      const entriesBuf = await this._fetchBytes(snodAddr + 8, numSymbols * snodEntrySize);
      const nv = new DataView(entriesBuf);

      for (let i = 0; i < numSymbols; i++) {
        let eo = i * snodEntrySize;
        const nameOffset = oSize === 8 ? Number(nv.getBigUint64(eo, true)) : nv.getUint32(eo, true);
        eo += oSize;
        const objAddr = oSize === 8 ? Number(nv.getBigUint64(eo, true)) : nv.getUint32(eo, true);
        eo += oSize;
        const cacheType = nv.getUint32(eo, true);
        eo += 4 + 4; // cacheType + reserved
        const scratch = new Uint8Array(entriesBuf, eo, 16);

        const name = readName(nameOffset);
        let childBtree = null, childHeap = null;
        if (cacheType === 1) {
          const scv = new DataView(scratch.buffer, scratch.byteOffset, 16);
          childBtree = Number(scv.getBigUint64(0, true));
          childHeap = Number(scv.getBigUint64(8, true));
        }

        if (name) {
          results.push({ name, objAddr, cacheType, btreeAddr: childBtree, heapAddr: childHeap });
        }
      }
    }

    return results;
  }

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
          if (dataspace && datatype && dataspace.rank >= 0) {
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

              // Try to parse B-tree if within metadata (skip in lazy mode)
              if (layout.btreeAddress && layout.btreeAddress < this.metadataBuffer.byteLength && !this.lazyTreeWalking) {
                try {
                  datasetInfo.chunks = parseBTreeV1(
                    reader,
                    layout.btreeAddress,
                    this.superblock,
                    dataspace.rank + 1,
                    layout.chunkDims
                  );
                } catch (e) {
                  console.warn(`[h5chunk] B-tree parse failed:`, e.message);
                }
              }

              this.datasets.set(datasetId, datasetInfo);

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
    if (dataspace && datatype && dataspace.rank >= 0) {
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

        // Try to parse B-tree (skip in lazy mode)
        if (layout && layout.type === 'chunked' && layout.btreeAddress && !this.lazyTreeWalking) {
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
    // Partial path match: require that all path segments of the target
    // appear in the candidate in the correct order.  This avoids the
    // ambiguity of a pure tail match (e.g. frequencyA/HHHH vs
    // frequencyB/HHHH) while still handling incomplete path resolution.
    const targetParts = targetPath.split('/').filter(Boolean);
    for (const [id, info] of this.datasets.entries()) {
      if (info.path) {
        const candParts = info.path.split('/').filter(Boolean);
        let ti = 0;
        for (let ci = 0; ci < candParts.length && ti < targetParts.length; ci++) {
          if (candParts[ci] === targetParts[ti]) ti++;
        }
        if (ti === targetParts.length) return id; // all target segments matched
      }
    }
    return null;
  }

  /**
   * Get HDF5 attributes for an object (dataset or group) by path.
   *
   * Attributes are parsed from MSG_ATTRIBUTE messages in object headers
   * during file opening. Returns an object { attrName: value } or null.
   *
   * @param {string} path — HDF5 path (e.g. '/science/LSAR/GCOV/grids/frequencyA/projection')
   * @returns {Object|null}
   */
  getAttributes(path) {
    // Direct path match
    if (this.objectAttributes.has(path)) {
      return this.objectAttributes.get(path);
    }
    // Try matching via dataset info
    for (const [, info] of this.datasets.entries()) {
      if (info.path === path && info.attributes) {
        return info.attributes;
      }
    }
    return null;
  }

  /**
   * Get HDF5 attributes for a dataset by its ID.
   * @param {string} datasetId — dataset identifier
   * @returns {Object|null}
   */
  getDatasetAttributes(datasetId) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return null;
    // Try dataset-stored attributes first
    if (dataset.attributes) return dataset.attributes;
    // Try path-based lookup
    if (dataset.path) return this.getAttributes(dataset.path);
    return null;
  }

  /**
   * Read the first and last element of a 1D contiguous dataset.
   *
   * Useful for large coordinate arrays where we only need the endpoints
   * to compute bounds. Reads just 2 elements instead of the entire array.
   *
   * @param {string} datasetId — dataset identifier
   * @returns {{first: number, last: number, length: number}|null}
   */
  async readDatasetEndpoints(datasetId) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return null;

    const { layout, dtype, shape, bytesPerElement } = dataset;
    if (!layout || !shape || shape.length !== 1) return null;

    const length = shape[0];
    if (length < 1) return null;

    // For contiguous datasets, we know exact byte positions
    if (layout.type === 'contiguous' && layout.address != null) {
      const firstOffset = layout.address;
      const lastOffset = layout.address + (length - 1) * bytesPerElement;

      let firstBuf, lastBuf;

      // Try metadata buffer first
      if (firstOffset + bytesPerElement <= this.metadataBuffer.byteLength) {
        firstBuf = this.metadataBuffer.slice(firstOffset, firstOffset + bytesPerElement);
      } else {
        firstBuf = await this._fetchBytes(firstOffset, bytesPerElement);
      }

      if (length === 1) {
        const firstVal = this._decodeSingleValue(firstBuf, dtype);
        return { first: firstVal, last: firstVal, length };
      }

      if (lastOffset + bytesPerElement <= this.metadataBuffer.byteLength) {
        lastBuf = this.metadataBuffer.slice(lastOffset, lastOffset + bytesPerElement);
      } else {
        lastBuf = await this._fetchBytes(lastOffset, bytesPerElement);
      }

      if (!firstBuf || !lastBuf) return null;

      const firstVal = this._decodeSingleValue(firstBuf, dtype);
      const lastVal = this._decodeSingleValue(lastBuf, dtype);

      if (firstVal == null || lastVal == null) return null;
      return { first: firstVal, last: lastVal, length };
    }

    // For chunked 1D datasets, try reading the first and last chunks
    if (layout.type === 'chunked' && dataset.chunks) {
      const data = await this.readSmallDataset(datasetId);
      if (data?.data?.length > 0) {
        return { first: data.data[0], last: data.data[data.data.length - 1], length };
      }
    }

    return null;
  }

  /**
   * Decode a single numeric value from a buffer.
   * @private
   */
  _decodeSingleValue(buffer, dtype) {
    if (!buffer || buffer.byteLength === 0) return null;
    const view = new DataView(buffer);
    switch (dtype) {
      case 'float64': return view.getFloat64(0, true);
      case 'float32': return view.getFloat32(0, true);
      case 'uint32': return view.getUint32(0, true);
      case 'int32': return view.getInt32(0, true);
      case 'uint16': return view.getUint16(0, true);
      case 'int16': return view.getInt16(0, true);
      default: return null;
    }
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

    // Compact datasets — data is inline in the object header
    if (layout.type === 'compact') {
      const totalElements = shape.reduce((a, b) => a * b, 1);
      const totalBytes = layout.size || totalElements * bytesPerElement;

      // Try reading from metadata buffer first (fast path)
      if (layout.address + totalBytes <= this.metadataBuffer.byteLength) {
        if (dtype === 'string') {
          return this._readStringDatasetFromBuffer(this.metadataBuffer, layout.address, totalElements, bytesPerElement, shape);
        }
        const slice = this.metadataBuffer.slice(layout.address, layout.address + totalBytes);
        const data = this._decodeData(slice, dtype);
        return { data, shape, dtype };
      }

      // Compact data beyond metadata buffer — fetch it
      try {
        const remoteBuffer = await this._fetchBytes(layout.address, totalBytes);
        if (!remoteBuffer) return null;
        if (dtype === 'string') {
          return this._readStringDatasetFromBuffer(remoteBuffer, 0, totalElements, bytesPerElement, shape);
        }
        const data = this._decodeData(remoteBuffer, dtype);
        return { data, shape, dtype };
      } catch (e) {
        console.warn(`[h5chunk] Failed to fetch compact dataset ${datasetId}:`, e.message);
        return null;
      }
    }

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
   * Ensure chunk index is loaded for a dataset (lazy B-tree fetching)
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<void>}
   */
  async _ensureChunkIndex(datasetId) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    // Already loaded or not chunked
    if (dataset.chunks || !dataset.layout || dataset.layout.type !== 'chunked') {
      return;
    }

    const layout = dataset.layout;
    if (!layout.btreeAddress) {
      console.warn(`[h5chunk] No B-tree address for dataset ${datasetId}`);
      return;
    }

    console.log(`[h5chunk] Lazy-loading B-tree for ${dataset.path || datasetId} at 0x${layout.btreeAddress.toString(16)}`);

    // Use the metadata buffer if the B-tree falls within it — avoids a redundant
    // fetch AND gives the parser access to child nodes that may be scattered
    // across the metadata region (NISAR B-trees for 35K×35K images can span
    // hundreds of KB; child nodes at absolute addresses need the full buffer).
    let btreeReader;
    if (layout.btreeAddress < this.metadataBuffer.byteLength) {
      btreeReader = new BufferReader(this.metadataBuffer, true, 0);
    } else {
      // B-tree beyond metadata buffer — fetch a region sized to the expected
      // number of chunks. Each B-tree leaf entry ≈ 50 bytes.
      const shape = dataset.shape || [1, 1];
      const chunkDims = layout.chunkDims || [512, 512];
      const numChunks = shape.reduce((n, dim, i) =>
        n * Math.ceil(dim / (chunkDims[i] || 1)), 1);
      const btreeSize = Math.max(256 * 1024, numChunks * 64);
      const btreeBuffer = await this._fetchBytes(layout.btreeAddress, btreeSize);
      btreeReader = new BufferReader(btreeBuffer, true, layout.btreeAddress);
    }

    // Parse B-tree to build chunk index
    try {
      if (layout.version < 4) {
        const rank = dataset.shape?.length || 2;
        dataset.chunks = parseBTreeV1(
          btreeReader,
          layout.btreeAddress,
          this.superblock,
          rank + 1,
          layout.chunkDims
        );
        console.log(`[h5chunk] Loaded ${dataset.chunks.size} chunks for ${dataset.path || datasetId}`);
      } else {
        console.warn(`[h5chunk] B-tree v2 (version 4) not yet supported for lazy loading`);
      }
    } catch (e) {
      console.warn(`[h5chunk] Failed to parse B-tree for ${datasetId}:`, e.message);
      throw e;
    }
  }

  /**
   * Read a chunk of data
   * @param {string} datasetId - Dataset identifier
   * @param {number} row - Chunk row index
   * @param {number} col - Chunk column index
   * @param {AbortSignal} [signal] - Optional abort signal to cancel the fetch
   * @returns {Promise<Float32Array>}
   */
  async readChunk(datasetId, row, col, signal) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    // Lazy-load chunk index if not yet loaded
    if (this.lazyTreeWalking && !dataset.chunks) {
      await this._ensureChunkIndex(datasetId);
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
    } else if (this.url || this._shardUrls) {
      buffer = await this._gatedFetch(
        this._nextUrl(),
        chunkInfo.offset,
        chunkInfo.offset + chunkInfo.size - 1,
        signal
      );
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
   * Batch-read multiple chunks with coalesced HTTP Range requests.
   * Instead of N individual fetch() calls, this:
   *   1. Resolves all chunk (offset, size) from the B-tree index
   *   2. Sorts by file offset
   *   3. Merges adjacent/nearby ranges (gap < MERGE_GAP) into larger reads
   *   4. Fetches merged ranges (far fewer HTTP round-trips)
   *   5. Splits and decompresses individual chunks from the merged buffers
   *
   * @param {string} datasetId - Dataset identifier
   * @param {Array<[number, number]>} coords - Array of [row, col] chunk indices
   * @param {AbortSignal} [signal] - Optional abort signal to cancel fetches
   * @returns {Promise<Map<string, Float32Array|null>>} Map of "row,col" → decoded chunk data
   */
  async readChunksBatch(datasetId, coords, signal) {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);

    if (this.lazyTreeWalking && !dataset.chunks) {
      await this._ensureChunkIndex(datasetId);
    }
    if (!dataset.chunks) throw new Error('Dataset is not chunked or chunk index not available');

    const chunkDims = dataset.layout?.chunkDims || [];
    const results = new Map();

    // Phase 1: Resolve all chunk coordinates to file offsets
    const chunkEntries = []; // { key, row, col, offset, size, filterMask }
    for (const [row, col] of coords) {
      const key = `${row},${col}`;
      const rowOffset = chunkDims.length >= 1 ? row * chunkDims[0] : row;
      const colOffset = chunkDims.length >= 2 ? col * chunkDims[1] : col;
      const btreeKey = `${rowOffset},${colOffset}`;
      const info = dataset.chunks.get(btreeKey);
      if (!info) {
        results.set(key, null); // sparse chunk
      } else {
        chunkEntries.push({
          key, row, col,
          offset: info.offset, size: info.size,
          filterMask: info.filterMask,
        });
      }
    }

    if (chunkEntries.length === 0) return results;

    // For local files, just read each chunk directly (File.slice is fast)
    if (this.file) {
      const promises = chunkEntries.map(async (entry) => {
        const slice = this.file.slice(entry.offset, entry.offset + entry.size);
        const buffer = await slice.arrayBuffer();
        const decoded = await this._decompressAndDecode(buffer, dataset, entry.filterMask);
        results.set(entry.key, decoded);
      });
      await Promise.all(promises);
      return results;
    }

    // Phase 2: Sort by file offset and merge nearby ranges.
    // 1 MB merge gap: allows merging adjacent chunks into larger requests (4-8 MB),
    // which amortizes S3 first-byte latency (~100ms). Shard throughput testing showed
    // 8 MB requests achieve 40 MB/s vs 10 MB/s at 1 MB.
    chunkEntries.sort((a, b) => a.offset - b.offset);

    const MERGE_GAP = 1024 * 1024; // 1 MB — merge chunks within this gap
    const MAX_RANGE_BYTES = 8 * 1024 * 1024; // 8 MB — cap merged range size
    const mergedRanges = []; // { start, end, chunks: [{entry, localOffset}] }
    let current = null;

    for (const entry of chunkEntries) {
      const entryEnd = entry.offset + entry.size;
      if (current && entry.offset <= current.end + MERGE_GAP
          && (entryEnd - current.start) <= MAX_RANGE_BYTES) {
        // Extend current range
        current.chunks.push({ entry, localOffset: entry.offset - current.start });
        current.end = Math.max(current.end, entryEnd);
      } else {
        // Start new range
        if (current) mergedRanges.push(current);
        current = {
          start: entry.offset,
          end: entryEnd,
          chunks: [{ entry, localOffset: 0 }],
        };
      }
    }
    if (current) mergedRanges.push(current);

    // Phase 3: Fetch + decode pipelined with shard URL rotation.
    // Each merged range uses _nextUrl() for round-robin across shard hostnames,
    // forcing separate TCP connections for ~2x throughput.
    // _gatedFetch limits total in-flight requests globally (across all tiles)
    // to prevent tile starvation. Decode starts as each fetch completes.
    await Promise.all(mergedRanges.map(async (range) => {
      const url = this._nextUrl();
      const mergedBuffer = await this._gatedFetch(url, range.start, range.end - 1, signal);
      if (!mergedBuffer) return;

      // Decode immediately while other fetches are still in flight
      await Promise.all(range.chunks.map(async ({ entry, localOffset }) => {
        const chunkBuffer = mergedBuffer.slice(localOffset, localOffset + entry.size);
        const decoded = await this._decompressAndDecode(chunkBuffer, dataset, entry.filterMask);
        results.set(entry.key, decoded);
      }));
    }));

    return results;
  }

  /**
   * Decompress and decode a single chunk buffer.
   * Shared logic between readChunk and readChunksBatch.
   */
  async _decompressAndDecode(buffer, dataset, filterMask) {
    let data = buffer;
    const chunkDimsProduct = (dataset.layout?.chunkDims || [])
      .slice(0, -1)
      .reduce((a, b) => a * b, 1);
    const expectedBytes = chunkDimsProduct * dataset.bytesPerElement;

    if (dataset.filters && filterMask === 0) {
      data = await this._decompressChunk(buffer, dataset.filters);
    } else if (!dataset.filters && buffer.byteLength < expectedBytes) {
      try {
        data = await this._decompressChunk(buffer, [{ id: FILTER_DEFLATE }]);
      } catch (e) {
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
    const isComplex = dataset.dtype === 'cfloat32' || dataset.dtype === 'cfloat64';
    const valuesPerPixel = isComplex ? 2 : 1; // complex = interleaved [real, imag]

    // Determine which chunks we need
    const startChunkRow = Math.floor(startRow / chunkRows);
    const endChunkRow = Math.floor((startRow + numRows - 1) / chunkRows);
    const startChunkCol = Math.floor(startCol / chunkCols);
    const endChunkCol = Math.floor((startCol + numCols - 1) / chunkCols);

    const result = new Float32Array(numRows * numCols * valuesPerPixel);

    // Read all chunks in parallel (critical for remote URLs — avoids sequential round-trips)
    const chunkPromises = [];
    for (let cr = startChunkRow; cr <= endChunkRow; cr++) {
      for (let cc = startChunkCol; cc <= endChunkCol; cc++) {
        chunkPromises.push(
          this.readChunk(datasetId, cr, cc)
            .then(data => ({ cr, cc, data }))
            .catch(e => {
              console.warn(`[h5chunk] Failed to read chunk (${cr}, ${cc}):`, e.message);
              return { cr, cc, data: null };
            })
        );
      }
    }
    const chunks = await Promise.all(chunkPromises);

    // Copy each chunk's relevant portion to result
    for (const { cr, cc, data: chunkData } of chunks) {
      if (!chunkData) continue;

      const chunkStartRow = cr * chunkRows;
      const chunkStartCol = cc * chunkCols;

      for (let r = 0; r < chunkRows; r++) {
        const srcRow = chunkStartRow + r;
        if (srcRow < startRow || srcRow >= startRow + numRows) continue;

        for (let c = 0; c < chunkCols; c++) {
          const srcCol = chunkStartCol + c;
          if (srcCol < startCol || srcCol >= startCol + numCols) continue;

          const srcIdx = (r * chunkCols + c) * valuesPerPixel;
          const dstIdx = ((srcRow - startRow) * numCols + (srcCol - startCol)) * valuesPerPixel;

          if (srcIdx < chunkData.length) {
            result[dstIdx] = chunkData[srcIdx];
            if (isComplex) result[dstIdx + 1] = chunkData[srcIdx + 1];
          }
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
      case 'uint8':
        return new Float32Array(new Uint8Array(buffer));
      case 'int8':
        return new Float32Array(new Int8Array(buffer));
      case 'cfloat32':
        // Interleaved [real, imag, real, imag, ...] — 2 float32 per pixel
        return new Float32Array(buffer);
      case 'cfloat64':
        // Interleaved complex float64 → convert to float32
        return new Float32Array(new Float64Array(buffer));
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
 * @param {number} metadataSize - Optional metadata size (defaults to auto-sized for lazy/bulk mode)
 * @returns {Promise<H5Chunk>}
 */
export async function openH5ChunkFile(file, metadataSize = null) {
  const reader = new H5Chunk();
  await reader.openFile(file, metadataSize);
  return reader;
}

/**
 * Create an H5Chunk reader for a URL
 * @param {string} url
 * @param {number} metadataSize - Optional metadata size (defaults to auto-sized for lazy/bulk mode)
 * @returns {Promise<H5Chunk>}
 */
export async function openH5ChunkUrl(url, metadataSize = null) {
  const reader = new H5Chunk();
  await reader.openUrl(url, metadataSize);
  return reader;
}

export default H5Chunk;
