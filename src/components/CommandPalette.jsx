import { useEffect, useRef, useState, useMemo } from 'react';
import { Dialog } from './ui/index.js';

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
    <Dialog
      open={open}
      onClose={onClose}
      align="top"
      flushBody
      ariaLabel="Command palette"
      initialFocus={inputRef}
      className="cmdk"
      footer={(
        <>
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span className="cmdk__count">{filtered.length} / {actions.length}</span>
        </>
      )}
    >
      <input
        ref={inputRef}
        className="cmdk__input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder="Type a command…"
        aria-label="Search commands"
      />
      <div ref={listRef} className="cmdk__list">
        {filtered.length === 0 ? (
          <p className="cmdk__empty">no matches</p>
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
    </Dialog>
  );
}

function ActionRow({ action, idx, selected, onHover, onPick }) {
  return (
    <div
      data-idx={idx}
      className={`cmdk__row${selected ? ' cmdk__row--selected' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
    >
      {action.group && <span className="cmdk__group">{action.group}</span>}
      <span className="cmdk__label">{action.label}</span>
      {action.hint && <span className="cmdk__hint">{action.hint}</span>}
      {action.shortcut && <kbd className="cmdk__shortcut">{action.shortcut}</kbd>}
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
