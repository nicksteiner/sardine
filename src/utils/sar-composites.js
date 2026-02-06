/**
 * SAR RGB Composite Presets
 *
 * Standard SAR polarimetric color combinations for GCOV power data.
 * GCOV datasets contain backscatter power values:
 *   HHHH = |HH|², HVHV = |HV|², VHVH = |VH|², VVVV = |VV|²
 */

import { applyStretch } from './stretch.js';

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
    .map(([id, preset]) => ({
      id,
      name: preset.name,
      description: preset.description,
    }));
}

/**
 * Get the unique dataset polarizations needed for a composite.
 * @param {string} compositeId
 * @returns {string[]} List of polarization names (e.g. ['HHHH', 'HVHV', 'VVVV'])
 */
export function getRequiredDatasets(compositeId) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return [];
  return preset.required;
}

/**
 * Compute RGB channel values from raw band data for a single tile.
 *
 * @param {Object} bandData - Map of polarization name → Float32Array
 * @param {string} compositeId - Which composite preset to apply
 * @param {number} tileSize - Number of pixels (width = height = tileSize)
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
export function computeRGBBands(bandData, compositeId, tileSize) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) {
    throw new Error(`Unknown composite: ${compositeId}`);
  }

  const numPixels = tileSize * tileSize;
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
 * @returns {ImageData}
 */
export function createRGBTexture(bands, width, height, contrastLimits, useDecibels, gamma = 1.0, stretchMode = 'linear') {
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

    rgba[idx + 3] = anyValid ? 255 : 0;
  }

  return new ImageData(rgba, width, height);
}
