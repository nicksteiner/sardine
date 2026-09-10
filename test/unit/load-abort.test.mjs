/**
 * load-abort.test.mjs — W030: cancelling a load actually stops the transfer.
 *
 * The risk this file guards is stated in the work order: "an abort that only
 * flips a UI flag while the transfer continues is worse than none — it lies."
 * So every assertion here is about I/O *stopping*, never about a promise
 * settling: range reads (HTTP) and file slices (local) must cease being issued
 * once the user cancels.
 *
 * The cancel signal is LOAD-scoped and reaches h5chunk. It is deliberately NOT
 * the per-tile deck.gl signal, which W003 established must never be forwarded
 * into readChunksBatch (test/w003-abort-cascade.test.mjs guards that side; the
 * last test here guards that the two channels stayed separate).
 *
 * Run: node test/unit/load-abort.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { H5Chunk } from '../../src/loaders/h5chunk.js';
import { loadNISARGCOV } from '../../src/loaders/nisar-loader.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('W030 load cancellation');

const STREAMING_THRESHOLD = 500 * 1024 * 1024;
const FIXTURE = 'synthetic-gcov.h5';

// ─── Synthetic URL-mode reader (same shape as the W003 regression fixture) ───

const CHUNK_DIMS = [4, 4];
const CHUNK_BYTES = CHUNK_DIMS[0] * CHUNK_DIMS[1] * 4; // 64 bytes, float32

function makeReader(chunkOffsets) {
  const reader = new H5Chunk();
  reader.url = 'https://example.com/fake.h5';
  reader.lazyTreeWalking = false;
  reader.useWorkerPool = false;
  reader._concurrency = 1; // one merged range per wave → deterministic waves
  const chunks = new Map();
  for (const [key, offset] of Object.entries(chunkOffsets)) {
    const [r, c] = key.split(',').map(Number);
    chunks.set(`${r * CHUNK_DIMS[0]},${c * CHUNK_DIMS[1]}`, {
      offset, size: CHUNK_BYTES, filterMask: 0,
    });
  }
  reader.datasets.set('/data', {
    path: '/data', shape: [64, 64], dtype: 'float32', bytesPerElement: 4,
    layout: { class: 2, chunkDims: CHUNK_DIMS },
    filters: null, chunks,
  });
  return reader;
}

/** Range-serving fetch stub that records every request it is asked to make. */
function makeStubFetch(onCall) {
  const calls = [];
  const stub = async (url, opts = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : 0;
    calls.push({ start, end, hadSignal: opts.signal !== undefined });
    if (opts.signal?.aborted) {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (onCall) await onCall(calls.length);
    const len = end - start + 1;
    const buf = new ArrayBuffer(len);
    new Float32Array(buf).fill(1);
    return { ok: true, status: 206, arrayBuffer: async () => buf };
  };
  stub.calls = calls;
  return stub;
}

/** Chunks 4 MB apart never merge, so each becomes its own range read. */
function spreadOffsets(n) {
  const out = {};
  for (let i = 0; i < n; i++) out[`${i},0`] = i * 4_000_000;
  return out;
}

const savedFetch = globalThis.fetch;

test('aborting mid-load stops further range reads (HTTP path)', async () => {
  const reader = makeReader(spreadOffsets(10));
  const controller = new AbortController();
  const stub = makeStubFetch((n) => { if (n === 2) controller.abort(); });
  globalThis.fetch = stub;
  try {
    reader.setLoadSignal(controller.signal);
    let threw = null;
    try {
      await reader.readChunksBatch('/data', Array.from({ length: 10 }, (_, i) => [i, 0]));
    } catch (e) { threw = e; }
    assert(threw, 'a cancelled batch must reject, not resolve partial data');
    assert(threw.name === 'AbortError', `expected AbortError, got ${threw.name}`);
    // 10 chunks were requested; the cancel landed on the 2nd. If the transfer
    // had continued regardless, all 10 range reads would be on record.
    assert(stub.calls.length < 10,
      `all ${stub.calls.length} range reads were issued after cancel — the abort did not stop the transfer`);
    assert(stub.calls.length <= 3,
      `expected the read stream to stop within a wave of the cancel, got ${stub.calls.length} reads`);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('a pre-aborted load issues no range reads at all', async () => {
  const reader = makeReader(spreadOffsets(6));
  const controller = new AbortController();
  controller.abort();
  const stub = makeStubFetch();
  globalThis.fetch = stub;
  try {
    reader.setLoadSignal(controller.signal);
    let threw = null;
    try {
      await reader.readChunksBatch('/data', Array.from({ length: 6 }, (_, i) => [i, 0]));
    } catch (e) { threw = e; }
    assert(threw?.name === 'AbortError', `expected AbortError, got ${threw && threw.name}`);
    assert(stub.calls.length === 0,
      `${stub.calls.length} range reads were issued for an already-cancelled load`);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('the load signal is forwarded to fetch so an in-flight body is torn down', async () => {
  const reader = makeReader(spreadOffsets(2));
  const controller = new AbortController();
  const stub = makeStubFetch();
  globalThis.fetch = stub;
  try {
    reader.setLoadSignal(controller.signal);
    await reader.readChunksBatch('/data', [[0, 0], [1, 0]]);
    assert(stub.calls.length === 2, `expected 2 range reads, got ${stub.calls.length}`);
    assert(stub.calls.every(c => c.hadSignal),
      'a load-scoped cancel must reach fetch(); checking after the bytes arrive is too late');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('W003 boundary: with no load signal, chunk reads stay unabortable', async () => {
  // The per-tile deck.gl signal must never end up here. A reader with no
  // load-scoped signal must issue plain, signal-free fetches exactly as before.
  const reader = makeReader(spreadOffsets(2));
  const stub = makeStubFetch();
  globalThis.fetch = stub;
  try {
    const tileController = new AbortController();
    tileController.abort();
    const results = await reader.readChunksBatch('/data', [[0, 0], [1, 0]]);
    assert(results.size === 2, `expected 2 chunks, got ${results.size}`);
    assert(stub.calls.every(c => !c.hadSignal),
      'chunk reads became abortable without a load-scoped signal — the two signals have been conflated');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ─── Local file path: the "drop a 1 GB GCOV, then cancel" flow ───────────────

/** MockFile that counts slice() calls — the local analogue of a range read. */
class CountingMockFile {
  constructor(arrayBuffer, name, reportedSize) {
    this._buffer = arrayBuffer;
    this.name = name;
    this.size = reportedSize;
    this.sliceCount = 0;
  }
  slice(start, end) {
    this.sliceCount++;
    const sliced = this._buffer.slice(start, end);
    return { arrayBuffer: () => Promise.resolve(sliced) };
  }
}

function loadFixtureFile() {
  const buf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', FIXTURE));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new CountingMockFile(ab, FIXTURE, STREAMING_THRESHOLD + 1);
}

test('loadNISARGCOV rejects with AbortError when cancelled during the chunk stream', async () => {
  const file = loadFixtureFile();
  const controller = new AbortController();
  let countAtAbort = null;
  let threw = null;
  try {
    await loadNISARGCOV(file, {
      frequency: 'A', polarization: 'HHHH',
      signal: controller.signal,
      onProgress: (pct, detail) => {
        // Cancel as soon as the load is genuinely streaming chunks.
        if (detail.phase === 'chunks' && detail.chunksDone >= 1 && countAtAbort === null) {
          countAtAbort = file.sliceCount;
          controller.abort();
        }
      },
    });
  } catch (e) { threw = e; }
  assert(countAtAbort !== null, 'the load never reached the chunk phase — test is not exercising cancel');
  assert(threw, 'a cancelled load must reject rather than return a half-loaded scene');
  assert(threw.name === 'AbortError', `expected AbortError, got ${threw.name}: ${threw.message}`);
  // 64 chunks in the fixture; the semaphore admits 16 at a time. If cancelling
  // did nothing, every one of them would have been sliced off the file.
  assert(file.sliceCount < 64,
    `all ${file.sliceCount} chunk reads ran after cancel — the abort did not stop the read stream`);
});

test('a load cancelled before it starts reads nothing', async () => {
  const file = loadFixtureFile();
  const controller = new AbortController();
  controller.abort();
  let threw = null;
  try {
    await loadNISARGCOV(file, { frequency: 'A', polarization: 'HHHH', signal: controller.signal });
  } catch (e) { threw = e; }
  assert(threw?.name === 'AbortError', `expected AbortError, got ${threw && threw.name}`);
  assert(file.sliceCount === 0,
    `${file.sliceCount} reads were issued for an already-cancelled load`);
});

await run();
