let _cached = null;

export function probeGPU() {
  if (_cached) return _cached;

  let webgl2 = false;
  let floatTextures = false;

  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      const ext = gl.getExtension('EXT_color_buffer_float');
      floatTextures = !!ext;
      const loseExt = gl.getExtension('WEBGL_lose_context');
      if (loseExt) loseExt.loseContext();
    }
  } catch (_) {
    // headless / no DOM — treat as no GPU
  }

  _cached = {
    webgl2,
    floatTextures,
    gpuRendering: webgl2 && floatTextures,
  };
  return _cached;
}

export function canUseGPURendering() {
  return probeGPU().gpuRendering;
}
