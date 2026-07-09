/**
 * GPU-accelerated statistics — drop-in replacement for stats.js functions.
 *
 * Falls back to CPU when WebGPU is unavailable.
 *
 * Usage:
 *   import { computeChannelStatsAuto } from './gpu/gpu-stats.js';
 *   const stats = await computeChannelStatsAuto(data, useDecibels, numBins);
 *   // Same return shape as computeChannelStats()
 */

import { hasWebGPU } from './webgpu-device.js';
import { computeHistogramGPU } from './histogram-compute.js';
import { computeChannelStats, sampleViewportStats } from '../utils/stats.js';

/**
 * Compute channel statistics, preferring GPU when available.
 *
 * @param {Float32Array|number[]} values - Raw SAR data
 * @param {boolean} useDecibels - Apply dB conversion
 * @param {number} numBins - Number of histogram bins
 * @param {number} stride - CPU fallback: sample every Nth value
 * @returns {Promise<Object|null>} { bins, min, max, mean, binWidth, count, p2, p98 }
 */
export async function computeChannelStatsAuto(values, useDecibels = true, numBins = 256, stride = 1) {
  // Ensure we have a Float32Array for GPU path
  const f32 = values instanceof Float32Array ? values : new Float32Array(values);

  // GPU path: use all data (no stride needed — GPU handles millions of elements).
  // Note: the WGSL shaders are compiled for 256 bins, so the GPU path always
  // uses the default bin count; the caller's numBins applies to the CPU fallback.
  if (hasWebGPU() && f32.length > 1024) {
    try {
      const result = await computeHistogramGPU(f32, { useDecibels });
      if (result !== null) return result;
      // GPU returned null (e.g. pipeline validation failure) — fall through to CPU
      console.warn('[gpu-stats] GPU histogram returned null, falling back to CPU');
    } catch (err) {
      console.warn('[gpu-stats] GPU histogram failed, falling back to CPU:', err.message);
    }
  }

  // CPU fallback
  return computeChannelStats(values, useDecibels, numBins, stride);
}

/**
 * Viewport-stats sampler, preferring GPU for the binning/stats math.
 *
 * Tile gathering stays on the CPU (same 3×3 grid of getTile() reads as
 * sampleViewportStats). When WebGPU is available, raw tile data is
 * concatenated and handed to the WebGPU two-pass histogram (nodata 0/NaN is
 * masked in the compute shader). When WebGPU is unavailable — or the GPU
 * dispatch fails — this delegates to the CPU sampleViewportStats() so the
 * result is identical to calling it directly.
 *
 * Same signature and return shape as sampleViewportStats().
 *
 * @returns {Promise<Object|null>} { bins, min, max, mean, binWidth, count, p2, p98 }
 */
export async function sampleViewportStatsAuto(
  getTile, regionWidth, regionHeight, useDecibels = true, numBins = 128,
  originX = 0, originY = 0, fullHeight = undefined, onProgress = null,
) {
  if (!hasWebGPU()) {
    // CPU fallback — byte-identical to the pre-GPU behavior.
    return sampleViewportStats(
      getTile, regionWidth, regionHeight, useDecibels, numBins,
      originX, originY, fullHeight, onProgress,
    );
  }

  // Gather the same 3×3 tile grid as sampleViewportStats (CPU I/O).
  const gridSize = 3;
  const totalTiles = gridSize * gridSize;
  const stepX = regionWidth / gridSize;
  const stepY = regionHeight / gridSize;

  const tilePromises = [];
  for (let ty = 0; ty < gridSize; ty++) {
    for (let tx = 0; tx < gridSize; tx++) {
      tilePromises.push(getTile({
        x: tx, y: ty, z: 0,
        bbox: {
          left: originX + tx * stepX,
          right: originX + (tx + 1) * stepX,
          top: originY + ty * stepY,
          bottom: originY + (ty + 1) * stepY,
        },
      }));
    }
  }

  const results = await Promise.allSettled(tilePromises);
  const tiles = [];
  let totalLength = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value && r.value.data) {
      tiles.push(r.value.data);
      totalLength += r.value.data.length;
    }
    if (onProgress) onProgress(i + 1, totalTiles);
  }
  if (totalLength === 0) return null;

  // Concatenate raw tile data — full resolution, no stride (GPU handles it).
  const all = new Float32Array(totalLength);
  let offset = 0;
  for (const t of tiles) {
    all.set(t, offset);
    offset += t.length;
  }

  try {
    // GPU shaders are compiled for 256 bins — always use the default bin count.
    const result = await computeHistogramGPU(all, { useDecibels });
    if (result !== null) return result;
    console.warn('[gpu-stats] GPU viewport histogram returned null, falling back to CPU');
  } catch (err) {
    console.warn('[gpu-stats] GPU viewport histogram failed, falling back to CPU:', err.message);
  }

  // GPU dispatch failed — CPU fallback (tiles are typically cached by the loader).
  return sampleViewportStats(
    getTile, regionWidth, regionHeight, useDecibels, numBins,
    originX, originY, fullHeight, onProgress,
  );
}

/**
 * Check if GPU stats are available.
 */
export function canUseGPUStats() {
  return hasWebGPU();
}
