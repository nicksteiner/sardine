import { useEffect, useRef, useState } from 'react';

/**
 * ScrubNumber — Figma/Blender-style drag-to-change number input.
 *
 * Drag horizontally on the field to change value (cursor becomes ew-resize).
 * Click without drag to focus and type.
 * Modifier keys during drag:
 *   Shift  = 10× speed (coarse)
 *   Alt    = 0.1× speed (fine)
 *   Ctrl   = snap to integer step
 *
 * Step is auto-derived from value magnitude when not given.
 *
 * Props:
 *   value      number (current)
 *   onChange   (n) => void
 *   min, max   optional clamps
 *   step       per-pixel delta (default = 1% of (max-min) or 0.1 if no range)
 *   precision  decimal places for display (default = inferred)
 *   suffix     unit shown to the right (e.g., "dB")
 *   width      CSS width (default 70)
 *   label      optional left-side label
 */
export function ScrubNumber({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step,
  precision,
  suffix = '',
  width = 70,
  label,
  disabled = false,
}) {
  const elRef = useRef(null);
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draftStr, setDraftStr] = useState('');
  const dragRef = useRef(null);

  // Derive sensible step + precision from range/value
  const effStep = step ?? deriveStep(min, max, value);
  const effPrec = precision ?? derivePrecision(effStep);

  const formatDisplay = (v) => {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(effPrec);
  };

  // ── Drag handlers ──────────────────────────────────────────────────
  useEffect(() => {
    if (disabled) return;
    const el = elRef.current;
    if (!el) return;

    const onPointerDown = (e) => {
      if (e.button !== 0 || editing) return;
      // Don't start a drag if the user is interacting with the inner input
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startValue: value,
        moved: false,
      };
    };

    const onPointerMove = (e) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) > 2) d.moved = true;
      let mult = 1;
      if (e.shiftKey) mult = 10;
      else if (e.altKey) mult = 0.1;
      let next = d.startValue + dx * effStep * mult;
      if (e.ctrlKey || e.metaKey) {
        // Snap to integer step
        const snap = Math.max(effStep, 1);
        next = Math.round(next / snap) * snap;
      }
      next = clamp(next, min, max);
      onChange(next);
    };

    const onPointerUp = (e) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      el.releasePointerCapture(e.pointerId);
      const moved = d.moved;
      dragRef.current = null;
      // Click-without-drag → enter edit mode
      if (!moved) {
        setDraftStr(formatDisplay(value));
        setEditing(true);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    };
  }, [value, onChange, min, max, effStep, editing, disabled]);

  const commit = () => {
    const n = parseFloat(draftStr);
    if (Number.isFinite(n)) onChange(clamp(n, min, max));
    setEditing(false);
  };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: 'var(--font-mono, monospace)', fontSize: '0.7rem',
    }}>
      {label && <span style={{ color: '#5a7099' }}>{label}</span>}
      <span
        ref={elRef}
        style={{
          width,
          padding: '2px 6px',
          background: editing ? '#0d1620' : 'transparent',
          border: '1px solid #2a3a4a',
          borderRadius: 2,
          color: '#e8edf5',
          cursor: disabled ? 'default' : (editing ? 'text' : 'ew-resize'),
          textAlign: 'right',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
          touchAction: 'none',
          display: 'inline-block',
          boxSizing: 'border-box',
        }}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draftStr}
            onChange={(e) => setDraftStr(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            style={{
              width: '100%', background: 'transparent', border: 'none',
              color: '#4ec9d4', fontFamily: 'inherit', fontSize: 'inherit',
              padding: 0, textAlign: 'right', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        ) : (
          formatDisplay(value)
        )}
      </span>
      {suffix && <span style={{ color: '#5a7099' }}>{suffix}</span>}
    </span>
  );
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function deriveStep(min, max, v) {
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
    return (max - min) / 200; // ~200 px = full range traversal
  }
  const a = Math.abs(v);
  if (a === 0 || !Number.isFinite(a)) return 0.1;
  if (a < 1) return 0.01;
  if (a < 10) return 0.05;
  if (a < 100) return 0.5;
  return 1;
}

function derivePrecision(step) {
  if (step >= 1) return 1;
  if (step >= 0.1) return 2;
  if (step >= 0.01) return 3;
  return 4;
}

export default ScrubNumber;
