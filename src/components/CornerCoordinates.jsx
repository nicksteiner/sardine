import React, { useMemo } from 'react';
import {
  computeVisibleExtent,
  formatCoord,
  isProjectedBounds,
} from '../utils/geo-overlays.js';

/**
 * CornerCoordinates — Four translucent pills at the viewport corners
 * showing the world coordinate at each corner.
 *
 * Style: --sardine-bg-raised + --sardine-border + radius-md, 80% alpha
 * Text:  --sardine-cyan, JetBrains Mono 0.6rem
 */
export function CornerCoordinates({ viewState, bounds }) {
  const corners = useMemo(() => {
    if (!viewState || !bounds) return null;

    // We need the container's pixel dimensions. Since this component fills
    // the container, we derive extent from approximate viewport.
    // The parent passes width/height as CSS — we don't know exact pixels,
    // but we can compute world corners from the visible extent using a
    // reference size. Instead, just compute from viewState + container ref.
    // For simplicity, we compute from the viewState + bounds.
    return null; // placeholder — real impl below
  }, [viewState, bounds]);

  if (!viewState || !bounds) return null;

  const projected = isProjectedBounds(bounds);

  // We'll use a ResizeObserver-free approach: put invisible absolutely-
  // positioned elements at each corner and compute coords from viewState
  // once we know the container size. But since we don't have container
  // size directly, we'll use a wrapper div that measures itself.

  return <CornerCoordinatesInner viewState={viewState} bounds={bounds} projected={projected} />;
}

function CornerCoordinatesInner({ viewState, bounds, projected }) {
  const ref = React.useRef(null);
  const [size, setSize] = React.useState(null);

  React.useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const corners = useMemo(() => {
    if (!size || !viewState) return null;
    const extent = computeVisibleExtent(viewState, size.width, size.height);
    return {
      tl: { x: extent.minX, y: extent.maxY }, // top-left pixel = min-x, max-y (Y is flipped in screen)
      tr: { x: extent.maxX, y: extent.maxY },
      bl: { x: extent.minX, y: extent.minY },
      br: { x: extent.maxX, y: extent.minY },
    };
  }, [viewState, size]);

  const pillStyle = {
    position: 'absolute',
    backgroundColor: 'rgba(15, 31, 56, 0.80)',  // --sardine-bg-raised at 80%
    border: '1px solid rgba(30, 58, 95, 0.80)',  // --sardine-border at 80%
    borderRadius: '8px',                          // --radius-md
    padding: '3px 7px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '0.6rem',
    color: '#4ec9d4',                             // --sardine-cyan
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    lineHeight: 1.3,
  };

  const formatCorner = (c) => {
    const xStr = formatCoord(c.x, projected, 'x');
    const yStr = formatCoord(c.y, projected, 'y');
    return `${yStr}\n${xStr}`;
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {corners && (
        <>
          {/* Top-left */}
          <div style={{ ...pillStyle, top: 8, left: 8 }}>
            {formatCorner(corners.tl).split('\n').map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {/* Top-right */}
          <div style={{ ...pillStyle, top: 8, right: 8 }}>
            {formatCorner(corners.tr).split('\n').map((line, i) => (
              <div key={i} style={{ textAlign: 'right' }}>{line}</div>
            ))}
          </div>
          {/* Bottom-left */}
          <div style={{ ...pillStyle, bottom: 8, left: 8 }}>
            {formatCorner(corners.bl).split('\n').map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {/* Bottom-right */}
          <div style={{ ...pillStyle, bottom: 8, right: 8 }}>
            {formatCorner(corners.br).split('\n').map((line, i) => (
              <div key={i} style={{ textAlign: 'right' }}>{line}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default CornerCoordinates;
