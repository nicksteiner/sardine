/**
 * stats.test.mjs — behavioral tests for src/utils/stats.js.
 *
 * Runs computeStats, computeHistogram, autoContrastLimits, and
 * computeChannelStats on synthetic arrays with NaN/zero nodata and asserts
 * min/max/mean/percentiles against hand-computed values.
 *
 * Percentiles/median in stats.js are histogram-binned (256 or 128 bins), so
 * those are asserted to within one bin width; min/max/mean/count are exact.
 *
 * Run: node test/unit/stats.test.mjs
 */

import {
  computeStats,
  computeHistogram,
  autoContrastLimits,
  computeChannelStats,
} from '../../src/utils/stats.js';
import { suite } from './harness.mjs';

const { test, assert, assertClose, run } = suite('stats');

// ─── computeStats ────────────────────────────────────────────────────────────

test('computeStats (linear): NaN/Inf/zero excluded, exact min/max/mean/std/count', () => {
  // Valid values: 3, 1, 4, 1, 5, 9, 2, 6 (0, NaN, Infinity are nodata)
  const data = new Float32Array([3, 1, 4, 1, 5, 9, 2, 6, 0, NaN, Infinity]);
  const s = computeStats(data, false);

  assert.equal(s.count, 8, 'count excludes nodata');
  assert.equal(s.min, 1, 'min');
  assert.equal(s.max, 9, 'max');
  // sum = 31 → mean = 3.875
  assertClose(s.mean, 3.875, 1e-12, 'mean');
  // sqSum = 9+1+16+1+25+81+4+36 = 173; var = 173/8 - 3.875^2 = 6.609375
  assertClose(s.std, Math.sqrt(6.609375), 1e-12, 'std');
  // Sorted: [1,1,2,3,4,5,6,9] → median between 3 and 4; binned estimate
  const binWidth = (9 - 1) / 256;
  assertClose(s.median, 4, binWidth, 'median (binned, ±1 bin)');
});

test('computeStats (dB): 10*log10 applied, non-positive values dropped', () => {
  // Valid in dB mode: 1 → 0 dB, 10 → 10 dB, 100 → 20 dB. 0, -5, NaN dropped.
  const data = new Float32Array([1, 10, 100, 0, -5, NaN]);
  const s = computeStats(data, true);

  assert.equal(s.count, 3, 'count');
  assertClose(s.min, 0, 1e-6, 'min = 0 dB');
  assertClose(s.max, 20, 1e-6, 'max = 20 dB');
  // mean = (0+10+20)/3 = 10
  assertClose(s.mean, 10, 1e-5, 'mean = 10 dB');
  // var = (0+100+400)/3 - 100 = 200/3
  assertClose(s.std, Math.sqrt(200 / 3), 1e-5, 'std');
});

test('computeStats: all-nodata input returns zeroed stats', () => {
  const s = computeStats(new Float32Array([0, NaN, 0]), false);
  assert.deepEqual(s, { min: 0, max: 0, mean: 0, std: 0, median: 0 }, 'zeroed stats object');
});

// ─── computeHistogram ────────────────────────────────────────────────────────

test('computeHistogram with explicit range: exact bin counts and edges', () => {
  const data = [0.5, 1.5, 1.6, 2.5, 3.5, 0, NaN]; // 0 and NaN are nodata
  const h = computeHistogram(data, false, 4, [0, 4]);

  assert.deepEqual(h.bins, [1, 2, 1, 1], 'bin counts');
  assert.deepEqual(h.edges, [0, 1, 2, 3, 4], 'edges');
  assert.equal(h.totalCount, 5, 'totalCount');
  assert.equal(h.min, 0, 'min = range min');
  assert.equal(h.max, 4, 'max = range max');
  assert.equal(h.binWidth, 1, 'binWidth');
});

test('computeHistogram with range: out-of-range values clamp to edge bins', () => {
  const h = computeHistogram([-3, 10, 2.5], false, 4, [0, 4]);
  assert.deepEqual(h.bins, [1, 0, 1, 1], 'clamped to first/last bins');
  assert.equal(h.totalCount, 3, 'totalCount includes clamped');
});

test('computeHistogram auto-range (linear): min/max from data, all values binned', () => {
  const h = computeHistogram([1, 2, 3, 4], false, 4);
  assert.equal(h.min, 1, 'min');
  assert.equal(h.max, 4, 'max');
  assert.deepEqual(h.bins, [1, 1, 1, 1], 'one value per bin');
  assert.equal(h.totalCount, 4, 'totalCount');
  assertClose(h.binWidth, 0.75, 1e-12, 'binWidth = 3/4');
});

test('computeHistogram in dB: bins land at 10*log10 positions', () => {
  const h = computeHistogram([1, 10, 100], true, 2); // dB: 0, 10, 20
  assert.equal(h.min, 0, 'min 0 dB');
  assert.equal(h.max, 20, 'max 20 dB');
  // binWidth = 10: 0 dB → bin 0; 10 dB sits on the boundary → bin 1;
  // 20 dB → index 2 clamped into bin 1
  assert.deepEqual(h.bins, [1, 2], 'bin counts at dB positions');
});

test('computeHistogram: empty/all-nodata input returns zeroed histogram', () => {
  const h = computeHistogram([0, NaN], false, 8);
  assert.deepEqual(h.bins, new Array(8).fill(0), 'all-zero bins');
  assert.equal(h.min, 0, 'min 0');
  assert.equal(h.max, 0, 'max 0');
});

// ─── autoContrastLimits ──────────────────────────────────────────────────────

test('autoContrastLimits (linear ramp): p2/p98 within one bin of true percentiles', () => {
  // 1..1000 → true p2 ≈ 21, p98 ≈ 981
  const data = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) data[i] = i + 1;

  const [lo, hi] = autoContrastLimits(data, false, 2, 98);
  const binWidth = (1000 - 1) / 256;
  assertClose(lo, 21, 2 * binWidth, 'low limit near 2nd percentile');
  assertClose(hi, 981, 2 * binWidth, 'high limit near 98th percentile');
  assert.ok(lo < hi, 'lo < hi');
});

test('autoContrastLimits (dB ramp): limits computed in dB space', () => {
  // Powers 10^-3 .. 10^0 uniform in dB: -30..0 dB over 301 samples
  const data = new Float64Array(301);
  for (let i = 0; i < 301; i++) data[i] = Math.pow(10, (i - 300) / 100);

  const [lo, hi] = autoContrastLimits(data, true, 2, 98);
  const binWidth = 30 / 256;
  assertClose(lo, -30 + 0.02 * 30, 2 * binWidth, 'low ≈ -29.4 dB');
  assertClose(hi, -0.6, 2 * binWidth, 'high ≈ -0.6 dB');
});

test('autoContrastLimits: nodata-only input falls back to defaults', () => {
  assert.deepEqual(autoContrastLimits([0, NaN], true), [-30, 0], 'dB default');
  assert.deepEqual(autoContrastLimits([0, NaN], false), [0, 1], 'linear default');
});

// ─── computeChannelStats ─────────────────────────────────────────────────────

test('computeChannelStats: exact count/min/max/mean with nodata mixed in', () => {
  const s = computeChannelStats([10, 20, 30, 40, 0, NaN], false);
  assert.ok(s !== null, 'non-null result');
  assert.equal(s.count, 4, 'count');
  assert.equal(s.min, 10, 'min');
  assert.equal(s.max, 40, 'max');
  assertClose(s.mean, 25, 1e-12, 'mean');
  assert.equal(s.bins.length, 128, 'default 128 bins');
  assert.equal(s.bins.reduce((a, b) => a + b, 0), 4, 'all valid values binned');
  // With 4 values, p2 target = 0 → first occupied bin; p98 → last occupied bin
  assert.equal(s.p2, 10, 'p2 = min for tiny sample');
  assertClose(s.p98, 40, s.binWidth, 'p98 = max (±1 bin)');
});

test('computeChannelStats: stride samples every Nth value', () => {
  const s = computeChannelStats([1, 999, 3, 999, 5, 999], false, 8, 2);
  assert.equal(s.count, 3, 'only strided samples counted');
  assert.equal(s.min, 1, 'min from indices 0,2,4');
  assert.equal(s.max, 5, 'max from indices 0,2,4');
  assertClose(s.mean, 3, 1e-12, 'mean of 1,3,5');
});

test('computeChannelStats (dB): converts before stats', () => {
  const s = computeChannelStats([0.01, 1, 100], true); // -20, 0, +20 dB
  assertClose(s.min, -20, 1e-9, 'min -20 dB');
  assertClose(s.max, 20, 1e-9, 'max +20 dB');
  assertClose(s.mean, 0, 1e-9, 'mean 0 dB');
});

test('computeChannelStats: percentiles on a large ramp within one bin', () => {
  const n = 10000;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = i + 1; // 1..10000
  const s = computeChannelStats(data, false, 128);
  const binWidth = (n - 1) / 128;
  assertClose(s.p2, 0.02 * n, 2 * binWidth, 'p2 ≈ 200');
  assertClose(s.p98, 0.98 * n, 2 * binWidth, 'p98 ≈ 9800');
});

test('computeChannelStats: returns null for all-nodata input', () => {
  assert.equal(computeChannelStats([0, NaN, 0], false), null, 'null on empty');
  assert.equal(computeChannelStats([-1, 0], true), null, 'null when dB drops everything');
});

await run();
