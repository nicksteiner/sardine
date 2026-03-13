/**
 * IncidenceScatter — Backscatter vs Incidence Angle scatter plot.
 *
 * Samples backscatter values and corresponding incidence angles from the
 * metadata cube, renders a 2D density scatter plot using Canvas 2D.
 * Useful for identifying near/far range behavior and selecting mask thresholds.
 */

import React, { useRef, useEffect, useMemo } from 'react';

const PLOT_W = 280;
const PLOT_H = 180;
const MARGIN = { top: 8, right: 8, bottom: 28, left: 40 };
const INNER_W = PLOT_W - MARGIN.left - MARGIN.right;
const INNER_H = PLOT_H - MARGIN.top - MARGIN.bottom;

/**
 * Sample backscatter and incidence angle data for the scatter plot.
 *
 * @param {Object} imageData — loaded GCOV data with getTile, metadataCube, xCoords, yCoords
 * @param {number} maxSamples — max number of points
 * @returns {Promise<{angles: Float32Array, values: Float32Array}>}
 */
export async function sampleScatterData(imageData, maxSamples = 5000) {
  if (!imageData?.getTile || !imageData?.metadataCube || !imageData?.xCoords || !imageData?.yCoords) {
    return null;
  }

  const { width, height, bounds, metadataCube, xCoords, yCoords } = imageData;
  if (!bounds) return null;

  // Sample a grid of points across the image
  const gridSize = Math.ceil(Math.sqrt(maxSamples));
  const stepX = Math.max(1, Math.floor(width / gridSize));
  const stepY = Math.max(1, Math.floor(height / gridSize));

  // Fetch a single large tile covering the full extent
  const [bMinX, bMinY, bMaxX, bMaxY] = bounds;
  const sampleSize = Math.min(512, width, height);

  let tile;
  try {
    tile = await imageData.getTile({
      x: 0, y: 0, z: 0,
      bbox: { left: bMinX, top: bMinY, right: bMaxX, bottom: bMaxY },
      tileSize: sampleSize,
    });
  } catch (e) {
    return null;
  }

  if (!tile?.data) return null;

  const tileW = tile.width || sampleSize;
  const tileH = tile.height || sampleSize;
  const angles = [];
  const values = [];

  // Sub-sample the tile and look up incidence angles
  const sStep = Math.max(1, Math.floor(tileW * tileH / maxSamples));
  for (let i = 0; i < tileW * tileH; i += sStep) {
    const val = tile.data[i];
    if (val === 0 || isNaN(val)) continue;

    // Map tile pixel to image pixel, then to world coordinate
    const tileCol = i % tileW;
    const tileRow = Math.floor(i / tileW);
    const imgCol = Math.round((tileCol / tileW) * (width - 1));
    const imgRow = Math.round((tileRow / tileH) * (height - 1));

    if (imgCol >= xCoords.length || imgRow >= yCoords.length) continue;

    const easting = xCoords[imgCol];
    const northing = yCoords[imgRow];
    const angle = metadataCube.getIncidenceAngle(easting, northing);
    if (angle === null || isNaN(angle)) continue;

    // Convert backscatter to dB
    const dB = 10 * Math.log10(Math.max(val, 1e-10));
    if (!isFinite(dB)) continue;

    angles.push(angle);
    values.push(dB);
  }

  return {
    angles: new Float32Array(angles),
    values: new Float32Array(values),
    count: angles.length,
  };
}

/**
 * IncidenceScatter component — renders a scatter plot of backscatter vs incidence angle.
 */
export function IncidenceScatter({
  scatterData,
  angleMin = 30,
  angleMax = 47,
  onAngleRangeChange,
  style = {},
}) {
  const canvasRef = useRef(null);

  // Compute data bounds
  const dataBounds = useMemo(() => {
    if (!scatterData?.count) return null;
    const { angles, values } = scatterData;
    let aMin = Infinity, aMax = -Infinity;
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < angles.length; i++) {
      if (angles[i] < aMin) aMin = angles[i];
      if (angles[i] > aMax) aMax = angles[i];
      if (values[i] < vMin) vMin = values[i];
      if (values[i] > vMax) vMax = values[i];
    }
    return { aMin, aMax, vMin, vMax };
  }, [scatterData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scatterData?.count || !dataBounds) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PLOT_W * dpr;
    canvas.height = PLOT_H * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, PLOT_W, PLOT_H);

    const { aMin, aMax, vMin, vMax } = dataBounds;
    const aRange = aMax - aMin || 1;
    const vRange = vMax - vMin || 1;

    // 2D density histogram for rendering
    const bins = 64;
    const density = new Uint32Array(bins * bins);
    const { angles, values } = scatterData;

    for (let i = 0; i < angles.length; i++) {
      const bx = Math.min(bins - 1, Math.floor(((angles[i] - aMin) / aRange) * bins));
      const by = Math.min(bins - 1, Math.floor(((values[i] - vMin) / vRange) * bins));
      density[by * bins + bx]++;
    }

    // Find max density for normalization
    let maxDensity = 0;
    for (let i = 0; i < density.length; i++) {
      if (density[i] > maxDensity) maxDensity = density[i];
    }

    // Draw density plot
    const cellW = INNER_W / bins;
    const cellH = INNER_H / bins;
    for (let by = 0; by < bins; by++) {
      for (let bx = 0; bx < bins; bx++) {
        const count = density[by * bins + bx];
        if (count === 0) continue;

        const t = Math.sqrt(count / maxDensity); // sqrt for perceptual scaling
        // Viridis-like: dark purple → teal → yellow
        const r = Math.round(68 + t * 185);
        const g = Math.round(1 + t * 220);
        const b = Math.round(84 + (1 - t) * 100);
        ctx.fillStyle = `rgb(${r},${g},${b})`;

        const px = MARGIN.left + bx * cellW;
        const py = MARGIN.top + (bins - 1 - by) * cellH; // flip Y (dB increases up)
        ctx.fillRect(px, py, Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    // Draw mask threshold lines
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);

    const minLineX = MARGIN.left + ((angleMin - aMin) / aRange) * INNER_W;
    const maxLineX = MARGIN.left + ((angleMax - aMin) / aRange) * INNER_W;

    if (minLineX >= MARGIN.left && minLineX <= MARGIN.left + INNER_W) {
      ctx.beginPath();
      ctx.moveTo(minLineX, MARGIN.top);
      ctx.lineTo(minLineX, MARGIN.top + INNER_H);
      ctx.stroke();
    }
    if (maxLineX >= MARGIN.left && maxLineX <= MARGIN.left + INNER_W) {
      ctx.beginPath();
      ctx.moveTo(maxLineX, MARGIN.top);
      ctx.lineTo(maxLineX, MARGIN.top + INNER_H);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Shade masked regions
    ctx.fillStyle = 'rgba(255, 50, 50, 0.08)';
    if (minLineX > MARGIN.left) {
      ctx.fillRect(MARGIN.left, MARGIN.top, minLineX - MARGIN.left, INNER_H);
    }
    if (maxLineX < MARGIN.left + INNER_W) {
      ctx.fillRect(maxLineX, MARGIN.top, MARGIN.left + INNER_W - maxLineX, INNER_H);
    }

    // Axes
    ctx.strokeStyle = '#3a5f8f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, MARGIN.top);
    ctx.lineTo(MARGIN.left, MARGIN.top + INNER_H);
    ctx.lineTo(MARGIN.left + INNER_W, MARGIN.top + INNER_H);
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#8899aa';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';

    // X axis labels (incidence angle)
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const angle = aMin + (i / xTicks) * aRange;
      const px = MARGIN.left + (i / xTicks) * INNER_W;
      ctx.fillText(`${angle.toFixed(0)}°`, px, PLOT_H - 4);
    }

    // Y axis labels (backscatter dB)
    ctx.textAlign = 'right';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const dB = vMin + (i / yTicks) * vRange;
      const py = MARGIN.top + INNER_H - (i / yTicks) * INNER_H;
      ctx.fillText(`${dB.toFixed(0)}`, MARGIN.left - 3, py + 3);
    }

    // Axis titles
    ctx.fillStyle = '#6688aa';
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Incidence Angle', MARGIN.left + INNER_W / 2, PLOT_H - 14);

    ctx.save();
    ctx.translate(8, MARGIN.top + INNER_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Backscatter (dB)', 0, 0);
    ctx.restore();

    // Point count
    ctx.fillStyle = '#556677';
    ctx.font = '7px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`n=${scatterData.count}`, PLOT_W - MARGIN.right, MARGIN.top + 8);
  }, [scatterData, dataBounds, angleMin, angleMax]);

  if (!scatterData?.count) {
    return (
      <div style={{
        fontSize: '0.7rem', color: 'var(--text-muted)',
        padding: '8px', textAlign: 'center', ...style,
      }}>
        No incidence angle data available
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: PLOT_W, height: PLOT_H,
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--sardine-border)',
        ...style,
      }}
    />
  );
}
