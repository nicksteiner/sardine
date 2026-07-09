#!/usr/bin/env node

/**
 * W006 — Decode worker pool tests
 *
 * Workers are unavailable under Node (no global Worker), so these tests
 * exercise the pool's synchronous main-thread fallback and prove it is
 * bit-exact with inline pako inflate + unshuffle. Also covers:
 *   - dtype decode paths (float32/float64/float16/int16/uint8/cfloat32)
 *   - heuristic fallbackFilters retry
 *   - pool cap = min(4, hardwareConcurrency) and lazy spawn (0 workers)
 *   - H5Chunk end-to-end: readChunk/readChunksBatch decode compressed chunks
 *     correctly in Node with the DEFAULT useWorkerPool=true (regression:
 *     the old pool returned silent empty chunks when Worker was undefined)
 *   - readChunksBatch result Map iteration order matches request order
 *
 * Runs standalone under Node with a stubbed global fetch — no network, no data.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pako from 'pako';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const { DecodePool, getDecodePool, getWorkerPoolInfo } =
  await import(join(rootDir, 'src/loaders/decode-pool.js'));
const { decodeChunkSync, unshuffle, FILTER_DEFLATE, FILTER_SHUFFLE } =
  await import(join(rootDir, 'src/loaders/decode-core.js'));
const { H5Chunk } = await import(join(rootDir, 'src/loaders/h5chunk.js'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** HDF5 shuffle filter (forward direction, as applied at write time). */
function shuffleForward(bytes, elementSize) {
  const count = bytes.length / elementSize;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < elementSize; j++) {
      out[j * count + i] = bytes[i * elementSize + j];
    }
  }
  return out;
}

/** Synthetic float32 payload with awkward values (NaN, ±0, Inf, denormal-ish). */
function makeFloats(n, seed = 1) {
  const f = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 16807) % 2147483647;
    f[i] = (x / 2147483647) * 2000 - 1000;
  }
  f[0] = NaN;
  f[1] = 0;
  f[2] = -0;
  f[3] = Infinity;
  f[4] = -Infinity;
  f[5] = 1.1754944e-38;
  return f;
}

const SHUFFLE_DEFLATE = [{ id: FILTER_SHUFFLE, params: [4] }, { id: FILTER_DEFLATE }];
const DEFLATE_ONLY = [{ id: FILTER_DEFLATE }];

/** Compress float32 payload the way HDF5 shuffle+deflate stores it. */
function compressShuffleDeflate(floats) {
  const raw = new Uint8Array(floats.buffer.slice(0));
  return pako.deflate(shuffleForward(raw, 4));
}

function bytesEqual(a, b) {
  const ua = new Uint8Array(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength);
  const ub = new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

// ─── Tests: environment + pool shape ─────────────────────────────────────────

console.log('\nW006 decode pool — Node fallback + bit-exactness\n');
console.log('Pool shape:');

await check('Node has no global Worker (fallback path is what we test)', () => {
  assert(typeof Worker === 'undefined', 'expected no Worker global under Node');
});

await check('pool caps at min(4, hardwareConcurrency)', () => {
  const pool = new DecodePool();
  assert(pool.maxWorkers >= 1 && pool.maxWorkers <= 4,
    `maxWorkers ${pool.maxWorkers} outside [1,4]`);
});

await check('pool is lazy: constructing it spawns no workers', () => {
  const pool = new DecodePool();
  assert(pool.spawnedCount() === 0, `spawned ${pool.spawnedCount()} workers at construction`);
});

await check('getWorkerPoolInfo() reports size/cores and unsupported Workers', () => {
  const info = getWorkerPoolInfo();
  assert(info.size >= 1, 'size < 1');
  assert(info.cores >= 1, 'cores < 1');
  assert(info.spawned === 0, 'lazy pool should have 0 spawned workers');
  assert(info.workersSupported === false, 'Workers should be unsupported under Node');
});

await check('resize clamps to [1,32] and keeps working', async () => {
  const pool = new DecodePool();
  pool.resize(0);
  assert(pool.maxWorkers === 1, `resize(0) → ${pool.maxWorkers}, expected 1`);
  pool.resize(100);
  assert(pool.maxWorkers === 32, `resize(100) → ${pool.maxWorkers}, expected 32`);
});

// ─── Tests: bit-exact fallback decode ────────────────────────────────────────

console.log('\nBit-exact fallback (vs inline pako):');

const floats = makeFloats(1024);
const originalBytes = new Uint8Array(floats.buffer.slice(0));
const compressed = compressShuffleDeflate(floats);

// Inline pako reference: inflate → unshuffle → Float32Array
const referenceBytes = unshuffle(pako.inflate(compressed), 4);
const reference = new Float32Array(referenceBytes.buffer);

await check('inline pako reference round-trips the original bytes', () => {
  assert(bytesEqual(referenceBytes, originalBytes), 'pako reference != original');
});

await check('decodeChunkSync(shuffle+deflate) is bit-exact with pako inline', () => {
  const out = decodeChunkSync(compressed.buffer.slice(0), SHUFFLE_DEFLATE, 'float32');
  assert(out instanceof Float32Array, 'not a Float32Array');
  assert(bytesEqual(out, reference), 'decodeChunkSync != pako inline reference');
  assert(bytesEqual(out, originalBytes), 'decodeChunkSync != original payload');
});

await check('pool.decode() falls back to sync decode, bit-exact', async () => {
  const pool = getDecodePool();
  const out = await pool.decode({
    buffer: compressed.buffer.slice(0),
    filters: SHUFFLE_DEFLATE,
    dtype: 'float32',
  });
  assert(out instanceof Float32Array, 'not a Float32Array');
  assert(bytesEqual(out, originalBytes), 'pool fallback != original payload');
});

await check('pool.decode({sync: true}) forces the same bit-exact path', async () => {
  const out = await getDecodePool().decode({
    buffer: compressed.buffer.slice(0),
    filters: SHUFFLE_DEFLATE,
    dtype: 'float32',
    sync: true,
  });
  assert(bytesEqual(out, originalBytes), 'sync-forced decode != original payload');
});

await check('deflate-only pipeline decodes bit-exact', async () => {
  const deflateOnly = pako.deflate(originalBytes);
  const out = await getDecodePool().decode({
    buffer: deflateOnly.buffer.slice(0),
    filters: DEFLATE_ONLY,
    dtype: 'float32',
  });
  assert(bytesEqual(out, originalBytes), 'deflate-only decode != original payload');
});

await check('fallbackFilters retry: primary pipeline throws, fallback succeeds', async () => {
  // Raw shuffled bytes (NOT zlib) — [deflate] throws, fallback [shuffle] works
  const rawShuffled = shuffleForward(originalBytes, 4);
  const out = await getDecodePool().decode({
    buffer: rawShuffled.buffer.slice(0),
    filters: DEFLATE_ONLY,
    dtype: 'float32',
    fallbackFilters: [{ id: FILTER_SHUFFLE, params: [4] }],
  });
  assert(bytesEqual(out, originalBytes), 'fallback pipeline result != original payload');
});

await check('corrupt data with no fallback rejects (does not hang)', async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let rejected = false;
  try {
    await getDecodePool().decode({
      buffer: garbage.buffer.slice(0),
      filters: DEFLATE_ONLY,
      dtype: 'float32',
    });
  } catch (e) {
    rejected = true;
  }
  assert(rejected, 'expected rejection for corrupt deflate stream');
});

// ─── Tests: dtype decode paths ───────────────────────────────────────────────

console.log('\nDtype decode paths (via deflate pipeline):');

await check('float64 → float32', () => {
  const f64 = new Float64Array([1.5, -2.25, NaN, 0, 3.75e10]);
  const out = decodeChunkSync(
    pako.deflate(new Uint8Array(f64.buffer)).buffer, DEFLATE_ONLY, 'float64');
  const expect = new Float32Array(f64);
  assert(bytesEqual(out, expect), 'float64 decode mismatch');
});

await check('int16 → float32', () => {
  const i16 = new Int16Array([-32768, -1, 0, 1, 32767]);
  const out = decodeChunkSync(
    pako.deflate(new Uint8Array(i16.buffer)).buffer, DEFLATE_ONLY, 'int16');
  const expect = new Float32Array(i16);
  assert(bytesEqual(out, expect), 'int16 decode mismatch');
});

await check('uint8 → float32', () => {
  const u8 = new Uint8Array([0, 1, 127, 255]);
  const out = decodeChunkSync(pako.deflate(u8).buffer, DEFLATE_ONLY, 'uint8');
  const expect = new Float32Array(u8);
  assert(bytesEqual(out, expect), 'uint8 decode mismatch');
});

await check('float16 → float32', () => {
  // 0x3C00=1.0, 0xC000=-2.0, 0x7C00=+Inf, 0x0000=0, 0x3555≈0.333252
  const h = new Uint16Array([0x3C00, 0xC000, 0x7C00, 0x0000, 0x3555]);
  const out = decodeChunkSync(
    pako.deflate(new Uint8Array(h.buffer)).buffer, DEFLATE_ONLY, 'float16');
  assert(out[0] === 1.0 && out[1] === -2.0 && out[2] === Infinity && out[3] === 0,
    `float16 decode wrong: ${Array.from(out)}`);
  assert(Math.abs(out[4] - 0.333251953125) < 1e-9, `float16 frac wrong: ${out[4]}`);
});

await check('cfloat32 stays interleaved float32 pairs', () => {
  const c = new Float32Array([1, -1, 2.5, -2.5]); // 2 complex pixels
  const out = decodeChunkSync(
    pako.deflate(new Uint8Array(c.buffer)).buffer, DEFLATE_ONLY, 'cfloat32');
  assert(bytesEqual(out, c), 'cfloat32 decode mismatch');
});

// ─── Tests: H5Chunk integration (Node, default useWorkerPool=true) ──────────

console.log('\nH5Chunk integration (stubbed fetch, compressed chunks):');

const CHUNK_DIMS = [4, 4];
const CHUNK_VALUES = CHUNK_DIMS[0] * CHUNK_DIMS[1];

/**
 * Build a virtual HDF5 "file": per-chunk float32 payloads (fill = 100*r + c),
 * shuffle+deflate compressed, concatenated. Returns reader + expected values.
 */
function makeCompressedReader(coordsList) {
  const reader = new H5Chunk();
  reader.url = 'https://example.com/fake.h5';
  reader.lazyTreeWalking = false;
  // NOTE: useWorkerPool stays TRUE (default) — under Node the pool must
  // transparently fall back to sync decode instead of returning empty chunks.

  const chunks = new Map();
  const parts = [];
  const expected = new Map();
  let offset = 0;
  for (const [r, c] of coordsList) {
    const fill = 100 * r + c + 1;
    const payload = new Float32Array(CHUNK_VALUES).fill(fill);
    payload[0] = fill + 0.5; // non-uniform so shuffle actually matters
    const comp = compressShuffleDeflate(payload);
    chunks.set(`${r * CHUNK_DIMS[0]},${c * CHUNK_DIMS[1]}`, {
      offset, size: comp.byteLength, filterMask: 0,
    });
    parts.push(comp);
    expected.set(`${r},${c}`, payload);
    offset += comp.byteLength;
  }
  const virtualFile = new Uint8Array(offset);
  let pos = 0;
  for (const p of parts) { virtualFile.set(p, pos); pos += p.byteLength; }

  reader.datasets.set('/data', {
    path: '/data',
    shape: [64, 64],
    dtype: 'float32',
    bytesPerElement: 4,
    layout: { class: 2, chunkDims: CHUNK_DIMS },
    filters: SHUFFLE_DEFLATE, // known pipeline, filterMask 0
    chunks,
  });
  return { reader, virtualFile, expected };
}

function installStubFetch(virtualFile) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : virtualFile.byteLength - 1;
    const body = virtualFile.slice(start, Math.min(end + 1, virtualFile.byteLength));
    return {
      ok: true, status: 206,
      arrayBuffer: async () => body.buffer,
    };
  };
  return () => { globalThis.fetch = orig; };
}

await check('readChunk decodes a compressed chunk under Node (useWorkerPool=true)', async () => {
  const { reader, virtualFile, expected } = makeCompressedReader([[0, 0]]);
  const restore = installStubFetch(virtualFile);
  try {
    const data = await reader.readChunk('/data', 0, 0);
    assert(data instanceof Float32Array, 'not a Float32Array');
    assert(bytesEqual(data, expected.get('0,0')), 'decoded chunk != payload (silent empty chunk regression?)');
  } finally { restore(); }
});

await check('readChunksBatch decodes all chunks bit-exact', async () => {
  const coords = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 3]];
  const { reader, virtualFile, expected } = makeCompressedReader(coords);
  const restore = installStubFetch(virtualFile);
  try {
    const results = await reader.readChunksBatch('/data', coords);
    for (const [r, c] of coords) {
      const key = `${r},${c}`;
      assert(results.get(key) && bytesEqual(results.get(key), expected.get(key)),
        `chunk ${key} mismatch`);
    }
  } finally { restore(); }
});

await check('readChunksBatch preserves request order in the results Map', async () => {
  // Scrambled request order + one sparse chunk (5,5 has no B-tree entry)
  const stored = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const requested = [[1, 1], [0, 0], [5, 5], [1, 0], [0, 1]];
  const { reader, virtualFile, expected } = makeCompressedReader(stored);
  const restore = installStubFetch(virtualFile);
  try {
    const results = await reader.readChunksBatch('/data', requested);
    const keys = [...results.keys()];
    const expectKeys = requested.map(([r, c]) => `${r},${c}`);
    assert(JSON.stringify(keys) === JSON.stringify(expectKeys),
      `Map order ${keys} != request order ${expectKeys}`);
    assert(results.get('5,5') === null, 'sparse chunk should be null');
    for (const [r, c] of stored) {
      assert(bytesEqual(results.get(`${r},${c}`), expected.get(`${r},${c}`)),
        `chunk ${r},${c} mismatch`);
    }
  } finally { restore(); }
});

await check('corrupt compressed chunk yields empty (zero) chunk, not a crash', async () => {
  const { reader, expected } = makeCompressedReader([[0, 0]]);
  void expected;
  const garbage = new Uint8Array(24).fill(9); // not zlib
  reader.datasets.get('/data').chunks.set('0,0', {
    offset: 0, size: garbage.byteLength, filterMask: 0,
  });
  const restore = installStubFetch(garbage);
  try {
    const data = await reader.readChunk('/data', 0, 0);
    assert(data instanceof Float32Array, 'not a Float32Array');
    assert(data.length === CHUNK_VALUES, `length ${data.length} != ${CHUNK_VALUES}`);
    assert(data.every(v => v === 0), 'empty chunk should be all zeros');
  } finally { restore(); }
});

await check('useWorkerPool=false still decodes identically (w003 test path)', async () => {
  const { reader, virtualFile, expected } = makeCompressedReader([[0, 0]]);
  reader.useWorkerPool = false;
  const restore = installStubFetch(virtualFile);
  try {
    const data = await reader.readChunk('/data', 0, 0);
    assert(bytesEqual(data, expected.get('0,0')), 'sync-forced decode mismatch');
  } finally { restore(); }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
