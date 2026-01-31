import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { getColormap } from '../utils/colormap.js';

/**
 * SARTileLayer - A deck.gl TileLayer specialized for SAR imagery
 * Supports decibel scaling and various colormaps
 */
export class SARTileLayer extends TileLayer {
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
      minZoom = 0,
      maxZoom = 20,
      tileSize = 256,
      ...otherProps
    } = props;

    super({
      id: props.id || 'sar-tile-layer',
      getTileData: async (tile) => {
        const tileData = await getTile({
          x: tile.index.x,
          y: tile.index.y,
          z: tile.index.z,
        });

        if (!tileData) {
          return null;
        }

        // Convert Float32 data to RGBA texture
        const { data, width, height } = tileData;
        return createSARTexture(data, width, height, contrastLimits, useDecibels, colormap);
      },
      extent: bounds,
      minZoom,
      maxZoom,
      tileSize,
      opacity,
      renderSubLayers: (props) => {
        const {
          bbox: { west, south, east, north },
        } = props.tile;

        if (!props.data) {
          return null;
        }

        return new BitmapLayer({
          id: `${props.id}-bitmap`,
          image: props.data,
          bounds: [west, south, east, north],
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
