#!/usr/bin/env node
/**
 * Test that simulates the exact browser code path for NISAR HDF5 loading.
 * Calls the same functions the browser would call and verifies output.
 */

import { openSync, readSync, closeSync, statSync, writeFileSync, mkdirSync } from 'fs';

const FILE_PATH = 'test_data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const OUTPUT_DIR = 'test_output';

// ─── Node.js File Shim (same as browser File API) ───────────────
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
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    };
  }
}

// ─── Import the same functions the browser uses ─────────────────
const { openH5ChunkFile } = await import('./src/loaders/h5chunk.js');

try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Browser Flow Simulation Test');
console.log('═══════════════════════════════════════════════════════════\n');

// ─── Step 1: Simulate loadNISARGCOVStreaming ────────────────────

console.log('── Step 1: Open file with h5chunk (same as browser) ──');
const file = new NodeFile(FILE_PATH);
console.log(`File: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)\n`);

const streamReader = await openH5ChunkFile(file, 32 * 1024 * 1024);
const h5Datasets = streamReader.getDatasets();

console.log(`\nDiscovered ${h5Datasets.length} datasets:`);
for (const ds of h5Datasets) {
  console.log(`  ${ds.id}: [${ds.shape?.join('x')}] ${ds.dtype} chunks=${ds.numChunks}`);
}

// Select largest 2D dataset (same logic as browser)
let selectedDataset = null;
let selectedDatasetId = null;
for (const ds of h5Datasets) {
  if (ds.shape?.length === 2) {
    const [h, w] = ds.shape;
    if (w >= 1000 && h >= 1000) {
      if (!selectedDataset || (w * h > selectedDataset.shape[0] * selectedDataset.shape[1])) {
        selectedDataset = ds;
        selectedDatasetId = ds.id;
      }
    }
  }
}

if (!selectedDataset) {
  console.error('No suitable dataset found!');
  process.exit(1);
}

const [height, width] = selectedDataset.shape;
const chunkH = selectedDataset.chunkDims?.[0] || 512;
const chunkW = selectedDataset.chunkDims?.[1] || 512;

console.log(`\nSelected: ${selectedDatasetId} (${width}x${height})`);
console.log(`Chunk size: ${chunkW}x${chunkH}`);
console.log(`Chunks: ${selectedDataset.numChunks}\n`);

// ─── Step 2: Compute stats from center chunk (new code) ────────

console.log('── Step 2: Compute stats from center chunk ───────────');
const midRow = Math.floor(height / chunkH / 2);
const midCol = Math.floor(width / chunkW / 2);
console.log(`Reading center chunk (${midRow}, ${midCol})...`);

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
    const mean = sum / count;
    const std = Math.sqrt(sumSq / count - mean * mean);
    const meanDb = 10 * Math.log10(mean);
    const stdDb = Math.abs(10 * Math.log10(std / mean));
    console.log(`  Valid pixels: ${count}/${sampleChunk.length}`);
    console.log(`  Linear: min=${min.toFixed(4)}, max=${max.toFixed(4)}, mean=${mean.toFixed(4)}, std=${std.toFixed(4)}`);
    console.log(`  dB: mean=${meanDb.toFixed(1)} dB`);
    console.log(`  Auto-contrast would be: ${(meanDb - 2*stdDb).toFixed(1)} to ${(meanDb + 2*stdDb).toFixed(1)} dB`);
  }
} else {
  console.log('  Center chunk returned null!');
}
console.log('');

// ─── Step 3: Simulate getTile calls ─────────────────────────────

console.log('── Step 3: Simulate deck.gl getTile calls ────────────');

// Simulate what deck.gl TileLayer would request
// With bounds [0, 0, width, height] and viewport zoom ~-4
// deck.gl will request tiles starting at z=0

function resampleToTileSize(srcData, srcWidth, srcHeight, tileSize, fillValue) {
  const dstData = new Float32Array(tileSize * tileSize);
  const scaleX = srcWidth / tileSize;
  const scaleY = srcHeight / tileSize;
  for (let dstY = 0; dstY < tileSize; dstY++) {
    for (let dstX = 0; dstX < tileSize; dstX++) {
      const srcX = Math.floor(dstX * scaleX);
      const srcY = Math.floor(dstY * scaleY);
      const idx = srcY * srcWidth + srcX;
      if (idx < srcData.length) {
        dstData[dstY * tileSize + dstX] = srcData[idx];
      }
    }
  }
  return dstData;
}

// Chunk cache (same as new code)
const chunkCache = new Map();
async function getCachedChunk(chunkRow, chunkCol) {
  const key = `${chunkRow},${chunkCol}`;
  if (chunkCache.has(key)) return chunkCache.get(key);
  let chunk = null;
  try {
    chunk = await streamReader.readChunk(selectedDatasetId, chunkRow, chunkCol);
  } catch (e) { /* skip */ }
  chunkCache.set(key, chunk);
  return chunk;
}

async function simulateGetTile(x, y, z) {
  const tileSize = 256;
  const scale = Math.pow(2, z);

  const pixelX = x * width / scale;
  const pixelY = y * height / scale;
  const pixelW = width / scale;
  const pixelH = height / scale;

  const left = Math.max(0, Math.floor(pixelX));
  const top = Math.max(0, Math.floor(pixelY));
  const right = Math.min(width, Math.ceil(pixelX + pixelW));
  const bottom = Math.min(height, Math.ceil(pixelY + pixelH));

  if (left >= width || top >= height || right <= 0 || bottom <= 0) return null;

  const sliceW = right - left;
  const sliceH = bottom - top;
  if (sliceW <= 0 || sliceH <= 0) return null;

  console.log(`  Tile (${x},${y},${z}): region [${top}:${bottom}, ${left}:${right}] = ${sliceW}x${sliceH} pixels`);

  const MAX_DIRECT_PIXELS = 1024 * 1024;
  let tileData;

  if (sliceW * sliceH <= MAX_DIRECT_PIXELS) {
    console.log(`    → Direct readRegion (${(sliceW * sliceH / 1e6).toFixed(2)}M pixels)`);
    const t0 = Date.now();
    const regionResult = await streamReader.readRegion(selectedDatasetId, top, left, sliceH, sliceW);
    const elapsed = Date.now() - t0;
    if (!regionResult?.data) { console.log('    → No data!'); return null; }
    tileData = resampleToTileSize(regionResult.data, sliceW, sliceH, tileSize, NaN);
    console.log(`    → Done in ${elapsed}ms`);
  } else {
    console.log(`    → Chunk-sampled (region too large: ${(sliceW * sliceH / 1e6).toFixed(1)}M pixels)`);
    const stepX = sliceW / tileSize;
    const stepY = sliceH / tileSize;
    tileData = new Float32Array(tileSize * tileSize);

    const t0 = Date.now();
    let chunksRead = 0;
    let lastCR = -1, lastCC = -1, currentChunk = null;

    for (let ty = 0; ty < tileSize; ty++) {
      const srcY = top + Math.floor((ty + 0.5) * stepY);
      if (srcY >= height) continue;
      const cr = Math.floor(srcY / chunkH);

      for (let tx = 0; tx < tileSize; tx++) {
        const srcX = left + Math.floor((tx + 0.5) * stepX);
        if (srcX >= width) continue;
        const cc = Math.floor(srcX / chunkW);

        if (cr !== lastCR || cc !== lastCC) {
          currentChunk = await getCachedChunk(cr, cc);
          if (!chunkCache.has(`${cr},${cc}_counted`)) {
            chunksRead++;
            chunkCache.set(`${cr},${cc}_counted`, true);
          }
          lastCR = cr;
          lastCC = cc;
        }

        if (currentChunk) {
          const localY = srcY - cr * chunkH;
          const localX = srcX - cc * chunkW;
          const idx = localY * chunkW + localX;
          if (idx >= 0 && idx < currentChunk.length) {
            tileData[ty * tileSize + tx] = currentChunk[idx];
          }
        }
      }
    }
    const elapsed = Date.now() - t0;
    console.log(`    → Read ${chunksRead} unique chunks in ${elapsed}ms`);
  }

  // Stats
  let validCount = 0, nanCount = 0, zeroCount = 0, tMin = Infinity, tMax = -Infinity, tSum = 0;
  for (let i = 0; i < tileData.length; i++) {
    const v = tileData[i];
    if (isNaN(v)) { nanCount++; continue; }
    if (v === 0) { zeroCount++; continue; }
    if (v < tMin) tMin = v;
    if (v > tMax) tMax = v;
    tSum += v;
    validCount++;
  }
  console.log(`    → Tile stats: valid=${validCount}, nan=${nanCount}, zero=${zeroCount}`);
  if (validCount > 0) {
    console.log(`    → Range: ${tMin.toFixed(4)} to ${tMax.toFixed(4)}, mean=${(tSum/validCount).toFixed(4)}`);
    const meanDb = 10 * Math.log10(tSum / validCount);
    console.log(`    → Mean dB: ${meanDb.toFixed(1)} dB`);
  }

  return { data: tileData, width: tileSize, height: tileSize };
}

// Write PGM utility
function writePGM(path, data, w, h, minVal, maxVal) {
  const pixels = Buffer.alloc(w * h);
  const range = maxVal - minVal || 1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isNaN(v) || v === 0) {
      pixels[i] = 0;
    } else {
      // dB scale: convert to dB then scale
      const db = 10 * Math.log10(Math.max(v, 1e-10));
      pixels[i] = Math.max(0, Math.min(255, Math.round(((db - minVal) / (maxVal - minVal)) * 255)));
    }
  }
  const header = `P5\n${w} ${h}\n255\n`;
  writeFileSync(path, Buffer.concat([Buffer.from(header, 'ascii'), pixels]));
}

// ─── Test z=0 (overview, covers entire image) ───────────────────

console.log('\n── z=0: Full image overview ────────────────────────────');
const tile_0_0_0 = await simulateGetTile(0, 0, 0);
if (tile_0_0_0) {
  writePGM(`${OUTPUT_DIR}/tile_z0_0_0.pgm`, tile_0_0_0.data, 256, 256, -30, 0);
  console.log(`    → Wrote: ${OUTPUT_DIR}/tile_z0_0_0.pgm\n`);
}

// ─── Test z=2 (4x4 grid, each tile covers ~4000x4000 pixels) ───

console.log('── z=2: Quadrant tiles ────────────────────────────────');
for (let ty = 0; ty < 2; ty++) {
  for (let tx = 0; tx < 2; tx++) {
    const tile = await simulateGetTile(tx, ty, 2);
    if (tile) {
      writePGM(`${OUTPUT_DIR}/tile_z2_${tx}_${ty}.pgm`, tile.data, 256, 256, -30, 0);
      console.log(`    → Wrote: ${OUTPUT_DIR}/tile_z2_${tx}_${ty}.pgm`);
    }
  }
}
console.log('');

// ─── Test z=5 (32x32 grid, each tile covers ~500x500 pixels) ───

console.log('── z=5: High zoom center tile ─────────────────────────');
const centerTileX = Math.floor(width / (width / Math.pow(2, 5)) / 2);
const centerTileY = Math.floor(height / (height / Math.pow(2, 5)) / 2);
const tile_5 = await simulateGetTile(centerTileX, centerTileY, 5);
if (tile_5) {
  writePGM(`${OUTPUT_DIR}/tile_z5_center.pgm`, tile_5.data, 256, 256, -30, 0);
  console.log(`    → Wrote: ${OUTPUT_DIR}/tile_z5_center.pgm\n`);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  DONE - Check test_output/ for tile images');
console.log('═══════════════════════════════════════════════════════════');
