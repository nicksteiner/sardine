#!/usr/bin/env node

/**
 * Unit tests for src/utils/sar-geometry.js
 *
 * Covers:
 *   - WGS84 round-trip (llhToECEF → ecefToLLH)
 *   - Slant ↔ ground round-trip within 0.5 px on synthetic geometry
 *   - Analytic dihedral offset matches h / tan(grazeAngle)
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

function assertClose(actual, expected, tol, label = '') {
  const diff = Math.abs(actual - expected);
  if (diff > tol) {
    throw new Error(`${label} expected ${expected}, got ${actual} (diff=${diff}, tol=${tol})`);
  }
}

// ─── Build a synthetic geometry for testing ──────────────────────────────────

function makeSyntheticGeometry() {
  // Sensor at ~700 km altitude, 40° graze angle, left-looking
  const sceneCenter = { lat: 34.0, lon: -118.0, h: 0 };
  const scnECEF = llhToECEF(sceneCenter.lat, sceneCenter.lon, 0);

  // Place ARP roughly 700 km above and to the side of scene center
  // For a 40° graze angle, the ARP is offset in range and up
  const altitude = 700000; // 700 km
  const grazeAngle = 40 * Math.PI / 180;
  const groundRange = altitude / Math.tan(grazeAngle);

  // Approximate ARP position: move up + offset in cross-track
  // Use a simple geometry: ARP above and east of scene center
  const latR = sceneCenter.lat * Math.PI / 180;
  const lonR = sceneCenter.lon * Math.PI / 180;

  // East direction at scene center
  const east = [-Math.sin(lonR), Math.cos(lonR), 0];
  // North direction
  const north = [-Math.sin(latR) * Math.cos(lonR), -Math.sin(latR) * Math.sin(lonR), Math.cos(latR)];
  // Up direction
  const up = [Math.cos(latR) * Math.cos(lonR), Math.cos(latR) * Math.sin(lonR), Math.sin(latR)];

  const arpX = scnECEF.x + up[0] * altitude + east[0] * groundRange;
  const arpY = scnECEF.y + up[1] * altitude + east[1] * groundRange;
  const arpZ = scnECEF.z + up[2] * altitude + east[2] * groundRange;

  return buildLocalGeometry({
    arpECEF: { x: arpX, y: arpY, z: arpZ },
    sceneCenter,
    rowSpacing: 5.0,   // 5 m range spacing
    colSpacing: 5.0,   // 5 m azimuth spacing
    nRows: 1000,
    nCols: 1000,
    sideOfTrack: 1,     // left-looking
  });
}

// ─── WGS84 Round-trip Tests ─────────────────────────────────────────────────

console.log('\n━━━ WGS84 Round-trip ━━━');

check('LLH → ECEF → LLH round-trip (equator)', () => {
  const lat = 0, lon = 0, h = 0;
  const ecef = llhToECEF(lat, lon, h);
  const llh = ecefToLLH(ecef.x, ecef.y, ecef.z);
  assertClose(llh.lat, lat, 1e-10, 'lat');
  assertClose(llh.lon, lon, 1e-10, 'lon');
  assertClose(llh.h, h, 1e-3, 'h');
});

check('LLH → ECEF → LLH round-trip (mid-latitude)', () => {
  const lat = 45.0, lon = -90.0, h = 500.0;
  const ecef = llhToECEF(lat, lon, h);
  const llh = ecefToLLH(ecef.x, ecef.y, ecef.z);
  assertClose(llh.lat, lat, 1e-10, 'lat');
  assertClose(llh.lon, lon, 1e-10, 'lon');
  assertClose(llh.h, h, 1e-3, 'h');
});

check('LLH → ECEF → LLH round-trip (pole)', () => {
  const lat = 90.0, lon = 0.0, h = 1000.0;
  const ecef = llhToECEF(lat, lon, h);
  const llh = ecefToLLH(ecef.x, ecef.y, ecef.z);
  assertClose(llh.lat, lat, 1e-10, 'lat');
  assertClose(llh.h, h, 1e-3, 'h');
});

check('LLH → ECEF → LLH round-trip (high altitude)', () => {
  const lat = -33.86, lon = 151.21, h = 35786000; // geostationary
  const ecef = llhToECEF(lat, lon, h);
  const llh = ecefToLLH(ecef.x, ecef.y, ecef.z);
  assertClose(llh.lat, lat, 1e-8, 'lat');
  assertClose(llh.lon, lon, 1e-8, 'lon');
  assertClose(llh.h, h, 0.1, 'h');
});

check('ECEF origin (0,0,0) → valid LLH', () => {
  // Center of Earth — degenerate but should not crash
  const llh = ecefToLLH(0, 0, 0);
  // Should return some value without NaN
  if (Number.isNaN(llh.lat) || Number.isNaN(llh.lon)) {
    throw new Error('NaN returned for degenerate input');
  }
});

check('Known ECEF → LLH (Washington DC)', () => {
  // Washington DC approx: 38.9°N, -77.0°W, h=0
  const ecef = llhToECEF(38.9, -77.0, 0);
  // Just verify ECEF values are reasonable
  if (Math.abs(ecef.x) < 1e6 || Math.abs(ecef.y) < 1e6 || Math.abs(ecef.z) < 1e6) {
    throw new Error('ECEF values too small');
  }
  // And round-trip
  const llh = ecefToLLH(ecef.x, ecef.y, ecef.z);
  assertClose(llh.lat, 38.9, 1e-10, 'lat');
  assertClose(llh.lon, -77.0, 1e-10, 'lon');
});

// ─── Slant ↔ Ground Round-trip Tests ─────────────────────────────────────────

console.log('\n━━━ Slant ↔ Ground Round-trip ━━━');

const geom = makeSyntheticGeometry();

check('Scene center round-trips exactly', () => {
  const row = 500, col = 500; // center pixel
  const gnd = slantToGroundPoint(row, col, geom);
  const sl = groundPointToSlant(gnd.lat, gnd.lon, gnd.h, geom);
  assertClose(sl.row, row, 0.5, 'row');
  assertClose(sl.col, col, 0.5, 'col');
});

check('Off-center pixel round-trips within 0.5 px', () => {
  const row = 300, col = 700;
  const gnd = slantToGroundPoint(row, col, geom);
  const sl = groundPointToSlant(gnd.lat, gnd.lon, gnd.h, geom);
  assertClose(sl.row, row, 0.5, 'row');
  assertClose(sl.col, col, 0.5, 'col');
});

check('Corner pixel round-trips within 0.5 px', () => {
  const row = 50, col = 50;
  const gnd = slantToGroundPoint(row, col, geom);
  const sl = groundPointToSlant(gnd.lat, gnd.lon, gnd.h, geom);
  assertClose(sl.row, row, 0.5, 'row');
  assertClose(sl.col, col, 0.5, 'col');
});

check('Opposite corner pixel round-trips within 0.5 px', () => {
  const row = 950, col = 950;
  const gnd = slantToGroundPoint(row, col, geom);
  const sl = groundPointToSlant(gnd.lat, gnd.lon, gnd.h, geom);
  assertClose(sl.row, row, 0.5, 'row');
  assertClose(sl.col, col, 0.5, 'col');
});

check('groundPointToSlant(slantToGroundPoint(r,c)) ≈ (r,c) for 10 random pixels', () => {
  // Use seeded-like deterministic values
  const pixels = [
    [100, 200], [250, 750], [400, 400], [600, 300], [800, 900],
    [150, 850], [500, 100], [700, 500], [350, 650], [900, 200],
  ];
  for (const [row, col] of pixels) {
    const gnd = slantToGroundPoint(row, col, geom);
    const sl = groundPointToSlant(gnd.lat, gnd.lon, gnd.h, geom);
    assertClose(sl.row, row, 0.5, `row@(${row},${col})`);
    assertClose(sl.col, col, 0.5, `col@(${row},${col})`);
  }
});

// ─── Dihedral Prediction Tests ───────────────────────────────────────────────

console.log('\n━━━ Dihedral & Shadow Predictors ━━━');

check('Dihedral offset matches h/tan(grazeAngle) for vertical wall', () => {
  const h = 20; // 20m wall
  const expectedGroundOffset = h / Math.tan(geom.grazeAngle); // meters

  // Place wall at scene center
  const wall = {
    footprint: [{ lat: geom.sceneCenterLLH.lat, lon: geom.sceneCenterLLH.lon }],
    height: h,
    baseElev: 0,
  };

  const base = groundPointToSlant(
    geom.sceneCenterLLH.lat, geom.sceneCenterLLH.lon, 0, geom
  );
  const dihedral = predictDihedralStrip(wall, geom);

  // The dihedral offset in pixels
  const rowDiff = Math.abs(dihedral[0].row - base.row);

  // Expected offset in pixels: groundOffset * cos(graze) / rowSpacing
  const expectedPixelOffset = expectedGroundOffset * Math.cos(geom.grazeAngle) / geom.rowSpacing;

  assertClose(rowDiff, expectedPixelOffset, 0.1, 'dihedral offset (px)');

  // Also verify col is unchanged
  assertClose(dihedral[0].col, base.col, 0.01, 'dihedral col');
});

check('Shadow offset matches h/tan(grazeAngle) for vertical wall', () => {
  const h = 20;
  const expectedGroundOffset = h / Math.tan(geom.grazeAngle);

  const wall = {
    footprint: [{ lat: geom.sceneCenterLLH.lat, lon: geom.sceneCenterLLH.lon }],
    height: h,
    baseElev: 0,
  };

  const base = groundPointToSlant(
    geom.sceneCenterLLH.lat, geom.sceneCenterLLH.lon, 0, geom
  );
  const shadow = predictShadowZone(wall, geom);

  const rowDiff = Math.abs(shadow[0].row - base.row);
  const expectedPixelOffset = expectedGroundOffset * Math.cos(geom.grazeAngle) / geom.rowSpacing;

  assertClose(rowDiff, expectedPixelOffset, 0.1, 'shadow offset (px)');
  assertClose(shadow[0].col, base.col, 0.01, 'shadow col');
});

check('Dihedral and shadow offsets are in opposite directions', () => {
  const h = 15;
  const wall = {
    footprint: [{ lat: geom.sceneCenterLLH.lat, lon: geom.sceneCenterLLH.lon }],
    height: h,
    baseElev: 0,
  };

  const base = groundPointToSlant(
    geom.sceneCenterLLH.lat, geom.sceneCenterLLH.lon, 0, geom
  );
  const dihedral = predictDihedralStrip(wall, geom);
  const shadow = predictShadowZone(wall, geom);

  const dihedralDir = dihedral[0].row - base.row;
  const shadowDir = shadow[0].row - base.row;

  // They should be in opposite directions
  if (dihedralDir * shadowDir >= 0) {
    throw new Error(`Dihedral (${dihedralDir}) and shadow (${shadowDir}) should be in opposite directions`);
  }
});

check('buildLocalGeometry produces valid graze angle (0°–90°)', () => {
  const deg = geom.grazeAngle * 180 / Math.PI;
  if (deg <= 0 || deg >= 90) {
    throw new Error(`Graze angle ${deg}° out of expected range`);
  }
});

check('Multi-vertex footprint returns same number of vertices', () => {
  const wall = {
    footprint: [
      { lat: 34.0, lon: -118.0 },
      { lat: 34.0, lon: -117.999 },
      { lat: 34.001, lon: -117.999 },
      { lat: 34.001, lon: -118.0 },
    ],
    height: 10,
    baseElev: 0,
  };

  const dihedral = predictDihedralStrip(wall, geom);
  const shadow = predictShadowZone(wall, geom);

  if (dihedral.length !== 4) throw new Error(`Expected 4 dihedral vertices, got ${dihedral.length}`);
  if (shadow.length !== 4) throw new Error(`Expected 4 shadow vertices, got ${shadow.length}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━\n`);
process.exit(failed > 0 ? 1 : 0);
