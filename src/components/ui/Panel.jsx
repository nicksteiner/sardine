import React from 'react';

/**
 * Panel — a titled surface.  Used by control-panel groups and by the
 * floating overlays that sit on top of the viewer.
 *
 * Renders a real <h2> for the title, so the panels finally have structure:
 * before W028 the three largest (CompareGrid, ScatterClassifier,
 * MetadataPanel — 111 KB of JSX) contained zero headings between them.
 *
 * Props:
 *   title     heading text (omit for an untitled surface)
 *   variant   'docked' | 'floating' | 'flush'   (default docked)
 *   actions   nodes rendered right-aligned in the header (close, menus)
 *   flushBody drop the body padding (lists, tables, canvases)
 *   as        element type (default 'section')
 */
export function Panel({
  title,
  variant = 'docked',
  actions,
  flushBody = false,
  level = 2,
  as: Tag = 'section',
  className = '',
  bodyClassName = '',
  children,
  ...rest
}) {
  const Heading = `h${level}`;
  const classes = [
    'panel',
    variant === 'floating' ? 'panel--floating' : null,
    variant === 'flush' ? 'panel--flush' : null,
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {(title || actions) && (
        <header className="panel__head">
          {title && <Heading className="panel__title">{title}</Heading>}
          {actions && <span className="panel__actions">{actions}</span>}
        </header>
      )}
      <div className={['panel__body', flushBody ? 'panel__body--flush' : null, bodyClassName].filter(Boolean).join(' ')}>
        {children}
      </div>
    </Tag>
  );
}

export default Panel;
