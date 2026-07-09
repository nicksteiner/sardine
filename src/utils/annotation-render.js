/**
 * Shared annotation rendering — used by both the live AnnotationOverlay
 * (interactive HTML canvas on top of deck.gl) and the figure-export pipeline,
 * so on-screen and exported PNGs look identical.
 *
 * Coordinates passed to these functions are screen pixels (already converted
 * from world coords by the caller via worldToPixel).
 */

import { THEME } from './geo-overlays.js';
import { FONTS } from './theme-tokens.js';

const FONT_MONO = FONTS.mono;

/**
 * Markup / annotation palette.
 *
 * A professional, publication-oriented accent set chosen to stay legible on
 * both dark SAR imagery and light figure-export backgrounds. Slightly
 * desaturated relative to the UI theme accents so lines/labels read as
 * deliberate markup rather than glowing screen colors.
 *
 * Legacy keys (cyan / magenta) are kept as aliases so previously-saved
 * annotations still resolve to a sensible color.
 */
export const ANNOTATION_COLORS = Object.freeze({
  red:    '#e5484d',
  amber:  '#f5a524',
  yellow: '#f2d94e',
  green:  '#30a46c',
  blue:   '#4593e8',
  white:  '#f0f2f5',
  // ── legacy aliases (older annotations reference these) ──
  cyan:    THEME.cyan,
  orange:  '#f5a524',   // → amber
  magenta: '#d45cff',
});

/** Order shown in the color picker (professional set only). */
export const ANNOTATION_COLOR_KEYS = Object.freeze(['red', 'amber', 'yellow', 'green', 'blue', 'white']);

/**
 * Standardized size presets — a small, fixed menu (medical-imaging style)
 * rather than free-form sliders. Each preset scales line weight, arrowhead,
 * and font together so annotations stay legible at figure/publication scale.
 *
 *   lineW    — arrow shaft / label border stroke width (screen px @ dpr 1)
 *   headLen  — arrowhead length
 *   headW    — arrowhead half-width
 *   fontSize — caption / label text size
 */
export const ANNOTATION_SIZES = Object.freeze({
  small:  { lineW: 2,   headLen: 12, headW: 7,  fontSize: 13 },
  medium: { lineW: 3.5, headLen: 18, headW: 11, fontSize: 18 },
  large:  { lineW: 5,   headLen: 26, headW: 16, fontSize: 26 },
});

export const ANNOTATION_SIZE_KEYS = Object.freeze(['small', 'medium', 'large']);

/** Default preset for new annotations — errs large so lines/text read clearly. */
export const DEFAULT_ANNOTATION_SIZE = 'medium';

export function resolveSize(key) {
  return ANNOTATION_SIZES[key] || ANNOTATION_SIZES[DEFAULT_ANNOTATION_SIZE];
}

export function resolveColor(key) {
  return ANNOTATION_COLORS[key] || ANNOTATION_COLORS.cyan;
}

/**
 * Draw a filled arrow with optional caption near the head.
 * Tail at (x1,y1), head at (x2,y2).
 */
export function drawArrow(ctx, x1, y1, x2, y2, opts = {}) {
  const { colorKey = 'cyan', caption = '', dpr = 1, size = DEFAULT_ANNOTATION_SIZE, selected = false } = opts;
  const color = resolveColor(colorKey);
  const sz = resolveSize(size);
  // fontSize may be overridden explicitly (legacy annotations), else from preset
  const fontSize = opts.fontSize || sz.fontSize;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const lineW = Math.max(1.5, sz.lineW * dpr);
  const headLen = Math.max(10, sz.headLen * dpr);
  const headW = Math.max(6, sz.headW * dpr);

  // Shorten the line so the stroked end doesn't poke past the filled triangle
  const ux = dx / len;
  const uy = dy / len;
  const sx = x2 - ux * headLen * 0.7;
  const sy = y2 - uy * headLen * 0.7;

  ctx.save();

  // Selection halo
  if (selected) {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = lineW + 4 * dpr;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  // Shaft
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(sx, sy);
  ctx.stroke();

  // Filled arrowhead
  const px = -uy;
  const py = ux;
  const baseX = x2 - ux * headLen;
  const baseY = y2 - uy * headLen;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(baseX + px * headW, baseY + py * headW);
  ctx.lineTo(baseX - px * headW, baseY - py * headW);
  ctx.closePath();
  ctx.fill();

  // Caption near the tail (so head stays clean over the feature)
  if (caption) {
    const fs = Math.round(fontSize * dpr);
    ctx.font = `${fs}px ${FONT_MONO}`;
    const padX = 6 * dpr;
    const padY = 3 * dpr;
    const w = ctx.measureText(caption).width + padX * 2;
    const h = fs + padY * 2;
    // Anchor caption at the tail, offset slightly perpendicular to the arrow
    const ax = x1 - ux * (8 * dpr) + px * (8 * dpr) - w / 2;
    const ay = y1 - uy * (8 * dpr) + py * (8 * dpr) - h / 2;

    ctx.fillStyle = 'rgba(10, 22, 40, 0.85)';
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, sz.lineW * 0.5) * dpr;
    roundRect(ctx, ax, ay, w, h, 3 * dpr);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(caption, ax + w / 2, ay + h / 2);
  }

  ctx.restore();
}

/**
 * Draw a free-text label pill anchored at (x,y) (top-left of the pill).
 */
export function drawTextLabel(ctx, x, y, text, opts = {}) {
  const { colorKey = 'cyan', dpr = 1, size = DEFAULT_ANNOTATION_SIZE, selected = false } = opts;
  if (!text) return;
  const color = resolveColor(colorKey);
  const sz = resolveSize(size);
  const fontSize = opts.fontSize || sz.fontSize;

  const fs = Math.round(fontSize * dpr);
  ctx.save();
  ctx.font = `${fs}px ${FONT_MONO}`;
  const padX = 8 * dpr;
  const padY = 5 * dpr;
  const w = ctx.measureText(text).width + padX * 2;
  const h = fs + padY * 2;

  if (selected) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, x - 2 * dpr, y - 2 * dpr, w + 4 * dpr, h + 4 * dpr, 5 * dpr);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(10, 22, 40, 0.88)';
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.25, sz.lineW * 0.6) * dpr;
  roundRect(ctx, x, y, w, h, 4 * dpr);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2);
  ctx.restore();
}

/** Bounding box for a text label in screen pixels (for hit testing). */
export function measureTextLabel(ctx, text, fontSize, dpr = 1) {
  const fs = Math.round((fontSize || resolveSize(DEFAULT_ANNOTATION_SIZE).fontSize) * dpr);
  ctx.save();
  ctx.font = `${fs}px ${FONT_MONO}`;
  const padX = 8 * dpr;
  const padY = 5 * dpr;
  const w = ctx.measureText(text || '').width + padX * 2;
  const h = fs + padY * 2;
  ctx.restore();
  return { w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}
