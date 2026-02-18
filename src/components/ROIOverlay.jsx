import React, { useRef, useEffect, useState, useCallback } from 'react';
import { worldToPixel, pixelToWorld } from '../utils/geo-overlays.js';

/**
 * ROIOverlay — Shift+drag rectangle selection overlay.
 *
 * Positioned absolutely over the deck.gl canvas. During normal interaction
 * (no Shift key) pointer events pass through to deck.gl for pan/zoom.
 * When Shift is held, the overlay captures mouse events to draw a selection
 * rectangle, converting screen coordinates → world → image pixel coordinates.
 *
 * The ROI is stored in image pixel coordinates { left, top, width, height }
 * and rendered back to screen space on every frame via worldToPixel.
 */
export function ROIOverlay({ viewState, bounds, imageWidth, imageHeight, roi, onROIChange }) {
  const canvasRef = useRef(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {sx, sy} screen coords
  const [dragCurrent, setDragCurrent] = useState(null); // {sx, sy} screen coords

  // Track Shift key globally
  useEffect(() => {
    const down = (e) => { if (e.key === 'Shift') setShiftHeld(true); };
    const up = (e) => { if (e.key === 'Shift') setShiftHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Convert screen coords to image pixel coords
  const screenToImagePixels = useCallback((sx, sy) => {
    const canvas = canvasRef.current;
    if (!canvas || !viewState || !bounds || !imageWidth || !imageHeight) return null;
    const rect = canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const [wx, wy] = pixelToWorld(cx, cy, viewState, w, h);

    // World → image pixel
    const [minX, minY, maxX, maxY] = bounds;
    const px = Math.round((wx - minX) / (maxX - minX) * imageWidth);
    const py = Math.round((wy - minY) / (maxY - minY) * imageHeight);
    return [
      Math.max(0, Math.min(imageWidth, px)),
      Math.max(0, Math.min(imageHeight, py)),
    ];
  }, [viewState, bounds, imageWidth, imageHeight]);

  // Mouse handlers
  const handleMouseDown = useCallback((e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    setDragStart({ sx: e.clientX, sy: e.clientY });
    setDragCurrent({ sx: e.clientX, sy: e.clientY });
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!dragStart) return;
    e.preventDefault();
    e.stopPropagation();
    setDragCurrent({ sx: e.clientX, sy: e.clientY });
  }, [dragStart]);

  const handleMouseUp = useCallback((e) => {
    if (!dragStart) return;
    e.preventDefault();
    e.stopPropagation();

    const p0 = screenToImagePixels(dragStart.sx, dragStart.sy);
    const p1 = screenToImagePixels(e.clientX, e.clientY);
    setDragStart(null);
    setDragCurrent(null);

    if (!p0 || !p1) return;

    const left = Math.min(p0[0], p1[0]);
    const top = Math.min(p0[1], p1[1]);
    const right = Math.max(p0[0], p1[0]);
    const bottom = Math.max(p0[1], p1[1]);
    const w = right - left;
    const h = bottom - top;

    // Minimum 16px to avoid accidental clicks
    if (w < 16 || h < 16) {
      onROIChange?.(null); // Shift+click clears
      return;
    }

    onROIChange?.({ left, top, width: w, height: h });
  }, [dragStart, screenToImagePixels, onROIChange]);

  // Draw ROI rectangle and active drag rectangle
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

    const [minX, minY, maxX, maxY] = bounds;

    // Helper: image pixel → screen pixel
    const imgToScreen = (px, py) => {
      const wx = minX + (px / imageWidth) * (maxX - minX);
      const wy = minY + (py / imageHeight) * (maxY - minY);
      return worldToPixel(wx, wy, viewState, w, h);
    };

    // Draw active drag rectangle (while dragging)
    if (dragStart && dragCurrent) {
      const rect = canvas.getBoundingClientRect();
      const x0 = dragStart.sx - rect.left;
      const y0 = dragStart.sy - rect.top;
      const x1 = dragCurrent.sx - rect.left;
      const y1 = dragCurrent.sy - rect.top;
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);

      ctx.fillStyle = 'rgba(255, 200, 50, 0.12)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#ffc832';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      return;
    }

    // Draw finalized ROI rectangle
    if (roi && imageWidth && imageHeight) {
      const [sx0, sy0] = imgToScreen(roi.left, roi.top);
      const [sx1, sy1] = imgToScreen(roi.left + roi.width, roi.top + roi.height);
      const rx = Math.min(sx0, sx1);
      const ry = Math.min(sy0, sy1);
      const rw = Math.abs(sx1 - sx0);
      const rh = Math.abs(sy1 - sy0);

      // Fill
      ctx.fillStyle = 'rgba(255, 200, 50, 0.08)';
      ctx.fillRect(rx, ry, rw, rh);

      // Border
      ctx.strokeStyle = '#ffc832';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      // Label
      const label = `${roi.width} × ${roi.height} px`;
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const textW = ctx.measureText(label).width + 8;
      const labelX = rx + 4;
      const labelY = ry - 4;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
      ctx.fillRect(labelX - 2, labelY - 13, textW, 15);
      ctx.fillStyle = '#ffc832';
      ctx.fillText(label, labelX, labelY);
    }
  }, [viewState, bounds, imageWidth, imageHeight, roi, dragStart, dragCurrent]);

  if (!viewState || !bounds) return null;

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: shiftHeld || dragStart ? 'auto' : 'none',
        cursor: shiftHeld ? 'crosshair' : 'default',
        zIndex: 2,
      }}
    />
  );
}

export default ROIOverlay;
