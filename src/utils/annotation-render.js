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

export const ANNOTATION_COLORS = Object.freeze({
  cyan:    THEME.cyan,
  orange:  THEME.orange,
  green:   THEME.green,
  magenta: THEME.magenta,
});

export const ANNOTATION_COLOR_KEYS = Object.freeze(['cyan', 'orange', 'green', 'magenta']);

export function resolveColor(key) {
  return ANNOTATION_COLORS[key] || ANNOTATION_COLORS.cyan;
}

/**
 * Draw a filled arrow with optional caption near the head.
 * Tail at (x1,y1), head at (x2,y2).
 */
export function drawArrow(ctx, x1, y1, x2, y2, opts = {}) {
  const { colorKey = 'cyan', caption = '', dpr = 1, fontSize = 12, selected = false } = opts;
  const color = resolveColor(colorKey);

  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const lineW = Math.max(1.5, 2 * dpr);
  const headLen = Math.max(10, 12 * dpr);
  const headW = Math.max(6, 7 * dpr);

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
    ctx.lineWidth = 1 * dpr;
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
  const { colorKey = 'cyan', dpr = 1, fontSize = 13, selected = false } = opts;
  if (!text) return;
  const color = resolveColor(colorKey);

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
  ctx.lineWidth = 1.25 * dpr;
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
  const fs = Math.round(fontSize * dpr);
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
