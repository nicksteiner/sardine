/**
 * cog-tile-reader.js — tile-aligned COG reads on @developmentseed/geotiff (W032).
 *
 * geotiff.js served SARdine's COG paths with `readRasters({ window })`: every
 * viewport tile became an arbitrary byte window decoded on the main thread.
 * This module reads whole internal COG tiles instead — one tile is one HTTP
 * range, neighbours coalesce into one request, decoding runs in a worker
 * pool — and keeps the decoded tiles in a bytes-capped LRU so adjacent
 * viewport tiles share them. On top of that it reproduces exactly what the
 * callers used geotiff.js for: a native-resolution window at a given level
 * (`readWindow`) and a fixed-size resampled tile for a base-resolution pixel
 * window (`readTile`, with geotiff.js's own nearest/bilinear formulas so
 * renders are unchanged).
 *
 * Only @developmentseed/geotiff's *reader* is used. Its deck.gl layers need
 * deck.gl 9 and are out of scope here.
 */
import { GeoTIFF, DecoderPool } from '@developmentseed/geotiff';
import { debugLog } from '../utils/debug-log.js';

const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_OPEN_READERS = 8;

// ─── Decoder pool ────────────────────────────────────────────────────────────

let workerPool = null;
let mainThreadPool = null;
let workersBroken = null; // Promise that rejects once a worker fails to load

function getMainThreadPool() {
  if (!mainThreadPool) mainThreadPool = new DecoderPool({ size: 0 });
  return mainThreadPool;
}

function getWorkerPool() {
  if (workerPool !== null) return workerPool;
  if (typeof Worker === 'undefined') {
    workerPool = false;
    return workerPool;
  }
  let rejectBroken;
  workersBroken = new Promise((_, reject) => { rejectBroken = reject; });
  workersBroken.catch(() => {}); // avoid unhandled rejection when never awaited
  try {
    const size = Math.max(1, Math.min(8, (navigator?.hardwareConcurrency || 4) - 1));
    workerPool = new DecoderPool({
      size,
      createWorker: () => {
        const w = new Worker(new URL('./cog-decode-worker.js', import.meta.url), { type: 'module' });
        w.onerror = (e) => {
          console.warn('[cog-tile-reader] decode worker failed, decoding on main thread:', e?.message || e);
          rejectBroken(new Error('decode worker failed'));
          workerPool = false;
        };
        return w;
      },
    });
    debugLog(`[cog-tile-reader] decode worker pool: ${size} threads`);
  } catch (e) {
    console.warn('[cog-tile-reader] could not start decode workers:', e?.message || e);
    workerPool = false;
  }
  return workerPool;
}

/**
 * A `{ decode }` object @developmentseed/geotiff accepts as its `pool`.
 * Prefers the worker pool; if a worker fails to load (bundling, CSP) the
 * in-flight jobs are abandoned and every decode falls back to the main
 * thread, instead of hanging on a worker that will never answer.
 */
const decoderProxy = {
  async decode(bytes, compression, metadata) {
    const pool = getWorkerPool();
    if (!pool) return getMainThreadPool().decode(bytes, compression, metadata);
    // The worker takes `bytes` by transfer, so keep a copy for the fallback.
    const backup = bytes.slice(0);
    try {
      return await Promise.race([pool.decode(bytes, compression, metadata), workersBroken]);
    } catch (e) {
      if (workerPool !== false) throw e; // a real decode error, not a dead worker
      return getMainThreadPool().decode(backup, compression, metadata);
    }
  },
};

// ─── Resampling (geotiff.js semantics) ───────────────────────────────────────

/**
 * Resample `data` (inW×inH) to outW×outH with geotiff.js's nearest or
 * bilinear formulas — same rounding, same edge clamping — so a tile read
 * through this module renders identically to one read via `readRasters`.
 * @returns {Float32Array}
 */
export function resampleArray(data, inW, inH, outW, outH, method = 'bilinear') {
  const out = new Float32Array(outW * outH);
  const relX = inW / outW;
  const relY = inH / outH;
  if (method === 'nearest') {
    for (let y = 0; y < outH; y++) {
      const cy = Math.min(Math.round(relY * y), inH - 1);
      const rowOff = cy * inW;
      for (let x = 0; x < outW; x++) {
        const cx = Math.min(Math.round(relX * x), inW - 1);
        out[y * outW + x] = data[rowOff + cx];
      }
    }
    return out;
  }
  for (let y = 0; y < outH; y++) {
    const rawY = relY * y;
    const yl = Math.floor(rawY);
    const yh = Math.min(Math.ceil(rawY), inH - 1);
    const ty = rawY % 1;
    for (let x = 0; x < outW; x++) {
      const rawX = relX * x;
      const tx = rawX % 1;
      const xl = Math.floor(rawX);
      const xh = Math.min(Math.ceil(rawX), inW - 1);
      const ll = data[yl * inW + xl];
      const hl = data[yl * inW + xh];
      const lh = data[yh * inW + xl];
      const hh = data[yh * inW + xh];
      const top = (1 - tx) * ll + tx * hl;
      const bot = (1 - tx) * lh + tx * hh;
      out[y * outW + x] = (1 - ty) * top + ty * bot;
    }
  }
  return out;
}

// ─── Reader ──────────────────────────────────────────────────────────────────

/** One band of a decoded tile as Float32, mask IFD pixels set to NaN. */
function bandToFloat32(array, band) {
  const n = array.width * array.height;
  let out;
  if (array.layout === 'band-separate') {
    const src = array.bands[band];
    out = src instanceof Float32Array ? src : new Float32Array(src);
  } else if (array.count === 1) {
    out = array.data instanceof Float32Array ? array.data : new Float32Array(array.data);
  } else {
    const d = array.data;
    const c = array.count;
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = d[i * c + band];
  }
  if (array.mask) {
    const m = array.mask;
    for (let i = 0; i < n; i++) if (m[i] === 0) out[i] = NaN;
  }
  return out;
}

/**
 * Open a COG for tile-aligned reads.
 *
 * @param {string|ArrayBuffer} source - URL (absolute, or relative to the page)
 *   or the whole file in memory.
 * @param {Object} [options]
 * @param {number} [options.cacheBytes=256MB] - decoded-tile LRU cap
 * @param {AbortSignal} [options.signal] - aborts the header reads
 * @returns {Promise<COGReader>}
 */
export async function openCOGReader(source, { cacheBytes = DEFAULT_CACHE_BYTES, signal } = {}) {
  const geotiff = typeof source === 'string'
    ? await GeoTIFF.fromUrl(source, { signal })
    : await GeoTIFF.fromArrayBuffer(source);

  // Level 0 is the full-resolution image; overviews follow finest → coarsest.
  const levels = [geotiff, ...geotiff.overviews].map((img, index) => ({
    index,
    img,
    width: img.width,
    height: img.height,
    tileWidth: img.tileWidth,
    tileHeight: img.tileHeight,
  }));
  const { width, height } = geotiff;
  const rawCrs = geotiff.crs;
  const crs = typeof rawCrs === 'number' ? `EPSG:${rawCrs}` : null;

  // Decoded-tile LRU: key → { promise, array, bands: Map<band, Float32Array>, bytes }
  const cache = new Map();
  let cacheTotal = 0;

  function touch(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
  }

  function evict() {
    for (const [key, entry] of cache) {
      if (cacheTotal <= cacheBytes) break;
      if (!entry.array) continue; // still in flight
      cache.delete(key);
      cacheTotal -= entry.bytes;
    }
  }

  function arrayBytes(array) {
    if (array.layout === 'band-separate') return array.bands.reduce((s, b) => s + b.byteLength, 0);
    return array.data.byteLength + (array.mask ? array.mask.byteLength : 0);
  }

  /** Fetch + decode the given tiles of one level (one coalesced batch). */
  function requestTiles(level, coords) {
    const L = levels[level];
    const entries = coords.map(([x, y]) => {
      const entry = { promise: null, array: null, bands: new Map(), bytes: 0 };
      cache.set(`${level}:${x}:${y}`, entry);
      return entry;
    });
    const batch = L.img.fetchTiles(coords, { boundless: true, pool: decoderProxy })
      .catch(async (err) => {
        // A sparse COG tile (byteCount 0) rejects the whole batch; fall back to
        // one fetch per tile so the present tiles still load and the sparse
        // ones read as nodata.
        if (!/not found/i.test(err?.message || '')) throw err;
        return Promise.all(coords.map(([x, y]) =>
          L.img.fetchTile(x, y, { boundless: true, pool: decoderProxy }).catch(() => null)));
      });
    entries.forEach((entry, i) => {
      entry.promise = batch.then((tiles) => {
        const tile = tiles[i];
        entry.array = tile ? tile.array : {
          layout: 'pixel-interleaved', count: 1,
          width: L.tileWidth, height: L.tileHeight, mask: null,
          data: new Float32Array(L.tileWidth * L.tileHeight).fill(NaN),
        };
        entry.bytes = arrayBytes(entry.array);
        cacheTotal += entry.bytes;
        evict();
        return entry;
      }, (err) => {
        const key = `${level}:${coords[i][0]}:${coords[i][1]}`;
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
    });
    return entries;
  }

  function getBand(entry, band) {
    let arr = entry.bands.get(band);
    if (!arr) {
      arr = bandToFloat32(entry.array, band);
      entry.bands.set(band, arr);
      const src = entry.array.layout === 'band-separate' ? entry.array.bands[band] : entry.array.data;
      if (arr !== src) { // a converted copy, not the zero-copy Float32 view
        entry.bytes += arr.byteLength;
        cacheTotal += arr.byteLength;
      }
    }
    return arr;
  }

  /**
   * Read a native-resolution window `[left, top, right, bottom]` (level
   * pixels, right/bottom exclusive) from level `level`. Clamped to the image.
   * @returns {Promise<{data: Float32Array, width: number, height: number}|null>}
   */
  async function readWindow(level, window, { band = 0 } = {}) {
    const L = levels[level];
    if (!L) throw new Error(`cog-tile-reader: no level ${level}`);
    if (!L.tileWidth || !L.tileHeight) throw new Error('cog-tile-reader: TIFF is not tiled');
    const left = Math.max(0, Math.floor(window[0]));
    const top = Math.max(0, Math.floor(window[1]));
    const right = Math.min(L.width, Math.ceil(window[2]));
    const bottom = Math.min(L.height, Math.ceil(window[3]));
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) return null;

    const { tileWidth: tw, tileHeight: th } = L;
    const tx0 = Math.floor(left / tw);
    const tx1 = Math.floor((right - 1) / tw);
    const ty0 = Math.floor(top / th);
    const ty1 = Math.floor((bottom - 1) / th);

    const wanted = [];
    const missing = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${level}:${tx}:${ty}`;
        const hit = cache.get(key);
        if (hit) {
          touch(key, hit);
          wanted.push({ tx, ty, entry: hit });
        } else {
          missing.push([tx, ty]);
          wanted.push({ tx, ty, entry: null });
        }
      }
    }
    if (missing.length) {
      const entries = requestTiles(level, missing);
      let k = 0;
      for (const item of wanted) if (!item.entry) item.entry = entries[k++];
    }
    await Promise.all(wanted.map((item) => item.entry.promise));

    const out = new Float32Array(w * h);
    for (const { tx, ty, entry } of wanted) {
      const src = getBand(entry, band);
      const ox = tx * tw;
      const oy = ty * th;
      const cl = Math.max(left, ox);
      const cr = Math.min(right, ox + tw);
      const ct = Math.max(top, oy);
      const cb = Math.min(bottom, oy + th);
      const span = cr - cl;
      for (let row = ct; row < cb; row++) {
        const s = (row - oy) * tw + (cl - ox);
        out.set(src.subarray(s, s + span), (row - top) * w + (cl - left));
      }
    }
    return { data: out, width: w, height: h };
  }

  /**
   * Coarsest level whose resolution is still within 1.5× of `neededRes`
   * (base pixels per output pixel) — the rule the geotiff.js paths used.
   */
  function pickLevel(neededRes) {
    let best = 0;
    for (let i = 0; i < levels.length; i++) {
      if (width / levels[i].width <= neededRes * 1.5) best = i;
    }
    return best;
  }

  /**
   * Read a `size`×`size` tile covering `baseWindow` (full-resolution pixel
   * coords, right/bottom exclusive): picks the level, maps the window onto it,
   * reads it and resamples. Returns null when the window misses the image.
   * @returns {Promise<Float32Array|null>}
   */
  async function readTile(baseWindow, size = 256, resample = 'bilinear', { band = 0 } = {}) {
    const [l, t, r, b] = baseWindow;
    if (!(r > l) || !(b > t)) return null;
    const level = pickLevel(Math.max(r - l, b - t) / size);
    const L = levels[level];
    const sx = L.width / width;
    const sy = L.height / height;
    const win = await readWindow(level, [l * sx, t * sy, r * sx, b * sy], { band });
    if (!win) return null;
    return resampleArray(win.data, win.width, win.height, size, size, resample);
  }

  function close() {
    cache.clear();
    cacheTotal = 0;
  }

  debugLog(`[cog-tile-reader] open ${width}x${height}, ${levels.length} levels, tiles ${geotiff.tileWidth}x${geotiff.tileHeight}, ${crs || 'no EPSG'}`);

  return {
    geotiff,
    width,
    height,
    tileWidth: geotiff.tileWidth,
    tileHeight: geotiff.tileHeight,
    isTiled: geotiff.isTiled,
    levelCount: levels.length,
    levels: levels.map(({ index, width: w, height: h, tileWidth, tileHeight }) => ({ index, width: w, height: h, tileWidth, tileHeight })),
    bbox: geotiff.bbox,
    crs,
    rawCrs,
    nodata: geotiff.nodata,
    bandCount: geotiff.count,
    gdalMetadata: geotiff.gdalMetadata,
    pickLevel,
    readWindow,
    readTile,
    close,
    get cacheBytes() { return cacheTotal; },
  };
}

// ─── Shared readers by URL ───────────────────────────────────────────────────

const openReaders = new Map(); // url → Promise<COGReader>

/**
 * Open-once reader for a URL: `loadCOG`, `SARTiledCOGLayer` and the compare
 * panels can all point at the same file without each paying the header reads
 * or keeping separate tile caches.
 */
export function getCOGReader(url, options) {
  let p = openReaders.get(url);
  if (p) {
    openReaders.delete(url);
    openReaders.set(url, p);
    return p;
  }
  p = openCOGReader(url, options).catch((err) => {
    openReaders.delete(url);
    throw err;
  });
  openReaders.set(url, p);
  while (openReaders.size > MAX_OPEN_READERS) {
    const [oldest, oldP] = openReaders.entries().next().value;
    openReaders.delete(oldest);
    oldP.then((r) => r.close(), () => {});
  }
  return p;
}

/** Drop a shared reader (and its tile cache). */
export function releaseCOGReader(url) {
  const p = openReaders.get(url);
  if (!p) return;
  openReaders.delete(url);
  p.then((r) => r.close(), () => {});
}
