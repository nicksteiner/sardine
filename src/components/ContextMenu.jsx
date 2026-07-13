import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * ContextMenu — right-click / long-press menu driven by the same action
 * registry as the command palette.
 *
 * Items share the palette action shape: {id, label, group?, shortcut?, run}.
 * `null` entries and items whose `when()` is false are filtered by the
 * caller; a change of `group` between consecutive items renders a divider.
 *
 * Positioning clamps to the viewport. Closes on Escape, click-away,
 * scroll, or resize. Keyboard: ↑↓ navigate, Enter runs, Esc closes.
 */
export function ContextMenu({ open, x, y, items, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [selected, setSelected] = useState(-1);

  // Clamp to viewport once the menu has a size
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      left: Math.max(4, Math.min(x, vw - r.width - 4)),
      top: Math.max(4, Math.min(y, vh - r.height - 4)),
    });
    setSelected(-1);
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(items.length - 1, s + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(0, s - 1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        setSelected(s => {
          const item = items[s];
          if (item) { onClose(); setTimeout(() => item.run(), 0); }
          return s;
        });
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, items, onClose]);

  if (!open || !items.length) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <React.Fragment key={item.id}>
          {i > 0 && item.group !== items[i - 1].group && (
            <div className="context-menu-divider" role="separator" />
          )}
          <button
            role="menuitem"
            className={`context-menu-item${i === selected ? ' selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => { onClose(); setTimeout(() => item.run(), 0); }}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

export default ContextMenu;
