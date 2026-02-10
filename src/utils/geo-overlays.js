/**
 * Shared geo-overlay utilities for both live viewer components and figure export.
 *
 * Key math:
 *   viewState.target = world-coordinate center [x, y]
 *   viewState.zoom → pixels-per-world-unit = 2^zoom
 *   px = worldUnits × 2^zoom
 *   Combined with canvas dimensions → full affine transform.
 */

import {
  DARK as _DARK,
  LIGHT as _LIGHT,
  CHANNEL_COLORS as _CH,
  FONTS,
  getTheme as _getTheme,
} from './theme-tokens.js';

// ── Theme tokens for canvas drawing (re-exported from theme-tokens.js) ──────

export const THEME = _DARK;
export const THEME_LIGHT = _LIGHT;
export const CHANNEL_COLORS = _CH;
export { FONTS, _getTheme as getTheme };

// ── Coordinate helpers ──────────────────────────────────────────────────────

/**
 * Determine whether bounds represent projected coordinates (meters) or
 * geographic coordinates (degrees).
 */
export function isProjectedBounds(bounds) {
  if (!bounds) return false;
  return Math.abs(bounds[0]) > 180 || Math.abs(bounds[2]) > 180;
}

/**
 * Compute the visible world-coordinate extent from the current viewState and
 * canvas pixel dimensions.
 *
 * @returns {{ minX, minY, maxX, maxY, width, height, pixelsPerUnit }}
 */
export function computeVisibleExtent(viewState, canvasW, canvasH) {
  const zoom = viewState.zoom || 0;
  const [cx, cy] = viewState.target || [0, 0];
  const ppu = Math.pow(2, zoom); // pixels per world-unit

  const halfW = (canvasW / 2) / ppu;
  const halfH = (canvasH / 2) / ppu;

  return {
    minX: cx - halfW,
    maxX: cx + halfW,
    minY: cy - halfH,
    maxY: cy + halfH,
    width:  halfW * 2,
    height: halfH * 2,
    pixelsPerUnit: ppu,
  };
}

/**
 * Pick a "nice" round interval (1, 2, or 5 × 10^n) so that ~targetCount
 * gridlines fit within `range`.
 */
export function niceInterval(range, targetCount = 5) {
  if (range <= 0 || !isFinite(range)) return 1;
  const rough = range / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;

  let nice;
  if (norm < 1.5)      nice = 1;
  else if (norm < 3.5) nice = 2;
  else if (norm < 7.5) nice = 5;
  else                 nice = 10;

  return nice * mag;
}

/**
 * Format a projected coordinate value with thin-space grouping.
 * e.g. 584200 → "584 200"
 */
function formatProjectedValue(v) {
  const abs = Math.abs(Math.round(v));
  // Insert thin-space every 3 digits from right
  const str = abs.toString();
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (i > 0 && (str.length - i) % 3 === 0) result += '\u2009'; // thin space
    result += str[i];
  }
  return v < 0 ? '−' + result : result;
}

/**
 * Format a coordinate for display.
 *
 * Projected: "584 200 E / 4 142 000 N" style
 * Geographic: "37.42°N / 122.08°W" style
 *
 * @param {number} value
 * @param {boolean} projected
 * @param {'x'|'y'} axis - 'x' for easting/longitude, 'y' for northing/latitude
 */
export function formatCoord(value, projected, axis) {
  if (projected) {
    const suffix = axis === 'x' ? ' E' : ' N';
    return formatProjectedValue(value) + suffix;
  }
  // Geographic
  const abs = Math.abs(value);
  const dir = axis === 'x'
    ? (value >= 0 ? 'E' : 'W')
    : (value >= 0 ? 'N' : 'S');
  return abs.toFixed(2) + '°' + dir;
}

/**
 * Format a coordinate for a tick label (shorter, no direction suffix).
 */
export function formatTickValue(value, projected) {
  if (projected) {
    return formatProjectedValue(value);
  }
  return value.toFixed(2) + '°';
}

/**
 * Compute extent dimensions in human-readable form.
 * @returns {string} e.g. "12.4 × 8.7 km" or "0.34° × 0.22°"
 */
export function formatExtent(width, height, projected) {
  if (projected) {
    if (width >= 1000 || height >= 1000) {
      return `${(width / 1000).toFixed(1)} × ${(height / 1000).toFixed(1)} km`;
    }
    return `${width.toFixed(0)} × ${height.toFixed(0)} m`;
  }
  return `${width.toFixed(2)}° × ${height.toFixed(2)}°`;
}

// ── Scale bar helpers ───────────────────────────────────────────────────────

/**
 * Compute scale bar dimensions and label for a given pixelsPerUnit and
 * target pixel width.
 */
export function computeScaleBar(pixelsPerUnit, targetPixels = 150) {
  const targetUnits = targetPixels / pixelsPerUnit;
  const interval = niceInterval(targetUnits, 1.5);
  const barPixels = interval * pixelsPerUnit;

  let label;
  if (interval >= 1000) {
    label = `${(interval / 1000).toFixed(interval >= 10000 ? 0 : 1)} km`;
  } else if (interval >= 1) {
    label = `${interval.toFixed(interval >= 100 ? 0 : interval >= 10 ? 0 : 1)} m`;
  } else {
    label = `${interval.toFixed(2)} m`;
  }

  return { barPixels, label, meters: interval };
}

// ── Canvas drawing helpers ──────────────────────────────────────────────────

/**
 * Draw a rounded rectangle path (does NOT fill or stroke — caller does).
 */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Convert world coordinates → canvas pixel coordinates.
 */
export function worldToPixel(wx, wy, viewState, canvasW, canvasH) {
  const ppu = Math.pow(2, viewState.zoom || 0);
  const [cx, cy] = viewState.target || [0, 0];
  const px = (wx - cx) * ppu + canvasW / 2;
  const py = (wy - cy) * ppu + canvasH / 2;
  return [px, py];
}
