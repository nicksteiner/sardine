/**
 * OvertureSlantLayer — Overture features projected into SICD slant-range
 *                      pixel space via the sarpy-equivalent sicd-projection.
 *
 * When a SICD NITF is loaded, the main SARdine viewer renders the image in
 * its native (col, row) pixel frame. To overlay Overture buildings/roads on
 * that image, each feature vertex must be transformed via groundToImageBulk
 * so it lands on the correct pixel.
 *
 * This module:
 *   1. Walks GeoJSON features and bulk-projects all vertices.
 *   2. Applies the y-flip that the SAR layer uses: world_y = nRows - row.
 *      (SARGPULayer places image row 0 at world y = nRows via its texCoord
 *      layout, and SARViewer's OrthographicView has flipY=false.)
 *   3. Builds deck.gl PolygonLayer/PathLayer instances with positions in
 *      pixel-world coordinates — no GeoJsonLayer (which would interpret
 *      coordinates as lon/lat).
 *
 * When `showLayover` is true, buildings with a non-null Overture `height`
 * are drawn a second time at that height — the shifted position is where
 * the building top actually images in the SAR scene.
 */

import { PolygonLayer, PathLayer } from '@deck.gl/layers';
import { groundToImageBulk } from '../utils/sicd-projection.js';

// ─── Vertex projection helpers ───────────────────────────────────────────────

/**
 * Project a flat [lon, lat] vertex ring into pixel-world [x, y] positions.
 * Returns a Float32Array of interleaved [x0, y0, x1, y1, ...] suitable for
 * deck.gl positionFormat: 'XY'.
 *
 * IMPORTANT: `h` is the feature's height above the WGS84 ellipsoid (HAE),
 * not above mean sea level and not above local terrain. For Overture
 * features (which don't carry elevation), use the SCP HAE as the ground
 * reference — this matches sarpy's image_to_ground_hae default and avoids
 * a large row shift at shallow graze. Passing h=0 would assume the feature
 * is at the ellipsoid, which is typically ~30-60 m below the actual scene
 * surface and causes a visible translational offset in row (range).
 *
 * @param {Array<[number, number]>} ring
 * @param {number} h height above WGS84 ellipsoid, in meters
 * @param {Object} proj  from buildSICDProjection()
 * @returns {Float32Array}
 */
function projectRing(ring, h, proj) {
  const N = ring.length;
  // Copy to typed arrays for the bulk projector
  const lons = new Float64Array(N);
  const lats = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lons[i] = ring[i][0];
    lats[i] = ring[i][1];
  }
  const rc = groundToImageBulk(lons, lats, h, proj); // interleaved [row, col, ...]
  const nRows = proj.nRows;
  const out = new Float32Array(2 * N);
  for (let i = 0; i < N; i++) {
    const row = rc[2 * i];
    const col = rc[2 * i + 1];
    out[2 * i]     = col;               // world x = col
    out[2 * i + 1] = nRows - row;       // world y = nRows - row (image-coord flip)
  }
  return out;
}

/**
 * Test whether a projected ring has any vertex inside (or near) the image frame.
 * Used to cull features that fall entirely outside the scene.
 */
function ringIntersectsImage(xyFlat, nCols, nRows, pad = 500) {
  for (let i = 0; i < xyFlat.length; i += 2) {
    const x = xyFlat[i];
    const y = xyFlat[i + 1];
    if (x > -pad && x < nCols + pad && y > -pad && y < nRows + pad) return true;
  }
  return false;
}

// ─── Build layer data ────────────────────────────────────────────────────────

/**
 * Walk Overture feature data and produce arrays of projected polygons and
 * paths in pixel-world coordinates.
 *
 * @param {Object} overtureData  { themeName: Feature[] }
 * @param {Object} proj          from buildSICDProjection()
 * @returns {{ polygons: Array, paths: Array, layoverPolygons: Array }}
 */
function buildSlantFeatures(overtureData, proj, { includeLayover }) {
  const polygons = [];         // { polygon: [[x,y], ...], color, theme, id }
  const paths = [];            // { path: [[x,y], ...], color, width, theme, id }
  const layoverPolygons = [];  // building tops at height>0

  const nC = proj.nCols, nR = proj.nRows;

  // Ground reference HAE for features that don't carry elevation.
  // Using 0 (the WGS84 ellipsoid) would put features ~30-60 m below the
  // actual scene surface, which translates into a large row (range) shift
  // at shallow graze angles. Using SCP HAE matches sarpy's image_to_ground_hae
  // default behavior and keeps translational error to a few row pixels.
  const baseHae = proj.scpHae || 0;

  const addPolyRing = (ring, { color, theme, id, height }) => {
    if (!ring || ring.length < 3) return;
    const xy = projectRing(ring, baseHae, proj);
    if (!ringIntersectsImage(xy, nC, nR)) return;
    // Convert interleaved Float32Array → array of [x,y] pairs for deck.gl
    const poly = [];
    for (let i = 0; i < xy.length; i += 2) poly.push([xy[i], xy[i + 1]]);
    polygons.push({ polygon: poly, color, theme, id });

    if (includeLayover && typeof height === 'number' && height > 0) {
      const xyTop = projectRing(ring, baseHae + height, proj);
      if (ringIntersectsImage(xyTop, nC, nR)) {
        const topPoly = [];
        for (let i = 0; i < xyTop.length; i += 2) topPoly.push([xyTop[i], xyTop[i + 1]]);
        layoverPolygons.push({ polygon: topPoly, theme, id });
      }
    }
  };

  const addPath = (line, { color, width, theme, id }) => {
    if (!line || line.length < 2) return;
    const xy = projectRing(line, baseHae, proj);
    if (!ringIntersectsImage(xy, nC, nR)) return;
    const path = [];
    for (let i = 0; i < xy.length; i += 2) path.push([xy[i], xy[i + 1]]);
    paths.push({ path, color, width, theme, id });
  };

  for (const [themeName, fc] of Object.entries(overtureData)) {
    // overtureData values are FeatureCollection objects: { features: [...] }
    const features = Array.isArray(fc) ? fc : (fc?.features || []);
    if (features.length === 0) continue;
    // Theme styling — keep simple, in RGBA.
    const isBuildings = themeName === 'buildings';
    const isRoads = themeName === 'transportation';
    const color = isBuildings ? [255, 140, 0, 150]
                : isRoads ? [200, 200, 200, 220]
                : [120, 200, 255, 180];
    const lineWidth = isRoads ? 2 : 1;

    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      const id = f.id || f.properties?.id;
      const height = f.properties?.height;
      if (g.type === 'Polygon') {
        addPolyRing(g.coordinates[0], { color, theme: themeName, id, height });
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) addPolyRing(poly[0], { color, theme: themeName, id, height });
      } else if (g.type === 'LineString') {
        addPath(g.coordinates, { color, width: lineWidth, theme: themeName, id });
      } else if (g.type === 'MultiLineString') {
        for (const line of g.coordinates) addPath(line, { color, width: lineWidth, theme: themeName, id });
      }
    }
  }

  return { polygons, paths, layoverPolygons };
}

// ─── Public: create deck.gl layers ──────────────────────────────────────────

/**
 * Create deck.gl overlay layers rendering Overture features projected into
 * SICD pixel-world coordinates.
 *
 * @param {Object} overtureData  { themeName: Feature[] } from fetchAllOvertureThemes
 * @param {Object} projection    from buildSICDProjection()
 * @param {Object} [options]
 * @param {number} [options.opacity=0.7]
 * @param {boolean} [options.showLayover=false]  draw building tops at height
 * @returns {Array} deck.gl layer instances (empty if no projection or data)
 */
export function createOvertureSlantLayers(overtureData, projection, options = {}) {
  if (!overtureData || !projection) return [];
  const { opacity = 0.7, showLayover = false } = options;

  const { polygons, paths, layoverPolygons } = buildSlantFeatures(
    overtureData, projection, { includeLayover: showLayover }
  );

  const layers = [];

  if (paths.length > 0) {
    layers.push(new PathLayer({
      id: 'overture-slant-paths',
      data: paths,
      pickable: true,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: d => d.width,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      opacity,
    }));
  }

  if (polygons.length > 0) {
    layers.push(new PolygonLayer({
      id: 'overture-slant-polygons',
      data: polygons,
      pickable: true,
      filled: true,
      stroked: true,
      getPolygon: d => d.polygon,
      getFillColor: d => d.color,
      getLineColor: [255, 180, 40, 230],
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 1,
      opacity,
    }));
  }

  if (layoverPolygons.length > 0) {
    layers.push(new PolygonLayer({
      id: 'overture-slant-layover-tops',
      data: layoverPolygons,
      pickable: false,
      filled: false,
      stroked: true,
      getPolygon: d => d.polygon,
      getLineColor: [253, 224, 71, 235], // yellow for layover-shifted tops
      getLineWidth: 1.5,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 1,
      opacity,
    }));
  }

  return layers;
}
