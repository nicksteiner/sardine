/**
 * Lightweight canvas-based chart renderers for sardine-lite report graphics.
 *
 * No external dependencies — pure Canvas 2D API. Designed to run in any
 * browser or in an OffscreenCanvas / node-canvas environment.
 */

// ── colour palette (sardine dark theme) ──────────────────────────────
const COLORS = {
  bg:        '#1a1a2e',
  panel:     '#16213e',
  grid:      '#334155',
  text:      '#e2e8f0',
  textDim:   '#94a3b8',
  accent:    '#38bdf8',   // sky-400
  warn:      '#f97316',   // orange-500
  flood:     '#ef4444',   // red-500
  normal:    '#22c55e',   // green-500
  secondary: '#a78bfa',   // violet-400
  outline:   '#475569',
};

/**
 * Draw a dB bar chart for scene results.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{date: string, meanDb: number, floodSignal?: boolean}>} scenes
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawDbBarChart(ctx, scenes, rect) {
  if (!scenes.length) return;
  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 40, left: 50 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const ox = x + pad.left;
  const oy = y + pad.top;

  // data range
  const vals = scenes.map(s => s.meanDb ?? s.stats?.mean ?? 0).filter(Number.isFinite);
  if (!vals.length) return;
  const minV = Math.floor(Math.min(...vals) - 2);
  const maxV = Math.ceil(Math.max(...vals) + 2);
  const range = maxV - minV || 1;

  // title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Mean Backscatter (dB)', ox, y + 16);

  // y-axis grid + labels
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const nTicks = 5;
  for (let i = 0; i <= nTicks; i++) {
    const v = minV + (range * i) / nTicks;
    const py = oy + plotH - (plotH * i) / nTicks;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, py);
    ctx.lineTo(ox + plotW, py);
    ctx.stroke();
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText(v.toFixed(1), ox - 6, py + 4);
  }

  // bars
  const barGap = 4;
  const barW = Math.max(4, (plotW - barGap * scenes.length) / scenes.length);
  scenes.forEach((s, i) => {
    const v = s.meanDb ?? s.stats?.mean ?? 0;
    if (!Number.isFinite(v)) return;
    const bx = ox + i * (barW + barGap) + barGap / 2;
    const bh = ((v - minV) / range) * plotH;
    const by = oy + plotH - bh;
    ctx.fillStyle = s.floodSignal ? COLORS.flood : COLORS.accent;
    ctx.fillRect(bx, by, barW, bh);

    // date label
    const label = s.date ? s.date.slice(0, 10) : `#${i + 1}`;
    ctx.save();
    ctx.translate(bx + barW / 2, oy + plotH + 6);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

/**
 * Draw a change-detection dot plot (primary → secondary dB change).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{primary: string, secondary: string, dbChange: number, significantChange?: boolean}>} pairs
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawChangeDetectionPlot(ctx, pairs, rect) {
  if (!pairs.length) return;
  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 24, left: 50 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const ox = x + pad.left;
  const oy = y + pad.top;

  const vals = pairs.map(p => Number(p.dbChange)).filter(Number.isFinite);
  if (!vals.length) return;
  const absMax = Math.max(Math.ceil(Math.max(...vals.map(Math.abs))), 1);

  // title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Change Detection (ΔdB)', ox, y + 16);

  // zero line
  const zeroY = oy + plotH / 2;
  ctx.strokeStyle = COLORS.outline;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(ox, zeroY);
  ctx.lineTo(ox + plotW, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // y labels
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(`+${absMax}`, ox - 6, oy + 4);
  ctx.fillText('0', ox - 6, zeroY + 4);
  ctx.fillText(`−${absMax}`, ox - 6, oy + plotH + 4);

  // dots
  const dotR = Math.min(8, plotW / pairs.length / 2.5);
  pairs.forEach((p, i) => {
    const v = Number(p.dbChange);
    if (!Number.isFinite(v)) return;
    const px = ox + ((i + 0.5) / pairs.length) * plotW;
    const py = zeroY - (v / absMax) * (plotH / 2);
    ctx.beginPath();
    ctx.arc(px, py, dotR, 0, Math.PI * 2);
    ctx.fillStyle = p.significantChange ? COLORS.flood : COLORS.secondary;
    ctx.fill();
    ctx.strokeStyle = COLORS.panel;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

/**
 * Draw scene footprints on a simple equirectangular map.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{bbox: number[]}>} scenes  — each bbox is [west, south, east, north]
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawFootprintMap(ctx, scenes, rect) {
  const bboxes = scenes.map(s => s.bbox).filter(b => b && b.length === 4);
  if (!bboxes.length) return;
  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 12, left: 12 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const ox = x + pad.left;
  const oy = y + pad.top;

  // title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Scene Footprints', ox, y + 16);

  // compute extent with 10% padding
  let [minLon, minLat, maxLon, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [bw, bs, be, bn] of bboxes) {
    if (bw < minLon) minLon = bw;
    if (bs < minLat) minLat = bs;
    if (be > maxLon) maxLon = be;
    if (bn > maxLat) maxLat = bn;
  }
  const lonSpan = (maxLon - minLon) || 1;
  const latSpan = (maxLat - minLat) || 1;
  const padFrac = 0.1;
  minLon -= lonSpan * padFrac;
  maxLon += lonSpan * padFrac;
  minLat -= latSpan * padFrac;
  maxLat += latSpan * padFrac;
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;

  const toX = lon => ox + ((lon - minLon) / spanLon) * plotW;
  const toY = lat => oy + plotH - ((lat - minLat) / spanLat) * plotH;

  // background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(ox, oy, plotW, plotH);

  // footprints
  bboxes.forEach((bbox, i) => {
    const [bw, bs, be, bn] = bbox;
    const rx = toX(bw);
    const ry = toY(bn);
    const rw = toX(be) - rx;
    const rh = toY(bs) - ry;
    const scene = scenes[i];
    ctx.fillStyle = scene.floodSignal
      ? 'rgba(239, 68, 68, 0.35)'
      : 'rgba(56, 189, 248, 0.25)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = scene.floodSignal ? COLORS.flood : COLORS.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
  });

  // axis labels
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${minLon.toFixed(2)}°`, ox, oy + plotH + 10);
  ctx.textAlign = 'right';
  ctx.fillText(`${maxLon.toFixed(2)}°`, ox + plotW, oy + plotH + 10);
  ctx.textAlign = 'left';
  ctx.fillText(`${maxLat.toFixed(2)}°`, ox + plotW + 2, oy + 10);
  ctx.fillText(`${minLat.toFixed(2)}°`, ox + plotW + 2, oy + plotH);
}

/**
 * Render a full report dashboard to a canvas context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} report — explorer report object
 * @param {number} width
 * @param {number} height
 */
export function renderReportDashboard(ctx, report, width, height) {
  // background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  const scenes = report.sceneResults || [];
  const pairs  = report.pairsTested  || [];

  // layout: two-column if we have both scene results and footprints
  const hasScenes = scenes.length > 0;
  const hasPairs  = pairs.length > 0;
  const hasBboxes = scenes.some(s => s.bbox && s.bbox.length === 4);

  const gap = 16;
  const colW = hasBboxes ? (width - gap * 3) / 2 : width - gap * 2;

  let yOff = gap;

  if (hasScenes) {
    const chartH = Math.min(280, height * 0.45);
    drawDbBarChart(ctx, scenes, { x: gap, y: yOff, w: colW, h: chartH });
    if (hasBboxes) {
      drawFootprintMap(ctx, scenes, { x: gap + colW + gap, y: yOff, w: colW, h: chartH });
    }
    yOff += chartH + gap;
  }

  if (hasPairs) {
    const plotH = Math.min(220, height - yOff - gap);
    drawChangeDetectionPlot(ctx, pairs, { x: gap, y: yOff, w: width - gap * 2, h: plotH });
  }
}

/**
 * Draw a region-estimates summary (flood/no-flood badges per named region).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object<string, {floodDetected: boolean, date?: string, meanDb?: number}>} regions
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawRegionEstimates(ctx, regions, rect) {
  const entries = Object.entries(regions || {});
  if (!entries.length) return;
  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 12, left: 12 };
  const ox = x + pad.left;
  const oy = y + pad.top;
  const innerW = w - pad.left - pad.right;

  // title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Region Estimates', ox, y + 16);

  const rowH = 28;
  entries.forEach(([name, info], i) => {
    const ry = oy + i * rowH;
    if (ry + rowH > y + h) return; // clip

    // badge
    const badgeW = 70;
    const flood = info.floodDetected;
    ctx.fillStyle = flood ? COLORS.flood : COLORS.normal;
    roundRect(ctx, ox, ry + 2, badgeW, rowH - 4, 4);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(flood ? 'FLOOD' : 'NORMAL', ox + badgeW / 2, ry + rowH / 2 + 4);

    // region name + optional dB
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    let label = name;
    if (Number.isFinite(info.meanDb)) label += `  (${info.meanDb.toFixed(1)} dB)`;
    ctx.fillText(label, ox + badgeW + 10, ry + rowH / 2 + 4);

    // date at right edge
    if (info.date) {
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(info.date.slice(0, 10), ox + innerW, ry + rowH / 2 + 4);
    }
  });
}

/**
 * Draw a dB timeline (line chart) from scene results.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{date: string, meanDb: number, floodSignal?: boolean}>} scenes
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawTimelinePlot(ctx, scenes, rect) {
  // need at least 2 points for a line
  const sorted = scenes
    .filter(s => s.date && Number.isFinite(s.meanDb ?? s.stats?.mean))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return;

  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 36, left: 50 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const ox = x + pad.left;
  const oy = y + pad.top;

  const vals = sorted.map(s => s.meanDb ?? s.stats?.mean);
  const minV = Math.floor(Math.min(...vals) - 1);
  const maxV = Math.ceil(Math.max(...vals) + 1);
  const range = maxV - minV || 1;

  const dates = sorted.map(s => new Date(s.date).getTime());
  const minT = dates[0];
  const maxT = dates[dates.length - 1];
  const tSpan = maxT - minT || 1;

  // title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Backscatter Timeline (dB)', ox, y + 16);

  // y-axis
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const nTicks = 4;
  for (let i = 0; i <= nTicks; i++) {
    const v = minV + (range * i) / nTicks;
    const py = oy + plotH - (plotH * i) / nTicks;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, py);
    ctx.lineTo(ox + plotW, py);
    ctx.stroke();
    ctx.fillStyle = COLORS.textDim;
    ctx.fillText(v.toFixed(1), ox - 6, py + 4);
  }

  // line
  ctx.beginPath();
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  sorted.forEach((s, i) => {
    const px = ox + ((dates[i] - minT) / tSpan) * plotW;
    const py = oy + plotH - ((vals[i] - minV) / range) * plotH;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // dots
  sorted.forEach((s, i) => {
    const px = ox + ((dates[i] - minT) / tSpan) * plotW;
    const py = oy + plotH - ((vals[i] - minV) / range) * plotH;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = s.floodSignal ? COLORS.flood : COLORS.accent;
    ctx.fill();
    ctx.strokeStyle = COLORS.panel;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // x-axis date labels
  const labelCount = Math.min(sorted.length, 6);
  const step = Math.max(1, Math.floor(sorted.length / labelCount));
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = 'center';
  for (let i = 0; i < sorted.length; i += step) {
    const px = ox + ((dates[i] - minT) / tSpan) * plotW;
    ctx.fillText(sorted[i].date.slice(0, 10), px, oy + plotH + 14);
  }
}

/**
 * Draw a simple horizontal bar chart for exploration log stats.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{label: string, value: number}>} items
 * @param {string} title
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function drawHorizontalBars(ctx, items, title, rect) {
  if (!items.length) return;
  const { x, y, w, h } = rect;
  const pad = { top: 28, right: 12, bottom: 12, left: 120 };
  const plotW = w - pad.left - pad.right;
  const ox = x + pad.left;
  const oy = y + pad.top;

  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, x + 12, y + 16);

  const maxVal = Math.max(...items.map(i => i.value), 1);
  const barH = Math.min(22, (h - pad.top - pad.bottom) / items.length - 4);

  items.forEach((item, i) => {
    const by = oy + i * (barH + 4);
    if (by + barH > y + h) return;

    // label
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(item.label, ox - 8, by + barH / 2 + 4);

    // bar
    const bw = (item.value / maxVal) * plotW;
    ctx.fillStyle = COLORS.accent;
    roundRect(ctx, ox, by, bw, barH, 3);
    ctx.fill();

    // value
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(item.value), ox + bw + 6, by + barH / 2 + 4);
  });
}

// ── helpers ─────────────────────────────────────────────────────────

/** Draw a rounded rectangle path (does NOT stroke/fill — caller does that). */
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export { COLORS as REPORT_COLORS };
