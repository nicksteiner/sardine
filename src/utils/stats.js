/**
 * Statistics utilities for SAR imagery
 * Provides auto contrast limits, histogram computation, and data analysis
 */

/**
 * Compute basic statistics from SAR data
 * @param {Float32Array|number[]} data - Raw SAR data
 * @param {boolean} useDecibels - Whether to compute stats in dB
 * @returns {Object} Statistics object with min, max, mean, std, median
 */
export function computeStats(data, useDecibels = true) {
  // Pass 1: convert + cache valid values, track min/max/sum/sqSum
  let min = Infinity, max = -Infinity, sum = 0, sqSum = 0, count = 0;

  // Cache converted values to avoid recomputing dB in pass 2
  const cached = new Float32Array(data.length);

  for (let i = 0; i < data.length; i++) {
    let val = data[i];
    if (isNaN(val)) continue;
    if (useDecibels) {
      if (val <= 0) continue;
      val = 10 * Math.log10(val);
    } else {
      if (val === 0) continue;
    }
    cached[count] = val;
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
    sqSum += val * val;
    count++;
  }

  if (count === 0) {
    return { min: 0, max: 0, mean: 0, std: 0, median: 0 };
  }

  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sqSum / count - mean * mean));

  // Pass 2: bin cached values (no dB recomputation)
  const numBins = 256;
  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);

  for (let i = 0; i < count; i++) {
    const idx = Math.floor((cached[i] - min) / binWidth);
    bins[Math.max(0, Math.min(numBins - 1, idx))]++;
  }

  const medianTarget = Math.floor(count / 2);
  let cumulative = 0;
  let median = mean;
  for (let b = 0; b < numBins; b++) {
    cumulative += bins[b];
    if (cumulative > medianTarget) {
      median = min + (b + 0.5) * binWidth;
      break;
    }
  }

  return { min, max, mean, std, median, count };
}

/**
 * Compute contrast limits automatically from data
 * Uses percentile-based clipping for robust estimation
 * @param {Float32Array|number[]} data - Raw SAR data
 * @param {boolean} useDecibels - Whether to compute limits in dB
 * @param {number} lowPercentile - Lower percentile (default 2)
 * @param {number} highPercentile - Upper percentile (default 98)
 * @returns {number[]} [min, max] contrast limits
 */
export function autoContrastLimits(
  data,
  useDecibels = true,
  lowPercentile = 2,
  highPercentile = 98
) {
  // Pass 1: convert + cache valid values, track min/max
  let min = Infinity, max = -Infinity, count = 0;
  const cached = new Float32Array(data.length);

  for (let i = 0; i < data.length; i++) {
    let val = data[i];
    if (isNaN(val)) continue;
    if (useDecibels) {
      if (val <= 0) continue;
      val = 10 * Math.log10(val);
    } else {
      if (val === 0) continue;
    }
    cached[count] = val;
    if (val < min) min = val;
    if (val > max) max = val;
    count++;
  }

  if (count === 0) {
    return useDecibels ? [-30, 0] : [0, 1];
  }

  // Pass 2: bin cached values (no dB recomputation)
  const numBins = 256;
  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);

  for (let i = 0; i < count; i++) {
    const idx = Math.floor((cached[i] - min) / binWidth);
    bins[Math.max(0, Math.min(numBins - 1, idx))]++;
  }

  const lowTarget = Math.floor((lowPercentile / 100) * count);
  const highTarget = Math.min(Math.floor((highPercentile / 100) * count), count - 1);
  let cumulative = 0;
  let pLow = min, pHigh = max;
  let foundLow = false;

  for (let b = 0; b < numBins; b++) {
    cumulative += bins[b];
    if (!foundLow && cumulative > lowTarget) {
      pLow = min + b * binWidth;
      foundLow = true;
    }
    if (cumulative > highTarget) {
      pHigh = min + (b + 1) * binWidth;
      break;
    }
  }

  return [pLow, pHigh];
}

/**
 * Compute histogram of SAR data
 * @param {Float32Array|number[]} data - Raw SAR data
 * @param {boolean} useDecibels - Whether to compute histogram in dB
 * @param {number} numBins - Number of histogram bins (default 256)
 * @param {number[]} range - Optional [min, max] range for histogram
 * @returns {Object} Histogram object with bins, counts, edges
 */
export function computeHistogram(data, useDecibels = true, numBins = 256, range = null) {
  let min, max;
  let cached = null;
  let count = 0;

  if (range) {
    [min, max] = range;
  } else {
    // Pass 1: convert + cache valid values, track min/max
    cached = new Float32Array(data.length);
    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      let val = data[i];
      if (isNaN(val)) continue;
      if (useDecibels) {
        if (val <= 0) continue;
        val = 10 * Math.log10(val);
      } else {
        if (val === 0) continue;
      }
      cached[count] = val;
      if (val < min) min = val;
      if (val > max) max = val;
      count++;
    }
  }

  if (min === Infinity) {
    return {
      bins: new Array(numBins).fill(0),
      edges: new Array(numBins + 1).fill(0),
      min: 0,
      max: 0,
    };
  }

  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);
  const edges = new Array(numBins + 1);

  for (let i = 0; i <= numBins; i++) {
    edges[i] = min + i * binWidth;
  }

  let totalCount = 0;
  if (cached) {
    // Use cached values (no dB recomputation)
    for (let i = 0; i < count; i++) {
      const binIdx = Math.floor((cached[i] - min) / binWidth);
      bins[Math.max(0, Math.min(numBins - 1, binIdx))]++;
    }
    totalCount = count;
  } else {
    // Range was provided — must convert on the fly
    for (let i = 0; i < data.length; i++) {
      let val = data[i];
      if (isNaN(val)) continue;
      if (useDecibels) {
        if (val <= 0) continue;
        val = 10 * Math.log10(val);
      } else {
        if (val === 0) continue;
      }
      const binIdx = Math.floor((val - min) / binWidth);
      bins[Math.max(0, Math.min(numBins - 1, binIdx))]++;
      totalCount++;
    }
  }

  return { bins, edges, min, max, binWidth, totalCount };
}

/**
 * Compute statistics from a sample of tiles (for large datasets)
 * @param {Function} getTile - Tile fetcher function
 * @param {number} sampleSize - Number of tiles to sample
 * @param {boolean} useDecibels - Whether to compute stats in dB
 * @returns {Promise<Object>} Combined statistics
 */
export async function sampleTileStats(getTile, sampleSize = 9, useDecibels = true) {
  // Collect values with streaming min/max/sum to avoid O(n log n) sort
  let min = Infinity, max = -Infinity, sum = 0, sqSum = 0, count = 0;
  const numBins = 256;
  // We'll do a two-pass approach: first collect all values for min/max, then bin
  const allValues = [];
  const gridSize = Math.ceil(Math.sqrt(sampleSize));

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (count >= sampleSize * 65536) break;
      try {
        const tile = await getTile({ x, y, z: 2 });
        if (tile && tile.data) {
          for (let i = 0; i < tile.data.length; i++) {
            let val = tile.data[i];
            if (isNaN(val)) continue;
            if (useDecibels) {
              if (val <= 0) continue;
              val = 10 * Math.log10(val);
            } else {
              if (val === 0) continue;
            }
            if (val < min) min = val;
            if (val > max) max = val;
            sum += val;
            sqSum += val * val;
            allValues.push(val);
            count++;
          }
        }
      } catch (e) {
        continue;
      }
    }
  }

  if (count === 0) {
    return {
      contrastLimits: useDecibels ? [-30, 0] : [0, 1],
      stats: { min: 0, max: 0, mean: 0, std: 0, median: 0, count: 0 },
    };
  }

  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sqSum / count - mean * mean));

  // Bin-walk CDF for percentiles and median
  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);
  for (const val of allValues) {
    const idx = Math.floor((val - min) / binWidth);
    bins[Math.max(0, Math.min(numBins - 1, idx))]++;
  }

  const p2Target = Math.floor(0.02 * count);
  const medTarget = Math.floor(count / 2);
  const p98Target = Math.min(Math.floor(0.98 * count), count - 1);
  let cumulative = 0, p2 = min, median = mean, p98 = max;
  let foundP2 = false, foundMed = false;

  for (let b = 0; b < numBins; b++) {
    cumulative += bins[b];
    if (!foundP2 && cumulative > p2Target) { p2 = min + b * binWidth; foundP2 = true; }
    if (!foundMed && cumulative > medTarget) { median = min + (b + 0.5) * binWidth; foundMed = true; }
    if (cumulative > p98Target) { p98 = min + (b + 1) * binWidth; break; }
  }

  return {
    contrastLimits: [p2, p98],
    stats: { min, max, mean, std, median, count },
  };
}

/**
 * Compute histogram and percentile statistics for a single channel of values.
 *
 * Uses O(n) two-pass bin-then-walk-CDF instead of O(n log n) sort for percentiles.
 * Pass 1: find min/max/mean and bin values. Pass 2: walk CDF to find p2/p98.
 *
 * @param {number[]} values - Raw float values (will be filtered for valid > 0)
 * @param {boolean} useDecibels - Apply 10*log10 before computing
 * @param {number} numBins - Number of histogram bins
 * @param {number} stride - Sample every Nth value (1 = all, 4 = every 4th)
 * @returns {Object|null} {bins, min, max, mean, binWidth, count, p2, p98}
 */
export function computeChannelStats(values, useDecibels = false, numBins = 128, stride = 1) {
  // Pass 1: find min/max/sum/count in one scan
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < values.length; i += stride) {
    let val = values[i];
    if (isNaN(val)) continue;
    if (useDecibels) {
      if (val <= 0) continue; // dB needs positive input
      val = 10 * Math.log10(Math.max(val, 1e-10));
    } else {
      if (val === 0) continue; // skip exact zero (nodata)
    }
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
    count++;
  }

  if (count === 0) return null;

  const mean = sum / count;
  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);

  // Pass 2: bin all values
  for (let i = 0; i < values.length; i += stride) {
    let val = values[i];
    if (isNaN(val)) continue;
    if (useDecibels) {
      if (val <= 0) continue;
      val = 10 * Math.log10(Math.max(val, 1e-10));
    } else {
      if (val === 0) continue;
    }
    const idx = Math.floor((val - min) / binWidth);
    bins[Math.max(0, Math.min(numBins - 1, idx))]++;
  }

  // Walk CDF to find p2/p98
  const p2Target = Math.floor(0.02 * count);
  const p98Target = Math.min(Math.floor(0.98 * count), count - 1);
  let cumulative = 0;
  let p2 = min;
  let p98 = max;
  let foundP2 = false;

  for (let b = 0; b < numBins; b++) {
    cumulative += bins[b];
    if (!foundP2 && cumulative > p2Target) {
      p2 = min + b * binWidth;
      foundP2 = true;
    }
    if (cumulative > p98Target) {
      p98 = min + (b + 1) * binWidth;
      break;
    }
  }

  return { bins, min, max, mean, binWidth, count, p2, p98 };
}

/**
 * Sample tile data from an OrthographicView loader and compute histogram stats.
 * Reads a 3x3 grid of tiles covering the specified region.
 *
 * @param {Function} getTile - Tile fetcher ({x, y, z, bbox}) => {data, width, height}
 * @param {number} regionWidth - Width of the region to sample (pixels/world-units)
 * @param {number} regionHeight - Height of the region to sample
 * @param {boolean} useDecibels - Compute stats in dB
 * @param {number} numBins - Histogram bins
 * @param {number} originX - Left edge of the region (default 0 for global)
 * @param {number} originY - Top edge of the region (default 0 for global)
 * @param {number} fullHeight - Full image height for Y-flip (default = originY + regionHeight)
 * @returns {Promise<Object|null>} Channel stats or null
 */
export async function sampleViewportStats(
  getTile, regionWidth, regionHeight, useDecibels = true, numBins = 128,
  originX = 0, originY = 0, fullHeight = undefined, onProgress = null,
) {
  const imgH = fullHeight !== undefined ? fullHeight : originY + regionHeight;
  const gridSize = 3;
  const totalTiles = gridSize * gridSize;
  const stepX = regionWidth / gridSize;
  const stepY = regionHeight / gridSize;
  const allValues = [];

  // Build tile requests — pass world-coordinate bboxes directly.
  // getTile handles world→pixel conversion internally.
  const tileRequests = [];
  for (let ty = 0; ty < gridSize; ty++) {
    for (let tx = 0; tx < gridSize; tx++) {
      const left = originX + tx * stepX;
      const right = originX + (tx + 1) * stepX;
      const top = originY + ty * stepY;
      const bottom = originY + (ty + 1) * stepY;

      tileRequests.push({
        promise: getTile({
          x: tx, y: ty, z: 0,
          bbox: { left, top, right, bottom },
        }),
        tx, ty,
      });
    }
  }

  // Fetch all tiles in parallel
  const results = await Promise.allSettled(tileRequests.map(r => r.promise));

  // Process results and collect values
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value && result.value.data) {
      const tileData = result.value;
      // Adaptive stride: use larger stride for big tiles
      const stride = Math.max(4, Math.floor(tileData.data.length / 50000));
      for (let j = 0; j < tileData.data.length; j += stride) {
        const v = tileData.data[j];
        // For dB mode: skip zeros/NaN (nodata) but keep positive values
        // For linear mode: keep all finite non-NaN values (phase/offset data can be negative)
        if (isNaN(v)) continue;
        if (useDecibels && v <= 0) continue; // dB needs positive input
        if (!useDecibels && v === 0) continue; // skip exact zero (nodata)
        allValues.push(v);
      }
    }
    if (onProgress) onProgress(i + 1, totalTiles);
  }

  if (allValues.length === 0) return null;
  return computeChannelStats(allValues, useDecibels, numBins);
}

export default {
  computeStats,
  autoContrastLimits,
  computeHistogram,
  sampleTileStats,
  computeChannelStats,
  sampleViewportStats,
};
