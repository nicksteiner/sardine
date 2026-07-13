/**
 * trainer.js — dependency-free train/test for lightweight pixel classifiers (W025).
 *
 * Multinomial logistic regression on typed arrays: standardize features,
 * mini-batch gradient descent with momentum and L2, softmax cross-entropy.
 * At pixel-classifier scale (≤1e5 samples, ≤16 features, ≤8 classes) this
 * converges in milliseconds — no ML framework warranted (and the GPU audit
 * forbids TF.js/WebNN; neural inference belongs to W024's ONNX substrate).
 *
 * All randomness is seeded (mulberry32) so trained artifacts are reproducible:
 * same labels + same seed → bit-identical weights.
 */

/** Deterministic PRNG — same generator used across the ML modules. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of an index array, in place, seeded. */
export function shuffleIndices(n, rand) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx;
}

/**
 * Per-feature mean/std over row-major X (n × f). Constant features get
 * std=1 so standardization is a no-op rather than a divide-by-zero.
 */
export function computeStandardizer(X, n, f) {
  const mean = new Float64Array(f);
  const std = new Float64Array(f);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < f; j++) mean[j] += X[i * f + j];
  }
  for (let j = 0; j < f; j++) mean[j] /= n || 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < f; j++) {
      const d = X[i * f + j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < f; j++) {
    std[j] = Math.sqrt(std[j] / (n || 1));
    if (!(std[j] > 1e-12)) std[j] = 1;
  }
  return { mean: Array.from(mean), std: Array.from(std) };
}

/**
 * Train multinomial logistic regression.
 *
 * @param {Object} opts
 * @param {Float32Array|Float64Array} opts.X — row-major features, n × f
 * @param {Uint8Array|Int32Array|Array} opts.y — labels 0..C-1, length n
 * @param {number} opts.numClasses
 * @param {number} opts.numFeatures
 * @param {number} [opts.epochs=60]
 * @param {number} [opts.batchSize=256]
 * @param {number} [opts.learningRate=0.3]
 * @param {number} [opts.momentum=0.9]
 * @param {number} [opts.l2=1e-4]
 * @param {number} [opts.seed=1337]
 * @returns {{weights:number[], mean:number[], std:number[], numClasses:number,
 *            numFeatures:number, seed:number, history:{epoch:number,loss:number}[]}}
 *          weights layout: C × (f+1), bias last per class row.
 */
export function trainLogistic({
  X, y, numClasses, numFeatures,
  epochs = 60, batchSize = 256, learningRate = 0.3,
  momentum = 0.9, l2 = 1e-4, seed = 1337,
}) {
  const n = y.length;
  const f = numFeatures;
  const C = numClasses;
  if (!n || !f || C < 2) throw new Error('trainLogistic: need samples, features, and ≥2 classes');

  const { mean, std } = computeStandardizer(X, n, f);
  // Standardized copy (Float64 for stable accumulation)
  const Xs = new Float64Array(n * f);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < f; j++) Xs[i * f + j] = (X[i * f + j] - mean[j]) / std[j];
  }

  const W = new Float64Array(C * (f + 1)); // zeros — symmetric start is fine for softmax
  const V = new Float64Array(C * (f + 1)); // momentum buffer
  const rand = mulberry32(seed);
  const logits = new Float64Array(C);
  const probs = new Float64Array(C);
  const grad = new Float64Array(C * (f + 1));
  const history = [];

  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = shuffleIndices(n, rand);
    let epochLoss = 0;
    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(n, start + batchSize);
      const bs = end - start;
      grad.fill(0);
      for (let b = start; b < end; b++) {
        const i = order[b];
        // logits
        let maxL = -Infinity;
        for (let c = 0; c < C; c++) {
          let s = W[c * (f + 1) + f]; // bias
          for (let j = 0; j < f; j++) s += W[c * (f + 1) + j] * Xs[i * f + j];
          logits[c] = s;
          if (s > maxL) maxL = s;
        }
        // softmax
        let Z = 0;
        for (let c = 0; c < C; c++) { probs[c] = Math.exp(logits[c] - maxL); Z += probs[c]; }
        for (let c = 0; c < C; c++) probs[c] /= Z;
        epochLoss += -Math.log(Math.max(probs[y[i]], 1e-12));
        // grad accumulation: (p - 1[y=c]) * x
        for (let c = 0; c < C; c++) {
          const err = probs[c] - (y[i] === c ? 1 : 0);
          if (err === 0) continue;
          const row = c * (f + 1);
          for (let j = 0; j < f; j++) grad[row + j] += err * Xs[i * f + j];
          grad[row + f] += err;
        }
      }
      // momentum SGD step with L2 (bias excluded from decay)
      const lr = learningRate / bs;
      for (let c = 0; c < C; c++) {
        const row = c * (f + 1);
        for (let j = 0; j <= f; j++) {
          const g = grad[row + j] + (j < f ? l2 * W[row + j] * bs : 0);
          V[row + j] = momentum * V[row + j] - lr * g;
          W[row + j] += V[row + j];
        }
      }
    }
    history.push({ epoch, loss: epochLoss / n });
  }

  return {
    weights: Array.from(W), mean, std,
    numClasses: C, numFeatures: f, seed, history,
  };
}

/**
 * Predict labels (and optionally per-pixel max probability) for row-major X.
 * Invalid rows (any non-finite feature) get label 255.
 *
 * @returns {{labels: Uint8Array, confidence?: Float32Array}}
 */
export function predictLogistic(model, X, n, { withConfidence = false } = {}) {
  const { weights, mean, std, numClasses: C, numFeatures: f } = model;
  const labels = new Uint8Array(n);
  const confidence = withConfidence ? new Float32Array(n) : null;
  const logits = new Float64Array(C);
  for (let i = 0; i < n; i++) {
    let bad = false;
    for (let j = 0; j < f; j++) {
      if (!Number.isFinite(X[i * f + j])) { bad = true; break; }
    }
    if (bad) { labels[i] = 255; continue; }
    let best = 0, bestS = -Infinity, maxL = -Infinity;
    for (let c = 0; c < C; c++) {
      let s = weights[c * (f + 1) + f];
      for (let j = 0; j < f; j++) {
        s += weights[c * (f + 1) + j] * ((X[i * f + j] - mean[j]) / std[j]);
      }
      logits[c] = s;
      if (s > maxL) maxL = s;
      if (s > bestS) { bestS = s; best = c; }
    }
    labels[i] = best;
    if (confidence) {
      let Z = 0;
      for (let c = 0; c < C; c++) Z += Math.exp(logits[c] - maxL);
      confidence[i] = Math.exp(bestS - maxL) / Z;
    }
  }
  return confidence ? { labels, confidence } : { labels };
}

/**
 * Evaluate a trained model on a labeled set: accuracy, confusion matrix
 * (rows = truth, cols = predicted), per-class precision/recall/F1/IoU,
 * macro-F1 and mean IoU.
 */
export function evaluateModel(model, X, y, n) {
  const C = model.numClasses;
  const { labels } = predictLogistic(model, X, n);
  const confusion = Array.from({ length: C }, () => new Array(C).fill(0));
  let correct = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 255) continue;
    confusion[y[i]][labels[i]]++;
    if (labels[i] === y[i]) correct++;
  }
  const perClass = [];
  let f1Sum = 0, iouSum = 0;
  for (let c = 0; c < C; c++) {
    const tp = confusion[c][c];
    let fp = 0, fn = 0;
    for (let k = 0; k < C; k++) {
      if (k !== c) { fp += confusion[k][c]; fn += confusion[c][k]; }
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    const iou = tp + fp + fn ? tp / (tp + fp + fn) : 0;
    perClass.push({ precision, recall, f1, iou });
    f1Sum += f1; iouSum += iou;
  }
  return {
    accuracy: n ? correct / n : 0,
    confusion,
    perClass,
    macroF1: C ? f1Sum / C : 0,
    meanIoU: C ? iouSum / C : 0,
    n,
  };
}
