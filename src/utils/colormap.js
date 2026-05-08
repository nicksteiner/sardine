/**
 * Colormap utilities for SAR imagery visualization
 * Provides various colormaps optimized for radar data
 */

/**
 * Available colormap names
 */
export const COLORMAP_NAMES = [
  'grayscale', 'viridis', 'inferno', 'plasma', 'magma', 'cividis',
  'turbo', 'batlow', 'coherence', 'phase', 'twilight',
  'sardine', 'flood', 'diverging', 'polarimetric', 'label',
  'rdbu', 'romaO',
];

/**
 * Grayscale colormap
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function grayscale(t) {
  t = Math.max(0, Math.min(1, t));
  const v = Math.round(t * 255);
  return [v, v, v];
}

/**
 * Viridis colormap - perceptually uniform, colorblind-friendly
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function viridis(t) {
  const c0 = [0.2777, 0.0054, 0.334];
  const c1 = [0.105, 0.6389, 0.7916];
  const c2 = [-0.3308, 0.2149, 0.0948];
  const c3 = [-4.6342, -5.7991, -19.3324];
  const c4 = [6.2282, 14.1799, 56.6905];
  const c5 = [4.7763, -13.7451, -65.353];
  const c6 = [-5.4354, 4.6456, 26.3124];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Inferno colormap - perceptually uniform, high contrast
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function inferno(t) {
  const c0 = [0.0002, 0.0016, 0.0139];
  const c1 = [0.1065, 0.0639, 0.2671];
  const c2 = [0.9804, 0.5388, -0.1957];
  const c3 = [-3.4496, -0.2218, -3.1556];
  const c4 = [3.8558, -2.0792, 8.7339];
  const c5 = [-1.4928, 1.8878, -8.0579];
  const c6 = [-0.0003, 0.0009, 2.4578];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Plasma colormap - perceptually uniform
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function plasma(t) {
  // Matplotlib canonical polynomial coefficients (must match GPU shaders.js)
  const c0 = [0.0590, 0.0298, 0.5270];
  const c1 = [0.1836, 0.0965, 0.8355];
  const c2 = [2.3213, 0.4316, -1.5074];
  const c3 = [-11.2436, -0.0486, 4.0720];
  const c4 = [17.5896, -1.1766, -7.6916];
  const c5 = [-11.6096, 1.9411, 6.2390];
  const c6 = [2.8642, -0.6177, -1.6442];

  t = Math.max(0, Math.min(1, t));
  const rgb = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    rgb[i] =
      c0[i] +
      t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))));
    rgb[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
  }

  return rgb;
}

/**
 * Magma colormap - perceptually uniform, black→purple→magenta→orange→pale yellow.
 * Sampled from Matplotlib magma at 9 stops (every 0.125).
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function magma(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.001, 0.000, 0.014],  // 0.000 - near-black
    [0.116, 0.063, 0.296],  // 0.125 - dark purple
    [0.317, 0.072, 0.485],  // 0.250 - violet
    [0.522, 0.139, 0.510],  // 0.375 - magenta
    [0.716, 0.215, 0.476],  // 0.500 - pink
    [0.890, 0.314, 0.395],  // 0.625 - coral
    [0.987, 0.510, 0.350],  // 0.750 - salmon
    [0.996, 0.745, 0.439],  // 0.875 - peach
    [0.987, 0.991, 0.749],  // 1.000 - pale yellow
  ];
  const seg = t * 8;
  const i = Math.min(Math.floor(seg), 7);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * Cividis colormap - perceptually uniform AND optimized for the most common
 * forms of color-vision deficiency (deuteranomaly/protanomaly).
 * Sampled from Matplotlib cividis at 9 stops.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function cividis(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.000, 0.135, 0.305],  // 0.000 - dark blue
    [0.099, 0.210, 0.420],  // 0.125
    [0.176, 0.286, 0.478],  // 0.250
    [0.275, 0.357, 0.490],  // 0.375
    [0.376, 0.431, 0.490],  // 0.500 - desaturated mid
    [0.486, 0.510, 0.471],  // 0.625
    [0.616, 0.604, 0.435],  // 0.750
    [0.761, 0.706, 0.376],  // 0.875
    [1.000, 0.835, 0.310],  // 1.000 - bright yellow
  ];
  const seg = t * 8;
  const i = Math.min(Math.floor(seg), 7);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * Turbo colormap - Google's improved jet replacement.
 * High-contrast rainbow without the perceptual artifacts of jet; widely used
 * for SAR/coherence/velocity visualization where strong feature separation
 * matters more than perceptual uniformity.
 * Polynomial coefficients from Anton Mikhailov (2019, Google AI Blog).
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function turbo(t) {
  t = Math.max(0, Math.min(1, t));
  const r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658   + t * (-14.18503333 + t * (4.27729857    + t * 2.82956604))));
  const b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [
    Math.round(Math.max(0, Math.min(1, r)) * 255),
    Math.round(Math.max(0, Math.min(1, g)) * 255),
    Math.round(Math.max(0, Math.min(1, b)) * 255),
  ];
}

/**
 * Batlow colormap - perceptually uniform sequential ramp from Crameri's
 * Scientific Colour Maps. The de-facto standard for SAR/geo sequential data
 * in modern publications. Colorblind-safe; print-safe in grayscale.
 * Goes: dark blue → green → yellow → tan → light pink.
 * 9-stop sample of Crameri batlow v8.0.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function batlow(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.0051, 0.0980, 0.3490],  // 0.000 - dark blue
    [0.0863, 0.2235, 0.3686],  // 0.125
    [0.1804, 0.3373, 0.3490],  // 0.250
    [0.3137, 0.4275, 0.2902],  // 0.375
    [0.5020, 0.4980, 0.2196],  // 0.500
    [0.7059, 0.5333, 0.2196],  // 0.625
    [0.8902, 0.5569, 0.3294],  // 0.750
    [0.9804, 0.6275, 0.5333],  // 0.875
    [0.9843, 0.7961, 0.7725],  // 1.000 - light pink
  ];
  const seg = t * 8;
  const i = Math.min(Math.floor(seg), 7);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * Phase colormap - cyclic colormap for interferometric phase
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function phase(t) {
  t = Math.max(0, Math.min(1, t));
  const angle = t * 2 * Math.PI;
  const r = Math.round((0.5 + 0.5 * Math.cos(angle)) * 255);
  const g = Math.round((0.5 + 0.5 * Math.cos(angle + (2 * Math.PI) / 3)) * 255);
  const b = Math.round((0.5 + 0.5 * Math.cos(angle + (4 * Math.PI) / 3)) * 255);
  return [r, g, b];
}

/**
 * Twilight colormap - cyclic perceptually uniform (Matplotlib)
 * Symmetric: light lavender → cool purples → dark teal → warm reds → light lavender
 * Ideal for unwrapped phase or any cyclic quantity.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function twilight(t) {
  t = Math.max(0, Math.min(1, t));
  // 9 key stops sampled from Matplotlib twilight (every 0.125)
  const stops = [
    [0.886, 0.850, 0.888],  // 0.000 - light lavender
    [0.695, 0.625, 0.831],  // 0.125 - light purple
    [0.418, 0.365, 0.733],  // 0.250 - medium purple
    [0.196, 0.225, 0.558],  // 0.375 - dark blue-purple
    [0.188, 0.329, 0.367],  // 0.500 - dark teal (nadir)
    [0.394, 0.303, 0.262],  // 0.625 - dark brown
    [0.610, 0.278, 0.225],  // 0.750 - brownish red
    [0.769, 0.390, 0.382],  // 0.875 - salmon
    [0.886, 0.850, 0.888],  // 1.000 - light lavender (cyclic)
  ];
  const seg = t * 8;
  const i = Math.min(Math.floor(seg), 7);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

// ── SARdine brand colorramps ─────────────────────────────────────────────────

/**
 * SARdine colormap — navy → teal → cyan → near-white.
 * Default single-band dB ramp using the SARdine accent palette.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function sardine(t) {
  t = Math.max(0, Math.min(1, t));
  // 4-stop gradient: #0a1628 → #2a8a93 → #4ec9d4 → #e8edf5
  let r, g, b;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 10  + s * (42 - 10);
    g = 22  + s * (138 - 22);
    b = 40  + s * (147 - 40);
  } else if (t < 0.67) {
    const s = (t - 0.33) / 0.34;
    r = 42  + s * (78 - 42);
    g = 138 + s * (201 - 138);
    b = 147 + s * (212 - 147);
  } else {
    const s = (t - 0.67) / 0.33;
    r = 78  + s * (232 - 78);
    g = 201 + s * (237 - 201);
    b = 212 + s * (245 - 212);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Flood alert colormap — navy → deep orange → bright orange → red.
 * Purpose-built for flood threshold visualization.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function flood(t) {
  t = Math.max(0, Math.min(1, t));
  // 4-stop gradient: #0a1628 → #b5642a → #e8833a → #ff5c5c
  let r, g, b;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 10  + s * (181 - 10);
    g = 22  + s * (100 - 22);
    b = 40  + s * (42 - 40);
  } else if (t < 0.67) {
    const s = (t - 0.33) / 0.34;
    r = 181 + s * (232 - 181);
    g = 100 + s * (131 - 100);
    b = 42  + s * (58 - 42);
  } else {
    const s = (t - 0.67) / 0.33;
    r = 232 + s * (255 - 232);
    g = 131 + s * (92 - 131);
    b = 58  + s * (92 - 58);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Diverging colormap — cyan → navy → orange.
 * Zero-centered for change detection (delta-sigma-nought).
 * t=0 → cyan, t=0.5 → navy, t=1 → orange.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function diverging(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.5) {
    // cyan → navy
    const s = t / 0.5;
    r = 78  + s * (10 - 78);
    g = 201 + s * (22 - 201);
    b = 212 + s * (40 - 212);
  } else {
    // navy → orange
    const s = (t - 0.5) / 0.5;
    r = 10  + s * (232 - 10);
    g = 22  + s * (131 - 22);
    b = 40  + s * (58 - 40);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Polarimetric colormap — magenta → navy → green.
 * For HH vs VV backscatter ratio visualization.
 * t=0 → magenta (HH), t=0.5 → navy, t=1 → green (VV).
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function polarimetric(t) {
  t = Math.max(0, Math.min(1, t));
  let r, g, b;
  if (t < 0.5) {
    // magenta → navy
    const s = t / 0.5;
    r = 212 + s * (10 - 212);
    g = 92  + s * (22 - 92);
    b = 255 + s * (40 - 255);
  } else {
    // navy → green
    const s = (t - 0.5) / 0.5;
    r = 10  + s * (61 - 10);
    g = 22  + s * (220 - 22);
    b = 40  + s * (132 - 40);
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/**
 * Label colormap — deterministic hash-based colors for integer labels.
 * Used for connected components and classification maps.
 * Label 0 is transparent (nodata); positive integers get distinct colors.
 * @param {number} t - Value between 0 and 1 (normalized label)
 * @returns {number[]} [r, g, b] values 0-255
 */
export function label(t) {
  t = Math.max(0, Math.min(1, t));
  // Map t back to an integer-like index for hashing
  const idx = Math.round(t * 255);
  if (idx === 0) return [0, 0, 0]; // nodata — will be masked to transparent
  // Golden-ratio hue cycling for maximum visual separation
  const hue = (idx * 0.618033988749895) % 1.0;
  const sat = 0.7 + 0.3 * ((idx * 13) % 7) / 6;
  const val = 0.75 + 0.25 * ((idx * 7) % 5) / 4;
  // HSV to RGB
  const h = hue * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = val * (1 - sat);
  const q = val * (1 - sat * f);
  const tt = val * (1 - sat * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: r = val; g = tt; b = p; break;
    case 1: r = q; g = val; b = p; break;
    case 2: r = p; g = val; b = tt; break;
    case 3: r = p; g = q; b = val; break;
    case 4: r = tt; g = p; b = val; break;
    default: r = val; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Coherence colormap — black → deep red → orange → yellow → white.
 * Sequential ramp purpose-built for InSAR coherence values in [0, 1]:
 * decorrelated regions stay near-black, fully coherent regions read as bright
 * yellow/white. Avoids the cool-tone confusion of viridis for binary "is the
 * pixel coherent?" interpretation.
 * @param {number} t - Value between 0 and 1
 * @returns {number[]} [r, g, b] values 0-255
 */
export function coherence(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.000, 0.000, 0.000],  // 0.00 - black (no coherence)
    [0.180, 0.030, 0.040],  // 0.20 - deep maroon
    [0.500, 0.110, 0.040],  // 0.40 - dark red
    [0.820, 0.310, 0.050],  // 0.60 - deep orange
    [0.980, 0.620, 0.110],  // 0.80 - amber
    [1.000, 1.000, 0.880],  // 1.00 - near-white (full coherence)
  ];
  const seg = t * 5;
  const i = Math.min(Math.floor(seg), 4);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * RdBu (Red-Blue) diverging colormap — the InSAR community standard for
 * displacement visualization. White center with saturated red/blue endpoints.
 * Blue = range decrease (toward satellite), Red = range increase (away).
 * Perceptually uniform, colorblind-accessible, symmetric luminance.
 * Sampled from matplotlib's RdBu_r (reversed so blue=negative, red=positive).
 * @param {number} t - Value between 0 and 1 (0.5 = zero/center)
 * @returns {number[]} [r, g, b] values 0-255
 */
export function rdbu(t) {
  t = Math.max(0, Math.min(1, t));
  // 11-stop RdBu_r sampled from matplotlib (blue at 0, white at 0.5, red at 1)
  const stops = [
    [0.020, 0.188, 0.380],  // 0.0  - dark blue
    [0.129, 0.400, 0.674],  // 0.1  - medium blue
    [0.263, 0.576, 0.765],  // 0.2  - steel blue
    [0.573, 0.773, 0.871],  // 0.3  - light blue
    [0.820, 0.898, 0.941],  // 0.4  - pale blue
    [0.969, 0.969, 0.969],  // 0.5  - near-white center
    [0.992, 0.859, 0.780],  // 0.6  - pale red
    [0.957, 0.647, 0.510],  // 0.7  - light red
    [0.839, 0.376, 0.302],  // 0.8  - medium red
    [0.698, 0.094, 0.169],  // 0.9  - dark red
    [0.404, 0.000, 0.122],  // 1.0  - deep red
  ];
  const seg = t * 10;
  const i = Math.min(Math.floor(seg), 9);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * romaO — cyclic perceptually uniform colormap from Crameri's Scientific
 * Colour Maps. The standard for wrapped interferometric phase display.
 * Bright, saturated, near-uniform luminance around the cycle, colorblind-safe.
 * Goes: red → orange → yellow → green → cyan → blue → magenta → red (cyclic).
 * Sampled from Crameri Scientific Colour Maps v8.0, romaO at every 1/8 cycle.
 * @param {number} t - Value between 0 and 1 (wraps at boundaries)
 * @returns {number[]} [r, g, b] values 0-255
 */
export function romaO(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.451, 0.165, 0.075],  // 0.000 - deep red-brown
    [0.682, 0.357, 0.090],  // 0.125 - burnt orange
    [0.835, 0.620, 0.247],  // 0.250 - warm yellow
    [0.769, 0.831, 0.518],  // 0.375 - pale yellow-green
    [0.475, 0.733, 0.616],  // 0.500 - teal-green
    [0.247, 0.514, 0.616],  // 0.625 - steel blue
    [0.227, 0.302, 0.518],  // 0.750 - deep blue
    [0.298, 0.157, 0.369],  // 0.875 - dark purple
    [0.451, 0.165, 0.075],  // 1.000 - deep red-brown (cyclic seam)
  ];
  const seg = t * 8;
  const i = Math.min(Math.floor(seg), 7);
  const s = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round((a[0] + s * (b[0] - a[0])) * 255),
    Math.round((a[1] + s * (b[1] - a[1])) * 255),
    Math.round((a[2] + s * (b[2] - a[2])) * 255),
  ];
}

/**
 * Get colormap function by name
 * @param {string} name - Colormap name
 * @returns {Function} Colormap function
 */
export function getColormap(name) {
  const colormaps = {
    grayscale,
    viridis,
    inferno,
    plasma,
    magma,
    cividis,
    turbo,
    batlow,
    coherence,
    phase,
    twilight,
    sardine,
    flood,
    diverging,
    polarimetric,
    label,
    rdbu,
    romaO,
  };

  return colormaps[name] || colormaps.grayscale;
}

/**
 * Generate a colorbar as an array of RGB values
 * @param {string} colormapName - Name of the colormap
 * @param {number} steps - Number of color steps (default 256)
 * @returns {number[][]} Array of [r, g, b] values
 */
export function generateColorbar(colormapName, steps = 256) {
  const colormap = getColormap(colormapName);
  const colors = [];

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    colors.push(colormap(t));
  }

  return colors;
}

/**
 * Create a canvas element with a colorbar visualization
 * @param {string} colormapName - Name of the colormap
 * @param {number} width - Canvas width (default 256)
 * @param {number} height - Canvas height (default 20)
 * @param {boolean} horizontal - Horizontal orientation (default true)
 * @returns {HTMLCanvasElement} Canvas element with colorbar
 */
export function createColorbarCanvas(
  colormapName,
  width = 256,
  height = 20,
  horizontal = true
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  const colormap = getColormap(colormapName);

  if (horizontal) {
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1);
      const [r, g, b] = colormap(t);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(x, 0, 1, height);
    }
  } else {
    for (let y = 0; y < height; y++) {
      const t = 1 - y / (height - 1);
      const [r, g, b] = colormap(t);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, y, width, 1);
    }
  }

  return canvas;
}

const _lutCache = new Map();

/**
 * Build a 256-entry RGBA lookup table for a colormap.
 * Results are cached — repeated calls with the same key return the same LUT.
 * @param {string} colormapName - Name of the colormap
 * @param {boolean} [reversed=false] - If true, reverse the ramp (entry i ← colormap((255-i)/255))
 * @returns {Uint8Array} 256×4 = 1024-byte LUT (RGBA per entry)
 */
export function buildColormapLUT(colormapName, reversed = false) {
  const cacheKey = reversed ? `${colormapName}__r` : colormapName;
  const cached = _lutCache.get(cacheKey);
  if (cached) return cached;
  const colormap = getColormap(colormapName);
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = reversed ? (255 - i) / 255 : i / 255;
    const [r, g, b] = colormap(t);
    const off = i * 4;
    lut[off] = r;
    lut[off + 1] = g;
    lut[off + 2] = b;
    lut[off + 3] = 255;
  }
  _lutCache.set(cacheKey, lut);
  return lut;
}

/**
 * Apply colormap to an array of normalized values.
 * Uses a 256-entry LUT for ~3-5× speedup over per-pixel function calls.
 * @param {number[]|Float32Array} values - Array of values between 0 and 1
 * @param {string} colormapName - Name of the colormap
 * @param {boolean} [reversed=false] - If true, invert the ramp
 * @returns {Uint8ClampedArray} RGBA array
 */
export function applyColormap(values, colormapName, reversed = false) {
  const lut = buildColormapLUT(colormapName, reversed);
  const rgba = new Uint8ClampedArray(values.length * 4);

  for (let i = 0; i < values.length; i++) {
    // Quantize [0,1] → [0,255] index into LUT
    const lutIdx = (Math.max(0, Math.min(1, values[i])) * 255 + 0.5) | 0;
    const src = lutIdx * 4;
    const dst = i * 4;
    rgba[dst] = lut[src];
    rgba[dst + 1] = lut[src + 1];
    rgba[dst + 2] = lut[src + 2];
    rgba[dst + 3] = lut[src + 3];
  }

  return rgba;
}

export default {
  COLORMAP_NAMES,
  grayscale,
  viridis,
  inferno,
  plasma,
  magma,
  cividis,
  turbo,
  batlow,
  coherence,
  phase,
  twilight,
  sardine,
  flood,
  diverging,
  polarimetric,
  label,
  rdbu,
  romaO,
  getColormap,
  generateColorbar,
  createColorbarCanvas,
  buildColormapLUT,
  applyColormap,
};
