/**
 * NISAR Inundation ATBD — port of JPL's 2021 "NISAR Inundation Notebook"
 *
 * Input: temporal stack of co-registered HH and HV power images (sigma0, linear).
 * Output: per-image, per-pixel class (0..5) + a non-classified value (10).
 *
 * Pipeline (from notebook):
 *   1. Mask zero/NaN pixels across the full stack.
 *   2. Compute long-term mean(HH), mean(HV).
 *   3. Rolling-mean the stack with window Nave_rolling (default 2) and derive
 *      a per-image correction factor f = mean(roll[k]) / mean(mean_stack).
 *   4. Apply correction: corr[k] = raw[k + Nave_rolling - 1] / f[k].
 *   5. ratio[k] = corr_HH[k] / corr_HV[k].
 *   6. Assign class based on (ratio, HH) thresholds:
 *        0 inundated vegetation 1
 *        1 inundated vegetation 2
 *        2 open water 1
 *        3 open water 2
 *        4 not inundated
 *        5 not classified
 *       10 masked/invalid
 */

export const DEFAULT_INUNDATION_THRESHOLDS = Object.freeze({
  class0: { ratioMin: 1.0, ratioMax: 15.0, hhMin: 0.5, hhMax: 20.0 },
  class1: { ratioMin: 1.0, ratioMax: 15.0, hhMin: 0.5, hhMax: 20.0 },
  class2: { ratioMin: 1.0, ratioMax: 15.0, hhMin: 0.0001, hhMax: 1.0 },
  class3: { ratioMin: 1.0, ratioMax: 15.0, hhMin: 0.0001, hhMax: 0.01 },
  class4: { ratioMin: 1.0, ratioMax: 15.0, hhMin: 0.05, hhMax: 1.0 },
  class5: { ratioMin: 0.0, ratioMax: 15.0, hhMin: 0.0, hhMax: 0.5 },
});

export const INUNDATION_CLASS_NAMES = Object.freeze([
  'inundated_vegetation_1',
  'inundated_vegetation_2',
  'open_water_1',
  'open_water_2',
  'not_inundated',
  'not_classified',
]);

export const INUNDATION_MASKED_VALUE = 10;

function isBad(v) {
  return v == null || Number.isNaN(v) || !Number.isFinite(v) || v <= 0;
}

/**
 * Compute a mask (1 where all images at that pixel are > 0 and finite, 0 else)
 * @param {Float32Array[]} stack - N frames each of length width*height
 * @returns {Uint8Array}
 */
export function computeStackMask(stack) {
  if (!stack.length) throw new Error('computeStackMask: empty stack');
  const n = stack[0].length;
  const mask = new Uint8Array(n);
  mask.fill(1);
  for (let k = 0; k < stack.length; k++) {
    const img = stack[k];
    if (img.length !== n) {
      throw new Error(`computeStackMask: frame ${k} length mismatch`);
    }
    for (let i = 0; i < n; i++) {
      if (mask[i] && isBad(img[i])) mask[i] = 0;
    }
  }
  return mask;
}

/**
 * Per-pixel temporal mean (NaN/zero treated as invalid → skipped).
 * @param {Float32Array[]} stack
 * @param {Uint8Array} mask - pixels with mask==0 get NaN
 */
export function meanStack(stack, mask) {
  const n = stack[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) { out[i] = NaN; continue; }
    let s = 0;
    for (let k = 0; k < stack.length; k++) s += stack[k][i];
    out[i] = s / stack.length;
  }
  return out;
}

/**
 * Rolling-window temporal mean. Output length = N - Nave_rolling + 1. For each
 * output index kk, averages input frames (kk..kk+Nave_rolling-1). Matches the
 * notebook: "the rolling average for image 0 contains images 0, 1, ... ".
 * @param {Float32Array[]} stack
 * @param {number} Nave
 * @returns {Float32Array[]}
 */
export function rollingMeanStack(stack, Nave) {
  if (Nave < 1) throw new Error('rollingMeanStack: Nave must be >= 1');
  const N = stack.length;
  const Nout = N - Nave + 1;
  if (Nout < 1) throw new Error('rollingMeanStack: stack shorter than window');
  const pixels = stack[0].length;
  const out = [];
  for (let kk = 0; kk < Nout; kk++) {
    const frame = new Float32Array(pixels);
    for (let j = 0; j < Nave; j++) {
      const src = stack[kk + j];
      for (let i = 0; i < pixels; i++) frame[i] += src[i] / Nave;
    }
    out.push(frame);
  }
  return out;
}

function nanmean(arr, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (mask && !mask[i]) continue;
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    s += v; n++;
  }
  return n > 0 ? s / n : NaN;
}

/**
 * Compute per-image correction factors: rolling-mean scene average divided by
 * the long-term scene mean.
 * @param {Float32Array[]} rolling
 * @param {number} longTermMean - nanmean of meanStack for the polarization
 * @param {Uint8Array} mask
 */
export function correctionFactors(rolling, longTermMean, mask) {
  const out = new Float32Array(rolling.length);
  for (let kk = 0; kk < rolling.length; kk++) {
    out[kk] = nanmean(rolling[kk], mask) / longTermMean;
  }
  return out;
}

/**
 * Apply per-image correction factor to the raw stack.
 * Output frame kk corresponds to raw frame kk + Nave - 1 (drops leading frames).
 */
export function applyCorrection(stack, factors, Nave) {
  const pixels = stack[0].length;
  const Nout = factors.length;
  const out = [];
  for (let kk = 0; kk < Nout; kk++) {
    const src = stack[kk + Nave - 1];
    const f = factors[kk];
    const frame = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) frame[i] = src[i] / f;
    out.push(frame);
  }
  return out;
}

/**
 * Per-pixel classification for one image pair (HH, HV corrected).
 * Returns Uint8Array with values 0..5 or INUNDATION_MASKED_VALUE (10).
 *
 * Matches the notebook: classes are assigned in order 5, 4, 3, 2, 1, 0 so that
 * the lowest-numbered class "wins" when multiple thresholds match. Pixels with
 * no matching threshold and mask==1 default to INUNDATION_MASKED_VALUE.
 */
export function classifyPair(hh, hv, mask, thresholds = DEFAULT_INUNDATION_THRESHOLDS) {
  const n = hh.length;
  if (hv.length !== n || mask.length !== n) {
    throw new Error('classifyPair: length mismatch');
  }
  const out = new Uint8Array(n);
  out.fill(INUNDATION_MASKED_VALUE);
  const order = ['class5', 'class4', 'class3', 'class2', 'class1', 'class0'];
  const classIdx = { class0: 0, class1: 1, class2: 2, class3: 3, class4: 4, class5: 5 };
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const hhVal = hh[i], hvVal = hv[i];
    if (!Number.isFinite(hhVal) || !Number.isFinite(hvVal) || hvVal === 0) continue;
    const ratio = hhVal / hvVal;
    for (const key of order) {
      const t = thresholds[key];
      if (ratio > t.ratioMin && ratio <= t.ratioMax &&
          hhVal > t.hhMin && hhVal <= t.hhMax) {
        out[i] = classIdx[key];
      }
    }
  }
  return out;
}

/**
 * Full pipeline. Returns { classifications, correctedHH, correctedHV, ratio,
 * mask, factors, meanHH, meanHV }.
 *
 * @param {Float32Array[]} stackHH
 * @param {Float32Array[]} stackHV
 * @param {object} [opts]
 * @param {number} [opts.Nave=2]
 * @param {object} [opts.thresholds=DEFAULT_INUNDATION_THRESHOLDS]
 */
export function runInundationATBD(stackHH, stackHV, opts = {}) {
  const Nave = opts.Nave ?? 2;
  const thresholds = opts.thresholds ?? DEFAULT_INUNDATION_THRESHOLDS;
  if (stackHH.length !== stackHV.length) {
    throw new Error('runInundationATBD: HH and HV stack lengths must match');
  }
  const maskHH = computeStackMask(stackHH);
  const maskHV = computeStackMask(stackHV);
  const mask = new Uint8Array(maskHH.length);
  for (let i = 0; i < mask.length; i++) mask[i] = (maskHH[i] & maskHV[i]);

  const meanHH = meanStack(stackHH, mask);
  const meanHV = meanStack(stackHV, mask);
  const longHH = nanmean(meanHH, mask);
  const longHV = nanmean(meanHV, mask);

  const rollHH = rollingMeanStack(stackHH, Nave);
  const rollHV = rollingMeanStack(stackHV, Nave);
  const factorsHH = correctionFactors(rollHH, longHH, mask);
  const factorsHV = correctionFactors(rollHV, longHV, mask);

  const corrHH = applyCorrection(stackHH, factorsHH, Nave);
  const corrHV = applyCorrection(stackHV, factorsHV, Nave);

  const classifications = [];
  const ratio = [];
  for (let kk = 0; kk < corrHH.length; kk++) {
    const ratioFrame = new Float32Array(corrHH[kk].length);
    for (let i = 0; i < ratioFrame.length; i++) {
      ratioFrame[i] = corrHV[kk][i] === 0 ? NaN : corrHH[kk][i] / corrHV[kk][i];
    }
    ratio.push(ratioFrame);
    classifications.push(classifyPair(corrHH[kk], corrHV[kk], mask, thresholds));
  }

  return {
    classifications, correctedHH: corrHH, correctedHV: corrHV, ratio,
    mask, factorsHH, factorsHV, meanHH, meanHV,
  };
}
