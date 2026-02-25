import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { worldToPixel, pixelToWorld } from '../utils/geo-overlays.js';

/**
 * ROIOverlay — Shift+drag rectangle selection overlay.
 *
 * Renders on a canvas positioned over the deck.gl viewer. Uses document-level
 * event listeners so that Shift+drag is captured reliably regardless of
 * z-index stacking or pointerEvents CSS timing.
 *
 * The ROI is stored in image pixel coordinates { left, top, width, height }
 * and rendered back to screen space on every frame via worldToPixel.
 */
export function ROIOverlay({ viewState, bounds, imageWidth, imageHeight, roi, onROIChange }) {
  const canvasRef = useRef(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [dragStart, setDragStart] = useState(null); // {sx, sy} screen coords
  const [dragCurrent, setDragCurrent] = useState(null); // {sx, sy} screen coords

  // Refs for latest props (used inside document-level listeners)
  const propsRef = useRef({ viewState, bounds, imageWidth, imageHeight, onROIChange });
  propsRef.current = { viewState, bounds, imageWidth, imageHeight, onROIChange };

  const dragRef = useRef(null); // {sx, sy} — mirrors dragStart for use in listeners

  // Convert screen coords to image pixel coords
  const screenToImagePixels = useCallback((sx, sy) => {
    const canvas = canvasRef.current;
    const { viewState: vs, bounds: b, imageWidth: iw, imageHeight: ih } = propsRef.current;
    if (!canvas || !vs || !b || !iw || !ih) return null;
    const rect = canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const [wx, wy] = pixelToWorld(cx, cy, vs, w, h);

    // World → image pixel
    // Y is flipped: world Y increases upward (deck.gl OrthographicView flipY:false)
    // but image row 0 is at the top (north). So row 0 → maxY, row H → minY.
    const [minX, minY, maxX, maxY] = b;
    const px = Math.round((wx - minX) / (maxX - minX) * iw);
    const py = Math.round((maxY - wy) / (maxY - minY) * ih);
    return [
      Math.max(0, Math.min(iw, px)),
      Math.max(0, Math.min(ih, py)),
    ];
  }, []);

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

  // Document-level mouse handlers for Shift+drag ROI selection
  useEffect(() => {
    const canvas = canvasRef.current;

    const isOverCanvas = (e) => {
      if (!canvas) return false;
      const rect = canvas.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right &&
             e.clientY >= rect.top && e.clientY <= rect.bottom;
    };

    const handleMouseDown = (e) => {
      if (!e.shiftKey || !isOverCanvas(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const start = { sx: e.clientX, sy: e.clientY };
      dragRef.current = start;
      setDragStart(start);
      setDragCurrent(start);
    };

    const handleMouseMove = (e) => {
      if (!dragRef.current) return;
      e.preventDefault();
      setDragCurrent({ sx: e.clientX, sy: e.clientY });
    };

    const handleMouseUp = (e) => {
      if (!dragRef.current) return;
      e.preventDefault();

      const start = dragRef.current;
      dragRef.current = null;
      setDragStart(null);
      setDragCurrent(null);

      const p0 = screenToImagePixels(start.sx, start.sy);
      const p1 = screenToImagePixels(e.clientX, e.clientY);

      if (!p0 || !p1) return;

      const left = Math.min(p0[0], p1[0]);
      const top = Math.min(p0[1], p1[1]);
      const right = Math.max(p0[0], p1[0]);
      const bottom = Math.max(p0[1], p1[1]);
      const w = right - left;
      const h = bottom - top;

      const { onROIChange: cb } = propsRef.current;

      // Minimum 16px to avoid accidental clicks
      if (w < 16 || h < 16) {
        cb?.(null); // Shift+click clears
        return;
      }

      cb?.({ left, top, width: w, height: h });
    };

    // Use capture phase to intercept before deck.gl
    document.addEventListener('pointerdown', handleMouseDown, true);
    document.addEventListener('pointermove', handleMouseMove, true);
    document.addEventListener('pointerup', handleMouseUp, true);
    return () => {
      document.removeEventListener('pointerdown', handleMouseDown, true);
      document.removeEventListener('pointermove', handleMouseMove, true);
      document.removeEventListener('pointerup', handleMouseUp, true);
    };
  }, [screenToImagePixels]);

  // Draw ROI rectangle and active drag rectangle
  // useLayoutEffect so canvas redraws synchronously before paint,
  // matching the SVG overlay (ROIProfilePlot) that updates during render.
  useLayoutEffect(() => {
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
    // Y is flipped: image row 0 → world maxY (top), row H → world minY (bottom)
    const imgToScreen = (px, py) => {
      const wx = minX + (px / imageWidth) * (maxX - minX);
      const wy = maxY - (py / imageHeight) * (maxY - minY);
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

  // Set crosshair cursor on the container when Shift is held
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!container) return;
    if (shiftHeld || dragRef.current) {
      container.style.cursor = 'crosshair';
    } else {
      container.style.cursor = '';
    }
    return () => { if (container) container.style.cursor = ''; };
  }, [shiftHeld]);

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
        zIndex: 2,
      }}
    />
  );
}

export default ROIOverlay;
