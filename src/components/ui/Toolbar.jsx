import React from 'react';

/**
 * Toolbar — a horizontal cluster of controls with one consistent gap.
 *
 * Exists so that "a row of buttons" stops being re-expressed as an inline
 * `display:flex; gap:6px` object at 40-odd call sites.
 *
 * Props:
 *   align   'start' | 'between' | 'end'   (default start)
 *   wrap    boolean (default true)
 *   grow    boolean — children share the width equally
 *   stack   boolean — vertical instead of horizontal
 *   as      element type (default 'div'; pass 'header' for a real landmark)
 */
export function Toolbar({
  align = 'start',
  wrap = true,
  grow = false,
  stack = false,
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'toolbar',
    wrap ? 'toolbar--wrap' : 'toolbar--nowrap',
    align === 'between' ? 'toolbar--between' : null,
    align === 'end' ? 'toolbar--end' : null,
    grow ? 'toolbar--grow' : null,
    stack ? 'toolbar--stack' : null,
    className,
  ].filter(Boolean).join(' ');

  return <Tag className={classes} {...rest}>{children}</Tag>;
}

export default Toolbar;
