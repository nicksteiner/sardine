/**
 * optical-peek-math.test.mjs — W026 optical peek detail atlas: tile math,
 * Web Mercator domain guards, cap-fitted zoom, screen-density zoom pick,
 * and world↔UV↔geo rect mapping.
 *
 * Run: node test/unit/optical-peek-math.test.mjs
 */

import { suite } from './harness.mjs';
import {
  TILE_PX,
  WEB_MERCATOR_MAX_LAT,
  MERCATOR_M_PER_PX_Z0,
  M_PER_DEG,
  proj4DefFor,
  isMercatorMappable,
  clampMercatorLat,
  lonLatToTilePx,
  tileRangeForLonLat,
  fitZoomToCaps,
  metersPerWorldUnit,
  detailZoomForView,
  worldRectToUV,
  uvRectToGeoBounds,
  padRect,
  wrapTileX,
} from '../../src/utils/optical-peek-math.js';

const { test, assert, assertClose, run } = suite('optical-peek-math (W026)');

// ---------------------------------------------------------------------------
// lonLatToTilePx — Slippy Map ground truth
// ---------------------------------------------------------------------------

test('origin lon/lat lands on the center tile seam', () => {
  const t = lonLatToTilePx(0, 0, 1);
  assert.equal(t.tileX, 1);
  assert.equal(t.tileY, 1);
  assertClose(t.pxX, 0, 1e-9);
  assertClose(t.pxY, 0, 1e-9);
});

test('z=0 has a single tile containing everything mappable', () => {
  for (const [lon, lat] of [[-179, 80], [179, -80], [0, 0]]) {
    const t = lonLatToTilePx(lon, lat, 0);
    assert.equal(t.tileX, 0);
    assert.equal(t.tileY, 0);
  }
});

test('quadrants at z=1', () => {
  assert.deepEqual(
    [lonLatToTilePx(-90, 45, 1).tileX, lonLatToTilePx(-90, 45, 1).tileY],
    [0, 0]);
  assert.deepEqual(
    [lonLatToTilePx(90, -45, 1).tileX, lonLatToTilePx(90, -45, 1).tileY],
    [1, 1]);
});

// ---------------------------------------------------------------------------
// Web Mercator domain guards
// ---------------------------------------------------------------------------

test('isMercatorMappable rejects polar latitudes and non-finite values', () => {
  assert.equal(isMercatorMappable(0, 84), true);
  assert.equal(isMercatorMappable(0, 86), false);
  assert.equal(isMercatorMappable(0, -86), false);
  assert.equal(isMercatorMappable(NaN, 0), false);
  assert.equal(isMercatorMappable(0, NaN), false);
});

test('clampMercatorLat pins into the tile domain', () => {
  assert.equal(clampMercatorLat(89), WEB_MERCATOR_MAX_LAT);
  assert.equal(clampMercatorLat(-89), -WEB_MERCATOR_MAX_LAT);
  assert.equal(clampMercatorLat(12.5), 12.5);
});

test('tileRangeForLonLat clamps tile y into [0, 2^z) for a polar box', () => {
  const r = tileRangeForLonLat(-10, 10, 80, 89.9, 4);
  assert.ok(r.tyMin >= 0);
  assert.ok(r.tyMax <= 15);
  assert.ok(r.rows >= 1);
});

test('wrapTileX wraps negative and overflow indices (antimeridian)', () => {
  assert.equal(wrapTileX(-1, 3), 7);
  assert.equal(wrapTileX(8, 3), 0);
  assert.equal(wrapTileX(5, 3), 5);
});

// ---------------------------------------------------------------------------
// fitZoomToCaps — atlas never exceeds tile or canvas-dimension budgets
// ---------------------------------------------------------------------------

test('small box keeps its requested zoom', () => {
  // ~0.05° box at z15 is a handful of tiles
  const { zoom, range } = fitZoomToCaps({ lonMin: -74.02, lonMax: -73.97, latMin: 40.70, latMax: 40.75, zoom: 15 });
  assert.equal(zoom, 15);
  assert.ok(range.cols * range.rows <= 64);
});

test('scene-sized box at z19 steps down until caps fit', () => {
  const { zoom, range } = fitZoomToCaps({ lonMin: -74.3, lonMax: -73.7, latMin: 40.4, latMax: 41.0, zoom: 19 });
  assert.ok(zoom < 19, `expected step-down, got z${zoom}`);
  assert.ok(range.cols * range.rows <= 1024);
  assert.ok(range.cols <= 64 && range.rows <= 64);
});

test('long-thin strip respects the per-axis cap, not just the total', () => {
  // 3° wide, very thin — old total-only cap would allow a canvas wider than
  // the browser maximum
  const { range } = fitZoomToCaps({ lonMin: -76, lonMax: -73, latMin: 40.0, latMax: 40.02, zoom: 19 });
  assert.ok(range.cols <= 64, `cols=${range.cols}`);
  assert.ok(range.cols * TILE_PX <= 16384, 'atlas width within conservative canvas limit');
});

test('never steps below minZoom', () => {
  const { zoom } = fitZoomToCaps({ lonMin: -180, lonMax: 180, latMin: -85, latMax: 85, zoom: 10, minZoom: 1 });
  assert.ok(zoom >= 1);
});

// ---------------------------------------------------------------------------
// metersPerWorldUnit — world→ground scale for both quad coordinate spaces
// ---------------------------------------------------------------------------

test('geographic scene (NISAR): bounds == geoBounds in degrees', () => {
  const bounds = [-74, 40, -73, 41];
  const m = metersPerWorldUnit({ bounds, geoBounds: bounds, isProjected: false, latCenterDeg: 0 });
  assertClose(m, M_PER_DEG, 1); // 1 world unit = 1 degree at the equator
});

test('geographic scene shrinks by cos(lat)', () => {
  const bounds = [-74, 40, -73, 41];
  const m = metersPerWorldUnit({ bounds, geoBounds: bounds, isProjected: false, latCenterDeg: 60 });
  assertClose(m, M_PER_DEG * 0.5, 1);
});

test('pixel-space scene (local COG): world unit = image pixel', () => {
  // 1000-px-wide image covering 20,000 m of UTM easting → 20 m/px
  const m = metersPerWorldUnit({
    bounds: [0, 0, 1000, 800],
    geoBounds: [500000, 4000000, 520000, 4016000],
    isProjected: true,
    latCenterDeg: 36,
  });
  assertClose(m, 20, 1e-9);
});

// ---------------------------------------------------------------------------
// detailZoomForView — screen-density-matched Web Mercator zoom
// ---------------------------------------------------------------------------

test('matches known resolution: 10 m per screen px at the equator → z14', () => {
  // metersPerWorld 10, viewZoom 0 → 10 m/screen-px.
  // ceil(log2(156543/10)) = ceil(13.93) = 14
  const z = detailZoomForView({ viewZoom: 0, metersPerWorld: 10, latCenterDeg: 0, maxZoom: 19 });
  assert.equal(z, 14);
});

test('each +1 of view zoom raises the pick by one level', () => {
  const z0 = detailZoomForView({ viewZoom: 2, metersPerWorld: 10, latCenterDeg: 0, maxZoom: 19 });
  const z1 = detailZoomForView({ viewZoom: 3, metersPerWorld: 10, latCenterDeg: 0, maxZoom: 19 });
  assert.equal(z1, z0 + 1);
});

test('clamps to provider maxZoom', () => {
  const z = detailZoomForView({ viewZoom: 20, metersPerWorld: 10, latCenterDeg: 0, maxZoom: 19 });
  assert.equal(z, 19);
});

test('high latitude needs fewer levels for the same ground resolution', () => {
  const zEq = detailZoomForView({ viewZoom: 0, metersPerWorld: 10, latCenterDeg: 0, maxZoom: 19 });
  const zHi = detailZoomForView({ viewZoom: 0, metersPerWorld: 10, latCenterDeg: 60, maxZoom: 19 });
  assert.equal(zHi, zEq - 1); // cos(60°) = 0.5 → exactly one level
});

test('degenerate inputs return minZoom', () => {
  assert.equal(detailZoomForView({ viewZoom: 0, metersPerWorld: 0, latCenterDeg: 0, maxZoom: 19 }), 1);
});

test('consistency: MERCATOR_M_PER_PX_Z0 ≈ earth circumference / 256', () => {
  assertClose(MERCATOR_M_PER_PX_Z0, 40075016.686 / 256, 1);
});

// ---------------------------------------------------------------------------
// Rect mapping: world → UV (v=0 north) → geo, round trip
// ---------------------------------------------------------------------------

test('full bounds map to the unit UV rect', () => {
  assert.deepEqual(worldRectToUV([0, 0, 100, 50], [0, 0, 100, 50]), [0, 0, 1, 1]);
});

test('v=0 is north: top half of the scene is v ∈ [0, 0.5]', () => {
  const uv = worldRectToUV([0, 25, 100, 50], [0, 0, 100, 50]);
  assertClose(uv[1], 0, 1e-12);
  assertClose(uv[3], 0.5, 1e-12);
});

test('uvRectToGeoBounds inverts worldRectToUV when spaces coincide', () => {
  const bounds = [-74, 40, -73, 41];
  const rect = [-73.8, 40.2, -73.4, 40.9];
  const geo = uvRectToGeoBounds(worldRectToUV(rect, bounds), bounds);
  for (let i = 0; i < 4; i++) assertClose(geo[i], rect[i], 1e-12);
});

test('pixel-space rect maps through UV into the geographic extent', () => {
  // top-left quadrant of a 1000×800 px image (y up in world space)
  const bounds = [0, 0, 1000, 800];
  const geoBounds = [500000, 4000000, 520000, 4016000];
  const geo = uvRectToGeoBounds(worldRectToUV([0, 400, 500, 800], bounds), geoBounds);
  assert.deepEqual(geo, [500000, 4008000, 510000, 4016000]);
});

test('padRect pads by the fraction and clamps to limits', () => {
  const limits = [0, 0, 100, 100];
  assert.deepEqual(padRect([40, 40, 60, 60], 0.25, limits), [35, 35, 65, 65]);
  assert.deepEqual(padRect([0, 0, 20, 20], 0.5, limits), [0, 0, 30, 30]);
});

// ---------------------------------------------------------------------------
// proj4DefFor — CRS coverage unchanged by the move out of the layer
// ---------------------------------------------------------------------------

test('recognises UTM north/south, polar stereo; passes 4326/unknown through', () => {
  assert.ok(proj4DefFor('EPSG:32610').includes('+proj=utm +zone=10 '));
  assert.ok(proj4DefFor('EPSG:32723').includes('+south'));
  assert.ok(proj4DefFor('EPSG:3413').includes('+proj=stere'));
  assert.ok(proj4DefFor('EPSG:3031').includes('lat_0=-90'));
  assert.equal(proj4DefFor('EPSG:4326'), null);
  assert.equal(proj4DefFor('EPSG:3857'), null);
  assert.equal(proj4DefFor(null), null);
});

await run();
