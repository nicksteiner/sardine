/**
 * roi-subset.js — Geographic ROI to HDF5 pixel range mapping.
 *
 * Maps a geographic bounding box (typically from WKT) to pixel row/col
 * indices within a NISAR GCOV HDF5 file using the file's coordinate
 * arrays and CRS.
 */

import { wgs84ToProjectedPoint } from '../loaders/overture-loader.js';

/**
 * Binary search: find first index where arr[i] >= target in a sorted ascending array.
 * Returns arr.length if target > all values.
 */
function searchGE(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Binary search: find last index where arr[i] <= target in a sorted ascending array.
 * Returns -1 if target < all values.
 */
function searchLE(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

/**
 * Reproject a bbox from EPSG:4326 to the file's CRS if needed.
 * Uses proj4 via wgs84ToProjectedPoint for accurate reprojection.
 *
 * @param {number[]} bbox4326 — [west, south, east, north] in EPSG:4326
 * @param {string} fileCrs — target CRS string like "EPSG:32610"
 * @returns {number[]} bbox in file CRS
 */
export function reprojectBbox(bbox4326, fileCrs) {
  if (!fileCrs) return bbox4326;

  const epsgMatch = fileCrs.match(/EPSG:(\d+)/);
  if (!epsgMatch) return bbox4326;

  const epsg = parseInt(epsgMatch[1]);
  if (epsg === 4326) return bbox4326;

  const [west, south, east, north] = bbox4326;

  // A lat/lon rectangle maps to a curved quadrilateral in a projected CRS
  // (UTM meridian convergence, polar stereographic, ...), so the projected
  // extrema can lie anywhere along the edges — not at the corners. Sample
  // densified points along all four edges and take the envelope; two-corner
  // sampling under-estimates the bbox and clips data at the E/W margins.
  const N_EDGE = 10;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (let i = 0; i <= N_EDGE; i++) {
    const fx = i / N_EDGE;
    const lon = west + fx * (east - west);
    const lat = south + fx * (north - south);
    const pts = [
      wgs84ToProjectedPoint(lon, south, fileCrs),  // south edge
      wgs84ToProjectedPoint(lon, north, fileCrs),  // north edge
      wgs84ToProjectedPoint(west, lat, fileCrs),   // west edge
      wgs84ToProjectedPoint(east, lat, fileCrs),   // east edge
    ];
    for (const [e, n] of pts) {
      if (!Number.isFinite(e) || !Number.isFinite(n)) continue;
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
  }
  if (!Number.isFinite(minE)) return bbox4326;

  return [minE, minN, maxE, maxN];
}

/**
 * Map a geographic bounding box to pixel row/col indices in the file.
 *
 * @param {number[]} roiBbox — [minX, minY, maxX, maxY] in the file's CRS
 *   (call reprojectBbox first if the ROI is in EPSG:4326 and the file is UTM)
 * @param {Object} fileMetadata
 * @param {number[]} fileMetadata.worldBounds — [minX, minY, maxX, maxY] in file CRS
 * @param {number} fileMetadata.width — total pixel columns
 * @param {number} fileMetadata.height — total pixel rows
 * @param {Float64Array|Float32Array|null} fileMetadata.xCoords — x coordinate array (ascending)
 * @param {Float64Array|Float32Array|null} fileMetadata.yCoords — y coordinate array (descending, north→south)
 * @returns {{ startRow: number, startCol: number, numRows: number, numCols: number } | null}
 *   null if the ROI doesn't intersect the file bounds
 */
export function bboxToPixelRange(roiBbox, fileMetadata) {
  const { worldBounds, width, height, xCoords, yCoords } = fileMetadata;
  const [roiMinX, roiMinY, roiMaxX, roiMaxY] = roiBbox;
  const [fileMinX, fileMinY, fileMaxX, fileMaxY] = worldBounds;

  // Quick intersection check
  if (roiMaxX <= fileMinX || roiMinX >= fileMaxX ||
      roiMaxY <= fileMinY || roiMinY >= fileMaxY) {
    return null;
  }

  // Clamp ROI to file extent
  const clampMinX = Math.max(roiMinX, fileMinX);
  const clampMaxX = Math.min(roiMaxX, fileMaxX);
  const clampMinY = Math.max(roiMinY, fileMinY);
  const clampMaxY = Math.min(roiMaxY, fileMaxY);

  let startCol, endCol, startRow, endRow;

  if (xCoords && xCoords.length > 2) {
    // Use coordinate arrays for precise mapping (binary search)
    // xCoords is ascending (west → east)
    startCol = searchGE(xCoords, clampMinX);
    endCol = searchLE(xCoords, clampMaxX);
  } else {
    // Linear interpolation from world bounds
    startCol = Math.floor(((clampMinX - fileMinX) / (fileMaxX - fileMinX)) * width);
    endCol = Math.ceil(((clampMaxX - fileMinX) / (fileMaxX - fileMinX)) * width);
  }

  if (yCoords && yCoords.length > 2) {
    // yCoords is descending (north → south)
    // startRow corresponds to the northern (maxY) edge
    // For descending array, we need: first index where yCoords[i] <= clampMaxY (north)
    // and last index where yCoords[i] >= clampMinY (south)
    startRow = 0;
    while (startRow < yCoords.length && yCoords[startRow] > clampMaxY) startRow++;
    endRow = yCoords.length - 1;
    while (endRow >= 0 && yCoords[endRow] < clampMinY) endRow--;
  } else {
    // Linear interpolation — worldBounds[3] is maxY (north), worldBounds[1] is minY (south)
    // Row 0 = north (maxY), row height-1 = south (minY)
    startRow = Math.floor(((fileMaxY - clampMaxY) / (fileMaxY - fileMinY)) * height);
    endRow = Math.ceil(((fileMaxY - clampMinY) / (fileMaxY - fileMinY)) * height);
  }

  // Clamp to valid pixel range
  startCol = Math.max(0, startCol);
  endCol = Math.min(width - 1, endCol);
  startRow = Math.max(0, startRow);
  endRow = Math.min(height - 1, endRow);

  const numCols = endCol - startCol + 1;
  const numRows = endRow - startRow + 1;

  if (numCols <= 0 || numRows <= 0) return null;

  return { startRow, startCol, numRows, numCols };
}

/**
 * Compute the geographic bounds of a pixel subset.
 *
 * @param {{ startRow: number, startCol: number, numRows: number, numCols: number }} pixelRange
 * @param {Object} fileMetadata — same as bboxToPixelRange
 * @returns {number[]} [minX, minY, maxX, maxY] in file CRS
 */
export function computeSubsetBounds(pixelRange, fileMetadata) {
  const { worldBounds, width, height, xCoords, yCoords } = fileMetadata;
  const { startRow, startCol, numRows, numCols } = pixelRange;
  const [fileMinX, fileMinY, fileMaxX, fileMaxY] = worldBounds;

  let minX, maxX, minY, maxY;

  if (xCoords && xCoords.length > 2) {
    minX = xCoords[startCol];
    maxX = xCoords[Math.min(startCol + numCols - 1, xCoords.length - 1)];
  } else {
    minX = fileMinX + (startCol / width) * (fileMaxX - fileMinX);
    maxX = fileMinX + ((startCol + numCols) / width) * (fileMaxX - fileMinX);
  }

  if (yCoords && yCoords.length > 2) {
    // yCoords descending: startRow = north (larger Y), endRow = south (smaller Y)
    maxY = yCoords[startRow];
    minY = yCoords[Math.min(startRow + numRows - 1, yCoords.length - 1)];
  } else {
    // Row 0 = north (maxY)
    maxY = fileMaxY - (startRow / height) * (fileMaxY - fileMinY);
    minY = fileMaxY - ((startRow + numRows) / height) * (fileMaxY - fileMinY);
  }

  return [Math.min(minX, maxX), Math.min(minY, maxY), Math.max(minX, maxX), Math.max(minY, maxY)];
}

/**
 * Map a WGS84 bbox to the inclusive chunk-coordinate range it intersects
 * (W016 deep-link fetch scoping). Pure math: reproject the bbox to the file
 * CRS, resolve it to a pixel range via the coordinate arrays (or linear
 * interpolation), then divide by the chunk dimensions.
 *
 * @param {number[]} bbox4326 — [west, south, east, north] in EPSG:4326
 * @param {Object} meta
 * @param {number[]} meta.worldBounds — [minX, minY, maxX, maxY] in file CRS
 * @param {number} meta.width — total pixel columns
 * @param {number} meta.height — total pixel rows
 * @param {number} meta.chunkH — chunk height in pixels
 * @param {number} meta.chunkW — chunk width in pixels
 * @param {Float64Array|Float32Array|null} [meta.xCoords] — x coordinate array (ascending)
 * @param {Float64Array|Float32Array|null} [meta.yCoords] — y coordinate array (descending)
 * @param {string} [meta.crs='EPSG:4326'] — file CRS
 * @returns {{ startCR: number, endCR: number, startCC: number, endCC: number } | null}
 *   inclusive chunk-row/col range, or null if the bbox doesn't intersect the file
 */
export function scopeBboxToChunkRange(bbox4326, meta) {
  const { worldBounds, width, height, chunkH, chunkW, xCoords = null, yCoords = null, crs = 'EPSG:4326' } = meta;
  if (!chunkH || !chunkW) return null;
  const bboxFileCrs = reprojectBbox(bbox4326, crs);
  const px = bboxToPixelRange(bboxFileCrs, { worldBounds, width, height, xCoords, yCoords });
  if (!px) return null;
  return {
    startCR: Math.floor(px.startRow / chunkH),
    endCR: Math.floor((px.startRow + px.numRows - 1) / chunkH),
    startCC: Math.floor(px.startCol / chunkW),
    endCC: Math.floor((px.startCol + px.numCols - 1) / chunkW),
  };
}

/**
 * Quick check: does the ROI bbox intersect the file bbox?
 * Both must be in the same CRS.
 *
 * @param {number[]} roiBbox — [minX, minY, maxX, maxY]
 * @param {number[]} fileBbox — [minX, minY, maxX, maxY]
 * @returns {boolean}
 */
export function roiIntersectsFile(roiBbox, fileBbox) {
  return !(
    roiBbox[2] <= fileBbox[0] || roiBbox[0] >= fileBbox[2] ||
    roiBbox[3] <= fileBbox[1] || roiBbox[1] >= fileBbox[3]
  );
}
