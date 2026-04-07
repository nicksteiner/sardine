/**
 * Overture Buildings Loader
 *
 * Loads Overture Maps building footprints from PMTiles and returns
 * extruded 3D box geometry with DEM-snapped base elevations.
 *
 * Reuses PMTiles fetch logic from overture-loader.js.
 */

import {
  fetchOvertureTile,
  bboxToTiles,
  getZoomForBbox,
} from './overture-loader.js';

/**
 * Load building footprints within a bounding box from Overture PMTiles.
 *
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat] in WGS84
 * @param {Object} [options]
 * @param {string} [options.release] - PMTiles release date
 * @param {number} [options.maxTiles] - Max tiles to fetch (default 100)
 * @returns {Promise<GeoJSON.Feature[]>} Array of building Features with
 *   {geometry: Polygon, properties: {height, num_floors, id}}
 */
export async function loadBuildingsInBbox(bbox, options = {}) {
  const { release, maxTiles = 100 } = options;

  const zoom = getZoomForBbox(bbox);
  const tiles = bboxToTiles(bbox, zoom);
  const tileCount = (tiles.maxX - tiles.minX + 1) * (tiles.maxY - tiles.minY + 1);

  if (tileCount > maxTiles) {
    console.warn(`[OvertureBuildings] Too many tiles (${tileCount}) at zoom ${zoom}, skipping`);
    return [];
  }

  const features = [];
  let tilesLoaded = 0;

  for (let x = tiles.minX; x <= tiles.maxX && tilesLoaded < maxTiles; x++) {
    for (let y = tiles.minY; y <= tiles.maxY && tilesLoaded < maxTiles; y++) {
      try {
        const args = release
          ? [('buildings'), zoom, x, y, release]
          : ['buildings', zoom, x, y];
        const tileData = await fetchOvertureTile(...args);
        for (const layerFeatures of Object.values(tileData.layers || {})) {
          features.push(...layerFeatures);
        }
        tilesLoaded++;
      } catch (e) {
        console.warn(`[OvertureBuildings] Failed tile ${zoom}/${x}/${y}:`, e.message);
      }
    }
  }

  // Filter to Polygon geometries only and normalize properties
  return features.filter(f =>
    f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
  );
}

/**
 * Resolve building height using fallback chain:
 * feature.properties.height → num_floors × 3m → default 6m
 *
 * @param {Object} properties - Feature properties
 * @returns {number} Height in meters
 */
export function resolveHeight(properties) {
  if (properties.height != null && properties.height > 0) {
    return properties.height;
  }
  if (properties.num_floors != null && properties.num_floors > 0) {
    return properties.num_floors * 3;
  }
  return 6;
}

/**
 * Extrude a building footprint into 3D box geometry with DEM-snapped base.
 *
 * @param {GeoJSON.Feature} feature - Building feature with Polygon geometry
 * @param {Function} demSampler - Function(lon, lat) → elevation in meters.
 *   Returns the DEM elevation at a given point. If null, base elevation is 0.
 * @returns {{
 *   baseElev: number,
 *   topElev: number,
 *   footprint: number[][],
 *   walls: Array<{p0: number[], p1: number[], baseElev: number, topElev: number, facingNormal: number[]}>
 * }}
 */
export function extrudeBuilding(feature, demSampler) {
  const coords = feature.geometry.type === 'MultiPolygon'
    ? feature.geometry.coordinates[0][0]  // Use first polygon's outer ring
    : feature.geometry.coordinates[0];     // Outer ring

  const height = resolveHeight(feature.properties || {});

  // Sample DEM at each footprint vertex, take minimum for base
  let baseElev = 0;
  if (demSampler) {
    const elevations = coords.map(([lon, lat]) => {
      const e = demSampler(lon, lat);
      return (e != null && isFinite(e)) ? e : 0;
    });
    baseElev = Math.min(...elevations);
  }

  const topElev = baseElev + height;

  // Build wall segments from consecutive footprint vertices
  // Skip the closing vertex (last === first in GeoJSON polygon rings)
  const walls = [];
  const n = coords.length - 1; // exclude closing duplicate
  for (let i = 0; i < n; i++) {
    const p0 = coords[i];
    const p1 = coords[(i + 1) % n];

    // 2D outward-facing normal (perpendicular to wall edge)
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = len > 0 ? dy / len : 0;
    const ny = len > 0 ? -dx / len : 0;

    walls.push({
      p0: [p0[0], p0[1]],
      p1: [p1[0], p1[1]],
      baseElev,
      topElev,
      facingNormal: [nx, ny, 0],
    });
  }

  return {
    baseElev,
    topElev,
    footprint: coords.map(([lon, lat]) => [lon, lat]),
    walls,
  };
}
