/**
 * SARSceneLayer — 3D scene geometry overlay for SAR imagery
 *
 * Composite deck.gl layer that renders SAR scene geometry predictions:
 *   (1) buildings3d      — extruded building footprints via SolidPolygonLayer
 *   (2) predictedDihedrals — predicted dihedral reflection strips (PolygonLayer)
 *   (3) predictedShadows   — predicted radar shadow zones (PolygonLayer)
 *   (4) pointIntercepted   — back-projected SAR pixels as 3D point cloud (PointCloudLayer)
 *
 * Props:
 *   mode             — 'buildings3d' | 'predictedDihedrals' | 'predictedShadows' | 'pointIntercepted'
 *   buildings        — Feature[] from loadBuildingsInBbox()
 *   extrudedBuildings — Array<{baseElev, topElev, footprint, walls}> from extrudeBuilding()
 *   dihedralStrips   — Array<{polygon: number[][], intensity?: number}> (see prepareDihedralStrips)
 *   shadowZones      — Array<{polygon: number[][]}> (see prepareShadowZones)
 *   pointCloud       — {positions: Float32Array, colors: Uint8Array, count}
 *   selectionBbox    — [west, south, east, north] required for pointIntercepted mode
 *   opacity          — layer opacity (default 0.7)
 *   buildingColor    — [r,g,b,a] for buildings3d
 *   dihedralColor    — [r,g,b,a] for dihedral strips
 *   shadowColor      — [r,g,b,a] for shadow zones
 */

import { CompositeLayer } from '@deck.gl/core';
import { SolidPolygonLayer, PolygonLayer, PointCloudLayer } from '@deck.gl/layers';
import { resolveHeight } from '../loaders/overture-buildings.js';
import {
  predictDihedralStrip,
  predictShadowZone,
  slantToGroundPoint,
  groundPointToSlant,
} from '../utils/sar-geometry.js';

/** Valid mode names. */
export const SCENE_MODES = ['buildings3d', 'predictedDihedrals', 'predictedShadows', 'pointIntercepted'];

const DEFAULTS = {
  buildingColor: [70, 130, 230, 180],
  buildingSideColor: [50, 100, 200, 160],
  dihedralColor: [255, 60, 60, 200],
  shadowColor: [80, 80, 80, 120],
  pointSize: 3,
};

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ─── Helpers: convert D171 vertex arrays to polygon arrays ──────────

/**
 * Convert an array of {row, col} vertices (from predictDihedralStrip /
 * predictShadowZone) into a closed [x, y] polygon for deck.gl.
 *
 * SARViewer uses an OrthographicView with flipY:false and the SAR image
 * placed with row 0 at world y = nRows (top). So image (row, col) maps to
 * deck.gl world (col, nRows - row).
 *
 * @param {{row:number, col:number}[]} vertices
 * @param {number} nRows  - Image height in pixels (for Y flip)
 * @returns {number[][]}  Closed polygon ring in [x, y]
 */
function verticesToPolygon(vertices, nRows) {
  if (!vertices || vertices.length < 3) return null;
  const ring = vertices.map(v => [v.col, nRows - v.row]);
  // Close the ring
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/**
 * Prepare dihedral strip polygons from buildings + SAR geometry.
 *
 * Converts Overture building features (with footprint in degrees) into
 * the radians-based BuildingFootprint format expected by predictDihedralStrip,
 * runs the prediction, and returns polygon data ready for the layer.
 *
 * @param {Array} extrudedBuildings - from extrudeBuilding() (D173)
 * @param {import('../utils/sar-geometry.js').SARGeometry} geometry - SAR view geometry
 * @param {Object} [opts]
 * @param {number} [opts.azWidth=4] - half-width of strip polygon in azimuth pixels
 * @param {function} [opts.getTile] - optional (row,col)->intensity sampler
 * @returns {Array<{polygon: number[][], intensity?: number}>}
 */
export function prepareDihedralStrips(extrudedBuildings, geometry, opts = {}) {
  const { getTile } = opts;
  const nRows = geometry?.nRows;
  if (!nRows) {
    console.warn('[SARSceneLayer] prepareDihedralStrips: geometry.nRows missing');
    return [];
  }
  const result = [];

  for (const bldg of extrudedBuildings) {
    // predictDihedralStrip wants footprint as {lat, lon} in DEGREES
    // (groundPointToSlant takes degrees and converts internally)
    const footprintLL = bldg.footprint.map(([lon, lat]) => ({ lat, lon }));

    const wall = {
      footprint: footprintLL,
      height: bldg.topElev - bldg.baseElev,
      baseElev: bldg.baseElev,
    };

    let vertices;
    try {
      vertices = predictDihedralStrip(wall, geometry);
    } catch (e) {
      continue;
    }
    const polygon = verticesToPolygon(vertices, nRows);
    if (!polygon) continue;

    const entry = { polygon };
    if (getTile) {
      // Sample intensity at the centroid
      let cr = 0, cc = 0;
      for (const v of vertices) { cr += v.row; cc += v.col; }
      cr /= vertices.length; cc /= vertices.length;
      entry.intensity = getTile(Math.round(cr), Math.round(cc)) || 0;
    }
    result.push(entry);
  }

  return result;
}

/**
 * Prepare shadow zone polygons from buildings + SAR geometry.
 *
 * @param {Array} extrudedBuildings - from extrudeBuilding() (D173)
 * @param {import('../utils/sar-geometry.js').SARGeometry} geometry
 * @param {Object} [opts]
 * @param {number} [opts.azWidth=4] - half-width of strip polygon in azimuth pixels
 * @returns {Array<{polygon: number[][]}>}
 */
export function prepareShadowZones(extrudedBuildings, geometry, opts = {}) {
  const nRows = geometry?.nRows;
  if (!nRows) {
    console.warn('[SARSceneLayer] prepareShadowZones: geometry.nRows missing');
    return [];
  }
  const result = [];

  for (const bldg of extrudedBuildings) {
    const footprintLL = bldg.footprint.map(([lon, lat]) => ({ lat, lon }));

    const wall = {
      footprint: footprintLL,
      height: bldg.topElev - bldg.baseElev,
      baseElev: bldg.baseElev,
    };

    let vertices;
    try {
      vertices = predictShadowZone(wall, geometry);
    } catch (e) {
      continue;
    }
    const polygon = verticesToPolygon(vertices, nRows);
    if (!polygon) continue;
    result.push({ polygon });
  }

  return result;
}

/**
 * Build a point cloud by back-projecting SAR pixels within a selection bbox.
 *
 * Iterates over a grid of pixels within the bbox, projects each to ground
 * coordinates via DEM, and samples intensity for color.
 *
 * @param {number[]} selectionBbox - [west, south, east, north] in degrees
 * @param {import('../utils/sar-geometry.js').SARGeometry} geometry
 * @param {function} demSampler - (lat, lon) → height in meters
 * @param {function} getTile - (row, col) → intensity value
 * @param {Object} [opts]
 * @param {number} [opts.step=2] - pixel step (skip pixels for speed)
 * @param {number} [opts.maxPoints=100000] - cap on total points
 * @returns {{positions: Float32Array, colors: Uint8Array, count: number}}
 */
export function buildPointCloud(selectionBbox, geometry, demSampler, getTile, opts = {}) {
  const { step = 2, maxPoints = 100000 } = opts;
  const [west, south, east, north] = selectionBbox;

  // Convert bbox corners to pixel space to find row/col bounds
  const corners = [
    groundPointToSlant(south * DEG, west * DEG, 0, geometry),
    groundPointToSlant(south * DEG, east * DEG, 0, geometry),
    groundPointToSlant(north * DEG, west * DEG, 0, geometry),
    groundPointToSlant(north * DEG, east * DEG, 0, geometry),
  ];

  let minRow = Infinity, maxRow = -Infinity;
  let minCol = Infinity, maxCol = -Infinity;
  for (const { row, col } of corners) {
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
  }
  minRow = Math.max(0, Math.floor(minRow));
  maxRow = Math.ceil(maxRow);
  minCol = Math.max(0, Math.floor(minCol));
  maxCol = Math.ceil(maxCol);

  const nRows = Math.ceil((maxRow - minRow) / step);
  const nCols = Math.ceil((maxCol - minCol) / step);
  const totalPossible = nRows * nCols;
  const effectiveStep = totalPossible > maxPoints
    ? step * Math.ceil(Math.sqrt(totalPossible / maxPoints))
    : step;

  const positions = [];
  const colors = [];

  for (let r = minRow; r <= maxRow; r += effectiveStep) {
    for (let c = minCol; c <= maxCol; c += effectiveStep) {
      if (positions.length / 3 >= maxPoints) break;

      const demSamplerRad = (latRad, lonRad) => {
        return demSampler(latRad * RAD, lonRad * RAD);
      };
      const ground = slantToGroundPoint(r, c, geometry, demSamplerRad);

      // Filter: only include points within the selection bbox
      const latDeg = ground.lat * RAD;
      const lonDeg = ground.lon * RAD;
      if (latDeg < south || latDeg > north || lonDeg < west || lonDeg > east) continue;

      positions.push(lonDeg, latDeg, ground.h);

      // Color by intensity
      const intensity = getTile(r, c) || 0;
      const dB = intensity > 0 ? 10 * Math.log10(intensity) : -40;
      const t = Math.max(0, Math.min(1, (dB + 30) / 30)); // map [-30, 0] dB to [0, 1]
      colors.push(
        Math.round(t * 255),
        Math.round(t * 200),
        Math.round((1 - t) * 100),
        255
      );
    }
  }

  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    count,
  };
}

// ─── SARSceneLayer (CompositeLayer) ─────────────────────────────────

export class SARSceneLayer extends CompositeLayer {
  renderLayers() {
    const { mode } = this.props;
    switch (mode) {
      case 'buildings3d':
        return this._renderBuildings3D();
      case 'predictedDihedrals':
        return this._renderDihedrals();
      case 'predictedShadows':
        return this._renderShadows();
      case 'pointIntercepted':
        return this._renderPointIntercepted();
      default:
        console.warn(`[SARSceneLayer] Unknown mode: ${mode}`);
        return [];
    }
  }

  // ── Mode 1: Extruded 3D buildings ──────────────────────────────────

  _renderBuildings3D() {
    const {
      extrudedBuildings,
      buildings,
      opacity = 0.7,
      buildingColor = DEFAULTS.buildingColor,
    } = this.props;

    const data = extrudedBuildings || buildings;
    if (!data || data.length === 0) return [];

    const isExtruded = !!extrudedBuildings;

    return [
      new SolidPolygonLayer({
        id: `${this.props.id}-buildings3d`,
        data,
        extruded: true,
        wireframe: false,
        opacity,
        getPolygon: d => {
          if (isExtruded) return d.footprint;
          const geom = d.geometry;
          if (geom.type === 'Polygon') return geom.coordinates[0];
          if (geom.type === 'MultiPolygon') return geom.coordinates[0][0];
          return [];
        },
        getElevation: d => {
          if (isExtruded) return d.topElev - d.baseElev;
          return resolveHeight(d.properties || {});
        },
        elevationScale: 1,
        getFillColor: buildingColor,
        material: {
          ambient: 0.4,
          diffuse: 0.6,
          shininess: 32,
        },
        parameters: { depthTest: true },
        updateTriggers: {
          getPolygon: [isExtruded],
          getElevation: [isExtruded],
        },
      }),
    ];
  }

  // ── Mode 2: Predicted dihedral reflection strips ───────────────────

  _renderDihedrals() {
    const {
      dihedralStrips,
      opacity = 0.7,
      dihedralColor = DEFAULTS.dihedralColor,
    } = this.props;

    if (!dihedralStrips || dihedralStrips.length === 0) {
      console.warn(
        '[SARSceneLayer] predictedDihedrals mode requires dihedralStrips prop. ' +
        'Use prepareDihedralStrips() to generate from buildings + geometry.'
      );
      return [];
    }

    return [
      new PolygonLayer({
        id: `${this.props.id}-dihedrals`,
        data: dihedralStrips,
        filled: true,
        stroked: true,
        opacity,
        getPolygon: d => d.polygon,
        getFillColor: d => {
          if (d.intensity != null) {
            const alpha = Math.min(255, Math.max(40, Math.round(d.intensity * 255)));
            return [dihedralColor[0], dihedralColor[1], dihedralColor[2], alpha];
          }
          return dihedralColor;
        },
        getLineColor: [255, 60, 60, 255],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 1,
        parameters: { depthTest: false },
        updateTriggers: {
          getFillColor: [dihedralColor],
        },
      }),
    ];
  }

  // ── Mode 3: Predicted shadow zones ─────────────────────────────────

  _renderShadows() {
    const {
      shadowZones,
      opacity = 0.5,
      shadowColor = DEFAULTS.shadowColor,
    } = this.props;

    if (!shadowZones || shadowZones.length === 0) {
      console.warn(
        '[SARSceneLayer] predictedShadows mode requires shadowZones prop. ' +
        'Use prepareShadowZones() to generate from buildings + geometry.'
      );
      return [];
    }

    return [
      new PolygonLayer({
        id: `${this.props.id}-shadows`,
        data: shadowZones,
        filled: true,
        stroked: false,
        opacity,
        getPolygon: d => d.polygon,
        getFillColor: shadowColor,
        parameters: { depthTest: false },
      }),
    ];
  }

  // ── Mode 4: Point-intercepted display ──────────────────────────────

  _renderPointIntercepted() {
    const {
      pointCloud,
      selectionBbox,
      opacity = 0.9,
      pointSize = DEFAULTS.pointSize,
    } = this.props;

    if (!selectionBbox) {
      console.warn(
        '[SARSceneLayer] pointIntercepted mode requires selectionBbox prop ' +
        '(full-scene is too many points).'
      );
      return [];
    }

    if (!pointCloud || pointCloud.count === 0) {
      console.warn(
        '[SARSceneLayer] pointIntercepted mode requires pointCloud prop. ' +
        'Use buildPointCloud() to generate from SAR pixels + DEM.'
      );
      return [];
    }

    return [
      new PointCloudLayer({
        id: `${this.props.id}-points`,
        data: {
          length: pointCloud.count,
          attributes: {
            getPosition: { value: pointCloud.positions, size: 3 },
            getColor: { value: pointCloud.colors, size: 4 },
          },
        },
        opacity,
        pointSize,
        sizeUnits: 'pixels',
        parameters: { depthTest: true },
      }),
    ];
  }
}

SARSceneLayer.layerName = 'SARSceneLayer';
SARSceneLayer.defaultProps = {
  mode: 'buildings3d',
  buildings: { type: 'value', value: null },
  extrudedBuildings: { type: 'value', value: null },
  dihedralStrips: { type: 'value', value: null },
  shadowZones: { type: 'value', value: null },
  pointCloud: { type: 'value', value: null },
  selectionBbox: { type: 'value', value: null },
  opacity: { type: 'number', value: 0.7 },
  buildingColor: { type: 'color', value: DEFAULTS.buildingColor },
  buildingSideColor: { type: 'color', value: DEFAULTS.buildingSideColor },
  dihedralColor: { type: 'color', value: DEFAULTS.dihedralColor },
  shadowColor: { type: 'color', value: DEFAULTS.shadowColor },
  pointSize: { type: 'number', value: DEFAULTS.pointSize },
};
