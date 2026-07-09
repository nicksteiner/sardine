#!/usr/bin/env node
/**
 * Unit tests for src/utils/annotation-io.js (W004).
 *
 * Builds a synthetic scene + one of each markup kind, then verifies:
 *   - output is well-formed GeoJSON (type, coordinates nesting)
 *   - properties schema (sardine:kind/schema, observer, method, created,
 *     confidence, sourceScene, style, measurements)
 *   - toGeoJSON → JSON round trip → fromGeoJSON reproduces state
 *     (world coords within 1e-9, pixel-derived ROI/transect within 0.5 px)
 *   - Y-flip correctness (row 0 = north = maxY)
 *   - unknown properties survive a round trip (forward compatibility)
 *
 * Run: node test/unit/annotation-io.test.mjs
 */

import assert from 'node:assert/strict';
import {
  annotationsToGeoJSON,
  geoJSONToAnnotations,
  isSardineMarkup,
  SARDINE_MARKUP_SCHEMA_VERSION,
} from '../../src/utils/annotation-io.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

// ─── Synthetic scene + one of each markup kind ───────────────────────────────

const scene = {
  file: 'NISAR_L2_GCOV_synthetic.h5',
  crs: 'EPSG:32614',                          // UTM 14N — deliberately NOT 4326
  bounds: [500000, 4000000, 510000, 4020000], // [w, s, e, n], 10 km × 20 km
  width: 1000,
  height: 2000,
};

const annotations = [
  {
    id: 'ann-1', type: 'arrow', color: 'orange',
    worldX: 501234.5, worldY: 4001234.25,     // tail
    worldX2: 505678.125, worldY2: 4015678.5,  // head
    text: 'flooded field',
  },
  {
    id: 'ann-2', type: 'text', color: 'green', fontSize: 15,
    worldX: 507000.0625, worldY: 4010000.03125,
    text: 'levee breach',
    size: 'large',            // upstream size preset — unknown at HEAD, must pass through
    futureField: 'kept',      // unknown object field, must pass through
  },
];

const roi = { left: 123, top: 456, width: 200, height: 100 }; // image pixels
const transectLine = { x0: 10, y0: 20, x1: 990, y1: 1980 };   // image pixels
const classRegions = [
  { name: 'open water', color: '#3ddc84', xMin: -22, xMax: -15, yMin: -25, yMax: -18 },
];
const roiProfile = { mean: -12.34, count: 20000, histMin: -30.5, histMax: -5.25, useDecibels: true };
const renderState = { colormap: 'grayscale', contrastMin: -25, contrastMax: 0 };

// Export → serialize → parse (proves it survives JSON) → import.
const fcRaw = annotationsToGeoJSON({ annotations, roi, transectLine, classRegions, scene, renderState, roiProfile });
const fc = JSON.parse(JSON.stringify(fcRaw));

console.log('\n━━━ annotation-io: well-formed GeoJSON ━━━');

test('schema version constant is 1', () => {
  assert.equal(SARDINE_MARKUP_SCHEMA_VERSION, 1);
});

test('FeatureCollection shape + collection-level members', () => {
  assert.equal(fc.type, 'FeatureCollection');
  assert.ok(Array.isArray(fc.features));
  assert.equal(fc.features.length, 5); // arrow, text, roi, transect, class-region
  assert.equal(fc['sardine:schema'], 1);
  assert.equal(fc['sardine:crs'], 'EPSG:32614');
  assert.deepEqual(fc['sardine:renderState'], renderState);
});

const byKind = {};
for (const f of fc.features) byKind[f.properties['sardine:kind']] = f;

test('every feature is a Feature with a properties object', () => {
  for (const f of fc.features) {
    assert.equal(f.type, 'Feature');
    assert.equal(typeof f.properties, 'object');
  }
});

test('geometry nesting: Point / LineString / Polygon / null', () => {
  const pt = byKind['annotation-text'].geometry;
  assert.equal(pt.type, 'Point');
  assert.ok(Array.isArray(pt.coordinates) && pt.coordinates.length === 2);
  assert.ok(pt.coordinates.every(Number.isFinite));

  for (const k of ['annotation-arrow', 'transect']) {
    const ls = byKind[k].geometry;
    assert.equal(ls.type, 'LineString', k);
    assert.equal(ls.coordinates.length, 2, k);
    for (const c of ls.coordinates) {
      assert.ok(Array.isArray(c) && c.length === 2 && c.every(Number.isFinite), k);
    }
  }

  const poly = byKind['roi'].geometry;
  assert.equal(poly.type, 'Polygon');
  assert.equal(poly.coordinates.length, 1);           // exterior ring only
  const ring = poly.coordinates[0];
  assert.equal(ring.length, 5);                        // closed ring
  assert.deepEqual(ring[0], ring[4]);                  // first == last
  for (const c of ring) {
    assert.ok(Array.isArray(c) && c.length === 2 && c.every(Number.isFinite));
  }

  assert.equal(byKind['class-region'].geometry, null); // dB feature space, not geography
});

console.log('\n━━━ annotation-io: properties schema ━━━');

test('all features carry the version-1 properties schema', () => {
  for (const f of fc.features) {
    const p = f.properties;
    assert.equal(p['sardine:schema'], 1);
    assert.equal(typeof p['sardine:kind'], 'string');
    assert.equal(typeof p.label, 'string');
    assert.equal(p.observer, 'human');
    assert.equal(p.method, 'manual');
    assert.equal(p.confidence, null);
    assert.ok(!Number.isNaN(Date.parse(p.created)), `created not ISO 8601: ${p.created}`);
    assert.deepEqual(p.sourceScene, {
      file: scene.file, crs: scene.crs, bounds: scene.bounds,
    });
    assert.equal(typeof p.style, 'object');
    assert.equal(typeof p.style.color, 'string');
    assert.equal(typeof p.style.size, 'string');
    assert.equal(typeof p.measurements, 'object');
  }
});

test('labels and styles map from state objects', () => {
  assert.equal(byKind['annotation-arrow'].properties.label, 'flooded field');
  assert.equal(byKind['annotation-arrow'].properties.style.color, 'orange');
  assert.equal(byKind['annotation-text'].properties.label, 'levee breach');
  assert.equal(byKind['annotation-text'].properties.style.size, 'large');
  assert.equal(byKind['annotation-text'].properties.style.fontSize, 15);
  assert.equal(byKind['class-region'].properties.label, 'open water');
  assert.equal(byKind['class-region'].properties.style.color, '#3ddc84');
});

test('ROI measurements embed the roiProfile stats', () => {
  assert.deepEqual(byKind['roi'].properties.measurements, {
    mean: -12.34, count: 20000, histMin: -30.5, histMax: -5.25, useDecibels: true,
  });
});

test('class-region carries featureSpace bounds in properties', () => {
  assert.deepEqual(byKind['class-region'].properties.featureSpace, {
    xMin: -22, xMax: -15, yMin: -25, yMax: -18,
  });
});

test('unknown annotation object fields land in sardine:extra', () => {
  assert.equal(byKind['annotation-text'].properties['sardine:extra'].futureField, 'kept');
});

console.log('\n━━━ annotation-io: coordinate conversion (Y-flip) ━━━');

test('ROI polygon honors row 0 = north = maxY', () => {
  const [w, s, e, n] = scene.bounds;
  const ring = byKind['roi'].geometry.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  const expWest = w + (roi.left / scene.width) * (e - w);
  const expEast = w + ((roi.left + roi.width) / scene.width) * (e - w);
  const expNorth = n - (roi.top / scene.height) * (n - s);
  const expSouth = n - ((roi.top + roi.height) / scene.height) * (n - s);
  assert.ok(Math.abs(Math.min(...xs) - expWest) < 1e-9);
  assert.ok(Math.abs(Math.max(...xs) - expEast) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - expNorth) < 1e-9, 'top row must map to max worldY (north)');
  assert.ok(Math.abs(Math.min(...ys) - expSouth) < 1e-9);
});

test('arrow LineString is tail → head in world coords', () => {
  const [tail, head] = byKind['annotation-arrow'].geometry.coordinates;
  assert.deepEqual(tail, [annotations[0].worldX, annotations[0].worldY]);
  assert.deepEqual(head, [annotations[0].worldX2, annotations[0].worldY2]);
});

test('transect endpoints convert pixel → world with Y-flip', () => {
  const [w, s, e, n] = scene.bounds;
  const [p0] = byKind['transect'].geometry.coordinates;
  assert.ok(Math.abs(p0[0] - (w + (transectLine.x0 / scene.width) * (e - w))) < 1e-9);
  assert.ok(Math.abs(p0[1] - (n - (transectLine.y0 / scene.height) * (n - s))) < 1e-9);
});

console.log('\n━━━ annotation-io: round trip ━━━');

const rt = geoJSONToAnnotations(fc, scene);

test('round trip returns all markup kinds', () => {
  assert.equal(rt.annotations.length, 2);
  assert.ok(rt.roi);
  assert.ok(rt.transectLine);
  assert.equal(rt.classRegions.length, 1);
  assert.ok(Array.isArray(rt.warnings));
});

test('annotations round-trip (world coords within 1e-9)', () => {
  const arrow = rt.annotations.find((a) => a.type === 'arrow');
  const text = rt.annotations.find((a) => a.type === 'text');
  assert.equal(arrow.id, 'ann-1');
  assert.equal(arrow.color, 'orange');
  assert.equal(arrow.text, 'flooded field');
  for (const [got, want] of [
    [arrow.worldX, annotations[0].worldX], [arrow.worldY, annotations[0].worldY],
    [arrow.worldX2, annotations[0].worldX2], [arrow.worldY2, annotations[0].worldY2],
    [text.worldX, annotations[1].worldX], [text.worldY, annotations[1].worldY],
  ]) {
    assert.ok(Math.abs(got - want) <= 1e-9, `${got} != ${want}`);
  }
  assert.equal(text.id, 'ann-2');
  assert.equal(text.color, 'green');
  assert.equal(text.text, 'levee breach');
  assert.equal(text.fontSize, 15);
  assert.equal(text.size, 'large');          // unknown-at-HEAD field passed through
  assert.equal(text.futureField, 'kept');    // arbitrary unknown field passed through
});

test('ROI round-trips within 0.5 px', () => {
  for (const k of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(rt.roi[k] - roi[k]) < 0.5, `roi.${k}: ${rt.roi[k]} vs ${roi[k]}`);
  }
});

test('transect round-trips within 0.5 px', () => {
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    assert.ok(Math.abs(rt.transectLine[k] - transectLine[k]) < 0.5,
      `transect.${k}: ${rt.transectLine[k]} vs ${transectLine[k]}`);
  }
});

test('class regions round-trip exactly', () => {
  const r = rt.classRegions[0];
  assert.equal(r.name, 'open water');
  assert.equal(r.color, '#3ddc84');
  assert.deepEqual(
    { xMin: r.xMin, xMax: r.xMax, yMin: r.yMin, yMax: r.yMax },
    { xMin: -22, xMax: -15, yMin: -25, yMax: -18 },
  );
});

test('non-4326 CRS produces a warning', () => {
  assert.ok(rt.warnings.some((w) => w.includes('EPSG:32614') && w.includes('EPSG:4326')),
    `warnings: ${JSON.stringify(rt.warnings)}`);
});

console.log('\n━━━ annotation-io: forward compatibility ━━━');

test('unknown feature properties survive export → import → export', () => {
  const fc2 = JSON.parse(JSON.stringify(fcRaw));
  const arrowF = fc2.features.find((f) => f.properties['sardine:kind'] === 'annotation-arrow');
  arrowF.properties['custom:note'] = 'field checked 2026-07-01';
  arrowF.properties.observer = 'agent';           // known key, non-default value
  arrowF.properties.confidence = 0.83;
  arrowF.properties.style.dash = 'dotted';        // unknown style key

  const imported = geoJSONToAnnotations(fc2, scene);
  const reexported = annotationsToGeoJSON({
    annotations: imported.annotations,
    roi: imported.roi,
    transectLine: imported.transectLine,
    classRegions: imported.classRegions,
    scene,
  });
  const arrowOut = reexported.features.find((f) => f.properties['sardine:kind'] === 'annotation-arrow');
  assert.equal(arrowOut.properties['custom:note'], 'field checked 2026-07-01');
  assert.equal(arrowOut.properties.observer, 'agent');
  assert.equal(arrowOut.properties.confidence, 0.83);
  assert.equal(arrowOut.properties.style.dash, 'dotted');
  assert.equal(arrowOut.properties.style.color, 'orange'); // known style keys still win
  // Original created timestamp is preserved, not regenerated
  assert.equal(arrowOut.properties.created, arrowF.properties.created);
});

test('second full round trip is stable (coords within tolerance)', () => {
  const again = annotationsToGeoJSON({ ...rt, scene, renderState, roiProfile });
  const rt2 = geoJSONToAnnotations(JSON.parse(JSON.stringify(again)), scene);
  for (const k of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(rt2.roi[k] - roi[k]) < 0.5);
  }
  assert.equal(rt2.annotations.length, 2);
  assert.equal(rt2.classRegions.length, 1);
});

console.log('\n━━━ annotation-io: robustness ━━━');

test('non-FeatureCollection input throws', () => {
  assert.throws(() => geoJSONToAnnotations({ type: 'Feature' }, scene));
  assert.throws(() => geoJSONToAnnotations(null, scene));
});

test('foreign GeoJSON features are skipped with warnings, not errors', () => {
  const mixed = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'plain overlay' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { 'sardine:kind': 'hologram', 'sardine:schema': 1 } },
      fc.features.find((f) => f.properties['sardine:kind'] === 'annotation-text'),
    ],
  };
  const res = geoJSONToAnnotations(mixed, scene);
  assert.equal(res.annotations.length, 1);
  assert.ok(res.warnings.some((w) => w.includes('sardine:kind')));
  assert.ok(res.warnings.some((w) => w.includes('hologram')));
});

test('ROI/transect import without scene dims warns and skips (annotations still load)', () => {
  const res = geoJSONToAnnotations(fc, { crs: scene.crs });
  assert.equal(res.roi, null);
  assert.equal(res.transectLine, null);
  assert.equal(res.annotations.length, 2);
  assert.ok(res.warnings.some((w) => w.includes('width')));
});

test('export without georeferencing falls back to pixel-identity bounds', () => {
  const pxScene = { file: 'x.tif', crs: null, width: 1000, height: 2000 };
  const out = annotationsToGeoJSON({ roi, scene: pxScene });
  const ring = out.features[0].geometry.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  assert.equal(Math.min(...xs), roi.left);
  assert.equal(Math.max(...xs), roi.left + roi.width);
  // identity bounds [0,0,W,H]: worldY = H - row
  assert.equal(Math.max(...ys), pxScene.height - roi.top);
  assert.equal(Math.min(...ys), pxScene.height - (roi.top + roi.height));
});

test('isSardineMarkup distinguishes markup from plain GeoJSON', () => {
  assert.equal(isSardineMarkup(fc), true);
  assert.equal(isSardineMarkup({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: null, properties: { a: 1 } }] }), false);
  assert.equal(isSardineMarkup({ type: 'Feature' }), false);
  assert.equal(isSardineMarkup(null), false);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
