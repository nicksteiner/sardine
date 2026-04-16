/**
 * SAR image stretch/enhancement modes.
 * Applied after normalization to [0,1] and before colormap mapping.
 *
 * Inspired by medical imaging (DICOM Window/Level, gamma correction)
 * and remote sensing contrast enhancement techniques.
 */

export const STRETCH_MODES = {
  linear:   { name: 'Linear',      description: 'No transform' },
  sqrt:     { name: 'Square Root',  description: 'Enhance low values' },
  cbrt:     { name: 'Cube Root',    description: 'Mild low-value enhancement (SAR backscatter)' },
  log:      { name: 'Logarithmic', description: 'Strong low-value enhancement (SAR speckle)' },
  gamma:    { name: 'Gamma',       description: 'Adjustable power curve' },
  sigmoid:  { name: 'Sigmoid',     description: 'S-curve, emphasize midtones' },
};

/**
 * Apply a stretch function to a normalized [0,1] value.
 *
 * Pipeline: raw → dB (optional) → normalize to [0,1] → applyStretch → colormap
 *
 * @param {number} value - Normalized input in [0, 1]
 * @param {string} mode - One of: 'linear', 'sqrt', 'cbrt', 'log', 'gamma', 'sigmoid'
 * @param {number} gamma - Gamma exponent (default 1.0).
 *   For gamma mode: output = value^gamma. gamma < 1 brightens, gamma > 1 darkens.
 *   For sigmoid mode: gamma controls steepness (higher = steeper S-curve).
 * @returns {number} Stretched value in [0, 1]
 */
export function applyStretch(value, mode = 'linear', gamma = 1.0) {
  switch (mode) {
    case 'sqrt':
      return Math.sqrt(value);

    case 'cbrt':
      return Math.cbrt(value);

    case 'log':
      // Logarithmic stretch: strong enhancement of low values.
      // Maps [0,1] → [0,1] via log(1 + k*x) / log(1 + k), k controlled by gamma.
      // Default gamma=1.0 gives k=100 (strong compression). Higher gamma = stronger.
      {
        const k = Math.pow(10, 1 + gamma);
        return Math.log(1 + k * value) / Math.log(1 + k);
      }

    case 'gamma':
      return Math.pow(value, gamma);

    case 'sigmoid': {
      const gain = gamma * 8;
      if (gain === 0) return value;
      const raw = 1.0 / (1.0 + Math.exp(-gain * (value - 0.5)));
      const lo = 1.0 / (1.0 + Math.exp(gain * 0.5));
      const hi = 1.0 / (1.0 + Math.exp(-gain * 0.5));
      const denom = hi - lo;
      if (denom === 0) return value;
      return Math.max(0, Math.min(1, (raw - lo) / denom));
    }

    case 'linear':
    default:
      return value;
  }
}

/**
 * Build a closure that applies a stretch with its mode-constants pre-computed.
 *
 * For hot per-pixel loops (createRGBTexture, histogram rendering) this avoids
 * recomputing `Math.log(1+k)` (log mode) or `lo/hi` sigmoid boundaries on
 * every call. The returned function takes the raw [0,1] value and returns
 * the stretched value.
 *
 * For `linear` and `gamma` modes there are no hoistable constants, so the
 * returned function is a thin wrapper — still correct, just not faster.
 *
 * @param {string} mode - Stretch mode
 * @param {number} gamma - Gamma / steepness parameter
 * @returns {(value: number) => number} Stretch function closure
 */
export function createStretchFn(mode = 'linear', gamma = 1.0) {
  switch (mode) {
    case 'sqrt':
      return (v) => Math.sqrt(v);

    case 'cbrt':
      return (v) => Math.cbrt(v);

    case 'log': {
      const k = Math.pow(10, 1 + gamma);
      const invLog = 1.0 / Math.log(1 + k);
      return (v) => Math.log(1 + k * v) * invLog;
    }

    case 'gamma':
      return (v) => Math.pow(v, gamma);

    case 'sigmoid': {
      const gain = gamma * 8;
      if (gain === 0) return (v) => v;
      const lo = 1.0 / (1.0 + Math.exp(gain * 0.5));
      const hi = 1.0 / (1.0 + Math.exp(-gain * 0.5));
      const denom = hi - lo;
      if (denom === 0) return (v) => v;
      const invDenom = 1.0 / denom;
      return (v) => {
        const raw = 1.0 / (1.0 + Math.exp(-gain * (v - 0.5)));
        const out = (raw - lo) * invDenom;
        return out < 0 ? 0 : (out > 1 ? 1 : out);
      };
    }

    case 'linear':
    default:
      return (v) => v;
  }
}
