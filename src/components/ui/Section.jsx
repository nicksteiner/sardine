import React, { useState } from 'react';

/**
 * Section — a collapsible control-panel section with a real heading.
 *
 * Promoted verbatim from `app/main.jsx`'s CollapsibleSection (21 call sites)
 * and converging MetadataPanel's private copy of the same idea.  The
 * two-layer disclosure — six rail groups over these sections, so only 15-30
 * controls render at once — is good UX and is preserved exactly: same
 * classes, same collapse animation, same default-open behaviour.
 *
 * Two things change.  The heading is now a real <h3> wrapping a <button>
 * rather than a click-handling <h3>, so the section can be reached by Tab and
 * toggled with Enter or Space and announces its state via aria-expanded.  And
 * the toggle lives in one file instead of two.
 *
 * `open` is presentational disclosure state, local to this component — the
 * same useState that lived in CollapsibleSection, moved here with it.  No
 * application state is involved.
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
    <section className={['control-section', className].filter(Boolean).join(' ')} {...rest}>
      <Heading className={`collapsible${open ? '' : ' collapsed'}`}>
        <button
          type="button"
          className="ui-section__toggle"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span>{title}</span>
          {aside != null && <span className="ui-section__aside">{aside}</span>}
        </button>
      </Heading>
      <div className={`section-body${open ? '' : ' collapsed'}`}>{children}</div>
    </section>
  );
}

export default Section;
