// view-frame.js — map-frame coordinate contract used by the markup overlays
// and the figure exporter in Basemap mode.
import { suite } from './harness.mjs';
import {
  makeMapFrame, makeOrthoFrame, scaleFrame,
  lonLatToMercator, mercatorToLonLat, mercatorMetersPerPixel,
} from '../../src/utils/view-frame.js';

const { test, assert, assertClose, run } = suite('view-frame');

test('mercator round-trip and ground scale', () => {
  const [x, y] = lonLatToMercator(-74.5, -5.3);
  const [lon, lat] = mercatorToLonLat(x, y);
  assertClose(lon, -74.5, 1e-9);
  assertClose(lat, -5.3, 1e-9);
  // 512-px world at z0 → 40075 km / 512 px at the equator
  assertClose(mercatorMetersPerPixel(0, 0), 40075016.686 / 512, 1e-6);
  // z10 at 60°N halves the equatorial ground scale
  assertClose(mercatorMetersPerPixel(60, 10) / mercatorMetersPerPixel(0, 10), 0.5, 1e-9);
});

test('ortho frame is the OrthographicView math', () => {
  const f = makeOrthoFrame();
  const vs = { target: [500, 400], zoom: 1 };
  const [sx, sy] = f.worldToPixel(500, 400, vs, 800, 600);
  assertClose(sx, 400, 1e-9); assertClose(sy, 300, 1e-9);
  const [wx, wy] = f.pixelToWorld(sx, sy, vs, 800, 600);
  assertClose(wx, 500, 1e-9); assertClose(wy, 400, 1e-9);
});

test('map frame: EPSG:4326 pixel-space scene round-trips through the screen', () => {
  // 1000×800 image covering lon −75..−74, lat −6..−5; bounds in pixel space (COG path)
  const f = makeMapFrame({
    bounds: [0, 0, 1000, 800], imageWidth: 1000, imageHeight: 800,
    worldBounds: [-75, -6, -74, -5], crs: 'EPSG:4326',
  });
  assert(f && f.kind === 'map');
  const vs = { longitude: -74.5, latitude: -5.5, zoom: 9 };
  // scene-world centre (pixel space, Y up) lands at the screen centre
  const [sx, sy] = f.worldToPixel(500, 400, vs, 1000, 700);
  assertClose(sx, 500, 1e-6); assertClose(sy, 350, 1e-6);
  // world → screen → world identity away from the centre
  const [wx, wy] = f.pixelToWorld(...f.worldToPixel(120, 710, vs, 1000, 700), vs, 1000, 700);
  assertClose(wx, 120, 1e-6); assertClose(wy, 710, 1e-6);
  // image row 0 is the north edge
  const [, lat0] = f.imgToLonLat(0, 0);
  assertClose(lat0, -5, 1e-12);
});

test('map frame: UTM scene (world-space bounds) round-trips through proj4', () => {
  // NISAR-style: bounds === worldBounds in the image CRS
  const wb = [500000, 9300000, 540000, 9340000]; // 40 km square, UTM 18S
  const f = makeMapFrame({
    bounds: wb, imageWidth: 2000, imageHeight: 2000, worldBounds: wb, crs: 'EPSG:32718',
  });
  const [lonC, latC] = f.imgToLonLat(1000, 1000);
  const vs = { longitude: lonC, latitude: latC, zoom: 10 };
  const [sx, sy] = f.worldToPixel(520000, 9320000, vs, 900, 900);
  assertClose(sx, 450, 1e-3); assertClose(sy, 450, 1e-3);
  const [wx, wy] = f.pixelToWorld(...f.worldToPixel(503210, 9337777, vs, 900, 900), vs, 900, 900);
  assertClose(wx, 503210, 1e-3); assertClose(wy, 9337777, 1e-3);
  // 40 km across ≈ 40 km / (m/px) screen pixels
  const [ex0] = f.worldToPixel(wb[0], 9320000, vs, 900, 900);
  const [ex1] = f.worldToPixel(wb[2], 9320000, vs, 900, 900);
  assertClose((ex1 - ex0) * f.metersPerPixel(vs), 40000, 60);
});

test('scaleFrame maps CSS-pixel geometry onto a device-pixel export canvas', () => {
  const f = makeMapFrame({
    bounds: [0, 0, 100, 100], imageWidth: 100, imageHeight: 100,
    worldBounds: [10, 50, 11, 51], crs: 'EPSG:4326',
  });
  const vs = { longitude: 10.5, latitude: 50.5, zoom: 8 };
  const g = scaleFrame(f, 2);
  const a = f.worldToPixel(25, 75, vs, 400, 300);
  const b = g.worldToPixel(25, 75, vs, 800, 600);
  assertClose(b[0], a[0] * 2, 1e-9); assertClose(b[1], a[1] * 2, 1e-9);
  assertClose(g.metersPerPixel(vs), f.metersPerPixel(vs) / 2, 1e-9);
  const back = g.pixelToWorld(b[0], b[1], vs, 800, 600);
  assertClose(back[0], 25, 1e-6); assertClose(back[1], 75, 1e-6);
});

test('map frame returns null without georeferencing', () => {
  assert(makeMapFrame({ bounds: null, imageWidth: 10, imageHeight: 10, worldBounds: [0, 0, 1, 1], crs: 'EPSG:4326' }) === null);
});

test('map frame honours bearing and pitch (rotated / tilted map view)', () => {
  const f = makeMapFrame({
    bounds: [0, 0, 1000, 800], imageWidth: 1000, imageHeight: 800,
    worldBounds: [-75, -6, -74, -5], crs: 'EPSG:4326',
  });
  const flat = { longitude: -74.5, latitude: -5.5, zoom: 9 };
  const turned = { ...flat, bearing: 30 };
  const tilted = { ...flat, bearing: 30, pitch: 45 };
  // the scene-world centre stays at the screen centre under any bearing/pitch
  for (const vs of [flat, turned, tilted]) {
    const [sx, sy] = f.worldToPixel(500, 400, vs, 1000, 700);
    assertClose(sx, 500, 1e-6); assertClose(sy, 350, 1e-6);
  }
  // a point east of centre rotates up-screen with a positive bearing …
  const e0 = f.worldToPixel(700, 400, flat, 1000, 700);
  const e30 = f.worldToPixel(700, 400, turned, 1000, 700);
  assert(Math.abs(e0[1] - 350) < 1e-6 && e30[1] < 340, 'bearing rotates the grid on screen');
  // … and round-trips through the screen in every view
  for (const vs of [turned, tilted]) {
    const [wx, wy] = f.pixelToWorld(...f.worldToPixel(120, 710, vs, 1000, 700), vs, 1000, 700);
    assertClose(wx, 120, 1e-5); assertClose(wy, 710, 1e-5);
  }
});

await run();
