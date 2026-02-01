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

// Plasma colormap lookup
vec3 plasma(float t) {
  const vec3 c0 = vec3(0.0505, 0.0298, 0.5280);
  const vec3 c1 = vec3(2.0206, 0.0000, 0.7067);
  const vec3 c2 = vec3(-1.0313, 1.2882, 0.3985);
  const vec3 c3 = vec3(-6.0884, -0.7839, -4.6899);
  const vec3 c4 = vec3(7.1103, -2.6782, 6.5379);
  const vec3 c5 = vec3(-2.7666, 3.0649, -3.5380);
  const vec3 c6 = vec3(0.8027, -0.8948, 0.9565);
  
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
};

/**
 * Get colormap ID from name
 * @param {string} name - Colormap name
 * @returns {number} Colormap ID for shader
 */
export function getColormapId(name) {
  return COLORMAP_IDS[name] ?? COLORMAP_IDS.grayscale;
}

export default {
  sarVertexShader,
  sarFragmentShader,
  COLORMAP_IDS,
  getColormapId,
};
