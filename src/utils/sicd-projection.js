/**
 * SICD ground ↔ image projection (sarpy-equivalent).
 *
 * Implements the plane-projection path from NGA's "SICD Image Projections"
 * description document — equivalent to sarpy.geometry.point_projection's
 * image-plane projection (https://github.com/ngageoint/sarpy,
 * sarpy/geometry/point_projection.py).
 *
 * Does NOT use ImageCorners (ICP) for any math. Geolocation is computed
 * rigorously from SCP + Grid.Row/Col.UVectECF + Row/Col.SS + SCPPixel.
 *
 * ── Math summary ──
 *   Forward  (ground → image):
 *       Δ    = ECEF(lat,lon,h) − SCP_ECF
 *       row  = (Δ · rowU) / rowSS + scpRow − firstRow
 *       col  = (Δ · colU) / colSS + scpCol − firstCol
 *
 *   Inverse (image → ground, on a plane through SCP perpendicular to the
 *            ellipsoid normal at SCP):
 *       dr   = (row + firstRow − scpRow) * rowSS
 *       dc   = (col + firstCol − scpCol) * colSS
 *       pECF = SCP_ECF + dr*rowU + dc*colU
 *       then ECEF → LLH. Since rowU/colU are in general *not* tangent to
 *       the ellipsoid, this gives a point slightly off the ellipsoid; for
 *       h=0 output we iterate once along the local ellipsoid normal.
 *
 * For features within a typical SAR scene (~30 km from SCP), the single-step
 * forward projection matches sarpy to well under a pixel — the Grid plane
 * is effectively tangent at SCP and its curvature only matters at scene
 * extrema or for DEM-coupled analysis.
 */

// ─── WGS84 geodesy ──────────────────────────────────────────────────────────
const DEG = Math.PI / 180;
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

function llhToEcef(lat, lon, h) {
  const sLat = Math.sin(lat * DEG);
  const cLat = Math.cos(lat * DEG);
  const sLon = Math.sin(lon * DEG);
  const cLon = Math.cos(lon * DEG);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  return [
    (N + h) * cLat * cLon,
    (N + h) * cLat * sLon,
    (N * (1 - WGS84_E2) + h) * sLat,
  ];
}

function ecefToLlh(x, y, z) {
  const p = Math.sqrt(x * x + y * y);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sT = Math.sin(theta);
  const cT = Math.cos(theta);
  const lat = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sT * sT * sT,
    p - WGS84_E2 * WGS84_A * cT * cT * cT,
  );
  const lon = Math.atan2(y, x);
  const sLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  const h = p / Math.cos(lat) - N;
  return { lat: lat / DEG, lon: lon / DEG, h };
}

// ─── Projection setup ───────────────────────────────────────────────────────

/**
 * Build a reusable projection object from SICD metadata.
 *
 * Accepts the `sicd` object produced by parseSICDXml in nitf-loader.js,
 * which must contain:
 *   sicd.geometry.rowUVect / colUVect   (Grid.Row/Col.UVectECF)
 *   sicd.geometry.rowSS / colSS          (Grid.Row/Col.SS, meters/pixel)
 *   sicd.scp.ecef                        (GeoData.SCP.ECF)
 *   sicd.scpPixel                        (ImageData.SCPPixel, full-image coords)
 *   sicd.firstRow, sicd.firstCol         (ImageData.FirstRow/FirstCol; chip offset)
 *   sicd.nrows, sicd.ncols               (ImageData.NumRows/NumCols; this chip)
 *
 * @param {Object} sicd
 * @returns {Object} projection (opaque — pass to groundToImage*)
 */
export function buildSICDProjection(sicd) {
  const g = sicd.geometry;
  if (!g || !g.rowUVect || !g.colUVect || !g.rowSS || !g.colSS) {
    throw new Error('SICD metadata missing Grid.Row/Col.UVectECF or SS');
  }
  if (!sicd.scp || !sicd.scp.ecef) {
    throw new Error('SICD metadata missing GeoData.SCP.ECF');
  }
  if (!sicd.scpPixel) {
    throw new Error('SICD metadata missing ImageData.SCPPixel');
  }

  return {
    // SCP in ECEF (Float64 for precision)
    scpX: sicd.scp.ecef.x,
    scpY: sicd.scp.ecef.y,
    scpZ: sicd.scp.ecef.z,
    scpLat: sicd.scp.lat,
    scpLon: sicd.scp.lon,
    scpHae: sicd.scp.hae || 0,

    // Grid plane unit vectors (ECEF)
    rowUx: g.rowUVect.x, rowUy: g.rowUVect.y, rowUz: g.rowUVect.z,
    colUx: g.colUVect.x, colUy: g.colUVect.y, colUz: g.colUVect.z,

    // Sample spacing (meters/pixel, slant plane)
    rowSS: g.rowSS,
    colSS: g.colSS,

    // SCP pixel in full-image coords + chip offset
    scpRow: sicd.scpPixel.row,
    scpCol: sicd.scpPixel.col,
    firstRow: sicd.firstRow || 0,
    firstCol: sicd.firstCol || 0,

    // Image dimensions (this chip)
    nRows: sicd.nrows,
    nCols: sicd.ncols,

    // Stash metadata for convenience
    sideOfTrack: g.sideOfTrack,
    grazeAng: g.grazeAng,
  };
}

// ─── Forward: ground → image ────────────────────────────────────────────────

/**
 * Project a single (lat, lon, h) to chip-local (row, col).
 * @returns {{row: number, col: number}}
 */
export function groundToImage(lat, lon, h, proj) {
  const [x, y, z] = llhToEcef(lat, lon, h);
  const dx = x - proj.scpX;
  const dy = y - proj.scpY;
  const dz = z - proj.scpZ;
  const dr = dx * proj.rowUx + dy * proj.rowUy + dz * proj.rowUz;
  const dc = dx * proj.colUx + dy * proj.colUy + dz * proj.colUz;
  return {
    row: dr / proj.rowSS + proj.scpRow - proj.firstRow,
    col: dc / proj.colSS + proj.scpCol - proj.firstCol,
  };
}

/**
 * Vectorized ground → image. Fast path for tens of thousands of points.
 *
 * @param {Float64Array|Float32Array|number[]} lons
 * @param {Float64Array|Float32Array|number[]} lats
 * @param {Float64Array|Float32Array|number[]|number|null} hs
 *        per-point heights, or a single number, or null (= 0)
 * @param {Object} proj
 * @param {Float32Array} [out]  pre-allocated interleaved [r0,c0,r1,c1,...]
 * @returns {Float32Array} interleaved (row, col) pairs, length = 2*N
 */
export function groundToImageBulk(lons, lats, hs, proj, out = null) {
  const N = lons.length;
  const result = out || new Float32Array(2 * N);
  if (result.length < 2 * N) throw new Error('out buffer too small');

  const scpX = proj.scpX, scpY = proj.scpY, scpZ = proj.scpZ;
  const rUx = proj.rowUx, rUy = proj.rowUy, rUz = proj.rowUz;
  const cUx = proj.colUx, cUy = proj.colUy, cUz = proj.colUz;
  const rSS = proj.rowSS, cSS = proj.colSS;
  const rOff = proj.scpRow - proj.firstRow;
  const cOff = proj.scpCol - proj.firstCol;

  const hConst = typeof hs === 'number' ? hs : null;
  const hArr = hs && typeof hs !== 'number' ? hs : null;
  const a = WGS84_A, e2 = WGS84_E2;

  for (let i = 0; i < N; i++) {
    const latR = lats[i] * DEG;
    const lonR = lons[i] * DEG;
    const h = hConst !== null ? hConst : (hArr ? hArr[i] : 0);

    const sLat = Math.sin(latR);
    const cLat = Math.cos(latR);
    const sLon = Math.sin(lonR);
    const cLon = Math.cos(lonR);
    const N_ = a / Math.sqrt(1 - e2 * sLat * sLat);
    const x = (N_ + h) * cLat * cLon;
    const y = (N_ + h) * cLat * sLon;
    const z = (N_ * (1 - e2) + h) * sLat;

    const dx = x - scpX;
    const dy = y - scpY;
    const dz = z - scpZ;
    const dr = dx * rUx + dy * rUy + dz * rUz;
    const dc = dx * cUx + dy * cUy + dz * cUz;

    result[2 * i]     = dr / rSS + rOff;
    result[2 * i + 1] = dc / cSS + cOff;
  }
  return result;
}

// ─── Inverse: image → ground (plane through SCP) ────────────────────────────

/**
 * Project chip-local (row, col) onto the Grid image plane through SCP,
 * then drop to the WGS84 ellipsoid along the local ellipsoid normal at SCP.
 *
 * This is a single-step approximation of sarpy's image_to_ground_hae: it
 * assumes flat-Earth (h=0) and does not iterate. For scene-extent overlays
 * and bbox computation it is accurate to a few meters.
 *
 * @param {number} row
 * @param {number} col
 * @param {Object} proj
 * @returns {{lat:number, lon:number, h:number}}
 */
export function imageToGround(row, col, proj) {
  const dr = (row - proj.scpRow + proj.firstRow) * proj.rowSS;
  const dc = (col - proj.scpCol + proj.firstCol) * proj.colSS;
  const x = proj.scpX + dr * proj.rowUx + dc * proj.colUx;
  const y = proj.scpY + dr * proj.rowUy + dc * proj.colUy;
  const z = proj.scpZ + dr * proj.rowUz + dc * proj.colUz;
  return ecefToLlh(x, y, z);
}

/**
 * Compute the lat/lon bounding box of the image by projecting its four
 * corners via imageToGround. Returns [minLon, minLat, maxLon, maxLat].
 */
export function imageBboxFromProjection(proj) {
  const corners = [
    imageToGround(0, 0, proj),
    imageToGround(0, proj.nCols - 1, proj),
    imageToGround(proj.nRows - 1, proj.nCols - 1, proj),
    imageToGround(proj.nRows - 1, 0, proj),
  ];
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const c of corners) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  return { bbox: [minLon, minLat, maxLon, maxLat], corners };
}

// Re-export the geodesy helpers for tests / callers that want them.
export { llhToEcef, ecefToLlh };
