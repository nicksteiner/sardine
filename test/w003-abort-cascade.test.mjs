#!/usr/bin/env node

/**
 * W003 — Abort-cascade regression tests (RENDERING_PIPELINE_AUDIT §8 BUG 1 + BUG 3)
 *
 * BUG 1: deck.gl tile aborts must never cancel h5chunk chunk fetches. Chunk
 *        reads run to completion and warm the chunk cache; the tile-level
 *        signal is only a post-read CPU skip inside getTile.
 * BUG 3: aborted/failed fetches must not contribute throughput samples to the
 *        adaptive-concurrency estimator (a batch containing an AbortError
 *        would register as ~0 MB/s and falsely decay concurrency).
 *
 * Runs standalone under Node with a stubbed global fetch — no network, no data.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

const { H5Chunk } = await import(join(rootDir, 'src/loaders/h5chunk.js'));

// ─── Test fixtures ───────────────────────────────────────────────────────────

const CHUNK_DIMS = [4, 4];
const CHUNK_BYTES = CHUNK_DIMS[0] * CHUNK_DIMS[1] * 4; // 64 bytes, float32

/**
 * Build a minimal H5Chunk reader in URL-streaming mode with a synthetic
 * chunk index. `chunkOffsets` maps "row,col" (chunk indices) → file offset.
 */
function makeReader(chunkOffsets) {
  const reader = new H5Chunk();
  reader.url = 'https://example.com/fake.h5';
  reader.lazyTreeWalking = false;
  reader.useWorkerPool = false;
  const chunks = new Map();
  for (const [key, offset] of Object.entries(chunkOffsets)) {
    const [r, c] = key.split(',').map(Number);
    // B-tree keys are pixel offsets (chunkIndex * chunkDim)
    chunks.set(`${r * CHUNK_DIMS[0]},${c * CHUNK_DIMS[1]}`, {
      offset, size: CHUNK_BYTES, filterMask: 0,
    });
  }
  reader.datasets.set('/data', {
    path: '/data',
    shape: [64, 64],
    dtype: 'float32',
    bytesPerElement: 4,
    layout: { class: 2, chunkDims: CHUNK_DIMS },
    filters: null, // uncompressed → raw float32 decode path
    chunks,
  });
  return reader;
}

/**
 * Stub fetch that serves Range requests with float32 data filled with `fillValue`.
 * Honors opts.signal: throws AbortError if the signal is (or becomes) aborted.
 * Optional per-call hook can force failures or add latency.
 */
function makeStubFetch({ fillValue = 7, delayMs = 0, failRangeStart = null } = {}) {
  const calls = [];
  const stub = async (url, opts = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : 0;
    calls.push({ start, end, hadSignal: opts.signal !== undefined });

    if (opts.signal?.aborted) {
      const e = new Error('signal is aborted without reason');
      e.name = 'AbortError';
      throw e;
    }
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if (failRangeStart !== null && start === failRangeStart) {
      const e = new Error('signal is aborted without reason');
      e.name = 'AbortError';
      throw e;
    }
    const len = end - start + 1;
    const buf = new ArrayBuffer(len);
    new Float32Array(buf).fill(fillValue);
    return {
      ok: true,
      status: 206,
      arrayBuffer: async () => buf,
    };
  };
  stub.calls = calls;
  return stub;
}

const savedFetch = globalThis.fetch;

console.log('\n━━━ W003: abort cascade (BUG 1) ━━━');

// ─── BUG 1: chunk reads complete even in an aborted-tile context ─────────────

await check('readChunksBatch resolves chunk data when the tile signal is already aborted (signal not forwarded)', async () => {
  const reader = makeReader({ '0,0': 1000, '0,1': 1064 }); // adjacent → one merged range
  const stub = makeStubFetch({ fillValue: 7 });
  globalThis.fetch = stub;
  try {
    // Simulate the fixed getTile path: the deck.gl tile signal is aborted,
    // but getTile does NOT forward it into readChunksBatch.
    const tileController = new AbortController();
    tileController.abort();
    assert(tileController.signal.aborted, 'precondition: tile signal aborted');

    const results = await reader.readChunksBatch('/data', [[0, 0], [0, 1]]);
    assert(results.size === 2, `expected 2 chunks, got ${results.size}`);
    for (const [key, data] of results) {
      assert(data instanceof Float32Array, `chunk ${key} not decoded`);
      assert(data[0] === 7, `chunk ${key} has wrong data: ${data[0]}`);
    }
    assert(stub.calls.every(c => !c.hadSignal),
      'fetch received a signal — chunk reads must not be abortable from tile context');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

await check('nisar-loader URL getTile does not forward signal into readChunksBatch/readRegion (source check)', async () => {
  const src = readFileSync(join(rootDir, 'src/loaders/nisar-loader.js'), 'utf8');
  assert(!/readChunksBatch\([^)]*signal/.test(src),
    'readChunksBatch call forwards a signal');
  assert(!/readRegion\([^)]*\bsignal\b/.test(src),
    'readRegion call forwards a signal');
  // The tile-level cheap CPU skip must remain
  assert(/signal\?\.aborted/.test(src),
    'tile-level signal?.aborted check missing from getTile');
});

await check('SARViewer passes the deck.gl tile signal through to getTile', async () => {
  const src = readFileSync(join(rootDir, 'src/viewers/SARViewer.jsx'), 'utf8');
  assert(/const \{ bbox, signal \} = tile;/.test(src),
    'stableGetTileData does not extract signal from tile');
});

console.log('\n━━━ W003: adaptive concurrency (BUG 3) ━━━');

// ─── BUG 3: aborted/failed fetches excluded from throughput samples ──────────

await check('batch containing an AbortError records no throughput sample and does not decay concurrency', async () => {
  // Two chunks > 2MB apart → two merged ranges → two fetches in one batch.
  const reader = makeReader({ '0,0': 0, '1,0': 10_000_000 });
  reader._throughputSamples = [0.5, 0.5]; // near the 3-sample adaptation threshold
  const startConcurrency = reader._concurrency;
  // First range succeeds slowly (>0.1s so it WOULD be sampled), second aborts.
  globalThis.fetch = makeStubFetch({ delayMs: 150, failRangeStart: 10_000_000 });
  try {
    let threw = null;
    try {
      await reader.readChunksBatch('/data', [[0, 0], [1, 0]]);
    } catch (e) {
      threw = e;
    }
    assert(threw, 'readChunksBatch should rethrow the AbortError');
    assert(threw.name === 'AbortError', `expected AbortError, got ${threw.name}`);
    assert(reader._throughputSamples.length === 2,
      `failed batch contributed a throughput sample (${reader._throughputSamples.length} samples)`);
    assert(reader._concurrency === startConcurrency,
      `concurrency changed on aborted batch: ${startConcurrency} → ${reader._concurrency}`);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

await check('fully-completed batch still records a throughput sample (sampler not disabled)', async () => {
  const reader = makeReader({ '0,0': 0, '1,0': 10_000_000 });
  globalThis.fetch = makeStubFetch({ delayMs: 150 });
  try {
    const results = await reader.readChunksBatch('/data', [[0, 0], [1, 0]]);
    assert(results.size === 2, `expected 2 chunks, got ${results.size}`);
    assert(reader._throughputSamples.length === 1,
      `completed batch should record exactly 1 sample, got ${reader._throughputSamples.length}`);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`  W003 RESULTS: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60) + '\n');
process.exit(failed > 0 ? 1 : 0);
