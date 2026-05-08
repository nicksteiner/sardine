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

export function makeReproject({ projection, crs }) {
  if (projection) {
    const nRows = projection.nRows;
    return ([lon, lat, h]) => {
      const { row, col } = groundToImage(lat, lon, h || 0, projection);
      return [col, nRows - row];
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
