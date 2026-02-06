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
 * @param {number[]} values - Raw float values (will be filtered for valid > 0)
 * @param {boolean} useDecibels - Apply 10*log10 before computing
 * @param {number} numBins - Number of histogram bins
 * @returns {Object|null} {bins, min, max, mean, binWidth, count, p2, p98}
 */
export function computeChannelStats(values, useDecibels = false, numBins = 128) {
  const processed = [];

  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (val <= 0 || isNaN(val)) continue;

    if (useDecibels) {
      processed.push(10 * Math.log10(Math.max(val, 1e-10)));
    } else {
      processed.push(val);
    }
  }

  if (processed.length === 0) return null;

  processed.sort((a, b) => a - b);

  const p2 = processed[Math.floor(0.02 * processed.length)];
  const p98 = processed[Math.min(Math.floor(0.98 * processed.length), processed.length - 1)];
  const min = processed[0];
  const max = processed[processed.length - 1];
  const mean = processed.reduce((a, b) => a + b, 0) / processed.length;

  const binWidth = (max - min) / numBins || 1;
  const bins = new Array(numBins).fill(0);

  for (const val of processed) {
    const idx = Math.floor((val - min) / binWidth);
    bins[Math.max(0, Math.min(numBins - 1, idx))]++;
  }

  return { bins, min, max, mean, binWidth, count: processed.length, p2, p98 };
}

/**
 * Sample tile data from an OrthographicView loader and compute histogram stats.
 * Reads a 3x3 grid of overview tiles for representative coverage.
 *
 * @param {Function} getTile - Tile fetcher ({x, y, z, bbox, quality}) => {data, width, height}
 * @param {number} imgWidth - Full image width in pixels
 * @param {number} imgHeight - Full image height in pixels
 * @param {boolean} useDecibels - Compute stats in dB
 * @param {number} numBins - Histogram bins
 * @returns {Promise<Object|null>} Channel stats or null
 */
export async function sampleViewportStats(getTile, imgWidth, imgHeight, useDecibels = true, numBins = 128) {
  const gridSize = 3;
  const stepX = imgWidth / gridSize;
  const stepY = imgHeight / gridSize;
  const allValues = [];

  for (let ty = 0; ty < gridSize; ty++) {
    for (let tx = 0; tx < gridSize; tx++) {
      const left = tx * stepX;
      const right = (tx + 1) * stepX;
      const worldBottom = imgHeight - (ty + 1) * stepY;
      const worldTop = imgHeight - ty * stepY;

      try {
        const tileData = await getTile({
          x: tx, y: ty, z: 0,
          bbox: { left, top: worldBottom, right, bottom: worldTop },
          quality: 'fast',
        });

        if (tileData && tileData.data) {
          for (let i = 0; i < tileData.data.length; i++) {
            const v = tileData.data[i];
            if (v > 0 && !isNaN(v)) allValues.push(v);
          }
        }
      } catch (e) {
        // Skip failed tiles
      }
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
