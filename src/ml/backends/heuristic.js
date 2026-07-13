/**
 * backends/heuristic.js — declarative rule models (W025).
 *
 * Heuristics are models: a threshold or index rule is a pixel-classifier
 * with zero weights. They share the manifest and output shape with learned
 * models (MONAI Label precedent: energy-based and DL tasks are peers under
 * one interface), so the UI, overlays, provenance, and adjudication flow
 * treat them identically.
 *
 * Rule shape (validated by manifest.js):
 *   { band: 0, op: "<" | "<=" | ">" | ">=" | "between", value: n | [lo, hi], class: k }
 * First matching rule wins; `sardine:params.default` (default 0) applies
 * when nothing matches. Invalid pixels (non-finite input) → 255.
 */

/**
 * @param {Object} manifest — validated manifest, backend "builtin-heuristic"
 * @param {{bands: Float32Array[], width: number, height: number}} input
 *        Band arrays already transformed per the manifest input spec (the
 *        registry applies dB/power conversion before dispatch).
 * @returns {Promise<{kind: 'classmap', data: Uint8Array, width, height}>}
 */
export async function runHeuristic(manifest, input, { signal } = {}) {
  const rules = manifest['sardine:params'].rules;
  const dflt = manifest['sardine:params'].default ?? 0;
  const { bands, width, height } = input;
  const n = width * height;
  const out = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if ((i & 0xFFFF) === 0 && signal?.aborted) {
      throw new DOMException('heuristic run aborted', 'AbortError');
    }
    let cls = dflt;
    let invalid = false;
    for (const r of rules) {
      const v = bands[r.band][i];
      if (!Number.isFinite(v)) { invalid = true; break; }
      let hit = false;
      switch (r.op) {
        case '<': hit = v < r.value; break;
        case '<=': hit = v <= r.value; break;
        case '>': hit = v > r.value; break;
        case '>=': hit = v >= r.value; break;
        case 'between': hit = v >= r.value[0] && v <= r.value[1]; break;
      }
      if (hit) { cls = r.class; break; }
    }
    out[i] = invalid ? 255 : cls;
  }
  return { kind: 'classmap', data: out, width, height };
}
