#!/usr/bin/env node
/**
 * Benchmark 4: h5chunk Streaming Performance
 *
 * Measures chunked HDF5 access pattern efficiency using h5chunk
 * against a local 1.9GB NISAR GCOV HDF5 file.
 *
 * Metrics:
 * - Metadata parse time (superblock + B-tree walk)
 * - Time-to-first-pixel for various region sizes
 * - Bytes read vs bytes needed (transfer ratio)
 * - Sequential tile access pattern (warm cache effect)
 */

import { H5Chunk } from '../../src/loaders/h5chunk.js';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { performance } from 'perf_hooks';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const FILE_PATH = join(__dirname, '..', 'data',
  'NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5');

const REGION_SIZES = [256, 512, 1024, 2048];
const TRIALS = 3;

/**
 * FakeFile: Node.js wrapper that mimics the browser File API.
 * h5chunk expects file.slice(start, end).arrayBuffer().
 * We track bytes read for the transfer ratio metric.
 */
class FakeFile {
  constructor(path) {
    this._buffer = readFileSync(path);
    this.size = this._buffer.byteLength;
    this.name = path.split('/').pop();
    this._bytesRead = 0;
    this._readCount = 0;
  }

  slice(start, end) {
    const actualEnd = end === undefined ? this.size : end;
    const bytes = actualEnd - start;
    this._bytesRead += bytes;
    this._readCount++;
    const sliced = this._buffer.subarray(start, actualEnd);
    return {
      arrayBuffer: () => Promise.resolve(
        sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)
      ),
    };
  }

  resetStats() {
    this._bytesRead = 0;
    this._readCount = 0;
  }

  get bytesRead() { return this._bytesRead; }
  get readCount() { return this._readCount; }
}

async function findTarget(reader) {
  const datasets = reader.getDatasets();
  const preferred = ['HHHH', 'HVHV', 'VVVV'];
  for (const pref of preferred) {
    const ds = datasets.find(d => d.chunked && d.path && d.path.includes(pref));
    if (ds) return ds;
  }
  return datasets.find(d => d.chunked && d.numChunks > 0);
}

async function benchmarkMetadata(file) {
  console.log('\n--- Test 1: Metadata Parse Time ---');
  const times = [];

  for (let t = 0; t < TRIALS; t++) {
    file.resetStats();
    const reader = new H5Chunk();
    const t0 = performance.now();
    await reader.openFile(file);
    const elapsed = performance.now() - t0;
    times.push(elapsed);
    const datasets = reader.getDatasets();
    if (t === 0) {
      console.log(`  Datasets found: ${datasets.length}`);
      console.log(`  Metadata bytes read: ${(file.bytesRead / 1024).toFixed(0)} KB`);
    }
  }

  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(`  Metadata parse time: ${median.toFixed(1)} ms (median of ${TRIALS})`);
  return { metadataParseMs: +median.toFixed(2), metadataBytesRead: file.bytesRead };
}

async function benchmarkRegions(file) {
  console.log('\n--- Test 2: Time-to-First-Pixel by Region Size ---');

  // Open once to find target dataset
  const reader = new H5Chunk();
  await reader.openFile(file);
  const target = await findTarget(reader);

  if (!target) {
    console.log('  ERROR: No suitable chunked dataset found');
    return [];
  }

  console.log(`  Dataset: ${target.path || target.id}`);
  console.log(`  Shape: [${target.shape}]  Chunks: ${target.numChunks}  ChunkDims: [${target.chunkDims}]`);

  const [totalRows, totalCols] = target.shape;
  const results = [];

  for (const regionSize of REGION_SIZES) {
    if (regionSize > totalRows || regionSize > totalCols) {
      console.log(`  ${regionSize}x${regionSize}: SKIP (larger than dataset)`);
      continue;
    }

    const centerRow = Math.floor(totalRows / 2) - Math.floor(regionSize / 2);
    const centerCol = Math.floor(totalCols / 2) - Math.floor(regionSize / 2);

    const trialTimes = [];
    let bytesActual = 0;

    for (let t = 0; t < TRIALS; t++) {
      // Fresh reader for cold-start measurement
      const freshReader = new H5Chunk();
      const freshFile = new FakeFile(FILE_PATH);
      await freshReader.openFile(freshFile);

      freshFile.resetStats();
      const t0 = performance.now();
      const region = await freshReader.readRegion(target.id, centerRow, centerCol, regionSize, regionSize);
      const elapsed = performance.now() - t0;
      trialTimes.push(elapsed);
      bytesActual = freshFile.bytesRead;

      if (t === 0) {
        // Validate data
        const validPixels = region.data.filter(v => v !== 0 && !isNaN(v)).length;
        console.log(`  ${regionSize}x${regionSize}: ${(validPixels / region.data.length * 100).toFixed(0)}% valid pixels`);
      }
    }

    trialTimes.sort((a, b) => a - b);
    const medianTime = trialTimes[Math.floor(trialTimes.length / 2)];
    const bytesNeeded = regionSize * regionSize * 4; // Float32
    const transferRatio = bytesActual / bytesNeeded;
    const pixelsPerMs = (regionSize * regionSize) / medianTime;

    const result = {
      regionSize,
      pixels: regionSize * regionSize,
      medianTimeMs: +medianTime.toFixed(2),
      minTimeMs: +trialTimes[0].toFixed(2),
      maxTimeMs: +trialTimes[trialTimes.length - 1].toFixed(2),
      bytesNeeded,
      bytesActual,
      transferRatio: +transferRatio.toFixed(2),
      pixelsPerMs: +pixelsPerMs.toFixed(0),
    };
    results.push(result);

    console.log(`  ${regionSize}x${regionSize}: ${medianTime.toFixed(1)} ms, ` +
      `ratio=${transferRatio.toFixed(1)}x, ${pixelsPerMs.toFixed(0)} px/ms`);
  }

  return results;
}

async function benchmarkSequentialAccess(file) {
  console.log('\n--- Test 3: Sequential Tile Access (Cache Warmth) ---');

  const reader = new H5Chunk();
  await reader.openFile(file);
  const target = await findTarget(reader);

  if (!target) return [];

  const [totalRows, totalCols] = target.shape;
  const tileSize = 512;
  const startRow = Math.floor(totalRows / 2) - tileSize;
  const startCol = Math.floor(totalCols / 2) - tileSize;

  // Read a 3x3 grid of tiles
  const results = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const r = startRow + row * tileSize;
      const c = startCol + col * tileSize;

      if (r + tileSize > totalRows || c + tileSize > totalCols) continue;

      file.resetStats();
      const t0 = performance.now();
      await reader.readRegion(target.id, r, c, tileSize, tileSize);
      const elapsed = performance.now() - t0;

      results.push({
        tileIndex: row * 3 + col,
        row: r,
        col: c,
        timeMs: +elapsed.toFixed(2),
        bytesRead: file.bytesRead,
      });

      console.log(`  Tile [${row},${col}]: ${elapsed.toFixed(1)} ms, ${(file.bytesRead / 1024).toFixed(0)} KB read`);
    }
  }

  return results;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('=' .repeat(60));
  console.log('Benchmark 4: h5chunk Streaming Performance');
  console.log('=' .repeat(60));

  // Check file exists
  try {
    const stat = statSync(FILE_PATH);
    console.log(`  File: ${FILE_PATH.split('/').pop()}`);
    console.log(`  Size: ${(stat.size / 1e9).toFixed(2)} GB`);
  } catch {
    console.error(`  ERROR: File not found: ${FILE_PATH}`);
    process.exit(1);
  }

  const file = new FakeFile(FILE_PATH);

  // Run benchmarks
  const metadata = await benchmarkMetadata(file);
  const regions = await benchmarkRegions(file);
  const sequential = await benchmarkSequentialAccess(file);

  // Compile results
  const results = {
    benchmark: '4_h5chunk_streaming',
    file: {
      name: file.name,
      sizeBytes: file.size,
      sizeMB: +(file.size / 1e6).toFixed(1),
    },
    metadata,
    regions,
    sequential,
    summary: {},
  };

  // Check success criteria
  if (regions.length > 0) {
    const firstPixel = regions[0]; // smallest region = time-to-first-pixel
    results.summary.timeToFirstPixelMs = firstPixel.medianTimeMs;
    results.summary.firstPixelPass = firstPixel.medianTimeMs < 100;

    const avgRatio = regions.reduce((s, r) => s + r.transferRatio, 0) / regions.length;
    results.summary.avgTransferRatio = +avgRatio.toFixed(2);

    console.log(`\n  --- Summary ---`);
    console.log(`  Time to first pixel (${firstPixel.regionSize}x${firstPixel.regionSize}): ${firstPixel.medianTimeMs} ms ${firstPixel.medianTimeMs < 100 ? 'PASS' : 'FAIL'}`);
    console.log(`  Average transfer ratio: ${avgRatio.toFixed(1)}x`);
  }

  // Write CSV
  const csvPath = join(RESULTS_DIR, 'bench4_streaming.csv');
  const csvLines = ['regionSize,pixels,medianTimeMs,minTimeMs,maxTimeMs,bytesNeeded,bytesActual,transferRatio,pixelsPerMs'];
  for (const r of regions) {
    csvLines.push(`${r.regionSize},${r.pixels},${r.medianTimeMs},${r.minTimeMs},${r.maxTimeMs},${r.bytesNeeded},${r.bytesActual},${r.transferRatio},${r.pixelsPerMs}`);
  }
  writeFileSync(csvPath, csvLines.join('\n') + '\n');
  console.log(`\n  CSV: ${csvPath}`);

  // Write JSON
  const jsonPath = join(RESULTS_DIR, 'bench4_summary.json');
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`  JSON: ${jsonPath}`);

  // Generate figure
  try {
    // Write a python script for the figure and exec it
    const figScript = `
import json, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

with open('${jsonPath}') as f:
    data = json.load(f)

regions = data['regions']
if not regions:
    print('No region data to plot')
    exit()

sizes = [r['regionSize'] for r in regions]
times = [r['medianTimeMs'] for r in regions]
ratios = [r['transferRatio'] for r in regions]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))

# Time to pixel
ax1.bar(range(len(sizes)), times, color='#4ec9d4')
ax1.set_xticks(range(len(sizes)))
ax1.set_xticklabels([f'{s}x{s}' for s in sizes])
ax1.set_ylabel('Time (ms)')
ax1.set_title('Time to First Pixel')
ax1.axhline(y=100, color='#e05858', linestyle='--', label='100ms target')
ax1.legend()
for i, t in enumerate(times):
    ax1.text(i, t + 2, f'{t:.0f}ms', ha='center', fontsize=9)

# Transfer ratio
ax2.bar(range(len(sizes)), ratios, color='#76b900')
ax2.set_xticks(range(len(sizes)))
ax2.set_xticklabels([f'{s}x{s}' for s in sizes])
ax2.set_ylabel('Transfer Ratio (bytes read / bytes needed)')
ax2.set_title('I/O Efficiency')
ax2.axhline(y=1.0, color='#888', linestyle='--', label='Ideal (1.0)')
ax2.legend()
for i, r in enumerate(ratios):
    ax2.text(i, r + 0.1, f'{r:.1f}x', ha='center', fontsize=9)

plt.suptitle('h5chunk Streaming Performance', fontweight='bold')
plt.tight_layout()
plt.savefig('${join(RESULTS_DIR, 'fig_streaming_efficiency.pdf')}', dpi=150, bbox_inches='tight')
plt.close()
print('Figure saved')
`;
    const { execSync } = await import('child_process');
    execSync(`python3 -c ${JSON.stringify(figScript)}`, { stdio: 'inherit' });
  } catch {
    console.log('  [SKIP] Figure generation failed (matplotlib not available?)');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
