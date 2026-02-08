import { Layer, project32, picking, COORDINATE_SYSTEM } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/engine';
import { Texture2D } from '@luma.gl/core';
import GL from '@luma.gl/constants';
import { getColormapId, getStretchModeId } from './shaders.js';

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
 * Copy of colormap functions from shaders.js
 */
const fs = `#version 300 es
#define SHADER_NAME sar-gpu-layer-fragment

precision highp float;

uniform sampler2D uTexture;
uniform float uMin;
uniform float uMax;
uniform float uUseDecibels;
uniform float uColormap;
uniform float uGamma;
uniform float uStretchMode;

in vec2 vTexCoord;
out vec4 fragColor;

// Viridis colormap
vec3 viridis(float t) {
  const vec3 c0 = vec3(0.2777, 0.0054, 0.3340);
  const vec3 c1 = vec3(0.1050, 0.6389, 0.7916);
  const vec3 c2 = vec3(-0.3308, 0.2149, 0.0948);
  const vec3 c3 = vec3(-4.6342, -5.7991, -19.3324);
  const vec3 c4 = vec3(6.2282, 14.1799, 56.6905);
  const vec3 c5 = vec3(4.7763, -13.7451, -65.3530);
  const vec3 c6 = vec3(-5.4354, 4.6456, 26.3124);

  t = clamp(t, 0.0, 1.0);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

// Inferno colormap
vec3 inferno(float t) {
  const vec3 c0 = vec3(0.0002, 0.0016, 0.0139);
  const vec3 c1 = vec3(0.1065, 0.0639, 0.2671);
  const vec3 c2 = vec3(0.9804, 0.5388, -0.1957);
  const vec3 c3 = vec3(-3.4496, -0.2218, -3.1556);
  const vec3 c4 = vec3(3.8558, -2.0792, 8.7339);
  const vec3 c5 = vec3(-1.4928, 1.8878, -8.0579);
  const vec3 c6 = vec3(-0.0003, 0.0009, 2.4578);

  t = clamp(t, 0.0, 1.0);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

// Plasma colormap
vec3 plasma(float t) {
  const vec3 c0 = vec3(0.0590, 0.0298, 0.5270);
  const vec3 c1 = vec3(0.1836, 0.0965, 0.8355);
  const vec3 c2 = vec3(2.3213, 0.4316, -1.5074);
  const vec3 c3 = vec3(-11.2436, -0.0486, 4.0720);
  const vec3 c4 = vec3(17.5896, -1.1766, -7.6916);
  const vec3 c5 = vec3(-11.6096, 1.9411, 6.2390);
  const vec3 c6 = vec3(2.8642, -0.6177, -1.6442);

  t = clamp(t, 0.0, 1.0);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

// Phase colormap (hue-based)
vec3 phaseColormap(float t) {
  t = clamp(t, 0.0, 1.0);
  float angle = t * 6.28318530718;
  return vec3(
    0.5 + 0.5 * cos(angle),
    0.5 + 0.5 * cos(angle + 2.09439510239),
    0.5 + 0.5 * cos(angle + 4.18879020479)
  );
}

// Grayscale colormap
vec3 grayscale(float t) {
  t = clamp(t, 0.0, 1.0);
  return vec3(t, t, t);
}

void main() {
  // Read raw float amplitude from R channel
  vec4 texel = texture(uTexture, vTexCoord);
  float amplitude = texel.r;

  // Apply dB scaling and contrast
  float value;
  if (uUseDecibels > 0.5) {
    float db = 10.0 * log(max(amplitude, 1e-10)) / log(10.0);
    value = (db - uMin) / (uMax - uMin);
  } else {
    value = (amplitude - uMin) / (uMax - uMin);
  }

  value = clamp(value, 0.0, 1.0);

  // Apply stretch mode
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

  // Apply colormap
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
  } else {
    rgb = grayscale(value);
  }

  // Handle no-data
  float alpha = (amplitude == 0.0 || isnan(amplitude)) ? 0.0 : 1.0;

  fragColor = vec4(rgb, alpha);
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
  }

  updateState({ props, oldProps }) {
    const { gl } = this.context;
    const { data, width, height, bounds } = props;

    // Create model when bounds change (geometry needs world coordinates)
    if (this.state.needsGeometryUpdate || bounds !== oldProps.bounds) {
      if (!bounds || bounds.length !== 4) {
        console.error('[SARGPULayer] Cannot create geometry without valid bounds');
        return;
      }

      const [minX, minY, maxX, maxY] = bounds;

      console.log(`[SARGPULayer] Creating geometry with bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]`);
      console.log(`[SARGPULayer] Coordinate system:`, props.coordinateSystem);
      console.log(`[SARGPULayer] Current viewport:`, this.context.viewport);

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

      const model = new Model(gl, {
        ...this.getShaders(),
        geometry,
        parameters: {
          blend: true,
          blendFunc: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
          depthTest: false  // Don't use depth test for 2D imagery
        }
      });

      this.setState({ model, needsGeometryUpdate: false });
      console.log('[SARGPULayer] ✅ Model created with world coordinates');
      console.log('[SARGPULayer] Position range: X=[', minX, ',', maxX, '], Y=[', minY, ',', maxY, ']');
    }

    // Upload R32F texture when data changes
    if (data && (data !== oldProps.data || width !== oldProps.width || height !== oldProps.height)) {
      console.log(`[SARGPULayer] Uploading R32F texture: ${width}×${height}`);

      const texture = this._createR32FTexture(data, width, height);

      if (texture) {
        if (this.state.texture) {
          // Delete old raw WebGL texture
          gl.deleteTexture(this.state.texture);
        }
        this.setState({ texture });
        console.log('[SARGPULayer] ✅ R32F texture uploaded');
      }
    }
  }

  _createR32FTexture(data, width, height) {
    const { gl } = this.context;

    try {
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
        data            // Float32Array
      );

      // Set texture parameters
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.bindTexture(gl.TEXTURE_2D, null);

      // Return raw WebGL texture (compatible with luma.gl's model.setUniforms)
      return texture;
    } catch (err) {
      console.error('[SARGPULayer] Texture creation failed:', err);
      return null;
    }
  }

  draw({ uniforms }) {
    const { model, texture } = this.state;

    if (!model || !texture) {
      console.warn('[SARGPULayer] Skipping draw - missing model or texture');
      return;
    }

    const {
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear'
    } = this.props;

    // Debug: Log draw call on first frame
    if (!this.state.hasDrawn) {
      console.log('[SARGPULayer] 🎨 First draw call');
      console.log('[SARGPULayer] Viewport:', this.context.viewport);
      console.log('[SARGPULayer] Uniforms received:', Object.keys(uniforms));
      console.log('[SARGPULayer] Contrast limits:', contrastLimits);
      this.setState({ hasDrawn: true });
    }

    try {
      const { gl } = this.context;

      // Manually bind raw WebGL texture to texture unit 0
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Set uniforms and draw
      model.setUniforms({
        ...uniforms,  // Includes deck.gl's projection uniforms from modules
        uTexture: 0,  // Texture unit 0 (not the texture object itself)
        uMin: contrastLimits[0],
        uMax: contrastLimits[1],
        uUseDecibels: useDecibels ? 1.0 : 0.0,
        uColormap: getColormapId(colormap),
        uGamma: gamma,
        uStretchMode: getStretchModeId(stretchMode)
      });

      model.draw();

      // Unbind texture
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (err) {
      console.error('[SARGPULayer] Draw error:', err);
    }
  }

  finalizeState() {
    super.finalizeState();
    if (this.state.model) this.state.model.delete();
    if (this.state.texture) {
      // Handle raw WebGL texture cleanup
      const { gl } = this.context;
      if (gl) gl.deleteTexture(this.state.texture);
    }
  }
}

SARGPULayer.layerName = 'SARGPULayer';
SARGPULayer.defaultProps = {
  data: { type: 'object', value: null, compare: false },
  width: { type: 'number', value: 256, min: 1 },
  height: { type: 'number', value: 256, min: 1 },
  bounds: { type: 'array', value: [-180, -90, 180, 90], compare: true },
  contrastLimits: { type: 'array', value: [-25, 0], compare: true },
  useDecibels: { type: 'boolean', value: true, compare: true },
  colormap: { type: 'string', value: 'grayscale', compare: true },
  gamma: { type: 'number', value: 1.0, min: 0.1, max: 10.0, compare: true },
  stretchMode: { type: 'string', value: 'linear', compare: true }
  // Note: coordinateSystem is NOT defined here - it will inherit from parent layer
  // This allows the layer to work with both CARTESIAN (pixel coords) and LNGLAT (geographic) systems
};
