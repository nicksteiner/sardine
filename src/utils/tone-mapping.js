/**
 * SAR Tone Mapping Module
 *
 * Makes SAR imagery visually interpretable for browser-based visualization.
 * Designed for integration with tile-serving pipelines (e.g., COG-based viewers).
 *
 * Operates on Float32Array or Uint8Array tile data.
 */

// ============================================================================
// CORE TONE MAPPING FUNCTIONS
// ============================================================================

/**
 * Adaptive logarithmic scaling
 * Handles SAR's huge dynamic range by computing scene-specific log parameters
 *
 * @param {Float32Array} data - Raw SAR amplitude values
 * @param {Object} options
 * @param {number} options.noDataValue - Value to treat as no-data (default: 0)
 * @param {number} options.pseudoLog - Small constant to avoid log(0) (default: auto)
 * @returns {Uint8Array} - 8-bit display-ready values
 */
function adaptiveLogScale(data, options = {}) {
  const { noDataValue = 0 } = options;

  // Compute statistics on valid pixels only
  const valid = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== noDataValue && data[i] > 0 && isFinite(data[i])) {
      valid.push(data[i]);
    }
  }

  if (valid.length === 0) {
    return new Uint8Array(data.length);
  }

  valid.sort((a, b) => a - b);

  // Use percentiles for robust min/max
  const p02 = valid[Math.floor(valid.length * 0.02)];
  const p98 = valid[Math.floor(valid.length * 0.98)];

  // Pseudo-log constant: small relative to data range
  const pseudoLog = options.pseudoLog ?? (p02 * 0.1 || 1e-6);

  const logMin = Math.log(p02 + pseudoLog);
  const logMax = Math.log(p98 + pseudoLog);
  const logRange = logMax - logMin || 1;

  const output = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    if (data[i] === noDataValue || data[i] <= 0 || !isFinite(data[i])) {
      output[i] = 0;
      continue;
    }

    const logVal = Math.log(data[i] + pseudoLog);
    const normalized = (logVal - logMin) / logRange;
    output[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  return output;
}


/**
 * Percentile stretch with gamma correction
 * Simple but effective for most scenes
 *
 * @param {Float32Array} data - Raw SAR amplitude values
 * @param {Object} options
 * @param {number} options.lowPercentile - Black point percentile (default: 0.02)
 * @param {number} options.highPercentile - White point percentile (default: 0.98)
 * @param {number} options.gamma - Gamma correction, <1 lifts shadows (default: 0.5)
 * @returns {Uint8Array}
 */
function percentileGammaStretch(data, options = {}) {
  const {
    lowPercentile = 0.02,
    highPercentile = 0.98,
    gamma = 0.5,
    noDataValue = 0
  } = options;

  const valid = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== noDataValue && isFinite(data[i])) {
      valid.push(data[i]);
    }
  }

  if (valid.length === 0) {
    return new Uint8Array(data.length);
  }

  valid.sort((a, b) => a - b);

  const minVal = valid[Math.floor(valid.length * lowPercentile)];
  const maxVal = valid[Math.floor(valid.length * highPercentile)];
  const range = maxVal - minVal || 1;

  const output = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    if (data[i] === noDataValue || !isFinite(data[i])) {
      output[i] = 0;
      continue;
    }

    // Linear stretch to 0-1
    let normalized = (data[i] - minVal) / range;
    normalized = Math.max(0, Math.min(1, normalized));

    // Gamma correction
    normalized = Math.pow(normalized, gamma);

    output[i] = Math.round(normalized * 255);
  }

  return output;
}


/**
 * Local contrast enhancement (simplified Reinhard-style)
 * Enhances local detail without blowing out bright areas
 *
 * @param {Float32Array} data - Raw SAR values
 * @param {number} width - Tile width in pixels
 * @param {number} height - Tile height in pixels
 * @param {Object} options
 * @param {number} options.kernelSize - Local neighborhood size (default: 16)
 * @param {number} options.strength - Enhancement strength 0-1 (default: 0.3)
 * @returns {Uint8Array}
 */
function localContrastEnhance(data, width, height, options = {}) {
  const {
    kernelSize = 16,
    strength = 0.3,
    noDataValue = 0
  } = options;

  // First pass: compute local means using box filter (separable for speed)
  const localMean = computeLocalMean(data, width, height, kernelSize, noDataValue);

  // Apply adaptive scaling based on local context
  const output = new Uint8Array(data.length);

  // Global stats for normalization
  let globalSum = 0;
  let globalCount = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== noDataValue && data[i] > 0 && isFinite(data[i])) {
      globalSum += data[i];
      globalCount++;
    }
  }
  const globalMean = globalSum / globalCount || 1;

  for (let i = 0; i < data.length; i++) {
    if (data[i] === noDataValue || data[i] <= 0 || !isFinite(data[i])) {
      output[i] = 0;
      continue;
    }

    const local = localMean[i] || globalMean;

    // Reinhard-style: scale by ratio of global to local
    // Blended with original based on strength
    const scaleFactor = 1 + strength * (globalMean / local - 1);
    const enhanced = data[i] * scaleFactor;

    // Log scale the result
    const logVal = Math.log(enhanced + 1);
    const logMax = Math.log(globalMean * 5 + 1); // rough expected max
    const normalized = logVal / logMax;

    output[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  return output;
}


/**
 * Box filter for local mean computation
 * Uses integral image for O(1) per-pixel regardless of kernel size
 */
function computeLocalMean(data, width, height, kernelSize, noDataValue) {
  // Build integral image
  const integral = new Float64Array(data.length);
  const counts = new Uint32Array(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const val = (data[i] !== noDataValue && isFinite(data[i])) ? data[i] : 0;
      const cnt = (data[i] !== noDataValue && isFinite(data[i])) ? 1 : 0;

      integral[i] = val;
      counts[i] = cnt;

      if (x > 0) {
        integral[i] += integral[i - 1];
        counts[i] += counts[i - 1];
      }
      if (y > 0) {
        integral[i] += integral[i - width];
        counts[i] += counts[i - width];
      }
      if (x > 0 && y > 0) {
        integral[i] -= integral[i - width - 1];
        counts[i] -= counts[i - width - 1];
      }
    }
  }

  // Compute local means
  const localMean = new Float32Array(data.length);
  const halfKernel = Math.floor(kernelSize / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      const x0 = Math.max(0, x - halfKernel) - 1;
      const y0 = Math.max(0, y - halfKernel) - 1;
      const x1 = Math.min(width - 1, x + halfKernel);
      const y1 = Math.min(height - 1, y + halfKernel);

      let sum = integral[y1 * width + x1];
      let cnt = counts[y1 * width + x1];

      if (x0 >= 0) {
        sum -= integral[y1 * width + x0];
        cnt -= counts[y1 * width + x0];
      }
      if (y0 >= 0) {
        sum -= integral[y0 * width + x1];
        cnt -= counts[y0 * width + x1];
      }
      if (x0 >= 0 && y0 >= 0) {
        sum += integral[y0 * width + x0];
        cnt += counts[y0 * width + x0];
      }

      localMean[i] = cnt > 0 ? sum / cnt : 0;
    }
  }

  return localMean;
}


// ============================================================================
// HYBRID / SMART TONE MAPPER
// ============================================================================

/**
 * Analyzes scene content and picks appropriate tone mapping parameters
 * This is where you'd plug in a learned model eventually
 *
 * @param {Float32Array} data
 * @returns {Object} Detected scene characteristics
 */
function analyzeScene(data, noDataValue = 0) {
  const valid = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== noDataValue && data[i] > 0 && isFinite(data[i])) {
      valid.push(data[i]);
    }
  }

  if (valid.length === 0) {
    return { type: 'empty', params: {} };
  }

  valid.sort((a, b) => a - b);

  const p10 = valid[Math.floor(valid.length * 0.1)];
  const p50 = valid[Math.floor(valid.length * 0.5)];
  const p90 = valid[Math.floor(valid.length * 0.9)];

  // Compute coefficient of variation
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  const cv = Math.sqrt(variance) / mean;

  // Dynamic range ratio
  const dynamicRange = p90 / p10;

  // Heuristic scene classification
  let sceneType;
  let params;

  if (dynamicRange > 100) {
    // High dynamic range: likely urban or mixed scene
    sceneType = 'urban';
    params = {
      method: 'adaptiveLog',
      gamma: 0.4,
      localContrast: 0.2
    };
  } else if (p50 < p10 * 2) {
    // Low median relative to low values: probably water-dominated
    sceneType = 'water';
    params = {
      method: 'percentileGamma',
      lowPercentile: 0.05,
      highPercentile: 0.95,
      gamma: 0.6
    };
  } else if (cv < 0.5) {
    // Low variation: relatively uniform (agriculture, desert)
    sceneType = 'uniform';
    params = {
      method: 'localContrast',
      strength: 0.4,
      gamma: 0.5
    };
  } else {
    // Default: mixed scene
    sceneType = 'mixed';
    params = {
      method: 'hybrid',
      gamma: 0.45,
      localContrast: 0.25
    };
  }

  return { type: sceneType, params, stats: { cv, dynamicRange, p10, p50, p90, mean } };
}


/**
 * Smart tone mapper that combines techniques based on scene analysis
 *
 * @param {Float32Array} data - Raw SAR amplitude
 * @param {number} width - Tile width
 * @param {number} height - Tile height
 * @param {Object} options - Override auto-detected params
 * @returns {Object} { image: Uint8Array, sceneInfo: Object }
 */
function smartToneMap(data, width, height, options = {}) {
  const noDataValue = options.noDataValue ?? 0;

  // Analyze scene unless params provided
  const analysis = options.skipAnalysis ? { params: options } : analyzeScene(data, noDataValue);
  const params = { ...analysis.params, ...options };

  let output;

  switch (params.method) {
    case 'adaptiveLog':
      output = adaptiveLogScale(data, { noDataValue });
      break;

    case 'percentileGamma':
      output = percentileGammaStretch(data, {
        noDataValue,
        lowPercentile: params.lowPercentile,
        highPercentile: params.highPercentile,
        gamma: params.gamma
      });
      break;

    case 'localContrast':
      output = localContrastEnhance(data, width, height, {
        noDataValue,
        strength: params.strength ?? 0.3
      });
      break;

    case 'hybrid':
    default:
      // Blend adaptive log with local contrast
      const base = adaptiveLogScale(data, { noDataValue });
      const local = localContrastEnhance(data, width, height, {
        noDataValue,
        strength: params.localContrast ?? 0.25
      });

      output = new Uint8Array(data.length);
      const blend = params.localBlend ?? 0.3;

      for (let i = 0; i < data.length; i++) {
        output[i] = Math.round(base[i] * (1 - blend) + local[i] * blend);
      }
      break;
  }

  // Optional final gamma adjustment
  if (params.finalGamma && params.finalGamma !== 1) {
    for (let i = 0; i < output.length; i++) {
      if (output[i] > 0) {
        output[i] = Math.round(255 * Math.pow(output[i] / 255, params.finalGamma));
      }
    }
  }

  return {
    image: output,
    sceneInfo: analysis
  };
}


// ============================================================================
// COLORIZATION
// ============================================================================

/**
 * Apply a color ramp to tone-mapped grayscale
 *
 * @param {Uint8Array} grayscale - 8-bit tone-mapped image
 * @param {string} palette - Color palette name
 * @returns {Uint8Array} - RGBA values (length = grayscale.length * 4)
 */
function applyColorRamp(grayscale, palette = 'viridis') {
  const lut = COLOR_RAMPS[palette] || COLOR_RAMPS.grayscale;
  const rgba = new Uint8Array(grayscale.length * 4);

  for (let i = 0; i < grayscale.length; i++) {
    const val = grayscale[i];
    const color = lut[val];
    const j = i * 4;
    rgba[j] = color[0];     // R
    rgba[j + 1] = color[1]; // G
    rgba[j + 2] = color[2]; // B
    rgba[j + 3] = val === 0 ? 0 : 255; // A (transparent for nodata)
  }

  return rgba;
}

// Pre-computed color lookup tables (256 entries each)
const COLOR_RAMPS = {
  grayscale: Array.from({ length: 256 }, (_, i) => [i, i, i]),

  // Warm grayscale - slightly easier on the eyes
  warmGray: Array.from({ length: 256 }, (_, i) => [
    Math.min(255, i + 5),
    i,
    Math.max(0, i - 10)
  ]),

  // Simple blue-white ramp good for water scenes
  blueWhite: Array.from({ length: 256 }, (_, i) => [
    Math.round(i * 0.8),
    Math.round(i * 0.9),
    i
  ]),

  // Viridis-ish (approximation)
  viridis: generateViridisLUT(),

  // High contrast for flood detection
  floodEmphasis: Array.from({ length: 256 }, (_, i) => {
    if (i < 50) return [0, 0, Math.round(i * 3)];        // Dark blue for water
    if (i < 100) return [0, Math.round((i - 50) * 4), 150]; // Cyan transition
    return [Math.round((i - 100) * 1.6), i, Math.round((255 - i) * 0.5)]; // Yellow-white for land
  })
};

function generateViridisLUT() {
  // Simplified viridis approximation
  const lut = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    lut.push([
      Math.round(255 * (0.267 + t * (0.329 + t * (-0.448 + t * 0.852)))),
      Math.round(255 * (0.004 + t * (0.873 + t * (-0.558 + t * 0.681)))),
      Math.round(255 * (0.329 + t * (0.694 + t * (-1.138 + t * 0.772))))
    ]);
  }
  return lut;
}


// ============================================================================
// EXPORTS
// ============================================================================

export {
  // Core functions
  adaptiveLogScale,
  percentileGammaStretch,
  localContrastEnhance,

  // Smart/combined
  analyzeScene,
  smartToneMap,

  // Colorization
  applyColorRamp,
  COLOR_RAMPS
};

// Default export for simple usage
export default smartToneMap;
