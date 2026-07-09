/**
 * decode-pool.js — Web Worker pool for HDF5 chunk decompression (W006).
 *
 * pako inflate + shuffle is CPU-bound (7–17 ms/chunk) and used to run
 * serially on the main thread, blocking pan/zoom frames. This pool moves
 * decompress + unshuffle + dtype decode into Web Workers with transferable
 * ArrayBuffers (zero-copy in both directions).
 *
 * Properties:
 *   - Lazy spawn: no workers are created until the first decode() call;
 *     workers are added on demand up to the cap.
 *   - Cap: min(4, navigator.hardwareConcurrency) by default; resizable at
 *     runtime via setWorkerCount() (UI slider in app/main.jsx).
 *   - Dispatch: idle-worker queue (effectively round-robin under load) —
 *     each job resolves its own Promise, so callers that need ordering
 *     (readChunksBatch) keep it regardless of completion order.
 *   - Graceful fallback: when Workers are unavailable (Node test env, older
 *     browsers) or construction throws, jobs decode synchronously on the
 *     main thread via decode-core — the exact same code the worker runs,
 *     so results are bit-exact.
 */

import { decodeChunkSync } from './decode-core.js';

const DEFAULT_MAX_WORKERS = 4;
const HARD_MAX_WORKERS = 32;

export class DecodePool {
  constructor(maxWorkers = null) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : DEFAULT_MAX_WORKERS;
    this.maxWorkers = maxWorkers || Math.min(DEFAULT_MAX_WORKERS, cores);
    this.cores = cores;
    this.workers = [];        // Worker instances (terminated slots become null)
    this.idle = [];           // indices of idle workers
    this.queue = [];          // pending jobs: {msg, resolve, reject}
    this.pending = new Map(); // job id → {resolve, reject}
    this.workerTask = new Map(); // worker idx → job id currently running
    this._nextId = 0;
    this._spawnFailed = false; // Worker construction threw → stop trying
  }

  /** True when the Worker path is usable in this environment. */
  workersSupported() {
    return !this._spawnFailed && typeof Worker === 'function';
  }

  /** Number of live (non-terminated) workers. */
  spawnedCount() {
    let n = 0;
    for (const w of this.workers) if (w) n++;
    return n;
  }

  /**
   * Decode one compressed chunk.
   *
   * @param {object} job
   * @param {ArrayBuffer} job.buffer - Compressed chunk bytes. TRANSFERRED to
   *   the worker (detached afterwards) when the worker path is used.
   * @param {Array<{id, params?}>} job.filters - HDF5 filter pipeline
   * @param {string} job.dtype - e.g. 'float32', 'float16', 'cfloat32'
   * @param {Array|null} [job.fallbackFilters] - Retry pipeline (heuristic)
   * @param {boolean} [job.sync] - Force synchronous main-thread decode
   * @returns {Promise<Float32Array>}
   */
  decode({ buffer, filters, dtype, fallbackFilters = null, sync = false }) {
    if (sync || !this.workersSupported()) {
      return this._decodeSync(buffer, filters, dtype, fallbackFilters);
    }
    const id = this._nextId++;
    const msg = { id, buffer, filters, dtype, fallbackFilters };
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, resolve, reject });
      this._dispatch();
    });
  }

  /** Synchronous main-thread fallback — bit-exact with the worker path. */
  _decodeSync(buffer, filters, dtype, fallbackFilters) {
    try {
      return Promise.resolve(decodeChunkSync(buffer, filters, dtype, fallbackFilters));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  _spawnWorker() {
    const idx = this.workers.length;
    const worker = new Worker(
      new URL('./decode-worker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (e) => this._onMessage(idx, e);
    worker.onerror = (e) => this._onError(idx, e);
    this.workers.push(worker);
    if (idx === 0) {
      console.log(`[decode-pool] Chunk decode worker pool (lazy, max ${this.maxWorkers} threads)`);
    }
    return idx;
  }

  _dispatch() {
    while (this.queue.length > 0) {
      let workerIdx;
      if (this.idle.length > 0) {
        workerIdx = this.idle.pop();
      } else if (this.spawnedCount() < this.maxWorkers && !this._spawnFailed) {
        try {
          workerIdx = this._spawnWorker();
        } catch (e) {
          console.warn(`[decode-pool] Worker spawn failed (${e.message}) — falling back to main-thread decode`);
          this._spawnFailed = true;
          if (this.spawnedCount() === 0) {
            // No workers at all → drain the whole queue synchronously
            const jobs = this.queue.splice(0);
            for (const job of jobs) {
              this._decodeSync(job.msg.buffer, job.msg.filters, job.msg.dtype, job.msg.fallbackFilters)
                .then(job.resolve, job.reject);
            }
          }
          return; // existing busy workers (if any) will drain the queue
        }
      } else {
        return; // all workers busy — completions re-enter _dispatch
      }
      const job = this.queue.shift();
      this.pending.set(job.msg.id, { resolve: job.resolve, reject: job.reject });
      this.workerTask.set(workerIdx, job.msg.id);
      this.workers[workerIdx].postMessage(job.msg, [job.msg.buffer]);
    }
  }

  _onMessage(workerIdx, e) {
    const { id, buffer, error } = e.data;
    this.workerTask.delete(workerIdx);
    const task = this.pending.get(id);
    if (task) {
      this.pending.delete(id);
      if (error) task.reject(new Error(error));
      else task.resolve(new Float32Array(buffer));
    }
    this._recycleWorker(workerIdx);
  }

  _onError(workerIdx, e) {
    const message = (e && e.message) || 'unknown worker error';
    console.warn(`[decode-pool] Worker ${workerIdx} error:`, message);
    // Reject the pending task for this worker so its promise doesn't hang.
    // The compressed buffer was transferred (detached) so no retry is possible.
    const taskId = this.workerTask.get(workerIdx);
    if (taskId !== undefined) {
      this.workerTask.delete(workerIdx);
      const task = this.pending.get(taskId);
      if (task) {
        this.pending.delete(taskId);
        task.reject(new Error(`Decode worker ${workerIdx} crashed: ${message}`));
      }
    }
    this._recycleWorker(workerIdx);
  }

  /** Return a worker to the idle list, or retire it if over the current cap. */
  _recycleWorker(workerIdx) {
    if (!this.workers[workerIdx]) return; // already terminated
    if (this.spawnedCount() > this.maxWorkers) {
      this.workers[workerIdx].terminate();
      this.workers[workerIdx] = null;
    } else {
      this.idle.push(workerIdx);
    }
    this._dispatch();
  }

  /**
   * Resize the pool cap at runtime. Growth is lazy (workers spawn on
   * demand); shrinking terminates idle workers immediately and retires
   * busy ones as they finish.
   */
  resize(newSize) {
    const clamped = Math.max(1, Math.min(HARD_MAX_WORKERS, newSize));
    if (clamped === this.maxWorkers) return;
    this.maxWorkers = clamped;
    while (this.spawnedCount() > this.maxWorkers && this.idle.length > 0) {
      const idx = this.idle.pop();
      this.workers[idx].terminate();
      this.workers[idx] = null;
    }
    console.log(`[decode-pool] Worker pool cap set to ${this.maxWorkers} threads`);
    this._dispatch();
  }

  terminate() {
    for (const w of this.workers) if (w) w.terminate();
    this.workers = [];
    this.idle = [];
    this.workerTask.clear();
  }

  getInfo() {
    return {
      size: this.maxWorkers,          // configured cap (what the UI shows/sets)
      spawned: this.spawnedCount(),   // lazily-created live workers
      idle: this.idle.length,
      queued: this.queue.length,
      cores: this.cores,
      workersSupported: this.workersSupported(),
    };
  }
}

// ── Shared singleton — one pool across all H5Chunk instances ────────────────
let _pool = null;

/** Get (lazily create) the shared decode pool. Creating it spawns no workers. */
export function getDecodePool() {
  if (!_pool) _pool = new DecodePool();
  return _pool;
}

/**
 * Set the decode worker cap at runtime.
 * @param {number} count - Number of workers (1–32)
 */
export function setWorkerCount(count) {
  getDecodePool().resize(count);
}

/**
 * Get current worker pool info.
 * @returns {{size: number, spawned: number, idle: number, queued: number, cores: number, workersSupported: boolean}}
 */
export function getWorkerPoolInfo() {
  return getDecodePool().getInfo();
}
