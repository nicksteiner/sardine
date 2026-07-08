/**
 * W005 — export provenance sidecar tests.
 *
 * Run with:  node test/unit/export-sidecar.test.mjs
 *      or:  node --test test/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildExportSidecar,
  serializeSidecar,
  EXPORT_SIDECAR_VERSION,
  SARDINE_VERSION,
} from '../../src/utils/export-sidecar.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Synthetic NISAR-style identification: 14 fields, mixed types,
// including fields SARdine itself never interprets (opaque pass-through).
const IDENTIFICATION = {
  missionId: 'NISAR',
  productType: 'GCOV',
  absoluteOrbitNumber: 4213,
  trackNumber: 147,
  frameNumber: 55,
  lookDirection: 'Left',
  orbitPassDirection: 'Ascending',
  zeroDopplerStartTime: '2026-05-01T13:45:12.000000Z',
  zeroDopplerEndTime: '2026-05-01T13:45:27.000000Z',
  processingDateTime: '2026-05-03T02:11:09.000000Z',
  productVersion: '1.1',
  isGeocoded: true,
  boundingPolygon: 'POLYGON ((-122.1 37.2, -121.4 37.2, -121.4 37.9, -122.1 37.9, -122.1 37.2))',
  listOfFrequencies: ['A'],
};

const BOUNDS = [-122.1, 37.2, -121.4, 37.9]; // [w, s, e, n]

function buildRendered() {
  return buildExportSidecar({
    scene: {
      file: 'NISAR_L2_PR_GCOV_001_147_A_055_4020_HH_20260501T134512.h5',
      productType: 'GCOV',
      identification: IDENTIFICATION,
    },
    renderState: {
      mode: 'rendered',
      useDecibels: true,
      contrastLimits: [-25, 0],
      colormap: 'grayscale',
      stretchMode: 'linear',
      gamma: 1.0,
      compositeId: null,
    },
    exportParams: { crs: 'EPSG:4326', bounds: BOUNDS, width: 4068, height: 4176, multilook: 4 },
  });
}

test('sidecar contains ALL identification fields verbatim (opaque pass-through)', () => {
  const sidecar = buildRendered();
  const keys = Object.keys(IDENTIFICATION);
  assert.ok(keys.length >= 10, 'synthetic identification must have 10+ fields');
  for (const key of keys) {
    assert.ok(key in sidecar.identification, `missing identification field: ${key}`);
    assert.deepEqual(sidecar.identification[key], IDENTIFICATION[key],
      `identification.${key} not passed through verbatim`);
  }
  // No fields invented or renamed either
  assert.deepEqual(Object.keys(sidecar.identification).sort(), keys.sort());
});

test('sidecar serializes to valid JSON and survives a round trip', () => {
  const sidecar = buildRendered();
  const json = serializeSidecar(sidecar);
  const parsed = JSON.parse(json); // throws if invalid
  assert.deepEqual(parsed.identification, IDENTIFICATION);
  assert.deepEqual(parsed.georeference.bounds, BOUNDS);
});

test('version, software, and derived_from are present', () => {
  const sidecar = buildRendered();
  assert.equal(sidecar['sardine:export'], EXPORT_SIDECAR_VERSION);
  assert.equal(EXPORT_SIDECAR_VERSION, 1);
  assert.equal(sidecar.software, `SARdine ${SARDINE_VERSION}`);
  assert.ok(sidecar.derived_from, 'derived_from missing');
  assert.equal(sidecar.derived_from.file,
    'NISAR_L2_PR_GCOV_001_147_A_055_4020_HH_20260501T134512.h5');
  assert.equal(sidecar.derived_from.productType, 'GCOV');
  assert.ok(!Number.isNaN(Date.parse(sidecar.created)), 'created is not a parseable timestamp');
});

test('SARDINE_VERSION stays in sync with package.json', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  assert.equal(SARDINE_VERSION, pkg.version,
    `export-sidecar.js SARDINE_VERSION (${SARDINE_VERSION}) drifted from package.json (${pkg.version})`);
});

test('georeference carries correct bounds, CRS, dimensions, multilook', () => {
  const sidecar = buildRendered();
  assert.equal(sidecar.georeference.crs, 'EPSG:4326');
  assert.deepEqual(sidecar.georeference.bounds, BOUNDS);
  assert.equal(sidecar.georeference.width, 4068);
  assert.equal(sidecar.georeference.height, 4176);
  assert.equal(sidecar.georeference.multilook, 4);
});

test('numeric EPSG codes are normalized to EPSG:XXXX strings', () => {
  const sidecar = buildExportSidecar({
    scene: { identification: IDENTIFICATION },
    renderState: { mode: 'raw' },
    exportParams: { crs: 32610, bounds: BOUNDS, width: 10, height: 10, multilook: 1 },
  });
  assert.equal(sidecar.georeference.crs, 'EPSG:32610');
});

test('rendered exports carry the full render block', () => {
  const sidecar = buildRendered();
  assert.deepEqual(sidecar.render, {
    mode: 'rendered',
    useDecibels: true,
    contrastLimits: [-25, 0],
    colormap: 'grayscale',
    stretchMode: 'linear',
    gamma: 1.0,
    compositeId: null,
  });
});

test('raw exports carry only mode in the render block', () => {
  const sidecar = buildExportSidecar({
    scene: { file: 'scene.h5', identification: IDENTIFICATION },
    renderState: { mode: 'raw', colormap: 'viridis' /* must be ignored */ },
    exportParams: { crs: 'EPSG:4326', bounds: BOUNDS, width: 100, height: 100, multilook: 8 },
  });
  assert.deepEqual(sidecar.render, { mode: 'raw' });
  assert.equal(sidecar.georeference.multilook, 8);
});

test('productType inferred from identification, then filename', () => {
  // From identification
  const a = buildExportSidecar({ scene: { file: 'x.h5', identification: { productType: 'GUNW' } } });
  assert.equal(a.derived_from.productType, 'GUNW');
  // From filename when no identification (COG path)
  const b = buildExportSidecar({ scene: { file: 'https://host/scene.tif?token=abc', identification: null } });
  assert.equal(b.derived_from.productType, 'COG');
  const c = buildExportSidecar({ scene: { file: 'scene.ntf' } });
  assert.equal(c.derived_from.productType, 'NITF');
  // Unknown → null, and identification stays null (not {})
  const d = buildExportSidecar({ scene: { file: 'mystery.bin' } });
  assert.equal(d.derived_from.productType, null);
  assert.equal(d.identification, null);
});

test('hostile metadata values serialize safely (BigInt, typed arrays, NaN)', () => {
  const sidecar = buildExportSidecar({
    scene: {
      file: 'weird.h5',
      identification: {
        ...IDENTIFICATION,
        absoluteOrbitNumber: 4213n,                    // BigInt from HDF5 int64
        cornerLats: new Float32Array([37.2, 37.9]),    // typed array
        badStat: NaN,                                  // non-finite
      },
    },
    renderState: { mode: 'raw' },
    exportParams: { crs: 'EPSG:4326', bounds: BOUNDS, width: 1, height: 1, multilook: 1 },
  });
  const parsed = JSON.parse(serializeSidecar(sidecar)); // must not throw
  assert.equal(parsed.identification.absoluteOrbitNumber, 4213);
  assert.deepEqual(parsed.identification.cornerLats, [37.20000076293945, 37.900001525878906]);
  assert.equal(parsed.identification.badStat, null);
  // The verbatim fields are still intact
  assert.equal(parsed.identification.missionId, 'NISAR');
});
