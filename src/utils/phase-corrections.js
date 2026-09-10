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
import { debugLog } from './debug-log.js';

// ─── Metadata Cube Corrections (troposphere, SET) ───────────────────────
// (Ionosphere is loaded per-tile in nisar-gunw-loader.js, not here.)

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

  // Build coordinate arrays spanning the image (matching incidence angle loading).
  // Cap at 1024 samples per axis — on a large frame a 512 cap coarsens the
  // correction to ~15 km/sample, below the native radarGrid cube resolution.
  const evalWidth = Math.min(1024, width);
  const evalHeight = Math.min(1024, height);
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
      debugLog(`[phase-corrections] Loaded ${fieldName}: ${evalWidth}x${evalHeight}`);
    } catch (e) {
      console.warn(`[phase-corrections] Failed to evaluate ${fieldName}:`, e.message);
    }
  }

  return result;
}

/**
 * Correction layer identifiers (matches UI toggle keys).
 */
export const CORRECTION_TYPES = {
  ionosphere: { label: 'Ionosphere', source: 'dataset' },
  troposphereWet: { label: 'Troposphere (Wet)', source: 'cube' },
  troposphereHydrostatic: { label: 'Troposphere (Hydrostatic)', source: 'cube' },
  solidEarthTides: { label: 'Solid Earth Tides', source: 'cube' },
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
  debugLog(`[phase-corrections] Available corrections: [${available.join(', ')}]`);

  return result;
}
