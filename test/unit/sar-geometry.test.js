#!/usr/bin/env node

/**
 * Unit tests for src/utils/sar-geometry.js
 *
 * Covers:
 *  - WGS84 round-trip (llhToECEF → ecefToLLH)
 *  - Slant ↔ ground round-trip within 0.5 px on synthetic geometry
 *  - Analytic dihedral offset = h / tan(grazeAngle)
 *  - Shadow zone offset = h / tan(grazeAngle) away from sensor
 */

import {
  ecefToLLH,
  llhToECEF,
  slantToGroundPoint,
  groundPointToSlant,
  predictDihedralStrip,
  predictShadowZone,
  buildLocalGeometry,
} from '../../src/utils/sar-geometry.js';

// ─── Test infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertClose(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  if (diff > tol) {
    throw new Error(`${label}: expected ${expected}, got ${actual} (diff=${diff}, tol=${tol})`);
  }
}

function check(name, fn) {
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

const DEG = Math.PI / 180;

// ─── WGS84 round-trip tests ─────────────────────────────────────────────────

console.log('\n━━━ WGS84 coordinate conversions ━━━');

check('llhToECEF → ecefToLLH round-trip at equator', () => {
  const lat = 0, lon = 0, h = 0;
  const [x, y, z] = llhToECEF(lat, lon, h);
  const result = ecefToLLH(x, y, z);
  assertClose(result.lat, lat, 1e-12, 'lat');
  assertClose(result.lon, lon, 1e-12, 'lon');
  assertClose(result.h, h, 1e-3, 'h');
});

check('llhToECEF → ecefToLLH round-trip at pole', () => {
  const lat = 90 * DEG, lon = 0, h = 100;
  const [x, y, z] = llhToECEF(lat, lon, h);
  const result = ecefToLLH(x, y, z);
  assertClose(result.lat, lat, 1e-12, 'lat');
  assertClose(result.lon, lon, 1e-12, 'lon');
  assertClose(result.h, h, 1e-3, 'h');
});

check('llhToECEF → ecefToLLH round-trip at mid-latitude with altitude', () => {
  const lat = 45 * DEG, lon = -120 * DEG, h = 5000;
  const [x, y, z] = llhToECEF(lat, lon, h);
  const result = ecefToLLH(x, y, z);
  assertClose(result.lat, lat, 1e-12, 'lat');
  assertClose(result.lon, lon, 1e-12, 'lon');
  assertClose(result.h, h, 1e-3, 'h');
});

check('llhToECEF → ecefToLLH round-trip at high altitude (LEO orbit)', () => {
  const lat = 30 * DEG, lon = 60 * DEG, h = 700000;
  const [x, y, z] = llhToECEF(lat, lon, h);
  const result = ecefToLLH(x, y, z);
  assertClose(result.lat, lat, 1e-10, 'lat');
  assertClose(result.lon, lon, 1e-10, 'lon');
  assertClose(result.h, h, 1e-2, 'h');
});

check('ecefToLLH → llhToECEF round-trip from known ECEF', () => {
  // Somewhere on the equator, known position
  const x = 6378137, y = 0, z = 0;
  const llh = ecefToLLH(x, y, z);
  assertClose(llh.lat, 0, 1e-12, 'lat');
  assertClose(llh.lon, 0, 1e-12, 'lon');
  assertClose(llh.h, 0, 1e-3, 'h');
  const [x2, y2, z2] = llhToECEF(llh.lat, llh.lon, llh.h);
  assertClose(x2, x, 1e-3, 'x');
  assertClose(y2, y, 1e-3, 'y');
  assertClose(z2, z, 1e-3, 'z');
});

// ─── Slant ↔ Ground round-trip tests ────────────────────────────────────────

console.log('\n━━━ Slant ↔ Ground projection ━━━');

// Build a synthetic geometry: right-looking, 45° graze, north-flying, at (35°N, -118°W)
const testGeom = buildLocalGeometry(
  35 * DEG, -118 * DEG, 0,
  { grazeAngleDeg: 45, sideOfTrack: 'R', azimuthAngleDeg: 0, rowSS: 1, colSS: 1, srpRow: 500, srpCol: 500 }
);

check('slantToGround → groundToSlant round-trip at SRP', () => {
  const ground = slantToGroundPoint(500, 500, testGeom, null);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant.row, 500, 0.5, 'row');
  assertClose(slant.col, 500, 0.5, 'col');
});

check('slantToGround → groundToSlant round-trip offset +100 range', () => {
  const ground = slantToGroundPoint(600, 500, testGeom, null);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant.row, 600, 0.5, 'row');
  assertClose(slant.col, 500, 0.5, 'col');
});

check('slantToGround → groundToSlant round-trip offset +100 azimuth', () => {
  const ground = slantToGroundPoint(500, 600, testGeom, null);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant.row, 500, 0.5, 'row');
  assertClose(slant.col, 600, 0.5, 'col');
});

check('slantToGround → groundToSlant round-trip offset +50/+50', () => {
  const ground = slantToGroundPoint(550, 550, testGeom, null);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant.row, 550, 0.5, 'row');
  assertClose(slant.col, 550, 0.5, 'col');
});

check('groundPointToSlant → slantToGround round-trip', () => {
  // Start from a known ground point near SRP
  const lat = 35.001 * DEG, lon = -117.999 * DEG, h = 0;
  const slant = groundPointToSlant(lat, lon, h, testGeom);
  const ground = slantToGroundPoint(slant.row, slant.col, testGeom, null);
  const slant2 = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant2.row, slant.row, 0.5, 'row');
  assertClose(slant2.col, slant.col, 0.5, 'col');
});

check('slantToGround → groundToSlant with flat DEM sampler', () => {
  const flatDEM = () => 0;
  const ground = slantToGroundPoint(550, 520, testGeom, flatDEM);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, testGeom);
  assertClose(slant.row, 550, 0.5, 'row');
  assertClose(slant.col, 520, 0.5, 'col');
});

check('slantToGround → groundToSlant with constant-height DEM', () => {
  const constDEM = () => 500; // 500m plateau
  const geom500 = buildLocalGeometry(
    35 * DEG, -118 * DEG, 500,
    { grazeAngleDeg: 45, sideOfTrack: 'R', azimuthAngleDeg: 0, rowSS: 1, colSS: 1, srpRow: 500, srpCol: 500 }
  );
  const ground = slantToGroundPoint(550, 520, geom500, constDEM);
  const slant = groundPointToSlant(ground.lat, ground.lon, ground.h, geom500);
  assertClose(slant.row, 550, 0.5, 'row');
  assertClose(slant.col, 520, 0.5, 'col');
});

// ─── Dihedral prediction tests ──────────────────────────────────────────────

console.log('\n━━━ Dihedral & Shadow prediction ━━━');

check('dihedral offset matches h/tan(grazeAngle) for vertical wall', () => {
  const grazeAngleDeg = 45;
  const geom = buildLocalGeometry(
    35 * DEG, -118 * DEG, 0,
    { grazeAngleDeg, sideOfTrack: 'R', azimuthAngleDeg: 0, rowSS: 1, colSS: 1, srpRow: 500, srpCol: 500 }
  );

  const wallHeight = 10; // meters
  const expectedOffset = wallHeight / Math.tan(grazeAngleDeg * DEG); // 10 / tan(45°) = 10 m → 10 px

  // Create a simple wall facing the sensor (east-facing for right-looking, north-flying)
  const baseLat = 35 * DEG;
  const baseLon = -118 * DEG;
  const dLat = 0.00001; // small wall segment

  const building = {
    footprint: [
      { lat: baseLat - dLat, lon: baseLon },
      { lat: baseLat + dLat, lon: baseLon },
    ],
    height: wallHeight,
    baseElev: 0,
  };

  const strips = predictDihedralStrip(building, geom);
  assert(strips.length > 0, 'Should predict at least one dihedral strip');

  // The offset should be h/tan(graze) in pixels, toward sensor (negative row)
  const strip = strips[0];
  assertClose(Math.abs(strip.offsetRow), expectedOffset, 0.5,
    'dihedral offset (px)');
  assert(strip.offsetRow < 0, 'dihedral should be toward sensor (negative row offset)');
  assertClose(strip.offsetCol, 0, 0.1, 'dihedral col offset should be ~0');
});

check('dihedral offset scales with wall height', () => {
  const grazeAngleDeg = 30;
  const geom = buildLocalGeometry(
    35 * DEG, -118 * DEG, 0,
    { grazeAngleDeg, sideOfTrack: 'R', azimuthAngleDeg: 0, rowSS: 1, colSS: 1, srpRow: 500, srpCol: 500 }
  );

  const baseLat = 35 * DEG;
  const baseLon = -118 * DEG;
  const dLat = 0.00001;

  for (const h of [5, 10, 20]) {
    const building = {
      footprint: [
        { lat: baseLat - dLat, lon: baseLon },
        { lat: baseLat + dLat, lon: baseLon },
      ],
      height: h,
      baseElev: 0,
    };
    const strips = predictDihedralStrip(building, geom);
    assert(strips.length > 0, `h=${h}: should have strips`);
    const expected = h / Math.tan(grazeAngleDeg * DEG);
    assertClose(Math.abs(strips[0].offsetRow), expected, 0.5, `h=${h} offset`);
  }
});

check('shadow offset = h/tan(grazeAngle) away from sensor', () => {
  const grazeAngleDeg = 45;
  const geom = buildLocalGeometry(
    35 * DEG, -118 * DEG, 0,
    { grazeAngleDeg, sideOfTrack: 'R', azimuthAngleDeg: 0, rowSS: 1, colSS: 1, srpRow: 500, srpCol: 500 }
  );

  const wallHeight = 10;
  const expectedOffset = wallHeight / Math.tan(grazeAngleDeg * DEG);

  const baseLat = 35 * DEG;
  const baseLon = -118 * DEG;
  const dLat = 0.00001;

  const building = {
    footprint: [
      { lat: baseLat - dLat, lon: baseLon },
      { lat: baseLat + dLat, lon: baseLon },
    ],
    height: wallHeight,
    baseElev: 0,
  };

  const zones = predictShadowZone(building, geom);
  assert(zones.length > 0, 'Should predict at least one shadow zone');
  const zone = zones[0];
  assertClose(Math.abs(zone.offsetRow), expectedOffset, 0.5, 'shadow offset (px)');
  assert(zone.offsetRow > 0, 'shadow should be away from sensor (positive row offset)');
});

check('buildLocalGeometry produces orthogonal row/col unit vectors', () => {
  const geom = buildLocalGeometry(
    35 * DEG, -118 * DEG, 0,
    { grazeAngleDeg: 45, sideOfTrack: 'R', azimuthAngleDeg: 0 }
  );
  const d = geom.rowUnitECEF[0] * geom.colUnitECEF[0]
          + geom.rowUnitECEF[1] * geom.colUnitECEF[1]
          + geom.rowUnitECEF[2] * geom.colUnitECEF[2];
  assertClose(d, 0, 1e-10, 'dot(row, col)');

  // Both should be unit vectors
  const rowLen = Math.sqrt(geom.rowUnitECEF.reduce((s, v) => s + v * v, 0));
  const colLen = Math.sqrt(geom.colUnitECEF.reduce((s, v) => s + v * v, 0));
  assertClose(rowLen, 1, 1e-10, '|rowUnit|');
  assertClose(colLen, 1, 1e-10, '|colUnit|');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━`);
process.exit(failed > 0 ? 1 : 0);
