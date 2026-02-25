/**
 * Persistent chunk cache backed by the browser Cache API.
 *
 * Stores decompressed chunk ArrayBuffers so they survive page reloads.
 * Falls back silently to no-op if Cache API is unavailable (e.g. HTTP, Firefox private mode).
 *
 * Cache key format: /<urlHash>/<datasetId>/<row>,<col>
 */

const CACHE_NAME = 'sardine-chunks-v1';
const MAX_CACHE_ENTRIES = 2000; // cap to prevent unbounded disk use

let _cache = null;
let _cacheAvailable = null; // null = untested, true/false after first attempt

async function getCache() {
  if (_cacheAvailable === false) return null;
  if (_cache) return _cache;
  try {
    _cache = await caches.open(CACHE_NAME);
    _cacheAvailable = true;
    return _cache;
  } catch {
    _cacheAvailable = false;
    return null;
  }
}

/** Simple FNV-1a hash of a string → 8-char hex. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function cacheKey(urlHash, datasetId, row, col) {
  return `/${urlHash}/${datasetId}/${row},${col}`;
}

/**
 * Create a persistent chunk cache scoped to a specific URL + dataset.
 *
 * @param {string} url - The source file URL (used for cache scoping)
 * @param {string} datasetId - HDF5 dataset identifier
 * @returns {{ get, put }}
 */
export function createPersistentChunkCache(url, datasetId) {
  const urlHash = hashString(url);

  return {
    /**
     * Retrieve a cached chunk. Returns Float32Array or null.
     */
    async get(row, col) {
      const cache = await getCache();
      if (!cache) return null;
      try {
        const resp = await cache.match(new Request(cacheKey(urlHash, datasetId, row, col)));
        if (!resp) return null;
        const buf = await resp.arrayBuffer();
        return new Float32Array(buf);
      } catch {
        return null;
      }
    },

    /**
     * Store a decompressed chunk.
     * @param {number} row
     * @param {number} col
     * @param {Float32Array} data
     */
    async put(row, col, data) {
      const cache = await getCache();
      if (!cache || !data) return;
      try {
        const key = cacheKey(urlHash, datasetId, row, col);
        const resp = new Response(data.buffer.slice(0), {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        await cache.put(new Request(key), resp);
      } catch {
        // Quota exceeded or other error — degrade silently
      }
    },

    /**
     * Check if a chunk is cached (without reading the full data).
     */
    async has(row, col) {
      const cache = await getCache();
      if (!cache) return false;
      try {
        const resp = await cache.match(new Request(cacheKey(urlHash, datasetId, row, col)));
        return resp != null;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Clear the entire persistent chunk cache.
 */
export async function clearChunkCache() {
  try {
    await caches.delete(CACHE_NAME);
    _cache = null;
  } catch {
    // ignore
  }
}
