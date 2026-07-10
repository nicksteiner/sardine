/**
 * h5chunk-synthetic.test.mjs — behavioral tests for src/loaders/h5chunk.js
 * against a tiny committed HDF5 fixture (no network, no NISAR download).
 *
 * Fixture: test/unit/fixtures/synthetic-chunked.h5 (~12 KB), built once with
 * h5py (see fixtures/generate-synthetic-h5.py):
 *   /science/grids/data — float32, shape (64, 48), chunks (16, 16),
 *   gzip(4) + shuffle, paged file space (superblock v2, v1 B-tree chunk
 *   index — the cloud-optimized layout h5chunk targets).
 *   Values: data[r, c] = r * 100 + c (exactly representable in float32).
 *
 * Second fixture: test/unit/fixtures/synthetic-chunked-v0.h5 (~8 KB), same
 * dataset/values but written with DEFAULT h5py settings → superblock v0,
 * root group addressed via the root symbol-table entry. Regression coverage
 * for the W013 parseSuperblock fix (v0/v1 path previously misread the STE's
 * linkNameOffset as rootGroupAddress).
 *
 * Asserts dataset discovery, readChunk values, and readRegion values
 * (including chunk-boundary crossings) against the closed-form formula.
 *
 * Run: node test/unit/h5chunk-synthetic.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openH5ChunkFile } from '../../src/loaders/h5chunk.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('h5chunk synthetic fixture');

const ROWS = 64;
const COLS = 48;
const CHUNK = 16;
const DATASET_PATH = '/science/grids/data';
const expected = (r, c) => r * 100 + c;

// ─── Mock browser File API over the fixture bytes ────────────────────────────

class MockFile {
  constructor(arrayBuffer, name) {
    this._buffer = arrayBuffer;
    this.name = name;
    this.size = arrayBuffer.byteLength;
  }
  slice(start, end) {
    const sliced = this._buffer.slice(start, end);
    return { arrayBuffer: () => Promise.resolve(sliced) };
  }
}

function loadFixture(name) {
  const buf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name));
  return new MockFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name);
}

const mockFile = loadFixture('synthetic-chunked.h5');

let reader;
let datasetId;

test('openH5ChunkFile opens the fixture', async () => {
  reader = await openH5ChunkFile(mockFile);
  assert.ok(reader, 'reader created');
  // Browser Worker API is unavailable in Node — use main-thread decompression.
  reader.useWorkerPool = false;
});

test('dataset discovery finds /science/grids/data with correct shape/dtype/chunking', async () => {
  datasetId = reader.findDatasetByPath(DATASET_PATH);
  assert.ok(datasetId, `findDatasetByPath('${DATASET_PATH}') resolves`);

  const listed = reader.getDatasets().find(d => d.id === datasetId);
  assert.ok(listed, 'dataset appears in getDatasets()');
  assert.deepEqual(Array.from(listed.shape), [ROWS, COLS], 'shape (64, 48)');
  assert.equal(listed.dtype, 'float32', 'dtype float32');
  assert.equal(listed.chunked, true, 'chunked layout');
  // HDF5 B-tree chunk dims carry a trailing element-size dimension → [16, 16, 4]
  assert.deepEqual(Array.from(listed.chunkDims).slice(0, 2), [CHUNK, CHUNK], 'chunk dims (16, 16)');
});

test('readChunk(0,0): full chunk decodes through shuffle + deflate, values exact', async () => {
  const chunk = await reader.readChunk(datasetId, 0, 0);
  assert.ok(chunk instanceof Float32Array, 'Float32Array returned');
  assert.equal(chunk.length, CHUNK * CHUNK, '16×16 values');
  for (let r = 0; r < CHUNK; r++) {
    for (let c = 0; c < CHUNK; c++) {
      const got = chunk[r * CHUNK + c];
      if (got !== expected(r, c)) {
        assert.fail(`chunk(0,0)[${r},${c}]: expected ${expected(r, c)}, got ${got}`);
      }
    }
  }
  assert.ok(true, 'all chunk(0,0) values exact');
});

test('readChunk(2,1): interior chunk maps to correct pixel offsets', async () => {
  const chunk = await reader.readChunk(datasetId, 2, 1);
  assert.equal(chunk.length, CHUNK * CHUNK, '16×16 values');
  // Chunk (2,1) covers rows 32..47, cols 16..31
  for (let r = 0; r < CHUNK; r++) {
    for (let c = 0; c < CHUNK; c++) {
      const got = chunk[r * CHUNK + c];
      const want = expected(32 + r, 16 + c);
      if (got !== want) {
        assert.fail(`chunk(2,1)[${r},${c}]: expected ${want}, got ${got}`);
      }
    }
  }
  assert.ok(true, 'all chunk(2,1) values exact');
});

test('readChunk on the last chunk row/col works (edge chunks)', async () => {
  const chunk = await reader.readChunk(datasetId, 3, 2); // rows 48..63, cols 32..47
  assert.equal(chunk.length, CHUNK * CHUNK, 'edge chunk fully allocated');
  assert.equal(chunk[0], expected(48, 32), 'first value');
  assert.equal(chunk[CHUNK * CHUNK - 1], expected(63, 47), 'last value');
});

test('readChunk out of range returns null (sparse/no such chunk)', async () => {
  const chunk = await reader.readChunk(datasetId, 10, 10);
  assert.equal(chunk, null, 'missing chunk → null');
});

test('readRegion within a single chunk returns exact values', async () => {
  const region = await reader.readRegion(datasetId, 2, 3, 5, 7);
  assert.equal(region.width, 7, 'width');
  assert.equal(region.height, 5, 'height');
  assert.equal(region.data.length, 35, 'data length');
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 7; c++) {
      const got = region.data[r * 7 + c];
      const want = expected(2 + r, 3 + c);
      if (got !== want) assert.fail(`region[${r},${c}]: expected ${want}, got ${got}`);
    }
  }
  assert.ok(true, 'single-chunk region exact');
});

test('readRegion crossing chunk boundaries stitches chunks correctly', async () => {
  // Rows 10..39, cols 10..39 → spans chunk rows 0..2 and chunk cols 0..2
  const region = await reader.readRegion(datasetId, 10, 10, 30, 30);
  assert.equal(region.width, 30, 'width');
  assert.equal(region.height, 30, 'height');
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 30; c++) {
      const got = region.data[r * 30 + c];
      const want = expected(10 + r, 10 + c);
      if (got !== want) assert.fail(`region[${r},${c}]: expected ${want}, got ${got}`);
    }
  }
  assert.ok(true, 'multi-chunk region exact (900 values)');
});

test('readRegion covering the full dataset returns every pixel', async () => {
  const region = await reader.readRegion(datasetId, 0, 0, ROWS, COLS);
  assert.equal(region.data.length, ROWS * COLS, 'full size');
  let mismatches = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (region.data[r * COLS + c] !== expected(r, c)) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `all ${ROWS * COLS} pixels exact`);
});

test('readRegion entirely outside the data returns null', async () => {
  const region = await reader.readRegion(datasetId, ROWS + 100, COLS + 100, 8, 8);
  assert.equal(region, null, 'no chunks found → null');
});

// ─── Superblock v0 fixture (default h5py settings) — W013 regression ────────

let readerV0;
let datasetIdV0;

test('v0 fixture: openH5ChunkFile parses a superblock v0 file', async () => {
  readerV0 = await openH5ChunkFile(loadFixture('synthetic-chunked-v0.h5'));
  assert.ok(readerV0, 'reader created');
  assert.equal(readerV0.superblock.version, 0, 'superblock version 0');
  readerV0.useWorkerPool = false; // no browser Worker API in Node
});

test('v0 fixture: dataset discovery via root symbol-table entry', async () => {
  datasetIdV0 = readerV0.findDatasetByPath(DATASET_PATH);
  assert.ok(datasetIdV0, `findDatasetByPath('${DATASET_PATH}') resolves`);

  const listed = readerV0.getDatasets().find(d => d.id === datasetIdV0);
  assert.ok(listed, 'dataset appears in getDatasets()');
  assert.deepEqual(Array.from(listed.shape), [ROWS, COLS], 'shape (64, 48)');
  assert.equal(listed.dtype, 'float32', 'dtype float32');
  assert.equal(listed.chunked, true, 'chunked layout');
  assert.deepEqual(Array.from(listed.chunkDims).slice(0, 2), [CHUNK, CHUNK], 'chunk dims (16, 16)');
});

test('v0 fixture: readChunk(0,0) values exact', async () => {
  const chunk = await readerV0.readChunk(datasetIdV0, 0, 0);
  assert.ok(chunk instanceof Float32Array, 'Float32Array returned');
  assert.equal(chunk.length, CHUNK * CHUNK, '16×16 values');
  for (let r = 0; r < CHUNK; r++) {
    for (let c = 0; c < CHUNK; c++) {
      const got = chunk[r * CHUNK + c];
      if (got !== expected(r, c)) {
        assert.fail(`v0 chunk(0,0)[${r},${c}]: expected ${expected(r, c)}, got ${got}`);
      }
    }
  }
  assert.ok(true, 'all v0 chunk(0,0) values exact');
});

test('v0 fixture: readChunk on the last chunk row/col works', async () => {
  const chunk = await readerV0.readChunk(datasetIdV0, 3, 2); // rows 48..63, cols 32..47
  assert.equal(chunk.length, CHUNK * CHUNK, 'edge chunk fully allocated');
  assert.equal(chunk[0], expected(48, 32), 'first value');
  assert.equal(chunk[CHUNK * CHUNK - 1], expected(63, 47), 'last value');
});

test('v0 fixture: readRegion crossing chunk boundaries stitches correctly', async () => {
  const region = await readerV0.readRegion(datasetIdV0, 10, 10, 30, 30);
  assert.equal(region.width, 30, 'width');
  assert.equal(region.height, 30, 'height');
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 30; c++) {
      const got = region.data[r * 30 + c];
      const want = expected(10 + r, 10 + c);
      if (got !== want) assert.fail(`v0 region[${r},${c}]: expected ${want}, got ${got}`);
    }
  }
  assert.ok(true, 'v0 multi-chunk region exact (900 values)');
});

test('v0 fixture: readRegion covering the full dataset returns every pixel', async () => {
  const region = await readerV0.readRegion(datasetIdV0, 0, 0, ROWS, COLS);
  assert.equal(region.data.length, ROWS * COLS, 'full size');
  let mismatches = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (region.data[r * COLS + c] !== expected(r, c)) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `all ${ROWS * COLS} pixels exact`);
});

await run();
