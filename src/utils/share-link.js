/**
 * Share-link URL schema for SARdine.
 *
 * A share link points at a single dataset URL plus optional view state, e.g.:
 *   https://nicksteiner.github.io/sardine/?cog=https://...&cmap=viridis&min=-25&max=0
 *   https://nicksteiner.github.io/sardine/?nisar=https://...&pol=HHHH&freq=B&db=1
 *
 * The recipient still needs their own Earthdata Login token for DAAC URLs —
 * tokens never travel in share links.
 */

// Keep param keys short — links get pasted into chat apps that truncate.
const KEYS = {
  cog: 'cog',
  nisar: 'nisar',
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

/**
 * Parse a window.location.search-style string into a normalized share-state
 * object. Returns { dataUrl, dataType, view } where dataType is 'cog' | 'nisar'
 * | null, dataUrl is the un-proxied target URL, and view holds any render
 * options that were present.
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
  }

  const view = {};
  const cmap = p.get(KEYS.cmap);   if (cmap) view.colormap = cmap;
  const rev = bool(p.get(KEYS.rev)); if (rev != null) view.reverseColormap = rev;
  const db = bool(p.get(KEYS.db));   if (db != null) view.useDecibels = db;
  const minV = num(p.get(KEYS.min)); if (minV != null) view.contrastMin = minV;
  const maxV = num(p.get(KEYS.max)); if (maxV != null) view.contrastMax = maxV;
  const stretch = p.get(KEYS.stretch); if (stretch) view.stretchMode = stretch;
  const gamma = num(p.get(KEYS.gamma)); if (gamma != null) view.gamma = gamma;
  const pol = p.get(KEYS.pol);     if (pol) view.selectedPolarization = pol;
  const freq = p.get(KEYS.freq);   if (freq) view.selectedFrequency = freq;
  const ml = num(p.get(KEYS.ml));  if (ml != null) view.multiLook = ml;
  const comp = p.get(KEYS.comp);   if (comp) view.compositeId = comp;
  const mode = p.get(KEYS.mode);   if (mode) view.displayMode = mode;

  const c = p.get(KEYS.c);
  if (c) {
    const parts = c.split(',').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) view.viewCenter = parts;
  }
  const z = num(p.get(KEYS.z));    if (z != null) view.viewZoom = z;

  return { dataUrl, dataType, view };
}

/**
 * Build a share URL for the current viewer state.
 *
 * @param {Object} opts
 * @param {string} [opts.baseUrl]   — defaults to window.location origin+pathname (no query)
 * @param {string} opts.dataUrl     — raw (un-proxied) data URL to share
 * @param {'cog'|'nisar'} opts.dataType
 * @param {Object} [opts.view]      — partial render state (same shape as parseShareLink output)
 * @returns {string} full share URL
 */
export function buildShareLink({ baseUrl, dataUrl, dataType, view = {} }) {
  if (!dataUrl || !dataType) throw new Error('buildShareLink: dataUrl and dataType are required');

  const base = baseUrl || (typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : 'https://nicksteiner.github.io/sardine/');

  const p = new URLSearchParams();
  p.set(KEYS[dataType], dataUrl);

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

  return `${base}?${p.toString()}`;
}

/**
 * Strip the share-link params from the current URL without reloading. Used
 * after auto-load so reloading the page doesn't re-trigger the share flow
 * and the user can copy a fresh link reflecting their current state.
 */
export function clearShareLinkParams() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  for (const k of Object.values(KEYS)) url.searchParams.delete(k);
  window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
}
