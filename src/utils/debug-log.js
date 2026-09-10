/**
 * debug-log.js — gated diagnostic logging (SARdine standard practice).
 *
 * Do not call console.log directly in app or library code: hot paths (tile
 * fetch, chunk decode) evaluate template strings on every call and flood the
 * console in production. Route diagnostics through debugLog instead.
 * console.warn / console.error stay un-gated — real problems must surface.
 *
 * Enable at runtime with any one of:
 *   - URL param:    ?debug=1
 *   - localStorage: localStorage.setItem('sardine:debug', '1')
 *   - console:      globalThis.SARDINE_DEBUG = true   (live toggle, no reload)
 *   - node:         SARDINE_DEBUG=1 environment variable
 */

let _cached = null;

export function debugEnabled() {
  // Live override wins and is re-read every call so it can be toggled
  // from the console without a reload.
  if (typeof globalThis !== 'undefined' && globalThis.SARDINE_DEBUG !== undefined) {
    return !!globalThis.SARDINE_DEBUG;
  }
  if (_cached !== null) return _cached;
  let on = false;
  try {
    if (typeof location !== 'undefined' && /[?&]debug=1(?:&|$)/.test(location.search)) {
      on = true;
    } else if (typeof localStorage !== 'undefined' && localStorage.getItem('sardine:debug') === '1') {
      on = true;
    } else if (typeof process !== 'undefined' && process.env?.SARDINE_DEBUG === '1') {
      on = true;
    }
  } catch (_) { /* storage blocked (private mode, sandboxed frame) */ }
  _cached = on;
  return on;
}

export function debugLog(...args) {
  if (debugEnabled()) console.log(...args);
}
