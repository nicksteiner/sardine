/**
 * Figure style — the single source of truth for how *exported figures* look.
 *
 * This is deliberately separate from the app's UI THEME (theme-tokens.js). The
 * UI is a dark navy instrument panel; a figure that goes into a paper, poster,
 * or slide wants a different, restrained house style. Two presets:
 *
 *   - 'publication' (default): white ground, near-black ink, sans labels with
 *     mono only for numerics, hairline OPEN chrome — no pill boxes, no dashed
 *     border, no rounded insets. Matches the Nature/RSE house style already used
 *     by the chart SVGs (svg-export.js).
 *   - 'dark': the legacy on-screen look, kept for presentation/projector use.
 *
 * Draw helpers read the *active* style (setFigureStyle → getFigureStyle) rather
 * than threading a param through ~15 functions. Each export function sets the
 * style once, synchronously, at entry; there is no concurrency within a single
 * export call, so a module-level active binding is safe.
 */

import { FONTS } from './theme-tokens.js';

// Sans for labels/titles; mono ONLY for coordinate + dB numerics (where digit
// alignment helps). Serif optional for a formal title.
const SANS  = FONTS.body;    // 'IBM Plex Sans'
const MONO  = FONTS.mono;    // numerics
const TITLE = FONTS.display; // 'Space Grotesk'

// ── Publication (light) — the default ───────────────────────────────────────
// Forward-looking, not stuffy: a warm near-white ground instead of clinical
// #fff, ink that's a very dark desaturated slate rather than dead black, ONE
// confident accent (a deep teal-ink) used sparingly for the scale bar and
// active marks, and restraint achieved through composition — open chrome,
// generous type in a modern grotesk — not through greyscale timidity. Reads
// like a Distill/modern-RSE figure, not a 1995 journal PDF.
export const PUBLICATION = Object.freeze({
  id: 'publication',

  // Canvas / raster background — shows through the SAR raster wherever it is
  // masked (nodata / off-swath). A neutral LIGHT GRAY, not white: white nodata
  // reads as a bright valid pixel in a dB colormap and hides the scene
  // footprint, whereas light gray says "outside the data" and frames the swath.
  // This is the SAR/InSAR figure convention (matplotlib set_bad, GMT, QGIS).
  background: '#e9e7e2',

  // Ink — text sits directly on the imagery, so it is pure BLACK with a WHITE
  // HALO (map-label casing). This is the highest-impact legibility choice: black
  // reads on light ground, the halo carries it over dark pixels too — the USGS /
  // Ordnance Survey / GMT convention. With halos there is no need for a muted
  // hierarchy; everything is black, size and weight carry the hierarchy instead.
  ink:        '#000000', // all text over imagery
  inkSoft:    '#000000', // (kept black — halo makes graying unnecessary)
  inkMuted:   '#000000',
  hairline:   '#1a1c22', // axes / colorbar frame — near-black hairline
  gridLine:   'rgba(0,0,0,0.10)', // subtle coordinate grid
  accent:     '#0f766e', // deep teal — scale bar, active marks (one accent only)

  // Text halo (label casing). halo=null disables it (dark preset). Modern soft
  // casing: thin-ish, round-joined, slightly translucent — reads like a Mapbox /
  // Apple-Maps label glow rather than a hard GIS sticker. Drawn UNDER the fill.
  halo:        'rgba(255,255,255,0.85)',
  haloWidthEm: 0.14,

  // Chrome geometry: OPEN, no boxes.
  panelFill:   null,  // null → draw no background box behind scale bar/colorbar/coords
  panelStroke: null,
  borderStyle: 'none', // no figure frame — modern figures breathe to the edge
  borderColor: '#2a2d35',
  radius: 0,           // square corners; no rounded pills

  // Type — modern grotesk for labels/titles, mono only for numerics
  fontLabel:   SANS,
  fontTitle:   TITLE,
  fontNumeric: MONO,

  // RGB legend swatches follow the display guns, tuned slightly warmer/deeper
  // than primary CSS colors so they sit on warm paper without vibrating.
  channelColors: { R: '#c8402f', G: '#2e9e4f', B: '#2668c4' },

  // Branding off by default in figures.
  branding: false,
});

// ── Dark (legacy app look) — for presentation/projector ─────────────────────
export const DARK_FIGURE = Object.freeze({
  id: 'dark',

  background: '#0a1628',

  ink:        '#e8edf5',
  inkSoft:    '#8fa4c4',
  inkMuted:   '#5a7099',
  hairline:   '#1e3a5f',
  gridLine:   'rgba(30, 58, 95, 0.20)',
  accent:     '#4ec9d4',

  // Dark preset uses subtle panels for legibility instead of halos.
  halo:       null,
  haloWidthEm: 0,

  // Dark keeps subtle panels so light chrome stays legible over bright imagery,
  // but drops the dashed border and heavy rounding for a cleaner read.
  panelFill:   'rgba(10, 22, 40, 0.72)',
  panelStroke: 'rgba(120, 150, 190, 0.28)',
  borderStyle: 'solid-thin',
  borderColor: '#1e3a5f',
  radius: 2,

  fontLabel:   SANS,
  fontTitle:   TITLE,
  fontNumeric: MONO,

  channelColors: { R: '#ff5c5c', G: '#3ddc84', B: '#4ea8ff' },

  branding: false,
});

const PRESETS = { publication: PUBLICATION, dark: DARK_FIGURE };

let _active = PUBLICATION;

/** Resolve a theme name (or object) to a style preset. Unknown → publication. */
export function resolveFigureStyle(theme) {
  if (theme && typeof theme === 'object' && theme.id) return theme;
  return PRESETS[theme] || PUBLICATION;
}

/** Set the active figure style for the current (synchronous) export call. */
export function setFigureStyle(theme) {
  _active = resolveFigureStyle(theme);
  return _active;
}

/** Read the active figure style. */
export function getFigureStyle() {
  return _active;
}

// ── Size-proportional scaling ────────────────────────────────────────────────
// Chrome (fonts, bars, pads) was tuned to read well on a ~900px-wide figure.
// The legacy scale factor was device-pixel-ratio only, so a 3200px full-res
// export drew the SAME absolute 13px labels — microscopic relative to the image.
// Instead, scale chrome by the figure's own size so text stays proportional at
// any export resolution.

// Chrome type is sized as a fixed FRACTION of the figure's short edge, so it
// reads correctly on full-screen / full-resolution exports (the common case)
// — not off a small nominal reference, which left labels tiny on big canvases.
//
// Target: the ~12px "body" chrome size should land at short-edge / BODY_DIVISOR.
// BODY_DIVISOR = 28 → body ≈ 3.6% of the short edge: comfortable, readable map
// labels on a full-screen export (e.g. 1080px-tall figure → ~39px body). The
// per-tier sizes (tick 12 · title 13 · branding 18 …) scale together from this,
// their ratios already close to a golden progression.
const BODY_NOMINAL = 12;   // the reference "body" px used throughout draw* helpers
const BODY_DIVISOR = 28;   // body text = shortEdge / 28  (~3.6% of short edge)

// Reference short-edge at which the nominal 12px renders 1:1.
const NOMINAL_SHORT_EDGE = BODY_NOMINAL * BODY_DIVISOR; // = 336

// Clamp so thumbnails keep legible chrome and enormous exports don't explode.
const MIN_FACTOR = 1.0;
const MAX_FACTOR = 10.0;

/**
 * Scale factor for figure chrome given the output canvas size (device px).
 * Multiply tuned pixel sizes by this so labels/bars track the figure.
 *
 * @param {number} W canvas width (device px)
 * @param {number} H canvas height (device px)
 * @returns {number}
 */
export function figureScale(W, H) {
  const shortEdge = Math.min(W || NOMINAL_SHORT_EDGE, H || NOMINAL_SHORT_EDGE);
  const f = shortEdge / NOMINAL_SHORT_EDGE;
  return Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, f));
}

/**
 * Build the chrome-scale function used throughout figure export. Replaces the
 * old `s = v => round(v * dpr)`: chrome now scales with FIGURE SIZE, not dpr.
 * (glCanvas dimensions already bake in dpr, so scaling by size covers it.)
 *
 * @param {number} W canvas width (device px)
 * @param {number} H canvas height (device px)
 * @returns {(v:number)=>number}
 */
export function makeScale(W, H) {
  const factor = figureScale(W, H);
  return (v) => Math.round(v * factor);
}
