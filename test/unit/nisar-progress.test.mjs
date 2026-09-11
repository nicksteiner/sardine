/**
 * nisar-progress.test.mjs — W030: loadNISARGCOV reports real per-chunk load
 * progress.
 *
 * Before W030 the NISAR path — the longest operation in the app — reported a
 * bare `loading` boolean while COG/TIF/NITF all had determinate bars. These
 * tests pin the replacement: an `onProgress(pct, detail)` callback (the same
 * convention the COG/TIF/NITF loaders use) driven by chunk-decode completion
 * inside h5chunk, not by a timer.
 *
 * Fixture: test/unit/fixtures/synthetic-gcov.h5 (~48 KB, committed; see
 * fixtures/generate-synthetic-gcov.py) — a spec-shaped miniature GCOV with
 * /science/LSAR/GCOV/grids/frequencyA/HHHH at 256×256 in 32×32 chunks
 * (64 chunks, gzip+shuffle). The MockFile reports a size above the 500 MB
 * streaming threshold so loadNISARGCOV takes the h5chunk streaming path — the
 * one a dropped 1 GB granule takes.
 *
 * Run: node test/unit/nisar-progress.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNISARGCOV } from '../../src/loaders/nisar-loader.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('W030 NISAR load progress');

const FIXTURE = 'synthetic-gcov.h5';
const STREAMING_THRESHOLD = 500 * 1024 * 1024;

/** Browser File stand-in whose reported size forces the streaming path. */
class MockFile {
  constructor(arrayBuffer, name, reportedSize) {
    this._buffer = arrayBuffer;
    this.name = name;
    this.size = reportedSize ?? arrayBuffer.byteLength;
  }
  slice(start, end) {
    const sliced = this._buffer.slice(start, end);
    return { arrayBuffer: () => Promise.resolve(sliced) };
  }
}

function loadFixture(reportedSize) {
  const buf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', FIXTURE));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new MockFile(ab, FIXTURE, reportedSize);
}

/** Run a streaming load, collecting every progress report. */
async function loadWithProgress(extraOptions = {}) {
  const calls = [];
  const data = await loadNISARGCOV(loadFixture(STREAMING_THRESHOLD + 1), {
    frequency: 'A',
    polarization: 'HHHH',
    onProgress: (pct, detail) => calls.push({ pct, detail }),
    ...extraOptions,
  });
  return { data, calls };
}

let loaded;

test('loadNISARGCOV accepts onProgress and still returns a usable scene', async () => {
  loaded = await loadWithProgress();
  assert(loaded.data, 'loader returned nothing');
  assert(loaded.data.width === 256 && loaded.data.height === 256,
    `unexpected scene size ${loaded.data.width}×${loaded.data.height}`);
  assert(typeof loaded.data.getTile === 'function', 'no getTile on the result');
});

test('onProgress is called more than a trivial number of times', () => {
  // A binary spinner is two calls. Per-chunk reporting on a 64-chunk grid is
  // an order of magnitude more — this is the whole point of the change.
  assert(loaded.calls.length >= 10,
    `expected >=10 progress calls, got ${loaded.calls.length}`);
});

test('progress is monotonic non-decreasing and ends at 100', () => {
  let prev = -1;
  for (const { pct } of loaded.calls) {
    assert(typeof pct === 'number' && Number.isFinite(pct), `non-numeric pct: ${pct}`);
    assert(pct >= 0 && pct <= 100, `pct out of range: ${pct}`);
    assert(pct >= prev, `progress went backwards: ${prev} → ${pct}`);
    prev = pct;
  }
  assert(prev === 100, `load did not finish at 100 (last was ${prev})`);
});

test('progress covers a real span, not a single jump', () => {
  const intermediate = loaded.calls.filter(c => c.pct > 15 && c.pct < 100);
  assert(intermediate.length >= 5,
    `expected >=5 intermediate reports between phases, got ${intermediate.length}`);
});

test('detail carries real chunk counts and byte totals', () => {
  const last = loaded.calls[loaded.calls.length - 1].detail;
  assert(last.chunksTotal > 1, `chunksTotal not per-chunk: ${last.chunksTotal}`);
  assert(last.chunksDone === last.chunksTotal,
    `finished with ${last.chunksDone}/${last.chunksTotal} chunks`);
  assert(last.bytes > 0, `no bytes reported (${last.bytes})`);
  // The chunk stream must be what moved the bar, not the fixed phase budget.
  const chunkReports = loaded.calls.filter(c => c.detail.phase === 'chunks');
  assert(chunkReports.length >= 10,
    `expected >=10 reports from the chunk phase, got ${chunkReports.length}`);
});

test('chunk counts are themselves monotonic (each report is one more chunk)', () => {
  let prevDone = -1;
  for (const { detail } of loaded.calls) {
    assert(detail.chunksDone >= prevDone,
      `chunksDone went backwards: ${prevDone} → ${detail.chunksDone}`);
    prevDone = detail.chunksDone;
  }
  assert(prevDone >= 10, `only ${prevDone} chunks were reported`);
});

test('phases are reported in order and never regress', () => {
  const order = ['opening', 'metadata', 'index', 'chunks', 'done'];
  let prevIdx = -1;
  for (const { detail } of loaded.calls) {
    const idx = order.indexOf(detail.phase);
    assert(idx >= 0, `unknown phase: ${detail.phase}`);
    assert(idx >= prevIdx, `phase regressed: ${order[prevIdx]} → ${detail.phase}`);
    prevIdx = idx;
  }
  assert(prevIdx === order.length - 1, 'load never reached the done phase');
});

test('a load without onProgress still works (callback is optional)', async () => {
  const data = await loadNISARGCOV(loadFixture(STREAMING_THRESHOLD + 1), {
    frequency: 'A', polarization: 'HHHH',
  });
  assert(data.width === 256, 'load without onProgress produced no scene');
});

await run();
