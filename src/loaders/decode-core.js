/**
 * decode-core.js — Shared HDF5 chunk decode primitives (W006).
 *
 * Pure, synchronous inflate + unshuffle + dtype decode used by BOTH:
 *   - src/loaders/decode-worker.js  (Web Worker pool path)
 *   - src/loaders/decode-pool.js    (main-thread fallback when Workers are
 *     unavailable — Node test env, older browsers)
 *
 * Single source of truth guarantees the fallback is bit-exact with the
 * worker path. Inflate uses pako (synchronous, zlib/RFC 1950 — the HDF5
 * deflate filter format), producing byte-identical output to the
 * DecompressionStream('deflate') path previously used on the main thread.
 */

import pako from 'pako';

// HDF5 filter pipeline IDs (must match h5chunk.js)
export const FILTER_DEFLATE = 1;
export const FILTER_SHUFFLE = 2;

/**
 * Synchronous zlib inflate.
 * @param {Uint8Array} data - Compressed bytes
 * @returns {Uint8Array} Decompressed bytes
 */
export function inflateSync(data) {
  try {
    return pako.inflate(data);
  } catch (e) {
    // pako throws plain strings (e.g. 'incorrect header check') — normalize
    // to Error so callers can rely on .message.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * HDF5 shuffle filter inverse: byte-plane de-interleave.
 * Identical semantics to H5Chunk._unshuffle.
 * @param {Uint8Array} data
 * @param {number} elementSize - Bytes per element (e.g. 4 for float32)
 * @returns {Uint8Array}
 */
export function unshuffle(data, elementSize) {
  if (elementSize <= 1) return data;
  const len = data.length;
  const count = (len / elementSize) | 0;
  const result = new Uint8Array(len);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < elementSize; j++) {
      result[i * elementSize + j] = data[j * count + i];
    }
  }
  return result;
}

/**
 * Decode IEEE 754 half-precision to Float32Array.
 * @param {ArrayBuffer} buffer
 * @returns {Float32Array}
 */
export function decodeFloat16(buffer) {
  const uint16 = new Uint16Array(buffer);
  const result = new Float32Array(uint16.length);
  for (let i = 0; i < uint16.length; i++) {
    const h = uint16[i];
    const sign = (h & 0x8000) >> 15;
    const exp = (h & 0x7C00) >> 10;
    const frac = h & 0x03FF;
    if (exp === 0) {
      result[i] = frac === 0
        ? (sign ? -0 : 0)
        : (sign ? -1 : 1) * (frac / 1024) * Math.pow(2, -14);
    } else if (exp === 31) {
      result[i] = frac ? NaN : (sign ? -Infinity : Infinity);
    } else {
      result[i] = (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
    }
  }
  return result;
}

/**
 * Decode raw bytes to Float32Array by dtype.
 * Identical semantics to H5Chunk._decodeData.
 * @param {ArrayBuffer|TypedArray} buffer
 * @param {string} dtype
 * @returns {Float32Array}
 */
export function decodeBytes(buffer, dtype) {
  // Ensure we have an ArrayBuffer for typed array construction.
  // Only copy when the view has a non-zero byteOffset (alignment issue).
  if (ArrayBuffer.isView(buffer)) {
    if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
      buffer = buffer.buffer; // Zero-copy: view spans entire ArrayBuffer
    } else {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  }
  switch (dtype) {
    case 'float32':  return new Float32Array(buffer);
    case 'float64':  return new Float32Array(new Float64Array(buffer));
    case 'float16':  return decodeFloat16(buffer);
    case 'int16':    return new Float32Array(new Int16Array(buffer));
    case 'uint16':   return new Float32Array(new Uint16Array(buffer));
    case 'int32':    return new Float32Array(new Int32Array(buffer));
    case 'uint32':   return new Float32Array(new Uint32Array(buffer));
    case 'uint8':    return new Float32Array(new Uint8Array(buffer));
    case 'int8':     return new Float32Array(new Int8Array(buffer));
    // Interleaved [real, imag, ...] — 2 values per pixel
    case 'cfloat32': return new Float32Array(buffer);
    case 'cfloat64': return new Float32Array(new Float64Array(buffer));
    default:         return new Float32Array(buffer);
  }
}

/**
 * Apply an HDF5 filter pipeline in reverse order (decode direction).
 * Identical semantics to H5Chunk._decompressChunk.
 * @param {ArrayBuffer|Uint8Array} buffer - Compressed chunk bytes
 * @param {Array<{id: number, params?: number[]}>} filters
 * @returns {Uint8Array} Decoded bytes
 */
export function applyFiltersSync(buffer, filters) {
  let data = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    switch (filter.id) {
      case FILTER_DEFLATE:
        data = inflateSync(data);
        break;
      case FILTER_SHUFFLE:
        data = unshuffle(data, (filter.params && filter.params[0]) || 4);
        break;
      // Other filters would go here
    }
  }
  return data;
}

/**
 * Full chunk decode: filters (reverse order) + dtype decode.
 * If the primary filter pipeline throws and `fallbackFilters` is provided,
 * retries with the fallback (used for the deflate → shuffle+deflate
 * heuristic when a dataset's filter pipeline message is missing).
 *
 * @param {ArrayBuffer|Uint8Array} buffer - Compressed chunk bytes
 * @param {Array|null} filters - Primary filter pipeline (null → raw decode)
 * @param {string} dtype
 * @param {Array|null} [fallbackFilters]
 * @returns {Float32Array}
 */
export function decodeChunkSync(buffer, filters, dtype, fallbackFilters = null) {
  if (!filters || filters.length === 0) {
    return decodeBytes(buffer, dtype);
  }
  try {
    return decodeBytes(applyFiltersSync(buffer, filters), dtype);
  } catch (e) {
    if (fallbackFilters && fallbackFilters.length > 0) {
      return decodeBytes(applyFiltersSync(buffer, fallbackFilters), dtype);
    }
    throw e;
  }
}
