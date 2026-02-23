/**
 * SAR image stretch/enhancement modes.
 * Applied after normalization to [0,1] and before colormap mapping.
 *
 * Inspired by medical imaging (DICOM Window/Level, gamma correction)
 * and remote sensing contrast enhancement techniques.
 */

export const STRETCH_MODES = {
  linear:  { name: 'Linear',      description: 'No transform' },
  sqrt:    { name: 'Square Root',  description: 'Enhance low values' },
  gamma:   { name: 'Gamma',       description: 'Adjustable power curve' },
  sigmoid: { name: 'Sigmoid',     description: 'S-curve, emphasize midtones' },
};

/**
 * Apply a stretch function to a normalized [0,1] value.
 *
 * Pipeline: raw → dB (optional) → normalize to [0,1] → applyStretch → colormap
 *
 * @param {number} value - Normalized input in [0, 1]
 * @param {string} mode - One of: 'linear', 'sqrt', 'gamma', 'sigmoid'
 * @param {number} gamma - Gamma exponent (default 1.0).
 *   For gamma mode: output = value^gamma. gamma < 1 brightens, gamma > 1 darkens.
 *   For sigmoid mode: gamma controls steepness (higher = steeper S-curve).
 * @returns {number} Stretched value in [0, 1]
 */
export function applyStretch(value, mode = 'linear', gamma = 1.0) {
  switch (mode) {
    case 'sqrt':
      return Math.sqrt(value);

    case 'gamma':
      return Math.pow(value, gamma);

    case 'sigmoid': {
      // Sigmoid centered at 0.5 with adjustable steepness
      const gain = gamma * 8;
      const raw = 1.0 / (1.0 + Math.exp(-gain * (value - 0.5)));
      // Normalize so endpoints map to [0, 1]
      const lo = 1.0 / (1.0 + Math.exp(gain * 0.5));
      const hi = 1.0 / (1.0 + Math.exp(-gain * 0.5));
      return Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
    }

    case 'linear':
    default:
      return value;
  }
}
