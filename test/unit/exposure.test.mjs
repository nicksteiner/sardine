/**
 * exposure.test.mjs — behavioural tests for src/utils/exposure.js: the
 * raster → vector exposure arithmetic (people and buildings under a polygon)
 * on synthetic data. No network: the population reader is a fake over a
 * small EPSG:4326 grid.
 *
 * Run: node test/unit/exposure.test.mjs
 */

import { cellAreaKm2, pointInPolygon, polygonBbox, sumPopulationInPolygon, maskToPolygons } from '../../src/utils/exposure.js';
import { suite } from './harness.mjs';

const { test, assert, assertClose, run } = suite('exposure');

/** Fake density reader: W×H grid over bbox, uniform `density` people/km², one level. */
function fakeReader({ width, height, bbox, density, levels = 1 }) {
  const data = new Float32Array(width * height).fill(density);
  const lv = [];
  for (let i = 0; i < levels; i++) lv.push({ index: i, width: width >> i, height: height >> i });
  return {
    width, height, bbox, levelCount: levels, levels: lv,
    async readWindow(level, win) {
      const L = lv[level];
      const l = Math.max(0, Math.floor(win[0])), t = Math.max(0, Math.floor(win[1]));
      const r = Math.min(L.width, Math.ceil(win[2])), b = Math.min(L.height, Math.ceil(win[3]));
      if (r <= l || b <= t) return null;
      const out = new Float32Array((r - l) * (b - t)).fill(density);
      return { data: out, width: r - l, height: b - t };
    },
  };
}

test('cellAreaKm2: 1° cell at the equator ≈ 12,364 km², shrinks with cos(lat)', () => {
  assertClose(cellAreaKm2(0, 1, 1), 12364, 30, 'equator');
  assertClose(cellAreaKm2(60, 1, 1), 12364 * 0.5, 30, '60°N');
  // 3 arc-second cell (GHS-POP 100 m grid) near the equator ≈ 0.0086 km²
  assertClose(cellAreaKm2(-5, 1 / 1200, 1 / 1200), 0.0086, 0.0003, '3 arcsec');
});

test('pointInPolygon: inside, outside, and holes', () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  assert.ok(pointInPolygon(5, 5, square));
  assert.ok(!pointInPolygon(15, 5, square));
  const withHole = [square[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
  assert.ok(!pointInPolygon(5, 5, withHole), 'in the hole');
  assert.ok(pointInPolygon(2, 2, withHole), 'outside the hole');
  assert.deepEqual(polygonBbox(withHole), [0, 0, 10, 10]);
});

test('sumPopulationInPolygon: density × area over a square matches analytic area', async () => {
  // 1200 cells/degree (3 arcsec), 2°×2° grid centred on the equator, 100 people/km².
  const reader = fakeReader({ width: 2400, height: 2400, bbox: [-1, -1, 1, 1], density: 100 });
  const half = 0.25; // 0.5° square at the equator ≈ 55.6 km × 55.6 km
  const rings = [[[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]];
  const r = await sumPopulationInPolygon(reader, rings);
  const expectedArea = cellAreaKm2(0, 0.5, 0.5); // ≈ 3091 km²
  assertClose(r.areaKm2, expectedArea, expectedArea * 0.01, 'area');
  assertClose(r.people, 100 * expectedArea, 100 * expectedArea * 0.01, 'people');
  assert.equal(r.cells, 600 * 600);
  assert.equal(r.level, 0);
});

test('sumPopulationInPolygon: units="count" sums raw values; polygon outside raster → 0', async () => {
  const reader = fakeReader({ width: 100, height: 100, bbox: [0, 0, 1, 1], density: 3 });
  const rings = [[[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3], [0.1, 0.1]]];
  const r = await sumPopulationInPolygon(reader, rings, { units: 'count' });
  assert.equal(r.cells, 400);
  assert.equal(r.people, 1200);
  const away = await sumPopulationInPolygon(reader, [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]);
  assert.equal(away.people, 0);
});

test('sumPopulationInPolygon: large bbox picks a coarser overview and keeps the total', async () => {
  const reader = fakeReader({ width: 4096, height: 4096, bbox: [-2, -2, 2, 2], density: 50, levels: 4 });
  const rings = [[[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5], [-1.5, -1.5]]];
  const fine = await sumPopulationInPolygon(reader, rings, { maxCells: 1e9 });
  const coarse = await sumPopulationInPolygon(reader, rings, { maxCells: 200_000 });
  assert.equal(fine.level, 0);
  assert.ok(coarse.level > 0, `coarse level ${coarse.level}`);
  assertClose(coarse.people, fine.people, fine.people * 0.02, 'overview total within 2%');
});

test('maskToPolygons: row runs become rectangles in lon/lat', () => {
  const mask = Uint8Array.from([
    1, 1, 0,
    0, 1, 1,
  ]);
  const toLonLat = (c, r) => [10 + c * 0.1, 20 - r * 0.1];
  const polys = maskToPolygons(mask, 3, 2, toLonLat);
  assert.equal(polys.length, 2);
  assert.deepEqual(polys[0][0][0], [10, 20]);
  assertClose(polys[0][0][1][0], 10.2, 1e-9, 'first run spans two cells');
  assert.ok(pointInPolygon(10.25, 19.85, polys[1]));
  assert.ok(!pointInPolygon(10.05, 19.85, polys[1]));
});

await run();
