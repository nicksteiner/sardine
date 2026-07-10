import React, { useRef, useEffect, useState, useCallback } from 'react';
import { worldToPixel, pixelToWorld } from '../utils/geo-overlays.js';
import {
  drawArrow,
  drawTextLabel,
  measureTextLabel,
  resolveColor,
  resolveSize,
  ANNOTATION_COLOR_KEYS,
  ANNOTATION_SIZE_KEYS,
  DEFAULT_ANNOTATION_SIZE,
} from '../utils/annotation-render.js';

/**
 * AnnotationOverlay — interactive arrow + text annotation layer.
 *
 * Modes (driven by `mode` prop):
 *   'off'   — pass-through, only renders existing annotations
 *   'arrow' — click to set tail, second click to set head; opens caption input
 *   'text'  — click to place a text label; opens inline input
 *
 * Selection: click an existing annotation to select; drag to reposition;
 * Delete/Backspace removes; double-click text to re-edit.
 *
 * All coordinates persist in world units (bounds-relative), so annotations
 * survive pan/zoom and serialize cleanly.
 */
export function AnnotationOverlay({
  viewState,
  bounds,
  mode = 'off',
  color = 'cyan',
  size = DEFAULT_ANNOTATION_SIZE,
  annotations = [],
  onAnnotationsChange,
  selectedId = null,
  onSelectAnnotation,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [draftArrow, setDraftArrow] = useState(null);   // {x1,y1,cx,cy} screen during drawing
  const [editingId, setEditingId] = useState(null);
  const [editorPos, setEditorPos] = useState(null);     // {sx, sy} for input box
  const [editorValue, setEditorValue] = useState('');
  const [drag, setDrag] = useState(null);               // {id, kind, dx, dy}

  const propsRef = useRef({ viewState, bounds, mode, color, size, annotations, onAnnotationsChange, onSelectAnnotation });
  propsRef.current = { viewState, bounds, mode, color, size, annotations, onAnnotationsChange, onSelectAnnotation };

  // ─── Sizing & redraw ──────────────────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { viewState: vs, annotations: anns } = propsRef.current;
    if (!vs) return;

    for (const a of anns) {
      const isSel = a.id === selectedId;
      if (a.type === 'arrow') {
        const [x1, y1] = worldToPixel(a.worldX,  a.worldY,  vs, W, H);
        const [x2, y2] = worldToPixel(a.worldX2, a.worldY2, vs, W, H);
        drawArrow(ctx, x1, y1, x2, y2, {
          colorKey: a.color, caption: a.text || '', dpr: 1,
          size: a.size || DEFAULT_ANNOTATION_SIZE, fontSize: a.fontSize, selected: isSel,
        });
      } else if (a.type === 'text') {
        const [x, y] = worldToPixel(a.worldX, a.worldY, vs, W, H);
        drawTextLabel(ctx, x, y, a.text || '(label)', {
          colorKey: a.color, dpr: 1,
          size: a.size || DEFAULT_ANNOTATION_SIZE, fontSize: a.fontSize, selected: isSel,
        });
      }
    }

    // Draft arrow during drawing
    if (draftArrow) {
      drawArrow(ctx, draftArrow.x1, draftArrow.y1, draftArrow.cx, draftArrow.cy, {
        colorKey: propsRef.current.color, caption: '', dpr: 1,
        size: propsRef.current.size || DEFAULT_ANNOTATION_SIZE,
      });
    }
  }, [selectedId, draftArrow]);

  useEffect(() => { redraw(); }, [redraw, viewState, annotations, mode, color, size]);

  // Resize observer so canvas resolution tracks container
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [redraw]);

  // ─── Coordinate helpers ───────────────────────────────────────────────────
  const screenFromEvent = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top, W: rect.width, H: rect.height };
  }, []);

  const screenToWorld = useCallback((sx, sy) => {
    const canvas = canvasRef.current;
    const { viewState: vs } = propsRef.current;
    if (!canvas || !vs) return null;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    return pixelToWorld(sx, sy, vs, W, H);
  }, []);

  // ─── Hit testing ──────────────────────────────────────────────────────────
  const hitTest = useCallback((sx, sy) => {
    const canvas = canvasRef.current;
    const { viewState: vs, annotations: anns } = propsRef.current;
    if (!canvas || !vs) return null;
    const ctx = canvas.getContext('2d');
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;

    // Test in reverse so topmost wins
    for (let i = anns.length - 1; i >= 0; i--) {
      const a = anns[i];
      if (a.type === 'text') {
        const [x, y] = worldToPixel(a.worldX, a.worldY, vs, W, H);
        const fs = a.fontSize || resolveSize(a.size || DEFAULT_ANNOTATION_SIZE).fontSize;
        const { w, h } = measureTextLabel(ctx, a.text || '(label)', fs, 1);
        if (sx >= x && sx <= x + w && sy >= y && sy <= y + h) {
          return { id: a.id, kind: 'text-body' };
        }
      } else if (a.type === 'arrow') {
        const [x1, y1] = worldToPixel(a.worldX,  a.worldY,  vs, W, H);
        const [x2, y2] = worldToPixel(a.worldX2, a.worldY2, vs, W, H);
        // Distance from point to line segment
        const dist = pointToSegment(sx, sy, x1, y1, x2, y2);
        if (dist.d < 8) {
          // Tail vs head vs shaft
          if (Math.hypot(sx - x1, sy - y1) < 12) return { id: a.id, kind: 'arrow-tail' };
          if (Math.hypot(sx - x2, sy - y2) < 12) return { id: a.id, kind: 'arrow-head' };
          return { id: a.id, kind: 'arrow-shaft' };
        }
      }
    }
    return null;
  }, []);

  // ─── Mouse events ─────────────────────────────────────────────────────────
  const startEditing = useCallback((id, sx, sy, initial = '') => {
    setEditingId(id);
    setEditorPos({ sx, sy });
    setEditorValue(initial);
  }, []);

  // Is the event over our canvas area? Used to filter document-level mouse listeners.
  const isOverCanvas = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right
        && e.clientY >= rect.top  && e.clientY <= rect.bottom;
  }, []);

  // Should we intercept this mousedown? Only when in a drawing mode, OR when
  // the click hits an existing annotation (selection / drag).
  const handleMouseDown = useCallback((e) => {
    if (!isOverCanvas(e)) return;
    const sc = screenFromEvent(e);
    if (!sc) return;
    const { mode: m, color: c, size: sz, annotations: anns, onAnnotationsChange: cb, onSelectAnnotation: sel } = propsRef.current;

    // First, see if user clicked an existing annotation
    const hit = hitTest(sc.sx, sc.sy);

    if (m === 'off' || (m !== 'off' && hit)) {
      // Selection / drag mode
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        sel?.(hit.id);
        const a = anns.find(x => x.id === hit.id);
        if (!a) return;

        if (hit.kind === 'arrow-tail' || hit.kind === 'arrow-head') {
          setDrag({ id: hit.id, kind: hit.kind, anchorSx: sc.sx, anchorSy: sc.sy });
        } else if (hit.kind === 'arrow-shaft' || hit.kind === 'text-body') {
          // Drag whole annotation; remember offset from anchor
          const [ax, ay] = worldToPixel(a.worldX, a.worldY, propsRef.current.viewState, sc.W, sc.H);
          setDrag({
            id: hit.id, kind: 'move',
            dx: sc.sx - ax, dy: sc.sy - ay,
          });
        }
        return;
      } else {
        // Click on empty space in 'off' mode → deselect
        if (m === 'off') sel?.(null);
        return;
      }
    }

    // Drawing modes
    if (m === 'arrow') {
      e.preventDefault();
      e.stopPropagation();
      if (!draftArrow) {
        setDraftArrow({ x1: sc.sx, y1: sc.sy, cx: sc.sx, cy: sc.sy });
      } else {
        // Second click → commit arrow
        const w1 = screenToWorld(draftArrow.x1, draftArrow.y1);
        const w2 = screenToWorld(sc.sx, sc.sy);
        setDraftArrow(null);
        if (w1 && w2) {
          const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const next = [...anns, {
            id, type: 'arrow', color: c, size: sz,
            worldX: w1[0], worldY: w1[1],
            worldX2: w2[0], worldY2: w2[1],
            text: '',
          }];
          cb?.(next);
          sel?.(id);
          // Open caption editor near tail
          startEditing(id, draftArrow.x1, draftArrow.y1, '');
        }
      }
    } else if (m === 'text') {
      e.preventDefault();
      e.stopPropagation();
      const w = screenToWorld(sc.sx, sc.sy);
      if (!w) return;
      const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const next = [...anns, {
        id, type: 'text', color: c, size: sz,
        worldX: w[0], worldY: w[1],
        text: '',
      }];
      cb?.(next);
      sel?.(id);
      startEditing(id, sc.sx, sc.sy, '');
    }
  }, [hitTest, screenFromEvent, screenToWorld, draftArrow, startEditing]);

  const handleMouseMove = useCallback((e) => {
    if (!draftArrow && !drag) return;
    if (!isOverCanvas(e) && !drag) return; // arrow draft tracks only over canvas
    const sc = screenFromEvent(e);
    if (!sc) return;
    const { annotations: anns, onAnnotationsChange: cb, viewState: vs } = propsRef.current;

    if (draftArrow) {
      setDraftArrow({ ...draftArrow, cx: sc.sx, cy: sc.sy });
      return;
    }

    if (drag) {
      const a = anns.find(x => x.id === drag.id);
      if (!a) return;

      if (drag.kind === 'move') {
        const w = screenToWorld(sc.sx - drag.dx, sc.sy - drag.dy);
        if (!w) return;
        const next = anns.map(x => {
          if (x.id !== drag.id) return x;
          if (x.type === 'arrow') {
            const ddx = w[0] - x.worldX;
            const ddy = w[1] - x.worldY;
            return { ...x, worldX: w[0], worldY: w[1], worldX2: x.worldX2 + ddx, worldY2: x.worldY2 + ddy };
          }
          return { ...x, worldX: w[0], worldY: w[1] };
        });
        cb?.(next);
      } else if (drag.kind === 'arrow-tail' || drag.kind === 'arrow-head') {
        const w = screenToWorld(sc.sx, sc.sy);
        if (!w) return;
        const next = anns.map(x => {
          if (x.id !== drag.id) return x;
          if (drag.kind === 'arrow-tail') return { ...x, worldX: w[0], worldY: w[1] };
          return { ...x, worldX2: w[0], worldY2: w[1] };
        });
        cb?.(next);
      }
    }
  }, [draftArrow, drag, screenFromEvent, screenToWorld]);

  const handleMouseUp = useCallback(() => {
    if (drag) setDrag(null);
  }, [drag]);

  const handleDoubleClick = useCallback((e) => {
    if (!isOverCanvas(e)) return;
    const sc = screenFromEvent(e);
    if (!sc) return;
    const hit = hitTest(sc.sx, sc.sy);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const a = propsRef.current.annotations.find(x => x.id === hit.id);
    if (!a) return;
    let editAt;
    if (a.type === 'text') {
      const [x, y] = worldToPixel(a.worldX, a.worldY, propsRef.current.viewState, sc.W, sc.H);
      editAt = { sx: x, sy: y };
    } else {
      const [x, y] = worldToPixel(a.worldX, a.worldY, propsRef.current.viewState, sc.W, sc.H);
      editAt = { sx: x, sy: y };
    }
    startEditing(a.id, editAt.sx, editAt.sy, a.text || '');
  }, [hitTest, screenFromEvent, startEditing]);

  // Delete key removes selected annotation
  useEffect(() => {
    const onKey = (e) => {
      if (editingId) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { annotations: anns, onAnnotationsChange: cb, onSelectAnnotation: sel } = propsRef.current;
        cb?.(anns.filter(a => a.id !== selectedId));
        sel?.(null);
      } else if (e.key === 'Escape') {
        propsRef.current.onSelectAnnotation?.(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingId, selectedId]);

  // Cancel draft on Escape during arrow drawing
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && draftArrow) {
        setDraftArrow(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftArrow]);

  // Document-level mouse routing — keeps the canvas pointerEvents:'none' so
  // wheel/zoom always falls through to deck.gl.
  useEffect(() => {
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup',   handleMouseUp,   true);
    document.addEventListener('dblclick',  handleDoubleClick, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup',   handleMouseUp,   true);
      document.removeEventListener('dblclick',  handleDoubleClick, true);
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp, handleDoubleClick]);

  // ─── Editor commit/cancel ─────────────────────────────────────────────────
  const commitEditor = useCallback(() => {
    if (!editingId) return;
    const { annotations: anns, onAnnotationsChange: cb } = propsRef.current;
    const text = editorValue.trim();
    let next;
    if (!text) {
      // Empty caption on text label → remove it; on arrow → keep arrow without caption
      next = anns.flatMap(a => {
        if (a.id !== editingId) return [a];
        if (a.type === 'text') return [];
        return [{ ...a, text: '' }];
      });
    } else {
      next = anns.map(a => a.id === editingId ? { ...a, text } : a);
    }
    cb?.(next);
    setEditingId(null);
    setEditorPos(null);
    setEditorValue('');
  }, [editingId, editorValue]);

  const cancelEditor = useCallback(() => {
    if (!editingId) return;
    // If we just created an empty annotation, remove it on cancel
    const { annotations: anns, onAnnotationsChange: cb, onSelectAnnotation: sel } = propsRef.current;
    const a = anns.find(x => x.id === editingId);
    if (a && (a.text || '').trim() === '' && (editorValue || '').trim() === '') {
      if (a.type === 'text') {
        cb?.(anns.filter(x => x.id !== editingId));
        sel?.(null);
      }
    }
    setEditingId(null);
    setEditorPos(null);
    setEditorValue('');
  }, [editingId, editorValue]);

  // ─── Render ───────────────────────────────────────────────────────────────
  // Container is pointer-events:none so wheel/zoom always reaches deck.gl;
  // mousedown/move/up are routed via document listeners and only intercepted
  // when over the canvas AND in a drawing mode or hitting an annotation.
  const showCrosshair = mode === 'arrow' || mode === 'text' || drag;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
        cursor: showCrosshair ? (drag ? 'grabbing' : 'crosshair') : 'default',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: '100%',
          pointerEvents: 'none',
        }}
      />

      {editingId && editorPos && (
        <input
          autoFocus
          type="text"
          value={editorValue}
          onChange={(e) => setEditorValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEditor(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelEditor(); }
          }}
          onBlur={commitEditor}
          placeholder="caption…"
          style={{
            position: 'absolute',
            left: Math.max(4, editorPos.sx),
            top: Math.max(4, editorPos.sy - 28),
            minWidth: 140,
            padding: '4px 8px',
            fontSize: '0.75rem',
            fontFamily: 'var(--sardine-font-mono, monospace)',
            background: 'var(--sardine-bg-panel, #122240)',
            color: resolveColor(annotations.find(a => a.id === editingId)?.color || 'cyan'),
            border: `1px solid ${resolveColor(annotations.find(a => a.id === editingId)?.color || 'cyan')}`,
            borderRadius: 3,
            outline: 'none',
            zIndex: 20,
            pointerEvents: 'auto',
          }}
        />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function pointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return { d: Math.hypot(px - x1, py - y1), t: 0 };
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}

export { ANNOTATION_COLOR_KEYS, ANNOTATION_SIZE_KEYS };
