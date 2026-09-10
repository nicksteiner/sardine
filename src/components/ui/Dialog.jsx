import React, { useEffect, useRef } from 'react';
import { CloseButton } from './Button.jsx';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Dialog — modal shell.  role="dialog" aria-modal, focus trap, focus
 * restore, Escape, click-away.
 *
 * Keyboard behaviour is modelled on ContextMenu.jsx, which was already the
 * strongest interaction component in the app: window-level capture-phase
 * key handling so it wins over the viewer's own shortcuts, and dismissal on
 * pointerdown outside the surface.
 *
 * Callers own `open` — Dialog adds no state of its own.
 *
 * Props:
 *   open, onClose
 *   title       heading text (also the accessible name)
 *   align       'top' | 'center'  (default center; the palette wants top)
 *   wide        wider surface
 *   flushBody   drop the body padding (lists own their own)
 *   actions     nodes right-aligned in the header, before the close button
 *   footer      nodes rendered in a bottom bar
 *   initialFocus  ref to focus on open (defaults to the first focusable)
 */
export function Dialog({
  open,
  onClose,
  title,
  align = 'center',
  wide = false,
  flushBody = false,
  actions,
  footer,
  initialFocus,
  labelledBy,
  className = '',
  children,
}) {
  const surfaceRef = useRef(null);
  const restoreRef = useRef(null);
  const titleId = `dlg-${(title || 'dialog').replace(/\W+/g, '-').toLowerCase()}`;

  // Focus management: remember what had focus, move focus in, restore on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const el = initialFocus?.current
      || surfaceRef.current?.querySelector(FOCUSABLE)
      || surfaceRef.current;
    // Let the surface mount before taking focus.
    const t = setTimeout(() => el?.focus?.(), 0);
    return () => {
      clearTimeout(t);
      const prev = restoreRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, [open, initialFocus]);

  useEffect(() => {
    if (!open) return;
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); return; }
      if (e.key !== 'Tab') return;
      const surface = surfaceRef.current;
      if (!surface) return;
      const items = [...surface.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`dialog__scrim dialog__scrim--${align === 'top' ? 'top' : 'center'}`}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || (title ? titleId : undefined)}
        aria-label={!title && !labelledBy ? 'Dialog' : undefined}
        tabIndex={-1}
        className={['dialog', wide ? 'dialog--wide' : null, className].filter(Boolean).join(' ')}
      >
        {(title || actions) && (
          <header className="dialog__head">
            {title && <h2 className="dialog__title" id={titleId}>{title}</h2>}
            <span className="dialog__actions">
              {actions}
              <CloseButton onClick={onClose} />
            </span>
          </header>
        )}
        <div className={['dialog__body', flushBody ? 'dialog__body--flush' : null].filter(Boolean).join(' ')}>
          {children}
        </div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
}

export default Dialog;
