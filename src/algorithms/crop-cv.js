/**
 * NISAR Crop Area ATBD — port of JPL's "Coefficient of Variation" notebook.
 *
 * Idea: the temporal coefficient of variation (CV = sigma/mu) of a SAR stack
 * is higher over actively cultivated land than over persistent vegetation or
 * bare soil. The ATBD sweeps a CV threshold and picks the optimal split by
 * Youden's index on a reference truth mask (e.g. USDA CDL).
 *
 * Input:  Float32Array[] stack of co-registered sigma0 power frames.
 * Output: per-pixel CV, optional threshold, ROC curve, Youden-optimal thresh.
 */

export function meanStd(stack, mask) {
  if (!stack.length) throw new Error('meanStd: empty stack');
  const n = stack[0].length;
  const mean = new Float32Array(n);
  const std = new Float32Array(n);
  const N = stack.length;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) { mean[i] = NaN; std[i] = NaN; continue; }
    let s = 0;
    for (let k = 0; k < N; k++) s += stack[k][i];
    const m = s / N;
    mean[i] = m;
    let sq = 0;
    for (let k = 0; k < N; k++) {
      const d = stack[k][i] - m;
      sq += d * d;
    }
    // NumPy default is population std (ddof=0) — matches the notebook's np.std.
    std[i] = Math.sqrt(sq / N);
  }
  return { mean, std };
}

/**
 * Coefficient of variation per pixel: std/mean. NaN where mean is 0.
 */
export function coefficientOfVariation(stack, mask) {
  const { mean, std } = meanStd(stack, mask);
  const cv = new Float32Array(mean.length);
  for (let i = 0; i < cv.length; i++) {
    const m = mean[i];
    cv[i] = (m === 0 || !Number.isFinite(m)) ? NaN : std[i] / m;
  }
  return { cv, mean, std };
}

/**
 * 2x2 confusion matrix from binary prediction vs binary truth. Each input is a
 * same-length array of 0/1 (or boolean).
 */
export function confusionCounts(pred, truth, mask) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < pred.length; i++) {
    if (mask && !mask[i]) continue;
    const p = pred[i] ? 1 : 0;
    const t = truth[i] ? 1 : 0;
    if (p && t) tp++;
    else if (p && !t) fp++;
    else if (!p && t) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

export function accuracyStats({ tp, fp, fn, tn }) {
  const sens = (tp + fn) > 0 ? tp / (tp + fn) : NaN; // TPR
  const spec = (tn + fp) > 0 ? tn / (tn + fp) : NaN; // TNR
  const ppv = (tp + fp) > 0 ? tp / (tp + fp) : NaN;
  const npv = (tn + fn) > 0 ? tn / (tn + fn) : NaN;
  const total = tp + fp + fn + tn;
  const acc = total > 0 ? (tp + tn) / total : NaN;
  return { sensitivity: sens, specificity: spec, ppv, npv, accuracy: acc };
}

/**
 * Build an ROC curve by sweeping CV thresholds. For each threshold tau, a
 * pixel is classified "cropland" if CV > tau.
 *
 * @param {Float32Array} cv
 * @param {Uint8Array|Array} truth - 1 for cropland, 0 for non-cropland
 * @param {number[]} thresholds
 * @param {Uint8Array} [mask]
 * @returns {{thresholds, fpr, tpr, youdenJ, bestIndex, bestThreshold, auc}}
 */
export function rocCurve(cv, truth, thresholds, mask) {
  const fpr = new Float64Array(thresholds.length);
  const tpr = new Float64Array(thresholds.length);
  const youdenJ = new Float64Array(thresholds.length);
  for (let ti = 0; ti < thresholds.length; ti++) {
    const tau = thresholds[ti];
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let i = 0; i < cv.length; i++) {
      if (mask && !mask[i]) continue;
      const v = cv[i];
      if (!Number.isFinite(v)) continue;
      const p = v > tau ? 1 : 0;
      const t = truth[i] ? 1 : 0;
      if (p && t) tp++;
      else if (p && !t) fp++;
      else if (!p && t) fn++;
      else tn++;
    }
    const sens = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const spec = (tn + fp) > 0 ? tn / (tn + fp) : 0;
    tpr[ti] = sens;
    fpr[ti] = 1 - spec;
    youdenJ[ti] = sens - (1 - spec);
  }
  let bestIndex = 0;
  for (let i = 1; i < youdenJ.length; i++) {
    if (youdenJ[i] > youdenJ[bestIndex]) bestIndex = i;
  }
  // AUC via trapezoidal rule. Sort by fpr ascending with tpr-ascending tie-
  // breaker so degenerate plateaus don't collapse the curve. Prepend (0,0)
  // and append (1,1) as anchors — matches the usual sklearn convention and
  // keeps AUC well-defined when the threshold grid doesn't reach both limits.
  const order = Array.from(fpr.keys()).sort((a, b) => {
    if (fpr[a] !== fpr[b]) return fpr[a] - fpr[b];
    return tpr[a] - tpr[b];
  });
  const xs = [0, ...order.map((i) => fpr[i]), 1];
  const ys = [0, ...order.map((i) => tpr[i]), 1];
  let auc = 0;
  for (let i = 1; i < xs.length; i++) {
    auc += (xs[i] - xs[i - 1]) * (ys[i - 1] + ys[i]) / 2;
  }
  return {
    thresholds: Array.from(thresholds),
    fpr: Array.from(fpr),
    tpr: Array.from(tpr),
    youdenJ: Array.from(youdenJ),
    bestIndex,
    bestThreshold: thresholds[bestIndex],
    auc,
  };
}

export function defaultCVThresholds() {
  const out = new Float64Array(100);
  for (let i = 0; i < 100; i++) out[i] = i / 100;
  return Array.from(out);
}

/**
 * End-to-end ATBD: stack → CV → ROC sweep → Youden threshold → classified.
 * truth is optional; when omitted, returns just CV + mean/std.
 */
export function runCropCvATBD(stack, opts = {}) {
  const mask = opts.mask;
  const { cv, mean, std } = coefficientOfVariation(stack, mask);
  if (!opts.truth) return { cv, mean, std };
  const thresholds = opts.thresholds ?? defaultCVThresholds();
  const roc = rocCurve(cv, opts.truth, thresholds, mask);
  const cropMask = new Uint8Array(cv.length);
  const tau = roc.bestThreshold;
  for (let i = 0; i < cv.length; i++) {
    if (mask && !mask[i]) continue;
    cropMask[i] = Number.isFinite(cv[i]) && cv[i] > tau ? 1 : 0;
  }
  const confusion = confusionCounts(cropMask, opts.truth, mask);
  return { cv, mean, std, roc, cropMask, confusion, stats: accuracyStats(confusion) };
}
