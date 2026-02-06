import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { getColormap } from '../utils/colormap.js';
import { computeRGBBands, createRGBTexture } from '../utils/sar-composites.js';
import { applyStretch } from '../utils/stretch.js';

/**
 * SARTileLayer - A deck.gl TileLayer specialized for SAR imagery
 *
 * Raw float data is cached in getTileData; rendering (dB, colormap, contrast)
 * is applied in renderSubLayers so prop changes are instant without refetching.
 */
export class SARTileLayer extends TileLayer {
  static componentName = 'SARTileLayer';

  constructor(props) {
    const {
      getTile,
      bounds,
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear',
      opacity = 1,
      multiLook = false,
      minZoom,
      maxZoom = 20,
      tileSize = 256,
      ...otherProps
    } = props;

    let computedMinZoom = minZoom;
    if (computedMinZoom === undefined && bounds) {
      const [minX, minY, maxX, maxY] = bounds;
      const maxSpan = Math.max(maxX - minX, maxY - minY);
      computedMinZoom = -Math.ceil(Math.log2(maxSpan / tileSize));
    }
    if (computedMinZoom === undefined) computedMinZoom = -8;

    // dB/colormap/contrast are applied in renderSubLayers (instant).
    const layerId = `${props.id || 'sar-tile-layer'}-${multiLook ? 'ml' : 'nn'}`;

    super({
      id: layerId,

      // getTileData caches RAW float data (not rendered textures)
      getTileData: async (tile) => {
        const { bbox } = tile;
        const tileData = await getTile({
          x: tile.index.x,
          y: tile.index.y,
          z: tile.index.z,
          bbox,
          multiLook,
        });
        if (!tileData) return null;
        // Return raw data — rendering happens in renderSubLayers
        return tileData;
      },

      extent: bounds,
      minZoom: computedMinZoom,
      maxZoom,
      tileSize,
      opacity,

      // Force sublayer re-render when rendering params change
      updateTriggers: {
        renderSubLayers: [contrastLimits, useDecibels, colormap, gamma, stretchMode],
      },

      renderSubLayers: (subProps) => {
        const tileData = subProps.data;
        if (!tileData) return null;

        const { bbox } = subProps.tile;
        const tileBounds = bbox.west !== undefined
          ? [bbox.west, bbox.south, bbox.east, bbox.north]
          : [bbox.left, bbox.top, bbox.right, bbox.bottom];

        let image;

        // RGB composite mode
        if (tileData.bands && tileData.compositeId) {
          const rgbBands = computeRGBBands(tileData.bands, tileData.compositeId, tileData.width);
          image = createRGBTexture(rgbBands, tileData.width, tileData.height, contrastLimits, useDecibels, gamma, stretchMode);
        } else if (tileData.data) {
          // Single-band mode
          image = createSARTexture(tileData.data, tileData.width, tileData.height, contrastLimits, useDecibels, colormap, gamma, stretchMode);
        } else {
          return null;
        }

        return new BitmapLayer({
          id: `${subProps.id}-bitmap`,
          image,
          bounds: tileBounds,
          opacity: subProps.opacity,
        });
      },

      ...otherProps,
    });
  }
}

/**
 * Create an RGBA texture from SAR data
 */
function createSARTexture(data, width, height, contrastLimits, useDecibels, colormap, gamma = 1.0, stretchMode = 'linear') {
  const [min, max] = contrastLimits;
  const colormapFunc = getColormap(colormap);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;

  for (let i = 0; i < data.length; i++) {
    const amplitude = data[i];
    let value;

    if (useDecibels) {
      const db = 10 * Math.log10(Math.max(amplitude, 1e-10));
      value = (db - min) / (max - min);
    } else {
      value = (amplitude - min) / (max - min);
    }

    value = Math.max(0, Math.min(1, value));
    if (needsStretch) value = applyStretch(value, stretchMode, gamma);

    const [r, g, b] = colormapFunc(value);
    const idx = i * 4;
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = amplitude === 0 || isNaN(amplitude) ? 0 : 255;
  }

  return new ImageData(rgba, width, height);
}

export default SARTileLayer;
