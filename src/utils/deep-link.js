/**
 * deep-link.js — granule deep-link URL schema for SARdine (W008).
 *
 * Pure functions (no React, no window requirement) so the serializer/parser
 * round-trip is unit-testable in Node. A deep link points at a single dataset
 * URL plus optional render + view state, e.g.:
 *
 *   https://.../sardine/?url=https://host/scene.tif&colormap=viridis&contrastMin=-20&contrastMax=0
 *   https://.../sardine/?cog=https://...&cmap=viridis&min=-25&max=0
 *   https://.../sardine/?nisar=https://...&pol=HHHH&freq=B&db=1
 *
 * Two spellings are accepted on parse:
 *   - short keys (what buildShareLink emits — links get pasted into chat apps
 *     that truncate): cmap, min, max, db, stretch, comp, pol, freq, …
 *   - long keys (human-writable): colormap, contrastMin, contrastMax,
 *     useDecibels, stretchMode, compositeId, polarization, frequency.
 *
 * The generic `?url=` param routes by file extension (see inferDataTypeFromUrl);
 * the explicit `?cog=` / `?nisar=` / `?nitf=` params override inference.
 *
 * The recipient still needs their own Earthdata Login token for DAAC URLs —
 * tokens never travel in deep links.
 *
 * Spatial subset (W016): `?bbox=w,s,e,n` (WGS84 lon/lat) or `?wkt=<POLYGON/BBOX>`
 * loads only the region — the app fits the view to it, applies it as the ROI,
 * and (for remote NISAR) scopes chunk prefetch to the intersecting chunk range.
 * `wkt` wins over `bbox` when both are present; internally the WKT reduces to
 * its bbox for fetch scoping (polygon fidelity is kept only for the ROI/WKT
 * input display). Malformed values are ignored with a console warning.
 */

import { validateWKT } from './wkt.js';

// Keep emitted param keys short — links get pasted into chat apps that truncate.
const KEYS = {
  url: 'url',         // generic source URL, type inferred from extension
  cog: 'cog',
  nisar: 'nisar',
  nitf: 'nitf',       // also matches ?sicd= (SICD-in-NITF is the common case)
  // Rendering
  cmap: 'cmap',
  rev: 'rev',         // reverse colormap (0/1)
  db: 'db',           // use decibels (0/1)
  min: 'min',         // contrast min
  max: 'max',         // contrast max
  stretch: 'stretch', // linear | sqrt | gamma | sigmoid
  gamma: 'gamma',
  // NISAR-only
  pol: 'pol',
  freq: 'freq',
  ml: 'ml',
  comp: 'comp',       // compositeId (e.g. 'dual-pol-h', 'pauli')
  mode: 'mode',       // 'single' | 'composite'
  // Viewport (optional — center as lon,lat, plus zoom)
  c: 'c',
  z: 'z',
  // Spatial subset (W016) — WGS84 lon/lat
  bbox: 'bbox',       // w,s,e,n
  wkt: 'wkt',         // URL-encoded WKT (POLYGON/BBOX/...); wins over bbox
};

// Long-form aliases accepted on parse (short key → long key).
const LONG = {
  cmap: 'colormap',
  min: 'contrastMin',
  max: 'contrastMax',
  db: 'useDecibels',
  stretch: 'stretchMode',
  comp: 'compositeId',
  pol: 'polarization',
  freq: 'frequency',
  ml: 'multilook',
};

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v == null) return null;
  return v === '1' || v === 'true';
}

/** Get a param by its short key, falling back to the long-form alias. */
function pick(p, shortKey) {
  const v = p.get(shortKey);
  if (v != null) return v;
  const longKey = LONG[shortKey];
  return longKey ? p.get(longKey) : null;
}

/**
 * Infer the SARdine data type from a URL's file extension (query string and
 * fragment ignored). Returns 'nisar' | 'cog' | 'nitf' | null (unknown).
 * Mirrors the routing in main.jsx's direct-URL handler:
 *   .h5/.he5/.hdf5/.hdf → remote NISAR HDF5 path
 *   .tif/.tiff/.geotiff → COG path
 *   .ntf/.nitf          → NITF/SICD path
 */
export function inferDataTypeFromUrl(url) {
  const path = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/\.(h5|he5|hdf5|hdf)$/.test(path)) return 'nisar';
  if (/\.(tif|tiff|geotiff)$/.test(path)) return 'cog';
  if (/\.(ntf|nitf)$/.test(path)) return 'nitf';
  return null;
}

/**
 * Parse a window.location.search-style string into a normalized share-state
 * object. Returns { dataUrl, dataType, view } where dataType is 'cog' |
 * 'nisar' | 'nitf' | null, dataUrl is the un-proxied target URL, and view
 * holds any render options that were present.
 *
 * Explicit type params (?cog=, ?nisar=, ?nitf=/?sicd=) win over the generic
 * ?url= param; ?url= with an unknown extension falls back to 'nisar' (same
 * fallback as the manual direct-URL input).
 */
export function parseShareLink(search = (typeof window !== 'undefined' ? window.location.search : '')) {
  const p = new URLSearchParams(search || '');

  let dataUrl = null;
  let dataType = null;
  if (p.has(KEYS.nisar)) {
    dataUrl = p.get(KEYS.nisar);
    dataType = 'nisar';
  } else if (p.has(KEYS.cog)) {
    dataUrl = p.get(KEYS.cog);
    dataType = 'cog';
  } else if (p.has(KEYS.nitf) || p.has('sicd')) {
    dataUrl = p.get(KEYS.nitf) || p.get('sicd');
    dataType = 'nitf';
  } else if (p.has(KEYS.url)) {
    dataUrl = p.get(KEYS.url);
    dataType = inferDataTypeFromUrl(dataUrl) || 'nisar';
  }

  const view = {};
  const cmap = pick(p, KEYS.cmap);   if (cmap) view.colormap = cmap;
  const rev = bool(p.get(KEYS.rev)); if (rev != null) view.reverseColormap = rev;
  const db = bool(pick(p, KEYS.db));   if (db != null) view.useDecibels = db;
  const minV = num(pick(p, KEYS.min)); if (minV != null) view.contrastMin = minV;
  const maxV = num(pick(p, KEYS.max)); if (maxV != null) view.contrastMax = maxV;
  const stretch = pick(p, KEYS.stretch); if (stretch) view.stretchMode = stretch;
  const gamma = num(p.get(KEYS.gamma)); if (gamma != null) view.gamma = gamma;
  const pol = pick(p, KEYS.pol);     if (pol) view.selectedPolarization = pol;
  const freq = pick(p, KEYS.freq);   if (freq) view.selectedFrequency = freq;
  const ml = num(pick(p, KEYS.ml));  if (ml != null) view.multiLook = ml;
  const comp = pick(p, KEYS.comp);   if (comp) view.compositeId = comp;
  const mode = p.get(KEYS.mode);   if (mode) view.displayMode = mode;

  const c = p.get(KEYS.c);
  if (c) {
    const parts = c.split(',').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) view.viewCenter = parts;
  }
  const z = num(p.get(KEYS.z));    if (z != null) view.viewZoom = z;

  // Spatial subset (W016): wkt wins over bbox; both reduce to a WGS84 bbox.
  // Malformed values are rejected with a warning, never a throw.
  const wktStr = p.get(KEYS.wkt);
  let roiFromWkt = false;
  if (wktStr) {
    const v = validateWKT(wktStr);
    if (v.valid && v.bbox[0] < v.bbox[2] && v.bbox[1] < v.bbox[3]) {
      view.roiWkt = wktStr;
      view.roiBbox = v.bbox; // [west, south, east, north]
      roiFromWkt = true;
    } else {
      console.warn(`[deep-link] Ignoring malformed wkt= param: ${v.error || 'degenerate geometry (zero-area bbox)'}`);
    }
  }
  if (!roiFromWkt) {
    const bboxStr = p.get(KEYS.bbox);
    if (bboxStr) {
      const parts = bboxStr.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)
          && parts[0] < parts[2] && parts[1] < parts[3]) {
        view.roiBbox = parts;
      } else {
        console.warn(`[deep-link] Ignoring malformed bbox= param (want w,s,e,n with w<e, s<n): ${bboxStr}`);
      }
    }
  }

  return { dataUrl, dataType, view };
}

/**
 * Build a share URL for the current viewer state.
 *
 * @param {Object} opts
 * @param {string} [opts.baseUrl]   — defaults to window.location origin+pathname (no query)
 * @param {string} opts.dataUrl     — raw (un-proxied) data URL to share
 * @param {'cog'|'nisar'|'nitf'} opts.dataType
 * @param {Object} [opts.view]      — partial render state (same shape as parseShareLink output)
 * @returns {string} full share URL
 */
export function buildShareLink({ baseUrl, dataUrl, dataType, view = {} }) {
  if (!dataUrl || !dataType) throw new Error('buildShareLink: dataUrl and dataType are required');

  const base = baseUrl || (typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : 'https://nicksteiner.github.io/sardine/');

  const p = new URLSearchParams();
  // Emit the generic ?url= when the extension round-trips to the same type;
  // otherwise pin the type explicitly (?cog=/?nisar=/?nitf=).
  if (inferDataTypeFromUrl(dataUrl) === dataType) p.set(KEYS.url, dataUrl);
  else p.set(KEYS[dataType], dataUrl);

  // Only emit params that differ from defaults — keep URLs short and readable.
  if (view.colormap && view.colormap !== 'grayscale') p.set(KEYS.cmap, view.colormap);
  if (view.reverseColormap) p.set(KEYS.rev, '1');
  if (view.useDecibels === false) p.set(KEYS.db, '0');
  if (Number.isFinite(view.contrastMin)) p.set(KEYS.min, String(view.contrastMin));
  if (Number.isFinite(view.contrastMax)) p.set(KEYS.max, String(view.contrastMax));
  if (view.stretchMode && view.stretchMode !== 'linear') p.set(KEYS.stretch, view.stretchMode);
  if (Number.isFinite(view.gamma) && view.gamma !== 1) p.set(KEYS.gamma, String(view.gamma));
  if (view.selectedPolarization) p.set(KEYS.pol, view.selectedPolarization);
  if (view.selectedFrequency) p.set(KEYS.freq, view.selectedFrequency);
  if (Number.isFinite(view.multiLook) && view.multiLook !== 1) p.set(KEYS.ml, String(view.multiLook));
  if (view.compositeId) p.set(KEYS.comp, view.compositeId);
  if (view.displayMode && view.displayMode !== 'single') p.set(KEYS.mode, view.displayMode);

  if (Array.isArray(view.viewCenter) && view.viewCenter.length === 2
      && view.viewCenter.every(Number.isFinite)) {
    const [lon, lat] = view.viewCenter;
    p.set(KEYS.c, `${lon.toFixed(5)},${lat.toFixed(5)}`);
  }
  if (Number.isFinite(view.viewZoom)) p.set(KEYS.z, String(Math.round(view.viewZoom * 100) / 100));

  // Spatial subset (W016): emit the active ROI as a WGS84 bbox. Callers with
  // projected scenes reproject to 4326 before passing roiBbox (see main.jsx).
  if (Array.isArray(view.roiBbox) && view.roiBbox.length === 4
      && view.roiBbox.every(Number.isFinite)
      && view.roiBbox[0] < view.roiBbox[2] && view.roiBbox[1] < view.roiBbox[3]) {
    p.set(KEYS.bbox, view.roiBbox.map(v => Math.round(v * 1e5) / 1e5).join(','));
  }

  return `${base}?${p.toString()}`;
}

/**
 * Strip the deep-link params from the current URL without reloading. Used
 * after auto-load so reloading the page doesn't re-trigger the share flow
 * and the user can copy a fresh link reflecting their current state.
 */
export function clearShareLinkParams() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  for (const k of Object.values(KEYS)) url.searchParams.delete(k);
  for (const k of Object.values(LONG)) url.searchParams.delete(k);
  url.searchParams.delete('sicd');
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}
