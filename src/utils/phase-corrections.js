/**
 * Phase Corrections for GUNW Interferograms
 *
 * Loads correction layers from NISAR GUNW products and computes
 * browser-side orbital ramp removal. All corrections are summed
 * into a single Float32Array for GPU subtraction.
 *
 * Available corrections (from GUNW product):
 *   - Ionosphere: ionospherePhaseScreen (alongside unwrappedPhase)
 *   - Troposphere wet: wetTroposphericPhaseScreen (radarGrid cube)
 *   - Troposphere hydrostatic: hydrostaticTroposphericPhaseScreen (radarGrid cube)
 *   - Solid Earth Tides: slantRangeSolidEarthTidesPhase (radarGrid cube)
 *
 * Computed corrections (MintPy-inspired):
 *   - Planar ramp: least-squares fit on high-coherence pixels
 *
 * Architecture: corrections are summed into one Float32Array,
 * uploaded as a single R32F texture, and subtracted in the
 * fragment shader: correctedPhase = rawPhase - correctionTexture
 */

import { loadMetadataCube } from './metadata-cube.js';

// ─── Ionosphere Correction ──────────────────────────────────────────────

/**
 * Load ionospherePhaseScreen from the GUNW unwrappedInterferogram group.
 * This dataset lives alongside unwrappedPhase at the same resolution.
 *
 * @param {Object} streamReader - h5chunk reader
 * @param {string} band - 'LSAR' or 'SSAR'
 * @param {string} frequency - 'A' or 'B'
 * @param {string} polarization - 'HH', 'VV', etc.
 * @returns {Promise<{data: Float32Array, width: number, height: number}|null>}
 */
export async function loadIonosphereCorrection(streamReader, band, frequency, polarization) {
  const path = `/science/${band}/GUNW/grids/frequency${frequency}/unwrappedInterferogram/${polarization}/ionospherePhaseScreen`;
  const dsId = streamReader.findDatasetByPath(path);
  if (dsId === null) {
    console.warn('[phase-corrections] Ionosphere dataset not found:', path);
    return null;
  }

  const datasets = streamReader.getDatasets();
  const meta = datasets.find(d => d.id === dsId);
  if (!meta?.shape || meta.shape.length < 2) return null;

  const [height, width] = meta.shape;
  try {
    const region = await streamReader.readRegion(dsId, 0, 0, height, width);
    const data = region.data || region;
    console.log(`[phase-corrections] Loaded ionosphere: ${width}x${height}`);
    return { data: new Float32Array(data), width, height };
  } catch (e) {
    console.warn('[phase-corrections] Failed to load ionosphere:', e.message);
    return null;
  }
}

// ─── Metadata Cube Corrections (troposphere, SET) ───────────────────────

/**
 * Load tropospheric and solid earth tide corrections from radarGrid metadata cubes.
 * These are coarse 3D grids that get interpolated to the full image extent.
 *
 * @param {Object} streamReader - h5chunk reader
 * @param {string} band - 'LSAR' or 'SSAR'
 * @param {Object} imageExtent - {bounds, width, height, xCoords, yCoords}
 * @returns {Promise<Object>} Dict of {fieldName: {data, width, height}} for available corrections
 */
export async function loadCubeCorrections(streamReader, band, imageExtent) {
  const cubeFields = [
    'wetTroposphericPhaseScreen',
    'hydrostaticTroposphericPhaseScreen',
    'slantRangeSolidEarthTidesPhase',
  ];

  const cube = await loadMetadataCube(streamReader, band, {
    product: 'GUNW',
    fields: cubeFields,
  });

  if (!cube) {
    console.warn('[phase-corrections] No radarGrid metadata cube found');
    return {};
  }

  const result = {};
  const { bounds, width, height } = imageExtent;
  const [bMinX, bMinY, bMaxX, bMaxY] = bounds;

  // Build coordinate arrays spanning the image (matching incidence angle loading)
  const evalWidth = Math.min(512, width);
  const evalHeight = Math.min(512, height);
  const xCoords = new Float64Array(evalWidth);
  const yCoords = new Float64Array(evalHeight);
  for (let i = 0; i < evalWidth; i++) xCoords[i] = bMinX + (i / (evalWidth - 1)) * (bMaxX - bMinX);
  for (let i = 0; i < evalHeight; i++) yCoords[i] = bMaxY - (i / (evalHeight - 1)) * (bMaxY - bMinY);

  for (const fieldName of cubeFields) {
    if (!cube.fields[fieldName]) continue;
    try {
      const grid = cube.evaluateOnGrid(fieldName, xCoords, yCoords, evalWidth, evalHeight, null, 4);
      // Convert Float64 cube values to Float32 for texture upload
      const f32 = new Float32Array(grid.length);
      for (let i = 0; i < grid.length; i++) f32[i] = grid[i];
      result[fieldName] = { data: f32, width: evalWidth, height: evalHeight };
      console.log(`[phase-corrections] Loaded ${fieldName}: ${evalWidth}x${evalHeight}`);
    } catch (e) {
      console.warn(`[phase-corrections] Failed to evaluate ${fieldName}:`, e.message);
    }
  }

  return result;
}

// ─── Planar Ramp Removal ────────────────────────────────────────────────

/**
 * Fit a planar ramp to phase data using high-coherence pixels.
 *
 * Model: phase(x, y) = a * x_norm + b * y_norm + c
 * where x_norm, y_norm are normalized to [0, 1] over the image extent.
 *
 * Solves the normal equations: (A^T A) coeffs = A^T b
 * using only pixels where coherence > threshold.
 *
 * @param {Float32Array} phaseData - Unwrapped phase values (height x width)
 * @param {Float32Array|null} coherenceData - Coherence values [0,1] (same dimensions)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} [options]
 * @param {number} [options.coherenceThreshold=0.7] - Min coherence for fitting
 * @param {number} [options.maxSamples=50000] - Max pixels for fitting (subsampled if larger)
 * @returns {{coefficients: {a: number, b: number, c: number}, ramp: Float32Array, nPixels: number}}
 */
export function fitPlanarRamp(phaseData, coherenceData, width, height, options = {}) {
  const {
    coherenceThreshold = 0.7,
    maxSamples = 50000,
  } = options;

  // Collect valid pixel coordinates and values
  const validPixels = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const phase = phaseData[idx];
      if (isNaN(phase) || phase === 0) continue;

      // Apply coherence mask if available
      if (coherenceData) {
        const coh = coherenceData[idx];
        if (isNaN(coh) || coh < coherenceThreshold) continue;
      }

      validPixels.push({ row, col, phase });
    }
  }

  if (validPixels.length < 10) {
    console.warn(`[phase-corrections] Too few valid pixels for ramp fit: ${validPixels.length}`);
    return { coefficients: { a: 0, b: 0, c: 0 }, ramp: new Float32Array(width * height), nPixels: 0 };
  }

  // Subsample if too many pixels (random selection for speed)
  let samples = validPixels;
  if (validPixels.length > maxSamples) {
    // Fisher-Yates partial shuffle
    samples = [];
    const indices = new Uint32Array(validPixels.length);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    for (let i = 0; i < maxSamples; i++) {
      const j = i + Math.floor(Math.random() * (indices.length - i));
      [indices[i], indices[j]] = [indices[j], indices[i]];
      samples.push(validPixels[indices[i]]);
    }
  }

  // Build normal equations for: phase = a * x_norm + b * y_norm + c
  // A^T A is 3x3, A^T b is 3x1
  let ata00 = 0, ata01 = 0, ata02 = 0;
  let ata11 = 0, ata12 = 0, ata22 = 0;
  let atb0 = 0, atb1 = 0, atb2 = 0;

  const invW = 1.0 / (width - 1 || 1);
  const invH = 1.0 / (height - 1 || 1);

  for (const { row, col, phase } of samples) {
    const x = col * invW;  // normalize to [0, 1]
    const y = row * invH;

    ata00 += x * x;
    ata01 += x * y;
    ata02 += x;
    ata11 += y * y;
    ata12 += y;
    ata22 += 1;

    atb0 += x * phase;
    atb1 += y * phase;
    atb2 += phase;
  }

  // Solve 3x3 system via Cramer's rule
  // | ata00 ata01 ata02 |   | a |   | atb0 |
  // | ata01 ata11 ata12 | × | b | = | atb1 |
  // | ata02 ata12 ata22 |   | c |   | atb2 |

  const det =
    ata00 * (ata11 * ata22 - ata12 * ata12) -
    ata01 * (ata01 * ata22 - ata12 * ata02) +
    ata02 * (ata01 * ata12 - ata11 * ata02);

  if (Math.abs(det) < 1e-20) {
    console.warn('[phase-corrections] Singular matrix in ramp fit');
    return { coefficients: { a: 0, b: 0, c: 0 }, ramp: new Float32Array(width * height), nPixels: samples.length };
  }

  const invDet = 1.0 / det;

  const a = invDet * (
    atb0 * (ata11 * ata22 - ata12 * ata12) -
    ata01 * (atb1 * ata22 - ata12 * atb2) +
    ata02 * (atb1 * ata12 - ata11 * atb2)
  );

  const b = invDet * (
    ata00 * (atb1 * ata22 - ata12 * atb2) -
    atb0 * (ata01 * ata22 - ata12 * ata02) +
    ata02 * (ata01 * atb2 - atb1 * ata02)
  );

  const c = invDet * (
    ata00 * (ata11 * atb2 - atb1 * ata12) -
    ata01 * (ata01 * atb2 - atb1 * ata02) +
    atb0 * (ata01 * ata12 - ata11 * ata02)
  );

  console.log(`[phase-corrections] Ramp fit: a=${a.toFixed(4)}, b=${b.toFixed(4)}, c=${c.toFixed(4)} ` +
    `(${samples.length} pixels, coh>${coherenceThreshold})`);

  // Generate ramp surface
  const ramp = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = row * invH;
    const rowOffset = row * width;
    for (let col = 0; col < width; col++) {
      const x = col * invW;
      ramp[rowOffset + col] = a * x + b * y + c;
    }
  }

  return { coefficients: { a, b, c }, ramp, nPixels: samples.length };
}

// ─── Combined Correction Builder ────────────────────────────────────────

/**
 * Correction layer identifiers (matches UI toggle keys).
 */
export const CORRECTION_TYPES = {
  ionosphere: { label: 'Ionosphere', source: 'dataset' },
  troposphereWet: { label: 'Troposphere (Wet)', source: 'cube' },
  troposphereHydrostatic: { label: 'Troposphere (Hydrostatic)', source: 'cube' },
  solidEarthTides: { label: 'Solid Earth Tides', source: 'cube' },
  planarRamp: { label: 'Planar Ramp', source: 'computed' },
};

/**
 * Map correction type keys to their radarGrid field names.
 */
const CUBE_FIELD_MAP = {
  troposphereWet: 'wetTroposphericPhaseScreen',
  troposphereHydrostatic: 'hydrostaticTroposphericPhaseScreen',
  solidEarthTides: 'slantRangeSolidEarthTidesPhase',
};

/**
 * Build a combined correction texture by summing enabled corrections.
 *
 * All correction layers are resampled to a common output size (typically
 * matching the image or a coarse GPU texture). The result is a single
 * Float32Array suitable for R32F texture upload.
 *
 * @param {Object} correctionLayers - {ionosphere, troposphereWet, ...} each {data, width, height}
 * @param {Set<string>} enabled - Set of enabled correction type keys
 * @param {number} outWidth - Output texture width
 * @param {number} outHeight - Output texture height
 * @returns {Float32Array} Combined correction values
 */
export function buildCombinedCorrection(correctionLayers, enabled, outWidth, outHeight) {
  const combined = new Float32Array(outWidth * outHeight);

  for (const key of enabled) {
    const layer = correctionLayers[key];
    if (!layer?.data) continue;

    const { data, width: srcW, height: srcH } = layer;

    if (srcW === outWidth && srcH === outHeight) {
      // Same size — direct addition
      for (let i = 0; i < combined.length; i++) {
        const v = data[i];
        if (!isNaN(v)) combined[i] += v;
      }
    } else {
      // Different size — bilinear resample during addition
      const scaleX = (srcW - 1) / (outWidth - 1 || 1);
      const scaleY = (srcH - 1) / (outHeight - 1 || 1);

      for (let row = 0; row < outHeight; row++) {
        const srcY = row * scaleY;
        const y0 = Math.floor(srcY);
        const y1 = Math.min(y0 + 1, srcH - 1);
        const wy = srcY - y0;

        for (let col = 0; col < outWidth; col++) {
          const srcX = col * scaleX;
          const x0 = Math.floor(srcX);
          const x1 = Math.min(x0 + 1, srcW - 1);
          const wx = srcX - x0;

          const v00 = data[y0 * srcW + x0];
          const v10 = data[y0 * srcW + x1];
          const v01 = data[y1 * srcW + x0];
          const v11 = data[y1 * srcW + x1];

          // NaN-aware bilinear
          let sum = 0, wsum = 0;
          if (!isNaN(v00)) { const w = (1 - wx) * (1 - wy); sum += w * v00; wsum += w; }
          if (!isNaN(v10)) { const w = wx * (1 - wy); sum += w * v10; wsum += w; }
          if (!isNaN(v01)) { const w = (1 - wx) * wy; sum += w * v01; wsum += w; }
          if (!isNaN(v11)) { const w = wx * wy; sum += w * v11; wsum += w; }

          if (wsum > 0) combined[row * outWidth + col] += sum / wsum;
        }
      }
    }
  }

  return combined;
}

/**
 * Load all available GUNW correction layers.
 *
 * Call this once after loading a GUNW dataset. Returns a dict of
 * correction layers keyed by CORRECTION_TYPES keys.
 *
 * @param {Object} streamReader - h5chunk reader
 * @param {string} band - 'LSAR' or 'SSAR'
 * @param {string} frequency - 'A' or 'B'
 * @param {string} polarization - 'HH', 'VV', etc.
 * @param {Object} imageExtent - {bounds, width, height}
 * @returns {Promise<Object>} {ionosphere, troposphereWet, troposphereHydrostatic, solidEarthTides}
 */
export async function loadAllCorrections(streamReader, band, frequency, polarization, imageExtent) {
  const result = {};

  // Ionosphere is loaded per-tile in the GUNW loader (same resolution as phase data).
  // Check if the dataset exists so we can report availability.
  const ionoPath = `/science/${band}/GUNW/grids/frequency${frequency}/unwrappedInterferogram/${polarization}/ionospherePhaseScreen`;
  const ionoDsId = streamReader.findDatasetByPath(ionoPath);
  if (ionoDsId !== null) {
    // Mark as available but don't load data — it's fetched per-tile
    result.ionosphere = { perTile: true, width: 0, height: 0, data: null };
  }

  // Load cube corrections (tropo + SET, coarse grid interpolated to ~512x512)
  const cubeCorrections = await loadCubeCorrections(streamReader, band, imageExtent);

  // Map cube fields to our correction type keys
  for (const [key, fieldName] of Object.entries(CUBE_FIELD_MAP)) {
    if (cubeCorrections[fieldName]) {
      result[key] = cubeCorrections[fieldName];
    }
  }

  const available = Object.keys(result);
  console.log(`[phase-corrections] Available corrections: [${available.join(', ')}]`);

  return result;
}
