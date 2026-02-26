/**
 * roi-subset.js — Geographic ROI to HDF5 pixel range mapping.
 *
 * Maps a geographic bounding box (typically from WKT) to pixel row/col
 * indices within a NISAR GCOV HDF5 file using the file's coordinate
 * arrays and CRS.
 */

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
 * Convert WGS84 (EPSG:4326) bbox to UTM projected coordinates.
 * Inverse of the utmToWGS84 pattern from overture-loader.js.
 *
 * @param {number[]} bbox — [west, south, east, north] in degrees
 * @param {number} zone — UTM zone number (1-60)
 * @param {boolean} isNorth — true for northern hemisphere
 * @returns {number[]} [minEasting, minNorthing, maxEasting, maxNorthing] in meters
 */
function wgs84ToUtm(bbox, zone, isNorth) {
  const [west, south, east, north] = bbox;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const k0 = 0.9996;
  const a = 6378137; // WGS84 semi-major axis

  function latLonToUtm(lon, lat) {
    const latRad = lat * Math.PI / 180;
    const easting = 500000 + k0 * a * (lon - lon0) * Math.PI / 180 * Math.cos(latRad);
    const rawNorthing = k0 * a * lat * Math.PI / 180;
    const northing = isNorth ? rawNorthing : rawNorthing + 10000000;
    return [easting, northing];
  }

  const [e1, n1] = latLonToUtm(west, south);
  const [e2, n2] = latLonToUtm(east, north);

  return [
    Math.min(e1, e2),
    Math.min(n1, n2),
    Math.max(e1, e2),
    Math.max(n1, n2),
  ];
}

/**
 * Reproject a bbox from EPSG:4326 to the file's CRS if needed.
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

  // UTM north (326xx)
  if (epsg >= 32601 && epsg <= 32660) {
    return wgs84ToUtm(bbox4326, epsg - 32600, true);
  }
  // UTM south (327xx)
  if (epsg >= 32701 && epsg <= 32760) {
    return wgs84ToUtm(bbox4326, epsg - 32700, false);
  }

  console.warn(`[ROI Subset] Unknown CRS ${fileCrs}, using bbox as-is`);
  return bbox4326;
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
