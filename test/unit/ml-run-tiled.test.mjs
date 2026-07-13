/**
 * W025 — runTiled: tile-and-blend seamlessness, cancellation, progress.
 *
 * Run with:  node test/unit/ml-run-tiled.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTiled } from '../../src/ml/run-tiled.js';
import { mulberry32 } from '../../src/ml/trainer.js';

/** Reference 3×3 box blur over the whole image (zero-padded edges) —
 *  shift-invariant, so whole-image vs tiled must agree away from the
 *  raster border regardless of tiling. */
function boxBlurWhole(data, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) s += data[yy * w + xx];
        }
      }
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

/** The same blur as a per-tile function (sees zero-padding at tile edges —
 *  exactly the seam artifact feathered blending must suppress). */
function boxBlurTileFn(tile, tw, th) {
  return boxBlurWhole(tile, tw, th);
}

function randomImage(w, h, seed = 5) {
  const rand = mulberry32(seed);
  const img = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) img[i] = rand() * 100;
  return img;
}

test('tiled result matches whole-image within tolerance (no visible seams)', async () => {
  const w = 300, h = 220; // forces a 2×2+ tile grid at size 128
  const img = randomImage(w, h);
  const whole = boxBlurWhole(img, w, h);
  const tiled = await runTiled(boxBlurTileFn, img, w, h, { tileSize: 128, overlap: 16 });

  // Compare away from the raster border (kernel radius 1) — interior
  // includes every tile seam.
  let maxDiff = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const d = Math.abs(whole[y * w + x] - tiled[y * w + x]);
      if (d > maxDiff) maxDiff = d;
    }
  }
  // Feathering suppresses tile-edge padding artifacts; interior must agree
  // to well under 1% of the value range (0–100).
  assert.ok(maxDiff < 0.5, `max seam deviation ${maxDiff} too large`);
});

test('single-tile path is exact', async () => {
  const w = 64, h = 48;
  const img = randomImage(w, h, 9);
  const whole = boxBlurWhole(img, w, h);
  const tiled = await runTiled(boxBlurTileFn, img, w, h, { tileSize: 128, overlap: 16 });
  for (let i = 0; i < w * h; i++) {
    assert.ok(Math.abs(whole[i] - tiled[i]) < 1e-5);
  }
});

test('progress is monotonic and complete; abort raises AbortError', async () => {
  const w = 300, h = 300;
  const img = randomImage(w, h, 3);
  const seen = [];
  await runTiled(boxBlurTileFn, img, w, h, {
    tileSize: 128, overlap: 16,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.ok(seen.length >= 4);
  assert.equal(seen[seen.length - 1][0], seen[seen.length - 1][1]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] > seen[i - 1][0]);

  const ctrl = new AbortController();
  await assert.rejects(
    runTiled((tile, tw, th) => { ctrl.abort(); return boxBlurTileFn(tile, tw, th); },
      img, w, h, { tileSize: 128, overlap: 16, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('multi-channel in/out shapes', async () => {
  const w = 150, h = 90;
  const img = new Float32Array(2 * w * h);
  const rand = mulberry32(11);
  for (let i = 0; i < img.length; i++) img[i] = rand();
  // tileFn: out channel = mean of the two input channels
  const fn = (tile, tw, th) => {
    const out = new Float32Array(tw * th);
    for (let i = 0; i < tw * th; i++) out[i] = (tile[i] + tile[tw * th + i]) / 2;
    return out;
  };
  const out = await runTiled(fn, img, w, h, { channels: 2, outChannels: 1, tileSize: 64, overlap: 8 });
  assert.equal(out.length, w * h);
  for (let i = 0; i < w * h; i += 977) {
    assert.ok(Math.abs(out[i] - (img[i] + img[w * h + i]) / 2) < 1e-4);
  }
});

test('NaN input stays local: contaminates only its kernel/tile locality', async () => {
  const w = 300, h = 220;
  const img = randomImage(w, h, 21);
  img[110 * w + 150] = NaN; // one bad pixel mid-raster
  const out = await runTiled(boxBlurTileFn, img, w, h, { tileSize: 128, overlap: 16 });
  // Within kernel radius of the bad pixel: NaN expected (blur ingests it)
  assert.ok(Number.isNaN(out[110 * w + 150]));
  // Far corners must stay finite — feathered blending must not smear NaN
  // across tile seams (zero-weight writes are skipped, but nonzero-weight
  // contamination is confined to the source tile's blur radius).
  for (const p of [0, w - 1, (h - 1) * w, h * w - 1, 5 * w + 5]) {
    assert.ok(Number.isFinite(out[p]), `far pixel ${p} contaminated`);
  }
  let nanCount = 0;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) nanCount++;
  // 3×3 blur of one NaN pixel → at most a 3×3 patch per overlapping tile
  assert.ok(nanCount <= 9 * 4, `NaN spread too far: ${nanCount} pixels`);
});

test('parameter validation', async () => {
  const img = randomImage(10, 10);
  await assert.rejects(runTiled(boxBlurTileFn, img, 10, 10, { tileSize: 32, overlap: 16 }), /overlap/);
  await assert.rejects(runTiled(boxBlurTileFn, img, 11, 10), /data length/);
});
