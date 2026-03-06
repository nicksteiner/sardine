import { CompositeLayer } from '@deck.gl/core';
import { BitmapLayer } from '@deck.gl/layers';
import { getColormapId, getStretchModeId, glslColormaps } from './shaders.js';

// WebGL max texture dimension — most GPUs support 16384
const MAX_TEX = 16384;

// Fragment shader GLSL for SAR processing
const FS_DECL = `
  uniform float uMin;
  uniform float uMax;
  uniform float uUseDecibels;
  uniform float uColormap;
  uniform float uGamma;
  uniform float uStretchMode;
  uniform float uDataMin;
  uniform float uDataRange;

  ${glslColormaps}
`;

const FS_FILTER = `
  // Decode 16-bit float from RG channels (RGBA8 normalized to [0,1])
  float norm = (color.r * 255.0 * 256.0 + color.g * 255.0) / 65535.0;
  float amplitude = uDataMin + norm * uDataRange;

  if (color.a < 0.5) {
    color = vec4(0.0);
  } else {
    float value;
    if (uUseDecibels > 0.5) {
      float db = 10.0 * log2(max(amplitude, 1e-10)) * 0.30103;
      value = (db - uMin) / (uMax - uMin);
    } else {
      value = (amplitude - uMin) / (uMax - uMin);
    }

    value = clamp(value, 0.0, 1.0);

    int stretchMode = int(uStretchMode + 0.5);
    if (stretchMode == 1) {
      value = sqrt(value);
    } else if (stretchMode == 2) {
      value = pow(value, uGamma);
    } else if (stretchMode == 3) {
      float gain = uGamma * 8.0;
      float raw = 1.0 / (1.0 + exp(-gain * (value - 0.5)));
      float lo = 1.0 / (1.0 + exp(gain * 0.5));
      float hi = 1.0 / (1.0 + exp(-gain * 0.5));
      value = (raw - lo) / (hi - lo);
    }

    vec3 rgb;
    int colormapId = int(uColormap + 0.5);
    if (colormapId == 0) rgb = grayscale(value);
    else if (colormapId == 1) rgb = viridis(value);
    else if (colormapId == 2) rgb = inferno(value);
    else if (colormapId == 3) rgb = plasma(value);
    else if (colormapId == 4) rgb = phaseColormap(value);
    else if (colormapId == 5) rgb = sardineMap(value);
    else if (colormapId == 6) rgb = floodMap(value);
    else if (colormapId == 7) rgb = divergingMap(value);
    else if (colormapId == 8) rgb = polarimetricMap(value);
    else rgb = grayscale(value);

    color = vec4(rgb, 1.0);
  }
`;

/**
 * Inner BitmapLayer with SAR shader injection.
 * One instance per texture chunk.
 */
class _SARChunkLayer extends BitmapLayer {
  static layerName = '_SARChunkLayer';

  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: {
        'fs:#decl': FS_DECL,
        'fs:DECKGL_FILTER_COLOR': FS_FILTER,
      }
    };
  }

  draw(opts) {
    const {
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear',
      dataMin = 0,
      dataRange = 1,
    } = this.props;

    super.draw({
      ...opts,
      uniforms: {
        ...opts.uniforms,
        uMin: contrastLimits[0],
        uMax: contrastLimits[1],
        uUseDecibels: useDecibels ? 1.0 : 0.0,
        uColormap: getColormapId(colormap),
        uGamma: gamma,
        uStretchMode: getStretchModeId(stretchMode),
        uDataMin: dataMin,
        uDataRange: dataRange,
      }
    });
  }
}

/**
 * SARGPUBitmapLayer - GPU-accelerated SAR rendering for full-image data.
 *
 * Splits the image into chunks that fit within GL_MAX_TEXTURE_SIZE and
 * renders each as a shader-injected BitmapLayer. Full resolution preserved.
 *
 * Contrast/colormap/gamma changes are instant uniform updates — no CPU work.
 */
export class SARGPUBitmapLayer extends CompositeLayer {
  static layerName = 'SARGPUBitmapLayer';

  initializeState() {
    this.setState({ chunks: null, dataMin: 0, dataRange: 1 });
  }

  updateState({ props, oldProps }) {
    if (props.data !== oldProps.data && props.data) {
      const { data, width, height, bounds } = props;
      const [bMinX, bMinY, bMaxX, bMaxY] = bounds;

      // Find data range (sampled)
      let dataMin = Infinity, dataMax = -Infinity;
      const stride = Math.max(1, Math.floor(data.length / 1000000));
      for (let i = 0; i < data.length; i += stride) {
        const val = data[i];
        if (val > 0 && !isNaN(val)) {
          if (val < dataMin) dataMin = val;
          if (val > dataMax) dataMax = val;
        }
      }
      if (dataMin === Infinity) { dataMin = 0; dataMax = 1; }
      const dataRange = dataMax - dataMin || 1;

      // Calculate chunk grid
      const nCols = Math.ceil(width / MAX_TEX);
      const nRows = Math.ceil(height / MAX_TEX);
      console.log(`[SARGPUBitmapLayer] ${width}x${height} → ${nCols}x${nRows} chunks (max ${MAX_TEX})`);

      const chunks = [];
      for (let row = 0; row < nRows; row++) {
        for (let col = 0; col < nCols; col++) {
          const x0 = col * MAX_TEX;
          const y0 = row * MAX_TEX;
          const cw = Math.min(MAX_TEX, width - x0);
          const ch = Math.min(MAX_TEX, height - y0);

          // Extract chunk data
          const chunkData = new Float32Array(cw * ch);
          for (let r = 0; r < ch; r++) {
            const srcOff = (y0 + r) * width + x0;
            chunkData.set(data.subarray(srcOff, srcOff + cw), r * cw);
          }

          // Encode to RGBA8 16-bit
          const rgba = encodeFloat16(chunkData, cw, ch, dataMin, dataRange);
          const image = new ImageData(rgba, cw, ch);

          // Compute geographic bounds for this chunk
          const fracLeft = x0 / width;
          const fracRight = (x0 + cw) / width;
          const fracTop = y0 / height;
          const fracBottom = (y0 + ch) / height;
          const chunkBounds = [
            bMinX + fracLeft * (bMaxX - bMinX),
            bMaxY - fracBottom * (bMaxY - bMinY),  // Y is flipped (top=maxY)
            bMinX + fracRight * (bMaxX - bMinX),
            bMaxY - fracTop * (bMaxY - bMinY),
          ];

          chunks.push({ id: `${col}-${row}`, image, bounds: chunkBounds });
        }
      }

      this.setState({ chunks, dataMin, dataRange });
    }
  }

  renderLayers() {
    const { chunks, dataMin, dataRange } = this.state;
    if (!chunks) return [];

    const { contrastLimits, useDecibels, colormap, gamma, stretchMode, opacity } = this.props;

    return chunks.map(chunk =>
      new _SARChunkLayer({
        id: `${this.props.id}-chunk-${chunk.id}`,
        image: chunk.image,
        bounds: chunk.bounds,
        contrastLimits,
        useDecibels,
        colormap,
        gamma,
        stretchMode,
        opacity,
        dataMin,
        dataRange,
      })
    );
  }
}

/**
 * Encode Float32 data to RGBA8 with 16-bit precision in RG channels.
 */
function encodeFloat16(data, width, height, dataMin, dataRange) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (val <= 0 || isNaN(val)) {
      rgba[i * 4 + 3] = 0;
      continue;
    }
    const norm = Math.min(1, Math.max(0, (val - dataMin) / dataRange));
    const encoded = Math.round(norm * 65535);
    rgba[i * 4]     = (encoded >> 8) & 0xFF;
    rgba[i * 4 + 1] = encoded & 0xFF;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

SARGPUBitmapLayer.defaultProps = {
  data: { type: 'object', value: null, compare: false },
  width: { type: 'number', value: 256, min: 1 },
  height: { type: 'number', value: 256, min: 1 },
  bounds: { type: 'array', value: [0, 0, 1, 1], compare: true },
  contrastLimits: { type: 'array', value: [-25, 0], compare: true },
  useDecibels: { type: 'boolean', value: true, compare: true },
  colormap: { type: 'string', value: 'grayscale', compare: true },
  gamma: { type: 'number', value: 1.0, min: 0.1, max: 10.0, compare: true },
  stretchMode: { type: 'string', value: 'linear', compare: true },
  opacity: { type: 'number', value: 1, min: 0, max: 1 },
};

export default SARGPUBitmapLayer;
