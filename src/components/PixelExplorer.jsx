import { useState, useRef, useEffect, useMemo } from 'react';
import { pixelToWorld } from '../utils/geo-overlays.js';

/**
 * PixelExplorer — hover tooltip + sampling-window bounding box.
 *
 * Uses pointerEvents:'none' so it doesn't block deck.gl pan/zoom or
 * ROI Shift+drag. Listens on document for pointermove.
 */
export function PixelExplorer({
  viewState,
  bounds,
  imageWidth,
  imageHeight,
  getPixelValue,
  useDecibels = true,
  windowSize = 1,
  enabled = true,
  xCoords,
  yCoords,
}) {
  const overlayRef = useRef(null);
  const [cursorInfo, setCursorInfo] = useState(null);

  // Stale detection: invalidate if cursor moves to different pixel.
  // We do NOT use a monotonic counter because that would drop results for
  // slow async chunk fetches when the mouse is still over the same pixel.
  const cursorRef = useRef(null); // {row, col} currently displayed

  useEffect(() => {
    if (!enabled || !getPixelValue) return;

    const handleMove = (e) => {
      const el = overlayRef.current;
      if (!el || !viewState || !bounds || !imageWidth || !imageHeight) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) {
        setCursorInfo(null);
        cursorRef.current = null;
        return;
      }

      const [wx, wy] = pixelToWorld(cx, cy, viewState, rect.width, rect.height);
      // Y is flipped: world Y increases upward but image row 0 is at the top
      const [minX, minY, maxX, maxY] = bounds;
      const px = (wx - minX) / (maxX - minX) * imageWidth;
      const py = (maxY - wy) / (maxY - minY) * imageHeight;
      const col = Math.floor(px);
      const row = Math.floor(py);

      if (row < 0 || row >= imageHeight || col < 0 || col >= imageWidth) {
        setCursorInfo(null);
        cursorRef.current = null;
        return;
      }

      // Update screen position immediately; keep cached value if same pixel
      const samePixel = cursorRef.current?.row === row && cursorRef.current?.col === col;
      cursorRef.current = { row, col };
      setCursorInfo(prev => ({
        row, col,
        screenX: cx,
        screenY: cy,
        value: samePixel ? prev?.value : undefined,
      }));

      if (!samePixel) {
        getPixelValue(row, col, windowSize).then(val => {
          // Only commit if cursor is still at this pixel
          if (cursorRef.current?.row !== row || cursorRef.current?.col !== col) return;
          setCursorInfo(prev => prev ? { ...prev, value: val } : null);
        }).catch(() => {});
      }
    };

    const handleLeave = () => {
      setCursorInfo(null);
      cursorRef.current = null;
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerleave', handleLeave);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerleave', handleLeave);
    };
  }, [enabled, getPixelValue, viewState, bounds, imageWidth, imageHeight, windowSize]);

  useEffect(() => {
    if (!enabled) { setCursorInfo(null); cursorRef.current = null; }
  }, [enabled]);

  // Geographic label from coord arrays
  const geoLabel = useMemo(() => {
    if (!cursorInfo || !xCoords || !yCoords) return null;
    const { col, row } = cursorInfo;
    if (col < 0 || col >= xCoords.length || row < 0 || row >= yCoords.length) return null;
    const x = xCoords[col];
    const y = yCoords[row];
    const isGeo = Math.abs(x) <= 180 && Math.abs(y) <= 90;
    return isGeo
      ? `${y.toFixed(5)}\u00B0, ${x.toFixed(5)}\u00B0`
      : `E ${x.toFixed(1)}m, N ${y.toFixed(1)}m`;
  }, [cursorInfo, xCoords, yCoords]);

  // Sampling window size in screen pixels
  const windowScreenPx = useMemo(() => {
    if (!viewState || !bounds || windowSize <= 1) return null;
    const ppu = Math.pow(2, viewState.zoom || 0);
    const worldPerImagePx = (bounds[2] - bounds[0]) / (imageWidth || 1);
    return windowSize * worldPerImagePx * ppu;
  }, [viewState, bounds, imageWidth, windowSize]);

  if (!enabled) return null;

  return (
    <div
      ref={overlayRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}
    >
      {/* Sampling-window bounding box */}
      {cursorInfo && windowScreenPx > 2 && (
        <div style={{
          position: 'absolute',
          left: cursorInfo.screenX - windowScreenPx / 2,
          top: cursorInfo.screenY - windowScreenPx / 2,
          width: windowScreenPx,
          height: windowScreenPx,
          border: '1px solid rgba(78, 201, 212, 0.75)',
          borderRadius: 1,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }} />
      )}

      {cursorInfo && (
        <PixelTooltip
          info={cursorInfo}
          useDecibels={useDecibels}
          windowSize={windowSize}
          geoLabel={geoLabel}
        />
      )}
    </div>
  );
}

function PixelTooltip({ info, useDecibels, windowSize, geoLabel }) {
  const { screenX, screenY, row, col, value } = info;

  const formatSingle = (v) => {
    if (v === undefined) return '\u2026'; // ellipsis = loading
    if (isNaN(v) || v === null) return 'nodata';
    if (v === 0) return 'nodata';
    if (useDecibels) return `${(10 * Math.log10(v)).toFixed(2)} dB`;
    return v < 0.001 || v > 10000 ? v.toExponential(3) : v.toFixed(4);
  };

  const formatValue = (v) => {
    if (v === undefined) return '\u2026';
    if (v === null) return 'nodata';
    if (typeof v === 'object') {
      return Object.entries(v)
        .map(([k, val]) => `${k}: ${formatSingle(val)}`)
        .join('\n');
    }
    return formatSingle(v);
  };

  const text = formatValue(value);
  const isMultiLine = typeof value === 'object' && value !== null;
  const lines = isMultiLine ? text.split('\n') : [text];

  return (
    <div style={{
      position: 'absolute',
      left: screenX + 18,
      top: screenY + 12,
      background: 'rgba(10, 22, 40, 0.93)',
      border: '1px solid var(--sardine-border, #1e3a5f)',
      borderLeft: '2px solid var(--sardine-cyan, #4ec9d4)',
      borderRadius: '2px',
      padding: '5px 10px',
      color: 'var(--text-primary, #e8edf5)',
      fontSize: '0.7rem',
      fontFamily: 'var(--font-mono, monospace)',
      pointerEvents: 'none',
      whiteSpace: 'pre',
      zIndex: 20,
      lineHeight: 1.55,
    }}>
      <div style={{ color: 'var(--text-muted, #5a7099)', marginBottom: 1 }}>
        px ({col}, {row}){windowSize > 1 ? ` \u00B7 ${windowSize}\u00D7${windowSize}` : ''}
      </div>
      {geoLabel && (
        <div style={{ color: 'var(--text-muted, #5a7099)', marginBottom: 1 }}>
          {geoLabel}
        </div>
      )}
      {lines.map((line, i) => (
        <div key={i} style={{ color: 'var(--sardine-cyan, #4ec9d4)', fontWeight: 500 }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export default PixelExplorer;
