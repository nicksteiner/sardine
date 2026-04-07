/**
 * SAR Scene Geometry — pure-math functions for coordinate transforms
 * and geometric predictions (dihedral strips, shadow zones).
 *
 * Coordinate convention: row = range, col = azimuth (SICD RGAZIM).
 *
 * No DOM, no WebGL — Node-safe pure functions.
 */

// ─── WGS84 constants ─────────────────────────────────────────────────────────

const WGS84_A = 6378137.0;                    // semi-major axis (m)
const WGS84_F = 1 / 298.257223563;            // flattening
const WGS84_B = WGS84_A * (1 - WGS84_F);     // semi-minor axis
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F; // first eccentricity squared

// ─── Vector helpers ──────────────────────────────────────────────────────────

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function norm(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// ─── WGS84 coordinate conversions ───────────────────────────────────────────

/**
 * Convert ECEF (x, y, z) in meters to geodetic (lat, lon, h).
 * Uses Bowring's iterative method (3 iterations, sub-mm accuracy).
 *
 * @param {number} x - ECEF X (m)
 * @param {number} y - ECEF Y (m)
 * @param {number} z - ECEF Z (m)
 * @returns {{lat: number, lon: number, h: number}} lat/lon in radians, h in meters
 */
export function ecefToLLH(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);

  // Initial estimate
  let lat = Math.atan2(z, p * (1 - WGS84_E2));

  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    lat = Math.atan2(z + WGS84_E2 * N * sinLat, p);
  }

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = cosLat > 1e-10 ? p / cosLat - N : Math.abs(z) / sinLat - N * (1 - WGS84_E2);

  return { lat, lon, h };
}

/**
 * Convert geodetic (lat, lon, h) to ECEF (x, y, z).
 *
 * @param {number} lat - Latitude in radians
 * @param {number} lon - Longitude in radians
 * @param {number} h   - Height above ellipsoid (m)
 * @returns {number[]} [x, y, z] in meters
 */
export function llhToECEF(lat, lon, h) {
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return [
    (N + h) * cosLat * cosLon,
    (N + h) * cosLat * sinLon,
    (N * (1 - WGS84_E2) + h) * sinLat,
  ];
}

// ─── Slant ↔ Ground projection ──────────────────────────────────────────────

/**
 * @typedef {Object} SARGeometry
 * @property {number[]} arpECEF     - Aperture Reference Point [x,y,z] (m)
 * @property {number[]} srpECEF     - Scene Reference Point [x,y,z] (m)
 * @property {number[]} rowUnitECEF - Range unit vector in ECEF
 * @property {number[]} colUnitECEF - Azimuth unit vector in ECEF
 * @property {number}   rowSS       - Row sample spacing (m)
 * @property {number}   colSS       - Col sample spacing (m)
 * @property {number}   srpRow      - SRP row index
 * @property {number}   srpCol      - SRP col index
 * @property {number}   grazeAngleDeg - Grazing angle at SRP (degrees)
 * @property {string}   sideOfTrack - 'L' or 'R'
 */

/**
 * Project slant-plane (row, col) to ground (lat, lon, h).
 *
 * Iterates DEM sampling 3 times starting from h=0 to converge
 * on the terrain surface.
 *
 * @param {number} row - Image row (range index)
 * @param {number} col - Image col (azimuth index)
 * @param {SARGeometry} geometry
 * @param {function(number,number): number} [demSampler] - (lat, lon) → height (m). Null → flat earth.
 * @returns {{lat: number, lon: number, h: number}} Radians and meters
 */
export function slantToGroundPoint(row, col, geometry, demSampler) {
  const { srpECEF, rowUnitECEF, colUnitECEF, rowSS, colSS, srpRow, srpCol } = geometry;

  // Scene-plane normal (moving along this preserves row/col projection)
  const nVec = cross(rowUnitECEF, colUnitECEF);
  const nHat = scale(nVec, 1 / norm(nVec));

  // Scene-plane ECEF point at (row, col)
  const dr = (row - srpRow) * rowSS;
  const dc = (col - srpCol) * colSS;
  const pScene = add(srpECEF, add(scale(rowUnitECEF, dr), scale(colUnitECEF, dc)));

  // Find parameter t along nHat such that P(t) = pScene + t*nHat lies on
  // the ellipsoid at target height. Newton iteration on h(t) - hTarget = 0.
  let t = 0;
  for (let i = 0; i < 6; i++) {
    const pCur = add(pScene, scale(nHat, t));
    const llh = ecefToLLH(pCur[0], pCur[1], pCur[2]);
    const hTarget = demSampler ? demSampler(llh.lat, llh.lon) : 0;
    const hErr = llh.h - hTarget;
    if (Math.abs(hErr) < 1e-6) break;

    // dh/dt ≈ dot(nHat, local_up). Local up at pCur:
    const sinLat = Math.sin(llh.lat);
    const cosLat = Math.cos(llh.lat);
    const sinLon = Math.sin(llh.lon);
    const cosLon = Math.cos(llh.lon);
    const upDir = [cosLat * cosLon, cosLat * sinLon, sinLat];
    const dhdt = dot(nHat, upDir);
    if (Math.abs(dhdt) < 1e-12) break;

    t -= hErr / dhdt;
  }

  const pFinal = add(pScene, scale(nHat, t));
  const llhFinal = ecefToLLH(pFinal[0], pFinal[1], pFinal[2]);
  const hFinal = demSampler ? demSampler(llhFinal.lat, llhFinal.lon) : 0;

  return { lat: llhFinal.lat, lon: llhFinal.lon, h: hFinal };
}

/**
 * Project a ground point (lat, lon, h) into slant-plane (row, col).
 *
 * Uses grid row/col unit vectors and SRP position to project the ECEF
 * point onto the image grid.
 *
 * @param {number} lat - Latitude (radians)
 * @param {number} lon - Longitude (radians)
 * @param {number} h   - Height above ellipsoid (m)
 * @param {SARGeometry} geometry
 * @returns {{row: number, col: number}}
 */
export function groundPointToSlant(lat, lon, h, geometry) {
  const { srpECEF, rowUnitECEF, colUnitECEF, rowSS, colSS, srpRow, srpCol } = geometry;
  const pECEF = llhToECEF(lat, lon, h);
  const d = sub(pECEF, srpECEF);
  return {
    row: srpRow + dot(d, rowUnitECEF) / rowSS,
    col: srpCol + dot(d, colUnitECEF) / colSS,
  };
}

// ─── Dihedral & shadow prediction ────────────────────────────────────────────

/**
 * @typedef {Object} BuildingFootprint
 * @property {Array<{lat: number, lon: number}>} footprint - Wall base vertices (radians)
 * @property {number} height    - Wall height (m)
 * @property {number} baseElev  - Base elevation above ellipsoid (m)
 */

/**
 * Predict dihedral (double-bounce) strip in slant-plane coordinates
 * for walls facing the sensor.
 *
 * For a vertical wall of height h at grazing angle θ on flat ground,
 * the dihedral strip extends h/tan(θ) in ground range toward the sensor
 * from the wall base.
 *
 * @param {BuildingFootprint} building
 * @param {SARGeometry} geometry
 * @returns {Array<{baseRow: number, baseCol: number, offsetRow: number, offsetCol: number}>}
 *   Each entry is a wall segment with base position and dihedral offset in image pixels.
 */
export function predictDihedralStrip(building, geometry) {
  const { footprint, height, baseElev } = building;
  const grazeRad = (geometry.grazeAngleDeg * Math.PI) / 180;
  const groundRangeOffset = height / Math.tan(grazeRad);

  // Determine sensor-facing direction in ECEF (from SRP toward ARP)
  const toSensor = sub(geometry.arpECEF, geometry.srpECEF);
  const toSensorNorm = scale(toSensor, 1 / norm(toSensor));

  // Range direction: toward sensor is negative row (closer range)
  const rangeSign = geometry.sideOfTrack === 'L' ? -1 : -1; // dihedral always toward sensor

  const results = [];

  for (let i = 0; i < footprint.length; i++) {
    const j = (i + 1) % footprint.length;
    const v0 = footprint[i];
    const v1 = footprint[j];

    // Wall midpoint
    const midLat = (v0.lat + v1.lat) / 2;
    const midLon = (v0.lon + v1.lon) / 2;

    // Wall segment endpoints in ECEF
    const p0 = llhToECEF(v0.lat, v0.lon, baseElev);
    const p1 = llhToECEF(v1.lat, v1.lon, baseElev);

    // Wall outward normal (horizontal component)
    const wallVec = sub(p1, p0);
    const up = scale(llhToECEF(midLat, midLon, baseElev + 1), 1); // approximate up
    const upDir = sub(up, llhToECEF(midLat, midLon, baseElev));
    const wallNormal = cross(wallVec, upDir);
    const wallNormalLen = norm(wallNormal);
    if (wallNormalLen < 1e-10) continue;
    const wallNormalUnit = scale(wallNormal, 1 / wallNormalLen);

    // Wall faces sensor if its normal has a positive component toward sensor
    const facingSensor = dot(wallNormalUnit, toSensorNorm) > 0;
    if (!facingSensor) {
      // Try the opposite normal
      const altNormal = scale(wallNormalUnit, -1);
      if (dot(altNormal, toSensorNorm) <= 0) continue;
    }

    // Project wall base midpoint to slant plane
    const base = groundPointToSlant(midLat, midLon, baseElev, geometry);

    // Dihedral offset: h/tan(graze) in ground range toward sensor
    // In image coordinates, this is along the row direction (range)
    const offsetPixels = groundRangeOffset / geometry.rowSS;

    results.push({
      baseRow: base.row,
      baseCol: base.col,
      offsetRow: -offsetPixels, // toward sensor = decreasing range = negative row offset
      offsetCol: 0,
    });
  }

  return results;
}

/**
 * Predict shadow zone in slant-plane coordinates for walls facing the sensor.
 *
 * Shadow extends from the top of the structure away from the sensor.
 * Shadow length in ground range = h / tan(grazeAngle).
 *
 * @param {BuildingFootprint} building
 * @param {SARGeometry} geometry
 * @returns {Array<{baseRow: number, baseCol: number, offsetRow: number, offsetCol: number}>}
 */
export function predictShadowZone(building, geometry) {
  const { footprint, height, baseElev } = building;
  const grazeRad = (geometry.grazeAngleDeg * Math.PI) / 180;
  const groundRangeOffset = height / Math.tan(grazeRad);

  const results = [];

  for (let i = 0; i < footprint.length; i++) {
    const j = (i + 1) % footprint.length;
    const v0 = footprint[i];
    const v1 = footprint[j];

    const midLat = (v0.lat + v1.lat) / 2;
    const midLon = (v0.lon + v1.lon) / 2;

    // Shadow starts from the wall base on the far side from sensor
    // and extends away from sensor by h/tan(graze)
    const base = groundPointToSlant(midLat, midLon, baseElev, geometry);

    // Shadow extends away from sensor = increasing range = positive row offset
    const offsetPixels = groundRangeOffset / geometry.rowSS;

    results.push({
      baseRow: base.row,
      baseCol: base.col,
      offsetRow: offsetPixels, // away from sensor = increasing range
      offsetCol: 0,
    });
  }

  return results;
}

// ─── Utility: build local tangent-plane geometry ─────────────────────────────

/**
 * Build a synthetic SARGeometry for a given SRP on the ellipsoid.
 * Useful for testing or when full SICD metadata is unavailable.
 *
 * @param {number} srpLat - SRP latitude (radians)
 * @param {number} srpLon - SRP longitude (radians)
 * @param {number} srpH   - SRP height (m)
 * @param {Object} opts
 * @param {number} opts.grazeAngleDeg - Grazing angle (degrees)
 * @param {string} opts.sideOfTrack   - 'L' or 'R'
 * @param {number} opts.azimuthAngleDeg - Azimuth angle from north (degrees), default 0 (north-flying)
 * @param {number} [opts.rowSS=1]     - Row sample spacing (m)
 * @param {number} [opts.colSS=1]     - Col sample spacing (m)
 * @param {number} [opts.srpRow=0]    - SRP row index
 * @param {number} [opts.srpCol=0]    - SRP col index
 * @returns {SARGeometry}
 */
export function buildLocalGeometry(srpLat, srpLon, srpH, opts) {
  const {
    grazeAngleDeg,
    sideOfTrack = 'R',
    azimuthAngleDeg = 0,
    rowSS = 1,
    colSS = 1,
    srpRow = 0,
    srpCol = 0,
  } = opts;

  const srpECEF = llhToECEF(srpLat, srpLon, srpH);

  // Local ENU (East-North-Up) unit vectors at SRP
  const sinLat = Math.sin(srpLat);
  const cosLat = Math.cos(srpLat);
  const sinLon = Math.sin(srpLon);
  const cosLon = Math.cos(srpLon);

  const east  = [-sinLon,          cosLon,          0        ];
  const north = [-sinLat * cosLon, -sinLat * sinLon, cosLat  ];
  const up    = [ cosLat * cosLon,  cosLat * sinLon, sinLat  ];

  // Azimuth direction (flight direction) in ENU, rotated from north
  const azRad = (azimuthAngleDeg * Math.PI) / 180;
  // Azimuth unit in ECEF (along-track)
  const colUnit = add(scale(north, Math.cos(azRad)), scale(east, Math.sin(azRad)));

  // Range direction: perpendicular to flight in the ground plane, then tilted by graze angle
  // For right-looking: range points to the right of flight direction
  const sideSign = sideOfTrack === 'L' ? -1 : 1;
  const groundRange = add(scale(east, sideSign * Math.cos(azRad)), scale(north, -sideSign * Math.sin(azRad)));

  // Slant range unit vector: ground range component at graze angle, with downward tilt
  const grazeRad = (grazeAngleDeg * Math.PI) / 180;
  const rowUnit = add(scale(groundRange, Math.cos(grazeRad)), scale(up, -Math.sin(grazeRad)));

  // ARP position: along the line-of-sight direction from SRP, at some altitude
  // Place it at a reasonable distance (e.g., 600 km for a satellite)
  const losDir = add(scale(groundRange, -Math.cos(grazeRad)), scale(up, Math.sin(grazeRad)));
  const arpDist = 600000; // 600 km
  const arpECEF = add(srpECEF, scale(losDir, arpDist));

  return {
    arpECEF,
    srpECEF,
    rowUnitECEF: rowUnit,
    colUnitECEF: colUnit,
    rowSS,
    colSS,
    srpRow,
    srpCol,
    grazeAngleDeg,
    sideOfTrack,
  };
}
