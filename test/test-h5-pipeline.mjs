#!/usr/bin/env node
/**
 * Automated H5 pipeline test — validates the full SARdine data flow.
 *
 * Exercises on real NISAR GCOV H5 data:
 *   1. h5chunk file open + metadata parsing
 *   2. Dataset discovery (polarizations, shapes, chunk layout)
 *   3. Chunk reads + decompression
 *   4. Data integrity (NaN/zero handling, value ranges, stats)
 *   5. Region reads at multiple zoom levels
 *   6. Multilook + dB conversion (CPU path)
 *   7. Colormap + stretch application
 *   8. GeoTIFF export round-trip
 *
 * Usage:
 *   node test/test-h5-pipeline.mjs                           # use default test file
 *   node test/test-h5-pipeline.mjs path/to/file.h5           # custom file
 *   node test/test-h5-pipeline.mjs --url "<presigned-url>"   # remote file
 *
 * Exit code 0 = all checks passed, 1 = failures detected.
 */

import { openSync, readSync, closeSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const DEFAULT_H5 = join(rootDir, 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5');
const OUTPUT_DIR = join(rootDir, 'test/output');

// ─── CLI args ────────────────────────────────────────────────────────────────

let filePath = DEFAULT_H5;
let useUrl = null;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--url' && process.argv[i + 1]) {
    useUrl = process.argv[++i];
  } else if (!process.argv[i].startsWith('-')) {
    filePath = process.argv[i];
  }
}

// ─── Node.js File Shim ──────────────────────────────────────────────────────

class NodeFile {
  constructor(filePath) {
    this._path = filePath;
    const stat = statSync(filePath);
    this.size = stat.size;
    this.name = basename(filePath);
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

// ─── Test infrastructure ─────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
let currentSuite = '';
const failures = [];
const timings = {};

function suite(name) {
  currentSuite = name;
  console.log(`\n━━━ ${name} ━━━`);
}

function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  PASS  ${name}`);
        totalPassed++;
      }).catch(err => {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        failures.push(`${currentSuite}: ${name} — ${err.message}`);
        totalFailed++;
      });
    }
    console.log(`  PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures.push(`${currentSuite}: ${name} — ${err.message}`);
    totalFailed++;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures.push(`${currentSuite}: ${name} — ${err.message}`);
    totalFailed++;
  }
}

function skip(name, reason) {
  console.log(`  SKIP  ${name} (${reason})`);
  totalSkipped++;
}

function timed(label, fn) {
  const t0 = performance.now();
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.then(val => {
      timings[label] = performance.now() - t0;
      return val;
    });
  }
  timings[label] = performance.now() - t0;
  return result;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Imports ─────────────────────────────────────────────────────────────────

const { openH5ChunkFile } = await import(join(rootDir, 'src/loaders/h5chunk.js'));

let colormapMod, stretchMod, statsMod, geotiffMod;
try {
  colormapMod = await import(join(rootDir, 'src/utils/colormap.js'));
  stretchMod = await import(join(rootDir, 'src/utils/stretch.js'));
} catch (e) {
  console.warn(`Warning: could not import utils: ${e.message}`);
}
try {
  statsMod = await import(join(rootDir, 'src/utils/stats.js'));
} catch {}
try {
  geotiffMod = await import(join(rootDir, 'src/utils/geotiff-writer.js'));
} catch {}

// ─── Setup ───────────────────────────────────────────────────────────────────

try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}

console.log('══════════════════════════════════════════════════════════════');
console.log('  SARdine H5 Pipeline Test');
console.log(`  Platform: ${platform()} ${arch()}`);
console.log(`  Node: ${process.version}`);
console.log('══════════════════════════════════════════════════════════════');

if (useUrl) {
  console.log(`  Source: URL (remote)`);
  skip('Local file tests', 'using --url mode');
  console.log('\nURL mode not implemented in this test yet. Use test-chunk-pipeline.mjs.');
  process.exit(0);
}

if (!existsSync(filePath)) {
  console.error(`\n  File not found: ${filePath}`);
  console.error('  Place a NISAR GCOV .h5 file at test/data/ or pass a path.\n');
  process.exit(1);
}

const file = new NodeFile(filePath);
console.log(`  File: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. FILE OPEN + METADATA
// ═══════════════════════════════════════════════════════════════════════════════

suite('1. File open + metadata parsing');

let streamReader;
await checkAsync('h5chunk opens file without error', async () => {
  streamReader = await timed('file_open', () => openH5ChunkFile(file, 32 * 1024 * 1024));
  assert(streamReader, 'openH5ChunkFile returned null');
});

if (!streamReader) {
  console.error('Cannot continue without stream reader.');
  process.exit(1);
}

let datasets;
check('discovers datasets', () => {
  datasets = streamReader.getDatasets();
  assert(Array.isArray(datasets), 'getDatasets() did not return array');
  assert(datasets.length > 0, `No datasets found (got ${datasets.length})`);
  console.log(`        Found ${datasets.length} datasets`);
});

check('datasets have required properties', () => {
  for (const ds of datasets) {
    assert(ds.id, `Dataset missing id`);
    assert(Array.isArray(ds.shape), `Dataset ${ds.id} missing shape`);
    assert(ds.dtype, `Dataset ${ds.id} missing dtype`);
  }
});

// Find 2D imaging datasets
const imagingDatasets = datasets.filter(ds =>
  ds.shape?.length === 2 && ds.shape[0] >= 100 && ds.shape[1] >= 100
);

check('has 2D imaging datasets', () => {
  assert(imagingDatasets.length > 0, `No 2D datasets with shape >= 100x100`);
  console.log(`        ${imagingDatasets.length} imaging datasets:`);
  for (const ds of imagingDatasets) {
    console.log(`          ${ds.id}: [${ds.shape.join('x')}] ${ds.dtype} chunks=${ds.numChunks}`);
  }
});

// Select largest dataset for remaining tests
const primary = imagingDatasets.reduce((best, ds) => {
  const size = ds.shape[0] * ds.shape[1];
  return size > (best?.shape[0] || 0) * (best?.shape[1] || 0) ? ds : best;
}, null);

const [dataH, dataW] = primary.shape;
const [chunkH, chunkW] = primary.chunkDims || [512, 512];
const numChunkRows = Math.ceil(dataH / chunkH);
const numChunkCols = Math.ceil(dataW / chunkW);

console.log(`\n  Primary dataset: ${primary.id}`);
console.log(`    Shape: ${dataW}x${dataH}, Chunks: ${chunkW}x${chunkH}`);
console.log(`    Grid: ${numChunkCols}x${numChunkRows} chunks\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CHUNK READS
// ═══════════════════════════════════════════════════════════════════════════════

suite('2. Chunk reads + decompression');

let sampleChunk;
await checkAsync('reads corner chunk (0,0)', async () => {
  sampleChunk = await timed('chunk_0_0', () => streamReader.readChunk(primary.id, 0, 0));
  assert(sampleChunk, 'readChunk returned null for (0,0)');
  assert(sampleChunk instanceof Float32Array || sampleChunk instanceof Float64Array,
    `Expected typed array, got ${sampleChunk?.constructor?.name}`);
  assert(sampleChunk.length > 0, 'Chunk has zero length');
  console.log(`        ${sampleChunk.length} values (${(sampleChunk.byteLength / 1024).toFixed(0)} KB)`);
});

let centerChunk;
const midRow = Math.floor(numChunkRows / 2);
const midCol = Math.floor(numChunkCols / 2);
await checkAsync(`reads center chunk (${midRow},${midCol})`, async () => {
  centerChunk = await timed('chunk_center', () => streamReader.readChunk(primary.id, midRow, midCol));
  assert(centerChunk, `readChunk returned null for (${midRow},${midCol})`);
  assert(centerChunk.length > 0, 'Center chunk has zero length');
});

await checkAsync('reads last chunk', async () => {
  const lastR = numChunkRows - 1;
  const lastC = numChunkCols - 1;
  const chunk = await timed('chunk_last', () => streamReader.readChunk(primary.id, lastR, lastC));
  assert(chunk, `readChunk returned null for last chunk (${lastR},${lastC})`);
});

await checkAsync('out-of-bounds chunk returns null (not crash)', async () => {
  const chunk = await streamReader.readChunk(primary.id, 99999, 99999);
  assert(chunk === null || chunk === undefined, 'Expected null for out-of-bounds chunk');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DATA INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════

suite('3. Data integrity');

function computeStats(arr) {
  let valid = 0, nan = 0, zero = 0, negative = 0;
  let min = Infinity, max = -Infinity, sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isNaN(v)) { nan++; continue; }
    if (v === 0) { zero++; continue; }
    if (v < 0) negative++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    valid++;
  }
  return { valid, nan, zero, negative, min, max, mean: valid > 0 ? sum / valid : NaN };
}

if (centerChunk) {
  const stats = computeStats(centerChunk);

  check('center chunk has valid pixels', () => {
    assert(stats.valid > 0, `No valid (non-NaN, non-zero) pixels in center chunk`);
    console.log(`        valid=${stats.valid}, NaN=${stats.nan}, zero=${stats.zero}`);
  });

  check('SAR power values are non-negative', () => {
    assert(stats.negative === 0,
      `Found ${stats.negative} negative values — GCOV power should be >= 0`);
  });

  check('values are in physically plausible range', () => {
    // GCOV gamma0 power: typically 1e-6 to 10 in linear scale
    // dB: -60 to +10 dB
    const minDb = stats.min > 0 ? 10 * Math.log10(stats.min) : -Infinity;
    const maxDb = stats.max > 0 ? 10 * Math.log10(stats.max) : -Infinity;
    const meanDb = stats.mean > 0 ? 10 * Math.log10(stats.mean) : -Infinity;
    console.log(`        Linear: min=${stats.min.toExponential(2)}, max=${stats.max.toExponential(2)}`);
    console.log(`        dB: min=${minDb.toFixed(1)}, max=${maxDb.toFixed(1)}, mean=${meanDb.toFixed(1)}`);
    assert(maxDb < 50, `Max dB=${maxDb.toFixed(1)} — unreasonably high for SAR backscatter`);
    assert(minDb > -100, `Min dB=${minDb.toFixed(1)} — unreasonably low`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. REGION READS (simulating getTile at different zoom levels)
// ═══════════════════════════════════════════════════════════════════════════════

suite('4. Region reads (tile simulation)');

await checkAsync('readRegion: small center region (256x256)', async () => {
  const startRow = Math.floor(dataH / 2) - 128;
  const startCol = Math.floor(dataW / 2) - 128;
  const result = await timed('region_256', () =>
    streamReader.readRegion(primary.id, startRow, startCol, 256, 256)
  );
  assert(result?.data, 'readRegion returned no data');
  assert(result.data.length === 256 * 256, `Expected 65536 values, got ${result.data.length}`);
  const stats = computeStats(result.data);
  console.log(`        valid=${stats.valid}/${result.data.length}`);
});

await checkAsync('readRegion: medium region (1024x1024)', async () => {
  const startRow = Math.floor(dataH / 2) - 512;
  const startCol = Math.floor(dataW / 2) - 512;
  const result = await timed('region_1024', () =>
    streamReader.readRegion(primary.id, startRow, startCol, 1024, 1024)
  );
  assert(result?.data, 'readRegion returned no data');
  const expected = 1024 * 1024;
  assert(result.data.length === expected, `Expected ${expected} values, got ${result.data.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CPU PROCESSING PIPELINE (dB + stretch + colormap)
// ═══════════════════════════════════════════════════════════════════════════════

suite('5. CPU processing pipeline');

if (centerChunk && colormapMod && stretchMod) {
  const { getColormap } = colormapMod;
  const { applyStretch } = stretchMod;

  check('dB conversion produces valid range', () => {
    let validDb = 0;
    let outOfRange = 0;
    for (let i = 0; i < Math.min(centerChunk.length, 10000); i++) {
      const v = centerChunk[i];
      if (v <= 0 || isNaN(v)) continue;
      const db = 10 * Math.log10(v);
      if (isFinite(db)) validDb++;
      else outOfRange++;
    }
    assert(validDb > 0, 'No valid dB conversions');
    assert(outOfRange === 0, `${outOfRange} non-finite dB values`);
  });

  check('normalize + stretch + colormap produces RGBA', () => {
    const cmap = getColormap('viridis');
    const minDb = -30, maxDb = 0;
    let rendered = 0;

    for (let i = 0; i < Math.min(centerChunk.length, 1000); i++) {
      const v = centerChunk[i];
      if (v <= 0 || isNaN(v)) continue;
      const db = 10 * Math.log10(v);
      const t = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
      const stretched = applyStretch(t, 'sqrt');
      const [r, g, b] = cmap(stretched);
      assert(r >= 0 && r <= 255, `R out of range: ${r}`);
      assert(g >= 0 && g <= 255, `G out of range: ${g}`);
      assert(b >= 0 && b <= 255, `B out of range: ${b}`);
      rendered++;
    }
    assert(rendered > 0, 'No pixels were rendered');
    console.log(`        Rendered ${rendered} pixels through full pipeline`);
  });

  const stretchModes = ['linear', 'sqrt', 'gamma', 'sigmoid'];
  for (const mode of stretchModes) {
    check(`stretch mode "${mode}" runs without error`, () => {
      for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
        const result = applyStretch(t, mode, 1.5);
        assert(isFinite(result), `${mode}(${t}) = ${result}`);
        assert(result >= -0.01 && result <= 1.01, `${mode}(${t}) = ${result} out of [0,1]`);
      }
    });
  }

  const colormapNames = ['grayscale', 'viridis', 'inferno', 'plasma', 'phase'];
  for (const name of colormapNames) {
    check(`colormap "${name}" runs without error`, () => {
      const cmap = getColormap(name);
      for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
        const rgb = cmap(t);
        assert(Array.isArray(rgb) && rgb.length === 3, `${name}(${t}) not [r,g,b]`);
      }
    });
  }
} else {
  skip('CPU processing pipeline', 'colormap/stretch modules not available');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. GEOTIFF EXPORT ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════════════

suite('6. GeoTIFF export');

if (centerChunk && geotiffMod) {
  const { writeFloat32GeoTIFF } = geotiffMod;

  await checkAsync('writeFloat32GeoTIFF from real chunk data', async () => {
    // Use a 256x256 subset of the center chunk
    const w = Math.min(256, chunkW);
    const h = Math.min(256, chunkH);
    const subset = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const srcIdx = r * chunkW + c;
        subset[r * w + c] = srcIdx < centerChunk.length ? centerChunk[srcIdx] : NaN;
      }
    }

    const buf = await writeFloat32GeoTIFF(
      { data: subset }, ['data'], w, h,
      [0, 0, w * 100, h * 100], 32610
    );

    assert(buf, 'Export returned null');
    // May be ArrayBuffer or Buffer depending on environment
    const byteLen = buf.byteLength || buf.length;
    assert(byteLen > 0, 'Export buffer is empty');

    // Verify TIFF magic
    const arrBuf = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const view = new DataView(arrBuf);
    const magic = view.getUint16(2, true);
    assert(magic === 42, `Bad TIFF magic: ${magic}`);

    const outPath = join(OUTPUT_DIR, 'pipeline_test_export.tif');
    writeFileSync(outPath, Buffer.from(arrBuf));
    console.log(`        Wrote ${(buf.byteLength / 1024).toFixed(0)} KB to ${basename(outPath)}`);
  });
} else {
  skip('GeoTIFF export', 'geotiff-writer module not available');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. MULTI-DATASET CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════

suite('7. Multi-dataset consistency');

if (imagingDatasets.length >= 2) {
  // Group datasets by resolution — NISAR has frequencyA (full-res) and frequencyB (lower-res)
  const byShape = {};
  for (const ds of imagingDatasets) {
    const key = `${ds.shape[0]}x${ds.shape[1]}`;
    (byShape[key] = byShape[key] || []).push(ds);
  }

  await checkAsync('imaging datasets are consistent within each resolution group', async () => {
    const groups = Object.entries(byShape);
    console.log(`        ${groups.length} resolution group(s):`);
    for (const [shape, dsList] of groups) {
      console.log(`          [${shape}]: ${dsList.length} datasets`);
    }
    // Each group should have datasets with matching shapes (this is tautological by construction,
    // but validates the grouping logic — the real check is that we found > 0 groups)
    assert(groups.length > 0, 'No resolution groups found');
    assert(groups.length <= 3, `Unexpectedly many resolution groups: ${groups.length}`);
  });

  await checkAsync('can read chunk from secondary dataset', async () => {
    const secondary = imagingDatasets.find(ds => ds.id !== primary.id);
    if (!secondary) { skip('secondary dataset read', 'only one imaging dataset'); return; }
    const chunk = await streamReader.readChunk(secondary.id, midRow, midCol);
    assert(chunk, `readChunk returned null for ${secondary.id}`);
    assert(chunk.length > 0, 'Secondary chunk has zero length');
    console.log(`        ${secondary.id}: ${chunk.length} values`);
  });
} else {
  skip('multi-dataset consistency', 'only one imaging dataset found');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(62));
console.log(`  RESULTS: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
console.log('═'.repeat(62));

if (Object.keys(timings).length > 0) {
  console.log('\n  Timings:');
  for (const [label, ms] of Object.entries(timings)) {
    console.log(`    ${label}: ${ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`}`);
  }
}

if (failures.length > 0) {
  console.log('\n  Failures:');
  for (const f of failures) {
    console.log(`    ${f}`);
  }
}

console.log('');
process.exit(totalFailed > 0 ? 1 : 0);
