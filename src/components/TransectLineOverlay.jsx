import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { worldToPixel, pixelToWorld } from '../utils/geo-overlays.js';

/**
 * TransectLineOverlay — a single free profile line over the viewer.
 *
 * The line is movable (drag body → translate), reshapeable (drag either
 * endpoint), and rotatable about its crossing point / midpoint (drag the
 * center pivot handle). Its value plot renders in the sidebar drawer.
 *
 * The line is stored in image-pixel coordinates as { x0, y0, x1, y1 } and
 * re-projected to screen space every frame via worldToPixel — so it stays
 * pinned to the ground as the user pans/zooms.
 *
 * Interaction is armed by `enabled` (a transect mode toggle) so it never
 * competes with deck.gl panning when the tool is off.
 *
 * Props:
 *   enabled      — arm pointer interaction + rendering
 *   viewState    — deck.gl {target, zoom}
 *   bounds       — [minX, minY, maxX, maxY] world bounds
 *   imageWidth   — source width (px)
 *   imageHeight  — source height (px)
 *   line         — { x0, y0, x1, y1 } image px, or null
 *   onLineChange — (line|null) => void
 */
const HANDLE_R = 6;      // endpoint grab radius (screen px)
const PIVOT_R = 7;       // center pivot grab radius

export function TransectLineOverlay({
  enabled,
  viewState,
  bounds,
  imageWidth,
  imageHeight,
  line,
  onLineChange,
}) {
  const canvasRef = useRef(null);
  const [drag, setDrag] = useState(null); // {mode, ...} while dragging

  const propsRef = useRef({ viewState, bounds, imageWidth, imageHeight, line, onLineChange, enabled });
  propsRef.current = { viewState, bounds, imageWidth, imageHeight, line, onLineChange, enabled };
  const dragRef = useRef(null);

  // ── coord helpers (screen ↔ image px) ─────────────────────────────
  const dims = useCallback(() => {
    const c = canvasRef.current;
    return c ? { rect: c.getBoundingClientRect(), w: c.clientWidth, h: c.clientHeight } : null;
  }, []);

  const imgToScreen = useCallback((px, py) => {
    const { viewState: vs, bounds: b, imageWidth: iw, imageHeight: ih } = propsRef.current;
    const d = dims();
    if (!vs || !b || !iw || !ih || !d) return null;
    const [minX, minY, maxX, maxY] = b;
    const wx = minX + (px / iw) * (maxX - minX);
    const wy = maxY - (py / ih) * (maxY - minY);
    return worldToPixel(wx, wy, vs, d.w, d.h);
  }, [dims]);

  // client (page) coords → image px
  const clientToImage = useCallback((clientX, clientY) => {
    const { viewState: vs, bounds: b, imageWidth: iw, imageHeight: ih } = propsRef.current;
    const d = dims();
    if (!vs || !b || !iw || !ih || !d) return null;
    const cx = clientX - d.rect.left;
    const cy = clientY - d.rect.top;
    const [wx, wy] = pixelToWorld(cx, cy, vs, d.w, d.h);
    const [minX, minY, maxX, maxY] = b;
    const px = (wx - minX) / (maxX - minX) * iw;
    const py = (maxY - wy) / (maxY - minY) * ih;
    return [
      Math.max(0, Math.min(iw - 1, px)),
      Math.max(0, Math.min(ih - 1, py)),
    ];
  }, [dims]);

  // Which handle (if any) is under the client point? Returns 'p0'|'p1'|'pivot'|'body'|null
  const hitTest = useCallback((clientX, clientY) => {
    const { line: ln } = propsRef.current;
    const d = dims();
    if (!ln || !d) return null;
    const sx = clientX - d.rect.left;
    const sy = clientY - d.rect.top;
    const s0 = imgToScreen(ln.x0, ln.y0);
    const s1 = imgToScreen(ln.x1, ln.y1);
    if (!s0 || !s1) return null;
    const mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];
    const near = (p, r) => (sx - p[0]) ** 2 + (sy - p[1]) ** 2 <= r * r;
    if (near(mid, PIVOT_R)) return 'pivot';
    if (near(s0, HANDLE_R)) return 'p0';
    if (near(s1, HANDLE_R)) return 'p1';
    // body: distance point→segment
    const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
    const len2 = dx * dx + dy * dy || 1;
    let t = ((sx - s0[0]) * dx + (sy - s0[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const distx = sx - (s0[0] + t * dx), disty = sy - (s0[1] + t * dy);
    if (distx * distx + disty * disty <= 36) return 'body'; // within 6 px of segment
    return null;
  }, [dims, imgToScreen]);

  // ── pointer handlers ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    const onDown = (e) => {
      const { line: ln } = propsRef.current;
      const d = dims();
      if (!d) return;
      const over = e.clientX >= d.rect.left && e.clientX <= d.rect.right &&
                   e.clientY >= d.rect.top && e.clientY <= d.rect.bottom;
      if (!over) return;

      const hit = ln ? hitTest(e.clientX, e.clientY) : null;

      if (!ln) {
        // No line yet → start drawing a fresh one from this point
        const p = clientToImage(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault(); e.stopPropagation();
        dragRef.current = { mode: 'draw', anchor: p };
        setDrag({ mode: 'draw' });
        return;
      }

      if (!hit) return; // let deck.gl pan when not grabbing a handle
      e.preventDefault(); e.stopPropagation();

      if (hit === 'body') {
        const p = clientToImage(e.clientX, e.clientY);
        dragRef.current = { mode: 'move', grab: p, orig: { ...ln } };
      } else if (hit === 'pivot') {
        dragRef.current = { mode: 'rotate', orig: { ...ln } };
      } else {
        dragRef.current = { mode: hit === 'p0' ? 'end0' : 'end1' };
      }
      setDrag({ mode: dragRef.current.mode });
    };

    const onMove = (e) => {
      const st = dragRef.current;
      if (!st) return;
      e.preventDefault();
      const { onLineChange: cb, line: ln } = propsRef.current;
      const p = clientToImage(e.clientX, e.clientY);
      if (!p) return;

      if (st.mode === 'draw') {
        cb?.({ x0: st.anchor[0], y0: st.anchor[1], x1: p[0], y1: p[1] });
      } else if (st.mode === 'end0') {
        cb?.({ ...ln, x0: p[0], y0: p[1] });
      } else if (st.mode === 'end1') {
        cb?.({ ...ln, x1: p[0], y1: p[1] });
      } else if (st.mode === 'move') {
        const dx = p[0] - st.grab[0], dy = p[1] - st.grab[1];
        cb?.({
          x0: st.orig.x0 + dx, y0: st.orig.y0 + dy,
          x1: st.orig.x1 + dx, y1: st.orig.y1 + dy,
        });
      } else if (st.mode === 'rotate') {
        const o = st.orig;
        const mx = (o.x0 + o.x1) / 2, my = (o.y0 + o.y1) / 2;
        const half = Math.hypot(o.x1 - o.x0, o.y1 - o.y0) / 2 || 1;
        const ang = Math.atan2(p[1] - my, p[0] - mx);
        const dx = Math.cos(ang) * half, dy = Math.sin(ang) * half;
        cb?.({ x0: mx - dx, y0: my - dy, x1: mx + dx, y1: my + dy });
      }
    };

    const onUp = (e) => {
      const st = dragRef.current;
      if (!st) return;
      e.preventDefault();
      dragRef.current = null;
      setDrag(null);
      // Discard a zero-length draw (a click)
      const { line: ln, onLineChange: cb } = propsRef.current;
      if (st.mode === 'draw' && ln && Math.hypot(ln.x1 - ln.x0, ln.y1 - ln.y0) < 3) {
        cb?.(null);
      }
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [enabled, dims, hitTest, clientToImage]);

  // ── cursor feedback ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!container) return;
    if (!enabled) { container.style.cursor = ''; return; }
    const move = (e) => {
      if (dragRef.current) return;
      const hit = propsRef.current.line ? hitTest(e.clientX, e.clientY) : null;
      container.style.cursor =
        hit === 'pivot' ? 'grab' :
        (hit === 'p0' || hit === 'p1') ? 'pointer' :
        hit === 'body' ? 'move' : 'crosshair';
    };
    document.addEventListener('pointermove', move);
    container.style.cursor = 'crosshair';
    return () => {
      document.removeEventListener('pointermove', move);
      if (container) container.style.cursor = '';
    };
  }, [enabled, hitTest]);

  // ── draw ──────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewState || !bounds) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!enabled || !line || !imageWidth || !imageHeight) return;

    const s0 = imgToScreen(line.x0, line.y0);
    const s1 = imgToScreen(line.x1, line.y1);
    if (!s0 || !s1) return;
    const mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2];

    // Line
    ctx.strokeStyle = '#4ec9d4';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();

    // Endpoint handles
    for (const p of [s0, s1]) {
      ctx.beginPath(); ctx.arc(p[0], p[1], HANDLE_R - 1, 0, Math.PI * 2);
      ctx.fillStyle = '#0a1628'; ctx.fill();
      ctx.strokeStyle = '#4ec9d4'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Center rotation pivot (ring + tick)
    ctx.beginPath(); ctx.arc(mid[0], mid[1], PIVOT_R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,200,50,0.18)'; ctx.fill();
    ctx.strokeStyle = '#ffc832'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(mid[0], mid[1], 1.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffc832'; ctx.fill();

    // Length + angle label near p1
    const lenPx = Math.round(Math.hypot(line.x1 - line.x0, line.y1 - line.y0));
    let deg = Math.atan2(-(line.y1 - line.y0), line.x1 - line.x0) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    const label = `${lenPx} px  ${deg.toFixed(0)}°`;
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(s1[0] + 8, s1[1] - 16, tw, 15);
    ctx.fillStyle = '#4ec9d4';
    ctx.fillText(label, s1[0] + 12, s1[1] - 3);
  }, [enabled, viewState, bounds, imageWidth, imageHeight, line, drag, imgToScreen]);

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
        zIndex: 3,
      }}
    />
  );
}

export default TransectLineOverlay;
