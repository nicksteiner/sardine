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
  const values = [];

  for (let i = 0; i < data.length; i++) {
    let val = data[i];
    if (val === 0 || isNaN(val)) continue; // Skip no-data

    if (useDecibels) {
      val = 10 * Math.log10(Math.max(val, 1e-10));
    }
    values.push(val);
  }

  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, std: 0, median: 0 };
  }

  values.sort((a, b) => a - b);

  const min = values[0];
  const max = values[values.length - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const median = values[Math.floor(values.length / 2)];

  // Standard deviation
  const sqDiffSum = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
  const std = Math.sqrt(sqDiffSum / values.length);

  return { min, max, mean, std, median, count: values.length };
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
  const values = [];

  for (let i = 0; i < data.length; i++) {
    let val = data[i];
    if (val === 0 || isNaN(val)) continue; // Skip no-data

    if (useDecibels) {
      val = 10 * Math.log10(Math.max(val, 1e-10));
    }
    values.push(val);
  }

  if (values.length === 0) {
    return useDecibels ? [-30, 0] : [0, 1];
  }

  values.sort((a, b) => a - b);

  const lowIdx = Math.floor((lowPercentile / 100) * values.length);
  const highIdx = Math.floor((highPercentile / 100) * values.length);

  const min = values[lowIdx];
  const max = values[Math.min(highIdx, values.length - 1)];

  return [min, max];
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
  const values = [];

  for (let i = 0; i < data.length; i++) {
    let val = data[i];
    if (val === 0 || isNaN(val)) continue;

    if (useDecibels) {
      val = 10 * Math.log10(Math.max(val, 1e-10));
    }
    values.push(val);
  }

  if (values.length === 0) {
    return {
      bins: new Array(numBins).fill(0),
      edges: new Array(numBins + 1).fill(0),
      min: 0,
      max: 0,
    };
  }

  let min, max;
  if (range) {
    [min, max] = range;
  } else {
    values.sort((a, b) => a - b);
    min = values[0];
    max = values[values.length - 1];
  }

  const binWidth = (max - min) / numBins;
  const bins = new Array(numBins).fill(0);
  const edges = new Array(numBins + 1);

  for (let i = 0; i <= numBins; i++) {
    edges[i] = min + i * binWidth;
  }

  for (const val of values) {
    const binIdx = Math.floor((val - min) / binWidth);
    const clampedIdx = Math.max(0, Math.min(numBins - 1, binIdx));
    bins[clampedIdx]++;
  }

  return { bins, edges, min, max, binWidth, totalCount: values.length };
}

/**
 * Compute statistics from a sample of tiles (for large datasets)
 * @param {Function} getTile - Tile fetcher function
 * @param {number} sampleSize - Number of tiles to sample
 * @param {boolean} useDecibels - Whether to compute stats in dB
 * @returns {Promise<Object>} Combined statistics
 */
export async function sampleTileStats(getTile, sampleSize = 9, useDecibels = true) {
  const allValues = [];
  const gridSize = Math.ceil(Math.sqrt(sampleSize));

  // Sample tiles from a grid pattern
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (allValues.length >= sampleSize * 65536) break;

      try {
        const tile = await getTile({ x, y, z: 2 }); // Use zoom level 2 for overview
        if (tile && tile.data) {
          for (let i = 0; i < tile.data.length; i++) {
            let val = tile.data[i];
            if (val === 0 || isNaN(val)) continue;

            if (useDecibels) {
              val = 10 * Math.log10(Math.max(val, 1e-10));
            }
            allValues.push(val);
          }
        }
      } catch (e) {
        // Skip failed tiles
        continue;
      }
    }
  }

  if (allValues.length === 0) {
    return {
      contrastLimits: useDecibels ? [-30, 0] : [0, 1],
      stats: { min: 0, max: 0, mean: 0, std: 0, median: 0, count: 0 },
    };
  }

  allValues.sort((a, b) => a - b);

  const min = allValues[0];
  const max = allValues[allValues.length - 1];
  const sum = allValues.reduce((a, b) => a + b, 0);
  const mean = sum / allValues.length;
  const median = allValues[Math.floor(allValues.length / 2)];

  const sqDiffSum = allValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0);
  const std = Math.sqrt(sqDiffSum / allValues.length);

  // Percentile-based contrast limits
  const lowIdx = Math.floor(0.02 * allValues.length);
  const highIdx = Math.floor(0.98 * allValues.length);
  const contrastLimits = [allValues[lowIdx], allValues[highIdx]];

  return {
    contrastLimits,
    stats: { min, max, mean, std, median, count: allValues.length },
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
    if (val <= 0 || isNaN(val)) continue;
    if (useDecibels) val = 10 * Math.log10(Math.max(val, 1e-10));
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
    if (val <= 0 || isNaN(val)) continue;
    if (useDecibels) val = 10 * Math.log10(Math.max(val, 1e-10));
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
  let done = 0;

  for (let ty = 0; ty < gridSize; ty++) {
    for (let tx = 0; tx < gridSize; tx++) {
      const left = originX + tx * stepX;
      const right = originX + (tx + 1) * stepX;
      const worldBottom = imgH - (originY + (ty + 1) * stepY);
      const worldTop = imgH - (originY + ty * stepY);

      try {
        const tileData = await getTile({
          x: tx, y: ty, z: 0,
          bbox: { left, top: worldBottom, right, bottom: worldTop },
        });

        if (tileData && tileData.data) {
          // Subsample every 4th pixel within each tile for efficiency
          for (let i = 0; i < tileData.data.length; i += 4) {
            const v = tileData.data[i];
            if (v > 0 && !isNaN(v)) allValues.push(v);
          }
        }
      } catch (e) {
        // Skip failed tiles
      }

      done++;
      if (onProgress) onProgress(done, totalTiles);
    }
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
