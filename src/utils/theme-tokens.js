/**
 * SARdine Design Tokens — the JS mirror of the CSS token layer.
 *
 * AUTHORITY DIRECTION:  src/theme/sardine-theme.css  →  this file.
 *   The CSS is the source of truth.  This module exists so canvas/GLSL
 *   consumers (which cannot read custom properties) get the same values.
 *   When a token changes, change the CSS first and follow here — never the
 *   reverse.  `test/unit/theme-mirror.test.mjs` fails on drift in either
 *   direction, using CSS_VAR_MAP below to pair keys with CSS properties.
 *
 * Consumers:
 *   - geo-overlays.js     (canvas drawing)
 *   - annotation-render.js (canvas drawing)
 *   - shaders.js          (GLSL vec3 constants)
 */

// ── Dark theme (default) ────────────────────────────────────────────────────

export const DARK = Object.freeze({
  bg:            '#1a1917',
  bgRaised:      '#282523',
  bgPanel:       '#211f1d',
  bgHover:       '#302d2a',
  border:        '#35312d',
  borderSubtle:  '#2a2724',

  cyan:          '#4ec9d4',
  cyanDim:       '#2a8a93',
  orange:        '#e8833a',
  orangeDim:     '#b5642a',
  green:         '#3ddc84',
  greenDim:      '#2a9e5e',
  magenta:       '#d45cff',
  magentaDim:    '#9a3db8',

  // Ink ramp.  `textDisabled` maps to --ink-faint, which is below AA by design
  // and is for non-text use only (rules, disabled fills).
  textPrimary:   '#ede9e3',
  textSecondary: '#b8b0a6',
  textMuted:     '#9c9389',
  textDisabled:  '#6b625a',

  statusFlood:   '#ff5c5c',
  statusWater:   '#4ea8ff',
  statusDry:     '#c4a35a',
  statusSuccess: '#3ddc84',

  radiusSm: 2,
  radiusMd: 3,
  radiusLg: 4,
});

// ── Light theme ─────────────────────────────────────────────────────────────

export const LIGHT = Object.freeze({
  bg:            '#f5f3ef',
  bgRaised:      '#ffffff',
  bgPanel:       '#faf9f6',
  bgHover:       '#edeae4',
  border:        '#d4cdb8',
  borderSubtle:  '#e2ddd0',

  cyan:          '#0e8a96',
  cyanDim:       '#0a6e78',
  orange:        '#c96a25',
  orangeDim:     '#a0541d',
  green:         '#1a8a4a',
  greenDim:      '#146b3a',
  magenta:       '#9b3dbb',
  magentaDim:    '#7a2f94',

  textPrimary:   '#1a2233',
  textSecondary: '#4a5568',
  textMuted:     '#6b7688',
  textDisabled:  '#b0b8c4',

  statusFlood:   '#cc3333',
  statusWater:   '#2a7acc',
  statusDry:     '#9a8030',
  statusSuccess: '#1a8a4a',

  radiusSm: 2,
  radiusMd: 3,
  radiusLg: 4,
});

/**
 * Key → CSS custom property.  The mirror test resolves each property out of
 * the stylesheet (following `var()` aliases) and compares it to the value
 * above.  A key absent here is not mirrored and must be justified.
 */
export const CSS_VAR_MAP = Object.freeze({
  bg:            '--sardine-bg',
  bgRaised:      '--sardine-bg-raised',
  bgPanel:       '--sardine-bg-panel',
  bgHover:       '--sardine-bg-hover',
  border:        '--sardine-border',
  borderSubtle:  '--sardine-border-subtle',

  cyan:          '--sardine-cyan',
  cyanDim:       '--sardine-cyan-dim',
  orange:        '--sardine-orange',
  orangeDim:     '--sardine-orange-dim',
  green:         '--sardine-green',
  greenDim:      '--sardine-green-dim',
  magenta:       '--sardine-magenta',
  magentaDim:    '--sardine-magenta-dim',

  textPrimary:   '--ink',
  textSecondary: '--ink-soft',
  textMuted:     '--ink-muted',
  textDisabled:  '--ink-faint',

  statusFlood:   '--status-flood',
  statusWater:   '--status-water',
  statusDry:     '--status-dry',
  statusSuccess: '--status-success',

  radiusSm:      '--radius-sm',
  radiusMd:      '--radius-md',
  radiusLg:      '--radius-lg',
});

// ── Overlay ink (drawn OVER imagery) ────────────────────────────────────────
/**
 * No flat colour is legible across the grey range SAR imagery occupies — cyan
 * scores 8.31:1 on panel but 2.00:1 on mid-grey, and even white and black
 * bottom out at 1.00:1 somewhere in the range.  So overlays never pick a
 * colour: they draw ink on a contrasting halo, and the pair carries contrast.
 * Chrome accents stay on chrome surfaces.
 */
export const OVERLAY = Object.freeze({
  ink:  '#ffffff',
  halo: 'rgba(0, 0, 0, 0.72)',
});

// ── Type scale (rem; px sizes ignore the user's font-size preference) ───────

export const TEXT = Object.freeze({
  xs:   '0.6875rem',  // 11px — dense numerics, table cells
  sm:   '0.75rem',    // 12px — default UI (the workhorse)
  md:   '0.875rem',   // 14px — body, panel copy
  lg:   '1rem',       // 16px — section titles
  xl:   '1.25rem',    // 20px — panel/dialog titles
  '2xl': '1.5rem',    // 24px — app title, empty-state headline
});

// ── Spacing scale (px) ──────────────────────────────────────────────────────

export const SPACE = Object.freeze({
  '3xs': 2, '2xs': 4, xs: 6, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48,
});

// ── Z scale ─────────────────────────────────────────────────────────────────

export const Z = Object.freeze({
  base: 0, overlay: 100, panel: 200, sheet: 300,
  dropdown: 400, modal: 500, toast: 600, dragdrop: 700,
});

// ── Semantic channel colors (polarization) ──────────────────────────────────

export const CHANNEL_COLORS = Object.freeze({
  R: DARK.magenta,
  G: DARK.green,
  B: DARK.cyan,
});

/** `#rrggbb` + alpha → `rgba(r, g, b, a)`.  Canvas needs literals, not var(). */
export function withAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? parseInt(h.split('').map(c => c + c).join(''), 16)
    : parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Canvas fill/stroke/legend triples for the R/G/B channels plus the
 * single-band case.  Canvas 2D cannot resolve `var(--…)`, so the literals
 * are DERIVED from the tokens above rather than re-picked by hand — which is
 * what HistogramOverlay used to do, shadowing this export with a completely
 * different palette (#e74c3c/#2ecc71/#3498db).  One source, three uses.
 */
export const CHANNEL_PLOT_COLORS = Object.freeze({
  R:      { fill: withAlpha(CHANNEL_COLORS.R, 0.45), stroke: withAlpha(CHANNEL_COLORS.R, 0.9),  legend: CHANNEL_COLORS.R },
  G:      { fill: withAlpha(CHANNEL_COLORS.G, 0.40), stroke: withAlpha(CHANNEL_COLORS.G, 0.85), legend: CHANNEL_COLORS.G },
  B:      { fill: withAlpha(CHANNEL_COLORS.B, 0.40), stroke: withAlpha(CHANNEL_COLORS.B, 0.85), legend: CHANNEL_COLORS.B },
  single: { fill: withAlpha(DARK.cyan, 0.35),        stroke: withAlpha(DARK.cyan, 0.85),        legend: DARK.cyan },
});

// ── Font stacks ─────────────────────────────────────────────────────────────

export const FONTS = Object.freeze({
  mono:    "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  display: "'Space Grotesk', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  body:    "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  serif:   "'IBM Plex Serif', Georgia, 'Times New Roman', serif",
});

export const FONT_VAR_MAP = Object.freeze({
  mono: '--font-mono', display: '--font-display', body: '--font-body', serif: '--font-serif',
});

// ── Helper: get theme by name ───────────────────────────────────────────────

export function getTheme(name) {
  return name === 'light' ? LIGHT : DARK;
}
