/**
 * WebGL2 FBO-based speckle filter for on-screen rendering.
 *
 * Runs filter as a GPU-only fragment shader pass (render-to-texture).
 * No CPU readback — input and output stay as WebGL2 R32F textures.
 *
 * Input:  R32F texture (raw SAR linear power)
 * Output: R32F texture (filtered SAR linear power)
 *
 * Requires EXT_color_buffer_float for rendering to R32F FBOs.
 *
 * The WebGPU compute path (spatial-filter.js) is retained for the export
 * pipeline where data lives on the CPU anyway.
 */

// Filter type IDs matching GLSL uniform
export const FILTER_TYPE_IDS = {
  'none': 0,
  'boxcar': 1,
  'lee': 2,
  'enhanced-lee': 3,
  'frost': 4,
  'gamma-map': 5,
};

// ── Shader cache ────────────────────────────────────────────────────────────
// WeakMap<WebGL2RenderingContext, Map<halfK, {program, loc}>>
const _programCache = new WeakMap();
// WeakMap<WebGL2RenderingContext, WebGLVertexArrayObject>
const _quadVAOs = new WeakMap();
// WeakMap<WebGL2RenderingContext, boolean>
const _extChecked = new WeakMap();

// ── Fullscreen-quad vertex shader ───────────────────────────────────────────

const FILTER_VS = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// ── Filter fragment shader generator ────────────────────────────────────────
// Parameterized by halfK (compile-time constant for loop bounds).
// Filter type is selected at runtime via uniform.

function generateFilterFS(halfK) {
  return `#version 300 es
precision highp float;

uniform sampler2D uInput;
uniform int uFilterType;  // 1=boxcar, 2=lee, 3=enhanced-lee, 4=frost, 5=gamma-map
uniform float uENL;
uniform float uDamping;

out vec4 outColor;

void main() {
  ivec2 size = textureSize(uInput, 0);
  ivec2 px = ivec2(gl_FragCoord.xy);

  float center = texelFetch(uInput, px, 0).r;

  // Nodata: 0 or NaN → pass through as 0
  if (center == 0.0 || center != center) {
    outColor = vec4(0.0);
    return;
  }

  // ─── Local statistics (shared by all filter types) ──────────────
  float sum = 0.0, sumSq = 0.0, count = 0.0;
  for (int dy = -${halfK}; dy <= ${halfK}; dy++) {
    for (int dx = -${halfK}; dx <= ${halfK}; dx++) {
      ivec2 c = px + ivec2(dx, dy);
      if (c.x >= 0 && c.x < size.x && c.y >= 0 && c.y < size.y) {
        float v = texelFetch(uInput, c, 0).r;
        if (v != 0.0 && v == v) {
          sum += v;
          sumSq += v * v;
          count += 1.0;
        }
      }
    }
  }

  float filtered = center;

  if (count >= 2.0) {
    float localMean = sum / count;
    float localVar = max(sumSq / count - localMean * localMean, 0.0);

    if (uFilterType == 1) {
      // ─── Boxcar (mean) ───
      filtered = count > 0.0 ? sum / count : center;

    } else if (uFilterType == 2) {
      // ─── Lee adaptive ───
      float noiseVar = (localMean * localMean) / max(uENL, 1.0);
      float denom = localVar + noiseVar;
      float K = denom > 0.0 ? localVar / denom : 0.0;
      filtered = localMean + K * (center - localMean);

    } else if (uFilterType == 3) {
      // ─── Enhanced Lee (Cv thresholding) ───
      float Cv = localMean > 0.0 ? sqrt(localVar) / localMean : 0.0;
      float Cu = 1.0 / sqrt(max(uENL, 1.0));
      float Cmax = sqrt(2.0) * Cu;
      if (Cv <= Cu) {
        filtered = localMean;
      } else if (Cv >= Cmax) {
        filtered = center;
      } else {
        float noiseVar = (localMean * localMean) / max(uENL, 1.0);
        float denom = localVar + noiseVar;
        float K = denom > 0.0 ? localVar / denom : 0.0;
        filtered = localMean + K * (center - localMean);
      }

    } else if (uFilterType == 4) {
      // ─── Frost (exponential distance weighting) ───
      float CvSq = localMean > 0.0 ? localVar / (localMean * localMean) : 0.0;
      float alpha = uDamping * CvSq;
      float wSum = 0.0, wTotal = 0.0;
      for (int dy2 = -${halfK}; dy2 <= ${halfK}; dy2++) {
        for (int dx2 = -${halfK}; dx2 <= ${halfK}; dx2++) {
          ivec2 c2 = px + ivec2(dx2, dy2);
          if (c2.x >= 0 && c2.x < size.x && c2.y >= 0 && c2.y < size.y) {
            float v2 = texelFetch(uInput, c2, 0).r;
            if (v2 != 0.0 && v2 == v2) {
              float dist = sqrt(float(dx2 * dx2 + dy2 * dy2));
              float w = exp(-alpha * dist);
              wSum += w * v2;
              wTotal += w;
            }
          }
        }
      }
      filtered = wTotal > 0.0 ? wSum / wTotal : center;

    } else if (uFilterType == 5) {
      // ─── Gamma-MAP ───
      float Cv = localMean > 0.0 ? sqrt(localVar) / localMean : 0.0;
      float ENL = max(uENL, 1.0);
      float Cu = 1.0 / sqrt(ENL);
      float Cmax = sqrt((2.0 + 1.0 / ENL) / ENL);
      if (Cv <= Cu) {
        filtered = localMean;
      } else if (Cv >= Cmax) {
        filtered = center;
      } else {
        float CvSq = Cv * Cv;
        float CuSq = Cu * Cu;
        float a = (1.0 + CuSq) / max(CvSq - CuSq, 1e-10);
        float A = a - ENL - 1.0;
        float disc = localMean * localMean * A * A + 4.0 * a * ENL * center * localMean;
        if (disc < 0.0) {
          // Fallback: Lee filter when discriminant is negative
          float noiseVar = (localMean * localMean) / ENL;
          float denom = localVar + noiseVar;
          float K = denom > 0.0 ? localVar / denom : 0.0;
          filtered = localMean + K * (center - localMean);
        } else {
          filtered = (A * localMean + sqrt(disc)) / (2.0 * a);
        }
      }
    }
  }

  outColor = vec4(max(filtered, 0.0), 0.0, 0.0, 0.0);
}
`;
}

// ── GL helpers ──────────────────────────────────────────────────────────────

function hasColorBufferFloat(gl) {
  if (_extChecked.has(gl)) return _extChecked.get(gl);
  const ext = gl.getExtension('EXT_color_buffer_float');
  const ok = !!ext;
  _extChecked.set(gl, ok);
  return ok;
}

function getQuadVAO(gl) {
  if (_quadVAOs.has(gl)) return _quadVAOs.get(gl);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  _quadVAOs.set(gl, vao);
  return vao;
}

function getProgram(gl, halfK) {
  if (!_programCache.has(gl)) _programCache.set(gl, new Map());
  const cache = _programCache.get(gl);
  if (cache.has(halfK)) return cache.get(halfK);

  // Compile vertex shader
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, FILTER_VS);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(vs);
    gl.deleteShader(vs);
    throw new Error(`[webgl-filter] VS compile: ${log}`);
  }

  // Compile fragment shader
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, generateFilterFS(halfK));
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`[webgl-filter] FS compile: ${log}`);
  }

  // Link program
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPosition');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`[webgl-filter] Link: ${log}`);
  }

  const entry = {
    program,
    loc: {
      uInput: gl.getUniformLocation(program, 'uInput'),
      uFilterType: gl.getUniformLocation(program, 'uFilterType'),
      uENL: gl.getUniformLocation(program, 'uENL'),
      uDamping: gl.getUniformLocation(program, 'uDamping'),
    },
  };

  cache.set(halfK, entry);
  return entry;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a speckle filter to an R32F texture entirely on the GPU.
 *
 * Uses a framebuffer render-to-texture pass — no CPU readback.
 * The returned texture has LINEAR filtering for smooth display sampling.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} inputTexture - R32F texture with raw SAR power
 * @param {number} width
 * @param {number} height
 * @param {Object} opts
 * @param {string} opts.type - Filter type ('boxcar'|'lee'|'enhanced-lee'|'frost'|'gamma-map')
 * @param {number} [opts.kernelSize=7] - Odd integer 3–15
 * @param {number} [opts.enl=4] - Equivalent number of looks
 * @param {number} [opts.damping=1.0] - Frost damping factor
 * @returns {WebGLTexture|null} Filtered R32F texture, or null on failure
 */
export function applyWebGLFilter(gl, inputTexture, width, height, {
  type = 'lee',
  kernelSize = 7,
  enl = 4,
  damping = 1.0,
} = {}) {
  if (!hasColorBufferFloat(gl)) {
    console.warn('[webgl-filter] EXT_color_buffer_float not available, cannot filter on GPU');
    return null;
  }

  const filterTypeId = FILTER_TYPE_IDS[type];
  if (!filterTypeId) return null; // 'none' or unknown

  // Normalize kernel size
  kernelSize = Math.max(3, Math.min(15, kernelSize));
  if (kernelSize % 2 === 0) kernelSize++;
  const halfK = (kernelSize - 1) / 2;

  try {
    const { program, loc } = getProgram(gl, halfK);

    // ── Create output R32F texture ──────────────────────────────────
    const outputTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outputTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
    // LINEAR for smooth display sampling in the render shader
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ── Create FBO ──────────────────────────────────────────────────
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[webgl-filter] FBO incomplete:', status);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(outputTexture);
      return null;
    }

    // ── Save GL state ───────────────────────────────────────────────
    const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);

    // ── Execute filter pass ─────────────────────────────────────────
    gl.useProgram(program);
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    // Bind input texture to unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);

    // Set uniforms
    gl.uniform1i(loc.uInput, 0);
    gl.uniform1i(loc.uFilterType, filterTypeId);
    gl.uniform1f(loc.uENL, enl);
    gl.uniform1f(loc.uDamping, damping);

    // Draw fullscreen quad
    const vao = getQuadVAO(gl);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ── Restore GL state ────────────────────────────────────────────
    gl.bindVertexArray(prevVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.useProgram(prevProgram);
    gl.activeTexture(prevActiveTexture);

    // Clean up FBO (the output texture survives)
    gl.deleteFramebuffer(fbo);

    return outputTexture;
  } catch (err) {
    console.error('[webgl-filter] Filter pass failed:', err);
    return null;
  }
}

/**
 * Check whether WebGL2 FBO filtering is supported.
 * @param {WebGL2RenderingContext} gl
 * @returns {boolean}
 */
export function canUseWebGLFilter(gl) {
  return hasColorBufferFloat(gl);
}
