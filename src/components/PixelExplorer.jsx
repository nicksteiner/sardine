import React, { useState, useRef, useEffect, useMemo } from 'react';
import { pixelToWorld } from '../utils/geo-overlays.js';

/**
 * PixelExplorer — Shows pixel value at cursor position.
 *
 * Uses pointerEvents: 'none' so it doesn't interfere with deck.gl pan/zoom
 * or ROI overlay Shift+drag. Listens on the document for pointermove events
 * and checks if the cursor is within the overlay bounds.
 *
 * Props:
 *   viewState       — deck.gl viewState {target, zoom}
 *   bounds          — [minX, minY, maxX, maxY] world bounds of the image
 *   imageWidth      — source image width in pixels
 *   imageHeight     — source image height in pixels
 *   getPixelValue   — async (row, col, windowSize?) => number|object|NaN
 *   useDecibels     — convert power to dB for display
 *   windowSize      — averaging window (odd int, default 1)
 *   enabled         — show/hide the explorer
 *   xCoords         — optional Float64Array of easting coords (length = imageWidth)
 *   yCoords         — optional Float64Array of northing coords (length = imageHeight)
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
  const pendingRef = useRef(0); // monotonic counter to discard stale lookups

  // Listen on document for pointermove — doesn't steal events from deck.gl
  useEffect(() => {
    if (!enabled || !getPixelValue) return;

    const handleMove = (e) => {
      const el = overlayRef.current;
      if (!el || !viewState || !bounds || !imageWidth || !imageHeight) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      // Outside the viewer area
      if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) {
        setCursorInfo(null);
        pendingRef.current++;
        return;
      }

      const [wx, wy] = pixelToWorld(cx, cy, viewState, rect.width, rect.height);
      const [minX, minY, maxX, maxY] = bounds;
      const px = (wx - minX) / (maxX - minX) * imageWidth;
      const py = (wy - minY) / (maxY - minY) * imageHeight;
      const col = Math.floor(px);
      const row = Math.floor(py);

      if (row < 0 || row >= imageHeight || col < 0 || col >= imageWidth) {
        setCursorInfo(null);
        pendingRef.current++;
        return;
      }

      const id = ++pendingRef.current;
      // Show position immediately, value when ready
      setCursorInfo(prev => ({
        row, col,
        screenX: cx,
        screenY: cy,
        value: prev?.row === row && prev?.col === col ? prev.value : undefined,
      }));

      getPixelValue(row, col, windowSize).then(val => {
        if (pendingRef.current !== id) return; // stale
        setCursorInfo(prev => prev ? { ...prev, value: val } : null);
      }).catch(() => {});
    };

    const handleLeave = () => {
      setCursorInfo(null);
      pendingRef.current++;
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerleave', handleLeave);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerleave', handleLeave);
    };
  }, [enabled, getPixelValue, viewState, bounds, imageWidth, imageHeight, windowSize]);

  // Clear when disabled
  useEffect(() => {
    if (!enabled) setCursorInfo(null);
  }, [enabled]);

  // Format geo-coords from coordinate arrays if available
  const geoLabel = useMemo(() => {
    if (!cursorInfo || !xCoords || !yCoords) return null;
    const { col, row } = cursorInfo;
    if (col < 0 || col >= xCoords.length || row < 0 || row >= yCoords.length) return null;
    const x = xCoords[col];
    const y = yCoords[row];
    // Detect geographic vs projected
    const isGeo = Math.abs(x) <= 180 && Math.abs(y) <= 90;
    if (isGeo) {
      return `${y.toFixed(5)}\u00B0, ${x.toFixed(5)}\u00B0`;
    }
    return `E ${x.toFixed(1)}m, N ${y.toFixed(1)}m`;
  }, [cursorInfo, xCoords, yCoords]);

  if (!enabled) return null;

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
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

/**
 * Tooltip showing pixel value near the cursor.
 */
function PixelTooltip({ info, useDecibels, windowSize, geoLabel }) {
  const { screenX, screenY, row, col, value } = info;

  const formatValue = (v) => {
    if (v === undefined) return '...';
    if (v === null) return '\u2014';
    if (typeof v === 'object') {
      // Multi-band: {HHHH: val, HVHV: val, ...}
      return Object.entries(v).map(([k, val]) => {
        return `${k}: ${formatSingle(val)}`;
      }).join('\n');
    }
    return formatSingle(v);
  };

  const formatSingle = (v) => {
    if (isNaN(v)) return 'NaN';
    if (useDecibels) {
      const db = 10 * Math.log10(Math.max(v, 1e-30));
      return `${db.toFixed(2)} dB`;
    }
    if (v < 0.001 || v > 10000) return v.toExponential(3);
    return v.toFixed(4);
  };

  const text = formatValue(value);
  const isMultiLine = typeof value === 'object' && value !== null;
  const lines = isMultiLine ? text.split('\n') : [text];

  const tipStyle = {
    position: 'absolute',
    left: screenX + 16,
    top: screenY + 16,
    background: 'var(--sardine-bg-raised, rgba(10, 22, 40, 0.95))',
    border: '1px solid var(--sardine-border, rgba(78, 201, 212, 0.25))',
    borderRadius: 'var(--radius-sm, 4px)',
    padding: '6px 10px',
    color: 'var(--text-primary, #e8edf5)',
    fontSize: '0.72rem',
    fontFamily: 'var(--font-mono, monospace)',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    zIndex: 20,
    maxWidth: '300px',
    lineHeight: 1.5,
  };

  return (
    <div style={tipStyle}>
      <div style={{ color: 'var(--text-muted, #8899aa)', marginBottom: 2 }}>
        px ({col}, {row}){windowSize > 1 ? ` [${windowSize}\u00D7${windowSize}]` : ''}
      </div>
      {geoLabel && (
        <div style={{ color: 'var(--text-muted, #8899aa)', marginBottom: 2 }}>
          {geoLabel}
        </div>
      )}
      {lines.map((line, i) => (
        <div key={i} style={{ color: 'var(--sardine-cyan, #4ec9d4)' }}>{line}</div>
      ))}
    </div>
  );
}

export default PixelExplorer;
