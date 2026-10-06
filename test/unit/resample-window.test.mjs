/**
 * resample-window.test.mjs — behavioral tests for resampleWindow in
 * src/loaders/cog-loader.js: the path that lets a non-COG local GeoTIFF
 * (no overviews, raster held in memory) answer `getTile` requests, which is
 * all Basemap mode's warped tiles ever ask for.
 *
 * Run: node test/unit/resample-window.test.mjs
 */

import '../helpers/dom-parser-shim.mjs';
import { resampleWindow } from '../../src/loaders/cog-loader.js';
import { suite } from './harness.mjs';

const { test, assert, assertClose, run } = suite('resample-window');

// 4×4 ramp: value = row*10 + col
const W = 4, H = 4;
const ramp = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) ramp[r * W + c] = r * 10 + c;

test('identity window at native size returns the pixels unchanged', () => {
  const out = resampleWindow(ramp, W, [0, 0, W, H], W, H);
  for (let i = 0; i < ramp.length; i++) assert(out[i] === ramp[i], `pixel ${i}: ${out[i]} !== ${ramp[i]}`);
});

test('sub-window at native size is a crop', () => {
  const out = resampleWindow(ramp, W, [1, 2, 3, 4], 2, 2);
  assert(out[0] === 21 && out[1] === 22 && out[2] === 31 && out[3] === 32, `crop: ${Array.from(out)}`);
});

test('shrinking box-averages each 2×2 footprint', () => {
  const out = resampleWindow(ramp, W, [0, 0, W, H], 2, 2);
  // top-left footprint: 0,1,10,11 → 5.5 ; bottom-right: 22,23,32,33 → 27.5
  assertClose(out[0], 5.5, 1e-6, 'top-left mean');
  assertClose(out[3], 27.5, 1e-6, 'bottom-right mean');
});

test('shrinking skips NaN and nodata instead of poisoning the mean', () => {
  const src = Float32Array.from(ramp);
  src[0] = NaN; src[1] = -9999;
  const out = resampleWindow(src, W, [0, 0, 2, 2], 1, 1, { nodata: -9999 });
  assertClose(out[0], 10.5, 1e-6, 'mean of the two valid pixels (10, 11)');
  const allBad = resampleWindow(new Float32Array([NaN, NaN, NaN, NaN]), 2, [0, 0, 2, 2], 1, 1);
  assert(Number.isNaN(allBad[0]), 'all-nodata footprint stays NaN');
});

test('growing bilinear interpolates between pixel centres', () => {
  // 1×2 source [0, 10] grown to 1×4: centres at 0.25,0.75 of the span → 0, 2.5, 7.5, 10
  const out = resampleWindow(new Float32Array([0, 10]), 2, [0, 0, 2, 1], 4, 1);
  assertClose(out[0], 0, 1e-6); assertClose(out[1], 2.5, 1e-6);
  assertClose(out[2], 7.5, 1e-6); assertClose(out[3], 10, 1e-6);
});

test('growing with nearest keeps class values intact', () => {
  const out = resampleWindow(new Float32Array([3, 7]), 2, [0, 0, 2, 1], 4, 1, { method: 'nearest' });
  assert(Array.from(out).every((v) => v === 3 || v === 7), `nearest leaked a blended value: ${Array.from(out)}`);
});

test('growing bilinear next to NaN falls back to nearest, never blends NaN', () => {
  const out = resampleWindow(new Float32Array([NaN, 10]), 2, [0, 0, 2, 1], 4, 1);
  assert(Number.isNaN(out[0]) && Number.isNaN(out[1]), 'left half nearest to the NaN pixel');
  assert(out[2] === 10 && out[3] === 10, `right half nearest to 10: ${Array.from(out)}`);
});

run();
