/**
 * a11y.js — the small set of keyboard/ARIA props that a non-native
 * interactive element needs to behave like the control it looks like.
 *
 * SARdine is overwhelmingly a native-<button> codebase; the handful of
 * div/span click targets that remain are rows, headers and map surfaces where
 * a <button> would fight the layout. Those still owe the keyboard user three
 * things — a role, a tab stop, and Enter/Space activation — and it is easier
 * to get all three right in one place than at each call site.
 *
 * Prefer a real <button> or <a> whenever the layout permits. Reach for this
 * only when it does not.
 */

/**
 * Props that turn a click-only element into a keyboard-operable control.
 *
 * @param {Function} onActivate   invoked on click and on Enter/Space
 * @param {object}   [opts]
 * @param {string}   [opts.role='button']  ARIA role to expose
 * @param {string}   [opts.label]          accessible name (aria-label)
 * @param {boolean}  [opts.disabled]       remove the tab stop and the handler
 * @param {object}   [opts.rest]           extra ARIA props, merged verbatim
 * @returns {object} spread onto the element
 *
 * @example
 *   <div {...clickable(() => open(dir), { label: `Open ${dir}` })}>…</div>
 */
export function clickable(onActivate, opts = {}) {
  const { role = 'button', label, disabled = false, ...rest } = opts;
  if (disabled || typeof onActivate !== 'function') {
    return { role, 'aria-label': label, 'aria-disabled': disabled || undefined, ...rest };
  }
  return {
    role,
    tabIndex: 0,
    'aria-label': label,
    onClick: onActivate,
    onKeyDown: (e) => {
      // Space scrolls the page by default and Enter submits forms; a control
      // that claims role=button has to swallow both and act instead.
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        onActivate(e);
      }
    },
    ...rest,
  };
}

/**
 * Props for a disclosure header (a collapsible section's title bar).
 * Same contract as `clickable`, plus the expanded state.
 *
 * @param {Function} onToggle
 * @param {boolean}  expanded
 * @param {object}   [opts]  see `clickable`
 */
export function disclosure(onToggle, expanded, opts = {}) {
  return clickable(onToggle, { ...opts, 'aria-expanded': !!expanded });
}

/**
 * Props for a selectable row in a list (search results, catalog scenes).
 * role=option must sit inside a role=listbox container to be valid.
 *
 * @param {Function} onSelect
 * @param {boolean}  selected
 * @param {object}   [opts]  see `clickable`
 */
export function option(onSelect, selected, opts = {}) {
  return clickable(onSelect, { ...opts, role: 'option', 'aria-selected': !!selected });
}

/**
 * Arrow-key handling for a control that is really a one-dimensional slider
 * but is not an <input type=range> — the comparison swipe handle, chiefly.
 * Returns an onKeyDown; pair it with role="slider" and the aria-value* trio.
 *
 * @param {number}   value     current position
 * @param {Function} onChange  receives the new, already-clamped position
 * @param {object}   [opts]
 * @param {number}   [opts.min=0]
 * @param {number}   [opts.max=1]
 * @param {number}   [opts.step=0.02]
 * @param {number}   [opts.pageStep]  Page Up/Down delta (default 5 × step)
 */
export function sliderKeys(value, onChange, opts = {}) {
  const { min = 0, max = 1, step = 0.02, pageStep = null } = opts;
  const big = pageStep ?? step * 5;
  return (e) => {
    let next = null;
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': next = value - step; break;
      case 'ArrowRight': case 'ArrowUp': next = value + step; break;
      case 'PageDown': next = value - big; break;
      case 'PageUp': next = value + big; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      default: return;
    }
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  };
}

/**
 * True when a keystroke lands in something the user is typing into, and so
 * must not be swallowed by a global shortcut. `isContentEditable` is the one
 * people forget: a contenteditable region is neither INPUT nor TEXTAREA.
 *
 * @param {EventTarget} target  usually `event.target`
 */
export function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
