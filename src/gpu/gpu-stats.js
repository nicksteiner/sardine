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
import { computeChannelStats } from '../utils/stats.js';

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

  // GPU path: use all data (no stride needed — GPU handles millions of elements)
  if (hasWebGPU() && f32.length > 1024) {
    try {
      const result = await computeHistogramGPU(f32, { useDecibels, numBins });
      return result;
    } catch (err) {
      console.warn('[gpu-stats] GPU histogram failed, falling back to CPU:', err.message);
    }
  }

  // CPU fallback
  return computeChannelStats(values, useDecibels, numBins, stride);
}

/**
 * Check if GPU stats are available.
 */
export function canUseGPUStats() {
  return hasWebGPU();
}
