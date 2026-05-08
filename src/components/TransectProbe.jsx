import { useEffect, useRef, useState, useMemo } from 'react';
import { pixelToWorld } from '../utils/geo-overlays.js';

/**
 * TransectProbe — Bloomberg-terminal-style live transect graph.
 *
 * Hold G while moving the cursor: a profile graph appears at the bottom
 * showing the horizontal row of pixel values through the cursor. Cursor
 * column is highlighted on the graph in real time.
 *
 * Sampling:
 *   - Up to 512 samples across the full image width (decimated for perf).
 *   - Cached per-row: re-sampling only happens when the row changes.
 *   - Async fetches via getRowSamples (provided by parent or derived from
 *     getPixelValue); first appearance shows skeleton until data arrives.
 *
 * The graph itself is a simple SVG polyline — no chart library.
 */
export function TransectProbe({
  enabled,
  viewState,
  bounds,
  imageWidth,
  imageHeight,
  getPixelValue,
  useDecibels = true,
  contrastLimits = null,
  containerRef,
}) {
  const [active, setActive] = useState(false);  // G held
  const [cursor, setCursor] = useState(null);   // {row, col}
  const [samples, setSamples] = useState(null); // {row, values: Float32Array, samplesPerCol}
  const sampleRowRef = useRef(null);
  const inflightRef = useRef(0);

  // ── G key arms/disarms ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) { setActive(false); return; }
    const onDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'g' || e.key === 'G') setActive(true);
    };
    const onUp = (e) => { if (e.key === 'g' || e.key === 'G') setActive(false); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [enabled]);

  // ── Cursor tracking (only while active) ───────────────────────────
  useEffect(() => {
    if (!active || !enabled) return;
    const el = containerRef?.current;
    if (!el) return;

    const handle = (e) => {
      if (!viewState || !bounds || !imageWidth || !imageHeight) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) return;
      const [wx, wy] = pixelToWorld(cx, cy, viewState, rect.width, rect.height);
      const [minX, minY, maxX, maxY] = bounds;
      const col = Math.floor((wx - minX) / (maxX - minX) * imageWidth);
      const row = Math.floor((maxY - wy) / (maxY - minY) * imageHeight);
      if (row < 0 || row >= imageHeight || col < 0 || col >= imageWidth) return;
      setCursor({ row, col });
    };
    document.addEventListener('pointermove', handle);
    return () => document.removeEventListener('pointermove', handle);
  }, [active, enabled, viewState, bounds, imageWidth, imageHeight, containerRef]);

  // ── Sample the row when it changes ────────────────────────────────
  // Up to 512 columns spaced evenly across imageWidth.
  useEffect(() => {
    if (!active || !cursor || !getPixelValue || !imageWidth) return;
    const { row } = cursor;
    if (sampleRowRef.current === row) return;
    sampleRowRef.current = row;
    const N = Math.min(512, imageWidth);
    const stride = Math.max(1, Math.floor(imageWidth / N));
    const cols = [];
    for (let c = 0; c < imageWidth; c += stride) cols.push(c);
    const fetchId = ++inflightRef.current;
    Promise.all(cols.map(c => getPixelValue(row, c, 1).catch(() => null)))
      .then(vals => {
        if (fetchId !== inflightRef.current) return;
        if (sampleRowRef.current !== row) return;
        const f = new Float32Array(vals.length);
        for (let i = 0; i < vals.length; i++) {
          const v = unwrapNumber(vals[i]);
          f[i] = (v === null || !Number.isFinite(v)) ? NaN : v;
        }
        setSamples({ row, values: f, cols });
      });
  }, [active, cursor, getPixelValue, imageWidth]);

  // ── Build SVG polyline path ───────────────────────────────────────
  const pathInfo = useMemo(() => {
    if (!samples) return null;
    const { values } = samples;
    // Convert to dB if requested
    const xs = values;
    let yMin = Infinity, yMax = -Infinity;
    const transformed = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const v = xs[i];
      let y;
      if (Number.isNaN(v)) { transformed[i] = NaN; continue; }
      if (useDecibels) {
        y = (v <= 0) ? NaN : 10 * Math.log10(v);
      } else {
        y = v;
      }
      transformed[i] = y;
      if (Number.isFinite(y)) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;

    // Use contrast limits as Y range when available (so transect lines up
    // with on-screen shading); else use data min/max with a 5% margin.
    let yLo, yHi;
    if (Array.isArray(contrastLimits) && contrastLimits.length === 2) {
      yLo = contrastLimits[0];
      yHi = contrastLimits[1];
      if (!(yHi > yLo)) { yLo = yMin; yHi = yMax; }
    } else {
      const pad = 0.05 * (yMax - yMin || 1);
      yLo = yMin - pad;
      yHi = yMax + pad;
    }

    return { transformed, yLo, yHi };
  }, [samples, useDecibels, contrastLimits]);

  if (!active || !enabled) return null;

  const W = 600, H = 130, padL = 38, padR = 8, padT = 8, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  let polyPoints = '';
  let cursorX = null;
  if (pathInfo && samples) {
    const { transformed, yLo, yHi } = pathInfo;
    const yRange = yHi - yLo || 1;
    const stride = samples.cols.length > 1 ? plotW / (samples.cols.length - 1) : plotW;
    const pts = [];
    for (let i = 0; i < transformed.length; i++) {
      const v = transformed[i];
      if (!Number.isFinite(v)) continue;
      const x = padL + i * stride;
      const y = padT + plotH - (v - yLo) / yRange * plotH;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    polyPoints = pts.join(' ');
    if (cursor && samples.cols.length > 0) {
      const idx = nearestIdx(samples.cols, cursor.col);
      cursorX = padL + idx * stride;
    }
  }

  const yLo = pathInfo?.yLo ?? 0;
  const yHi = pathInfo?.yHi ?? 1;
  const unit = useDecibels ? 'dB' : '';

  return (
    <div style={{
      position: 'absolute',
      bottom: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      width: W,
      background: 'rgba(0, 0, 0, 0.85)',
      border: '1px solid #2a2a2a',
      borderTop: '2px solid #4ec9d4',
      pointerEvents: 'none',
      zIndex: 11,
      fontFamily: 'var(--font-mono, monospace)',
    }}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Plot frame */}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="none" stroke="#1a2a3a" strokeWidth={1} />

        {/* Y-axis labels */}
        <text x={padL - 4} y={padT + 4} fill="#5a7099" fontSize={9} textAnchor="end">{yHi.toFixed(1)}{unit}</text>
        <text x={padL - 4} y={padT + plotH} fill="#5a7099" fontSize={9} textAnchor="end">{yLo.toFixed(1)}{unit}</text>

        {/* Polyline */}
        {polyPoints && (
          <polyline
            points={polyPoints}
            fill="none"
            stroke="#4ec9d4"
            strokeWidth={1}
            strokeLinejoin="round"
          />
        )}

        {/* Cursor column marker */}
        {cursorX !== null && (
          <line x1={cursorX} y1={padT} x2={cursorX} y2={padT + plotH} stroke="#ffc832" strokeWidth={1} strokeDasharray="2,2" />
        )}

        {/* Footer */}
        <text x={padL} y={H - 6} fill="#5a7099" fontSize={9}>
          row {samples?.row ?? cursor?.row ?? '—'}
        </text>
        <text x={W - padR} y={H - 6} fill="#5a7099" fontSize={9} textAnchor="end">
          col {cursor?.col ?? '—'} of {imageWidth}
        </text>
        <text x={W / 2} y={H - 6} fill="#4ec9d4" fontSize={9} textAnchor="middle" letterSpacing={1}>
          TRANSECT (hold G)
        </text>
      </svg>
    </div>
  );
}

function unwrapNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'object') {
    if (typeof v.value === 'number') return v.value;
    if (typeof v.mean === 'number') return v.mean;
  }
  return null;
}

function nearestIdx(cols, target) {
  // cols is sorted ascending
  let lo = 0, hi = cols.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(cols[lo - 1] - target) < Math.abs(cols[lo] - target)) return lo - 1;
  return lo;
}

export default TransectProbe;
