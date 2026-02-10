/**
 * SARdine Design Tokens — Single source of truth.
 *
 * All theme values live here.  Consumers:
 *   - sardine-theme.css   (CSS custom properties mirror these)
 *   - geo-overlays.js     (canvas drawing)
 *   - figure-export.js    (PNG overlay rendering)
 *   - shaders.js          (GLSL vec3 constants)
 */

// ── Dark theme (default) ────────────────────────────────────────────────────

export const DARK = Object.freeze({
  bg:            '#0a1628',
  bgRaised:      '#0f1f38',
  bgPanel:       '#122240',
  bgHover:       '#1a2d50',
  border:        '#1e3a5f',
  borderSubtle:  '#162d4a',

  cyan:          '#4ec9d4',
  cyanDim:       '#2a8a93',
  orange:        '#e8833a',
  orangeDim:     '#b5642a',
  green:         '#3ddc84',
  greenDim:      '#2a9e5e',
  magenta:       '#d45cff',
  magentaDim:    '#9a3db8',

  textPrimary:   '#e8edf5',
  textSecondary: '#8fa4c4',
  textMuted:     '#5a7099',
  textDisabled:  '#3a5070',

  statusFlood:   '#ff5c5c',
  statusWater:   '#4ea8ff',
  statusDry:     '#c4a35a',
  statusSuccess: '#3ddc84',

  radiusSm: 2,
  radiusMd: 3,
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
  textMuted:     '#7a8599',
  textDisabled:  '#b0b8c4',

  statusFlood:   '#cc3333',
  statusWater:   '#2a7acc',
  statusDry:     '#9a8030',
  statusSuccess: '#1a8a4a',

  radiusSm: 2,
  radiusMd: 3,
});

// ── Semantic channel colors (polarization) ──────────────────────────────────

export const CHANNEL_COLORS = Object.freeze({
  R: DARK.magenta,
  G: DARK.green,
  B: DARK.cyan,
});

// ── Font stacks ─────────────────────────────────────────────────────────────

export const FONTS = Object.freeze({
  mono:    "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
  display: "'Space Grotesk', sans-serif",
  body:    "'IBM Plex Sans', sans-serif",
  serif:   "'IBM Plex Serif', Georgia, serif",
});

// ── Helper: get theme by name ───────────────────────────────────────────────

export function getTheme(name) {
  return name === 'light' ? LIGHT : DARK;
}
