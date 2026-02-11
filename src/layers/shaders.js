/**
 * GLSL shader code for SAR image visualization
 * Supports dB scaling and multiple colormaps
 */

/**
 * Vertex shader for SAR tile layer
 */
export const sarVertexShader = `\
#version 300 es
#define SHADER_NAME sar-tile-layer-vertex-shader

in vec2 texCoords;
in vec3 positions;
in vec3 positions64Low;
in vec3 instancePickingColors;

out vec2 vTexCoord;

void main(void) {
  geometry.worldPosition = positions;
  geometry.uv = texCoords;
  geometry.pickingColor = instancePickingColors;
  
  gl_Position = project_position_to_clipspace(positions, positions64Low, vec3(0.0), geometry.position);
  
  vTexCoord = texCoords;
}
`;

/**
 * Fragment shader for SAR tile layer
 * Supports linear and dB scaling with multiple colormaps
 */
export const sarFragmentShader = `\
#version 300 es
#define SHADER_NAME sar-tile-layer-fragment-shader

precision highp float;

uniform sampler2D uTexture;
uniform float uMin;
uniform float uMax;
uniform bool uUseDecibels;
uniform int uColormap;
uniform int uStretchMode;  // 0=linear, 1=sqrt, 2=gamma, 3=sigmoid
uniform float uGamma;

in vec2 vTexCoord;
out vec4 fragColor;

// Viridis colormap lookup
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

// Inferno colormap lookup
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

// Plasma colormap lookup (matplotlib canonical coefficients)
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

// Phase colormap (cyclic, for interferometry)
vec3 phaseColormap(float t) {
  t = clamp(t, 0.0, 1.0);
  float angle = t * 6.28318530718; // 2 * PI
  return vec3(
    0.5 + 0.5 * cos(angle),
    0.5 + 0.5 * cos(angle + 2.09439510239), // + 2*PI/3
    0.5 + 0.5 * cos(angle + 4.18879020479)  // + 4*PI/3
  );
}

// Grayscale colormap
vec3 grayscale(float t) {
  t = clamp(t, 0.0, 1.0);
  return vec3(t, t, t);
}

// SARdine brand colormap — navy → teal → cyan → near-white
vec3 sardineMap(float t) {
  t = clamp(t, 0.0, 1.0);
  // Stops: #0a1628 (0.039,0.086,0.157)  #2a8a93 (0.165,0.541,0.576)
  //        #4ec9d4 (0.306,0.788,0.824)  #e8edf5 (0.910,0.929,0.961)
  vec3 c;
  if (t < 0.33) {
    float s = t / 0.33;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.165, 0.541, 0.576), s);
  } else if (t < 0.67) {
    float s = (t - 0.33) / 0.34;
    c = mix(vec3(0.165, 0.541, 0.576), vec3(0.306, 0.788, 0.824), s);
  } else {
    float s = (t - 0.67) / 0.33;
    c = mix(vec3(0.306, 0.788, 0.824), vec3(0.910, 0.929, 0.961), s);
  }
  return c;
}

// Flood alert colormap — navy → deep orange → bright orange → red
vec3 floodMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.33) {
    float s = t / 0.33;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.710, 0.392, 0.165), s);
  } else if (t < 0.67) {
    float s = (t - 0.33) / 0.34;
    c = mix(vec3(0.710, 0.392, 0.165), vec3(0.910, 0.514, 0.227), s);
  } else {
    float s = (t - 0.67) / 0.33;
    c = mix(vec3(0.910, 0.514, 0.227), vec3(1.0, 0.361, 0.361), s);
  }
  return c;
}

// Diverging colormap — cyan → navy → orange (zero-centered)
vec3 divergingMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.5) {
    float s = t / 0.5;
    c = mix(vec3(0.306, 0.788, 0.824), vec3(0.039, 0.086, 0.157), s);
  } else {
    float s = (t - 0.5) / 0.5;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.910, 0.514, 0.227), s);
  }
  return c;
}

// Polarimetric colormap — magenta → navy → green
vec3 polarimetricMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.5) {
    float s = t / 0.5;
    c = mix(vec3(0.831, 0.361, 1.0), vec3(0.039, 0.086, 0.157), s);
  } else {
    float s = (t - 0.5) / 0.5;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.239, 0.863, 0.518), s);
  }
  return c;
}

void main(void) {
  vec4 texel = texture(uTexture, vTexCoord);
  float amplitude = texel.r;
  
  float value;
  if (uUseDecibels) {
    // Convert to decibels: dB = 10 * log10(amplitude)
    float db = 10.0 * log(max(amplitude, 1e-10)) / log(10.0);
    value = (db - uMin) / (uMax - uMin);
  } else {
    // Linear scaling
    value = (amplitude - uMin) / (uMax - uMin);
  }
  
  value = clamp(value, 0.0, 1.0);

  // Apply stretch mode
  if (uStretchMode == 1) {
    // sqrt stretch
    value = sqrt(value);
  } else if (uStretchMode == 2) {
    // gamma stretch
    value = pow(value, uGamma);
  } else if (uStretchMode == 3) {
    // sigmoid stretch
    float gain = uGamma * 8.0;
    float raw = 1.0 / (1.0 + exp(-gain * (value - 0.5)));
    float lo = 1.0 / (1.0 + exp(gain * 0.5));
    float hi = 1.0 / (1.0 + exp(-gain * 0.5));
    value = (raw - lo) / (hi - lo);
  }
  // else: linear (no modification)

  vec3 color;
  if (uColormap == 0) {
    color = grayscale(value);
  } else if (uColormap == 1) {
    color = viridis(value);
  } else if (uColormap == 2) {
    color = inferno(value);
  } else if (uColormap == 3) {
    color = plasma(value);
  } else if (uColormap == 4) {
    color = phaseColormap(value);
  } else if (uColormap == 5) {
    color = sardineMap(value);
  } else if (uColormap == 6) {
    color = floodMap(value);
  } else if (uColormap == 7) {
    color = divergingMap(value);
  } else if (uColormap == 8) {
    color = polarimetricMap(value);
  } else {
    color = grayscale(value);
  }
  
  // Handle no-data (typically 0 or NaN)
  float alpha = (amplitude == 0.0 || isnan(amplitude)) ? 0.0 : 1.0;
  
  fragColor = vec4(color, alpha);
  
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/**
 * Colormap name to integer mapping for shader
 */
export const COLORMAP_IDS = {
  grayscale: 0,
  viridis: 1,
  inferno: 2,
  plasma: 3,
  phase: 4,
  sardine: 5,
  flood: 6,
  diverging: 7,
  polarimetric: 8,
};

/**
 * Get colormap ID from name
 * @param {string} name - Colormap name
 * @returns {number} Colormap ID for shader
 */
export function getColormapId(name) {
  return COLORMAP_IDS[name] ?? COLORMAP_IDS.grayscale;
}

/**
 * Stretch mode name to integer mapping for shader
 */
export const STRETCH_MODE_IDS = {
  linear: 0,
  sqrt: 1,
  gamma: 2,
  sigmoid: 3,
};

/**
 * Get stretch mode ID from name
 * @param {string} name - Stretch mode name
 * @returns {number} Stretch mode ID for shader
 */
export function getStretchModeId(name) {
  return STRETCH_MODE_IDS[name] ?? STRETCH_MODE_IDS.linear;
}

/**
 * Consolidated GLSL colormap functions (single source of truth)
 * Use this in all layers to ensure consistent colormaps across the application.
 */
export const glslColormaps = `
// Grayscale colormap
vec3 grayscale(float t) {
  t = clamp(t, 0.0, 1.0);
  return vec3(t, t, t);
}

// Viridis colormap lookup
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

// Inferno colormap lookup
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

// Plasma colormap lookup (matplotlib canonical coefficients)
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

// Phase colormap (cyclic, for interferometry)
vec3 phaseColormap(float t) {
  t = clamp(t, 0.0, 1.0);
  float angle = t * 6.28318530718; // 2 * PI
  return vec3(
    0.5 + 0.5 * cos(angle),
    0.5 + 0.5 * cos(angle + 2.09439510239), // + 2*PI/3
    0.5 + 0.5 * cos(angle + 4.18879020479)  // + 4*PI/3
  );
}

// SARdine brand colormap — navy → teal → cyan → near-white
vec3 sardineMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.33) {
    float s = t / 0.33;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.165, 0.541, 0.576), s);
  } else if (t < 0.67) {
    float s = (t - 0.33) / 0.34;
    c = mix(vec3(0.165, 0.541, 0.576), vec3(0.306, 0.788, 0.824), s);
  } else {
    float s = (t - 0.67) / 0.33;
    c = mix(vec3(0.306, 0.788, 0.824), vec3(0.910, 0.929, 0.961), s);
  }
  return c;
}

// Flood alert colormap — navy → deep orange → bright orange → red
vec3 floodMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.33) {
    float s = t / 0.33;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.710, 0.392, 0.165), s);
  } else if (t < 0.67) {
    float s = (t - 0.33) / 0.34;
    c = mix(vec3(0.710, 0.392, 0.165), vec3(0.910, 0.514, 0.227), s);
  } else {
    float s = (t - 0.67) / 0.33;
    c = mix(vec3(0.910, 0.514, 0.227), vec3(1.0, 0.361, 0.361), s);
  }
  return c;
}

// Diverging colormap — cyan → navy → orange (zero-centered)
vec3 divergingMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.5) {
    float s = t / 0.5;
    c = mix(vec3(0.306, 0.788, 0.824), vec3(0.039, 0.086, 0.157), s);
  } else {
    float s = (t - 0.5) / 0.5;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.910, 0.514, 0.227), s);
  }
  return c;
}

// Polarimetric colormap — for RGB decompositions
vec3 polarimetricMap(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  if (t < 0.25) {
    float s = t / 0.25;
    c = mix(vec3(0.039, 0.086, 0.157), vec3(0.306, 0.216, 0.529), s);
  } else if (t < 0.5) {
    float s = (t - 0.25) / 0.25;
    c = mix(vec3(0.306, 0.216, 0.529), vec3(0.710, 0.392, 0.165), s);
  } else if (t < 0.75) {
    float s = (t - 0.5) / 0.25;
    c = mix(vec3(0.710, 0.392, 0.165), vec3(0.910, 0.788, 0.227), s);
  } else {
    float s = (t - 0.75) / 0.25;
    c = mix(vec3(0.910, 0.788, 0.227), vec3(0.961, 0.961, 0.961), s);
  }
  return c;
}
`;

export default {
  sarVertexShader,
  sarFragmentShader,
  COLORMAP_IDS,
  getColormapId,
  STRETCH_MODE_IDS,
  getStretchModeId,
};
