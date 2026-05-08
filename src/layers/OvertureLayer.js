/**
 * Overture Maps Overlay Layer
 *
 * Renders Overture Maps vector data as deck.gl GeoJsonLayer overlays.
 * Features arrive in WGS84 and are reprojected to the image CRS via proj4.
 *
 * For `coastlineStroke` themes, tile boundary edges are stripped on the CPU
 * before rendering. MVT tiles clip polygons at tile boundaries, creating
 * artificial straight edges. We detect edges where both endpoints lie on
 * the same tile boundary and exclude them, leaving only real coastline geometry.
 */

import { GeoJsonLayer } from '@deck.gl/layers';
import { OVERTURE_THEMES } from '../loaders/overture-loader.js';
import { makeReproject, reprojectFeature } from '../utils/overture-projection.js';

/**
 * Extract non-boundary edges from polygons as LineString features.
 *
 * MVT tiles clip polygons at tile boundaries, creating artificial straight
 * edges. This function walks each polygon ring and detects edges where both
 * endpoints lie on the same tile boundary (within tolerance). Those edges
 * are dropped; consecutive real edges are joined into LineStrings.
 *
 * Operates on WGS84 coordinates (before reprojection) where tile boundaries
 * are at exact slippy-map coordinates.
 */
function extractCoastlineEdges(features, tileBounds) {
  const [minLon, minLat, maxLon, maxLat] = tileBounds;
  // Tolerance: ~0.1% of tile span handles MVT quantisation noise
  const tolX = (maxLon - minLon) * 0.001;
  const tolY = (maxLat - minLat) * 0.001;

  const lines = [];

  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom) continue;

    const rings =
      geom.type === 'Polygon' ? geom.coordinates :
      geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];

    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      let currentLine = [];

      for (let i = 0; i < ring.length - 1; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[i + 1];

        // Edge lies on a tile boundary if both endpoints share the same
        // boundary coordinate (left, right, top, or bottom of tile)
        const onLeft   = Math.abs(x0 - minLon) < tolX && Math.abs(x1 - minLon) < tolX;
        const onRight  = Math.abs(x0 - maxLon) < tolX && Math.abs(x1 - maxLon) < tolX;
        const onBottom = Math.abs(y0 - minLat) < tolY && Math.abs(y1 - minLat) < tolY;
        const onTop    = Math.abs(y0 - maxLat) < tolY && Math.abs(y1 - maxLat) < tolY;

        if (onLeft || onRight || onBottom || onTop) {
          // Artificial boundary edge — flush current line segment
          if (currentLine.length >= 2) {
            lines.push(currentLine);
          }
          currentLine = [];
        } else {
          // Real coastline edge
          if (currentLine.length === 0) {
            currentLine.push(ring[i]);
          }
          currentLine.push(ring[i + 1]);
        }
      }
      if (currentLine.length >= 2) {
        lines.push(currentLine);
      }
    }
  }

  return {
    type: 'FeatureCollection',
    features: lines.map(coords => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    })),
  };
}

/**
 * Create deck.gl layers for Overture data.
 */
export function createOvertureLayers(overtureData, options = {}) {
  const { opacity = 0.7, crs, projection } = options;
  const layers = [];

  if (!overtureData) return layers;

  const reprojectFn = makeReproject({ projection, crs });
  const needsReproject = reprojectFn !== null;

  for (const [themeKey, featureCollection] of Object.entries(overtureData)) {
    if (!featureCollection?.features?.length) continue;

    const themeDef = OVERTURE_THEMES[themeKey];
    if (!themeDef) continue;

    const layerId = `overture-${themeKey}`;

    // Coastline stroke: extract real edges, drop tile-boundary artifacts
    if (themeDef.coastlineStroke && featureCollection.tileGroups) {
      const allLineFeatures = [];
      let edgesBefore = 0, edgesAfter = 0;
      for (const group of featureCollection.tileGroups) {
        if (!group.features.length) continue;
        // Count edges before
        for (const f of group.features) {
          const g = f.geometry;
          if (!g) continue;
          const rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
          for (const r of rings) if (r) edgesBefore += r.length - 1;
        }
        const edgeCollection = extractCoastlineEdges(group.features, group.bounds);
        for (const f of edgeCollection.features) {
          edgesAfter += f.geometry.coordinates.length - 1;
          allLineFeatures.push(needsReproject ? reprojectFeature(f, reprojectFn) : f);
        }
      }

      console.log(`[OvertureLayer] ${themeKey}: ${featureCollection.tileGroups.length} tiles, ${edgesBefore} polygon edges → ${edgesAfter} coastline edges (${edgesBefore - edgesAfter} boundary edges removed), ${allLineFeatures.length} line features`);

      if (allLineFeatures.length === 0) continue;

      layers.push(
        new GeoJsonLayer({
          id: layerId,
          data: { type: 'FeatureCollection', features: allLineFeatures },
          opacity,
          filled: false,
          stroked: true,
          getLineColor: themeDef.lineColor || [200, 200, 200, 200],
          getLineWidth: themeDef.lineWidth || 1,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          pickable: false,
          parameters: { depthTest: false },
        })
      );
      continue;
    }

    // Standard rendering for non-clipped themes
    const data = needsReproject
      ? {
          type: 'FeatureCollection',
          features: featureCollection.features.map(f => reprojectFeature(f, reprojectFn)),
        }
      : featureCollection;

    // coastlineStroke themes without tileGroups (e.g. legacy data, retry path):
    // force stroke-only to avoid filling water polygons across whole tiles.
    const forceStroke = themeDef.coastlineStroke;

    layers.push(
      new GeoJsonLayer({
        id: layerId,
        data,
        opacity,
        filled: forceStroke ? false : (themeDef.fillOnly || !themeDef.strokeOnly),
        stroked: forceStroke ? true : !themeDef.fillOnly,
        getFillColor: themeDef.color || [200, 200, 200, 100],
        getLineColor: themeDef.lineColor || themeDef.color || [150, 150, 150, 200],
        getLineWidth: themeDef.lineWidth || 1,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 1,
        pointType: 'circle',
        getPointRadius: themeDef.pointRadius || 3,
        pointRadiusUnits: 'pixels',
        pointRadiusMinPixels: 2,
        pickable: false,
        parameters: { depthTest: false },
      })
    );
  }

  return layers;
}
