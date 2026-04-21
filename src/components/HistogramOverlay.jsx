/**
 * HistogramOverlay — Viewport-snapped publication-quality histogram inset.
 *
 * Renders a compact, high-DPI histogram canvas positioned inside the viewer.
 * Designed to be journal-ready: clean typography, subtle gridlines, no clutter.
 * When visible, the histogram is automatically included in figure exports.
 *
 * Toggle with the 'h' key (when no ROI is active) or via the overlay API.
 *
 * Supports:
 *   - Single-band mode: one histogram (HH, HV, VV, etc.)
 *   - RGB/multi-channel mode: overlaid translucent histograms per channel
 *   - dB and linear scales
 *   - Contrast limit markers with percentile annotations
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { SAR_COMPOSITES } from '../utils/sar-composites.js';
import { generateHistogramSVG, downloadSVG } from '../utils/svg-export.js';

const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

// ─── Publication-quality palette ─────────────────────────────────────────
// Colors chosen for perceptual separability on dark backgrounds and in print.
const CHANNEL_COLORS = {
  R:      { fill: 'rgba(231, 76, 60, 0.45)',   stroke: 'rgba(231, 76, 60, 0.9)',   legend: '#e74c3c' },
  G:      { fill: 'rgba(46, 204, 113, 0.40)',   stroke: 'rgba(46, 204, 113, 0.85)', legend: '#2ecc71' },
  B:      { fill: 'rgba(52, 152, 219, 0.40)',   stroke: 'rgba(52, 152, 219, 0.85)', legend: '#3498db' },
  single: { fill: 'rgba(78, 201, 212, 0.35)',   stroke: 'rgba(78, 201, 212, 0.85)', legend: '#4ec9d4' },
};

/**
 * Derive legend labels from the composite preset.
 * e.g. 'hh-hv-vv' → {R:'HHHH', G:'HVHV', B:'VVVV'}
 *      'pauli-power' → {R:'|HH−VV|', G:'HVHV', B:'HH+VV'}
 */
function getChannelLabels(compositeId) {
  const preset = compositeId && SAR_COMPOSITES[compositeId];
  if (!preset?.channels) return { R: 'R', G: 'G', B: 'B' };
  const labels = {};
  for (const ch of ['R', 'G', 'B']) {
    const def = preset.channels[ch];
    if (def?.label) labels[ch] = def.label;
    else if (def?.dataset) labels[ch] = def.dataset;
    else labels[ch] = ch;
  }
  return labels;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Format a value for axis labels. */
function fmtAxis(v, isDb) {
  if (isDb) return v.toFixed(0);
  if (Math.abs(v) < 0.001 || Math.abs(v) >= 100000) return v.toExponential(1);
  if (Math.abs(v) < 1) return v.toFixed(3);
  return v.toFixed(1);
}

/** Generate nice tick positions for an axis. */
function niceTicks(min, max, targetCount = 6) {
  const range = max - min;
  if (range <= 0) return [min];
  const rough = range / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / mag;
  let step;
  if (residual <= 1.5) step = mag;
  else if (residual <= 3) step = 2 * mag;
  else if (residual <= 7) step = 5 * mag;
  else step = 10 * mag;

  const ticks = [];
  let v = Math.ceil(min / step) * step;
  while (v <= max + step * 0.01) {
    ticks.push(v);
    v += step;
  }
  return ticks;
}

// ─── Core drawing function (reused by React component + figure export) ──

/**
 * Draw a publication-quality histogram onto a 2D canvas context.
 *
 * @param {CanvasRenderingContext2D} ctx - Target context (already scaled for DPR if needed)
 * @param {number} W - Logical width of the drawing area
 * @param {number} H - Logical height of the drawing area
 * @param {Object} opts
 * @param {Object} opts.histograms - {single: stats} | {R: stats, G: stats, B: stats}
 * @param {string} opts.mode - 'single' | 'rgb'
 * @param {*}      opts.contrastLimits - [min,max] | {R:[],G:[],B:[]}
 * @param {boolean} opts.useDecibels
 * @param {string} [opts.polarization]
 * @param {string} [opts.compositeId]
 * @param {boolean} [opts.compact=false] - Use smaller margins for inset mode
 */
export function drawHistogramCanvas(ctx, W, H, opts) {
  const {
    histograms, mode, contrastLimits, useDecibels,
    polarization, compositeId, compact = false, logScale = true,
  } = opts;

  if (!histograms) return;

  const channels = mode === 'rgb' ? ['R', 'G', 'B'] : ['single'];

  // Determine global data range
  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const ch of channels) {
    const s = histograms[ch];
    if (s) {
      if (s.min < globalMin) globalMin = s.min;
      if (s.max > globalMax) globalMax = s.max;
    }
  }
  if (!isFinite(globalMin)) { globalMin = 0; globalMax = 1; }

  // ── Layout constants ──
  const margin = compact
    ? { top: 24, right: 16, bottom: 34, left: 48 }
    : { top: 48, right: 40, bottom: 56, left: 72 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  if (plotW < 60 || plotH < 40) return;

  const fontSize = compact ? 9 : 12;
  const titleFontSize = compact ? 11 : 16;
  const axisTitleSize = compact ? 10 : 13;
  const legendFontSize = compact ? 9 : 12;
  const statsFontSize = compact ? 8 : 10;

  // ── Background ──
  ctx.fillStyle = 'rgba(10, 22, 40, 0.94)';
  ctx.fillRect(0, 0, W, H);

  // ── Compute Y-axis max ──
  let yMax = 1;
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s?.bins) continue;
    for (const b of s.bins) {
      const v = logScale ? Math.log10(b + 1) : b;
      if (v > yMax) yMax = v;
    }
  }
  yMax *= 1.08;

  const toY = logScale ? (count) => Math.log10(count + 1) : (count) => count;

  // ── Axis scales ──
  const xScale = (v) => margin.left + ((v - globalMin) / (globalMax - globalMin)) * plotW;
  const yScale = (v) => margin.top + plotH - (v / yMax) * plotH;

  // ── Gridlines ──
  const xTicks = niceTicks(globalMin, globalMax, Math.min(compact ? 5 : 10, Math.floor(plotW / (compact ? 50 : 80))));
  const yTicks = niceTicks(0, yMax, Math.min(compact ? 4 : 6, Math.floor(plotH / (compact ? 40 : 60))));

  ctx.strokeStyle = 'rgba(90, 112, 153, 0.18)';
  ctx.lineWidth = 0.5;
  for (const t of xTicks) {
    const x = xScale(t);
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
  }
  for (const t of yTicks) {
    if (t === 0) continue;
    const y = yScale(t);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
  }

  // ── Plot frame ──
  ctx.strokeStyle = 'rgba(90, 112, 153, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left, margin.top, plotW, plotH);

  // ── Draw histograms ──
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s?.bins) continue;
    const style = CHANNEL_COLORS[ch] || CHANNEL_COLORS.single;

    const binCount = s.bins.length;
    const dataRange = s.max - s.min || 1;

    // Filled area
    ctx.beginPath();
    ctx.moveTo(xScale(s.min), yScale(0));
    for (let i = 0; i < binCount; i++) {
      const binLeft = s.min + (i / binCount) * dataRange;
      const binRight = s.min + ((i + 1) / binCount) * dataRange;
      const yVal = toY(s.bins[i]);
      ctx.lineTo(xScale(binLeft), yScale(yVal));
      ctx.lineTo(xScale(binRight), yScale(yVal));
    }
    ctx.lineTo(xScale(s.max), yScale(0));
    ctx.closePath();
    ctx.fillStyle = style.fill;
    ctx.fill();

    // Stroke outline
    ctx.beginPath();
    for (let i = 0; i < binCount; i++) {
      const binLeft = s.min + (i / binCount) * dataRange;
      const binRight = s.min + ((i + 1) / binCount) * dataRange;
      const yVal = toY(s.bins[i]);
      const x1 = xScale(binLeft);
      const x2 = xScale(binRight);
      const y = yScale(yVal);
      if (i === 0) ctx.moveTo(x1, y);
      else ctx.lineTo(x1, y);
      ctx.lineTo(x2, y);
    }
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = compact ? 1 : 1.5;
    ctx.stroke();
  }

  // ── Contrast limit markers ──
  const drawLimitLine = (val, label, color) => {
    const x = xScale(val);
    if (x < margin.left || x > margin.left + plotW) return;
    ctx.save();
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = compact ? 1 : 1.5;
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = `600 ${compact ? 8 : 11}px 'JetBrains Mono', 'Fira Code', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x, margin.top + (compact ? 2 : 4));
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  };

  if (mode === 'rgb' && contrastLimits) {
    for (const ch of channels) {
      const lim = contrastLimits[ch];
      if (!lim) continue;
      const style = CHANNEL_COLORS[ch];
      drawLimitLine(lim[0], `${ch} lo`, style.stroke);
      drawLimitLine(lim[1], `${ch} hi`, style.stroke);
    }
  } else if (mode === 'single' && contrastLimits) {
    const [lo, hi] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
    drawLimitLine(lo, 'lo', '#e8833a');
    drawLimitLine(hi, 'hi', '#e8833a');
  }

  // ── Percentile markers (p2/p98) ──
  for (const ch of channels) {
    const s = histograms[ch];
    if (!s) continue;
    const style = CHANNEL_COLORS[ch] || CHANNEL_COLORS.single;

    for (const [pVal] of [[s.p2, 'p2'], [s.p98, 'p98']]) {
      const x = xScale(pVal);
      if (x < margin.left || x > margin.left + plotW) continue;
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = `${style.legend}66`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, margin.top + plotH - 10); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ── X-axis labels ──
  ctx.fillStyle = 'rgba(232, 237, 245, 0.85)';
  ctx.font = `400 ${fontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) {
    ctx.fillText(fmtAxis(t, useDecibels), xScale(t), margin.top + plotH + (compact ? 4 : 8));
  }

  // X-axis title
  ctx.fillStyle = 'rgba(232, 237, 245, 0.7)';
  ctx.font = `400 ${axisTitleSize}px 'Inter', 'Helvetica Neue', sans-serif`;
  ctx.fillText(useDecibels ? 'Backscatter (dB)' : 'Power (linear)', margin.left + plotW / 2, margin.top + plotH + (compact ? 18 : 32));

  // ── Y-axis labels ──
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(232, 237, 245, 0.85)';
  ctx.font = `400 ${fontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
  for (const t of yTicks) {
    if (t === 0) continue;
    const y = yScale(t);
    let label;
    if (logScale) {
      const actual = Math.round(Math.pow(10, t));
      if (actual >= 1e6) label = (actual / 1e6).toFixed(0) + 'M';
      else if (actual >= 1e3) label = (actual / 1e3).toFixed(0) + 'k';
      else label = String(actual);
    } else {
      if (t >= 1e6) label = (t / 1e6).toFixed(0) + 'M';
      else if (t >= 1e3) label = (t / 1e3).toFixed(0) + 'k';
      else label = String(Math.round(t));
    }
    ctx.fillText(label, margin.left - (compact ? 4 : 8), y);
  }

  // Y-axis title (rotated)
  ctx.save();
  ctx.translate(compact ? 10 : 16, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(232, 237, 245, 0.7)';
  ctx.font = `400 ${axisTitleSize}px 'Inter', 'Helvetica Neue', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(logScale ? (compact ? 'Count' : 'Count (log₁₀)') : 'Count', 0, 0);
  ctx.restore();

  // ── Legend ──
  const legendX = margin.left + plotW - (compact ? 4 : 10);
  let legendY = margin.top + (compact ? 10 : 16);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const chLabels = mode === 'rgb' ? getChannelLabels(compositeId) : {};

  for (const ch of channels) {
    const s = histograms[ch];
    if (!s) continue;
    const style = CHANNEL_COLORS[ch] || CHANNEL_COLORS.single;
    const labelText = mode === 'rgb'
      ? (chLabels[ch] || ch)
      : (polarization || 'Data');

    // Swatch
    ctx.fillStyle = style.fill;
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = compact ? 1 : 1.5;
    const swatchSize = compact ? 8 : 12;
    const swatchX = legendX - (compact ? 80 : 84);
    ctx.fillRect(swatchX, legendY - swatchSize / 2, swatchSize, swatchSize);
    ctx.strokeRect(swatchX, legendY - swatchSize / 2, swatchSize, swatchSize);

    // Label (after swatch)
    ctx.fillStyle = 'rgba(232, 237, 245, 0.9)';
    ctx.font = `600 ${legendFontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(labelText, swatchX + swatchSize + 4, legendY);

    // Count (right-aligned, separate line in compact to avoid overlap)
    ctx.fillStyle = 'rgba(232, 237, 245, 0.45)';
    ctx.font = `400 ${statsFontSize}px 'JetBrains Mono', 'Fira Code', monospace`;
    ctx.textAlign = 'right';
    const countStr = s.count != null ? `n=${s.count >= 1e6 ? (s.count / 1e6).toFixed(1) + 'M' : s.count >= 1e3 ? (s.count / 1e3).toFixed(0) + 'k' : s.count}` : '';
    ctx.fillText(countStr, legendX, legendY);

    legendY += compact ? 15 : 20;
  }

  // ── Title ──
  ctx.fillStyle = 'rgba(232, 237, 245, 0.95)';
  ctx.font = `600 ${titleFontSize}px 'Inter', 'Helvetica Neue', sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const title = mode === 'rgb'
    ? `Histogram — ${compositeId || 'RGB Composite'}`
    : `Histogram — ${polarization || 'Single Band'}`;
  ctx.fillText(title, margin.left, compact ? 6 : 14);
}

// ─── Main overlay component ──────────────────────────────────────────────

export function HistogramOverlay({
  histograms,       // {single: stats} | {R: stats, G: stats, B: stats}
  mode,             // 'single' | 'rgb'
  contrastLimits,   // [min,max] | {R:[],G:[],B:[]}
  useDecibels,
  logScale = true,
  polarization,     // Current polarization label (e.g. 'HHHH') for single-band title
  compositeId,      // Composite name for RGB title
  onClose,          // () => void
}) {
  const canvasRef = useRef(null);
  const [drawCount, setDrawCount] = useState(0);

  // ── Fingerprint the histogram data so we can detect real changes ──
  const dataFingerprint = histograms
    ? Object.keys(histograms).map(k => {
        const s = histograms[k];
        return s ? `${k}:${s.min}:${s.max}:${s.count}` : k;
      }).join('|')
    : '';

  // ── Draw on canvas ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !histograms) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W === 0 || H === 0) return;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, W, H);

    drawHistogramCanvas(ctx, W, H, {
      histograms, mode, contrastLimits, useDecibels,
      polarization, compositeId, compact: true, logScale,
    });
  }, [dataFingerprint, mode, contrastLimits, useDecibels, logScale, polarization, compositeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Redraw when draw function changes or manual refresh ──
  useEffect(() => {
    requestAnimationFrame(() => draw());
  }, [draw, drawCount]);

  // ── Resize handler ──
  useEffect(() => {
    const handleResize = () => requestAnimationFrame(() => draw());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  // ── Keyboard dismiss ──
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape' || e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey, true); // capture phase
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const handleExportSVG = useCallback(() => {
    const svg = generateHistogramSVG(histograms, mode, contrastLimits, useDecibels, polarization, compositeId);
    if (svg) downloadSVG(svg, 'histogram.svg');
  }, [histograms, mode, contrastLimits, useDecibels, polarization, compositeId]);

  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      right: 16,
      width: 460,
      height: 260,
      background: 'rgba(10, 22, 40, 0.94)',
      border: '1px solid var(--sardine-border)',
      borderRadius: 'var(--radius-md)',
      zIndex: 30,
      fontFamily: 'var(--font-mono)',
      color: 'var(--text-primary)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }} onClick={(e) => e.stopPropagation()}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px 0 12px', flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.5px' }}>
          <span style={{ color: 'var(--sardine-cyan)' }}>Histogram</span>
        </span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onClick={() => setDrawCount(c => c + 1)} title="Redraw histogram" className="btn-ghost" style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 'var(--radius-sm)', textTransform: 'none',
            letterSpacing: 0,
          }}>&#8635;</button>
          <button onClick={handleExportSVG} title="Export SVG" className="btn-ghost" style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 'var(--radius-sm)', textTransform: 'none',
            letterSpacing: 0,
          }}>SVG</button>
          <button onClick={onClose} aria-label="Close histogram" style={{
            background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
            fontSize: 16, padding: '0 4px', lineHeight: 1, textTransform: 'none',
            letterSpacing: 0, boxShadow: 'none',
          }}>&times;</button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
