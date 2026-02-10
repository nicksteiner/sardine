import { BitmapLayer } from '@deck.gl/layers';
import { getColormap } from '../utils/colormap.js';
import { applyStretch } from '../utils/stretch.js';

/**
 * SARBitmapLayer - A deck.gl BitmapLayer for full SAR images
 * Loads the entire image at once (good for small-to-medium COGs)
 * Supports decibel scaling and various colormaps
 */
export class SARBitmapLayer extends BitmapLayer {
  static componentName = 'SARBitmapLayer';

  /**
   * Create a SARBitmapLayer
   * @param {Object} props - Layer properties
   * @param {Float32Array} props.data - Raw SAR amplitude data
   * @param {number} props.width - Image width
   * @param {number} props.height - Image height
   * @param {number[]} props.bounds - [minX, minY, maxX, maxY] bounds
   * @param {number[]} props.contrastLimits - [min, max] contrast limits
   * @param {boolean} props.useDecibels - Whether to apply dB scaling
   * @param {string} props.colormap - Colormap name ('grayscale', 'viridis', etc.)
   * @param {number} props.opacity - Layer opacity (0-1)
   */
  constructor(props) {
    const {
      data,
      width,
      height,
      bounds,
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear',
      opacity = 1,
      ...otherProps
    } = props;

    // Create RGBA texture from SAR data
    const imageData = createSARTexture(data, width, height, contrastLimits, useDecibels, colormap, gamma, stretchMode);

    super({
      id: props.id || 'sar-bitmap-layer',
      image: imageData,
      bounds,
      opacity,
      ...otherProps,
    });
  }
}

/**
 * Create an RGBA texture from SAR data
 * @param {Float32Array} data - Raw SAR amplitude data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number[]} contrastLimits - [min, max] contrast limits
 * @param {boolean} useDecibels - Whether to apply dB scaling
 * @param {string} colormap - Colormap name
 * @returns {ImageData} RGBA image data for texture
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

export default SARBitmapLayer;
