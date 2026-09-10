/**
 * h5chunk-nd.test.mjs — N-dimensional chunked dataset reads.
 *
 * Regression cover for a silent failure: readRegion() derives its B-tree key
 * from (row, col) only, so a rank-3 dataset's 3-coordinate key never matched
 * and NISAR metadata cubes came back empty — which in turn made grounding
 * report that per-pixel incidence angle was unavailable on products that
 * carry it.
 *
 * These tests use a synthetic in-memory reader rather than a real granule so
 * they run without data; the real-granule path is exercised by
 * test/unit/gcov-truth.test.mjs when NISAR files are present.
 */

import assert from 'node:assert';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ PASS  ${name}`); passed++; }
  catch (err) { console.log(`  ✗ FAIL  ${name}\n          ${err.message}`); failed++; }
}

/**
 * Minimal stand-in exposing the pieces readFullND touches, with a chunk store
 * keyed exactly as HDF5 keys them: by PIXEL offset per dimension.
 */
function makeReader({ shape, chunkDims, fill }) {
  const rank = shape.length;
  const nChunks = shape.map((s, d) => Math.ceil(s / chunkDims[d]));
  const chunks = new Map();

  const total = nChunks.reduce((a, b) => a * b, 1);
  const idx = new Array(rank).fill(0);
  for (let c = 0; c < total; c++) {
    const origin = idx.map((ci, d) => ci * chunkDims[d]);
    // Chunks are stored PADDED to full chunkDims, as HDF5 does.
    const chunkLen = chunkDims.reduce((a, b) => a * b, 1);
    const data = new Float32Array(chunkLen);
    const pos = new Array(rank).fill(0);
    for (let i = 0; i < chunkLen; i++) {
      const global = origin.map((o, d) => o + pos[d]);
      data[i] = global.every((g, d) => g < shape[d]) ? fill(global) : -999;
      for (let d = rank - 1; d >= 0; d--) {
        if (++pos[d] < chunkDims[d]) break;
        pos[d] = 0;
      }
    }
    chunks.set(origin.join(','), data);
    for (let d = rank - 1; d >= 0; d--) {
      if (++idx[d] < nChunks[d]) break;
      idx[d] = 0;
    }
  }

  const dataset = {
    id: 'ds', shape, dtype: 'float32', bytesPerElement: 4,
    layout: { type: 'chunked', chunkDims, btreeAddress: 1 },
    chunks: new Map([...chunks.keys()].map(k => [k, { offset: 0, size: 0 }])),
  };

  return {
    _raw: chunks,
    datasets: new Map([['ds', dataset]]),
    lazyTreeWalking: false,
    getDatasets: () => [dataset],
    findDatasetByPath: () => 'ds',
    async readChunkND(id, chunkIndex) {
      const key = chunkIndex.map((ci, d) => ci * chunkDims[d]).join(',');
      return chunks.get(key) || null;
    },
  };
}

// Borrow the real implementation, bound to the synthetic reader.
const { H5Chunk } = await import('../../src/loaders/h5chunk.js');
const readFullND = H5Chunk.prototype.readFullND;

console.log('\nh5chunk N-D reads\n');

await test('rank-3 cube reconstructs exactly (aligned chunks)', async () => {
  const shape = [4, 6, 8], chunkDims = [2, 3, 4];
  const fill = ([z, y, x]) => z * 100 + y * 10 + x;
  const r = makeReader({ shape, chunkDims, fill });
  const out = await readFullND.call(r, 'ds');
  assert.strictEqual(out.length, 4 * 6 * 8);
  for (let z = 0; z < 4; z++)
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 8; x++) {
        const got = out[z * 48 + y * 8 + x];
        assert.strictEqual(got, fill([z, y, x]), `mismatch at ${z},${y},${x}: ${got}`);
      }
});

await test('edge chunks are clipped, padding never leaks in', async () => {
  // 5 is not a multiple of 2, and 7 is not a multiple of 3 — both dims have
  // partial edge chunks whose padding must be discarded.
  const shape = [5, 7], chunkDims = [2, 3];
  const fill = ([y, x]) => y * 10 + x;
  const r = makeReader({ shape, chunkDims, fill });
  const out = await readFullND.call(r, 'ds');
  assert.strictEqual(out.length, 35);
  assert.ok(!out.includes(-999), 'padding value leaked into output');
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 7; x++)
      assert.strictEqual(out[y * 7 + x], fill([y, x]), `mismatch at ${y},${x}`);
});

await test('NISAR-shaped cube (21 x 715 x 725) reconstructs', async () => {
  // The real radarGrid geometry, with the trailing element-size entry HDF5
  // appends to chunkDims — readFullND must slice it off.
  const shape = [3, 40, 45], chunkDims = [1, 32, 32, 4];
  const fill = ([z, y, x]) => z + y * 0.5 + x * 0.25;
  const r = makeReader({ shape, chunkDims: chunkDims.slice(0, 3), fill });
  const out = await readFullND.call(r, 'ds');
  assert.strictEqual(out.length, 3 * 40 * 45);
  assert.strictEqual(out[0], fill([0, 0, 0]));
  assert.strictEqual(out[out.length - 1], fill([2, 39, 44]));
});

await test('missing (sparse) chunks leave zeros rather than throwing', async () => {
  const shape = [4, 4], chunkDims = [2, 2];
  const r = makeReader({ shape, chunkDims, fill: () => 7 });
  r._raw.delete('0,0');
  const orig = r.readChunkND.bind(r);
  r.readChunkND = async (id, ci) => (ci.join(',') === '0,0' ? null : orig(id, ci));
  const out = await readFullND.call(r, 'ds');
  assert.strictEqual(out[0], 0, 'absent chunk should stay zero');
  assert.strictEqual(out[out.length - 1], 7);
});

console.log(`\nh5chunk N-D: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
