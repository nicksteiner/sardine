/**
 * Publication-quality SVG export for scatter plots and histograms.
 *
 * Targeting Nature / Remote Sensing of Environment house style:
 *   - White background, black axes/text
 *   - Helvetica (Arial fallback) for all text
 *   - Thin 0.5 pt axis lines, outward-facing tick marks
 *   - No chartjunk: no gridlines, no box frame, open L-shaped axes
 *   - 86 mm single-column width (≈ 244 pt)
 *   - Font sizes: 7 pt axis labels, 8 pt axis titles, 9 pt panel label
 */

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// ── Shared helpers ──────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Nature-style nice ticks (Wilkinson-like). */
function niceTicks(lo, hi, target = 5) {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const rough = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const r = rough / mag;
  const step = r <= 1.5 ? mag : r <= 3 ? 2 * mag : r <= 7 ? 5 * mag : 10 * mag;
  const ticks = [];
  let v = Math.ceil(lo / step) * step;
  while (v <= hi + step * 0.001) { ticks.push(v); v += step; }
  return ticks;
}

function fmtTick(v) {
  if (v === 0) return '0';
  if (Math.abs(v) >= 10000) return v.toExponential(0);
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) < 1 ? v.toPrecision(2) : v.toFixed(1);
}

// ── Density colormap (perceptual: white → steel → navy) ─────────────────
// Designed for legibility on white paper — inverted from screen version.

function densityColor(t) {
  if (t === 0) return null; // transparent / skip
  // white → light blue → dark blue
  const r = Math.round(235 - t * 195);
  const g = Math.round(240 - t * 200);
  const b = Math.round(245 - t * 125);
  return `rgb(${r},${g},${b})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCATTER PLOT SVG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a publication-quality SVG of the feature-space scatter density plot.
 *
 * @param {Object} scatterData - { x, y, valid, w, h }
 * @param {string} xLabel - X-axis label (e.g. "σ° HH (dB)")
 * @param {string} yLabel - Y-axis label
 * @param {Object[]} classRegions - [{ name, color, xMin, xMax, yMin, yMax }]
 * @param {number[]} xRange - [min, max]
 * @param {number[]} yRange - [min, max]
 * @returns {string} SVG markup
 */
export function generateScatterSVG(scatterData, xLabel, yLabel, classRegions, xRange, yRange) {
  if (!scatterData) return '';

  // Layout — 86 mm wide (Nature single col), square plot area
  const W = 244, H = 244;
  const m = { top: 18, right: 12, bottom: 42, left: 46 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const BINS = 128;
  const TICK_LEN = 4;

  const { x, y, valid } = scatterData;
  const [xMin, xMax] = xRange;
  const [yMin, yMax] = yRange;
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const sx = (v) => m.left + ((v - xMin) / xSpan) * pw;
  const sy = (v) => m.top + ph - ((v - yMin) / ySpan) * ph;

  // ── Density grid ──
  const grid = new Uint32Array(BINS * BINS);
  for (let i = 0; i < x.length; i++) {
    if (!valid[i]) continue;
    const bx = Math.floor((x[i] - xMin) / xSpan * (BINS - 1));
    const by = Math.floor((y[i] - yMin) / ySpan * (BINS - 1));
    if (bx < 0 || bx >= BINS || by < 0 || by >= BINS) continue;
    grid[(BINS - 1 - by) * BINS + bx]++;
  }
  let maxC = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > maxC) maxC = grid[i];
  const logMax = Math.log10(maxC + 1) || 1;

  const cellW = pw / BINS, cellH = ph / BINS;
  let rects = '';
  for (let row = 0; row < BINS; row++) {
    for (let col = 0; col < BINS; col++) {
      const c = grid[row * BINS + col];
      if (!c) continue;
      const t = Math.log10(c + 1) / logMax;
      const fill = densityColor(t);
      if (!fill) continue;
      rects += `<rect x="${(m.left + col * cellW).toFixed(1)}" y="${(m.top + row * cellH).toFixed(1)}" width="${cellW.toFixed(2)}" height="${cellH.toFixed(2)}" fill="${fill}"/>`;
    }
  }

  // ── Ticks (outward) ──
  const xTicks = niceTicks(xMin, xMax, 5);
  const yTicks = niceTicks(yMin, yMax, 5);
  let ticks = '';
  for (const v of xTicks) {
    const px = sx(v);
    ticks += `<line x1="${px}" y1="${m.top + ph}" x2="${px}" y2="${m.top + ph + TICK_LEN}" stroke="#000" stroke-width="0.75"/>`;
    ticks += `<text x="${px}" y="${m.top + ph + TICK_LEN + 9}" text-anchor="middle" font-size="7">${esc(fmtTick(v))}</text>`;
  }
  for (const v of yTicks) {
    const py = sy(v);
    ticks += `<line x1="${m.left}" y1="${py}" x2="${m.left - TICK_LEN}" y2="${py}" stroke="#000" stroke-width="0.75"/>`;
    ticks += `<text x="${m.left - TICK_LEN - 3}" y="${py + 2.5}" text-anchor="end" font-size="7">${esc(fmtTick(v))}</text>`;
  }

  // ── Class regions (print-safe: heavier stroke, hatched fill) ──
  let classes = '';
  for (const r of (classRegions || [])) {
    if (!r.xMax && !r.yMax) continue;
    const lx = sx(r.xMin), rx = sx(r.xMax);
    const ty = sy(r.yMax), by = sy(r.yMin);
    classes += `<rect x="${lx}" y="${ty}" width="${rx - lx}" height="${by - ty}" fill="${r.color}" fill-opacity="0.15" stroke="${r.color}" stroke-width="1.25"/>`;
    classes += `<text x="${lx + 3}" y="${ty + 10}" font-size="7" font-weight="600" fill="${r.color}">${esc(r.name)}</text>`;
  }

  // ── Assemble SVG ──
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="244" height="244"
     viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">
<rect width="${W}" height="${H}" fill="#fff"/>
<defs><clipPath id="plot"><rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/></clipPath></defs>
<g clip-path="url(#plot)" shape-rendering="crispEdges">${rects}</g>
<g clip-path="url(#plot)">${classes}</g>
<!-- axes (open L) -->
<line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + ph}" stroke="#000" stroke-width="0.75"/>
<line x1="${m.left}" y1="${m.top + ph}" x2="${m.left + pw}" y2="${m.top + ph}" stroke="#000" stroke-width="0.75"/>
${ticks}
<text x="${m.left + pw / 2}" y="${H - 4}" text-anchor="middle" font-size="8">${esc(xLabel || 'Band X (dB)')}</text>
<text x="4" y="${m.top + ph / 2}" text-anchor="middle" font-size="8"
      transform="rotate(-90,4,${m.top + ph / 2})">${esc(yLabel || 'Band Y (dB)')}</text>
</svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTOGRAM SVG
// ═══════════════════════════════════════════════════════════════════════════

/** Channel palette — optimised for print (Nature allows colour). */
const CH_PRINT = {
  R:      { fill: 'rgba(215,48,39,0.35)',  stroke: '#d7302f' },
  G:      { fill: 'rgba(26,152,80,0.35)',  stroke: '#1a9850' },
  B:      { fill: 'rgba(44,123,182,0.35)', stroke: '#2c7bb6' },
  single: { fill: 'rgba(64,64,64,0.25)',   stroke: '#222' },
};

/**
 * Generate a publication-quality SVG histogram.
 *
 * @param {Object} histograms - { single: stats } | { R, G, B }
 * @param {string} mode - 'single' | 'rgb'
 * @param {*} contrastLimits
 * @param {boolean} useDecibels
 * @param {string} polarization
 * @param {string} compositeId
 * @returns {string} SVG markup
 */
export function generateHistogramSVG(histograms, mode, contrastLimits, useDecibels, polarization, compositeId) {
  if (!histograms) return '';

  const W = 244, H = 160;
  const m = { top: 14, right: 12, bottom: 38, left: 46 };
  const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
  const TICK_LEN = 4;

  const channels = mode === 'rgb' ? ['R', 'G', 'B'] : ['single'];

  // Data range
  let gMin = Infinity, gMax = -Infinity;
  for (const ch of channels) {
    const s = histograms[ch];
    if (s) { if (s.min < gMin) gMin = s.min; if (s.max > gMax) gMax = s.max; }
  }
  if (!isFinite(gMin)) { gMin = 0; gMax = 1; }

  // Y max (log-scaled)
  let yMax = 1;
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s?.bins) continue;
    for (const b of s.bins) { const lv = Math.log10(b + 1); if (lv > yMax) yMax = lv; }
  }
  yMax *= 1.05;

  const xScale = (v) => m.left + ((v - gMin) / (gMax - gMin)) * pw;
  const yScale = (lv) => m.top + ph - (lv / yMax) * ph;

  // ── Histogram paths ──
  let paths = '';
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s?.bins) continue;
    const style = CH_PRINT[ch] || CH_PRINT.single;
    const n = s.bins.length;
    const dr = s.max - s.min || 1;

    // Filled area
    let d = `M${xScale(s.min).toFixed(1)},${yScale(0).toFixed(1)}`;
    for (let i = 0; i < n; i++) {
      const bl = s.min + (i / n) * dr;
      const br = s.min + ((i + 1) / n) * dr;
      const lh = Math.log10(s.bins[i] + 1);
      d += `L${xScale(bl).toFixed(1)},${yScale(lh).toFixed(1)}L${xScale(br).toFixed(1)},${yScale(lh).toFixed(1)}`;
    }
    d += `L${xScale(s.max).toFixed(1)},${yScale(0).toFixed(1)}Z`;
    paths += `<path d="${d}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.75"/>`;
  }

  // ── Contrast limit markers ──
  let limits = '';
  if (mode === 'rgb' && contrastLimits) {
    for (const ch of channels) {
      const lim = contrastLimits[ch];
      if (!lim) continue;
      const style = CH_PRINT[ch];
      for (const v of lim) {
        const px = xScale(v);
        if (px < m.left || px > m.left + pw) continue;
        limits += `<line x1="${px}" y1="${m.top}" x2="${px}" y2="${m.top + ph}" stroke="${style.stroke}" stroke-width="0.5" stroke-dasharray="4,2"/>`;
      }
    }
  } else if (mode === 'single' && contrastLimits) {
    const [lo, hi] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
    for (const v of [lo, hi]) {
      const px = xScale(v);
      if (px < m.left || px > m.left + pw) continue;
      limits += `<line x1="${px}" y1="${m.top}" x2="${px}" y2="${m.top + ph}" stroke="#555" stroke-width="0.5" stroke-dasharray="4,2"/>`;
    }
  }

  // ── Ticks ──
  const xTicks = niceTicks(gMin, gMax, 6);
  let ticks = '';
  for (const v of xTicks) {
    const px = xScale(v);
    ticks += `<line x1="${px}" y1="${m.top + ph}" x2="${px}" y2="${m.top + ph + TICK_LEN}" stroke="#000" stroke-width="0.75"/>`;
    ticks += `<text x="${px}" y="${m.top + ph + TICK_LEN + 9}" text-anchor="middle" font-size="7">${esc(fmtTick(v))}</text>`;
  }
  // Y ticks (log count)
  const yTicks = niceTicks(0, yMax, 4).filter(t => t > 0);
  for (const v of yTicks) {
    const py = yScale(v);
    const raw = Math.round(Math.pow(10, v));
    const label = raw >= 1e6 ? (raw / 1e6).toFixed(0) + 'M' : raw >= 1e3 ? (raw / 1e3).toFixed(0) + 'k' : String(raw);
    ticks += `<line x1="${m.left}" y1="${py}" x2="${m.left - TICK_LEN}" y2="${py}" stroke="#000" stroke-width="0.75"/>`;
    ticks += `<text x="${m.left - TICK_LEN - 3}" y="${py + 2.5}" text-anchor="end" font-size="7">${label}</text>`;
  }

  // ── Legend ──
  let legend = '';
  let ly = m.top + 4;
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s) continue;
    const style = CH_PRINT[ch] || CH_PRINT.single;
    const label = mode === 'rgb' ? ch : (polarization || 'Data');
    legend += `<rect x="${m.left + pw - 48}" y="${ly}" width="8" height="8" fill="${style.fill}" stroke="${style.stroke}" stroke-width="0.75"/>`;
    legend += `<text x="${m.left + pw - 37}" y="${ly + 7}" font-size="7">${esc(label)}  n=${(s.count || 0).toLocaleString()}</text>`;
    ly += 12;
  }

  const xTitle = useDecibels ? 'Backscatter (dB)' : 'Power (linear)';
  const title = mode === 'rgb' ? (compositeId || 'RGB') : (polarization || '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="244" height="160"
     viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">
<rect width="${W}" height="${H}" fill="#fff"/>
<defs><clipPath id="histclip"><rect x="${m.left}" y="${m.top}" width="${pw}" height="${ph}"/></clipPath></defs>
<g clip-path="url(#histclip)">${paths}${limits}</g>
<!-- axes -->
<line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + ph}" stroke="#000" stroke-width="0.75"/>
<line x1="${m.left}" y1="${m.top + ph}" x2="${m.left + pw}" y2="${m.top + ph}" stroke="#000" stroke-width="0.75"/>
${ticks}
${legend}
<text x="${m.left + pw / 2}" y="${H - 6}" text-anchor="middle" font-size="8">${esc(xTitle)}</text>
<text x="4" y="${m.top + ph / 2}" text-anchor="middle" font-size="8"
      transform="rotate(-90,4,${m.top + ph / 2})">Count (log\u2081\u2080)</text>
${title ? `<text x="${m.left}" y="${m.top - 5}" font-size="8" font-weight="600">${esc(title)}</text>` : ''}
</svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Download helper
// ═══════════════════════════════════════════════════════════════════════════

export function downloadSVG(svgString, filename) {
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
