/**
 * SAR RGB Composite Presets
 *
 * Standard SAR polarimetric color combinations for GCOV power data.
 * GCOV datasets contain backscatter power values:
 *   HHHH = |HH|², HVHV = |HV|², VHVH = |VH|², VVVV = |VV|²
 *
 * Off-diagonal terms (complex):
 *   HHVV = <SHH·SVV*> — stored as CFloat32 in NISAR, de-interleaved
 *   to HHVV_re (real) and HHVV_im (imaginary) by the loader.
 */

import { applyStretch } from './stretch.js';

/**
 * Freeman-Durden 3-component decomposition (per-pixel).
 *
 * Decomposes the 3×3 covariance matrix into:
 *   Ps — surface (single-bounce Bragg)
 *   Pd — double-bounce (dihedral)
 *   Pv — volume (random canopy)
 *
 * Uses the random-dipole-cloud volume model (Freeman & Durden 1998, IEEE TGRS).
 *
 * @param {number} c11 - <|SHH|²>      (HHHH)
 * @param {number} c22 - <|SHV|²>      (HVHV)
 * @param {number} c33 - <|SVV|²>      (VVVV)
 * @param {number} c13re - Re(<SHH·SVV*>) (Re(HHVV))
 * @param {number} c13im - Im(<SHH·SVV*>) (Im(HHVV))
 * @returns {{Ps: number, Pd: number, Pv: number}}
 */
function freemanDurden(c11, c22, c33, c13re, c13im) {
  const span = c11 + 2 * c22 + c33;
  if (span <= 1e-20) return { Ps: 0, Pd: 0, Pv: 0 };

  // Volume: random dipole cloud model
  // Cv_22 = fv/4 → fv = 4·C22
  // Cv_11 = Cv_33 = fv/2, Cv_13 = fv/4
  // Volume power in span: fv/2 + 2·fv/4 + fv/2 = 3fv/2
  const fv = 4 * c22;

  // Residual co-pol after removing volume contribution
  const c11r = c11 - fv / 2;     // C11 - 2·C22
  const c33r = c33 - fv / 2;     // C33 - 2·C22
  const c13r_re = c13re - c22;   // Re(C13) - C22  (fv/4 = C22)
  const c13r_im = c13im;

  let Ps, Pd, Pv;

  if (c11r <= 0 || c33r <= 0) {
    // Volume over-estimated — assign all power to volume
    return { Ps: 0, Pd: 0, Pv: span };
  }

  const c13r_sq = c13r_re * c13r_re + c13r_im * c13r_im;
  const det = c11r * c33r;

  if (c13r_re >= 0) {
    // Surface dominant: fix α = -1
    // Ps from C33 residual, Pd from remainder
    Ps = c33r;
    Pd = (det > c13r_sq) ? c11r - c13r_sq / c33r : 0;
  } else {
    // Double-bounce dominant: fix β = 1
    // Pd from C11 residual, Ps from remainder
    Pd = c11r;
    Ps = (det > c13r_sq) ? c33r - c13r_sq / c11r : 0;
  }

  if (Ps < 0) Ps = 0;
  if (Pd < 0) Pd = 0;
  Pv = span - Ps - Pd;
  if (Pv < 0) Pv = 0;

  return { Ps, Pd, Pv };
}

/**
 * Compute Freeman-Durden RGB bands for an entire tile.
 *
 * Standard convention: R = Pd (double-bounce, red in urban areas),
 *                      G = Pv (volume, green in forests),
 *                      B = Ps (surface, blue over water / bare soil).
 *
 * @param {Object} bands - {HHHH, HVHV, VVVV, HHVV_re, HHVV_im} Float32Arrays
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
function computeFreemanDurdenRGB(bands) {
  const hh = bands['HHHH'];
  const hv = bands['HVHV'];
  const vv = bands['VVVV'];
  const re = bands['HHVV_re'];
  const im = bands['HHVV_im'];
  const n = hh.length;

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const c11 = hh[i];
    const c22 = hv[i];
    const c33 = vv[i];
    const c13re = re ? re[i] : 0;
    const c13im = im ? im[i] : 0;

    if (c11 <= 0 && c22 <= 0 && c33 <= 0) continue; // nodata

    const { Ps, Pd, Pv } = freemanDurden(c11, c22, c33, c13re, c13im);
    R[i] = Pd;  // double-bounce → red (urban)
    G[i] = Pv;  // volume → green (vegetation)
    B[i] = Ps;  // surface → blue (water/soil)
  }

  return { R, G, B };
}

/**
 * SAR composite preset definitions
 * Each preset maps R/G/B channels to polarization datasets or formulas.
 */
export const SAR_COMPOSITES = {
  'hh-hv-vv': {
    name: 'HH / HV / VV',
    description: 'Standard quad-pol RGB',
    required: ['HHHH', 'HVHV', 'VVVV'],
    channels: {
      R: { dataset: 'HHHH' },
      G: { dataset: 'HVHV' },
      B: { dataset: 'VVVV' },
    },
  },
  'pauli-power': {
    name: 'Pauli (power)',
    description: 'Approx Pauli decomposition from power data',
    required: ['HHHH', 'HVHV', 'VVVV'],
    channels: {
      R: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const vv = bands['VVVV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = Math.abs(hh[i] - vv[i]);
          }
          return result;
        },
        datasets: ['HHHH', 'VVVV'],
        label: '|HH−VV|',
      },
      G: { dataset: 'HVHV' },
      B: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const vv = bands['VVVV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = hh[i] + vv[i];
          }
          return result;
        },
        datasets: ['HHHH', 'VVVV'],
        label: 'HH+VV',
      },
    },
  },
  'dual-pol-v': {
    name: 'VV / VH / VV÷VH',
    description: 'Dual-pol V-transmit (Sentinel-1 style)',
    required: ['VVVV', 'VHVH'],
    channels: {
      R: { dataset: 'VVVV' },
      G: { dataset: 'VHVH' },
      B: {
        formula: (bands) => {
          const vv = bands['VVVV'];
          const vh = bands['VHVH'];
          const result = new Float32Array(vv.length);
          for (let i = 0; i < vv.length; i++) {
            result[i] = vv[i] / Math.max(vh[i], 1e-10);
          }
          return result;
        },
        datasets: ['VVVV', 'VHVH'],
        label: 'VV/VH',
      },
    },
  },
  'dual-pol-h': {
    name: 'HH / HV / HH÷HV',
    description: 'Dual-pol H-transmit (ALOS style)',
    required: ['HHHH', 'HVHV'],
    channels: {
      R: { dataset: 'HHHH' },
      G: { dataset: 'HVHV' },
      B: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const hv = bands['HVHV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = hh[i] / Math.max(hv[i], 1e-10);
          }
          return result;
        },
        datasets: ['HHHH', 'HVHV'],
        label: 'HH/HV',
      },
    },
  },
  'freeman-durden': {
    name: 'Freeman-Durden',
    description: 'Double-bounce / Volume / Surface decomposition',
    required: ['HHHH', 'HVHV', 'VVVV'],
    requiredComplex: ['HHVV'],
    computeAll: true,
    formula: computeFreemanDurdenRGB,
    channelLabels: { R: 'Pd (dbl-bounce)', G: 'Pv (volume)', B: 'Ps (surface)' },
  },
};

/**
 * Auto-select the best composite preset based on available polarization datasets.
 * @param {Array<{frequency: string, polarization: string}>} availableDatasets
 * @returns {string|null} Composite ID or null if only 1 pol available
 */
export function autoSelectComposite(availableDatasets) {
  const pols = new Set(availableDatasets.map(d => d.polarization));

  // Default pattern: R=co-pol, G=cross-pol, B=co-pol/cross-pol (ratio)
  // H-transmit (NISAR primary, ALOS)
  if (pols.has('HHHH') && pols.has('HVHV')) {
    return 'dual-pol-h';
  }

  // V-transmit (Sentinel-1 style)
  if (pols.has('VVVV') && pols.has('VHVH')) {
    return 'dual-pol-v';
  }

  // Not enough bands for RGB
  return null;
}

/**
 * Get the list of available composites for a set of polarizations.
 * @param {Array<{frequency: string, polarization: string}>} availableDatasets
 * @returns {Array<{id: string, name: string, description: string}>}
 */
export function getAvailableComposites(availableDatasets) {
  const pols = new Set(availableDatasets.map(d => d.polarization));

  return Object.entries(SAR_COMPOSITES)
    .filter(([, preset]) => preset.required.every(p => pols.has(p)))
    // Note: complex terms (requiredComplex) are discovered at load time,
    // not from the dataset list. We show the composite as available if
    // the diagonal terms match; missing complex terms will degrade gracefully.
    .map(([id, preset]) => ({
      id,
      name: preset.name,
      description: preset.description,
    }));
}

/**
 * Get the unique dataset polarizations needed for a composite (real-valued).
 * @param {string} compositeId
 * @returns {string[]} List of polarization names (e.g. ['HHHH', 'HVHV', 'VVVV'])
 */
export function getRequiredDatasets(compositeId) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return [];
  return preset.required;
}

/**
 * Get the complex (off-diagonal) datasets needed for a composite.
 * @param {string} compositeId
 * @returns {string[]} List of complex term names (e.g. ['HHVV'])
 */
export function getRequiredComplexDatasets(compositeId) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return [];
  return preset.requiredComplex || [];
}

/**
 * Compute RGB channel values from raw band data.
 *
 * @param {Object} bandData - Map of polarization name → Float32Array
 * @param {string} compositeId - Which composite preset to apply
 * @param {number} tileSize - Tile width (assumes square tile if numPixels not given)
 * @param {number} [numPixels] - Total pixel count (for non-square images)
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
export function computeRGBBands(bandData, compositeId, tileSize, numPixels) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) {
    throw new Error(`Unknown composite: ${compositeId}`);
  }

  if (numPixels === undefined) numPixels = tileSize * tileSize;

  // Decomposition presets compute all channels at once (e.g. Freeman-Durden)
  if (preset.computeAll && preset.formula) {
    return preset.formula(bandData);
  }

  const result = {};

  for (const channel of ['R', 'G', 'B']) {
    const chDef = preset.channels[channel];

    if (chDef.formula) {
      // Formula-based channel: pass all band data, get computed result
      result[channel] = chDef.formula(bandData);
    } else {
      // Direct dataset mapping
      const data = bandData[chDef.dataset];
      if (data) {
        result[channel] = data;
      } else {
        // Missing band — fill with zeros
        result[channel] = new Float32Array(numPixels);
      }
    }
  }

  return result;
}

/**
 * Create an RGBA ImageData from three RGB Float32Array bands.
 * Applies per-channel dB scaling, contrast stretch, and optional gamma/stretch mode.
 *
 * @param {{R: Float32Array, G: Float32Array, B: Float32Array}} bands
 * @param {number} width
 * @param {number} height
 * @param {number[]} contrastLimits - [min, max] applied uniformly to all channels
 * @param {boolean} useDecibels - Whether to apply 10*log10 before stretching
 * @param {number} gamma - Gamma exponent (default 1.0)
 * @param {string} stretchMode - Stretch mode (default 'linear')
 * @param {Uint8Array|null} dataMask - Optional mask array (NISAR convention: 0=invalid, 1-5=valid, 255=fill)
 * @param {boolean} useMask - Whether to apply mask (if dataMask provided)
 * @returns {ImageData}
 */
export function createRGBTexture(bands, width, height, contrastLimits, useDecibels, gamma = 1.0, stretchMode = 'linear', dataMask = null, useMask = false) {
  // Support per-channel contrast: {R: [min,max], G: [min,max], B: [min,max]}
  // or uniform: [min, max]
  const channelKeys = ['R', 'G', 'B'];
  const limits = {};
  if (Array.isArray(contrastLimits)) {
    const [min, max] = contrastLimits;
    for (const ch of channelKeys) {
      limits[ch] = [min, max];
    }
  } else {
    for (const ch of channelKeys) {
      limits[ch] = contrastLimits[ch] || [-25, 0];
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    let anyValid = false;

    for (let c = 0; c < 3; c++) {
      const channelKey = channelKeys[c];
      const raw = bands[channelKey][i];

      if (isNaN(raw) || raw === 0) {
        rgba[idx + c] = 0;
        continue;
      }

      anyValid = true;

      const [chMin, chMax] = limits[channelKey];
      const range = chMax - chMin || 1;
      let value;
      if (useDecibels) {
        const db = 10 * Math.log10(Math.max(raw, 1e-10));
        value = (db - chMin) / range;
      } else {
        value = (raw - chMin) / range;
      }

      value = Math.max(0, Math.min(1, value));
      if (needsStretch) value = applyStretch(value, stretchMode, gamma);
      rgba[idx + c] = Math.round(value * 255);
    }

    let alpha = anyValid ? 255 : 0;
    // Apply mask if enabled (NISAR convention: 0=invalid, 255=fill → transparent; 1-5=valid)
    if (useMask && dataMask && dataMask[i] !== undefined) {
      const maskVal = dataMask[i];
      if (maskVal < 0.5 || maskVal > 254.5) alpha = 0;
    }
    rgba[idx + 3] = alpha;
  }

  return new ImageData(rgba, width, height);
}
