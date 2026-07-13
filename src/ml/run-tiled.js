/**
 * run-tiled.js — tiled execution with feathered overlap blending (W025).
 *
 * Backend-agnostic: `tileFn` is any async function over one fixed-size
 * float32 tile (an ONNX session run, a WASM kernel, a JS filter). The
 * runner cuts the raster into overlapping tiles, executes them
 * sequentially (yielding to the event loop), and blends the overlap with
 * a linear feather ramp so tile seams stay below test tolerance.
 *
 * Contract notes (from the W025 research pass):
 *  - float32-native throughout — SAR power/dB never quantized (the
 *    Deepness uint8 limitation is the anti-lesson);
 *  - border tiles are zero-padded to the fixed tile size (Deepness
 *    convention) and cropped on write-back;
 *  - cancelable via AbortSignal, progress via onProgress(done, total).
 */

/**
 * @param {(tile: Float32Array, tw: number, th: number) => Promise<Float32Array>|Float32Array} tileFn
 *        Maps a CHW tile (channels × tileSize × tileSize, row-major per
 *        channel) to an output tile with `outChannels` channels, same H/W.
 * @param {Float32Array} data — CHW input raster (channels × h × w)
 * @param {number} w
 * @param {number} h
 * @param {Object} [opts]
 * @param {number} [opts.channels=1]
 * @param {number} [opts.outChannels=1]
 * @param {number} [opts.tileSize=256]
 * @param {number} [opts.overlap=16] — must be < tileSize/2
 * @param {AbortSignal} [opts.signal]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Float32Array>} CHW output raster (outChannels × h × w)
 */
export async function runTiled(tileFn, data, w, h, opts = {}) {
  const {
    channels = 1, outChannels = 1,
    tileSize = 256, overlap = 16,
    signal, onProgress,
  } = opts;
  if (!(overlap >= 0 && overlap * 2 < tileSize)) {
    throw new Error(`runTiled: overlap ${overlap} must satisfy 0 ≤ overlap < tileSize/2`);
  }
  if (data.length !== channels * w * h) {
    throw new Error(`runTiled: data length ${data.length} ≠ channels×w×h = ${channels * w * h}`);
  }

  // Whole raster fits in one tile — run once, no blending.
  if (w <= tileSize && h <= tileSize) {
    const tile = new Float32Array(channels * tileSize * tileSize);
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < h; y++) {
        tile.set(data.subarray(c * w * h + y * w, c * w * h + y * w + w),
          c * tileSize * tileSize + y * tileSize);
      }
    }
    const outTile = await tileFn(tile, tileSize, tileSize);
    const out = new Float32Array(outChannels * w * h);
    for (let c = 0; c < outChannels; c++) {
      for (let y = 0; y < h; y++) {
        out.set(outTile.subarray(c * tileSize * tileSize + y * tileSize,
          c * tileSize * tileSize + y * tileSize + w), c * w * h + y * w);
      }
    }
    onProgress?.(1, 1);
    return out;
  }

  const step = tileSize - 2 * overlap; // interior stride
  const xs = [];
  const ys = [];
  for (let x = 0; ; x += step) {
    const x0 = Math.min(x - overlap, w - tileSize);
    xs.push(Math.max(0, x0));
    if (x0 + tileSize >= w) break;
  }
  for (let y = 0; ; y += step) {
    const y0 = Math.min(y - overlap, h - tileSize);
    ys.push(Math.max(0, y0));
    if (y0 + tileSize >= h) break;
  }
  const total = xs.length * ys.length;

  const acc = new Float32Array(outChannels * w * h);
  const weight = new Float32Array(w * h);

  // Tile edges are contaminated by the tileFn's implicit padding (a conv
  // sees zeros beyond the tile). Discard the outer `margin` pixels of every
  // tile side that has a neighbor to cover it, then feather from 0 to 1
  // across the remaining overlap. Sides on the raster border keep full
  // weight (no neighbor exists; whole-image edge effects are inherent).
  const margin = Math.floor(overlap / 2);
  const feather = Math.max(1, overlap - margin);
  const buildRamp = (atStart, atEnd) => {
    const r = new Float32Array(tileSize);
    for (let i = 0; i < tileSize; i++) {
      const dS = atStart ? Infinity : i;                 // dist from cut start edge
      const dE = atEnd ? Infinity : tileSize - 1 - i;    // dist from cut end edge
      const d = Math.min(dS, dE);
      r[i] = d < margin ? 0 : Math.min(1, (d - margin + 1) / (feather + 1));
    }
    return r;
  };

  const tile = new Float32Array(channels * tileSize * tileSize);
  let done = 0;
  for (const ty of ys) {
    const rampY = buildRamp(ty === 0, ty + tileSize >= h);
    for (const tx of xs) {
      const rampX = buildRamp(tx === 0, tx + tileSize >= w);
      if (signal?.aborted) throw new DOMException('runTiled aborted', 'AbortError');

      // Extract (zero-pad right/bottom if raster edge < tileSize — only
      // happens when raster is smaller than tile in one dimension).
      tile.fill(0);
      const cw = Math.min(tileSize, w - tx);
      const ch = Math.min(tileSize, h - ty);
      for (let c = 0; c < channels; c++) {
        for (let y = 0; y < ch; y++) {
          const src = c * w * h + (ty + y) * w + tx;
          tile.set(data.subarray(src, src + cw), c * tileSize * tileSize + y * tileSize);
        }
      }

      const outTile = await tileFn(tile, tileSize, tileSize);

      for (let y = 0; y < ch; y++) {
        const wy = rampY[y];
        if (wy === 0) continue;
        for (let x = 0; x < cw; x++) {
          const wgt = wy * rampX[x];
          if (wgt === 0) continue;
          const p = (ty + y) * w + (tx + x);
          weight[p] += wgt;
          for (let c = 0; c < outChannels; c++) {
            acc[c * w * h + p] += wgt * outTile[c * tileSize * tileSize + y * tileSize + x];
          }
        }
      }

      done++;
      onProgress?.(done, total);
      // Yield so the UI (progress chip, cancel button) stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  for (let p = 0; p < w * h; p++) {
    const wgt = weight[p] || 1;
    for (let c = 0; c < outChannels; c++) acc[c * w * h + p] /= wgt;
  }
  return acc;
}
