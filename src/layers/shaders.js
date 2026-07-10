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
 * Consolidated GLSL colormap functions (single source of truth).
 * Used by sarFragmentShader and SARGPULayer.
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

// Twilight colormap — cyclic perceptually uniform (Matplotlib)
vec3 twilightMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 s0 = vec3(0.886, 0.850, 0.888);
  const vec3 s1 = vec3(0.695, 0.625, 0.831);
  const vec3 s2 = vec3(0.418, 0.365, 0.733);
  const vec3 s3 = vec3(0.196, 0.225, 0.558);
  const vec3 s4 = vec3(0.188, 0.329, 0.367);
  const vec3 s5 = vec3(0.394, 0.303, 0.262);
  const vec3 s6 = vec3(0.610, 0.278, 0.225);
  const vec3 s7 = vec3(0.769, 0.390, 0.382);
  const vec3 s8 = vec3(0.886, 0.850, 0.888);
  float seg = t * 8.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)      c = mix(s0, s1, s);
  else if (i < 2.0) c = mix(s1, s2, s);
  else if (i < 3.0) c = mix(s2, s3, s);
  else if (i < 4.0) c = mix(s3, s4, s);
  else if (i < 5.0) c = mix(s4, s5, s);
  else if (i < 6.0) c = mix(s5, s6, s);
  else if (i < 7.0) c = mix(s6, s7, s);
  else              c = mix(s7, s8, s);
  return c;
}

// SARdine colormap — cubehelix (Green 2011) tuned for SAR.
// Perceptually-uniform black→white with a subtle hue rotation through
// the midtones. Floor anchored at #030201 (deepest displayable black)
// so the ramp's bottom blends into the canvas background.
vec3 sardineMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const float start = 0.5;
  const float rotations = -1.5;
  const float hue = 1.0;
  float fract = t;
  float angle = 6.28318530718 * (start / 3.0 + rotations * fract);
  float amp = hue * fract * (1.0 - fract) / 2.0;
  float cosA = cos(angle);
  float sinA = sin(angle);
  float r = fract + amp * (-0.14861 * cosA + 1.78277 * sinA);
  float g = fract + amp * (-0.29227 * cosA - 0.90649 * sinA);
  float b = fract + amp * ( 1.97294 * cosA);
  vec3 c = clamp(vec3(r, g, b), 0.0, 1.0);
  vec3 floorC = vec3(3.0 / 255.0, 2.0 / 255.0, 1.0 / 255.0);
  return floorC + (vec3(1.0) - floorC) * c;
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

// Label colormap — deterministic hash-based colors for integer labels
vec3 labelMap(float t) {
  t = clamp(t, 0.0, 1.0);
  float idx = floor(t * 255.0 + 0.5);
  if (idx < 0.5) return vec3(0.0);
  float hue = fract(idx * 0.618033988749895);
  float sat = 0.7 + 0.3 * mod(idx * 13.0, 7.0) / 6.0;
  float val = 0.75 + 0.25 * mod(idx * 7.0, 5.0) / 4.0;
  float h = hue * 6.0;
  float i = floor(h);
  float f = h - i;
  float p = val * (1.0 - sat);
  float q = val * (1.0 - sat * f);
  float tt = val * (1.0 - sat * (1.0 - f));
  float mi = mod(i, 6.0);
  vec3 c;
  if (mi < 0.5)      c = vec3(val, tt, p);
  else if (mi < 1.5) c = vec3(q, val, p);
  else if (mi < 2.5) c = vec3(p, val, tt);
  else if (mi < 3.5) c = vec3(p, q, val);
  else if (mi < 4.5) c = vec3(tt, p, val);
  else               c = vec3(val, p, q);
  return c;
}

// RdBu diverging — blue-white-red (InSAR displacement standard)
vec3 rdbuMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 s0  = vec3(0.020, 0.188, 0.380);
  const vec3 s1  = vec3(0.129, 0.400, 0.674);
  const vec3 s2  = vec3(0.263, 0.576, 0.765);
  const vec3 s3  = vec3(0.573, 0.773, 0.871);
  const vec3 s4  = vec3(0.820, 0.898, 0.941);
  const vec3 s5  = vec3(0.969, 0.969, 0.969);
  const vec3 s6  = vec3(0.992, 0.859, 0.780);
  const vec3 s7  = vec3(0.957, 0.647, 0.510);
  const vec3 s8  = vec3(0.839, 0.376, 0.302);
  const vec3 s9  = vec3(0.698, 0.094, 0.169);
  const vec3 s10 = vec3(0.404, 0.000, 0.122);
  float seg = t * 10.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(s0, s1, s);
  else if (i < 2.0)  c = mix(s1, s2, s);
  else if (i < 3.0)  c = mix(s2, s3, s);
  else if (i < 4.0)  c = mix(s3, s4, s);
  else if (i < 5.0)  c = mix(s4, s5, s);
  else if (i < 6.0)  c = mix(s5, s6, s);
  else if (i < 7.0)  c = mix(s6, s7, s);
  else if (i < 8.0)  c = mix(s7, s8, s);
  else if (i < 9.0)  c = mix(s8, s9, s);
  else               c = mix(s9, s10, s);
  return c;
}

// romaO cyclic — Crameri scientific colour map for wrapped interferograms
vec3 romaOMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 r0 = vec3(0.451, 0.165, 0.075);
  const vec3 r1 = vec3(0.682, 0.357, 0.090);
  const vec3 r2 = vec3(0.835, 0.620, 0.247);
  const vec3 r3 = vec3(0.769, 0.831, 0.518);
  const vec3 r4 = vec3(0.475, 0.733, 0.616);
  const vec3 r5 = vec3(0.247, 0.514, 0.616);
  const vec3 r6 = vec3(0.227, 0.302, 0.518);
  const vec3 r7 = vec3(0.298, 0.157, 0.369);
  const vec3 r8 = vec3(0.451, 0.165, 0.075);
  float seg = t * 8.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(r0, r1, s);
  else if (i < 2.0)  c = mix(r1, r2, s);
  else if (i < 3.0)  c = mix(r2, r3, s);
  else if (i < 4.0)  c = mix(r3, r4, s);
  else if (i < 5.0)  c = mix(r4, r5, s);
  else if (i < 6.0)  c = mix(r5, r6, s);
  else if (i < 7.0)  c = mix(r6, r7, s);
  else               c = mix(r7, r8, s);
  return c;
}

// Magma — perceptually uniform (Matplotlib magma, 9-stop sample)
vec3 magma(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 m0 = vec3(0.001, 0.000, 0.014);
  const vec3 m1 = vec3(0.116, 0.063, 0.296);
  const vec3 m2 = vec3(0.317, 0.072, 0.485);
  const vec3 m3 = vec3(0.522, 0.139, 0.510);
  const vec3 m4 = vec3(0.716, 0.215, 0.476);
  const vec3 m5 = vec3(0.890, 0.314, 0.395);
  const vec3 m6 = vec3(0.987, 0.510, 0.350);
  const vec3 m7 = vec3(0.996, 0.745, 0.439);
  const vec3 m8 = vec3(0.987, 0.991, 0.749);
  float seg = t * 8.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(m0, m1, s);
  else if (i < 2.0)  c = mix(m1, m2, s);
  else if (i < 3.0)  c = mix(m2, m3, s);
  else if (i < 4.0)  c = mix(m3, m4, s);
  else if (i < 5.0)  c = mix(m4, m5, s);
  else if (i < 6.0)  c = mix(m5, m6, s);
  else if (i < 7.0)  c = mix(m6, m7, s);
  else               c = mix(m7, m8, s);
  return c;
}

// Cividis — perceptually uniform AND colorblind-optimized (8-stop sample)
vec3 cividisMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 v0 = vec3(0.000, 0.135, 0.305);
  const vec3 v1 = vec3(0.099, 0.210, 0.420);
  const vec3 v2 = vec3(0.176, 0.286, 0.478);
  const vec3 v3 = vec3(0.275, 0.357, 0.490);
  const vec3 v4 = vec3(0.376, 0.431, 0.490);
  const vec3 v5 = vec3(0.486, 0.510, 0.471);
  const vec3 v6 = vec3(0.616, 0.604, 0.435);
  const vec3 v7 = vec3(0.761, 0.706, 0.376);
  const vec3 v8 = vec3(1.000, 0.835, 0.310);
  float seg = t * 8.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(v0, v1, s);
  else if (i < 2.0)  c = mix(v1, v2, s);
  else if (i < 3.0)  c = mix(v2, v3, s);
  else if (i < 4.0)  c = mix(v3, v4, s);
  else if (i < 5.0)  c = mix(v4, v5, s);
  else if (i < 6.0)  c = mix(v5, v6, s);
  else if (i < 7.0)  c = mix(v6, v7, s);
  else               c = mix(v7, v8, s);
  return c;
}

// Turbo — Google's improved jet (Mikhailov 2019), high-contrast non-uniform
vec3 turboMap(float t) {
  t = clamp(t, 0.0, 1.0);
  float r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  float g = 0.09140261 + t * (2.19418839 + t * (4.84296658   + t * (-14.18503333 + t * (4.27729857    + t * 2.82956604))));
  float b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

// Batlow — Crameri sequential perceptually uniform (9-stop sample)
vec3 batlowMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 b0 = vec3(0.0051, 0.0980, 0.3490);
  const vec3 b1 = vec3(0.0863, 0.2235, 0.3686);
  const vec3 b2 = vec3(0.1804, 0.3373, 0.3490);
  const vec3 b3 = vec3(0.3137, 0.4275, 0.2902);
  const vec3 b4 = vec3(0.5020, 0.4980, 0.2196);
  const vec3 b5 = vec3(0.7059, 0.5333, 0.2196);
  const vec3 b6 = vec3(0.8902, 0.5569, 0.3294);
  const vec3 b7 = vec3(0.9804, 0.6275, 0.5333);
  const vec3 b8 = vec3(0.9843, 0.7961, 0.7725);
  float seg = t * 8.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(b0, b1, s);
  else if (i < 2.0)  c = mix(b1, b2, s);
  else if (i < 3.0)  c = mix(b2, b3, s);
  else if (i < 4.0)  c = mix(b3, b4, s);
  else if (i < 5.0)  c = mix(b4, b5, s);
  else if (i < 6.0)  c = mix(b5, b6, s);
  else if (i < 7.0)  c = mix(b6, b7, s);
  else               c = mix(b7, b8, s);
  return c;
}

// Coherence — black → red → orange → yellow → white (InSAR coherence-specific)
vec3 coherenceMap(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 h0 = vec3(0.000, 0.000, 0.000);
  const vec3 h1 = vec3(0.180, 0.030, 0.040);
  const vec3 h2 = vec3(0.500, 0.110, 0.040);
  const vec3 h3 = vec3(0.820, 0.310, 0.050);
  const vec3 h4 = vec3(0.980, 0.620, 0.110);
  const vec3 h5 = vec3(1.000, 1.000, 0.880);
  float seg = t * 5.0;
  float i = floor(seg);
  float s = seg - i;
  vec3 c;
  if (i < 1.0)       c = mix(h0, h1, s);
  else if (i < 2.0)  c = mix(h1, h2, s);
  else if (i < 3.0)  c = mix(h2, h3, s);
  else if (i < 4.0)  c = mix(h3, h4, s);
  else               c = mix(h4, h5, s);
  return c;
}
`;

/**
 * Fragment shader for SAR tile layer.
 * Composed from glslColormaps (single source of truth for colormap functions).
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
uniform int uStretchMode;  // 0=linear, 1=sqrt, 2=cbrt, 3=log, 4=gamma, 5=sigmoid
uniform float uGamma;
uniform bool uReverseColormap;

in vec2 vTexCoord;
out vec4 fragColor;

${glslColormaps}

void main(void) {
  vec4 texel = texture(uTexture, vTexCoord);
  float amplitude = texel.r;

  float value;
  if (uUseDecibels) {
    float db = 10.0 * log2(max(amplitude, 1e-10)) * 0.30103;
    value = (db - uMin) / (uMax - uMin);
  } else {
    value = (amplitude - uMin) / (uMax - uMin);
  }

  value = clamp(value, 0.0, 1.0);

  // Apply stretch mode
  if (uStretchMode == 1) {
    value = sqrt(value);
  } else if (uStretchMode == 2) {
    value = pow(max(value, 0.0), 1.0 / 3.0);
  } else if (uStretchMode == 3) {
    float k = pow(10.0, 1.0 + uGamma);
    value = log(1.0 + k * value) / log(1.0 + k);
  } else if (uStretchMode == 4) {
    value = pow(value, uGamma);
  } else if (uStretchMode == 5) {
    float gain = uGamma * 8.0;
    float raw = 1.0 / (1.0 + exp(-gain * (value - 0.5)));
    float lo = 1.0 / (1.0 + exp(gain * 0.5));
    float hi = 1.0 / (1.0 + exp(-gain * 0.5));
    float denom = hi - lo;
    value = denom > 0.0 ? clamp((raw - lo) / denom, 0.0, 1.0) : value;
  }

  // Reverse-ramp toggle (skipped for label colormap, which has no meaningful inverse)
  float cmapInput = (uReverseColormap && uColormap != 10) ? (1.0 - value) : value;

  vec3 color;
  if (uColormap == 0) {
    color = grayscale(cmapInput);
  } else if (uColormap == 1) {
    color = viridis(cmapInput);
  } else if (uColormap == 2) {
    color = inferno(cmapInput);
  } else if (uColormap == 3) {
    color = plasma(cmapInput);
  } else if (uColormap == 4) {
    color = phaseColormap(cmapInput);
  } else if (uColormap == 5) {
    color = twilightMap(cmapInput);
  } else if (uColormap == 6) {
    color = sardineMap(cmapInput);
  } else if (uColormap == 7) {
    color = floodMap(cmapInput);
  } else if (uColormap == 8) {
    color = divergingMap(cmapInput);
  } else if (uColormap == 9) {
    color = polarimetricMap(cmapInput);
  } else if (uColormap == 10) {
    color = labelMap(value);
  } else if (uColormap == 11) {
    color = rdbuMap(cmapInput);
  } else if (uColormap == 12) {
    color = romaOMap(cmapInput);
  } else if (uColormap == 13) {
    color = magma(cmapInput);
  } else if (uColormap == 14) {
    color = cividisMap(cmapInput);
  } else if (uColormap == 15) {
    color = turboMap(cmapInput);
  } else if (uColormap == 16) {
    color = batlowMap(cmapInput);
  } else if (uColormap == 17) {
    color = coherenceMap(cmapInput);
  } else {
    color = grayscale(cmapInput);
  }

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
  twilight: 5,
  sardine: 6,
  flood: 7,
  diverging: 8,
  polarimetric: 9,
  label: 10,
  rdbu: 11,
  romaO: 12,
  magma: 13,
  cividis: 14,
  turbo: 15,
  batlow: 16,
  coherence: 17,
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
  cbrt: 2,
  log: 3,
  gamma: 4,
  sigmoid: 5,
};

/**
 * Get stretch mode ID from name
 * @param {string} name - Stretch mode name
 * @returns {number} Stretch mode ID for shader
 */
export function getStretchModeId(name) {
  return STRETCH_MODE_IDS[name] ?? STRETCH_MODE_IDS.linear;
}

export default {
  sarVertexShader,
  sarFragmentShader,
  glslColormaps,
  COLORMAP_IDS,
  getColormapId,
  STRETCH_MODE_IDS,
  getStretchModeId,
};
