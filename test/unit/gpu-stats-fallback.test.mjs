/**
 * gpu-stats-fallback.test.mjs — W007: CPU-fallback equivalence for gpu-stats.
 *
 * In Node there is no WebGPU (`navigator.gpu` is undefined), so the
 * gpu-stats "Auto" wrappers must delegate to the CPU implementations in
 * src/utils/stats.js and return identical results:
 *
 *   computeChannelStatsAuto(...)  ≡ computeChannelStats(...)
 *   sampleViewportStatsAuto(...)  ≡ sampleViewportStats(...)
 *
 * Run: node test/unit/gpu-stats-fallback.test.mjs
 */

import {
  computeChannelStats,
  sampleViewportStats,
} from '../../src/utils/stats.js';
import {
  computeChannelStatsAuto,
  sampleViewportStatsAuto,
  canUseGPUStats,
} from '../../src/gpu/gpu-stats.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('gpu-stats fallback');

// ─── environment guard ──────────────────────────────────────────────────────
// Every equivalence assertion below assumes the CPU fallback path is taken.

test('WebGPU is unavailable in Node (fallback path active)', () => {
  assert.equal(canUseGPUStats(), false, 'canUseGPUStats() must be false in Node');
});

// ─── computeChannelStatsAuto ≡ computeChannelStats ───────────────────────────

test('computeChannelStatsAuto (linear, mixed nodata): identical to CPU', async () => {
  const data = [10, 20, 30, 40, 0, NaN];
  const gpu = await computeChannelStatsAuto(data, false, 128);
  const cpu = computeChannelStats(data, false, 128);
  assert.deepEqual(gpu, cpu, 'full result object matches');
});

test('computeChannelStatsAuto (dB): identical to CPU', async () => {
  const data = [0.01, 1, 100, 0, -5, NaN]; // -20, 0, +20 dB; rest dropped
  const gpu = await computeChannelStatsAuto(data, true, 128);
  const cpu = computeChannelStats(data, true, 128);
  assert.deepEqual(gpu, cpu, 'full result object matches');
});

test('computeChannelStatsAuto (large ramp, custom bins + stride): identical to CPU', async () => {
  const n = 10000;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = i + 1; // 1..10000
  const gpu = await computeChannelStatsAuto(data, false, 64, 3);
  const cpu = computeChannelStats(data, false, 64, 3);
  assert.deepEqual(gpu, cpu, 'binned histogram, percentiles, and stride match');
});

test('computeChannelStatsAuto (speckle-like data with nodata holes): identical to CPU', async () => {
  // Deterministic LCG-driven pseudo-exponential values with 0/NaN sprinkled in
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const n = 50000;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = rand();
    if (i % 97 === 0) data[i] = 0;
    else if (i % 131 === 0) data[i] = NaN;
    else data[i] = -Math.log(1 - u) * 0.05; // exponential, SAR-power-like
  }
  const gpu = await computeChannelStatsAuto(data, true, 128);
  const cpu = computeChannelStats(data, true, 128);
  assert.deepEqual(gpu, cpu, 'dB stats on speckle-like data match');
});

test('computeChannelStatsAuto: all-nodata input returns null on both paths', async () => {
  assert.equal(await computeChannelStatsAuto([0, NaN, 0], false), null, 'null on empty');
  assert.equal(computeChannelStats([0, NaN, 0], false), null, 'CPU null on empty');
});

// ─── sampleViewportStatsAuto ≡ sampleViewportStats ───────────────────────────

/**
 * Deterministic mock tile fetcher: each (x, y) tile is a Float32Array of
 * `tileLen` LCG-driven values with 0/NaN nodata mixed in. Optionally rejects
 * one tile to exercise the Promise.allSettled path.
 */
function makeMockGetTile(tileLen, { rejectTile = null } = {}) {
  return async ({ x, y }) => {
    if (rejectTile && rejectTile.x === x && rejectTile.y === y) {
      throw new Error('mock tile fetch failure');
    }
    let seed = (x * 73856093) ^ (y * 19349663) ^ 0x9e3779b9;
    seed >>>= 0;
    const data = new Float32Array(tileLen);
    for (let i = 0; i < tileLen; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const u = seed / 4294967296;
      if (i % 53 === 0) data[i] = 0;
      else if (i % 89 === 0) data[i] = NaN;
      else data[i] = u * 0.2 + 1e-4;
    }
    return { data, width: Math.sqrt(tileLen) | 0, height: Math.sqrt(tileLen) | 0 };
  };
}

test('sampleViewportStatsAuto (dB): identical to CPU sampleViewportStats', async () => {
  const getTile = makeMockGetTile(5000); // stride = max(4, 5000/50000) = 4
  const gpu = await sampleViewportStatsAuto(getTile, 900, 900, true, 128, 0, 0);
  const cpu = await sampleViewportStats(getTile, 900, 900, true, 128, 0, 0);
  assert.ok(gpu !== null, 'non-null result');
  assert.deepEqual(gpu, cpu, 'full result object matches');
});

test('sampleViewportStatsAuto (linear, offset origin): identical to CPU', async () => {
  const getTile = makeMockGetTile(2048);
  const gpu = await sampleViewportStatsAuto(getTile, 300, 150, false, 64, 100, 50, 1000);
  const cpu = await sampleViewportStats(getTile, 300, 150, false, 64, 100, 50, 1000);
  assert.deepEqual(gpu, cpu, 'full result object matches with origin/fullHeight args');
});

test('sampleViewportStatsAuto: failed tile fetches handled identically', async () => {
  const opts = { rejectTile: { x: 1, y: 1 } }; // center tile rejects
  const gpu = await sampleViewportStatsAuto(makeMockGetTile(3000, opts), 600, 600, true, 128, 0, 0);
  const cpu = await sampleViewportStats(makeMockGetTile(3000, opts), 600, 600, true, 128, 0, 0);
  assert.ok(gpu !== null, 'non-null despite one failed tile');
  assert.deepEqual(gpu, cpu, 'result matches with a rejected tile');
});

test('sampleViewportStatsAuto: onProgress reports 9 tiles like CPU path', async () => {
  const getTile = makeMockGetTile(1024);
  const gpuCalls = [];
  const cpuCalls = [];
  await sampleViewportStatsAuto(getTile, 90, 90, true, 128, 0, 0, undefined,
    (done, total) => gpuCalls.push([done, total]));
  await sampleViewportStats(getTile, 90, 90, true, 128, 0, 0, undefined,
    (done, total) => cpuCalls.push([done, total]));
  assert.equal(gpuCalls.length, 9, '9 progress callbacks');
  assert.deepEqual(gpuCalls, cpuCalls, 'progress sequence matches CPU path');
});

test('sampleViewportStatsAuto: all-nodata tiles return null on both paths', async () => {
  const emptyGetTile = async () => ({ data: new Float32Array(256), width: 16, height: 16 });
  assert.equal(await sampleViewportStatsAuto(emptyGetTile, 48, 48, true, 128, 0, 0), null, 'Auto null');
  assert.equal(await sampleViewportStats(emptyGetTile, 48, 48, true, 128, 0, 0), null, 'CPU null');
});

await run();
