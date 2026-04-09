#!/usr/bin/env node
/**
 * Unit tests for src/utils/sicd-projection.js
 *
 * Uses a synthetic SICD-like metadata object with orthonormal Grid unit
 * vectors built from a scene at 30 deg graze, left-looking, so we can
 * assert exact pixel values without a real NITF.
 */

import {
  buildSICDProjection,
  groundToImage,
  groundToImageBulk,
  imageToGround,
  imageBboxFromProjection,
  llhToEcef,
  ecefToLlh,
} from '../../src/utils/sicd-projection.js';

let passed = 0, failed = 0;

function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
function assertClose(a, b, tol, label = '') {
  const d = Math.abs(a - b);
  if (!(d <= tol)) throw new Error(`${label}: |${a} - ${b}| = ${d} > ${tol}`);
}

// ─── Build a synthetic SICD for a scene at (0,0), 30° graze, left-looking ───

function buildSyntheticSICD() {
  // SCP at (lat=0, lon=0, h=0)
  const scpEcef = llhToEcef(0, 0, 0);

  // Local ENU at SCP:
  //   East  = (-sinLon, cosLon, 0) = (0, 1, 0)
  //   North = (-sinLat cosLon, -sinLat sinLon, cosLat) = (0, 0, 1)
  //   Up    = (cosLat cosLon, cosLat sinLon, sinLat) = (1, 0, 0)
  const E = [0, 1, 0];
  const N = [0, 0, 1];
  const U = [1, 0, 0];

  // 30° graze, sensor to the East (azimuth = North, range increases East+Up).
  // Range unit vector (from scene toward sensor in slant plane):
  //   rowU = cos(graze)*E + sin(graze)*U
  // Azimuth unit vector:
  //   colU = N
  const graze = 30 * Math.PI / 180;
  const cg = Math.cos(graze), sg = Math.sin(graze);
  const rowU = [cg * E[0] + sg * U[0], cg * E[1] + sg * U[1], cg * E[2] + sg * U[2]];
  const colU = [N[0], N[1], N[2]];

  return {
    scp: {
      lat: 0, lon: 0, hae: 0,
      ecef: { x: scpEcef[0], y: scpEcef[1], z: scpEcef[2] },
    },
    scpPixel: { row: 5000, col: 5000 },
    firstRow: 0,
    firstCol: 0,
    nrows: 10000,
    ncols: 10000,
    geometry: {
      rowUVect: { x: rowU[0], y: rowU[1], z: rowU[2] },
      colUVect: { x: colU[0], y: colU[1], z: colU[2] },
      rowSS: 1.0, // 1 m/pixel slant-range spacing
      colSS: 1.0, // 1 m/pixel azimuth spacing
      sideOfTrack: 'L',
      grazeAng: 30,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n── SICD projection tests ──');

check('SCP maps to its own pixel', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  const { row, col } = groundToImage(0, 0, 0, proj);
  assertClose(row, 5000, 1e-6, 'row');
  assertClose(col, 5000, 1e-6, 'col');
});

check('Step of rowSS along rowU advances row by exactly 1', () => {
  const sicd = buildSyntheticSICD();
  const proj = buildSICDProjection(sicd);
  // Move 1 meter in the rowU direction from SCP in ECEF, then convert to LLH.
  const x = proj.scpX + proj.rowUx * proj.rowSS;
  const y = proj.scpY + proj.rowUy * proj.rowSS;
  const z = proj.scpZ + proj.rowUz * proj.rowSS;
  const llh = ecefToLlh(x, y, z);
  const { row, col } = groundToImage(llh.lat, llh.lon, llh.h, proj);
  assertClose(row, 5001, 1e-6, 'row');
  assertClose(col, 5000, 1e-6, 'col');
});

check('Step of colSS along colU advances col by exactly 1', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  const x = proj.scpX + proj.colUx * proj.colSS;
  const y = proj.scpY + proj.colUy * proj.colSS;
  const z = proj.scpZ + proj.colUz * proj.colSS;
  const llh = ecefToLlh(x, y, z);
  const { row, col } = groundToImage(llh.lat, llh.lon, llh.h, proj);
  assertClose(row, 5000, 1e-6, 'row');
  assertClose(col, 5001, 1e-6, 'col');
});

check('firstRow/firstCol chip offset shifts pixel output', () => {
  const sicd = buildSyntheticSICD();
  sicd.firstRow = 100;
  sicd.firstCol = 200;
  const proj = buildSICDProjection(sicd);
  const { row, col } = groundToImage(0, 0, 0, proj);
  assertClose(row, 5000 - 100, 1e-6, 'row');
  assertClose(col, 5000 - 200, 1e-6, 'col');
});

check('imageToGround(groundToImage(p)) round-trip near SCP', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  // Pick a point ~1 km east, 500 m north at h=0
  const { lat: lat0, lon: lon0, h: h0 } = ecefToLlh(
    proj.scpX + 1000 * proj.rowUx + 500 * proj.colUx,
    proj.scpY + 1000 * proj.rowUy + 500 * proj.colUy,
    proj.scpZ + 1000 * proj.rowUz + 500 * proj.colUz,
  );
  const { row, col } = groundToImage(lat0, lon0, h0, proj);
  const back = imageToGround(row, col, proj);
  assertClose(back.lat, lat0, 1e-9, 'lat');
  assertClose(back.lon, lon0, 1e-9, 'lon');
  assertClose(back.h, h0, 1e-3, 'h'); // meter-level due to plane vs ellipsoid
});

check('Bulk matches scalar on 10k random points', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  const N = 10000;
  const lats = new Float64Array(N);
  const lons = new Float64Array(N);
  // Random points within ~5 km of SCP
  for (let i = 0; i < N; i++) {
    lats[i] = (Math.random() - 0.5) * 0.1; // ±5.5 km lat
    lons[i] = (Math.random() - 0.5) * 0.1;
  }
  const bulk = groundToImageBulk(lons, lats, 0, proj);
  let maxErr = 0;
  for (let i = 0; i < N; i++) {
    const s = groundToImage(lats[i], lons[i], 0, proj);
    maxErr = Math.max(maxErr, Math.abs(bulk[2 * i] - s.row));
    maxErr = Math.max(maxErr, Math.abs(bulk[2 * i + 1] - s.col));
  }
  if (maxErr > 1e-3) throw new Error(`max bulk-vs-scalar err = ${maxErr} px`);
});

check('Bulk throughput: 100k points under 50 ms', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  const N = 100000;
  const lats = new Float64Array(N);
  const lons = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lats[i] = (Math.random() - 0.5) * 0.1;
    lons[i] = (Math.random() - 0.5) * 0.1;
  }
  const out = new Float32Array(2 * N);
  // warm up
  groundToImageBulk(lons, lats, 0, proj, out);
  const t0 = performance.now();
  groundToImageBulk(lons, lats, 0, proj, out);
  const dt = performance.now() - t0;
  console.log(`        (100k points in ${dt.toFixed(2)} ms)`);
  if (dt > 50) throw new Error(`too slow: ${dt} ms`);
});

check('imageBboxFromProjection returns plausible bbox around SCP', () => {
  const proj = buildSICDProjection(buildSyntheticSICD());
  const { bbox, corners } = imageBboxFromProjection(proj);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  // 10000 px × 1 m = 10 km in each direction, so bbox should span ~0.1 deg
  if (!(maxLon > minLon && maxLat > minLat)) throw new Error('degenerate bbox');
  if (maxLat - minLat < 0.05 || maxLat - minLat > 0.2) {
    throw new Error(`lat span ${maxLat - minLat} outside expected`);
  }
  if (corners.length !== 4) throw new Error('expected 4 corners');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
