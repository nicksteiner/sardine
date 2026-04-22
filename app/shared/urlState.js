/**
 * urlState — tiny URL-parameter helper shared by pages.
 *
 * SARdine is hash-routed (`#/inundation`), but wouter's hash-location hook
 * routes off the hash *fragment only* — query params go into the document's
 * `location.search`. So a "deep link" with state looks like
 *
 *     https://example.com/?lon=-73.8&lat=-8.4#/inundation
 *
 * not `#/inundation?lon=-73.8`. This module reads + writes `location.search`
 * consistently so pages don't each re-derive that quirk.
 */

/** Parse a raw query string (with or without leading '?'). */
export function parseQuery(queryString) {
  if (!queryString) return {};
  const qs = queryString.startsWith('?') ? queryString.slice(1) : queryString;
  const out = {};
  for (const [key, val] of new URLSearchParams(qs)) {
    out[key] = val;
  }
  return out;
}

/** Stringify a plain object into a query string (no leading '?'). */
export function stringifyQuery(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  return params.toString();
}

/** Read params from the document search string (`?url=…`). */
export function readSearchQuery() {
  if (typeof window === 'undefined') return {};
  return parseQuery(window.location.search);
}

/**
 * Replace `location.search` with `updates` merged on top of the current
 * params. Preserves the pathname + hash. Uses `history.replaceState` so
 * the browser back button doesn't step through every slider move.
 */
export function writeSearchQuery(updates) {
  if (typeof window === 'undefined') return;
  const existing = parseQuery(window.location.search);
  const merged = { ...existing, ...updates };
  for (const k of Object.keys(merged)) {
    const v = merged[k];
    if (v === undefined || v === null || v === '') delete merged[k];
  }
  const next = stringifyQuery(merged);
  const nextSearch = next ? `?${next}` : '';
  if (nextSearch !== window.location.search) {
    const url = window.location.pathname + nextSearch + window.location.hash;
    window.history.replaceState(window.history.state, '', url);
  }
}
