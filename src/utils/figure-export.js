/**
 * Figure export utility for SAR imagery.
 * Captures the deck.gl canvas and composites overlays (colorbar, scale bar,
 * metadata annotation) onto a 2D canvas for PNG export.
 */

import { getColormap } from './colormap.js';
import { SAR_COMPOSITES } from './sar-composites.js';

/**
 * Capture the current viewer and export as a PNG figure with overlays.
 *
 * @param {HTMLCanvasElement} glCanvas - The deck.gl WebGL canvas element
 * @param {Object} options
 * @param {string} [options.colormap] - Colormap name (single-band mode)
 * @param {number[]|Object} [options.contrastLimits] - [min,max] or {R,G,B}
 * @param {boolean} [options.useDecibels]
 * @param {string} [options.compositeId] - RGB composite ID or null
 * @param {Object} [options.viewState] - Current deck.gl view state
 * @param {number[]} [options.bounds] - [minX, minY, maxX, maxY]
 * @param {string} [options.filename] - Source filename
 * @param {string} [options.crs] - CRS string (e.g. "EPSG:32610")
 * @returns {Promise<Blob>} PNG blob
 */
export async function exportFigure(glCanvas, options = {}) {
  const {
    colormap = 'grayscale',
    contrastLimits,
    useDecibels = true,
    compositeId = null,
    viewState,
    bounds,
    filename = '',
    crs = '',
  } = options;

  const W = glCanvas.width;
  const H = glCanvas.height;

  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Draw the WebGL canvas content
  ctx.drawImage(glCanvas, 0, 0);

  // DPR-aware font sizing (overlays should look consistent regardless of DPR)
  const dpr = window.devicePixelRatio || 1;
  const scale = (v) => Math.round(v * dpr);

  // Draw overlays
  drawScaleBar(ctx, W, H, viewState, bounds, scale);

  if (compositeId) {
    drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, scale);
  } else {
    drawColormapBar(ctx, W, H, colormap, contrastLimits, useDecibels, scale);
  }

  drawMetadata(ctx, W, H, { filename, crs, compositeId, useDecibels }, scale);

  // Export as PNG blob
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

/**
 * Draw a scale bar overlay on the 2D canvas (bottom-left).
 */
function drawScaleBar(ctx, W, H, viewState, bounds, scale) {
  if (!viewState || !bounds) return;

  const isProjected = Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;
  if (!isProjected) return;

  const pixelsPerMeter = Math.pow(2, viewState.zoom || 0);
  const targetPixels = scale(150);
  const targetMeters = targetPixels / pixelsPerMeter;

  const magnitude = Math.pow(10, Math.floor(Math.log10(targetMeters)));
  const normalized = targetMeters / magnitude;
  let niceNumber;
  if (normalized < 1.5) niceNumber = 1;
  else if (normalized < 3.5) niceNumber = 2;
  else if (normalized < 7.5) niceNumber = 5;
  else niceNumber = 10;

  const scaleMeters = niceNumber * magnitude;
  const scalePixels = scaleMeters * pixelsPerMeter;

  let label;
  if (scaleMeters >= 1000) {
    label = `${(scaleMeters / 1000).toFixed(scaleMeters >= 10000 ? 0 : 1)} km`;
  } else {
    label = `${scaleMeters.toFixed(scaleMeters >= 100 ? 0 : 0)} m`;
  }

  const x = scale(16);
  const y = H - scale(16);
  const barHeight = scale(6);
  const fontSize = scale(13);

  // Background
  const bgPad = scale(8);
  const bgW = scalePixels + bgPad * 2;
  const bgH = barHeight + fontSize + bgPad * 3;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  roundRect(ctx, x - bgPad, y - bgH, bgW, bgH + bgPad, scale(4));
  ctx.fill();

  // Bar
  ctx.fillStyle = 'white';
  ctx.fillRect(x, y - barHeight, scalePixels, barHeight);
  ctx.strokeStyle = 'black';
  ctx.lineWidth = scale(1);
  ctx.strokeRect(x, y - barHeight, scalePixels, barHeight);

  // Label
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x + scalePixels / 2, y - barHeight - scale(4));
}

/**
 * Draw RGB channel legend (top-right).
 */
function drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, scale) {
  const preset = SAR_COMPOSITES[compositeId];
  const title = preset?.name || 'RGB';

  const channels = [
    { key: 'R', color: '#ff4444' },
    { key: 'G', color: '#44ff44' },
    { key: 'B', color: '#4444ff' },
  ];

  const fontSize = scale(12);
  const titleFontSize = scale(13);
  const swatchSize = scale(12);
  const lineHeight = scale(18);
  const pad = scale(10);
  const x = W - scale(20);

  // Measure width
  ctx.font = `bold ${titleFontSize}px monospace`;
  let maxWidth = ctx.measureText(title).width;

  const labels = channels.map(({ key }) => {
    const chDef = preset?.channels?.[key];
    const label = chDef?.label || chDef?.dataset || key;
    const limStr = formatLimit(contrastLimits, key, useDecibels);
    return `${label} ${limStr}`;
  });

  ctx.font = `${fontSize}px monospace`;
  for (const l of labels) {
    maxWidth = Math.max(maxWidth, ctx.measureText(l).width + swatchSize + scale(8));
  }

  const boxW = maxWidth + pad * 2;
  const boxH = titleFontSize + lineHeight * 3 + pad * 2 + scale(4);
  const boxX = x - boxW;
  const boxY = scale(20);

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, boxX, boxY, boxW, boxH, scale(4));
  ctx.fill();

  // Title
  ctx.fillStyle = 'white';
  ctx.font = `bold ${titleFontSize}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, boxX + pad, boxY + pad);

  // Channels
  let cy = boxY + pad + titleFontSize + scale(6);
  for (let i = 0; i < channels.length; i++) {
    const { color } = channels[i];

    // Swatch
    ctx.fillStyle = color;
    roundRect(ctx, boxX + pad, cy + scale(1), swatchSize, swatchSize, scale(2));
    ctx.fill();

    // Label
    ctx.fillStyle = 'white';
    ctx.font = `${fontSize}px monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i], boxX + pad + swatchSize + scale(6), cy);

    cy += lineHeight;
  }
}

/**
 * Draw single-band colormap gradient bar (top-right).
 */
function drawColormapBar(ctx, W, H, colormapName, contrastLimits, useDecibels, scale) {
  const [min, max] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
  const unit = useDecibels ? ' dB' : '';
  const colormapFunc = getColormap(colormapName);

  const barW = scale(20);
  const barH = scale(150);
  const pad = scale(10);
  const fontSize = scale(12);
  const boxW = barW + pad * 2 + scale(50);
  const boxH = barH + pad * 2 + fontSize * 2 + scale(8);
  const boxX = W - scale(20) - boxW;
  const boxY = scale(20);

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, boxX, boxY, boxW, boxH, scale(4));
  ctx.fill();

  // Max label
  ctx.fillStyle = 'white';
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${max.toFixed(1)}${unit}`, boxX + pad, boxY + pad);

  // Gradient bar
  const gradX = boxX + pad;
  const gradY = boxY + pad + fontSize + scale(4);

  for (let y = 0; y < barH; y++) {
    const t = 1 - y / barH;
    const rgb = colormapFunc(t);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(gradX, gradY + y, barW, 1);
  }

  // Min label
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'top';
  ctx.fillText(`${min.toFixed(1)}${unit}`, boxX + pad, gradY + barH + scale(4));
}

/**
 * Draw metadata annotation (bottom-right).
 */
function drawMetadata(ctx, W, H, meta, scale) {
  const { filename, crs, compositeId, useDecibels } = meta;

  const lines = [];
  if (filename) lines.push(filename);
  if (compositeId) {
    const preset = SAR_COMPOSITES[compositeId];
    lines.push(`Composite: ${preset?.name || compositeId}`);
  }
  if (crs) lines.push(crs);
  lines.push(`Scale: ${useDecibels ? 'dB' : 'linear'}`);

  const fontSize = scale(11);
  const lineHeight = scale(15);
  const pad = scale(8);

  ctx.font = `${fontSize}px monospace`;

  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  }

  const boxW = maxWidth + pad * 2;
  const boxH = lines.length * lineHeight + pad * 2;
  const boxX = W - scale(16) - boxW;
  const boxY = H - scale(16) - boxH;

  // Background
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  roundRect(ctx, boxX, boxY, boxW, boxH, scale(4));
  ctx.fill();

  // Text
  ctx.fillStyle = '#ccc';
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], boxX + pad, boxY + pad + i * lineHeight);
  }
}

/**
 * Format contrast limit for a given channel.
 */
function formatLimit(contrastLimits, ch, useDecibels) {
  if (!contrastLimits) return '';
  if (Array.isArray(contrastLimits)) {
    const [min, max] = contrastLimits;
    return useDecibels
      ? `${min.toFixed(1)}–${max.toFixed(1)} dB`
      : `${min.toExponential(1)}–${max.toExponential(1)}`;
  }
  const lim = contrastLimits[ch];
  if (!lim) return '';
  return useDecibels
    ? `${lim[0].toFixed(1)}–${lim[1].toFixed(1)} dB`
    : `${lim[0].toExponential(1)}–${lim[1].toExponential(1)}`;
}

/**
 * Draw a rounded rectangle path.
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Download a Blob as a file.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
