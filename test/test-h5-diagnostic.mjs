#!/usr/bin/env node
/**
 * HDF5 Diagnostic Test
 *
 * Explores the NISAR HDF5 file to answer:
 * 1. Is the B-tree address beyond the metadata buffer?
 * 2. Does the file use B-tree v2 (BTHD/BTLF)?
 * 3. Is there a B-tree parse failure (and why)?
 *
 * Also reports: superblock version, dataset layout, chunk dimensions,
 * all B-tree signatures found, and attempts to read the first chunk.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'fs';

const FILE_PATH = 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const METADATA_SIZES = [8, 32, 64, 128]; // MB to test

// ─── HDF5 Constants ──────────────────────────────────────────────────

const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

const MSG_DATASPACE = 0x0001;
const MSG_DATATYPE = 0x0003;
const MSG_DATA_LAYOUT = 0x0008;
const MSG_FILTER_PIPELINE = 0x000B;

const LAYOUT_CONTIGUOUS = 1;
const LAYOUT_CHUNKED = 2;

// ─── BufferReader ────────────────────────────────────────────────────

class BufferReader {
  constructor(buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.buf = buffer;
    this.pos = 0;
  }
  seek(pos) { this.pos = pos; }
  skip(n) { this.pos += n; }
  remaining() { return this.buf.byteLength - this.pos; }

  readUint8() {
    const v = this.view.getUint8(this.pos); this.pos += 1; return v;
  }
  readUint16() {
    const v = this.view.getUint16(this.pos, true); this.pos += 2; return v;
  }
  readUint32() {
    const v = this.view.getUint32(this.pos, true); this.pos += 4; return v;
  }
  readUint64() {
    const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return Number(v);
  }
  readBytes(n) {
    const arr = Buffer.from(this.buf.buffer, this.buf.byteOffset + this.pos, n);
    this.pos += n;
    return arr;
  }
  readOffset(size) {
    if (size === 8) return this.readUint64();
    if (size === 4) return this.readUint32();
    if (size === 2) return this.readUint16();
    return this.readUint8();
  }
  readLength(size) { return this.readOffset(size); }
}

// ─── Superblock Parser ───────────────────────────────────────────────

function parseSuperblock(reader) {
  const sig = reader.readBytes(8);
  for (let i = 0; i < 8; i++) {
    if (sig[i] !== HDF5_SIGNATURE[i]) throw new Error('Invalid HDF5 signature');
  }

  const version = reader.readUint8();
  let superblock = { version };

  if (version === 0 || version === 1) {
    superblock.freeSpaceVersion = reader.readUint8();
    superblock.rootGroupVersion = reader.readUint8();
    reader.skip(1);
    superblock.sharedHeaderVersion = reader.readUint8();
    superblock.offsetSize = reader.readUint8();
    superblock.lengthSize = reader.readUint8();
    reader.skip(1);
    superblock.groupLeafNodeK = reader.readUint16();
    superblock.groupInternalNodeK = reader.readUint16();
    reader.skip(4);
    if (version === 1) {
      superblock.indexedStorageK = reader.readUint16();
      reader.skip(2);
    }
    superblock.baseAddress = reader.readOffset(superblock.offsetSize);
    superblock.freeSpaceAddress = reader.readOffset(superblock.offsetSize);
    superblock.endOfFileAddress = reader.readOffset(superblock.offsetSize);
    superblock.driverInfoAddress = reader.readOffset(superblock.offsetSize);
    superblock.rootGroupAddress = reader.readOffset(superblock.offsetSize);
  } else if (version === 2 || version === 3) {
    superblock.offsetSize = reader.readUint8();
    superblock.lengthSize = reader.readUint8();
    superblock.fileConsistencyFlags = reader.readUint8();
    superblock.baseAddress = reader.readOffset(superblock.offsetSize);
    superblock.superblockExtAddress = reader.readOffset(superblock.offsetSize);
    superblock.endOfFileAddress = reader.readOffset(superblock.offsetSize);
    superblock.rootGroupAddress = reader.readOffset(superblock.offsetSize);
    reader.skip(4); // checksum
  }

  return superblock;
}

// ─── Layout Parser ───────────────────────────────────────────────────

function parseDataLayoutMessage(reader, offset, superblock) {
  reader.seek(offset);
  const version = reader.readUint8();

  if (version < 3) {
    const rank = reader.readUint8();
    const layoutClass = reader.readUint8();
    reader.skip(5);
    if (layoutClass === LAYOUT_CHUNKED) {
      const btreeAddress = reader.readOffset(superblock.offsetSize);
      const chunkDims = [];
      for (let i = 0; i < rank; i++) chunkDims.push(reader.readUint32());
      return { type: 'chunked', btreeAddress, chunkDims, version };
    } else if (layoutClass === LAYOUT_CONTIGUOUS) {
      return { type: 'contiguous', version };
    }
  } else if (version === 3) {
    const layoutClass = reader.readUint8();
    if (layoutClass === LAYOUT_CHUNKED) {
      const rank = reader.readUint8();
      const btreeAddress = reader.readOffset(superblock.offsetSize);
      const chunkDims = [];
      for (let i = 0; i < rank; i++) chunkDims.push(reader.readUint32());
      return { type: 'chunked', btreeAddress, chunkDims, version: 3 };
    } else if (layoutClass === LAYOUT_CONTIGUOUS) {
      return { type: 'contiguous', version: 3 };
    }
  } else if (version === 4) {
    const layoutClass = reader.readUint8();
    if (layoutClass === LAYOUT_CHUNKED) {
      const flags = reader.readUint8();
      const rank = reader.readUint8();
      const dimSizeEncoded = reader.readUint8();
      const chunkDims = [];
      for (let i = 0; i < rank; i++) chunkDims.push(reader.readLength(dimSizeEncoded));
      const indexType = reader.readUint8();
      const btreeAddress = reader.readOffset(superblock.offsetSize);
      return { type: 'chunked', btreeAddress, chunkDims, indexType, flags, version: 4 };
    } else if (layoutClass === LAYOUT_CONTIGUOUS) {
      return { type: 'contiguous', version: 4 };
    }
  }
  return { type: 'unknown', version };
}

// ─── Dataspace Parser ────────────────────────────────────────────────

function parseDataspaceMessage(reader, offset) {
  reader.seek(offset);
  const version = reader.readUint8();
  const rank = reader.readUint8();
  const flags = reader.readUint8();

  if (version === 1) reader.skip(5);
  else if (version === 2) reader.readUint8(); // type

  const dims = [];
  for (let i = 0; i < rank; i++) dims.push(reader.readUint64());
  return { rank, dims, version };
}

// ─── Datatype Parser ─────────────────────────────────────────────────

function parseDatatypeMessage(reader, offset) {
  reader.seek(offset);
  const classAndVersion = reader.readUint8();
  const dtClass = classAndVersion & 0x0F;
  const dtVersion = (classAndVersion >> 4) & 0x0F;
  reader.skip(3); // bit fields
  const size = reader.readUint32();

  let dtype = `class${dtClass}`;
  if (dtClass === 0) {
    // Fixed-point
    if (size === 1) dtype = 'int8';
    else if (size === 2) dtype = 'int16';
    else if (size === 4) dtype = 'int32';
    else if (size === 8) dtype = 'int64';
  } else if (dtClass === 1) {
    if (size === 2) dtype = 'float16';
    else if (size === 4) dtype = 'float32';
    else if (size === 8) dtype = 'float64';
  }
  return { dtype, size, dtClass, dtVersion };
}

// ─── B-tree V1 Parser ────────────────────────────────────────────────

function parseBTreeV1(reader, address, superblock, rank, chunkDims, verbose = true) {
  const chunks = new Map();
  let nodesVisited = 0;
  let errors = [];

  function parseNode(nodeAddress, depth = 0) {
    if (nodeAddress >= reader.buf.byteLength) {
      errors.push(`Node at 0x${nodeAddress.toString(16)} is beyond buffer (${reader.buf.byteLength} bytes)`);
      return;
    }

    nodesVisited++;
    reader.seek(nodeAddress);

    const sig = reader.readBytes(4);
    const sigStr = sig.toString('ascii');

    if (sigStr !== 'TREE') {
      errors.push(`Expected TREE at 0x${nodeAddress.toString(16)}, got "${sigStr}" (0x${[...sig].map(b => b.toString(16).padStart(2, '0')).join(' ')})`);
      return;
    }

    const nodeType = reader.readUint8();
    const nodeLevel = reader.readUint8();
    const entriesUsed = reader.readUint16();
    const leftSibling = reader.readOffset(superblock.offsetSize);
    const rightSibling = reader.readOffset(superblock.offsetSize);

    if (verbose && nodesVisited <= 5) {
      console.log(`    B-tree node at 0x${nodeAddress.toString(16)}: type=${nodeType} level=${nodeLevel} entries=${entriesUsed}`);
    }

    // Read all entries first to avoid reader position corruption during recursion
    const entries = [];
    for (let i = 0; i < entriesUsed; i++) {
      const keyChunkSize = reader.readUint32();
      const filterMask = reader.readUint32();
      const chunkOffsets = [];
      for (let d = 0; d < rank; d++) chunkOffsets.push(reader.readUint64());
      const childAddress = reader.readOffset(superblock.offsetSize);
      entries.push({ keyChunkSize, filterMask, chunkOffsets, childAddress });
    }

    // Now process entries (safe to recurse)
    for (const entry of entries) {
      if (nodeLevel === 0) {
        const chunkKey = entry.chunkOffsets.slice(0, -1).join(',');
        chunks.set(chunkKey, {
          offset: entry.childAddress,
          size: entry.keyChunkSize,
          filterMask: entry.filterMask,
          indices: entry.chunkOffsets.slice(0, -1),
        });
      } else {
        parseNode(entry.childAddress, depth + 1);
      }
    }
  }

  try {
    parseNode(address);
  } catch (e) {
    errors.push(`Exception during parse: ${e.message}`);
  }

  return { chunks, nodesVisited, errors };
}

// ─── Signature Scanner ───────────────────────────────────────────────

function scanSignatures(buf) {
  const results = {
    TREE: [], BTHD: [], BTLF: [], BTIN: [],
    OHDR: [], FRHP: [], SNOD: [], GCOL: [],
  };

  const sigs = Object.keys(results).map(s => ({
    name: s,
    bytes: [...s].map(c => c.charCodeAt(0)),
  }));

  for (let i = 0; i < buf.length - 4; i++) {
    for (const sig of sigs) {
      if (buf[i] === sig.bytes[0] && buf[i + 1] === sig.bytes[1] &&
          buf[i + 2] === sig.bytes[2] && buf[i + 3] === sig.bytes[3]) {
        results[sig.name].push(i);
      }
    }
  }
  return results;
}

// ─── Chunked Layout Scanner ─────────────────────────────────────────

function scanChunkedLayouts(buf, superblock) {
  const reader = new BufferReader(buf);
  const candidates = [];

  for (let i = 0; i < buf.length - 20; i++) {
    // Version 3, class 2 (chunked)
    if (buf[i] === 3 && buf[i + 1] === 2) {
      const rank = buf[i + 2];
      if (rank >= 1 && rank <= 10) {
        try {
          const layout = parseDataLayoutMessage(reader, i, superblock);
          if (layout.type === 'chunked') {
            candidates.push({ offset: i, ...layout });
          }
        } catch (e) { /* skip */ }
      }
    }
    // Version 4, class 2 (chunked)
    if (buf[i] === 4 && buf[i + 1] === 2) {
      const flags = buf[i + 2];
      const rank = buf[i + 3];
      if (rank >= 1 && rank <= 10 && flags <= 0x1F) {
        try {
          const layout = parseDataLayoutMessage(reader, i, superblock);
          if (layout.type === 'chunked') {
            candidates.push({ offset: i, ...layout });
          }
        } catch (e) { /* skip */ }
      }
    }
  }
  return candidates;
}

// ─── Find Nearby Dataspace/Datatype ──────────────────────────────────

function findNearbyDataspace(reader, buf, layoutOffset, expectedRank) {
  const searchStart = Math.max(0, layoutOffset - 500);
  const searchEnd = Math.min(buf.length, layoutOffset + 100);

  for (let j = searchStart; j < searchEnd - 10; j++) {
    if ((buf[j] === 1 || buf[j] === 2) && buf[j + 1] >= 1 && buf[j + 1] <= 10) {
      const dsRank = buf[j + 1];
      if (dsRank === expectedRank || dsRank === expectedRank - 1) {
        try {
          const ds = parseDataspaceMessage(reader, j);
          if (ds && ds.dims && ds.dims.length >= 1) {
            // Sanity check: dims should be reasonable
            if (ds.dims.every(d => d > 0 && d < 1e8)) {
              return { ...ds, foundAt: j };
            }
          }
        } catch (e) { /* skip */ }
      }
    }
  }
  return null;
}

function findNearbyDatatype(reader, buf, layoutOffset) {
  const searchStart = Math.max(0, layoutOffset - 500);
  const searchEnd = Math.min(buf.length, layoutOffset + 100);

  for (let j = searchStart; j < searchEnd - 10; j++) {
    const classAndVersion = buf[j];
    const dtClass = classAndVersion & 0x0F;
    const dtVersion = (classAndVersion >> 4) & 0x0F;
    if ((dtClass === 0 || dtClass === 1) && dtVersion >= 0 && dtVersion <= 4) {
      const size = buf[j + 4] | (buf[j + 5] << 8) | (buf[j + 6] << 16) | (buf[j + 7] << 24);
      if (size === 2 || size === 4 || size === 8) {
        try {
          const dt = parseDatatypeMessage(reader, j);
          if (dt && dt.dtype && !dt.dtype.startsWith('class')) {
            return { ...dt, foundAt: j };
          }
        } catch (e) { /* skip */ }
      }
    }
  }
  return null;
}

// ─── Object Header Parser ────────────────────────────────────────────

function parseObjectHeaderMessages(reader, superblock, address) {
  if (address >= reader.buf.byteLength - 10) return [];

  reader.seek(address);
  const sig = reader.readBytes(4);
  const sigStr = sig.toString('ascii');
  const messages = [];

  if (sigStr === 'OHDR') {
    const version = reader.readUint8();
    const flags = reader.readUint8();
    if (flags & 0x10) reader.skip(16);
    if (flags & 0x04) reader.skip(4);
    let sizeFieldSize = 1;
    if ((flags & 0x03) === 1) sizeFieldSize = 2;
    else if ((flags & 0x03) === 2) sizeFieldSize = 4;
    else if ((flags & 0x03) === 3) sizeFieldSize = 8;
    const chunk0Size = reader.readLength(sizeFieldSize);
    const messagesStart = reader.pos;
    const messagesEnd = messagesStart + chunk0Size - 4;

    while (reader.pos < messagesEnd && reader.pos < reader.buf.byteLength - 4) {
      const msgType = reader.readUint8();
      const msgSize = reader.readUint16();
      const msgFlags = reader.readUint8();
      if (msgType === 0) { reader.skip(msgSize); continue; }
      if (msgFlags & 0x04) reader.skip(2);
      messages.push({ type: msgType, size: msgSize, offset: reader.pos });
      reader.seek(reader.pos + msgSize);
    }
  }
  return messages;
}

// ═════════════════════════════════════════════════════════════════════
// MAIN DIAGNOSTIC
// ═════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════');
console.log('  HDF5 Diagnostic for h5chunk Streaming Reader');
console.log('═══════════════════════════════════════════════════════════\n');

// 1. File info
const stat = statSync(FILE_PATH);
console.log(`File: ${FILE_PATH}`);
console.log(`Size: ${(stat.size / 1e6).toFixed(1)} MB (${stat.size} bytes)\n`);

// 2. Read full metadata buffer (up to 128MB for diagnostics)
const diagSize = Math.min(128 * 1024 * 1024, stat.size);
const fd = openSync(FILE_PATH, 'r');
const fullBuf = Buffer.alloc(diagSize);
readSync(fd, fullBuf, 0, diagSize, 0);
closeSync(fd);

const reader = new BufferReader(fullBuf);

// 3. Parse superblock
console.log('── Superblock ──────────────────────────────────────────');
const superblock = parseSuperblock(reader);
console.log(`  Version:            ${superblock.version}`);
console.log(`  Offset size:        ${superblock.offsetSize} bytes`);
console.log(`  Length size:        ${superblock.lengthSize} bytes`);
console.log(`  Root group addr:    0x${superblock.rootGroupAddress.toString(16)}`);
console.log(`  End of file addr:   0x${superblock.endOfFileAddress?.toString(16) || 'N/A'}`);
if (superblock.version <= 1) {
  console.log(`  Group leaf K:       ${superblock.groupLeafNodeK}`);
  console.log(`  Group internal K:   ${superblock.groupInternalNodeK}`);
  if (superblock.indexedStorageK !== undefined)
    console.log(`  Indexed storage K:  ${superblock.indexedStorageK}`);
}
console.log('');

// 4. Scan for all known HDF5 signatures
console.log('── Signature Scan (full metadata buffer) ───────────────');
const sigs = scanSignatures(fullBuf);
for (const [name, addrs] of Object.entries(sigs)) {
  if (addrs.length > 0) {
    console.log(`  ${name}: ${addrs.length} found`);
    if (addrs.length <= 10) {
      for (const a of addrs) {
        const mbPos = (a / 1e6).toFixed(2);
        const withinDefault = a < 32 * 1024 * 1024 ? 'within 32MB' : 'BEYOND 32MB';
        console.log(`    0x${a.toString(16).padStart(8, '0')} (${mbPos} MB) [${withinDefault}]`);
      }
    } else {
      // Show first 5 and last 5
      const show = [...addrs.slice(0, 5), '...', ...addrs.slice(-5)];
      for (const a of show) {
        if (a === '...') { console.log(`    ...`); continue; }
        const mbPos = (a / 1e6).toFixed(2);
        const withinDefault = a < 32 * 1024 * 1024 ? 'within 32MB' : 'BEYOND 32MB';
        console.log(`    0x${a.toString(16).padStart(8, '0')} (${mbPos} MB) [${withinDefault}]`);
      }
    }
  }
}
console.log('');

// 5. Scan for chunked data layout messages
console.log('── Chunked Layout Messages ─────────────────────────────');
const layouts = scanChunkedLayouts(fullBuf, superblock);
console.log(`  Found ${layouts.length} chunked layout messages\n`);

for (let i = 0; i < layouts.length; i++) {
  const l = layouts[i];
  const rank = l.chunkDims?.length || '?';
  const btreeHex = l.btreeAddress ? `0x${l.btreeAddress.toString(16)}` : 'N/A';
  const btreeMB = l.btreeAddress ? `${(l.btreeAddress / 1e6).toFixed(2)} MB` : '';
  const beyondDefault = l.btreeAddress > 32 * 1024 * 1024;
  const beyondDiag = l.btreeAddress > diagSize;

  console.log(`  Layout #${i} at offset 0x${l.offset.toString(16)}:`);
  console.log(`    Version:      ${l.version}`);
  console.log(`    Chunk dims:   [${l.chunkDims?.join(', ') || '?'}]`);
  if (l.indexType !== undefined) console.log(`    Index type:   ${l.indexType}`);
  console.log(`    B-tree addr:  ${btreeHex} (${btreeMB})`);
  if (beyondDefault) console.log(`    ⚠  B-tree is BEYOND the 32MB metadata buffer!`);
  if (beyondDiag)    console.log(`    ⚠  B-tree is BEYOND our ${diagSize / 1e6}MB diagnostic buffer!`);

  // Check what's at the B-tree address
  if (l.btreeAddress && l.btreeAddress < diagSize - 4) {
    const btSig = fullBuf.subarray(l.btreeAddress, l.btreeAddress + 4).toString('ascii');
    const btSigHex = [...fullBuf.subarray(l.btreeAddress, l.btreeAddress + 8)]
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`    Bytes at B-tree addr: "${btSig}" [${btSigHex}]`);

    if (btSig === 'TREE') {
      console.log(`    ✓ Valid B-tree v1 (TREE) signature`);
    } else if (btSig === 'BTHD') {
      console.log(`    ✗ B-tree v2 (BTHD) - NOT fully supported by h5chunk!`);
    } else {
      console.log(`    ✗ Unknown signature - B-tree address may be wrong`);
    }
  }

  // Find nearby dataspace to understand the dataset
  const ds = findNearbyDataspace(reader, fullBuf, l.offset, rank);
  const dt = findNearbyDatatype(reader, fullBuf, l.offset);
  if (ds) {
    console.log(`    Nearby dataspace: rank=${ds.rank} dims=[${ds.dims.join(', ')}] (at 0x${ds.foundAt.toString(16)})`);
  }
  if (dt) {
    console.log(`    Nearby datatype:  ${dt.dtype} (${dt.size} bytes) (at 0x${dt.foundAt.toString(16)})`);
  }

  // Try to parse B-tree if accessible
  if (l.btreeAddress && l.btreeAddress < diagSize - 100 && ds) {
    console.log(`\n    Attempting B-tree parse (rank=${ds.rank + 1})...`);
    const btResult = parseBTreeV1(reader, l.btreeAddress, superblock, ds.rank + 1, l.chunkDims, true);
    console.log(`      Nodes visited: ${btResult.nodesVisited}`);
    console.log(`      Chunks found:  ${btResult.chunks.size}`);
    if (btResult.errors.length > 0) {
      console.log(`      Errors:`);
      for (const e of btResult.errors) console.log(`        - ${e}`);
    }
    if (btResult.chunks.size > 0) {
      // Show a few sample chunks
      const entries = [...btResult.chunks.entries()].slice(0, 5);
      console.log(`      Sample chunks:`);
      for (const [key, info] of entries) {
        console.log(`        "${key}" → offset=0x${info.offset.toString(16)} size=${info.size} filterMask=${info.filterMask}`);
      }
    }

    // Also try with version 4 B-tree v2 if no chunks found and BTHD exists
    if (btResult.chunks.size === 0 && l.version === 4) {
      const btSig = fullBuf.subarray(l.btreeAddress, l.btreeAddress + 4).toString('ascii');
      if (btSig === 'BTHD') {
        console.log(`\n    B-tree v2 header detected. Parsing header...`);
        reader.seek(l.btreeAddress + 4); // skip BTHD sig
        const v2version = reader.readUint8();
        const v2type = reader.readUint8();
        const v2nodeSize = reader.readUint32();
        const v2recordSize = reader.readUint16();
        const v2depth = reader.readUint16();
        const v2splitPct = reader.readUint8();
        const v2mergePct = reader.readUint8();
        const v2rootAddr = reader.readOffset(superblock.offsetSize);
        const v2numRec = reader.readUint16();
        const v2totalRec = reader.readLength(superblock.lengthSize);

        console.log(`      v2 version:     ${v2version}`);
        console.log(`      v2 type:        ${v2type} (${v2type === 10 ? 'filtered chunks' : v2type === 11 ? 'non-filtered chunks' : 'other'})`);
        console.log(`      v2 nodeSize:    ${v2nodeSize}`);
        console.log(`      v2 recordSize:  ${v2recordSize}`);
        console.log(`      v2 depth:       ${v2depth}`);
        console.log(`      v2 rootAddr:    0x${v2rootAddr.toString(16)}`);
        console.log(`      v2 numRecords:  ${v2numRec}`);
        console.log(`      v2 totalRecords:${v2totalRec}`);

        // Check root node signature
        if (v2rootAddr < diagSize - 10) {
          const rootSig = fullBuf.subarray(v2rootAddr, v2rootAddr + 4).toString('ascii');
          console.log(`      Root node sig:  "${rootSig}"`);
        }
      }
    }
  }

  console.log('');
}

// 6. Check OHDR-based datasets (what h5chunk strategy 1+2 would find)
console.log('── OHDR-based Dataset Discovery ────────────────────────');
const ohdrAddrs = sigs.OHDR || [];
let datasetsFound = 0;

for (const addr of ohdrAddrs) {
  const messages = parseObjectHeaderMessages(reader, superblock, addr);
  let hasDataspace = false, hasDatatype = false, hasLayout = false;
  let dsInfo = null, dtInfo = null, layoutInfo = null;

  for (const msg of messages) {
    try {
      if (msg.type === MSG_DATASPACE && msg.offset < fullBuf.byteLength) {
        dsInfo = parseDataspaceMessage(reader, msg.offset);
        hasDataspace = true;
      }
      if (msg.type === MSG_DATATYPE && msg.offset < fullBuf.byteLength) {
        dtInfo = parseDatatypeMessage(reader, msg.offset);
        hasDatatype = true;
      }
      if (msg.type === MSG_DATA_LAYOUT && msg.offset < fullBuf.byteLength) {
        layoutInfo = parseDataLayoutMessage(reader, msg.offset, superblock);
        hasLayout = true;
      }
    } catch (e) { /* skip */ }
  }

  if (hasDataspace && hasDatatype && dsInfo?.rank >= 1) {
    datasetsFound++;
    const shape = dsInfo.dims.join(' x ');
    const isChunked = layoutInfo?.type === 'chunked';
    const btreeAddr = layoutInfo?.btreeAddress;
    const btreeOk = btreeAddr && btreeAddr < 32 * 1024 * 1024;

    console.log(`  Dataset at OHDR 0x${addr.toString(16)}:`);
    console.log(`    Shape: [${shape}]  dtype: ${dtInfo.dtype}`);
    console.log(`    Layout: ${layoutInfo?.type || 'none'} v${layoutInfo?.version || '?'}`);
    if (isChunked) {
      console.log(`    Chunk dims: [${layoutInfo.chunkDims?.join(', ')}]`);
      console.log(`    B-tree addr: 0x${btreeAddr?.toString(16)} ${btreeOk ? '✓ within 32MB' : '⚠ BEYOND 32MB'}`);
      if (layoutInfo.indexType !== undefined) {
        console.log(`    Index type: ${layoutInfo.indexType}`);
      }
    }
    console.log('');
  }
}
console.log(`  Total datasets from OHDR scan: ${datasetsFound}\n`);

// 7. Summary / Diagnosis
console.log('═══════════════════════════════════════════════════════════');
console.log('  DIAGNOSIS');
console.log('═══════════════════════════════════════════════════════════\n');

const hasBTreeV1 = (sigs.TREE?.length || 0) > 0;
const hasBTreeV2 = (sigs.BTHD?.length || 0) > 0;
const allBtreeAddrs = layouts.map(l => l.btreeAddress).filter(Boolean);
const btreesBeyond32 = allBtreeAddrs.filter(a => a > 32 * 1024 * 1024);
const btreesBeyond8 = allBtreeAddrs.filter(a => a > 8 * 1024 * 1024);

console.log(`  Q1: Is the B-tree beyond the metadata buffer?`);
if (btreesBeyond32.length > 0) {
  console.log(`  → YES: ${btreesBeyond32.length}/${allBtreeAddrs.length} B-tree addresses are beyond 32MB`);
  for (const a of btreesBeyond32) {
    console.log(`    0x${a.toString(16)} (${(a / 1e6).toFixed(1)} MB)`);
  }
} else if (btreesBeyond8.length > 0) {
  console.log(`  → PARTIAL: B-trees are within 32MB but ${btreesBeyond8.length} are beyond the default 8MB`);
} else if (allBtreeAddrs.length > 0) {
  console.log(`  → NO: All B-tree addresses are within 8MB`);
} else {
  console.log(`  → N/A: No chunked layouts found`);
}
console.log('');

console.log(`  Q2: Does the file use B-tree v2?`);
if (hasBTreeV2) {
  console.log(`  → YES: Found ${sigs.BTHD.length} BTHD (v2 header) signatures`);
  console.log(`    h5chunk's parseBTreeV2() is STUBBED - returns empty Map!`);
} else if (hasBTreeV1) {
  console.log(`  → NO: File uses B-tree v1 (TREE signatures found)`);
} else {
  console.log(`  → UNCLEAR: No B-tree signatures found in metadata buffer`);
}
console.log('');

console.log(`  Q3: Does B-tree parsing fail?`);
let parseWorked = false;
for (const l of layouts) {
  if (l.btreeAddress && l.btreeAddress < diagSize - 100) {
    const ds = findNearbyDataspace(reader, fullBuf, l.offset, l.chunkDims?.length || 2);
    if (ds) {
      const result = parseBTreeV1(reader, l.btreeAddress, superblock, ds.rank + 1, l.chunkDims, false);
      if (result.chunks.size > 0) {
        parseWorked = true;
        console.log(`  → Parse SUCCEEDED for layout at 0x${l.offset.toString(16)}: ${result.chunks.size} chunks`);
      } else if (result.errors.length > 0) {
        console.log(`  → Parse FAILED for layout at 0x${l.offset.toString(16)}:`);
        for (const e of result.errors) console.log(`    ${e}`);
      } else {
        console.log(`  → Parse returned 0 chunks (no errors) for layout at 0x${l.offset.toString(16)}`);
      }
    }
  }
}
if (!parseWorked && layouts.length > 0) {
  console.log(`  → No B-tree could be successfully parsed`);
}
console.log('');

// 8. What metadata size would be needed?
console.log('── Required Metadata Size ──────────────────────────────');
if (allBtreeAddrs.length > 0) {
  // Only consider addresses that are actually within the file
  const validAddrs = allBtreeAddrs.filter(a => a < stat.size);
  if (validAddrs.length > 0) {
    const maxAddr = Math.max(...validAddrs);
    const needed = maxAddr + 1 * 1024 * 1024;
    console.log(`  Largest valid B-tree address: 0x${maxAddr.toString(16)} (${(maxAddr / 1e6).toFixed(1)} MB)`);
    console.log(`  Current h5chunk default: 32 MB`);
    console.log(`  Sufficient? ${maxAddr < 32 * 1024 * 1024 ? 'YES' : 'NO'}`);
  } else {
    console.log(`  No valid B-tree addresses found within file size`);
  }
}
console.log('');

// ═════════════════════════════════════════════════════════════════════
// 9. HEX DUMP OF B-TREE NODES
// ═════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════');
console.log('  B-TREE HEX DUMP & MANUAL PARSE');
console.log('═══════════════════════════════════════════════════════════\n');

function hexDump(buf, offset, length, label) {
  console.log(`  ${label} (0x${offset.toString(16)}, ${length} bytes):`);
  for (let i = 0; i < length; i += 16) {
    const addr = (offset + i).toString(16).padStart(8, '0');
    const bytes = [];
    const ascii = [];
    for (let j = 0; j < 16 && (i + j) < length; j++) {
      const b = buf[offset + i + j];
      bytes.push(b.toString(16).padStart(2, '0'));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
    }
    console.log(`    ${addr}  ${bytes.join(' ').padEnd(48)}  ${ascii.join('')}`);
  }
}

// Find the real chunked B-trees (those with valid TREE signatures)
const realBtrees = layouts.filter(l =>
  l.btreeAddress && l.btreeAddress < diagSize - 100 &&
  fullBuf.subarray(l.btreeAddress, l.btreeAddress + 4).toString('ascii') === 'TREE'
);

console.log(`Found ${realBtrees.length} B-trees with valid TREE signatures\n`);

// For each real B-tree, dump and manually parse
for (const bt of realBtrees.slice(0, 3)) { // First 3 for brevity
  const layoutRank = bt.chunkDims?.length || 0;
  console.log(`── B-tree for layout at 0x${bt.offset.toString(16)} ──────────────────`);
  console.log(`  Layout version: ${bt.version}, chunk dims: [${bt.chunkDims?.join(', ')}]`);
  console.log(`  Layout rank (ndims): ${layoutRank}`);
  console.log(`  B-tree addr: 0x${bt.btreeAddress.toString(16)}\n`);

  // Parse header
  const r = new BufferReader(fullBuf);
  r.seek(bt.btreeAddress);
  const treeSig = r.readBytes(4).toString('ascii');
  const nodeType = r.readUint8();
  const nodeLevel = r.readUint8();
  const entriesUsed = r.readUint16();
  const leftSib = r.readOffset(superblock.offsetSize);
  const rightSib = r.readOffset(superblock.offsetSize);

  console.log(`  Header: sig=${treeSig} type=${nodeType} level=${nodeLevel} entries=${entriesUsed}`);
  console.log(`  Left sibling:  0x${leftSib.toString(16)}`);
  console.log(`  Right sibling: 0x${rightSib.toString(16)}`);

  const headerSize = 4 + 1 + 1 + 2 + superblock.offsetSize * 2;
  const entryStart = bt.btreeAddress + headerSize;

  // Calculate expected key size with different rank assumptions
  console.log(`\n  Key size calculations:`);
  for (let testRank = 1; testRank <= 5; testRank++) {
    const keySize = 4 + 4 + testRank * 8; // chunkSize + filterMask + offsets
    const entrySize = keySize + superblock.offsetSize;
    console.log(`    rank=${testRank}: key=${keySize}B, entry=${entrySize}B, total=${headerSize + entriesUsed * entrySize + keySize}B`);
  }

  // Dump raw bytes for the first few entries
  const dumpLen = Math.min(800, fullBuf.byteLength - entryStart);
  console.log('');
  hexDump(fullBuf, entryStart, dumpLen, `Raw entries starting at 0x${entryStart.toString(16)}`);

  // Now manually parse entries with the expected rank
  console.log(`\n  Manual parse with rank=${layoutRank} (key=${4+4+layoutRank*8}B + child=${superblock.offsetSize}B = ${4+4+layoutRank*8+superblock.offsetSize}B per entry):`);

  r.seek(entryStart);
  const maxEntries = Math.min(entriesUsed, 10); // show first 10

  for (let i = 0; i < maxEntries; i++) {
    const entryOffset = r.pos;
    const keyChunkSize = r.readUint32();
    const filterMask = r.readUint32();
    const offsets = [];
    for (let d = 0; d < layoutRank; d++) {
      offsets.push(r.readUint64());
    }
    const childAddr = r.readOffset(superblock.offsetSize);

    // Check if child looks valid
    let childSig = '';
    let childValid = false;
    if (childAddr > 0 && childAddr < diagSize - 4) {
      childSig = fullBuf.subarray(childAddr, childAddr + 4).toString('ascii');
      childValid = childSig === 'TREE';
    }

    const offsetStr = offsets.map(o => o.toString()).join(', ');
    const validMark = childValid ? '✓' : (childAddr === 0 ? '⊘ NULL' : '✗');

    console.log(`    Entry ${i} @ 0x${entryOffset.toString(16)}:`);
    console.log(`      chunkSize=${keyChunkSize}, filterMask=0x${filterMask.toString(16)}, offsets=[${offsetStr}]`);
    console.log(`      child=0x${childAddr.toString(16)} ${validMark} ${childValid ? '(TREE)' : childSig ? `("${childSig}")` : ''}`);

    // If child size is suspicious, flag it
    if (keyChunkSize > 100 * 1024 * 1024) {
      console.log(`      ⚠ chunkSize ${keyChunkSize} seems too large (>${(keyChunkSize/1e6).toFixed(0)}MB)`);
    }
  }

  // Now try parsing with DIFFERENT ranks to see if alignment improves
  console.log(`\n  Testing alternative rank values:`);
  for (let testRank = layoutRank - 1; testRank <= layoutRank + 2; testRank++) {
    if (testRank < 1) continue;
    r.seek(entryStart);
    let validChildren = 0;
    let totalRead = 0;

    for (let i = 0; i < entriesUsed; i++) {
      r.skip(4 + 4); // chunkSize + filterMask
      for (let d = 0; d < testRank; d++) r.readUint64();
      const childAddr = r.readOffset(superblock.offsetSize);
      totalRead++;

      if (childAddr > 0 && childAddr < diagSize - 4) {
        const sig = fullBuf.subarray(childAddr, childAddr + 4).toString('ascii');
        if (sig === 'TREE') validChildren++;
      }
    }

    const pct = ((validChildren / totalRead) * 100).toFixed(0);
    const marker = validChildren === totalRead ? '✓✓✓' : validChildren > entriesUsed / 2 ? '~' : '✗';
    console.log(`    rank=${testRank}: ${validChildren}/${totalRead} valid children (${pct}%) ${marker}`);
  }

  // Also check: what if the B-tree key uses lengthSize instead of 8 for offsets?
  if (superblock.lengthSize !== 8) {
    console.log(`\n  Note: superblock.lengthSize=${superblock.lengthSize} (differs from 8)`);
    console.log(`  Testing with ${superblock.lengthSize}-byte offsets in key:`);
    r.seek(entryStart);
    let validChildren = 0;
    for (let i = 0; i < entriesUsed; i++) {
      r.skip(4 + 4);
      for (let d = 0; d < layoutRank; d++) r.readOffset(superblock.lengthSize);
      const childAddr = r.readOffset(superblock.offsetSize);
      if (childAddr > 0 && childAddr < diagSize - 4) {
        if (fullBuf.subarray(childAddr, childAddr + 4).toString('ascii') === 'TREE') validChildren++;
      }
    }
    console.log(`    ${validChildren}/${entriesUsed} valid`);
  }

  // Check what happens if there's an extra trailing key (N+1 keys for N entries)
  // The HDF5 spec says B-tree has K[0] A[0] K[1] A[1] ... K[N-1] A[N-1] K[N]
  // Let's verify if the leaf node at the valid child address is correct
  if (nodeLevel > 0) {
    // Find the first valid child and dump its leaf entries
    r.seek(entryStart);
    for (let i = 0; i < entriesUsed; i++) {
      const eOff = r.pos;
      r.skip(4 + 4 + layoutRank * 8);
      const childAddr = r.readOffset(superblock.offsetSize);
      if (childAddr > 0 && childAddr < diagSize - 4) {
        const sig = fullBuf.subarray(childAddr, childAddr + 4).toString('ascii');
        if (sig === 'TREE') {
          console.log(`\n  Leaf node at child[${i}] = 0x${childAddr.toString(16)}:`);
          const leafR = new BufferReader(fullBuf);
          leafR.seek(childAddr);
          const lSig = leafR.readBytes(4).toString('ascii');
          const lType = leafR.readUint8();
          const lLevel = leafR.readUint8();
          const lEntries = leafR.readUint16();
          const lLeft = leafR.readOffset(superblock.offsetSize);
          const lRight = leafR.readOffset(superblock.offsetSize);
          console.log(`    sig=${lSig} type=${lType} level=${lLevel} entries=${lEntries}`);
          console.log(`    left=0x${lLeft.toString(16)} right=0x${lRight.toString(16)}`);

          // Dump first few leaf entries
          const leafEntryStart = leafR.pos;
          hexDump(fullBuf, leafEntryStart, Math.min(400, fullBuf.byteLength - leafEntryStart),
            `Leaf entries at 0x${leafEntryStart.toString(16)}`);

          console.log(`\n    Parsed leaf entries (rank=${layoutRank}):`);
          leafR.seek(leafEntryStart);
          for (let j = 0; j < Math.min(lEntries, 8); j++) {
            const jOff = leafR.pos;
            const cSize = leafR.readUint32();
            const fMask = leafR.readUint32();
            const offs = [];
            for (let d = 0; d < layoutRank; d++) offs.push(leafR.readUint64());
            const dataAddr = leafR.readOffset(superblock.offsetSize);
            console.log(`      [${j}] @ 0x${jOff.toString(16)}: size=${cSize} mask=0x${fMask.toString(16)} offsets=[${offs.join(',')}] data=0x${dataAddr.toString(16)}`);
          }
          break;
        }
      }
    }
  }

  console.log('\n');
}
