import { Layer, project32, picking } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/core';
import GL from '@luma.gl/constants';
import { getColormapId, getStretchModeId, getSpeckleFilterId, glslColormaps } from './shaders.js';


/**
 * Simple vertex shader using deck.gl's project module
 */
const vs = `#version 300 es
#define SHADER_NAME sar-gpu-layer-vertex

in vec3 positions;
in vec2 texCoords;

out vec2 vTexCoord;

void main() {
  // Convert LNGLAT world coordinates to clip space using deck.gl's projection
  // positions is [longitude, latitude, 0] in world coordinates
  vec3 position64Low = vec3(0.0);  // No 64-bit precision needed for now
  vec3 offset = vec3(0.0);          // No offset
  vec4 commonPosition;              // Output from projection

  gl_Position = project_position_to_clipspace(positions, position64Low, offset, commonPosition);
  vTexCoord = texCoords;
}
`;

/**
 * Fragment shader - SAR processing (dB, colormap, stretch)
 * Supports both single-band (colormap) and RGB (3-band composite) modes.
 */
const fs = `#version 300 es
#define SHADER_NAME sar-gpu-layer-fragment

precision highp float;

// Single-band texture (always bound)
uniform sampler2D uTexture;
// RGB-mode textures (only used when uMode > 0.5)
uniform sampler2D uTextureG;
uniform sampler2D uTextureB;
// Mask texture (NISAR §4.3.3: 0=invalid, 1-5=valid, 255=fill)
uniform sampler2D uTextureMask;

uniform float uMin;
uniform float uMax;
uniform float uUseDecibels;
uniform float uColormap;
uniform float uGamma;
uniform float uStretchMode;
uniform float uMode;  // 0 = single-band + colormap, 1 = RGB composite
uniform float uUseMask;  // > 0.5 = apply mask
// Per-channel min/max for RGB mode (falls back to uMin/uMax if equal)
uniform float uMinR;
uniform float uMaxR;
uniform float uMinG;
uniform float uMaxG;
uniform float uMinB;
uniform float uMaxB;

// Speckle filter uniforms
uniform float uFilterType;   // 0=none, 1=boxcar, 2=lee, 3=median
uniform float uFilterSize;   // kernel size: 3, 5, or 7
uniform float uFilterENL;    // ENL for Lee filter (noise variance = mean²/ENL)
uniform vec2  uTextureSize;  // (width, height) in texels

in vec2 vTexCoord;
out vec4 fragColor;

// ─── Speckle filters ─────────────────────────────────────────────────

// Read texel, returning -1.0 sentinel for nodata (0 or NaN)
float fetchAmp(sampler2D tex, vec2 uv) {
  float v = texture(tex, uv).r;
  return (v == 0.0 || isnan(v)) ? -1.0 : v;
}

// Boxcar (mean) filter — NxN average, skipping nodata
float boxcarFilter(sampler2D tex, vec2 uv, int halfK, vec2 ts) {
  float sum = 0.0, count = 0.0;
  for (int dy = -halfK; dy <= halfK; dy++) {
    for (int dx = -halfK; dx <= halfK; dx++) {
      float v = fetchAmp(tex, uv + vec2(float(dx), float(dy)) * ts);
      if (v >= 0.0) { sum += v; count += 1.0; }
    }
  }
  return count > 0.0 ? sum / count : 0.0;
}

// Lee adaptive filter — preserves edges in heterogeneous areas
float leeFilter(sampler2D tex, vec2 uv, int halfK, vec2 ts, float enl) {
  float center = fetchAmp(tex, uv);
  if (center < 0.0) return 0.0;

  float sum = 0.0, sum2 = 0.0, count = 0.0;
  for (int dy = -halfK; dy <= halfK; dy++) {
    for (int dx = -halfK; dx <= halfK; dx++) {
      float v = fetchAmp(tex, uv + vec2(float(dx), float(dy)) * ts);
      if (v >= 0.0) { sum += v; sum2 += v * v; count += 1.0; }
    }
  }
  if (count < 2.0) return center;

  float mean = sum / count;
  float variance = (sum2 / count) - mean * mean;
  float noiseVar = (mean * mean) / max(enl, 1.0);
  float weight = max(0.0, 1.0 - noiseVar / max(variance, 1e-10));
  return mean + weight * (center - mean);
}

// 3x3 median via sorting network (9 elements, 25 compare-and-swaps)
float medianFilter3x3(sampler2D tex, vec2 uv, vec2 ts) {
  float v[9];
  int idx = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float a = fetchAmp(tex, uv + vec2(float(dx), float(dy)) * ts);
      v[idx++] = a >= 0.0 ? a : 1e30;
    }
  }
  #define SW(a,b) { float t = min(v[a],v[b]); v[b] = max(v[a],v[b]); v[a] = t; }
  SW(0,1); SW(3,4); SW(6,7); SW(1,2); SW(4,5); SW(7,8);
  SW(0,1); SW(3,4); SW(6,7); SW(0,3); SW(3,6); SW(0,3);
  SW(1,4); SW(4,7); SW(1,4); SW(2,5); SW(5,8); SW(2,5);
  SW(1,3); SW(5,7); SW(2,6); SW(4,6); SW(2,4); SW(2,3);
  SW(5,6);
  #undef SW
  return v[4] < 1e29 ? v[4] : 0.0;
}

// 5x5 median via sorting network (25 elements)
float medianFilter5x5(sampler2D tex, vec2 uv, vec2 ts) {
  float v[25];
  int idx = 0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      float a = fetchAmp(tex, uv + vec2(float(dx), float(dy)) * ts);
      v[idx++] = a >= 0.0 ? a : 1e30;
    }
  }
  // Partial sort: only need to find the 13th element (median of 25)
  // Use truncated bubble passes to push smallest 13 values to front
  #define SW(a,b) { float t = min(v[a],v[b]); v[b] = max(v[a],v[b]); v[a] = t; }
  // Sort pairs across the array
  for (int pass = 0; pass < 13; pass++) {
    for (int i = 1; i < 25; i++) {
      SW(i-1, i);
    }
  }
  #undef SW
  return v[12] < 1e29 ? v[12] : 0.0;
}

// Dispatcher: apply selected speckle filter to a texture
float applySpeckleFilter(sampler2D tex, vec2 uv) {
  int filterType = int(uFilterType + 0.5);
  if (filterType == 0) return texture(tex, uv).r;

  vec2 ts = 1.0 / uTextureSize;
  int halfK = int(uFilterSize + 0.5) / 2;

  if (filterType == 1) {
    return boxcarFilter(tex, uv, halfK, ts);
  } else if (filterType == 2) {
    return leeFilter(tex, uv, halfK, ts, uFilterENL);
  } else if (filterType == 3) {
    int kSize = int(uFilterSize + 0.5);
    if (kSize <= 3) return medianFilter3x3(tex, uv, ts);
    else return medianFilter5x5(tex, uv, ts);
  }
  return texture(tex, uv).r;
}

// ─── Shared: dB scaling + contrast + stretch ─────────────────────────

float processChannel(float amplitude, float cMin, float cMax) {
  float value;
  if (uUseDecibels > 0.5) {
    float db = 10.0 * log2(max(amplitude, 1e-10)) * 0.30103;
    value = (db - cMin) / (cMax - cMin);
  } else {
    value = (amplitude - cMin) / (cMax - cMin);
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

  return value;
}

// ─── Colormaps (imported from shaders.js - single source of truth) ──
${glslColormaps}

// ─── Main ────────────────────────────────────────────────────────────

void main() {
  if (uMode > 0.5) {
    // ── RGB composite mode: 3 separate R32F textures ──
    float ampR = applySpeckleFilter(uTexture, vTexCoord);
    float ampG = applySpeckleFilter(uTextureG, vTexCoord);
    float ampB = applySpeckleFilter(uTextureB, vTexCoord);

    vec3 rgb = vec3(
      processChannel(ampR, uMinR, uMaxR),
      processChannel(ampG, uMinG, uMaxG),
      processChannel(ampB, uMinB, uMaxB)
    );

    // Any channel valid → visible
    bool anyValid = (ampR != 0.0 && !isnan(ampR)) ||
                    (ampG != 0.0 && !isnan(ampG)) ||
                    (ampB != 0.0 && !isnan(ampB));
    float alpha = anyValid ? 1.0 : 0.0;

    // Apply mask: 0=invalid, 255=fill → transparent; 1-5=valid
    if (uUseMask > 0.5) {
      float maskVal = texture(uTextureMask, vTexCoord).r;
      if (maskVal < 0.5 || maskVal > 254.5) alpha = 0.0;
    }

    fragColor = vec4(rgb, alpha);
  } else {
    // ── Single-band mode: R32F texture + colormap ──
    float amplitude = applySpeckleFilter(uTexture, vTexCoord);
    float value = processChannel(amplitude, uMin, uMax);

    vec3 rgb;
    int colormapId = int(uColormap + 0.5);
    if (colormapId == 0) {
      rgb = grayscale(value);
    } else if (colormapId == 1) {
      rgb = viridis(value);
    } else if (colormapId == 2) {
      rgb = inferno(value);
    } else if (colormapId == 3) {
      rgb = plasma(value);
    } else if (colormapId == 4) {
      rgb = phaseColormap(value);
    } else if (colormapId == 5) {
      rgb = sardineMap(value);
    } else if (colormapId == 6) {
      rgb = floodMap(value);
    } else if (colormapId == 7) {
      rgb = divergingMap(value);
    } else if (colormapId == 8) {
      rgb = polarimetricMap(value);
    } else {
      rgb = grayscale(value);
    }

    float alpha = (amplitude == 0.0 || isnan(amplitude)) ? 0.0 : 1.0;

    // Apply mask: 0=invalid, 255=fill → transparent; 1-5=valid
    if (uUseMask > 0.5) {
      float maskVal = texture(uTextureMask, vTexCoord).r;
      if (maskVal < 0.5 || maskVal > 254.5) alpha = 0.0;
    }

    fragColor = vec4(rgb, alpha);
  }
}
`;

/**
 * SARGPULayer - Custom GPU-accelerated SAR rendering layer
 *
 * Pure GPU pipeline: R32F texture upload → shader processing → display
 * No CPU preprocessing - all dB/colormap/stretch done in fragment shader
 */
export class SARGPULayer extends Layer {
  getShaders() {
    return {
      vs,
      fs,
      modules: [project32, picking]  // Use deck.gl's projection and picking modules
    };
  }

  initializeState() {
    // Initialize state - create geometry in updateState when we have bounds
    this.setState({ needsGeometryUpdate: true });

    // Setup WebGL context loss/restore handlers
    const { gl } = this.context;
    if (gl && gl.canvas) {
      // Store bound handlers so we can remove them in finalizeState
      this.handleContextLost = (event) => {
        event.preventDefault(); // Prevent default context loss behavior
        console.warn('[SARGPULayer] WebGL context lost');
        this.setState({ contextLost: true });
      };

      this.handleContextRestored = () => {
        console.log('[SARGPULayer] WebGL context restored, recreating resources');
        this.setState({
          contextLost: false,
          needsGeometryUpdate: true,
          model: null,
          texture: null,
          textureG: null,
          textureB: null,
          textureMask: null
        });
        // Trigger re-render by setting needsUpdate
        this.setNeedsUpdate();
      };

      gl.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
      gl.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    }
  }

  // Override: we draw a static quad, not instanced rendering.
  // Return 0 so deck.gl skips attribute buffer management entirely.
  // Our draw() renders the geometry directly via model.draw().
  getNumInstances() {
    return 0;
  }

  updateState({ props, oldProps }) {
    const { gl } = this.context;
    const { data, width, height, bounds } = props;

    // Skip updates if WebGL context is lost
    if (this.state.contextLost) {
      console.warn('[SARGPULayer] Skipping update while WebGL context is lost');
      return;
    }

    // Create model when bounds change (geometry needs world coordinates)
    if (this.state.needsGeometryUpdate || bounds !== oldProps.bounds) {
      if (!bounds || bounds.length !== 4) {
        console.error('[SARGPULayer] Cannot create geometry without valid bounds');
        return;
      }

      const [minX, minY, maxX, maxY] = bounds;

      // Create quad with world coordinates from bounds
      const positions = new Float32Array([
        // Triangle 1
        minX, minY, 0,
        maxX, minY, 0,
        maxX, maxY, 0,
        // Triangle 2
        minX, minY, 0,
        maxX, maxY, 0,
        minX, maxY, 0
      ]);

      const texCoords = new Float32Array([
        // Triangle 1
        0, 1,  1, 1,  1, 0,
        // Triangle 2
        0, 1,  1, 0,  0, 0
      ]);

      const geometry = new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: { size: 3, value: positions },
          texCoords: { size: 2, value: texCoords }
        }
      });

      // Clean up old model
      if (this.state.model) {
        this.state.model.delete();
      }

      let model;
      try {
        model = new Model(gl, {
          ...this.getShaders(),
          geometry,
          parameters: {
            blend: true,
            blendFunc: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
            depthTest: false  // Don't use depth test for 2D imagery
          }
        });
      } catch (err) {
        console.error('[SARGPULayer] Shader compilation failed:', err.message);
        const infoLog = err.infoLog || err.shaderLog || '';
        if (infoLog) console.error('[SARGPULayer] Shader log:', infoLog);
        return;
      }

      this.setState({ model, needsGeometryUpdate: false });
    }

    // Upload R32F texture(s) when data changes or filter mode changes
    // Speckle filter requires NEAREST filtering (no GPU interpolation of raw values)
    const { dataR, dataG, dataB, mode = 'single', speckleFilter: sf = 'none' } = props;
    const isRGB = mode === 'rgb';
    const useNearest = sf !== 'none';
    const filterChanged = sf !== (oldProps.speckleFilter || 'none');

    if (isRGB) {
      // RGB mode: upload 3 separate R32F textures
      const rChanged = dataR !== oldProps.dataR;
      const gChanged = dataG !== oldProps.dataG;
      const bChanged = dataB !== oldProps.dataB;
      const sizeChanged = width !== oldProps.width || height !== oldProps.height;

      if (dataR && dataG && dataB && (rChanged || gChanged || bChanged || sizeChanged || filterChanged)) {
        const texR = this._createR32FTexture(dataR, width, height, useNearest);
        const texG = this._createR32FTexture(dataG, width, height, useNearest);
        const texB = this._createR32FTexture(dataB, width, height, useNearest);

        if (texR && texG && texB) {
          // Clean up old textures
          if (this.state.texture) gl.deleteTexture(this.state.texture);
          if (this.state.textureG) gl.deleteTexture(this.state.textureG);
          if (this.state.textureB) gl.deleteTexture(this.state.textureB);

          this.setState({ texture: texR, textureG: texG, textureB: texB });
        } else {
          console.error('[SARGPULayer] Failed to create one or more RGB textures');
        }
      }
    } else if (data && (data !== oldProps.data || width !== oldProps.width || height !== oldProps.height || filterChanged)) {
      const texture = this._createR32FTexture(data, width, height, useNearest);

      if (texture) {
        if (this.state.texture) gl.deleteTexture(this.state.texture);
        this.setState({ texture });
      }
    }

    // Upload mask texture when dataMask changes
    const { dataMask } = props;
    if (dataMask && (dataMask !== oldProps.dataMask || width !== oldProps.width || height !== oldProps.height)) {
      const texMask = this._createR32FTexture(dataMask, width, height, true);
      if (texMask) {
        if (this.state.textureMask) gl.deleteTexture(this.state.textureMask);
        this.setState({ textureMask: texMask });
      }
    }
  }

  _createR32FTexture(data, width, height, nearest = false) {
    const { gl } = this.context;

    try {
      const expected = width * height;
      let texData = data;

      // Pad undersized data (edge tiles may have fewer pixels than width×height)
      if (data.length < expected) {
        texData = new Float32Array(expected);
        texData.set(data);
      }

      // Create R32F texture using raw WebGL2 API
      // luma.gl Texture2D wrapper doesn't support R32F well in v8.5
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Upload float data as R32F
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,              // mipmap level
        gl.R32F,        // internal format
        width,
        height,
        0,              // border (must be 0)
        gl.RED,         // format
        gl.FLOAT,       // type
        texData         // Float32Array
      );

      // Set texture filtering parameters
      const filter = nearest ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      // Check for GL errors (VRAM exhaustion won't throw, it sets an error flag)
      const glErr = gl.getError();
      if (glErr !== gl.NO_ERROR) {
        console.error(`[SARGPULayer] GL error 0x${glErr.toString(16)} after texImage2D (${width}x${height})`);
        gl.deleteTexture(texture);
        return null;
      }

      // Return raw WebGL texture (compatible with luma.gl's model.setUniforms)
      return texture;
    } catch (err) {
      console.error('[SARGPULayer] Texture creation failed:', err);
      return null;
    }
  }

  draw({ uniforms }) {
    const { model, texture, textureG, textureB, textureMask } = this.state;

    if (!model || !texture) return;

    const {
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear',
      mode = 'single',
      useMask = false,
      speckleFilter = 'none',
      speckleFilterSize = 3,
      speckleFilterENL = 4.0,
      width = 256,
      height = 256,
    } = this.props;

    const isRGB = mode === 'rgb';

    try {
      const { gl } = this.context;

      // Bind R texture to unit 0 (always)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Resolve per-channel contrast limits
      // contrastLimits can be [min, max] (uniform) or {R: [min,max], G: [min,max], B: [min,max]}
      let uMin, uMax, uMinR, uMaxR, uMinG, uMaxG, uMinB, uMaxB;

      if (isRGB && contrastLimits && !Array.isArray(contrastLimits)) {
        // Per-channel object: {R: [min,max], G: [min,max], B: [min,max]}
        const rLim = contrastLimits.R || [-25, 0];
        const gLim = contrastLimits.G || [-25, 0];
        const bLim = contrastLimits.B || [-25, 0];
        uMinR = rLim[0]; uMaxR = rLim[1];
        uMinG = gLim[0]; uMaxG = gLim[1];
        uMinB = bLim[0]; uMaxB = bLim[1];
        // Set single-band min/max to R channel as fallback
        uMin = uMinR; uMax = uMaxR;
      } else {
        // Uniform array: [min, max]
        const lim = Array.isArray(contrastLimits) ? contrastLimits : [-25, 0];
        uMin = lim[0]; uMax = lim[1];
        uMinR = uMin; uMaxR = uMax;
        uMinG = uMin; uMaxG = uMax;
        uMinB = uMin; uMaxB = uMax;
      }

      const layerUniforms = {
        ...uniforms,
        uTexture: 0,
        uMin, uMax,
        uMinR, uMaxR,
        uMinG, uMaxG,
        uMinB, uMaxB,
        uUseDecibels: useDecibels ? 1.0 : 0.0,
        uColormap: getColormapId(colormap),
        uGamma: gamma,
        uStretchMode: getStretchModeId(stretchMode),
        uMode: isRGB ? 1.0 : 0.0,
        uUseMask: (useMask && textureMask) ? 1.0 : 0.0,
        uTextureMask: 3,
        uFilterType: getSpeckleFilterId(speckleFilter),
        uFilterSize: speckleFilterSize,
        uFilterENL: speckleFilterENL,
        uTextureSize: [width, height],
      };

      if (isRGB && textureG && textureB) {
        // Bind G and B textures to units 1 and 2
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, textureG);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, textureB);

        layerUniforms.uTextureG = 1;
        layerUniforms.uTextureB = 2;
      }

      // Bind mask texture to unit 3
      if (textureMask) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, textureMask);
      }

      model.setUniforms(layerUniforms);
      model.draw();

      // Unbind textures
      if (textureMask) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (isRGB) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (err) {
      console.error('[SARGPULayer] Draw error:', err);
    }
  }

  finalizeState() {
    super.finalizeState();

    // Remove WebGL context loss/restore event listeners
    const { gl } = this.context;
    if (gl && gl.canvas) {
      if (this.handleContextLost) {
        gl.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
      }
      if (this.handleContextRestored) {
        gl.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
      }
    }

    // Clean up resources
    if (this.state.model) this.state.model.delete();
    if (gl) {
      if (this.state.texture) gl.deleteTexture(this.state.texture);
      if (this.state.textureG) gl.deleteTexture(this.state.textureG);
      if (this.state.textureB) gl.deleteTexture(this.state.textureB);
      if (this.state.textureMask) gl.deleteTexture(this.state.textureMask);
    }
  }
}

SARGPULayer.layerName = 'SARGPULayer';
SARGPULayer.defaultProps = {
  // Single-band mode (use {length:0} not null — deck.gl's count() requires an object)
  data: { type: 'object', value: {length: 0}, compare: false },
  // RGB mode (3 separate Float32Arrays)
  dataR: { type: 'object', value: null, compare: false },
  dataG: { type: 'object', value: null, compare: false },
  dataB: { type: 'object', value: null, compare: false },
  // Mask data (Float32Array, uint8 values: 0=invalid, 1-5=valid, 255=fill)
  dataMask: { type: 'object', value: null, compare: false },
  useMask: { type: 'boolean', value: false, compare: true },
  mode: { type: 'string', value: 'single', compare: true },  // 'single' or 'rgb'
  width: { type: 'number', value: 256, min: 1 },
  height: { type: 'number', value: 256, min: 1 },
  bounds: { type: 'array', value: [-180, -90, 180, 90], compare: true },
  // type: 'object' to accept both [min,max] and {R:[],G:[],B:[]} formats
  contrastLimits: { type: 'object', value: [-25, 0], compare: true },
  useDecibels: { type: 'boolean', value: true, compare: true },
  colormap: { type: 'string', value: 'grayscale', compare: true },
  gamma: { type: 'number', value: 1.0, min: 0.1, max: 10.0, compare: true },
  stretchMode: { type: 'string', value: 'linear', compare: true },
  // Speckle filter props
  speckleFilter: { type: 'string', value: 'none', compare: true },       // 'none'|'boxcar'|'lee'|'median'
  speckleFilterSize: { type: 'number', value: 3, compare: true },         // 3, 5, or 7
  speckleFilterENL: { type: 'number', value: 4.0, compare: true },        // Lee ENL parameter
  // Note: coordinateSystem is NOT defined here - it will inherit from parent layer
};
