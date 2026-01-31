import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { getColormapId } from './shaders.js';

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
  const colormapFunc = getColormapFunction(colormap);
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

/**
 * Get colormap function by name
 * @param {string} name - Colormap name
 * @returns {Function} Colormap function that takes a value 0-1 and returns [r, g, b] 0-255
 */
function getColormapFunction(name) {
  const colormaps = {
    grayscale: (t) => {
      const v = Math.round(t * 255);
      return [v, v, v];
    },
    viridis: viridis,
    inferno: inferno,
    plasma: plasma,
    phase: phaseColormap,
  };

  return colormaps[name] || colormaps.grayscale;
}

/**
 * Viridis colormap implementation
 */
function viridis(t) {
  // Viridis lookup table (simplified polynomial approximation)
  const c0 = [0.2777, 0.0054, 0.334];
  const c1 = [0.105, 0.6389, 0.7916];
  const c2 = [-0.3308, 0.2149, 0.0948];
  const c3 = [-4.6342, -5.7991, -19.3324];
  const c4 = [6.2282, 14.1799, 56.6905];
  const c5 = [4.7763, -13.7451, -65.353];
  const c6 = [-5.4354, 4.6456, 26.3124];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Inferno colormap implementation
 */
function inferno(t) {
  const c0 = [0.0002, 0.0016, 0.0139];
  const c1 = [0.1065, 0.0639, 0.2671];
  const c2 = [0.9804, 0.5388, -0.1957];
  const c3 = [-3.4496, -0.2218, -3.1556];
  const c4 = [3.8558, -2.0792, 8.7339];
  const c5 = [-1.4928, 1.8878, -8.0579];
  const c6 = [-0.0003, 0.0009, 2.4578];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Plasma colormap implementation
 */
function plasma(t) {
  const c0 = [0.0505, 0.0298, 0.528];
  const c1 = [2.0206, 0.0, 0.7067];
  const c2 = [-1.0313, 1.2882, 0.3985];
  const c3 = [-6.0884, -0.7839, -4.6899];
  const c4 = [7.1103, -2.6782, 6.5379];
  const c5 = [-2.7666, 3.0649, -3.538];
  const c6 = [0.8027, -0.8948, 0.9565];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Phase colormap (cyclic) for interferometry
 */
function phaseColormap(t) {
  t = Math.max(0, Math.min(1, t));
  const angle = t * 2 * Math.PI;
  const r = Math.round((0.5 + 0.5 * Math.cos(angle)) * 255);
  const g = Math.round((0.5 + 0.5 * Math.cos(angle + (2 * Math.PI) / 3)) * 255);
  const b = Math.round((0.5 + 0.5 * Math.cos(angle + (4 * Math.PI) / 3)) * 255);
  return [r, g, b];
}

export default SARTileLayer;
