import React, { useRef, useEffect } from 'react';
import {
  computeVisibleExtent,
  niceInterval,
  formatTickValue,
  isProjectedBounds,
} from '../utils/geo-overlays.js';

/**
 * CoordinateGrid — Canvas overlay that draws gridlines with tick labels.
 *
 * Gridlines: dashed [4,4], --sardine-border at ~35% alpha
 * Tick labels: --text-muted at ~70% alpha, JetBrains Mono 10px
 *
 * Positioning uses the deck.gl OrthographicView affine:
 *   pixel = (world − center) × 2^zoom + canvasSize/2
 */
export function CoordinateGrid({ viewState, bounds, width, height }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewState || !bounds) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const projected = isProjectedBounds(bounds);
    const extent = computeVisibleExtent(viewState, w, h);
    const ppu = extent.pixelsPerUnit;

    // Pick nice intervals for each axis (~5 lines)
    const dx = niceInterval(extent.width, 5);
    const dy = niceInterval(extent.height, 5);

    const [cx, cy] = viewState.target || [0, 0];

    // World → pixel transform
    const toX = (wx) => (wx - cx) * ppu + w / 2;
    const toY = (wy) => (wy - cy) * ppu + h / 2;

    // Grid line style
    ctx.strokeStyle = 'rgba(30, 58, 95, 0.35)'; // --sardine-border at 35%
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Tick label style
    const tickFont = "10px 'JetBrains Mono', monospace";
    const tickColor = 'rgba(90, 112, 153, 0.70)'; // --text-muted at 70%
    const tickPad = 4;

    // ── Vertical gridlines (constant-X) ──
    const xStart = Math.ceil(extent.minX / dx) * dx;
    for (let wx = xStart; wx <= extent.maxX; wx += dx) {
      const px = toX(wx);
      if (px < 0 || px > w) continue;

      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();

      // Tick label at bottom
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = tickFont;
      ctx.fillStyle = tickColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatTickValue(wx, projected), px, h - tickPad);
      ctx.restore();
    }

    // ── Horizontal gridlines (constant-Y) ──
    const yStart = Math.ceil(extent.minY / dy) * dy;
    for (let wy = yStart; wy <= extent.maxY; wy += dy) {
      const py = toY(wy);
      if (py < 0 || py > h) continue;

      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();

      // Tick label at left
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = tickFont;
      ctx.fillStyle = tickColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatTickValue(wy, projected), tickPad, py);
      ctx.restore();
    }
  }, [viewState, bounds, width, height]);

  if (!viewState || !bounds) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  );
}

export default CoordinateGrid;
