import { useEffect, useRef, useState, useMemo } from 'react';

/**
 * CommandPalette — Cmd-K / Ctrl-K modal with fuzzy search.
 *
 * Receives a flat array of actions: [{id, label, hint?, group?, shortcut?, run, when?}].
 * - run: () => void — executed on Enter or click
 * - when: () => boolean — gate visibility (e.g., disable export when no data)
 * - hint: short secondary text shown right of label
 * - group: section header in the list
 * - shortcut: visual hint only; the keybind itself is bound elsewhere
 *
 * Fuzzy match scores by: contiguous-substring > subsequence > group match.
 */
export function CommandPalette({ open, onClose, actions }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Defer focus to next frame so the input is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const visible = actions.filter(a => !a.when || a.when());
    if (!query.trim()) {
      return visible.map(a => ({ action: a, score: 0 }));
    }
    const q = query.toLowerCase();
    const scored = [];
    for (const a of visible) {
      const score = fuzzyScore(q, a);
      if (score > 0) scored.push({ action: a, score });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored;
  }, [actions, query]);

  // Reset selection when filter changes
  useEffect(() => { setSelected(0); }, [query]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selected}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(s => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(s => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = filtered[selected];
      if (hit) {
        onClose();
        // Defer so the modal unmounts before action runs (avoids focus thrash)
        setTimeout(() => hit.action.run(), 0);
      }
    }
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        style={{
          width: 'min(560px, 90vw)',
          background: '#0d1620',
          border: '1px solid #2a2a2a',
          borderTop: '2px solid #4ec9d4',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          fontFamily: 'var(--font-mono, monospace)',
          color: '#e8edf5',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a command…"
          style={{
            width: '100%',
            padding: '12px 14px',
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid #1a2a3a',
            color: '#e8edf5',
            fontSize: '0.85rem',
            fontFamily: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div ref={listRef} style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '14px', color: '#5a7099', fontStyle: 'italic', fontSize: '0.75rem' }}>
              no matches
            </div>
          ) : (
            filtered.map(({ action }, i) => (
              <ActionRow
                key={action.id}
                action={action}
                idx={i}
                selected={i === selected}
                onHover={() => setSelected(i)}
                onPick={() => {
                  onClose();
                  setTimeout(() => action.run(), 0);
                }}
              />
            ))
          )}
        </div>
        <div style={{
          borderTop: '1px solid #1a2a3a',
          padding: '5px 12px',
          fontSize: '0.6rem',
          color: '#5a7099',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span>{filtered.length} / {actions.length}</span>
        </div>
      </div>
    </div>
  );
}

function ActionRow({ action, idx, selected, onHover, onPick }) {
  return (
    <div
      data-idx={idx}
      onMouseEnter={onHover}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      style={{
        padding: '7px 14px',
        cursor: 'pointer',
        background: selected ? 'rgba(78, 201, 212, 0.12)' : 'transparent',
        borderLeft: selected ? '2px solid #4ec9d4' : '2px solid transparent',
        display: 'flex', alignItems: 'center', gap: 10,
        fontSize: '0.75rem',
      }}
    >
      {action.group && (
        <span style={{ color: '#5a7099', fontSize: '0.6rem', minWidth: 60, letterSpacing: 1 }}>
          {action.group}
        </span>
      )}
      <span style={{ color: selected ? '#4ec9d4' : '#e8edf5', flex: 1 }}>
        {action.label}
      </span>
      {action.hint && (
        <span style={{ color: '#5a7099', fontSize: '0.65rem' }}>{action.hint}</span>
      )}
      {action.shortcut && (
        <span style={{
          color: '#5a7099', fontSize: '0.6rem',
          padding: '1px 5px', border: '1px solid #2a3a4a', borderRadius: 2,
        }}>{action.shortcut}</span>
      )}
    </div>
  );
}

/**
 * fuzzyScore — higher = better match.
 *  contiguous substring → 1000 + (longer match earlier)
 *  subsequence (chars in order) → 100 + (density)
 *  group match → 50
 *  no match → 0
 */
function fuzzyScore(q, action) {
  const label = action.label.toLowerCase();
  const group = (action.group || '').toLowerCase();
  const hint = (action.hint || '').toLowerCase();
  const hay = `${label} ${group} ${hint}`;

  // 1) Contiguous substring in label = best
  const idx = label.indexOf(q);
  if (idx >= 0) return 1000 - idx;

  // 2) Subsequence in label
  let li = 0, qi = 0, firstHit = -1, lastHit = -1;
  while (li < label.length && qi < q.length) {
    if (label[li] === q[qi]) {
      if (firstHit < 0) firstHit = li;
      lastHit = li;
      qi++;
    }
    li++;
  }
  if (qi === q.length) {
    const span = lastHit - firstHit + 1;
    const density = q.length / span; // 1.0 = perfect contiguous, lower = spread
    return 100 + Math.round(density * 50) - firstHit;
  }

  // 3) Substring in group/hint
  if (hay.indexOf(q) >= 0) return 50;

  return 0;
}

export default CommandPalette;
