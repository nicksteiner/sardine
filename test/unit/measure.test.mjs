// measure.js — ground distances/areas for marks in image pixels.
import { suite } from './harness.mjs';
import { makeGroundMeasure, haversineM, formatDistance, formatArea, formatRoiGround } from '../../src/utils/measure.js';

const { test, assert, assertClose, run } = suite('measure');

test('haversine: one degree of longitude at the equator', () => {
  assertClose(haversineM([0, 0], [1, 0]), 111195, 5);
});

test('geographic scene: ROI reads in km and km²', () => {
  // 1° × 1° scene at the equator, 1000 px square → 111 m/px
  const m = makeGroundMeasure({ worldBounds: [0, 0, 1, 1], crs: 'EPSG:4326', imageWidth: 1000, imageHeight: 1000 });
  assert(m);
  assertClose(m.metersPerPixel.x, 111.2, 0.2);
  const g = m.roiGround({ left: 100, top: 100, width: 200, height: 100 });
  assertClose(g.widthM, 22239, 30);
  assertClose(g.heightM, 11120, 30);
  assertClose(g.areaM2 / 1e6, 247.3, 1);
  assert(formatRoiGround(g).includes('km²'));
});

test('projected scene: metres straight from UTM through proj4', () => {
  const wb = [500000, 9300000, 540000, 9340000];
  const m = makeGroundMeasure({ worldBounds: wb, crs: 'EPSG:32718', imageWidth: 4000, imageHeight: 4000 });
  assertClose(m.metersPerPixel.x, 10, 0.05);
  assertClose(m.distanceM(0, 2000, 4000, 2000), 40000, 40);
});

test('returns null when the scene is not georeferenced', () => {
  assert(makeGroundMeasure({ worldBounds: null, crs: null, imageWidth: 10, imageHeight: 10 }) === null);
  assert(makeGroundMeasure({ worldBounds: [0, 0, 0, 1], crs: 'EPSG:4326', imageWidth: 10, imageHeight: 10 }) === null);
});

test('formatting', () => {
  assert(formatDistance(850) === '850 m');
  assert(formatDistance(3400) === '3.40 km');
  assert(formatDistance(34000) === '34.0 km');
  assert(formatArea(5000) === '5000 m²');
  assert(formatArea(42000) === '4.2 ha');
  assert(formatArea(0.96e6) === '96.0 ha');
  assert(formatArea(1.5e6) === '1.50 km²');
  assert(formatArea(1240e6).endsWith('km²'));
});

await run();
