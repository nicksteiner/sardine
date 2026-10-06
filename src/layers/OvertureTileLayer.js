/**
 * OvertureTileLayer — viewport-driven Overture overlays for map mode (W033).
 *
 * The native-grid overlay (OvertureLayer.js) fetches one bbox for the whole
 * scene, which caps it at coarse zooms: building footprints only exist from
 * z12 and are dense at z14, so a 60 km frame can never show them that way.
 * In map mode the view is Web Mercator, so each theme becomes a deck.gl
 * TileLayer reading the PMTiles archive tile by tile for what is on screen,
 * at the archive's own zoom range (overzoomed past maxZoom, hidden below
 * minZoom). Styling comes from OVERTURE_THEMES, same as the native overlay.
 */
import { TileLayer } from '@deck.gl/geo-layers';
import { GeoJsonLayer } from '@deck.gl/layers';
import { OVERTURE_THEMES, fetchOvertureTile } from '../loaders/overture-loader.js';
import { extractCoastlineEdges } from './OvertureLayer.js';

// Where each Overture theme archive stops (2026-09-23 planetiler build).
const ARCHIVE_MAX_ZOOM = { base: 13, buildings: 14, divisions: 12, places: 14, transportation: 14 };

function tileBounds(x, y, z) {
  const n = Math.pow(2, z);
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * One TileLayer per enabled theme.
 * @param {string[]} themeKeys - keys of OVERTURE_THEMES
 * @param {{ opacity?: number, release?: string }} [options]
 */
export function createOvertureTileLayers(themeKeys, { opacity = 0.7, release } = {}) {
  const layers = [];
  for (const key of themeKeys) {
    const def = OVERTURE_THEMES[key];
    if (!def) continue;
    const theme = def.theme || key;
    const types = new Set(def.types || []);
    const maxZoom = def.maxZoom ?? ARCHIVE_MAX_ZOOM[theme] ?? 14;
    const minZoom = Math.min(def.minZoom || 0, maxZoom);

    layers.push(new TileLayer({
      id: `overture-tiles-${key}`,
      minZoom,
      maxZoom,
      tileSize: 512, // archive zoom == map zoom, as in MapLibre
      maxRequests: 8,
      refinementStrategy: 'no-overlap',
      opacity,
      getTileData: async ({ index: { x, y, z }, signal }) => {
        if (signal?.aborted) return null;
        const decoded = await fetchOvertureTile(theme, z, x, y, release, def.url);
        const features = [];
        for (const [layerName, fs] of Object.entries(decoded?.layers || {})) {
          if (types.has(layerName)) features.push(...fs);
        }
        if (def.coastlineStroke) {
          return extractCoastlineEdges(features, tileBounds(x, y, z)).features;
        }
        return features;
      },
      renderSubLayers: (props) => {
        const features = props.data;
        if (!features || features.length === 0) return null;
        const stroke = !!def.coastlineStroke;
        return new GeoJsonLayer({
          id: `${props.id}-geo`,
          data: { type: 'FeatureCollection', features },
          opacity,
          filled: stroke ? false : (def.fillOnly || !def.strokeOnly),
          stroked: stroke ? true : !def.fillOnly,
          getFillColor: def.getFillColor || def.color || [200, 200, 200, 100],
          getLineColor: def.lineColor || def.color || [150, 150, 150, 200],
          getLineWidth: def.lineWidth || 1,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          pointType: 'circle',
          getPointRadius: def.pointRadius || 3,
          pointRadiusUnits: 'pixels',
          pointRadiusMinPixels: 2,
          pickable: false,
          parameters: { depthTest: false },
        });
      },
    }));
  }
  return layers;
}
