/**
 * dataset.js — labeled sample extraction + stratified train/test split (W025).
 *
 * Turns analyst markup into training data. First source: the scatter
 * classifier's feature-space rectangles (`classRegions` over the two band
 * features in `classifierData`) — every valid pixel inside exactly the
 * region's bounds gets that region's label. Ambiguous pixels (inside more
 * than one region) are dropped: conflicting labels teach nothing.
 */

import { mulberry32, shuffleIndices } from './trainer.js';

/**
 * Build a labeled dataset from scatter-classifier regions.
 *
 * @param {{x: Float32Array, y: Float32Array, valid: Uint8Array}} classifierData
 *        Two per-pixel feature bands (dB), as built for ScatterClassifier.
 * @param {Array<{name:string,color:string,xMin:number,xMax:number,yMin:number,yMax:number}>} classRegions
 * @param {Object} [opts]
 * @param {number} [opts.maxPerClass=20000] — cap samples per class (seeded reservoir)
 * @param {number} [opts.seed=1337]
 * @returns {{X: Float32Array, y: Uint8Array, n: number, numFeatures: 2,
 *            numClasses: number, counts: number[], dropped: number}}
 */
export function datasetFromClassRegions(classifierData, classRegions, opts = {}) {
  const { maxPerClass = 20000, seed = 1337 } = opts;
  const { x, y, valid } = classifierData;
  const C = classRegions.length;
  if (C < 2) throw new Error('datasetFromClassRegions: need ≥2 class regions');

  // First pass: label every pixel (255 = unlabeled, 254 = ambiguous)
  const n0 = x.length;
  const label = new Uint8Array(n0).fill(255);
  let dropped = 0;
  for (let i = 0; i < n0; i++) {
    if (valid && !valid[i]) continue;
    const xv = x[i], yv = y[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    let hit = -1;
    for (let c = 0; c < C; c++) {
      const r = classRegions[c];
      if (xv >= r.xMin && xv <= r.xMax && yv >= r.yMin && yv <= r.yMax) {
        if (hit >= 0) { hit = -2; break; } // ambiguous
        hit = c;
      }
    }
    if (hit === -2) { label[i] = 254; dropped++; }
    else if (hit >= 0) label[i] = hit;
  }

  // Second pass: seeded reservoir sample per class up to maxPerClass
  const rand = mulberry32(seed);
  const kept = Array.from({ length: C }, () => []);
  const seen = new Array(C).fill(0);
  for (let i = 0; i < n0; i++) {
    const c = label[i];
    if (c >= C) continue;
    seen[c]++;
    if (kept[c].length < maxPerClass) {
      kept[c].push(i);
    } else {
      const j = Math.floor(rand() * seen[c]);
      if (j < maxPerClass) kept[c][j] = i;
    }
  }

  const counts = kept.map(k => k.length);
  const n = counts.reduce((a, b) => a + b, 0);
  if (counts.some(c => c === 0)) {
    const empty = classRegions.filter((_, c) => counts[c] === 0).map(r => r.name);
    throw new Error(`No valid pixels inside region(s): ${empty.join(', ')}`);
  }

  const X = new Float32Array(n * 2);
  const yOut = new Uint8Array(n);
  let k = 0;
  for (let c = 0; c < C; c++) {
    for (const i of kept[c]) {
      X[k * 2] = x[i];
      X[k * 2 + 1] = y[i];
      yOut[k] = c;
      k++;
    }
  }
  return { X, y: yOut, n, numFeatures: 2, numClasses: C, counts, dropped };
}

/**
 * Stratified, seeded train/test split: each class contributes testFraction
 * of its samples to the test set (at least 1 when the class has ≥2 samples).
 *
 * @returns {{train: {X,y,n}, test: {X,y,n}}}
 */
export function stratifiedSplit({ X, y, n, numFeatures: f, numClasses: C }, { testFraction = 0.25, seed = 1337 } = {}) {
  if (!(testFraction > 0 && testFraction < 1)) throw new Error('testFraction must be in (0,1)');
  const rand = mulberry32(seed);
  const byClass = Array.from({ length: C }, () => []);
  for (let i = 0; i < n; i++) byClass[y[i]].push(i);

  const trainIdx = [];
  const testIdx = [];
  for (let c = 0; c < C; c++) {
    const ids = byClass[c];
    const order = shuffleIndices(ids.length, rand);
    const nTest = ids.length >= 2 ? Math.max(1, Math.round(ids.length * testFraction)) : 0;
    for (let k = 0; k < ids.length; k++) {
      (k < nTest ? testIdx : trainIdx).push(ids[order[k]]);
    }
  }

  const pack = (idx) => {
    const Xp = new Float32Array(idx.length * f);
    const yp = new Uint8Array(idx.length);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      for (let j = 0; j < f; j++) Xp[k * f + j] = X[i * f + j];
      yp[k] = y[i];
    }
    return { X: Xp, y: yp, n: idx.length };
  };
  return { train: pack(trainIdx), test: pack(testIdx) };
}
