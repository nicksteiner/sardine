/**
 * backends/onnx.js — ONNX Runtime Web backend (W025; W024 will extend).
 *
 * Design constraints from the verified research:
 *  - `onnxruntime-web` loads ONLY via lazy dynamic import — the entry
 *    bundle pays nothing until the first ONNX model runs (W024 ground rule;
 *    vite splits the dynamic import into its own chunk).
 *  - WebGPU availability must NOT be assumed, even on Chromium (claim
 *    refuted 0–3 in verification): EP negotiation tries
 *    ['webgpu', 'wasm'] when `navigator.gpu` exists, else ['wasm'].
 *  - Weights are fetched once and cached in IndexedDB (same cache-once
 *    treatment as data chunks); tiny models can inline weights as base64
 *    in the manifest (`sardine:params.modelBase64`) and skip the network
 *    entirely.
 *
 * W024 coordination: the despeckle pilot should extend THIS module
 * (graph capture, f16, GPU-buffer IO) rather than create ort-session.js.
 */

import { runTiled } from '../run-tiled.js';
import { manifestDefaults } from '../manifest.js';

const DB_NAME = 'sardine-model-weights';
const DB_STORE = 'weights';

let ortModulePromise = null;
const sessionCache = new Map(); // manifest.id → {session, ep}

/** Lazy-load onnxruntime-web exactly once. */
function loadOrt() {
  if (!ortModulePromise) {
    ortModulePromise = import('onnxruntime-web').then((mod) => {
      // Namespace shape differs between bundled (named exports) and
      // dev-served-without-interop (default export) — accept both.
      const ort = mod?.env ? mod : (mod?.default?.env ? mod.default : mod);
      if (!ort?.env || !ort?.InferenceSession) {
        throw new Error('onnxruntime-web loaded but exports are unrecognized — check the installed package');
      }
      // ORT's .wasm binaries are not bundled by vite; fetch them from the
      // pinned CDN matching the installed version. (Hosted + dev builds;
      // fully-offline deployments can override via ort.env.wasm.wasmPaths.)
      if (!ort.env.wasm.wasmPaths) {
        const ver = ort.env.versions?.web || ort.env.versions?.common;
        ort.env.wasm.wasmPaths = ver
          ? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`
          : 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
      }
      return ort;
    });
  }
  return ortModulePromise;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      tx.onsuccess = () => resolve(tx.result || null);
      tx.onerror = () => resolve(null);
    });
  } catch { return null; } // private mode etc. — cache is best-effort
}

async function idbPut(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
      tx.onsuccess = resolve;
      tx.onerror = resolve;
    });
  } catch { /* best-effort */ }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Fetch model bytes: inline base64 → IDB cache → network (then cache). */
async function getModelBytes(manifest, onPhase) {
  const inline = manifest['sardine:params']?.modelBase64;
  if (inline) return { bytes: base64ToBytes(inline), from: 'inline' };

  const href = manifest['mlm:artifacts'].find(a => a?.href)?.href;
  const cacheKey = `${manifest.id}::${href}`;
  const cached = await idbGet(cacheKey);
  if (cached) return { bytes: new Uint8Array(cached), from: 'idb' };

  onPhase?.('weights');
  const resp = await fetch(href);
  if (!resp.ok) throw new Error(`weight fetch failed: HTTP ${resp.status} for ${href}`);
  const buf = await resp.arrayBuffer();
  await idbPut(cacheKey, buf);
  return { bytes: new Uint8Array(buf), from: 'network' };
}

/** Create (or reuse) an inference session with EP negotiation. */
async function getSession(manifest, onPhase) {
  const hit = sessionCache.get(manifest.id);
  if (hit) return hit;

  const ort = await loadOrt();
  const { bytes, from } = await getModelBytes(manifest, onPhase);

  onPhase?.('session');
  // Never assume WebGPU (refuted claim): negotiate, record what ran.
  const wantGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  const providers = wantGpu ? ['webgpu', 'wasm'] : ['wasm'];
  let session = null;
  let ep = null;
  let lastErr = null;
  for (const p of providers) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [p] });
      ep = p;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!session) throw new Error(`ONNX session creation failed on [${providers}]: ${lastErr?.message}`);

  const entry = { session, ep, weightsFrom: from };
  sessionCache.set(manifest.id, entry);
  return entry;
}

/** Drop a cached session (frees GPU/WASM memory). */
export function releaseOnnxSession(manifestId) {
  const hit = sessionCache.get(manifestId);
  if (hit) {
    hit.session.release?.();
    sessionCache.delete(manifestId);
  }
}

/**
 * Run an ONNX model over the input raster.
 *
 * @param {Object} manifest — validated, backend "onnx"
 * @param {{bands: Float32Array[], width, height}} input — transformed bands
 * @param {Object} [opts] {signal, onProgress(phase, done, total)}
 * @returns {Promise<{kind:'raster'|'classmap', data, width, height, ep, weightsFrom}>}
 */
export async function runOnnx(manifest, input, opts = {}) {
  const { signal, onProgress } = opts;
  const { bands, width, height } = input;
  const d = manifestDefaults(manifest);
  const channels = bands.length;
  const isClassifier = manifest['mlm:tasks'].includes('pixel-classifier');

  const { session, ep, weightsFrom } = await getSession(manifest,
    (phase) => onProgress?.(phase, 0, 1));
  const ort = await loadOrt();

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  // CHW-stack the bands once.
  const chw = new Float32Array(channels * width * height);
  for (let c = 0; c < channels; c++) chw.set(bands[c], c * width * height);

  const runOne = async (tileData, tw, th) => {
    if (signal?.aborted) throw new DOMException('onnx run aborted', 'AbortError');
    const tensor = new ort.Tensor('float32', tileData, [1, channels, th, tw]);
    const result = await session.run({ [inputName]: tensor });
    const out = result[outputName];
    return out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  };

  let raster;
  if (d.strategy === 'tiled') {
    raster = await runTiled(runOne, chw, width, height, {
      channels,
      outChannels: isClassifier ? (d.classes?.length || 1) : 1,
      tileSize: d.tile.size,
      overlap: d.tile.overlap,
      signal,
      onProgress: (done, total) => onProgress?.('tiles', done, total),
    });
  } else {
    onProgress?.('tiles', 0, 1);
    raster = await runOne(chw, width, height);
    onProgress?.('tiles', 1, 1);
  }

  if (isClassifier) {
    // Argmax across class channels → classmap
    const C = d.classes.length;
    const n = width * height;
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bestV = -Infinity;
      for (let c = 0; c < C; c++) {
        const v = raster[c * n + i];
        if (v > bestV) { bestV = v; best = c; }
      }
      labels[i] = best;
    }
    return { kind: 'classmap', data: labels, width, height, ep, weightsFrom };
  }
  return { kind: 'raster', data: raster, width, height, ep, weightsFrom };
}
