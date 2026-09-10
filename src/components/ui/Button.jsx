import React from 'react';

/**
 * Button — the one button.
 *
 * The default variant is deliberately `secondary`, not `primary`.  Before
 * W028 every unclassed <button> inherited a solid-accent CTA from a global
 * rule, so the UI read as a wall of equal-weight actions with no hierarchy.
 * Restraint is the point: one primary action per view, everything else quiet.
 *
 * Props:
 *   variant   'primary' | 'secondary' | 'ghost' | 'danger'   (default secondary)
 *   size      'sm' | 'md'                                    (default sm)
 *   icon      true → square icon button; REQUIRES `label`
 *   label     accessible name; becomes aria-label + title on icon buttons
 *   active    renders the pressed/selected state (sets aria-pressed)
 *   block     full-width
 * Everything else passes through to the <button>.
 */
export function Button({
  variant = 'secondary',
  size = 'sm',
  icon = false,
  label,
  active,
  block = false,
  className = '',
  type = 'button',
  children,
  ...rest
}) {
  if (icon && !label) {
    // Loud on purpose: an icon-only control with no name is invisible to a
    // screen reader.  W029 asserts the hard version of this.
    console.warn('[ui/Button] icon-only Button requires a `label` (used as aria-label)');
  }

  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'md' ? 'btn--md' : null,
    icon ? 'btn--icon' : null,
    block ? 'btn--block' : null,
    active ? 'is-active' : null,
    className,
  ].filter(Boolean).join(' ');

  const a11y = {};
  if (label) {
    a11y['aria-label'] = rest['aria-label'] ?? label;
    if (rest.title === undefined) a11y.title = label;
  }
  if (active !== undefined) a11y['aria-pressed'] = !!active;

  return (
    <button type={type} className={classes} {...a11y} {...rest}>
      {children}
    </button>
  );
}

/** The single close glyph for the whole app.  Was ✕ / × / ✗ in three places. */
export const CLOSE_GLYPH = '✕';

/** Close button — icon-only, always named, always the same glyph. */
export function CloseButton({ label = 'Close', ...rest }) {
  return <Button icon variant="ghost" label={label} {...rest}>{CLOSE_GLYPH}</Button>;
}

export default Button;
