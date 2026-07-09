/**
 * IndexedDB-backed L2 chunk cache (W009).
 *
 * Layered cache design (docs/CHUNKING_USABILITY_REVIEW.md gap 3):
 *
 *     L1  in-memory Map (per-loader, volatile)     — nisar-loader.js
 *     L2  IndexedDB (this module, survives reload) — ~200 MB LRU
 *     L3  HTTP Range fetch                          — h5chunk.js
 *
 * Stores DECODED Float32 chunk buffers keyed by
 * (sourceUrl, datasetPath, chunkRow, chunkCol) so repeat sessions on the
 * same remote scene skip re-download AND re-decompression.
 *
 * Design rules:
 *  - URL sources only. Local File objects have no stable key and already
 *    read at disk speed — callers must not create a cache for them.
 *  - Fire-and-forget puts: writes are serialized on an internal chain and
 *    NEVER block or fail a read path. `put()` returns a promise (awaitable
 *    in tests) that never rejects.
 *  - Complete no-op fallback when `indexedDB` is undefined (Node, tests,
 *    ancient browsers): `get()` resolves null, `put()` resolves, nothing
 *    throws. Any runtime IDB failure permanently degrades to the same no-op.
 *  - LRU by last access: reads bump a `lastAccess` stamp (tiny meta record,
 *    so touches don't rewrite megabyte data buffers); eviction walks the
 *    `lastAccess` index ascending until total bytes fit the bound.
 *
 * Schema (DB `sardine-chunk-l2`, version 1):
 *   store `chunks` {key, data: ArrayBuffer, bytes}          — the payload
 *   store `meta`   {key, bytes, lastAccess, sourceUrl,
 *                   datasetPath, row, col}                  — LRU bookkeeping
 *   index `meta.lastAccess`                                 — eviction order
 */

const DB_NAME = 'sardine-chunk-l2';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';
const META_STORE = 'meta';

/** Size bound for the whole L2 store (all URLs/datasets share one LRU). */
export const L2_MAX_BYTES = 200 * 1024 * 1024; // ~200 MB

/** Compose the storage key. U+001F (unit separator) cannot appear in URLs or HDF5 paths. */
export function chunkCacheKey(sourceUrl, datasetPath, chunkRow, chunkCol) {
  return `${sourceUrl}\u001f${datasetPath}\u001f${chunkRow},${chunkCol}`;
}

/** Promisify an IDBRequest. */
function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export class ChunkCacheL2 {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBytes] - LRU size bound (default ~200 MB)
   * @param {IDBFactory|null} [options.idbFactory] - injectable for tests;
   *   defaults to the global `indexedDB`, or null (no-op mode) when undefined.
   */
  constructor({ maxBytes = L2_MAX_BYTES, idbFactory } = {}) {
    this.maxBytes = maxBytes;
    this._idb = idbFactory !== undefined
      ? idbFactory
      : (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this._disabled = !this._idb;
    this._dbPromise = null;
    this._totalBytes = 0;
    this._chain = Promise.resolve(); // serializes all writes (puts, touches, eviction)
    this._accessClock = Date.now(); // monotonic lastAccess stamps (Date.now can tie)
  }

  /** False in no-op mode (no indexedDB, or a fatal IDB error occurred). */
  get available() { return !this._disabled; }

  /** Current accounted payload bytes (accurate after writes settle). */
  get totalBytes() { return this._totalBytes; }

  /** Monotonically increasing timestamp for LRU ordering. */
  _now() {
    const t = Date.now();
    this._accessClock = t > this._accessClock ? t : this._accessClock + 1;
    return this._accessClock;
  }

  _fail(err) {
    if (!this._disabled) {
      this._disabled = true;
      try { console.warn('[ChunkCacheL2] disabled:', err?.message || err); } catch { /* ignore */ }
    }
  }

  /** Open (once) and scan meta records to initialize the byte accounting. */
  _open() {
    if (this._disabled) return Promise.resolve(null);
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve) => {
        let request;
        try {
          request = this._idb.open(DB_NAME, DB_VERSION);
        } catch (e) {
          this._fail(e);
          resolve(null);
          return;
        }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(CHUNK_STORE)) {
            db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            const meta = db.createObjectStore(META_STORE, { keyPath: 'key' });
            meta.createIndex('lastAccess', 'lastAccess');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { this._fail(request.error); resolve(null); };
      }).then(async (db) => {
        if (!db) return null;
        try {
          this._totalBytes = await this._scanSize(db);
        } catch (e) {
          this._fail(e);
          return null;
        }
        return db;
      });
    }
    return this._dbPromise;
  }

  /** Sum stored bytes by cursoring the (tiny) meta records. */
  _scanSize(db) {
    return new Promise((resolve, reject) => {
      let total = 0;
      const cursorReq = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(total); return; }
        total += cursor.value?.bytes || 0;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  /**
   * Read a cached chunk. Resolves Float32Array or null. Never rejects.
   * A hit bumps the LRU stamp via a fire-and-forget meta write.
   */
  async get(sourceUrl, datasetPath, chunkRow, chunkCol) {
    if (this._disabled) return null;
    const db = await this._open();
    if (!db) return null;
    const key = chunkCacheKey(sourceUrl, datasetPath, chunkRow, chunkCol);
    let record;
    try {
      record = await reqPromise(db.transaction(CHUNK_STORE, 'readonly').objectStore(CHUNK_STORE).get(key));
    } catch {
      return null;
    }
    if (!record || !record.data) return null;
    this._touch(key); // fire-and-forget lastAccess bump — never blocks the read
    try {
      return new Float32Array(record.data);
    } catch {
      return null;
    }
  }

  /** Fire-and-forget lastAccess bump (meta record only — no data rewrite). */
  _touch(key) {
    this._enqueue(async (db) => {
      const store = db.transaction(META_STORE, 'readwrite').objectStore(META_STORE);
      const meta = await reqPromise(store.get(key));
      if (meta) {
        meta.lastAccess = this._now();
        await reqPromise(store.put(meta));
      }
    });
  }

  /**
   * Store a decoded Float32 chunk. Fire-and-forget: returns a promise that
   * never rejects; callers must NOT await it on the read path. Non-Float32
   * data (e.g. uint8 mask chunks) and oversized buffers are ignored.
   */
  put(sourceUrl, datasetPath, chunkRow, chunkCol, data) {
    if (this._disabled) return Promise.resolve();
    if (!(data instanceof Float32Array)) return Promise.resolve();
    const bytes = data.byteLength;
    if (bytes === 0 || bytes > this.maxBytes) return Promise.resolve();
    // Copy NOW: the caller's buffer may later be transferred to a worker or GPU.
    const payload = data.buffer.slice(data.byteOffset, data.byteOffset + bytes);
    const key = chunkCacheKey(sourceUrl, datasetPath, chunkRow, chunkCol);
    return this._enqueue(async (db) => {
      const txn = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
      const metaStore = txn.objectStore(META_STORE);
      const prev = await reqPromise(metaStore.get(key));
      await reqPromise(txn.objectStore(CHUNK_STORE).put({ key, data: payload, bytes }));
      await reqPromise(metaStore.put({
        key, bytes,
        lastAccess: this._now(),
        sourceUrl, datasetPath,
        row: chunkRow, col: chunkCol,
      }));
      this._totalBytes += bytes - (prev?.bytes || 0);
      if (this._totalBytes > this.maxBytes) {
        await this._evict(db);
      }
    });
  }

  /** Delete least-recently-accessed entries until under the byte bound. */
  _evict(db) {
    return new Promise((resolve, reject) => {
      const txn = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
      const chunkStore = txn.objectStore(CHUNK_STORE);
      const cursorReq = txn.objectStore(META_STORE).index('lastAccess').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || this._totalBytes <= this.maxBytes) { resolve(); return; }
        this._totalBytes -= cursor.value?.bytes || 0;
        chunkStore.delete(cursor.value.key);
        cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  /** Serialize a write task; failures disable the cache but never propagate. */
  _enqueue(task) {
    const run = this._chain.then(async () => {
      if (this._disabled) return;
      const db = await this._open();
      if (!db) return;
      try {
        await task(db);
      } catch (e) {
        // Quota exceeded / IO error — degrade to no-op, keep the app running.
        this._fail(e);
      }
    });
    this._chain = run.catch(() => {});
    return this._chain;
  }

  /** Await all pending writes (test helper — production code never calls this). */
  async flush() {
    await this._chain;
  }

  /** Drop every entry and reset accounting. Never rejects. */
  clear() {
    return this._enqueue(async (db) => {
      const txn = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
      await reqPromise(txn.objectStore(CHUNK_STORE).clear());
      await reqPromise(txn.objectStore(META_STORE).clear());
      this._totalBytes = 0;
    });
  }
}

// ── Shared instance + loader-facing wrapper ─────────────────────────────────

let _shared = null;

/** Lazily created singleton — one ~200 MB LRU shared by all loaders/datasets. */
export function getSharedChunkCacheL2() {
  if (!_shared) _shared = new ChunkCacheL2();
  return _shared;
}

/**
 * Scoped view of the shared L2 cache for one (sourceUrl, datasetPath) pair.
 * Drop-in replacement for the old Cache-API `createPersistentChunkCache`:
 * returns `{ get(row, col), put(row, col, data) }`.
 *
 * URL sources only — callers with a local File must not create one (local
 * files have no stable identity across sessions and read at disk speed).
 *
 * @param {string} sourceUrl - Remote file URL (cache scoping key)
 * @param {string} datasetPath - HDF5 dataset path (stable across sessions)
 * @param {ChunkCacheL2} [cache] - injectable for tests (defaults to shared)
 */
export function createPersistentChunkCache(sourceUrl, datasetPath, cache = getSharedChunkCacheL2()) {
  const src = String(sourceUrl);
  const ds = String(datasetPath);
  return {
    /** Retrieve a cached chunk → Float32Array | null. Never rejects. */
    get: (row, col) => cache.get(src, ds, row, col),
    /** Store a decoded chunk. Fire-and-forget; never rejects. */
    put: (row, col, data) => cache.put(src, ds, row, col, data),
  };
}

/** Clear the entire persistent chunk cache (all URLs, all datasets). */
export async function clearChunkCache() {
  await getSharedChunkCacheL2().clear();
}
