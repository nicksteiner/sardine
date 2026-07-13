import { BitmapLayer } from '@deck.gl/layers';
import GL from '@luma.gl/constants';
import { getColormap } from '../utils/colormap.js';
import { createStretchFn } from '../utils/stretch.js';

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
      reverseColormap = false,
      gamma = 1.0,
      stretchMode = 'linear',
      opacity = 1,
      dataMask = null,
      maskInvalid = false,
      maskLayoverShadow = false,
      classMode = false,
      classPalette = null,      // Uint8Array(256*3) packed RGB per class index
      ...otherProps
    } = props;

    // Create RGBA texture from SAR data. Class-map rasters use a direct
    // integer-label → palette lookup (no dB/stretch/colormap); everything else
    // uses the continuous SAR pipeline.
    const imageData = (classMode && classPalette)
      ? createClassTexture(data, width, height, classPalette, dataMask, maskInvalid, maskLayoverShadow)
      : createSARTexture(data, width, height, contrastLimits, useDecibels, colormap, gamma, stretchMode, dataMask, maskInvalid, maskLayoverShadow, reverseColormap);

    super({
      id: props.id || 'sar-bitmap-layer',
      image: imageData,
      bounds,
      opacity,
      // Class maps: NEAREST sampling so class colors stay crisp when zoomed in
      // (bilinear would smear color across class boundaries).
      ...((classMode && classPalette) ? {
        textureParameters: {
          [GL.TEXTURE_MIN_FILTER]: GL.NEAREST,
          [GL.TEXTURE_MAG_FILTER]: GL.NEAREST,
        },
      } : {}),
      ...otherProps,
    });
  }

  _createR32FTexture(gl, data, width, height) {
    const expectedSize = width * height;
    let texData;

    // Pad undersized arrays for edge tiles at dataset boundary
    if (!data || data.length === 0) {
      texData = new Float32Array(expectedSize);
      texData.fill(NaN);
    } else if (data.length < expectedSize) {
      texData = new Float32Array(expectedSize);
      texData.fill(NaN);
      texData.set(data);
    } else {
      texData = data.length > expectedSize ? data.subarray(0, expectedSize) : data;
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      width, height, 0,
      gl.RED, gl.FLOAT, texData
    );

    return texture;
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
 * @param {Float32Array} dataMask - Mask data (NISAR 3-digit encoding)
 * @param {boolean} maskInvalid - Hide invalid (0) and fill (255) pixels
 * @param {boolean} maskLayoverShadow - Hide layover/shadow pixels (mask < 100)
 * @returns {ImageData} RGBA image data for texture
 */
function createSARTexture(data, width, height, contrastLimits, useDecibels, colormap, gamma = 1.0, stretchMode = 'linear', dataMask = null, maskInvalid = false, maskLayoverShadow = false, reverseColormap = false) {
  const [min, max] = contrastLimits;
  const colormapFunc = getColormap(colormap);
  const invertRamp = reverseColormap && colormap !== 'label';
  const expectedSize = width * height;
  const rgba = new Uint8ClampedArray(expectedSize * 4);
  const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
  const stretchFn = needsStretch ? createStretchFn(stretchMode, gamma) : null;

  // Only iterate over actual data; remaining pixels stay [0,0,0,0] (transparent)
  const pixelCount = Math.min(data.length, expectedSize);

  for (let i = 0; i < pixelCount; i++) {
    const amplitude = data[i];
    let value;

    if (useDecibels) {
      const db = 10 * Math.log10(Math.max(amplitude, 1e-10));
      value = (db - min) / (max - min);
    } else {
      value = (amplitude - min) / (max - min);
    }

    value = Math.max(0, Math.min(1, value));
    if (stretchFn !== null) value = stretchFn(value);

    const [r, g, b] = colormapFunc(invertRamp ? 1 - value : value);
    const idx = i * 4;
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;

    // Alpha: transparent for nodata or invalid mask
    let alpha = (amplitude === 0 || isNaN(amplitude)) ? 0 : 255;
    if (dataMask && dataMask[i] !== undefined) {
      const maskVal = dataMask[i];
      // Invalid/fill: mask == 0 or mask == 255
      if (maskInvalid && (maskVal < 0.5 || maskVal > 254.5)) alpha = 0;
      // Layover/shadow: mask > 1 (not pure-valid) and not fill
      if (maskLayoverShadow && maskVal > 1.5 && maskVal < 254.5) alpha = 0;
    }
    rgba[idx + 3] = alpha;
  }

  return new ImageData(rgba, width, height);
}

/**
 * Create an RGBA texture for a classification raster by looking up each pixel's
 * integer class index in a packed RGB palette. No dB / stretch / colormap —
 * class 0 and NaN are background (transparent), matching the GPU class shader.
 *
 * @param {Float32Array} data - integer class labels
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} palette - 256*3 packed RGB (index i → palette[i*3..i*3+2])
 * @param {Float32Array} [dataMask]
 * @param {boolean} [maskInvalid]
 * @param {boolean} [maskLayoverShadow]
 * @returns {ImageData}
 */
function createClassTexture(data, width, height, palette, dataMask = null, maskInvalid = false, maskLayoverShadow = false) {
  const expectedSize = width * height;
  const rgba = new Uint8ClampedArray(expectedSize * 4);
  const pixelCount = Math.min(data.length, expectedSize);

  for (let i = 0; i < pixelCount; i++) {
    const amplitude = data[i];
    const idx = i * 4;

    // Background: 0 / NaN → transparent.
    if (amplitude === 0 || isNaN(amplitude)) {
      rgba[idx + 3] = 0;
      continue;
    }

    // Nearest integer class, clamped to the 0–255 palette range.
    const cls = Math.max(0, Math.min(255, Math.round(amplitude)));
    rgba[idx] = palette[cls * 3 + 0];
    rgba[idx + 1] = palette[cls * 3 + 1];
    rgba[idx + 2] = palette[cls * 3 + 2];

    let alpha = 255;
    if (dataMask && dataMask[i] !== undefined) {
      const maskVal = dataMask[i];
      if (maskInvalid && (maskVal < 0.5 || maskVal > 254.5)) alpha = 0;
      if (maskLayoverShadow && maskVal > 1.5 && maskVal < 254.5) alpha = 0;
    }
    rgba[idx + 3] = alpha;
  }

  return new ImageData(rgba, width, height);
}

export default SARBitmapLayer;
