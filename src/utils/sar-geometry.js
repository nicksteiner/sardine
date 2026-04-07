/**
 * SAR Scene Geometry — Pure-math module for SAR coordinate transforms
 * and geometric predictors (dihedral/shadow).
 *
 * Coordinate convention: row = range, col = azimuth (RGAZIM / SICD Grid.Type)
 *
 * Exports:
 *   ecefToLLH(x, y, z)                → { lat, lon, h }   (degrees, meters)
 *   llhToECEF(lat, lon, h)            → { x, y, z }       (meters)
 *   slantToGroundPoint(row, col, geometry, demSampler)  → { lat, lon, h }
 *   groundPointToSlant(lat, lon, h, geometry)           → { row, col }
 *   predictDihedralStrip(wall, geometry)  → [{ row, col }]
 *   predictShadowZone(wall, geometry)     → [{ row, col }]
 *   buildLocalGeometry(options)            → geometry object
 *
 * @module sar-geometry
 */

// ─── WGS84 Constants ────────────────────────────────────────────────────────

const WGS84_A = 6378137.0;                     // semi-major axis (m)
const WGS84_F = 1.0 / 298.257223563;           // flattening
const WGS84_B = WGS84_A * (1 - WGS84_F);      // semi-minor axis
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // first eccentricity squared
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

const DEG = Math.PI / 180;

// ─── WGS84 Coordinate Transforms ────────────────────────────────────────────

/**
 * Convert ECEF (x,y,z) to geodetic (lat,lon,h) using Bowring's iterative method.
 * @param {number} x - ECEF X (meters)
 * @param {number} y - ECEF Y (meters)
 * @param {number} z - ECEF Z (meters)
 * @returns {{ lat: number, lon: number, h: number }} lat/lon in degrees, h in meters
 */
export function ecefToLLH(x, y, z) {
  const p = Math.sqrt(x * x + y * y);
  const lon = Math.atan2(y, x);

  // Bowring's iterative method (converges in 2-3 iterations for any point)
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
  }

  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = p / Math.cos(lat) - N;

  return { lat: lat / DEG, lon: lon / DEG, h };
}

/**
 * Convert geodetic (lat,lon,h) to ECEF (x,y,z).
 * @param {number} lat - Latitude (degrees)
 * @param {number} lon - Longitude (degrees)
 * @param {number} h   - Height above ellipsoid (meters)
 * @returns {{ x: number, y: number, z: number }} ECEF in meters
 */
export function llhToECEF(lat, lon, h) {
  const latR = lat * DEG;
  const lonR = lon * DEG;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return {
    x: (N + h) * cosLat * cosLon,
    y: (N + h) * cosLat * sinLon,
    z: (N * (1 - WGS84_E2) + h) * sinLat,
  };
}

// ─── Vector helpers ──────────────────────────────────────────────────────────

function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vecScale(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function vecDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vecNorm(v) { return Math.sqrt(vecDot(v, v)); }
function vecNormalize(v) { const n = vecNorm(v); return [v[0] / n, v[1] / n, v[2] / n]; }

// ─── Geometry Builder ────────────────────────────────────────────────────────

/**
 * Build a local SAR imaging geometry descriptor from sensor and scene parameters.
 *
 * @param {Object} opts
 * @param {{ x: number, y: number, z: number }} opts.arpECEF  - Antenna Reference Point in ECEF
 * @param {{ lat: number, lon: number, h: number }} opts.sceneCenter - Scene center in LLH
 * @param {number} opts.rowSpacing   - Range pixel spacing in meters
 * @param {number} opts.colSpacing   - Azimuth pixel spacing in meters
 * @param {number} opts.nRows        - Number of rows (range)
 * @param {number} opts.nCols        - Number of columns (azimuth)
 * @param {number} [opts.sideOfTrack=1]  - +1 = left-looking, -1 = right-looking
 * @returns {Object} geometry descriptor
 */
export function buildLocalGeometry(opts) {
  const { arpECEF, sceneCenter, rowSpacing, colSpacing, nRows, nCols, sideOfTrack = 1 } = opts;
  const arp = [arpECEF.x, arpECEF.y, arpECEF.z];
  const scnECEF = llhToECEF(sceneCenter.lat, sceneCenter.lon, sceneCenter.h || 0);
  const scn = [scnECEF.x, scnECEF.y, scnECEF.z];

  // Up direction at scene center (ellipsoid normal)
  const latR = sceneCenter.lat * DEG;
  const lonR = sceneCenter.lon * DEG;
  const up = [
    Math.cos(latR) * Math.cos(lonR),
    Math.cos(latR) * Math.sin(lonR),
    Math.sin(latR),
  ];

  // Line-of-sight: scene center → ARP
  const los = vecNormalize(vecSub(arp, scn));

  // Along-track (azimuth) direction: perpendicular to LOS and up
  // azDir = normalize(up × los) * sideOfTrack
  const cross = [
    up[1] * los[2] - up[2] * los[1],
    up[2] * los[0] - up[0] * los[2],
    up[0] * los[1] - up[1] * los[0],
  ];
  const azDir = vecScale(vecNormalize(cross), sideOfTrack);

  // Range direction (ground-projected): perpendicular to azDir in ground plane
  // rgDir = normalize(los - (los·up)*up)  — projection of LOS onto ground plane
  const losDotUp = vecDot(los, up);
  const rgDir = vecNormalize(vecSub(los, vecScale(up, losDotUp)));

  // Graze angle
  const grazeAngle = Math.asin(Math.abs(losDotUp));

  // Slant range to scene center
  const slantRange = vecNorm(vecSub(arp, scn));

  return {
    arp,
    sceneCenter: scn,
    sceneCenterLLH: sceneCenter,
    up: vecNormalize(up),
    los,
    azDir,
    rgDir,
    rowSpacing,
    colSpacing,
    nRows,
    nCols,
    sideOfTrack,
    grazeAngle,
    slantRange,
  };
}

// ─── Slant ↔ Ground Transforms ──────────────────────────────────────────────

/**
 * Project a slant-plane pixel (row, col) to a ground point (lat, lon, h).
 * Iterates: assume h=0, project to ground, sample DEM, repeat.
 *
 * @param {number} row - Range index (fractional OK)
 * @param {number} col - Azimuth index (fractional OK)
 * @param {Object} geometry - From buildLocalGeometry
 * @param {Function} [demSampler] - (lat, lon) → elevation in meters. Default returns 0.
 * @param {number} [iterations=3] - Number of DEM refinement iterations
 * @returns {{ lat: number, lon: number, h: number }}
 */
export function slantToGroundPoint(row, col, geometry, demSampler = null, iterations = 3) {
  const { sceneCenter, rgDir, azDir, rowSpacing, colSpacing, nRows, nCols, up, grazeAngle } = geometry;

  // Offset from scene center in row/col
  const dRow = row - nRows / 2;
  const dCol = col - nCols / 2;

  // Ground-range offset (meters)
  const groundRangeOffset = dRow * rowSpacing / Math.cos(grazeAngle);
  const azOffset = dCol * colSpacing;

  // Initial ground point (h=0)
  let pt = vecAdd(sceneCenter, vecAdd(
    vecScale(rgDir, groundRangeOffset),
    vecScale(azDir, azOffset),
  ));

  const dem = demSampler || (() => 0);

  for (let i = 0; i < iterations; i++) {
    const llh = ecefToLLH(pt[0], pt[1], pt[2]);
    const hDEM = dem(llh.lat, llh.lon);
    // Adjust point along ellipsoid normal to match DEM height
    const ptLLH = llhToECEF(llh.lat, llh.lon, hDEM);
    pt = [ptLLH.x, ptLLH.y, ptLLH.z];
  }

  return ecefToLLH(pt[0], pt[1], pt[2]);
}

/**
 * Project a ground point (lat, lon, h) back to slant-plane pixel (row, col).
 * Uses the geometry's grid vectors and ARP position.
 *
 * @param {number} lat - Latitude (degrees)
 * @param {number} lon - Longitude (degrees)
 * @param {number} h   - Height above ellipsoid (meters)
 * @param {Object} geometry - From buildLocalGeometry
 * @returns {{ row: number, col: number }}
 */
export function groundPointToSlant(lat, lon, h, geometry) {
  const { sceneCenter, rgDir, azDir, rowSpacing, colSpacing, nRows, nCols, grazeAngle } = geometry;

  const ptECEF = llhToECEF(lat, lon, h);
  const pt = [ptECEF.x, ptECEF.y, ptECEF.z];

  // Vector from scene center to target
  const delta = vecSub(pt, sceneCenter);

  // Project onto range and azimuth directions
  const groundRangeOffset = vecDot(delta, rgDir);
  const azOffset = vecDot(delta, azDir);

  // Convert back to row/col
  const dRow = groundRangeOffset * Math.cos(grazeAngle) / rowSpacing;
  const dCol = azOffset / colSpacing;

  return {
    row: nRows / 2 + dRow,
    col: nCols / 2 + dCol,
  };
}

// ─── Dihedral & Shadow Predictors ────────────────────────────────────────────

/**
 * Predict the dihedral (double-bounce) strip in slant-plane coordinates
 * for a vertical wall.
 *
 * For a wall of height h on flat ground, the dihedral return appears
 * offset by h / tan(grazeAngle) toward the sensor in ground range,
 * which maps to h * cos(grazeAngle) / (sin(grazeAngle) * rowSpacing)
 * pixels in the range (row) direction.
 *
 * @param {Object} wall
 * @param {{ lat: number, lon: number }[]} wall.footprint - Wall base vertices in LLH
 * @param {number} wall.height      - Wall height in meters
 * @param {number} [wall.baseElev=0] - Base elevation in meters
 * @param {Object} geometry - From buildLocalGeometry
 * @returns {{ row: number, col: number }[]} Slant-plane polygon vertices
 */
export function predictDihedralStrip(wall, geometry) {
  const { height, baseElev = 0, footprint } = wall;
  const { grazeAngle, sideOfTrack } = geometry;

  // Dihedral offset in ground range (toward sensor)
  const dihedralGroundOffset = height / Math.tan(grazeAngle);

  const vertices = [];
  for (const vertex of footprint) {
    // Base vertex in slant plane
    const base = groundPointToSlant(vertex.lat, vertex.lon, baseElev, geometry);

    // Dihedral line is offset toward sensor in range
    // "Toward sensor" = decreasing row for sideOfTrack convention
    const rowOffset = -sideOfTrack * dihedralGroundOffset * Math.cos(grazeAngle) / geometry.rowSpacing;

    vertices.push({
      row: base.row + rowOffset,
      col: base.col,
    });
  }

  return vertices;
}

/**
 * Predict the shadow zone in slant-plane coordinates for a vertical wall.
 *
 * Shadow extends away from the sensor by h / tan(grazeAngle) in ground range.
 *
 * @param {Object} wall
 * @param {{ lat: number, lon: number }[]} wall.footprint - Wall base vertices in LLH
 * @param {number} wall.height      - Wall height in meters
 * @param {number} [wall.baseElev=0] - Base elevation in meters
 * @param {Object} geometry - From buildLocalGeometry
 * @returns {{ row: number, col: number }[]} Slant-plane polygon vertices
 */
export function predictShadowZone(wall, geometry) {
  const { height, baseElev = 0, footprint } = wall;
  const { grazeAngle, sideOfTrack } = geometry;

  // Shadow extends away from sensor in ground range
  const shadowGroundOffset = height / Math.tan(grazeAngle);

  const vertices = [];
  for (const vertex of footprint) {
    const base = groundPointToSlant(vertex.lat, vertex.lon, baseElev, geometry);

    // "Away from sensor" = increasing row
    const rowOffset = sideOfTrack * shadowGroundOffset * Math.cos(grazeAngle) / geometry.rowSpacing;

    vertices.push({
      row: base.row + rowOffset,
      col: base.col,
    });
  }

  return vertices;
}
