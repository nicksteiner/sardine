/**
 * cog-tile-reader.test.mjs — parity tests for src/loaders/cog-tile-reader.js
 * (W032) against geotiff.js, which it replaces on the COG streaming paths.
 *
 * Fixture: app/public/demo/pacaya_hh.tif — a real NISAR-derived COG (1500²
 * Float32, deflate + floating-point predictor, 512² tiles, 3 levels, EPSG:32718).
 * Every read the loaders used to make through geotiff.js `readRasters` must
 * come back byte-identical from the new reader, so swapping it in cannot
 * change a rendered pixel.
 *
 * Run: node test/unit/cog-tile-reader.test.mjs
 */

import '../helpers/dom-parser-shim.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { openCOGReader, resampleArray } from '../../src/loaders/cog-tile-reader.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('cog-tile-reader');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', 'app', 'public', 'demo', 'pacaya_hh.tif');

function fixtureBuffer() {
  const buf = readFileSync(FIXTURE);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Count element-wise mismatches, treating NaN === NaN. */
function mismatches(a, b) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (x !== y) n++;
  }
  return n;
}

/** The geotiff.js read the loaders performed for a 256² tile at a base window. */
async function legacyTile(tiff, baseWidth, baseHeight, px, size, method) {
  const neededRes = Math.max(px[2] - px[0], px[3] - px[1]) / size;
  const n = await tiff.getImageCount();
  let best = 0;
  for (let i = 0; i < n; i++) {
    const im = await tiff.getImage(i);
    if (baseWidth / im.getWidth() <= neededRes * 1.5) best = i;
  }
  const im = await tiff.getImage(best);
  const sx = im.getWidth() / baseWidth;
  const sy = im.getHeight() / baseHeight;
  const win = [
    Math.max(0, Math.floor(px[0] * sx)), Math.max(0, Math.floor(px[1] * sy)),
    Math.min(im.getWidth(), Math.ceil(px[2] * sx)), Math.min(im.getHeight(), Math.ceil(px[3] * sy)),
  ];
  const rasters = await im.readRasters({ window: win, width: size, height: size, resampleMethod: method });
  return { level: best, data: rasters[0] };
}

let reader;
let tiff;

test('opens the fixture and reports the same geometry as geotiff.js', async () => {
  const ab = fixtureBuffer();
  reader = await openCOGReader(ab);
  tiff = await fromArrayBuffer(ab.slice(0));
  const image = await tiff.getImage();

  assert.equal(reader.width, image.getWidth());
  assert.equal(reader.height, image.getHeight());
  assert.equal(reader.levelCount, await tiff.getImageCount());
  assert.deepEqual([...reader.bbox], image.getBoundingBox());
  assert.equal(reader.crs, `EPSG:${image.getGeoKeys().ProjectedCSTypeGeoKey}`);
  assert.equal(reader.tileWidth, image.getTileWidth());
  assert.ok(reader.isTiled);
  assert.equal(reader.bandCount, 1);
  // Overviews are finest → coarsest, halving each level.
  assert.deepEqual(reader.levels.map((l) => l.width), [1500, 750, 375]);
});

test('native window at level 0 straddling four tiles is byte-identical', async () => {
  const win = [400, 300, 700, 650]; // crosses the x=512 and y=512 tile seams
  const mine = await reader.readWindow(0, win);
  const theirs = (await (await tiff.getImage(0)).readRasters({ window: win }))[0];
  assert.equal(mine.width, 300);
  assert.equal(mine.height, 350);
  assert.equal(mismatches(mine.data, theirs), 0);
});

test('native window on an overview is byte-identical', async () => {
  const win = [10, 20, 300, 370];
  const mine = await reader.readWindow(2, win);
  const theirs = (await (await tiff.getImage(2)).readRasters({ window: win }))[0];
  assert.equal(mismatches(mine.data, theirs), 0);
});

test('window is clamped to the image and misses return null', async () => {
  const edge = await reader.readWindow(0, [1400, 1450, 1700, 1600]);
  assert.equal(edge.width, 100);
  assert.equal(edge.height, 50);
  const theirs = (await (await tiff.getImage(0)).readRasters({ window: [1400, 1450, 1500, 1500] }))[0];
  assert.equal(mismatches(edge.data, theirs), 0);
  assert.equal(await reader.readWindow(0, [1500, 0, 1600, 10]), null);
  assert.equal(await reader.readTile([0, 0, 0, 10]), null);
});

test('pickLevel follows the 1.5× rule the loaders used', () => {
  assert.equal(reader.pickLevel(1), 0);     // full res wanted → level 0
  assert.equal(reader.pickLevel(1.4), 1);   // 2× overview is within 1.5×2.1
  assert.equal(reader.pickLevel(3), 2);     // 4× overview is within 1.5×3
  assert.equal(reader.pickLevel(100), 2);   // coarser than anything we have
});

for (const method of ['bilinear', 'nearest']) {
  test(`resampled 256² tile (${method}) is byte-identical to geotiff.js`, async () => {
    for (const px of [[100, 200, 900, 1000], [0, 0, 1500, 1500], [1200, 1300, 1500, 1500], [5, 7, 260, 262]]) {
      const theirs = await legacyTile(tiff, reader.width, reader.height, px, 256, method);
      const mine = await reader.readTile(px, 256, method);
      assert.equal(reader.pickLevel(Math.max(px[2] - px[0], px[3] - px[1]) / 256), theirs.level, `level for ${px}`);
      assert.equal(mismatches(mine, theirs.data), 0, `${method} ${px}`);
    }
  });
}

test('resampleArray matches geotiff.js formulas on a synthetic ramp', () => {
  const inW = 5, inH = 3;
  const src = Float32Array.from({ length: inW * inH }, (_, i) => i);
  const near = resampleArray(src, inW, inH, 3, 2, 'nearest');
  // relX = 5/3: x → round(0, 1.67, 3.33) = 0, 2, 3; relY = 1.5: y → 0, 2
  assert.deepEqual([...near], [0, 2, 3, 10, 12, 13]);
  const bil = resampleArray(src, inW, inH, 3, 2, 'bilinear');
  assert.equal(bil[0], 0);
  // x=1 → rawX 1.667 between 1 and 2 → 1.667; y=1 → rawY 1.5 between rows 1,2 → +7.5
  assert.ok(Math.abs(bil[1] - 1.6667) < 1e-3);
  assert.ok(Math.abs(bil[4] - (1.6667 + 7.5)) < 1e-3);
});

test('decoded tiles are cached and shared across windows', async () => {
  const fresh = await openCOGReader(fixtureBuffer());
  assert.equal(fresh.cacheBytes, 0);
  await fresh.readWindow(0, [0, 0, 100, 100]);
  const one = fresh.cacheBytes;
  assert.equal(one, 512 * 512 * 4); // one Float32 tile, zero-copy
  await fresh.readWindow(0, [50, 50, 200, 200]); // same tile → no growth
  assert.equal(fresh.cacheBytes, one);
  await fresh.readWindow(0, [500, 500, 600, 600]); // 4 tiles, 1 already cached
  assert.equal(fresh.cacheBytes, 4 * one);
  fresh.close();
  assert.equal(fresh.cacheBytes, 0);
});

test('LRU evicts decoded tiles past the byte cap', async () => {
  const small = await openCOGReader(fixtureBuffer(), { cacheBytes: 2 * 512 * 512 * 4 });
  await small.readWindow(0, [0, 0, 1500, 1500]); // all 9 tiles
  assert.ok(small.cacheBytes <= 2 * 512 * 512 * 4, `cache ${small.cacheBytes} within cap`);
  // Evicted tiles are simply re-read: result still correct.
  const again = await small.readWindow(0, [0, 0, 100, 100]);
  const theirs = (await (await tiff.getImage(0)).readRasters({ window: [0, 0, 100, 100] }))[0];
  assert.equal(mismatches(again.data, theirs), 0);
});

await run();
