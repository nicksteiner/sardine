/**
 * Figure export utility for SAR imagery.
 * Captures the deck.gl canvas and composites themed overlays onto a 2D canvas
 * for PNG export.
 *
 * Overlays:
 *   1. 2px figure border (--sardine-border)
 *   2. Coordinate grid with tick labels
 *   3. Corner coordinate pills
 *   4. Scale bar (--sardine-cyan bar, panel pill background)
 *   5. RGB legend with semantic polarization colors  OR  colormap bar
 *   6. Metadata panel with label:value pairs and semantic colors
 *   7. SARdine branding badge (top-left)
 */

import { getColormap } from './colormap.js';
import { applyStretch } from './stretch.js';
import { SAR_COMPOSITES } from './sar-composites.js';
import {
  THEME,
  CHANNEL_COLORS,
  isProjectedBounds,
  computeVisibleExtent,
  niceInterval,
  formatTickValue,
  formatCoord,
  formatExtent,
  computeScaleBar,
  roundRect,
} from './geo-overlays.js';

// ── Font helper ─────────────────────────────────────────────────────────────

const FONT_MONO = "'JetBrains Mono', 'Fira Code', 'Consolas', monospace";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Capture the current viewer and export as a PNG figure with overlays.
 *
 * @param {HTMLCanvasElement} glCanvas - The deck.gl WebGL canvas element
 * @param {Object} options
 * @param {string}   [options.colormap]        - Colormap name (single-band)
 * @param {number[]|Object} [options.contrastLimits] - [min,max] or {R,G,B}
 * @param {boolean}  [options.useDecibels]
 * @param {string}   [options.compositeId]     - RGB composite ID or null
 * @param {Object}   [options.viewState]       - Current deck.gl view state
 * @param {number[]} [options.bounds]          - [minX,minY,maxX,maxY]
 * @param {string}   [options.filename]        - Source filename
 * @param {string}   [options.crs]             - CRS string (e.g. "EPSG:32610")
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

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Draw the WebGL canvas content
  ctx.drawImage(glCanvas, 0, 0);

  // DPR-aware sizing
  const dpr = window.devicePixelRatio || 1;
  const s = (v) => Math.round(v * dpr);

  const projected = isProjectedBounds(bounds);

  // 1. Figure border
  drawBorder(ctx, W, H, s);

  // 2. Coordinate grid + tick labels
  drawCoordinateGrid(ctx, W, H, viewState, bounds, projected, s);

  // 3. Corner coordinates
  drawCornerCoordinates(ctx, W, H, viewState, projected, s);

  // 4. Scale bar (bottom-left)
  drawScaleBar(ctx, W, H, viewState, bounds, projected, s);

  // 5. Legend (top-right)
  if (compositeId) {
    drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, s);
  } else {
    drawColormapBar(ctx, W, H, colormap, contrastLimits, useDecibels, s);
  }

  // 6. Metadata panel (bottom-right)
  drawMetadata(ctx, W, H, {
    filename, crs, compositeId, useDecibels, viewState, bounds, projected,
  }, s);

  // 7. SARdine branding (top-left)
  drawBranding(ctx, W, H, s);

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}

// ── 1. Figure border ────────────────────────────────────────────────────────

function drawBorder(ctx, W, H, s) {
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = s(2);
  ctx.strokeRect(s(1), s(1), W - s(2), H - s(2));
}

// ── 2. Coordinate grid ─────────────────────────────────────────────────────

function drawCoordinateGrid(ctx, W, H, viewState, bounds, projected, s) {
  if (!viewState || !bounds) return;

  const extent = computeVisibleExtent(viewState, W, H);
  const ppu = extent.pixelsPerUnit;
  const [cx, cy] = viewState.target || [0, 0];

  const toX = (wx) => (wx - cx) * ppu + W / 2;
  const toY = (wy) => (wy - cy) * ppu + H / 2;

  const dx = niceInterval(extent.width, 5);
  const dy = niceInterval(extent.height, 5);

  // Gridlines
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.35)';
  ctx.lineWidth = s(1);
  ctx.setLineDash([s(4), s(4)]);

  const tickFontSize = s(10);
  const tickPad = s(5);

  // Vertical gridlines
  const xStart = Math.ceil(extent.minX / dx) * dx;
  for (let wx = xStart; wx <= extent.maxX; wx += dx) {
    const px = toX(wx);
    if (px < s(2) || px > W - s(2)) continue;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();

    // Tick label at bottom
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `${tickFontSize}px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(90, 112, 153, 0.70)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatTickValue(wx, projected), px, H - tickPad);
    ctx.restore();
  }

  // Horizontal gridlines
  const yStart = Math.ceil(extent.minY / dy) * dy;
  for (let wy = yStart; wy <= extent.maxY; wy += dy) {
    const py = toY(wy);
    if (py < s(2) || py > H - s(2)) continue;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(W, py);
    ctx.stroke();

    // Tick label at left
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `${tickFontSize}px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(90, 112, 153, 0.70)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatTickValue(wy, projected), tickPad, py);
    ctx.restore();
  }

  ctx.setLineDash([]);
}

// ── 3. Corner coordinates ───────────────────────────────────────────────────

function drawCornerCoordinates(ctx, W, H, viewState, projected, s) {
  if (!viewState) return;

  const extent = computeVisibleExtent(viewState, W, H);
  // Only show bottom-right corner coordinate
  const corners = [
    { wx: extent.maxX, wy: extent.minY, align: 'right', baseline: 'bottom', px: W - s(10), py: H - s(10) },
  ];

  const fontSize = s(9);
  const pad = s(5);
  const lineH = s(12);

  for (const c of corners) {
    const line1 = formatCoord(c.wy, projected, 'y');
    const line2 = formatCoord(c.wx, projected, 'x');

    ctx.font = `${fontSize}px ${FONT_MONO}`;
    const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);

    const pillW = tw + pad * 2;
    const pillH = lineH * 2 + pad * 2;
    const pillX = c.align === 'left' ? c.px : c.px - pillW;
    const pillY = c.baseline === 'top' ? c.py : c.py - pillH;

    // Pill background
    ctx.fillStyle = 'rgba(15, 31, 56, 0.80)';
    roundRect(ctx, pillX, pillY, pillW, pillH, s(THEME.radiusMd));
    ctx.fill();
    ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
    ctx.lineWidth = s(1);
    ctx.stroke();

    // Text
    ctx.fillStyle = THEME.cyan;
    ctx.font = `${fontSize}px ${FONT_MONO}`;
    ctx.textAlign = c.align;
    ctx.textBaseline = 'top';
    const textX = c.align === 'left' ? pillX + pad : pillX + pillW - pad;
    ctx.fillText(line1, textX, pillY + pad);
    ctx.fillText(line2, textX, pillY + pad + lineH);
  }
}

// ── 4. Scale bar ────────────────────────────────────────────────────────────

function drawScaleBar(ctx, W, H, viewState, bounds, projected, s) {
  if (!viewState || !bounds || !projected) return;

  const ppu = Math.pow(2, viewState.zoom || 0);
  const { barPixels, label } = computeScaleBar(ppu, s(150));

  const barH = s(4);
  const fontSize = s(11);
  const pad = s(8);
  const x = s(16);
  const y = H - s(16);

  // Panel pill background
  const bgW = barPixels + pad * 2;
  const bgH = barH + fontSize + pad * 3;

  ctx.fillStyle = 'rgba(15, 31, 56, 0.85)';
  roundRect(ctx, x - pad, y - bgH, bgW, bgH + pad, s(THEME.radiusSm));
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  // Cyan bar
  ctx.fillStyle = THEME.cyan;
  roundRect(ctx, x, y - barH, barPixels, barH, s(2));
  ctx.fill();

  // Label
  ctx.font = `500 ${fontSize}px ${FONT_MONO}`;
  ctx.fillStyle = THEME.textSecondary;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x + barPixels / 2, y - barH - s(4));
}

// ── 5a. RGB legend ──────────────────────────────────────────────────────────

function drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, s) {
  const preset = SAR_COMPOSITES[compositeId];
  const title = preset?.name || 'RGB';

  const channels = [
    { key: 'R', color: CHANNEL_COLORS.R },
    { key: 'G', color: CHANNEL_COLORS.G },
    { key: 'B', color: CHANNEL_COLORS.B },
  ];

  const fontSize = s(11);
  const titleFontSize = s(12);
  const swatchSize = s(12);
  const lineHeight = s(18);
  const pad = s(10);

  // Measure width
  ctx.font = `bold ${titleFontSize}px ${FONT_MONO}`;
  let maxWidth = ctx.measureText(title).width;

  const labels = channels.map(({ key }) => {
    const chDef = preset?.channels?.[key];
    const label = chDef?.label || chDef?.dataset || key;
    const limStr = formatLimit(contrastLimits, key, useDecibels);
    return `${label} ${limStr}`;
  });

  ctx.font = `${fontSize}px ${FONT_MONO}`;
  for (const l of labels) {
    maxWidth = Math.max(maxWidth, ctx.measureText(l).width + swatchSize + s(8));
  }

  const boxW = maxWidth + pad * 2;
  const boxH = titleFontSize + lineHeight * 3 + pad * 2 + s(4);
  const boxX = W - s(20) - boxW;
  const boxY = s(20);

  // Background
  ctx.fillStyle = 'rgba(15, 31, 56, 0.85)';
  roundRect(ctx, boxX, boxY, boxW, boxH, s(THEME.radiusMd));
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  // Title
  ctx.fillStyle = THEME.textPrimary;
  ctx.font = `bold ${titleFontSize}px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, boxX + pad, boxY + pad);

  // Channels
  let cy = boxY + pad + titleFontSize + s(6);
  for (let i = 0; i < channels.length; i++) {
    const { color } = channels[i];

    // Swatch
    ctx.fillStyle = color;
    roundRect(ctx, boxX + pad, cy + s(1), swatchSize, swatchSize, s(2));
    ctx.fill();

    // Label
    ctx.fillStyle = THEME.textSecondary;
    ctx.font = `${fontSize}px ${FONT_MONO}`;
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i], boxX + pad + swatchSize + s(6), cy);

    cy += lineHeight;
  }
}

// ── 5b. Colormap bar ────────────────────────────────────────────────────────

function drawColormapBar(ctx, W, H, colormapName, contrastLimits, useDecibels, s) {
  const [min, max] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
  const unit = useDecibels ? ' dB' : '';
  const colormapFunc = getColormap(colormapName);

  const barW = s(20);
  const barH = s(150);
  const pad = s(10);
  const fontSize = s(11);
  const boxW = barW + pad * 2 + s(50);
  const boxH = barH + pad * 2 + fontSize * 2 + s(8);
  const boxX = W - s(20) - boxW;
  const boxY = s(20);

  // Background
  ctx.fillStyle = 'rgba(15, 31, 56, 0.85)';
  roundRect(ctx, boxX, boxY, boxW, boxH, s(THEME.radiusMd));
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  // Max label
  ctx.fillStyle = THEME.textSecondary;
  ctx.font = `${fontSize}px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${max.toFixed(1)}${unit}`, boxX + pad, boxY + pad);

  // Gradient bar
  const gradX = boxX + pad;
  const gradY = boxY + pad + fontSize + s(4);

  for (let y = 0; y < barH; y++) {
    const t = 1 - y / barH;
    const rgb = colormapFunc(t);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(gradX, gradY + y, barW, 1);
  }

  // Min label
  ctx.fillStyle = THEME.textSecondary;
  ctx.textBaseline = 'top';
  ctx.fillText(`${min.toFixed(1)}${unit}`, boxX + pad, gradY + barH + s(4));
}

// ── 6. Metadata panel ───────────────────────────────────────────────────────

function drawMetadata(ctx, W, H, meta, s) {
  const { filename, crs, compositeId, useDecibels, viewState, bounds, projected } = meta;

  // Build label:value pairs with semantic colors
  const entries = [];

  if (filename) {
    entries.push({ label: 'SOURCE', value: filename, color: THEME.textPrimary });
  }
  if (compositeId) {
    const preset = SAR_COMPOSITES[compositeId];
    entries.push({ label: 'COMPOSITE', value: preset?.name || compositeId, color: THEME.cyan });
  }
  if (crs) {
    entries.push({ label: 'CRS', value: crs, color: THEME.orange });
  }
  entries.push({ label: 'SCALE', value: useDecibels ? 'dB' : 'linear', color: THEME.textSecondary });

  // Visible extent
  if (viewState && bounds) {
    const ext = computeVisibleExtent(viewState, W, H);
    entries.push({
      label: 'EXTENT',
      value: formatExtent(ext.width, ext.height, projected),
      color: THEME.cyan,
    });
  }

  const labelFontSize = s(9);
  const valueFontSize = s(11);
  const lineH = s(16);
  const pad = s(10);
  const labelWidth = s(72);  // fixed label column width

  // Measure max value width
  ctx.font = `${valueFontSize}px ${FONT_MONO}`;
  let maxValueW = 0;
  for (const e of entries) {
    maxValueW = Math.max(maxValueW, ctx.measureText(e.value).width);
  }

  const boxW = labelWidth + maxValueW + pad * 2 + s(4);
  const boxH = entries.length * lineH + pad * 2;
  const boxX = W - s(16) - boxW;
  const boxY = H - s(16) - boxH;

  // Background
  ctx.fillStyle = 'rgba(15, 31, 56, 0.85)';
  roundRect(ctx, boxX, boxY, boxW, boxH, s(THEME.radiusMd));
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = boxY + pad + i * lineH;

    // Label — uppercase, letter-spaced, muted
    ctx.font = `600 ${labelFontSize}px ${FONT_MONO}`;
    ctx.fillStyle = THEME.textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(e.label, boxX + pad, y);

    // Value — semantic color
    ctx.font = `${valueFontSize}px ${FONT_MONO}`;
    ctx.fillStyle = e.color;
    ctx.fillText(e.value, boxX + pad + labelWidth, y);
  }
}

// ── 7. Branding ─────────────────────────────────────────────────────────────

function drawBranding(ctx, W, H, s) {
  const fontSize = s(12);
  ctx.font = `bold ${fontSize}px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const x = s(12);
  const y = s(10);

  // "SAR" in cyan
  ctx.fillStyle = THEME.cyan;
  const sarW = ctx.measureText('SAR').width;
  ctx.fillText('SAR', x, y);

  // "dine" in primary
  ctx.fillStyle = THEME.textPrimary;
  ctx.fillText('dine', x + sarW, y);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Standalone RGB colorbar (triangle) ───────────────────────────────────────

/**
 * Generate a standalone RGB colorbar as a triangular color-space diagram.
 *
 * The triangle vertices represent the three channels (R, G, B).  Each
 * interior pixel is coloured by its barycentric coordinates: wR, wG, wB
 * determine the relative intensity of each channel.  The stretch function
 * is applied so the gradient matches the on-screen rendering.
 *
 * Layout:
 *               R: HHHH
 *                 ▲
 *                ╱ ╲
 *               ╱   ╲
 *              ╱  ●  ╲
 *             ╱_______╲
 *       G: HVHV     B: HH/HV
 *
 *       R  −41.4 – −1.5 dB
 *       G  −24.7 – −8.2 dB
 *       B   −4.0 – 11.5 dB
 *
 * @param {Object} options
 * @param {string}   options.compositeId   - SAR composite preset ID
 * @param {Object}   options.contrastLimits - {R:[min,max], G:[min,max], B:[min,max]}
 * @param {boolean}  [options.useDecibels=true]
 * @param {string}   [options.stretchMode='linear']
 * @param {number}   [options.gamma=1.0]
 * @returns {Promise<Blob>} PNG blob
 */
export function exportRGBColorbar(options = {}) {
  const {
    compositeId,
    contrastLimits,
    useDecibels = true,
    stretchMode = 'linear',
    gamma = 1.0,
  } = options;

  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return Promise.resolve(null);

  const dpr = window.devicePixelRatio || 1;
  const s = (v) => Math.round(v * dpr);

  const pad = s(14);
  const triSide = s(240);
  const triH = Math.round(triSide * Math.sqrt(3) / 2);

  // Canvas sizing: title, label above apex, triangle, labels below base, range table
  const titleH = s(28);
  const apexLabelH = s(20);
  const baseLabelH = s(22);
  const rangeTableH = s(56);
  const canvasW = triSide + pad * 2 + s(60);   // extra room for base labels
  const canvasH = titleH + apexLabelH + triH + baseLabelH + rangeTableH + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Border
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = s(1);
  roundRect(ctx, s(1), s(1), canvasW - s(2), canvasH - s(2), s(THEME.radiusMd));
  ctx.stroke();

  // ── Title row ──
  let y = pad;
  ctx.font = `bold ${s(13)}px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = THEME.cyan;
  const sarTextW = ctx.measureText('SAR').width;
  ctx.fillText('SAR', pad, y);
  ctx.fillStyle = THEME.textPrimary;
  ctx.fillText('dine', pad + sarTextW, y);

  ctx.fillStyle = THEME.textSecondary;
  ctx.font = `${s(11)}px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(preset.name, canvasW - pad, y + s(2));
  ctx.textAlign = 'left';

  y += titleH;

  // ── Triangle vertices: R (top), G (bottom-left), B (bottom-right) ──
  const cx = canvasW / 2;
  const triTop = y + apexLabelH;
  const vR = [cx, triTop];
  const vG = [cx - triSide / 2, triTop + triH];
  const vB = [cx + triSide / 2, triTop + triH];

  // ── Render triangle via ImageData + barycentric interpolation ──
  const bboxX0 = Math.floor(vG[0]);
  const bboxX1 = Math.ceil(vB[0]);
  const bboxY0 = Math.floor(vR[1]);
  const bboxY1 = Math.ceil(vG[1]);
  const imgW = bboxX1 - bboxX0;
  const imgH = bboxY1 - bboxY0;
  const imgData = ctx.getImageData(bboxX0, bboxY0, imgW, imgH);
  const px = imgData.data;

  // Pre-compute barycentric denominator
  const e0 = [vG[0] - vR[0], vG[1] - vR[1]];  // R → G
  const e1 = [vB[0] - vR[0], vB[1] - vR[1]];  // R → B
  const d00 = e0[0] * e0[0] + e0[1] * e0[1];
  const d01 = e0[0] * e1[0] + e0[1] * e1[1];
  const d11 = e1[0] * e1[0] + e1[1] * e1[1];
  const invDenom = 1 / (d00 * d11 - d01 * d01);

  for (let iy = 0; iy < imgH; iy++) {
    for (let ix = 0; ix < imgW; ix++) {
      const pX = bboxX0 + ix + 0.5;
      const pY = bboxY0 + iy + 0.5;
      const ep = [pX - vR[0], pY - vR[1]];
      const d20 = ep[0] * e0[0] + ep[1] * e0[1];
      const d21 = ep[0] * e1[0] + ep[1] * e1[1];

      const wG = (d11 * d20 - d01 * d21) * invDenom;
      const wB = (d00 * d21 - d01 * d20) * invDenom;
      const wR = 1 - wG - wB;

      if (wR >= 0 && wG >= 0 && wB >= 0) {
        const r = Math.round(applyStretch(wR, stretchMode, gamma) * 255);
        const g = Math.round(applyStretch(wG, stretchMode, gamma) * 255);
        const b = Math.round(applyStretch(wB, stretchMode, gamma) * 255);
        const idx = (iy * imgW + ix) * 4;
        px[idx] = r;
        px[idx + 1] = g;
        px[idx + 2] = b;
        px[idx + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, bboxX0, bboxY0);

  // Triangle outline
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = s(1.5);
  ctx.beginPath();
  ctx.moveTo(vR[0], vR[1]);
  ctx.lineTo(vG[0], vG[1]);
  ctx.lineTo(vB[0], vB[1]);
  ctx.closePath();
  ctx.stroke();

  // ── Vertex labels ──
  const chDefs = {
    R: preset.channels.R,
    G: preset.channels.G,
    B: preset.channels.B,
  };

  const labelR = chDefs.R?.label || chDefs.R?.dataset || 'R';
  const labelG = chDefs.G?.label || chDefs.G?.dataset || 'G';
  const labelB = chDefs.B?.label || chDefs.B?.dataset || 'B';

  const labelFont = `bold ${s(11)}px ${FONT_MONO}`;
  const subFont = `${s(10)}px ${FONT_MONO}`;

  // R — above apex
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = CHANNEL_COLORS.R;
  ctx.fillText(`R: ${labelR}`, vR[0], vR[1] - s(4));

  // G — below-left of base
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = CHANNEL_COLORS.G;
  ctx.fillText(`G: ${labelG}`, vG[0] + s(4), vG[1] + s(4));

  // B — below-right of base
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = CHANNEL_COLORS.B;
  ctx.fillText(`B: ${labelB}`, vB[0] - s(4), vB[1] + s(4));

  // ── Contrast range table ──
  y = vG[1] + baseLabelH + s(8);
  const rangeX = pad + s(4);
  const unit = useDecibels ? ' dB' : '';

  for (const ch of ['R', 'G', 'B']) {
    const color = CHANNEL_COLORS[ch];
    const lim = contrastLimits?.[ch] || [-25, 0];
    const minStr = useDecibels ? lim[0].toFixed(1) : lim[0].toExponential(1);
    const maxStr = useDecibels ? lim[1].toFixed(1) : lim[1].toExponential(1);

    ctx.font = labelFont;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(ch, rangeX, y);

    ctx.font = subFont;
    ctx.fillStyle = THEME.textMuted;
    ctx.fillText(`${minStr} – ${maxStr}${unit}`, rangeX + s(18), y + s(1));

    y += s(16);
  }

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
