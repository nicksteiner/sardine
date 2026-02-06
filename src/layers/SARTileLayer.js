import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { getColormap } from '../utils/colormap.js';
import { computeRGBBands, createRGBTexture } from '../utils/sar-composites.js';

/**
 * SARTileLayer - A deck.gl TileLayer specialized for SAR imagery
 * Supports decibel scaling and various colormaps
 */
export class SARTileLayer extends TileLayer {
  static componentName = 'SARTileLayer';
  /**
   * Create a SARTileLayer
   * @param {Object} props - Layer properties
   * @param {Function} props.getTile - Tile fetcher function from COG loader
   * @param {number[]} props.bounds - [minX, minY, maxX, maxY] bounds
   * @param {number[]} props.contrastLimits - [min, max] contrast limits
   * @param {boolean} props.useDecibels - Whether to apply dB scaling
   * @param {string} props.colormap - Colormap name ('grayscale', 'viridis', etc.)
   * @param {number} props.opacity - Layer opacity (0-1)
   */
  constructor(props) {
    const {
      getTile,
      bounds,
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      opacity = 1,
      quality = 'fast',
      minZoom,
      maxZoom = 20,
      tileSize = 256,
      ...otherProps
    } = props;

    // For OrthographicView, compute minZoom so that at minZoom one tile
    // covers the entire extent. At zoom z, each tile covers tileSize * 2^(-z)
    // world units. We need tileSize * 2^(-minZoom) >= maxSpan.
    let computedMinZoom = minZoom;
    if (computedMinZoom === undefined && bounds) {
      const [minX, minY, maxX, maxY] = bounds;
      const maxSpan = Math.max(maxX - minX, maxY - minY);
      computedMinZoom = -Math.ceil(Math.log2(maxSpan / tileSize));
    }
    if (computedMinZoom === undefined) computedMinZoom = -8;

    super({
      id: props.id || 'sar-tile-layer',
      getTileData: async (tile) => {
        // Pass tile bbox so getTile knows the world-coordinate region
        const { bbox } = tile;
        const tileData = await getTile({
          x: tile.index.x,
          y: tile.index.y,
          z: tile.index.z,
          bbox,
          quality,
        });

        if (!tileData) {
          return null;
        }

        // RGB composite mode: tileData has {bands, width, height, compositeId}
        if (tileData.bands && tileData.compositeId) {
          const rgbBands = computeRGBBands(tileData.bands, tileData.compositeId, tileData.width);
          return createRGBTexture(rgbBands, tileData.width, tileData.height, contrastLimits, useDecibels);
        }

        // Single-band mode: convert Float32 data to RGBA texture
        const { data, width, height } = tileData;
        return createSARTexture(data, width, height, contrastLimits, useDecibels, colormap);
      },
      extent: bounds,
      minZoom: computedMinZoom,
      maxZoom,
      tileSize,
      opacity,
      renderSubLayers: (props) => {
        if (!props.data) {
          return null;
        }

        const { bbox } = props.tile;
        // OrthographicView uses left/top/right/bottom; geographic uses west/south/east/north
        const tileBounds = bbox.west !== undefined
          ? [bbox.west, bbox.south, bbox.east, bbox.north]
          : [bbox.left, bbox.top, bbox.right, bbox.bottom];

        return new BitmapLayer({
          id: `${props.id}-bitmap`,
          image: props.data,
          bounds: tileBounds,
          opacity: props.opacity,
        });
      },
      ...otherProps,
    });
  }
}

/**
 * Create an RGBA texture from SAR data
 * @param {Float32Array} data - Raw SAR amplitude data
 * @param {number} width - Tile width
 * @param {number} height - Tile height
 * @param {number[]} contrastLimits - [min, max] contrast limits
 * @param {boolean} useDecibels - Whether to apply dB scaling
 * @param {string} colormap - Colormap name
 * @returns {ImageData} RGBA image data for texture
 */
function createSARTexture(data, width, height, contrastLimits, useDecibels, colormap) {
  const [min, max] = contrastLimits;
  const colormapFunc = getColormap(colormap);
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let i = 0; i < data.length; i++) {
    const amplitude = data[i];
    let value;

    if (useDecibels) {
      // Convert to decibels: dB = 10 * log10(amplitude)
      const db = 10 * Math.log10(Math.max(amplitude, 1e-10));
      value = (db - min) / (max - min);
    } else {
      // Linear scaling
      value = (amplitude - min) / (max - min);
    }

    value = Math.max(0, Math.min(1, value));

    const [r, g, b] = colormapFunc(value);
    const idx = i * 4;
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    // Handle no-data (typically 0 or NaN)
    rgba[idx + 3] = amplitude === 0 || isNaN(amplitude) ? 0 : 255;
  }

  // Create an ImageData object
  return new ImageData(rgba, width, height);
}

export default SARTileLayer;
