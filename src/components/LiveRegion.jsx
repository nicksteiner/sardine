/**
 * LiveRegion — the app's screen-reader announcement channel.
 *
 * SARdine streams: a NISAR granule takes seconds to minutes to open, and
 * everything that reports on it (the spinner, the progress bar, the status
 * window) is visual only — and the status window is collapsed by default.
 * A screen-reader user otherwise gets silence for the whole load.
 *
 * Two regions, deliberately:
 *   - polite / role=status  — state transitions (a load started, a load
 *     finished). Queued behind whatever the reader is already saying.
 *   - assertive / role=alert — failures only. Interrupts.
 *
 * The hard rule here is VERBOSITY. The app emits hundreds of status-log
 * lines per session; announcing them would make it unusable with a reader.
 * Only transitions are announced — never progress ticks — and each is
 * debounced so a burst of fast tile loads collapses into one utterance.
 */

import React, { useEffect, useRef, useState } from 'react';

/** Delay before a transition is spoken, so rapid flips collapse into one. */
const ANNOUNCE_DEBOUNCE_MS = 300;

/**
 * Renders the two live regions. Mount once, near the app root.
 * Both are visually hidden but present in the accessibility tree — they must
 * exist in the DOM *before* their text changes, or the change is not announced.
 */
export function LiveRegion({ polite = '', assertive = '' }) {
  return (
    <>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite}
      </div>
      <div
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertive}
      </div>
    </>
  );
}

/**
 * Derive announcement text from the load lifecycle.
 *
 * @param {object}  opts
 * @param {boolean} opts.loading  the app's single loading flag
 * @param {string}  opts.subject  what is loading ("NISAR granule", a filename)
 * @param {string}  opts.error    latest failure message, or '' / null
 * @returns {{polite: string, assertive: string}} props for <LiveRegion>
 */
export function useLoadAnnouncer({ loading, subject = '', error = '' }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const wasLoading = useRef(loading);
  const errorAtStart = useRef(error);
  const latestError = useRef(error);
  const timer = useRef(null);
  latestError.current = error;

  useEffect(() => {
    if (loading === wasLoading.current) return;  // transitions only
    wasLoading.current = loading;

    const what = subject ? subject.trim() : 'data';
    // A load that ends with a fresh error did not finish — saying "loaded"
    // there is worse than saying nothing. The error is read from a ref so it
    // does not sit in the dependency list: an error arriving mid-load would
    // otherwise re-run this effect and cancel the pending "Loading" utterance.
    const err = latestError.current;
    const failed = !loading && err && err !== errorAtStart.current;
    if (loading) errorAtStart.current = err;
    const message = loading ? `Loading ${what}`
      : failed ? `${what} could not be loaded`
      : `${what} loaded`;

    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // A repeated identical string is not re-announced by most readers;
      // the trailing marker forces a fresh utterance for a genuine repeat.
      setPolite(prev => (prev === message ? `${message}.` : message));
    }, ANNOUNCE_DEBOUNCE_MS);
  }, [loading, subject]);

  // Only unmount cancels a pending announcement.
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!error) return;
    setAssertive(prev => (prev === error ? `${error}.` : error));
  }, [error]);

  return { polite, assertive };
}
