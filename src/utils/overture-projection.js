/**
 * Overture vector reprojection helpers.
 *
 * Three target spaces, picked at runtime:
 *
 *   1. SICD slant-plane (when `projection` is set) — back-project ground
 *      vectors into chip-local pixel space via groundToImage and emit
 *      deck.gl world coords (col, nRows - row). The Y flip matches
 *      nitf-loader.js's getTile(), which places world Y=0 at the bottom
 *      of the image.
 *
 *   2. Projected CRS (UTM, polar-stereo, ...) — proj4 forward via
 *      wgs84ToProjectedPoint.
 *
 *   3. EPSG:4326 / no metadata — identity (returns null so callers can
 *      skip the walk entirely).
 *
 * Kept separate from src/layers/OvertureLayer.js so it can be imported
 * by Node tests without dragging in @deck.gl/layers.
 */

import { wgs84ToProjectedPoint } from '../loaders/overture-loader.js';
import { groundToImage } from './sicd-projection.js';

export function makeReproject({ projection, crs, worldBounds, pixelBounds }) {
  if (projection) {
    const nRows = projection.nRows;
    return ([lon, lat, h]) => {
      const { row, col } = groundToImage(lat, lon, h || 0, projection);
      return [col, nRows - row];
    };
  }

  // The NISAR loader is inconsistent about what `bounds` means: sometimes it
  // holds the world-coordinate extent, sometimes it holds pixel indices
  // [0, 0, W, H] alongside a separate `worldBounds`. When `bounds` clearly
  // describes pixel space (origin at 0 and extent matches image dimensions),
  // we have to map WGS84 → world CRS → pixel space, otherwise the overlay
  // lands at the world coordinates while the image is drawn in pixel coords.
  const isPixelBounds = !!(pixelBounds && worldBounds
    && Math.abs(pixelBounds[0]) < 1e-6 && Math.abs(pixelBounds[1]) < 1e-6
    && (Math.abs(pixelBounds[2] - (worldBounds[2] - worldBounds[0])) > 1e-3
        || Math.abs(pixelBounds[3] - (worldBounds[3] - worldBounds[1])) > 1e-3));

  if (isPixelBounds) {
    const [wMinX, wMinY, wMaxX, wMaxY] = worldBounds;
    const [, , pMaxX, pMaxY] = pixelBounds;
    const dWx = wMaxX - wMinX;
    const dWy = wMaxY - wMinY;
    const isProjectedWorld = crs && !crs.includes('4326');
    return ([lon, lat, h]) => {
      const [wx, wy] = isProjectedWorld
        ? wgs84ToProjectedPoint(lon, lat, crs)
        : [lon, lat];
      const x = ((wx - wMinX) / dWx) * pMaxX;
      const y = ((wy - wMinY) / dWy) * pMaxY;
      return h !== undefined ? [x, y, h] : [x, y];
    };
  }

  if (crs && !crs.includes('4326')) {
    return ([lon, lat, h]) => {
      const [x, y] = wgs84ToProjectedPoint(lon, lat, crs);
      return h !== undefined ? [x, y, h] : [x, y];
    };
  }

  return null;
}

export function reprojectCoords(coords, fn) {
  if (!coords) return coords;
  if (typeof coords[0] === 'number') return fn(coords);
  return coords.map(c => reprojectCoords(c, fn));
}

export function reprojectFeature(feature, fn) {
  if (!feature?.geometry?.coordinates) return feature;
  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: reprojectCoords(feature.geometry.coordinates, fn),
    },
  };
}
