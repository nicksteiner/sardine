#!/usr/bin/env node
/**
 * Benchmark 4: h5chunk Streaming Performance
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
    this._bytesRead += (actualEnd - start);
    this._readCount++;
    const sliced = this._buffer.subarray(start, actualEnd);
    return { arrayBuffer: () => Promise.resolve(sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength)) };
  }
  resetStats() { this._bytesRead = 0; this._readCount = 0; }
  get bytesRead() { return this._bytesRead; }
}

async function findTarget(reader) {
  const ds = reader.getDatasets();
  for (const pref of ['HHHH', 'HVHV', 'VVVV']) {
    const d = ds.find(x => x.chunked && x.path?.includes(pref));
    if (d) return d;
  }
  return ds.find(x => x.chunked && x.numChunks > 0);
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('='.repeat(60));
  console.log('Benchmark 4: h5chunk Streaming Performance');
  console.log('='.repeat(60));

  const stat = statSync(FILE_PATH);
  console.log(`  File: ${FILE_PATH.split('/').pop()}`);
  console.log(`  Size: ${(stat.size / 1e9).toFixed(2)} GB`);

  const file = new FakeFile(FILE_PATH);

  // Metadata parse time
  console.log('\n--- Metadata Parse ---');
  const metaTimes = [];
  for (let t = 0; t < TRIALS; t++) {
    file.resetStats();
    const r = new H5Chunk(); const t0 = performance.now();
    await r.openFile(file);
    metaTimes.push(performance.now() - t0);
    if (t === 0) console.log(`  Datasets: ${r.getDatasets().length}, Bytes: ${(file.bytesRead/1024).toFixed(0)} KB`);
  }
  metaTimes.sort((a, b) => a - b);
  const metaMs = +metaTimes[Math.floor(metaTimes.length / 2)].toFixed(2);
  console.log(`  Parse time: ${metaMs} ms (median)`);

  // Region reads
  console.log('\n--- Region Reads ---');
  const reader = new H5Chunk(); await reader.openFile(file);
  const target = await findTarget(reader);
  if (!target) { console.error('No chunked dataset found'); process.exit(1); }
  console.log(`  Dataset: ${target.path}, Shape: [${target.shape}]`);

  const [totalRows, totalCols] = target.shape;
  const regions = [];

  for (const sz of REGION_SIZES) {
    if (sz > totalRows || sz > totalCols) continue;
    const cr = Math.floor(totalRows/2) - Math.floor(sz/2);
    const cc = Math.floor(totalCols/2) - Math.floor(sz/2);
    const trialTimes = [];
    let bytesActual = 0;

    for (let t = 0; t < TRIALS; t++) {
      const fr = new H5Chunk(); const ff = new FakeFile(FILE_PATH);
      await fr.openFile(ff); ff.resetStats();
      const t0 = performance.now();
      await fr.readRegion(target.id, cr, cc, sz, sz);
      trialTimes.push(performance.now() - t0);
      bytesActual = ff.bytesRead;
    }
    trialTimes.sort((a, b) => a - b);
    const med = +trialTimes[Math.floor(trialTimes.length/2)].toFixed(2);
    const needed = sz * sz * 4;
    const ratio = +(bytesActual / needed).toFixed(2);
    regions.push({ regionSize: sz, pixels: sz*sz, medianTimeMs: med, bytesNeeded: needed, bytesActual, transferRatio: ratio, pixelsPerMs: +((sz*sz)/med).toFixed(0) });
    console.log(`  ${sz}x${sz}: ${med} ms, ratio=${ratio}x, ${((sz*sz)/med).toFixed(0)} px/ms`);
  }

  // Sequential tiles
  console.log('\n--- Sequential Tiles ---');
  const seqReader = new H5Chunk(); const seqFile = new FakeFile(FILE_PATH);
  await seqReader.openFile(seqFile);
  const sequential = [];
  const tsz = 512, sr = Math.floor(totalRows/2)-tsz, sc = Math.floor(totalCols/2)-tsz;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const r = sr + row*tsz, c = sc + col*tsz;
      if (r+tsz > totalRows || c+tsz > totalCols) continue;
      seqFile.resetStats();
      const t0 = performance.now();
      await seqReader.readRegion(target.id, r, c, tsz, tsz);
      const el = +(performance.now() - t0).toFixed(2);
      sequential.push({ tile: `${row},${col}`, timeMs: el, bytesRead: seqFile.bytesRead });
      console.log(`  [${row},${col}]: ${el} ms`);
    }
  }

  const results = {
    benchmark: '4_h5chunk_streaming',
    file: { name: file.name, sizeMB: +(file.size/1e6).toFixed(1) },
    metadataParseMs: metaMs, regions, sequential,
    summary: { timeToFirstPixelMs: regions[0]?.medianTimeMs, avgTransferRatio: +(regions.reduce((s,r) => s+r.transferRatio, 0)/regions.length).toFixed(2) }
  };

  writeFileSync(join(RESULTS_DIR, 'bench4_streaming.csv'),
    'regionSize,pixels,medianTimeMs,bytesNeeded,bytesActual,transferRatio,pixelsPerMs\n' +
    regions.map(r => `${r.regionSize},${r.pixels},${r.medianTimeMs},${r.bytesNeeded},${r.bytesActual},${r.transferRatio},${r.pixelsPerMs}`).join('\n') + '\n');
  writeFileSync(join(RESULTS_DIR, 'bench4_summary.json'), JSON.stringify(results, null, 2));
  console.log(`\n  CSV + JSON written to results/`);
}

main().catch(e => { console.error(e); process.exit(1); });
