/**
 * decode-worker.js — Web Worker for HDF5 chunk decompression (W006).
 *
 * Receives {id, buffer, filters, dtype, fallbackFilters} where `buffer` is a
 * transferred (zero-copy) ArrayBuffer of compressed chunk bytes. Applies
 * inflate + unshuffle + dtype decode via decode-core (shared with the
 * main-thread fallback — bit-exact by construction) and posts the decoded
 * Float32Array's buffer back, also transferred.
 *
 * Instantiated by decode-pool.js with the Vite-supported pattern:
 *   new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' })
 */

import { decodeChunkSync } from './decode-core.js';

self.onmessage = (e) => {
  const { id, buffer, filters, dtype, fallbackFilters } = e.data;
  try {
    const result = decodeChunkSync(buffer, filters, dtype, fallbackFilters);
    self.postMessage({ id, buffer: result.buffer }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
