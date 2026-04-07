/**
 * Overture Buildings Loader
 *
 * Loads Overture Maps building footprints for a bounding box and produces
 * extruded 3D box geometry with DEM-snapped base elevations.
 *
 * Reuses PMTiles fetch logic from overture-loader.js for tile access.
 *
 * API:
 *   loadBuildingsInBbox(bbox) → Feature[] with {geometry:Polygon, properties:{height,num_floors,id}}
 *   extrudeBuilding(feature, demSampler) → {baseElev, topElev, footprint, walls}
 */

import {
  fetchOvertureTile,
  bboxToTiles,
  getZoomForBbox,
} from './overture-loader.js';

/**
 * Height fallback: feature.properties.height || (num_floors * 3) || 6m default.
 * @param {Object} properties - GeoJSON feature properties
 * @returns {number} Building height in meters
 */
export function getBuildingHeight(properties) {
  if (properties.height != null && properties.height > 0) return properties.height;
  if (properties.num_floors != null && properties.num_floors > 0) return properties.num_floors * 3;
  return 6;
}

/**
 * Load Overture building footprints within a bounding box.
 *
 * Fetches building data from Overture PMTiles at an appropriate zoom level,
 * filters to features within the bbox, and normalizes properties.
 *
 * @param {number[]} bbox - [minLon, minLat, maxLon, maxLat] in WGS84
 * @param {Object} [options]
 * @param {string} [options.release] - PMTiles release date
 * @param {number} [options.maxTiles=100] - Max tiles to fetch
 * @returns {Promise<GeoJSON.Feature[]>} Array of building features with Polygon geometry
 */
export async function loadBuildingsInBbox(bbox, options = {}) {
  const { release, maxTiles = 100 } = options;

  const zoom = getZoomForBbox(bbox);
  const tiles = bboxToTiles(bbox, zoom);
  const tileCount = (tiles.maxX - tiles.minX + 1) * (tiles.maxY - tiles.minY + 1);

  if (tileCount > maxTiles) {
    console.warn(`[Overture Buildings] Too many tiles (${tileCount}) at zoom ${zoom}, try zooming in.`);
    return [];
  }

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const features = [];

  for (let x = tiles.minX; x <= tiles.maxX; x++) {
    for (let y = tiles.minY; y <= tiles.maxY; y++) {
      try {
        const tileArgs = release
          ? [('buildings'), zoom, x, y, release]
          : ['buildings', zoom, x, y];
        const tileData = await fetchOvertureTile(...tileArgs);

        for (const layerFeatures of Object.values(tileData.layers || {})) {
          for (const feature of layerFeatures) {
            // Filter: only Polygon/MultiPolygon geometries
            const geomType = feature.geometry?.type;
            if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') continue;

            // Bbox filter: check if any coordinate falls within bbox
            if (!featureIntersectsBbox(feature, minLon, minLat, maxLon, maxLat)) continue;

            // Normalize properties
            const props = feature.properties || {};
            features.push({
              type: 'Feature',
              geometry: feature.geometry,
              properties: {
                id: props.id || props['@id'] || null,
                height: props.height != null ? Number(props.height) : null,
                num_floors: props.num_floors != null ? Number(props.num_floors) : null,
              },
            });
          }
        }
      } catch (e) {
        console.warn(`[Overture Buildings] Failed tile ${zoom}/${x}/${y}:`, e.message);
      }
    }
  }

  console.log(`[Overture Buildings] Loaded ${features.length} buildings in bbox`);
  return features;
}

/**
 * Check if any coordinate of a feature falls within a bounding box.
 * @param {GeoJSON.Feature} feature
 * @param {number} minLon
 * @param {number} minLat
 * @param {number} maxLon
 * @param {number} maxLat
 * @returns {boolean}
 */
function featureIntersectsBbox(feature, minLon, minLat, maxLon, maxLat) {
  const coords = feature.geometry?.coordinates;
  if (!coords) return false;

  // Flatten to get individual [lon, lat] pairs
  const flat = flattenCoords(coords);
  for (const [lon, lat] of flat) {
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively flatten nested coordinate arrays to [lon, lat] pairs.
 * @param {Array} coords
 * @returns {number[][]}
 */
function flattenCoords(coords) {
  if (typeof coords[0] === 'number') return [coords];
  const result = [];
  for (const c of coords) {
    result.push(...flattenCoords(c));
  }
  return result;
}

/**
 * Extract the outer ring coordinates from a building feature.
 * For Polygon: coordinates[0]; for MultiPolygon: coordinates[0][0].
 * @param {GeoJSON.Feature} feature
 * @returns {number[][]} Array of [lon, lat] pairs
 */
function getFootprint(feature) {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') return geom.coordinates[0];
  if (geom.type === 'MultiPolygon') return geom.coordinates[0][0];
  return [];
}

/**
 * Extrude a building feature into 3D box geometry.
 *
 * Produces a footprint polygon, wall faces, and base/top elevations.
 * The base elevation is snapped to the DEM by sampling all footprint
 * vertices and taking the minimum.
 *
 * @param {GeoJSON.Feature} feature - Building feature with Polygon geometry
 * @param {Function} demSampler - (lon, lat) → elevation in meters (or null/NaN for no data)
 * @returns {{
 *   baseElev: number,
 *   topElev: number,
 *   footprint: number[][],
 *   walls: Array<{p0: number[], p1: number[], baseElev: number, topElev: number, facingNormal: number[]}>
 * }}
 */
export function extrudeBuilding(feature, demSampler) {
  const footprint = getFootprint(feature);
  const height = getBuildingHeight(feature.properties || {});

  // Sample DEM at all footprint vertices, take minimum for base
  let baseElev = Infinity;
  for (const [lon, lat] of footprint) {
    const elev = demSampler(lon, lat);
    if (elev != null && !isNaN(elev) && isFinite(elev)) {
      baseElev = Math.min(baseElev, elev);
    }
  }
  // Fallback to 0 if DEM has no data for any vertex
  if (!isFinite(baseElev)) baseElev = 0;

  const topElev = baseElev + height;

  // Build wall segments from consecutive footprint vertices
  const walls = [];
  for (let i = 0; i < footprint.length - 1; i++) {
    const p0 = footprint[i];
    const p1 = footprint[i + 1];

    // Compute outward-facing normal (2D, in lon/lat space)
    // Edge vector: (dx, dy), normal: (dy, -dx) normalized
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

  return { baseElev, topElev, footprint, walls };
}
