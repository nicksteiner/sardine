let _cached = null;

export function probeGPU() {
  if (_cached) return _cached;

  let webgl2 = false;
  let floatTextures = false;
  let floatLinearFilter = false;
  let halfFloatTextures = false;
  let maxTextureSize = 0;
  let isMobile = false;
  let webgpu = false;
  let renderer = '';

  // Detect mobile device
  if (typeof navigator !== 'undefined') {
    isMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  }

  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      const ext = gl.getExtension('EXT_color_buffer_float');
      floatTextures = !!ext;

      // OES_texture_float_linear: required for LINEAR filtering on R32F textures.
      // Without this, mobile GPUs silently render black when using gl.LINEAR.
      floatLinearFilter = !!gl.getExtension('OES_texture_float_linear');

      // Half-float support (R16F): available on nearly all mobile GPUs.
      // OES_texture_half_float_linear is part of WebGL2 core, but check anyway.
      halfFloatTextures = !!gl.getExtension('EXT_color_buffer_half_float') || floatTextures;

      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

      // Get renderer string for diagnostics
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        renderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || '';
      }

      const loseExt = gl.getExtension('WEBGL_lose_context');
      if (loseExt) loseExt.loseContext();
    }
  } catch (_) {
    // headless / no DOM — treat as no GPU
  }

  // WebGPU detection (synchronous check — device request is async)
  webgpu = typeof navigator !== 'undefined' && !!navigator.gpu;

  _cached = {
    webgl2,
    floatTextures,
    floatLinearFilter,
    halfFloatTextures,
    maxTextureSize,
    isMobile,
    renderer,
    // GPU rendering works if we have float textures OR can fall back to half-float
    gpuRendering: webgl2 && (floatTextures || halfFloatTextures),
    // On mobile without float linear filter, use NEAREST sampling to avoid black textures
    needsNearestSampling: webgl2 && floatTextures && !floatLinearFilter,
    webgpu,
    computeShaders: webgpu,  // WebGPU implies compute shader support
  };
  return _cached;
}

export function canUseGPURendering() {
  return probeGPU().gpuRendering;
}

export function canUseWebGPUCompute() {
  return probeGPU().computeShaders;
}
