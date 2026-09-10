import React, { useId } from 'react';

/**
 * Field — label + control, with the pairing done for you.
 *
 * This is the fix for the 96 unlabeled inputs the W028 audit found.  Field
 * generates an id, hands it to the control via a render prop (or clones a
 * single child), and points `htmlFor` at it.  A caller cannot forget the
 * wiring because there is nothing to forget.
 *
 * Note `useId` is React state-free — it does not add application state.
 *
 * Props:
 *   label     visible label text (required for a real pairing)
 *   hint      helper text under the control
 *   error     error text under the control (replaces hint)
 *   value     optional read-out rendered beside the control (slider values)
 *   inline    label sits beside the control (checkboxes, compact rows)
 *   htmlFor   opt out of id generation and point at an existing control id
 *   children  either a single element, or (id) => element
 */
export function Field({
  label,
  hint,
  error,
  value,
  inline = false,
  disabled = false,
  htmlFor,
  className = '',
  children,
  ...rest
}) {
  const generated = useId();
  const id = htmlFor || generated;

  const control = typeof children === 'function'
    ? children(id)
    : React.isValidElement(children) && children.props.id === undefined
      ? React.cloneElement(children, { id })
      : children;

  const classes = [
    'field',
    inline ? 'field--inline' : null,
    disabled ? 'field--disabled' : null,
    className,
  ].filter(Boolean).join(' ');

  // Inline fields read control-first, label-second (checkbox, radio).
  const labelEl = label
    ? <label className="field__label" htmlFor={id}>{label}</label>
    : null;
  const controlEl = (
    <span className="field__control">
      {control}
      {value != null && <span className="field__value">{value}</span>}
    </span>
  );

  return (
    <div className={classes} {...rest}>
      {inline ? <>{controlEl}{labelEl}</> : <>{labelEl}{controlEl}</>}
      {error
        ? <span className="field__error">{error}</span>
        : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export default Field;
