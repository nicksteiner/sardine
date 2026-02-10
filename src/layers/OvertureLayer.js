/**
 * Overture Maps Overlay Layer
 *
 * Renders Overture Maps Foundation vector data (buildings, roads, places)
 * as a deck.gl GeoJsonLayer overlay on top of SAR imagery.
 *
 * Features are fetched on viewport change and cached per bbox tile.
 */

import { GeoJsonLayer } from '@deck.gl/layers';
import { OVERTURE_THEMES } from '../loaders/overture-loader.js';

/**
 * Create deck.gl layers for Overture data.
 *
 * @param {Object} overtureData - Map of themeKey → GeoJSON FeatureCollection
 * @param {Object} options
 * @param {number} options.opacity - Layer opacity (0–1)
 * @returns {Array} deck.gl Layer instances
 */
export function createOvertureLayers(overtureData, options = {}) {
  const { opacity = 0.7 } = options;
  const layers = [];

  if (!overtureData) return layers;

  for (const [themeKey, featureCollection] of Object.entries(overtureData)) {
    if (!featureCollection?.features?.length) continue;

    const themeDef = OVERTURE_THEMES[themeKey];
    if (!themeDef) continue;

    const layerId = `overture-${themeKey}`;

    layers.push(
      new GeoJsonLayer({
        id: layerId,
        data: featureCollection,
        opacity,

        // Polygon styling (buildings, water, land_use)
        filled: true,
        stroked: true,
        getFillColor: themeDef.color || [200, 200, 200, 100],
        getLineColor: themeDef.lineColor || themeDef.color || [150, 150, 150, 200],
        getLineWidth: themeDef.lineWidth || 1,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 1,

        // Point styling (places)
        pointType: 'circle',
        getPointRadius: themeDef.pointRadius || 3,
        pointRadiusUnits: 'pixels',
        pointRadiusMinPixels: 2,

        // Interaction
        pickable: true,
        autoHighlight: true,
        highlightColor: [78, 201, 212, 100], // sardine cyan highlight

        // Performance
        parameters: {
          depthTest: false,
        },
      })
    );
  }

  return layers;
}
