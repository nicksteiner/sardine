/**
 * Run a NISAR ecosystem ATBD against an already-loaded time-series of tiles.
 *
 * The app loads an ROI time-series via handleLoadRoiTimeSeries → each frame
 * carries a `getTile({bbox})` that streams a Float32Array (or per-pol bands)
 * from the underlying NISAR GCOV product. This module pulls a single fixed
 * tile at the ROI's world bounds from every frame, stacks the arrays, and
 * dispatches to the pure algorithm implementations under src/algorithms/.
 *
 * The result is a ClassificationResult (see below) that app/main.jsx feeds to
 * ClassificationOverlay for display and to writeRGBAGeoTIFF for export.
 */

import { runInundationATBD, INUNDATION_MASKED_VALUE } from '../algorithms/inundation.js';
import { runCropCvATBD } from '../algorithms/crop-cv.js';
import { runDisturbanceATBD } from '../algorithms/disturbance-cusum.js';
import { ATBD_PALETTES } from './atbd-palettes.js';

/** @typedef {Object} ClassificationResult
 *  @property {'inundation'|'crop'|'disturbance'} algorithm
 *  @property {Uint8Array} classMap      per-pixel class (1 for binary palette,
 *                                       0..5 + INUNDATION_MASKED_VALUE for inundation)
 *  @property {number} width
 *  @property {number} height
 *  @property {number[]} bounds          [minX,minY,maxX,maxY] world coords
 *  @property {ReadonlyArray<ReadonlyArray<number>>} palette
 *  @property {ReadonlyArray<string>} classLabels
 *  @property {Object} metadata          algorithm-specific extras (threshold, etc.)
 */

/**
 * Pull one tile per frame covering the ROI bounds and return a stack of
 * Float32Array views keyed by polarization. For single-pol frames, the tile
 * is stored under the frame's own polarization name.
 *
 * @param {Array} frames - roiTSFrames
 * @param {number[]} bounds - [minX, minY, maxX, maxY] world coords
 * @param {function} [onProgress] - (frameIdx, totalFrames) => void
 * @returns {Promise<{pols: Record<string, Float32Array[]>, width: number, height: number}>}
 */
async function readStackAtBounds(frames, bounds, onProgress) {
  const [minX, minY, maxX, maxY] = bounds;
  const bbox = { left: minX, top: minY, right: maxX, bottom: maxY };
  const pols = {};
  let width = 0;
  let height = 0;
  for (let fi = 0; fi < frames.length; fi++) {
    if (onProgress) onProgress(fi, frames.length);
    const tile = await frames[fi].getTile({ x: 0, y: 0, z: 0, bbox });
    if (!tile) throw new Error(`frame ${fi} returned no tile`);
    const tw = tile.width;
    const th = tile.height;
    if (fi === 0) { width = tw; height = th; }
    else if (tw !== width || th !== height) {
      throw new Error(
        `frame ${fi} tile size ${tw}x${th} differs from first frame ${width}x${height}`
      );
    }
    if (tile.bands) {
      for (const [pol, data] of Object.entries(tile.bands)) {
        if (!pols[pol]) pols[pol] = [];
        pols[pol].push(data);
      }
    } else if (tile.data) {
      const polKey = frames[fi].requiredPols?.[0] || 'band0';
      if (!pols[polKey]) pols[polKey] = [];
      pols[polKey].push(tile.data);
    } else {
      throw new Error(`frame ${fi} tile missing bands/data`);
    }
  }
  return { pols, width, height };
}

/**
 * @param {Array} frames - roiTSFrames
 * @param {number[]} bounds - ROI world bounds
 * @param {Object} opts
 * @param {'inundation'|'crop'|'disturbance'} opts.algorithm
 * @param {string} [opts.polarization] - for crop/disturbance single-band path
 * @param {number} [opts.Nave=2] - inundation rolling window
 * @param {number} [opts.sdiffThresholdPercentile=80] - disturbance threshold pct
 * @param {number} [opts.cvThreshold] - crop-cv manual threshold; default 0.25
 * @param {function} [opts.onProgress]
 * @returns {Promise<ClassificationResult>}
 */
export async function runATBD(frames, bounds, opts) {
  if (!frames || frames.length === 0) throw new Error('runATBD: empty frames');
  if (!bounds || bounds.length !== 4) throw new Error('runATBD: bounds required');
  const { algorithm, onProgress } = opts;
  const { pols, width, height } = await readStackAtBounds(frames, bounds, onProgress);

  if (algorithm === 'inundation') {
    // Inundation needs HH and HV. Look up by common NISAR GCOV naming.
    const hhStack = pols.HHHH || pols.HH;
    const hvStack = pols.HVHV || pols.HV || pols.VHVH;
    if (!hhStack || !hvStack) {
      const have = Object.keys(pols).join(', ') || 'none';
      throw new Error(
        `Inundation needs HH and HV power stacks; time-series bands present: ${have}. ` +
        `Load a dual-pol RGB composite (e.g. "dual-pol-h") so each frame carries HHHH + HVHV.`
      );
    }
    if (hhStack.length < 2 || hvStack.length < 2) {
      throw new Error(`Inundation needs >=2 frames per pol; got HH=${hhStack.length}, HV=${hvStack.length}`);
    }
    const Nave = Math.max(1, Math.min(opts.Nave ?? 2, hhStack.length));
    const res = runInundationATBD(hhStack, hvStack, { Nave });
    // The notebook classifies each corrected frame independently. Use the last
    // corrected frame by default — it reflects the most recent observation
    // after the rolling correction. This matches the notebook's
    // "corrected_images[-1]" convention used in its figure output.
    const classMap = res.classifications[res.classifications.length - 1];
    const { palette, labels } = ATBD_PALETTES.inundation;
    return {
      algorithm,
      classMap,
      width,
      height,
      bounds,
      palette,
      classLabels: labels,
      metadata: {
        Nave,
        numFrames: hhStack.length,
        numClassified: res.classifications.length,
        frameIndex: res.classifications.length - 1,
        maskedValue: INUNDATION_MASKED_VALUE,
      },
    };
  }

  if (algorithm === 'crop') {
    const polKey = opts.polarization || Object.keys(pols)[0];
    const stack = pols[polKey];
    if (!stack || stack.length < 2) {
      throw new Error(`Crop CV needs >=2 frames for "${polKey}"; got ${stack?.length ?? 0}`);
    }
    const tau = opts.cvThreshold ?? 0.25;
    const res = runCropCvATBD(stack);
    const classMap = new Uint8Array(res.cv.length);
    for (let i = 0; i < res.cv.length; i++) {
      classMap[i] = Number.isFinite(res.cv[i]) && res.cv[i] > tau ? 1 : 0;
    }
    const { palette, labels } = ATBD_PALETTES.crop;
    return {
      algorithm,
      classMap,
      width,
      height,
      bounds,
      palette,
      classLabels: labels,
      metadata: {
        polarization: polKey,
        threshold: tau,
        numFrames: stack.length,
      },
    };
  }

  if (algorithm === 'disturbance') {
    const polKey = opts.polarization || Object.keys(pols)[0];
    const stack = pols[polKey];
    if (!stack || stack.length < 3) {
      throw new Error(`Disturbance needs >=3 frames for "${polKey}"; got ${stack?.length ?? 0}`);
    }
    const pct = opts.sdiffThresholdPercentile ?? 80;
    const res = runDisturbanceATBD(stack, { sdiffThresholdPercentile: pct });
    const { palette, labels } = ATBD_PALETTES.disturbance;
    return {
      algorithm,
      classMap: res.disturbedMask,
      width,
      height,
      bounds,
      palette,
      classLabels: labels,
      metadata: {
        polarization: polKey,
        sdiffThresholdPercentile: pct,
        numFrames: stack.length,
      },
    };
  }

  throw new Error(`runATBD: unknown algorithm "${algorithm}"`);
}

export const ATBD_ALGORITHMS = Object.freeze([
  { id: 'inundation',  name: 'Inundation (6-class)',  minFrames: 2, needsDualPol: true  },
  { id: 'crop',        name: 'Crop Area (CV mask)',   minFrames: 2, needsDualPol: false },
  { id: 'disturbance', name: 'Disturbance (CUSUM)',   minFrames: 3, needsDualPol: false },
]);
