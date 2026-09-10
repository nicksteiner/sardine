import React, { useState } from 'react';

/**
 * Section — a collapsible control-panel section with a real <h3>.
 *
 * Promoted verbatim from `app/main.jsx`'s CollapsibleSection (used 21×) and
 * from MetadataPanel's private copy of the same idea; the two-layer
 * disclosure (rail group → section) is good UX and is preserved exactly.
 * The only behavioural addition is the heading element: the three largest
 * panels had zero <h1>-<h6> between them, so nothing could be skimmed or
 * navigated by structure.
 *
 * `open` is presentational disclosure state, local to this component — the
 * same useState that lived in CollapsibleSection, moved with it.
 *
 * Props:
 *   title        heading text
 *   defaultOpen  (default true)
 *   aside        small right-aligned text (counts, units)
 *   level        heading level, 2|3|4 (default 3)
 */
export function Section({
  title,
  defaultOpen = true,
  aside,
  level = 3,
  className = '',
  children,
  ...rest
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Heading = `h${level}`;

  return (
    <section className={['ui-section', className].filter(Boolean).join(' ')} {...rest}>
      <Heading style={{ margin: 0 }}>
        <button
          type="button"
          className="ui-section__head"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span className={`ui-section__chevron${open ? ' ui-section__chevron--open' : ''}`}>▸</span>
          <span>{title}</span>
          {aside != null && <span className="ui-section__aside">{aside}</span>}
        </button>
      </Heading>
      <div className="ui-section__body" hidden={!open}>{children}</div>
    </section>
  );
}

export default Section;
