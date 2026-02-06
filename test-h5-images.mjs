#!/usr/bin/env node
/**
 * Test h5chunk by reading real data from the NISAR HDF5 file
 * and writing images to disk as PGM (grayscale).
 *
 * Tests the full pipeline: metadata parse → chunk index → chunk read → decode.
 */

import { openSync, readSync, closeSync, statSync, writeFileSync, mkdirSync } from 'fs';

// We can't import h5chunk directly (it uses browser File API),
// so we import the class and shim the File interface for Node.js.

const FILE_PATH = 'test_data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const OUTPUT_DIR = 'test_output';
const METADATA_SIZE = 32 * 1024 * 1024;

// ─── Node.js File Shim ──────────────────────────────────────────────
// Mimics the browser File/Blob API that h5chunk expects.

class NodeFile {
  constructor(filePath) {
    this._path = filePath;
    const stat = statSync(filePath);
    this.size = stat.size;
    this.name = filePath.split('/').pop();
  }

  slice(start, end) {
    const path = this._path;
    const length = end - start;
    return {
      async arrayBuffer() {
        const fd = openSync(path, 'r');
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, start);
        closeSync(fd);
        // Return an ArrayBuffer (h5chunk expects this)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    };
  }
}

// ─── Import h5chunk ─────────────────────────────────────────────────
// Dynamic import since it's ES module
const { H5Chunk } = await import('./src/loaders/h5chunk.js');

// ─── Utilities ──────────────────────────────────────────────────────

function stats(data) {
  let min = Infinity, max = -Infinity, sum = 0, count = 0, nan = 0, zero = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v)) { nan++; continue; }
    if (v === 0) zero++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  return {
    min, max,
    mean: count > 0 ? sum / count : NaN,
    count,
    nan,
    zero,
    total: data.length,
  };
}

function writePGM(path, data, width, height, minVal, maxVal) {
  // PGM P5 (binary grayscale)
  const pixels = Buffer.alloc(width * height);
  const range = maxVal - minVal || 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v) || v === 0) {
      pixels[i] = 0;
    } else {
      pixels[i] = Math.max(0, Math.min(255, Math.round(((v - minVal) / range) * 255)));
    }
  }
  const header = `P5\n${width} ${height}\n255\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  writeFileSync(path, Buffer.concat([headerBuf, pixels]));
}

function toDecibels(data) {
  const result = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v) || v <= 0) {
      result[i] = NaN;
    } else {
      result[i] = 10 * Math.log10(v);
    }
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═════════════════════════════════════════════════════════════════════

try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

console.log('═══════════════════════════════════════════════════════════');
console.log('  h5chunk Image Output Test');
console.log('═══════════════════════════════════════════════════════════\n');

// 1. Open file
console.log(`Opening: ${FILE_PATH}`);
const file = new NodeFile(FILE_PATH);
console.log(`File size: ${(file.size / 1e6).toFixed(1)} MB\n`);

const reader = new H5Chunk();
await reader.openFile(file, METADATA_SIZE);

// 2. List datasets
const datasets = reader.getDatasets();
console.log(`Discovered ${datasets.length} datasets:\n`);

for (const ds of datasets) {
  const shapeStr = ds.shape?.join(' × ') || '?';
  console.log(`  ${ds.id}: [${shapeStr}] ${ds.dtype} chunked=${ds.chunked} chunks=${ds.numChunks}`);
  if (ds.chunkDims) console.log(`    chunk dims: [${ds.chunkDims.join(', ')}]`);
}
console.log('');

// 3. Select the largest 2D dataset
let selected = null;
for (const ds of datasets) {
  if (ds.shape?.length === 2 && ds.shape[0] >= 100 && ds.shape[1] >= 100) {
    if (!selected || (ds.shape[0] * ds.shape[1] > selected.shape[0] * selected.shape[1])) {
      selected = ds;
    }
  }
}

if (!selected) {
  console.log('No suitable 2D dataset found!');
  console.log('Available datasets:');
  for (const ds of datasets) {
    console.log(`  ${ds.id}: shape=[${ds.shape?.join(',')}] chunks=${ds.numChunks}`);
  }
  process.exit(1);
}

console.log(`Selected dataset: ${selected.id}`);
console.log(`  Shape: [${selected.shape.join(', ')}]`);
console.log(`  Dtype: ${selected.dtype}`);
console.log(`  Chunks: ${selected.numChunks}`);
console.log(`  Chunk dims: [${selected.chunkDims?.join(', ')}]\n`);

const [height, width] = selected.shape;

// 4. Test reading a single chunk
console.log('── Test 1: Read Single Chunk ────────────────────────────');
try {
  const chunkData = await reader.readChunk(selected.id, 0, 0);
  if (chunkData) {
    const s = stats(chunkData);
    console.log(`  Chunk (0,0): ${chunkData.length} values`);
    console.log(`  Stats: min=${s.min.toFixed(4)}, max=${s.max.toFixed(4)}, mean=${s.mean.toFixed(4)}`);
    console.log(`  NaN=${s.nan}, zero=${s.zero}, valid=${s.count}`);

    // Write raw chunk as image
    const chunkW = selected.chunkDims?.[1] || 512;
    const chunkH = selected.chunkDims?.[0] || 512;
    const dbData = toDecibels(chunkData);
    const dbStats = stats(dbData);
    console.log(`  dB range: ${dbStats.min.toFixed(1)} to ${dbStats.max.toFixed(1)} dB`);

    writePGM(`${OUTPUT_DIR}/chunk_0_0_raw.pgm`, chunkData, chunkW, chunkH, s.min, s.max);
    writePGM(`${OUTPUT_DIR}/chunk_0_0_dB.pgm`, dbData, chunkW, chunkH, -30, 0);
    console.log(`  Wrote: ${OUTPUT_DIR}/chunk_0_0_raw.pgm`);
    console.log(`  Wrote: ${OUTPUT_DIR}/chunk_0_0_dB.pgm`);
  } else {
    console.log('  Chunk (0,0) returned null (empty/sparse)');
  }
} catch (e) {
  console.error(`  FAILED: ${e.message}`);
}
console.log('');

// 5. Test reading a middle chunk
console.log('── Test 2: Read Middle Chunk ────────────────────────────');
const midChunkRow = Math.floor(height / (selected.chunkDims?.[0] || 512) / 2);
const midChunkCol = Math.floor(width / (selected.chunkDims?.[1] || 512) / 2);
try {
  const chunkData = await reader.readChunk(selected.id, midChunkRow, midChunkCol);
  if (chunkData) {
    const s = stats(chunkData);
    console.log(`  Chunk (${midChunkRow},${midChunkCol}): ${chunkData.length} values`);
    console.log(`  Stats: min=${s.min.toFixed(4)}, max=${s.max.toFixed(4)}, mean=${s.mean.toFixed(4)}`);

    const chunkW = selected.chunkDims?.[1] || 512;
    const chunkH = selected.chunkDims?.[0] || 512;
    const dbData = toDecibels(chunkData);
    writePGM(`${OUTPUT_DIR}/chunk_mid_raw.pgm`, chunkData, chunkW, chunkH, s.min, s.max);
    writePGM(`${OUTPUT_DIR}/chunk_mid_dB.pgm`, dbData, chunkW, chunkH, -30, 0);
    console.log(`  Wrote: ${OUTPUT_DIR}/chunk_mid_raw.pgm`);
    console.log(`  Wrote: ${OUTPUT_DIR}/chunk_mid_dB.pgm`);
  } else {
    console.log(`  Chunk (${midChunkRow},${midChunkCol}) returned null`);
  }
} catch (e) {
  console.error(`  FAILED: ${e.message}`);
}
console.log('');

// 6. Test readRegion (multi-chunk)
console.log('── Test 3: Read 1024×1024 Region ──────────────────────');
try {
  const regionW = 1024, regionH = 1024;
  const startRow = Math.floor(height / 2) - regionH / 2;
  const startCol = Math.floor(width / 2) - regionW / 2;
  console.log(`  Reading region [${startRow}:${startRow + regionH}, ${startCol}:${startCol + regionW}]`);

  const t0 = Date.now();
  const result = await reader.readRegion(selected.id, startRow, startCol, regionH, regionW);
  const elapsed = Date.now() - t0;

  const s = stats(result.data);
  console.log(`  Result: ${result.width}×${result.height}, ${result.data.length} values (${elapsed}ms)`);
  console.log(`  Stats: min=${s.min.toFixed(4)}, max=${s.max.toFixed(4)}, mean=${s.mean.toFixed(4)}`);
  console.log(`  NaN=${s.nan}, zero=${s.zero}, valid=${s.count}`);

  const dbData = toDecibels(result.data);
  writePGM(`${OUTPUT_DIR}/region_center_raw.pgm`, result.data, regionW, regionH, s.min, s.max);
  writePGM(`${OUTPUT_DIR}/region_center_dB.pgm`, dbData, regionW, regionH, -30, 0);
  console.log(`  Wrote: ${OUTPUT_DIR}/region_center_raw.pgm`);
  console.log(`  Wrote: ${OUTPUT_DIR}/region_center_dB.pgm`);
} catch (e) {
  console.error(`  FAILED: ${e.message}`);
  console.error(`  ${e.stack}`);
}
console.log('');

// 7. Test reading a tile (as the SARViewer would)
console.log('── Test 4: Read Full Overview (downsampled) ───────────');
try {
  // Read a ~512×512 overview from the full image by sampling every Nth pixel
  const overviewSize = 512;
  const stepRow = Math.max(1, Math.floor(height / overviewSize));
  const stepCol = Math.max(1, Math.floor(width / overviewSize));
  const actualH = Math.ceil(height / stepRow);
  const actualW = Math.ceil(width / stepCol);

  console.log(`  Sampling every ${stepRow}×${stepCol} pixels → ${actualW}×${actualH} overview`);

  // Read center strip (one row of chunks)
  const chunkH = selected.chunkDims?.[0] || 512;
  const chunkW = selected.chunkDims?.[1] || 512;
  const nChunkCols = Math.ceil(width / chunkW);
  const nChunkRows = Math.ceil(height / chunkH);

  console.log(`  Grid: ${nChunkRows} × ${nChunkCols} chunks`);

  // Read a row of chunks across the middle
  const midRow = Math.floor(nChunkRows / 2);
  const stripData = new Float32Array(chunkH * width);
  let chunksRead = 0;

  const t0 = Date.now();
  for (let cc = 0; cc < nChunkCols; cc++) {
    try {
      const chunk = await reader.readChunk(selected.id, midRow, cc);
      if (chunk) {
        chunksRead++;
        // Copy into strip
        for (let r = 0; r < chunkH; r++) {
          for (let c = 0; c < chunkW && (cc * chunkW + c) < width; c++) {
            stripData[r * width + cc * chunkW + c] = chunk[r * chunkW + c];
          }
        }
      }
    } catch (e) {
      // Skip failed chunks
    }
  }
  const elapsed = Date.now() - t0;

  const s = stats(stripData);
  console.log(`  Read ${chunksRead}/${nChunkCols} chunks in ${elapsed}ms`);
  console.log(`  Stats: min=${s.min.toFixed(4)}, max=${s.max.toFixed(4)}, mean=${s.mean.toFixed(4)}`);
  console.log(`  NaN=${s.nan}, zero=${s.zero}, valid=${s.count}`);

  const dbData = toDecibels(stripData);
  writePGM(`${OUTPUT_DIR}/strip_mid_raw.pgm`, stripData, width, chunkH, s.min, s.max);
  writePGM(`${OUTPUT_DIR}/strip_mid_dB.pgm`, dbData, width, chunkH, -30, 0);
  console.log(`  Wrote: ${OUTPUT_DIR}/strip_mid_raw.pgm (${width}×${chunkH})`);
  console.log(`  Wrote: ${OUTPUT_DIR}/strip_mid_dB.pgm`);
} catch (e) {
  console.error(`  FAILED: ${e.message}`);
  console.error(`  ${e.stack}`);
}
console.log('');

// 8. Scan chunk index integrity
console.log('── Test 5: Chunk Index Integrity ───────────────────────');
{
  const ds = reader.datasets.get(selected.id);
  if (ds?.chunks) {
    const chunkH = ds.layout?.chunkDims?.[0] || 512;
    const chunkW = ds.layout?.chunkDims?.[1] || 512;
    const expectedRows = Math.ceil(height / chunkH);
    const expectedCols = Math.ceil(width / chunkW);
    const expectedTotal = expectedRows * expectedCols;

    console.log(`  Expected: ${expectedRows}×${expectedCols} = ${expectedTotal} chunks`);
    console.log(`  Found:    ${ds.chunks.size} chunks in index`);
    console.log(`  Match:    ${ds.chunks.size === expectedTotal ? 'YES' : 'NO ⚠'}`);

    // Check first/last keys
    const keys = [...ds.chunks.keys()];
    if (keys.length > 0) {
      keys.sort((a, b) => {
        const [ar, ac] = a.split(',').map(Number);
        const [br, bc] = b.split(',').map(Number);
        return ar - br || ac - bc;
      });
      console.log(`  First key: "${keys[0]}"`);
      console.log(`  Last key:  "${keys[keys.length - 1]}"`);

      // Sample some chunk offsets
      const sample = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
      console.log(`  Sample entries:`);
      for (const k of sample) {
        const info = ds.chunks.get(k);
        const inFile = info.offset < file.size;
        console.log(`    "${k}" → offset=0x${info.offset.toString(16)} (${(info.offset/1e6).toFixed(1)}MB) size=${info.size} ${inFile ? '✓' : '⚠ beyond file!'}`);
      }
    }
  } else {
    console.log(`  ⚠ No chunks map found for ${selected.id}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  DONE');
console.log('═══════════════════════════════════════════════════════════');
