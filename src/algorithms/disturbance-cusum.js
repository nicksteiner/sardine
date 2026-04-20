/**
 * NISAR Disturbance ATBD — CUMSUM change-point detection with bootstrap
 * significance testing. Port of the JPL "NISAR Forest Disturbance Detection"
 * notebook (Brazilian forest time-series example).
 *
 * Algorithm:
 *   1. Compute per-pixel residuals r[k] = x[k] - mean(x) over the whole stack.
 *   2. Cumulative sum S[k] = sum_{j<=k} r[j].
 *   3. SDiff = max(S) - min(S) per pixel — large SDiff flags change points.
 *   4. Bootstrap: randomly permute the time axis n_bootstraps times, recompute
 *      Sdiff_random. Fraction of pixels where SDiff > Sdiff_random is the
 *      confidence — a pixel with confidence >= alpha (e.g. 0.95) is a disturbed
 *      candidate.
 *
 * Input:  Float32Array[] stack of polarization-filtered sigma0 (any band OK).
 * Output: { residuals, S, SDiff, confidence (0..1), disturbedMask }.
 *
 * Unlike the Disturbance ATBD notebook which uses dask+xarray, this runs in
 * plain arrays — suitable for browser or Node.
 */

export function subtractMean(stack, mask) {
  if (!stack.length) throw new Error('subtractMean: empty stack');
  const n = stack[0].length;
  const N = stack.length;
  const residuals = [];
  for (let k = 0; k < N; k++) residuals.push(new Float32Array(n));
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) {
      for (let k = 0; k < N; k++) residuals[k][i] = NaN;
      continue;
    }
    let s = 0;
    for (let k = 0; k < N; k++) s += stack[k][i];
    const m = s / N;
    for (let k = 0; k < N; k++) residuals[k][i] = stack[k][i] - m;
  }
  return residuals;
}

/**
 * Cumulative sum along the time axis. cumsum[k][i] = sum_{j<=k} residuals[j][i]
 */
export function cumsumTime(residuals) {
  const n = residuals[0].length;
  const N = residuals.length;
  const S = [];
  for (let k = 0; k < N; k++) {
    const frame = new Float32Array(n);
    if (k === 0) {
      for (let i = 0; i < n; i++) frame[i] = residuals[0][i];
    } else {
      const prev = S[k - 1];
      const curr = residuals[k];
      for (let i = 0; i < n; i++) frame[i] = prev[i] + curr[i];
    }
    S.push(frame);
  }
  return S;
}

/**
 * Per-pixel (max(S) - min(S)) along time axis.
 */
export function sdiff(S) {
  const n = S[0].length;
  const N = S.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    let allNan = true;
    for (let k = 0; k < N; k++) {
      const v = S[k][i];
      if (!Number.isFinite(v)) continue;
      allNan = false;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    out[i] = allNan ? NaN : (hi - lo);
  }
  return out;
}

/**
 * Fisher-Yates shuffle of indices 0..N-1 using an injected rng.
 */
export function shuffledIndices(N, rng = Math.random) {
  const arr = new Int32Array(N);
  for (let i = 0; i < N; i++) arr[i] = i;
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/**
 * Bootstrap: for n_bootstraps random time-axis permutations, compute Sdiff,
 * and count the fraction of permutations where the true SDiff exceeds the
 * random SDiff. Returns per-pixel confidence in [0, 1].
 */
export function bootstrapConfidence(residuals, trueSDiff, opts = {}) {
  const n_bootstraps = opts.n_bootstraps ?? 100;
  const rng = opts.rng ?? Math.random;
  const n = trueSDiff.length;
  const counts = new Int32Array(n);
  for (let b = 0; b < n_bootstraps; b++) {
    const perm = shuffledIndices(residuals.length, rng);
    // Plain Array — Int32Array.map can't hold Float32Array references.
    const permuted = Array.from(perm, (p) => residuals[p]);
    const Sb = cumsumTime(permuted);
    const Db = sdiff(Sb);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(trueSDiff[i]) && Number.isFinite(Db[i]) && trueSDiff[i] > Db[i]) {
        counts[i]++;
      }
    }
  }
  const conf = new Float32Array(n);
  for (let i = 0; i < n; i++) conf[i] = counts[i] / n_bootstraps;
  return conf;
}

/**
 * End-to-end CUMSUM disturbance detection with optional bootstrap.
 *
 * @param {Float32Array[]} stack
 * @param {object} [opts]
 * @param {Uint8Array} [opts.mask]
 * @param {number} [opts.sdiffThresholdPercentile=80] - if >0, threshold SDiff
 *   at this percentile to produce disturbedMask (skipped if opts.alpha set).
 * @param {number} [opts.alpha] - if provided, disturbedMask = confidence >= alpha
 * @param {number} [opts.n_bootstraps=100]
 * @param {function} [opts.rng=Math.random]
 */
export function runDisturbanceATBD(stack, opts = {}) {
  const residuals = subtractMean(stack, opts.mask);
  const S = cumsumTime(residuals);
  const SDiff = sdiff(S);

  let confidence = null;
  let disturbedMask = null;

  if (opts.alpha != null) {
    confidence = bootstrapConfidence(residuals, SDiff, opts);
    disturbedMask = new Uint8Array(confidence.length);
    for (let i = 0; i < confidence.length; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      disturbedMask[i] = confidence[i] >= opts.alpha ? 1 : 0;
    }
  } else if ((opts.sdiffThresholdPercentile ?? 80) > 0) {
    const pct = opts.sdiffThresholdPercentile ?? 80;
    const vals = [];
    for (let i = 0; i < SDiff.length; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      if (Number.isFinite(SDiff[i])) vals.push(SDiff[i]);
    }
    vals.sort((a, b) => a - b);
    const tau = vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * pct / 100)))];
    disturbedMask = new Uint8Array(SDiff.length);
    for (let i = 0; i < SDiff.length; i++) {
      if (opts.mask && !opts.mask[i]) continue;
      disturbedMask[i] = Number.isFinite(SDiff[i]) && SDiff[i] > tau ? 1 : 0;
    }
  }

  return { residuals, S, SDiff, confidence, disturbedMask };
}
