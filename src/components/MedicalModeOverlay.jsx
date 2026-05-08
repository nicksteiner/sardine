import { useEffect, useRef, useState, useCallback } from 'react';
import { pixelToWorld } from '../utils/geo-overlays.js';

/**
 * MedicalModeOverlay — analytical / medical-imaging interaction layer.
 *
 * Merges medical-imaging gestures with ENVI-style analytical rigor:
 *   - Right-drag (or Shift+drag) on canvas: window/level
 *       horizontal → contrast width (window)
 *       vertical   → contrast center (level)
 *   - Persistent corner readout: row/col, raw, dB, 5×5 mean/std, geo coord
 *   - σ presets: 1σ / 2σ / 3σ / 2–98% derived from current histogram
 *   - Zoom snaps: 1:1, 2:1, 4:1 (data-pixel : screen-pixel)
 *   - Invert grayscale toggle
 *
 * Mounts as an absolute-positioned overlay inside SARViewer when medicalMode
 * is enabled. Uses pointerEvents:'none' on the chrome and toggles them on
 * the active drag region only, so it doesn't block deck.gl pan/zoom.
 */
export function MedicalModeOverlay({
  enabled,
  viewState,
  setViewState,
  bounds,
  imageWidth,
  imageHeight,
  contrastLimits,
  setContrastLimits,
  useDecibels,
  histogramData,
  inverted,
  setInverted,
  getPixelValue,
  xCoords,
  yCoords,
}) {
  const overlayRef = useRef(null);
  const [readout, setReadout] = useState(null);
  // Drag state for window/level
  const dragRef = useRef(null);

  // Resolve current single-band contrast limits (medical W/L is 1-D)
  const limits = Array.isArray(contrastLimits) ? contrastLimits : null;

  // ── Window/Level drag handler ────────────────────────────────────────
  // Right mouse button drag: X delta scales window width, Y delta shifts level.
  // Sensitivity scales with the current window so motion feels uniform.
  useEffect(() => {
    if (!enabled || !limits || !setContrastLimits) return;
    const el = overlayRef.current;
    if (!el) return;

    const onPointerDown = (e) => {
      // Right button only (button === 2). Left stays for pan.
      if (e.button !== 2) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startMin: limits[0],
        startMax: limits[1],
      };
    };

    const onPointerMove = (e) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const startWindow = d.startMax - d.startMin;
      const startCenter = 0.5 * (d.startMin + d.startMax);
      // Scale: 1 px = 0.5% of original window.
      // Wider windows move faster in absolute units; feels uniform perceptually.
      const winScale = Math.max(Math.abs(startWindow) * 0.005, 1e-6);
      const newWindow = Math.max(1e-6, startWindow + dx * winScale);
      // Y inverted (up = brighter = lower center value for amplitude data)
      const newCenter = startCenter - dy * winScale;
      const newMin = newCenter - newWindow / 2;
      const newMax = newCenter + newWindow / 2;
      setContrastLimits([newMin, newMax]);
    };

    const onPointerUp = (e) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      el.releasePointerCapture(e.pointerId);
      dragRef.current = null;
    };

    const preventContext = (e) => e.preventDefault();

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('contextmenu', preventContext);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('contextmenu', preventContext);
    };
  }, [enabled, limits, setContrastLimits]);

  // ── Cursor readout (raw + dB + 5×5 stats + geo) ──────────────────────
  const readoutCacheRef = useRef(null); // { row, col, raw, mean, std }
  useEffect(() => {
    if (!enabled || !getPixelValue) {
      setReadout(null);
      readoutCacheRef.current = null;
      return;
    }
    const el = overlayRef.current;
    if (!el) return;

    const handle = (e) => {
      if (!viewState || !bounds || !imageWidth || !imageHeight) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) {
        setReadout(null);
        return;
      }
      const [wx, wy] = pixelToWorld(cx, cy, viewState, rect.width, rect.height);
      const [minX, minY, maxX, maxY] = bounds;
      const col = Math.floor((wx - minX) / (maxX - minX) * imageWidth);
      const row = Math.floor((maxY - wy) / (maxY - minY) * imageHeight);
      if (row < 0 || row >= imageHeight || col < 0 || col >= imageWidth) {
        setReadout(null);
        return;
      }

      const cache = readoutCacheRef.current;
      const samePixel = cache && cache.row === row && cache.col === col;

      // Always update screen pos. Only re-fetch the raw + 5x5 if pixel changed.
      setReadout(prev => ({
        row, col, screenX: cx, screenY: cy,
        raw: samePixel ? prev?.raw : undefined,
        mean: samePixel ? prev?.mean : undefined,
        std: samePixel ? prev?.std : undefined,
      }));

      if (!samePixel) {
        // Sample two windows: 1×1 (raw) and 5×5 (mean/std).
        // getPixelValue returns either a number (single-band) or an object
        // {mean, std, ...} when windowSize > 1.
        Promise.all([
          getPixelValue(row, col, 1).catch(() => null),
          getPixelValue(row, col, 5).catch(() => null),
        ]).then(([raw, win]) => {
          // Race: skip stale results
          const c = readoutCacheRef.current;
          // (Allow first result through even if cache empty)
          if (c && (c.row !== row || c.col !== col)) {
            // a newer move already happened — discard
            return;
          }
          const r = unwrap(raw);
          const w = unwrap(win);
          const mean = (typeof w === 'object' && w !== null) ? w.mean : (typeof w === 'number' ? w : null);
          const std = (typeof w === 'object' && w !== null) ? w.std : null;
          readoutCacheRef.current = { row, col, raw: r, mean, std };
          setReadout(prev => prev ? { ...prev, raw: r, mean, std } : null);
        });
      } else {
        readoutCacheRef.current = { row, col, ...cache };
      }
    };

    const handleLeave = () => setReadout(null);

    document.addEventListener('pointermove', handle);
    document.addEventListener('pointerleave', handleLeave);
    return () => {
      document.removeEventListener('pointermove', handle);
      document.removeEventListener('pointerleave', handleLeave);
    };
  }, [enabled, getPixelValue, viewState, bounds, imageWidth, imageHeight]);

  // ── σ presets derived from histogram ─────────────────────────────────
  const applySigmaPreset = useCallback((sigmas) => {
    if (!histogramData || !setContrastLimits) return;
    const single = histogramData.single;
    if (!single) return;
    const { mean, std } = single;
    if (!Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return;
    setContrastLimits([mean - sigmas * std, mean + sigmas * std]);
  }, [histogramData, setContrastLimits]);

  const applyPercentile = useCallback(() => {
    if (!histogramData || !setContrastLimits) return;
    const single = histogramData.single;
    if (!single || !Number.isFinite(single.p2) || !Number.isFinite(single.p98)) return;
    setContrastLimits([single.p2, single.p98]);
  }, [histogramData, setContrastLimits]);

  // ── Zoom snap to integer pixel ratios ────────────────────────────────
  const snapZoom = useCallback((ratio) => {
    if (!viewState || !setViewState || !bounds || !imageWidth) return;
    // ratio: positive = N screen px per data px (zoom in)
    //        negative = 1 data px per N screen px (zoom out)
    const dataPxPerWorldUnit = imageWidth / (bounds[2] - bounds[0]);
    // deck.gl OrthographicView: pixelsPerUnit = 2^zoom
    // we want: screenPx / dataPx = ratio  →  pixelsPerUnit = ratio * dataPxPerWorldUnit
    const pixelsPerUnit = ratio * dataPxPerWorldUnit;
    const zoom = Math.log2(pixelsPerUnit);
    setViewState({ ...viewState, zoom });
  }, [viewState, setViewState, bounds, imageWidth]);

  if (!enabled) return null;

  // Geographic label
  let geoLabel = null;
  if (readout && xCoords && yCoords) {
    const { col, row } = readout;
    if (col >= 0 && col < xCoords.length && row >= 0 && row < yCoords.length) {
      const x = xCoords[col];
      const y = yCoords[row];
      const isGeo = Math.abs(x) <= 180 && Math.abs(y) <= 90;
      geoLabel = isGeo
        ? `${y.toFixed(5)}°  ${x.toFixed(5)}°`
        : `E ${x.toFixed(1)}m  N ${y.toFixed(1)}m`;
    }
  }

  return (
    <>
      {/* Full-screen drag layer for W/L. Uses transparent background so
          deck.gl handles left-click pan but right-click goes to W/L. */}
      <div
        ref={overlayRef}
        style={{
          position: 'absolute',
          inset: 0,
          // pointer events on so the right-click drag is captured.
          // Left clicks are not intercepted (pointerdown filters by button).
          pointerEvents: 'auto',
          background: 'transparent',
          zIndex: 4,
          cursor: dragRef.current ? 'ns-resize' : 'crosshair',
        }}
        onPointerDownCapture={(e) => {
          // Let left-button events bubble to deck.gl underneath.
          // Right-button drags are handled in the useEffect.
          if (e.button === 0) {
            // re-dispatch is unnecessary; just not stopPropagation lets it pass
          }
        }}
      />

      {/* Persistent readout — top-left corner */}
      <ReadoutPanel
        readout={readout}
        useDecibels={useDecibels}
        geoLabel={geoLabel}
        contrastLimits={limits}
      />

      {/* Analytical control rail — top-right */}
      <ControlRail
        onSigma={applySigmaPreset}
        onPercentile={applyPercentile}
        onSnap={snapZoom}
        inverted={inverted}
        setInverted={setInverted}
        hasHistogram={!!(histogramData?.single)}
      />
    </>
  );
}

/**
 * unwrap — async pixel results may resolve to undefined/null/number/object.
 * Normalize to a usable value or null.
 */
function unwrap(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'object') return v;
  return null;
}

function fmtRaw(v) {
  if (v === undefined) return '…';
  if (v === null) return '—';
  if (typeof v === 'object') return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 0.001 || a > 10000) return v.toExponential(3);
  return v.toFixed(4);
}

function fmtDb(v) {
  if (v === undefined) return '…';
  if (v === null || typeof v !== 'number' || v <= 0) return '—';
  return `${(10 * Math.log10(v)).toFixed(2)} dB`;
}

function ReadoutPanel({ readout, useDecibels, geoLabel, contrastLimits }) {
  const win = contrastLimits ? (contrastLimits[1] - contrastLimits[0]) : null;
  const ctr = contrastLimits ? 0.5 * (contrastLimits[0] + contrastLimits[1]) : null;
  const unit = useDecibels ? 'dB' : '';

  return (
    <div style={{
      position: 'absolute',
      top: 8,
      left: 44, // clear of the home button at left:10
      background: 'rgba(0, 0, 0, 0.78)',
      border: '1px solid #2a2a2a',
      borderLeft: '2px solid #4ec9d4',
      padding: '6px 10px',
      color: '#e8edf5',
      fontSize: '0.68rem',
      fontFamily: 'var(--font-mono, monospace)',
      lineHeight: 1.5,
      pointerEvents: 'none',
      zIndex: 10,
      minWidth: 220,
    }}>
      <div style={{ color: '#5a7099', fontSize: '0.6rem', letterSpacing: 1, marginBottom: 2 }}>
        ANALYTICAL · MEDICAL
      </div>
      {readout ? (
        <>
          <Row label="px" val={`(${readout.col}, ${readout.row})`} />
          {geoLabel && <Row label="geo" val={geoLabel} />}
          <Row label="raw" val={fmtRaw(readout.raw)} accent />
          <Row label="dB" val={fmtDb(readout.raw)} accent />
          <Row label="μ 5×5" val={fmtRaw(readout.mean)} />
          <Row label="σ 5×5" val={fmtRaw(readout.std)} />
        </>
      ) : (
        <div style={{ color: '#5a7099', fontStyle: 'italic' }}>move cursor over data</div>
      )}
      <div style={{ borderTop: '1px solid #1a1a1a', marginTop: 4, paddingTop: 3, color: '#5a7099', fontSize: '0.6rem' }}>
        {win !== null && (
          <>W {win.toFixed(2)}{unit} · L {ctr.toFixed(2)}{unit}</>
        )}
      </div>
      <div style={{ color: '#3a4a5f', fontSize: '0.55rem', marginTop: 2 }}>
        right-drag X=window Y=level
      </div>
    </div>
  );
}

function Row({ label, val, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#5a7099' }}>{label}</span>
      <span style={{ color: accent ? '#4ec9d4' : '#e8edf5', fontWeight: accent ? 500 : 400 }}>
        {val}
      </span>
    </div>
  );
}

function ControlRail({ onSigma, onPercentile, onSnap, inverted, setInverted, hasHistogram }) {
  const btn = {
    background: 'rgba(0, 0, 0, 0.78)',
    border: '1px solid #2a2a2a',
    color: '#e8edf5',
    padding: '3px 8px',
    fontSize: '0.65rem',
    fontFamily: 'var(--font-mono, monospace)',
    cursor: 'pointer',
    borderRadius: 0,
  };
  const sectionLabel = {
    color: '#5a7099',
    fontSize: '0.55rem',
    letterSpacing: 1,
    margin: '2px 0',
  };
  const disabled = !hasHistogram;
  return (
    <div style={{
      position: 'absolute',
      top: 200, // below ColorbarOverlay
      right: 'var(--space-lg, 24px)',
      background: 'rgba(0, 0, 0, 0.78)',
      border: '1px solid #2a2a2a',
      padding: '6px 8px',
      pointerEvents: 'auto',
      zIndex: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={sectionLabel}>STRETCH</div>
      <div style={{ display: 'flex', gap: 2 }}>
        {[1, 2, 3].map(n => (
          <button
            key={n}
            disabled={disabled}
            onClick={() => onSigma(n)}
            style={{ ...btn, opacity: disabled ? 0.4 : 1 }}
            title={`±${n}σ from histogram`}
          >
            {n}σ
          </button>
        ))}
        <button
          disabled={disabled}
          onClick={onPercentile}
          style={{ ...btn, opacity: disabled ? 0.4 : 1 }}
          title="2nd–98th percentile"
        >
          2–98%
        </button>
      </div>

      <div style={sectionLabel}>ZOOM</div>
      <div style={{ display: 'flex', gap: 2 }}>
        <button onClick={() => onSnap(0.25)} style={btn} title="1 data px = 4 screen px (1/4)">1:4</button>
        <button onClick={() => onSnap(1)} style={btn} title="1:1 actual size">1:1</button>
        <button onClick={() => onSnap(2)} style={btn} title="2 screen px per data px">2:1</button>
        <button onClick={() => onSnap(4)} style={btn} title="4 screen px per data px">4:1</button>
      </div>

      <div style={sectionLabel}>DISPLAY</div>
      <button
        onClick={() => setInverted(!inverted)}
        style={{ ...btn, background: inverted ? 'rgba(78, 201, 212, 0.2)' : btn.background }}
        title="Invert grayscale (medical convention)"
      >
        {inverted ? '◐ inverted' : '◑ invert'}
      </button>
    </div>
  );
}

export default MedicalModeOverlay;
