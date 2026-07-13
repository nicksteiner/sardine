/**
 * backends/classical.js — parameter-carrying learned heads (W025).
 *
 * v1 head type: multinomial logistic regression (trainer.js). The manifest
 * carries the parameters (weights/mean/std) inline — the artifact IS the
 * model, no weight fetch. Milliseconds per megapixel, which is what makes
 * the live label→fit→preview loop possible.
 *
 * These heads run on band features today and on foundation-model
 * embeddings tomorrow (linear-probe pattern) — same code, different
 * feature extractor upstream.
 */

import { predictLogistic } from '../trainer.js';

/**
 * @param {Object} manifest — validated, backend "builtin-classical"
 * @param {{bands: Float32Array[], width, height}} input — transformed bands
 * @returns {Promise<{kind:'classmap', data: Uint8Array, confidence: Float32Array, width, height}>}
 */
export async function runClassical(manifest, input, { signal } = {}) {
  const { bands, width, height } = input;
  const f = bands.length;
  const n = width * height;
  const classes = manifest['mlm:output'][0]['classification:classes'];

  const model = {
    weights: manifest['sardine:params'].weights,
    mean: manifest['sardine:params'].mean,
    std: manifest['sardine:params'].std,
    numClasses: classes.length,
    numFeatures: f,
  };

  // Interleave bands to row-major feature matrix. Chunked so long rasters
  // can honor abort between slabs.
  const X = new Float32Array(n * f);
  const SLAB = 1 << 18;
  for (let start = 0; start < n; start += SLAB) {
    if (signal?.aborted) throw new DOMException('classical run aborted', 'AbortError');
    const end = Math.min(n, start + SLAB);
    for (let i = start; i < end; i++) {
      for (let j = 0; j < f; j++) X[i * f + j] = bands[j][i];
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  const { labels, confidence } = predictLogistic(model, X, n, { withConfidence: true });
  return { kind: 'classmap', data: labels, confidence, width, height };
}
