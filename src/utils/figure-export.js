/**
 * Figure export utility for SAR imagery.
 * Captures the deck.gl canvas and composites themed overlays onto a 2D canvas
 * for PNG export.
 *
 * Overlays:
 *   1. 2px figure border (--sardine-border)
 *   2. Coordinate grid with tick labels
 *   3. Corner coordinate pills
 *   4. Scale bar (--sardine-cyan bar, panel pill background)
 *   5. RGB legend with semantic polarization colors  OR  colormap bar
 *   6. Metadata panel with label:value pairs and semantic colors
 *   7. SARdine branding badge (top-left)
 */

import { getColormap } from './colormap.js';
import { SVGRecorder, svgToBlob } from './svg-recorder.js';
import { setFigureStyle, getFigureStyle, makeScale } from './figure-style.js';
import { createStretchFn } from './stretch.js';
import { SAR_COMPOSITES, COLORBLIND_MATRICES } from './sar-composites.js';
import { drawHistogramCanvas } from '../components/HistogramOverlay.jsx';
import { drawArrow as drawAnnArrow, drawTextLabel as drawAnnText } from './annotation-render.js';
import {
  THEME,
  CHANNEL_COLORS,
  isProjectedBounds,
  computeVisibleExtent,
  niceInterval,
  formatTickValue,
  formatCoord,
  formatExtent,
  computeScaleBar,
  roundRect,
} from './geo-overlays.js';

// ── Font helpers ────────────────────────────────────────────────────────────

import { FONTS } from './theme-tokens.js';

const FONT_MONO  = FONTS.mono;
const FONT_SERIF = FONTS.serif;

// ── Attribution (CSDA + vendor copyright) ───────────────────────────────────

const VENDORS = {
  iceye:      { label: 'ICEYE',         holder: 'ICEYE US, Inc.',            csda: true,  patterns: [/iceye/i] },
  capella:    { label: 'Capella',       holder: 'Capella Space Corporation', csda: true,  patterns: [/capella/i, /^cap[a-z0-9_-]*\.tif/i] },
  umbra:      { label: 'Umbra',         holder: 'Umbra Lab Inc.',            csda: true,  patterns: [/umbra/i] },
  nisar:      { label: 'NISAR',         holder: 'NASA / ISRO NISAR Mission', csda: false, patterns: [/nisar/i, /\bgcov\b/i, /\bgunw\b/i] },
  sentinel1:  { label: 'Sentinel-1',    holder: 'Contains modified Copernicus Sentinel-1 data', csda: false, patterns: [/^s1[ab]_/i, /sentinel[-_ ]?1/i] },
  alos:       { label: 'ALOS PALSAR',   holder: 'JAXA ALOS PALSAR',          csda: false, patterns: [/\balos\b/i, /palsar/i] },
};

export const VENDOR_OPTIONS = Object.freeze(
  Object.entries(VENDORS).map(([key, v]) => ({ key, label: v.label }))
);

const CSDA_ACK = 'Data via NASA Commercial Smallsat Data Acquisition (CSDA) program';
export const DEFAULT_PROCESSOR = 'Nick Steiner (CCNY/CUNY)';

/**
 * Detect vendor from a filename or URL. Returns key in VENDORS, or null.
 */
export function detectVendor(filenameOrUrl) {
  if (!filenameOrUrl) return null;
  const name = String(filenameOrUrl).split('/').pop() || '';
  for (const [key, { patterns }] of Object.entries(VENDORS)) {
    if (patterns.some((re) => re.test(name))) return key;
  }
  return null;
}

/**
 * Build the standardized attribution string.
 *
 * Format: "© {Vendor}, {YYYY}. All Rights Reserved · {CSDA ack if applicable} · Processed by {name}"
 *
 * Processor always defaults to Nick Steiner if not provided. If vendor is unknown,
 * the vendor copyright clause is omitted but processor is still stamped.
 */
export function buildAttribution({ vendor, year, processor } = {}) {
  const yr = year || new Date().getUTCFullYear();
  const v = VENDORS[vendor];
  const parts = [];
  if (v) {
    parts.push(`© ${v.holder}, ${yr}. All Rights Reserved`);
    if (v.csda) parts.push(CSDA_ACK);
  }
  parts.push(`Processed by ${processor || DEFAULT_PROCESSOR}`);
  return parts.join(' · ');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Capture the current viewer and export as a PNG figure with overlays.
 *
 * @param {HTMLCanvasElement} glCanvas - The deck.gl WebGL canvas element
 * @param {Object} options
 * @param {string}   [options.colormap]        - Colormap name (single-band)
 * @param {number[]|Object} [options.contrastLimits] - [min,max] or {R,G,B}
 * @param {boolean}  [options.useDecibels]
 * @param {string}   [options.compositeId]     - RGB composite ID or null
 * @param {Object}   [options.viewState]       - Current deck.gl view state
 * @param {number[]} [options.bounds]          - [minX,minY,maxX,maxY]
 * @param {string}   [options.filename]        - Source filename
 * @param {string}   [options.crs]             - CRS string (e.g. "EPSG:32610")
 * @param {Object}   [options.histogramData]   - Histogram stats to render as inset
 * @param {string}   [options.polarization]    - Polarization label for histogram title
 * @returns {Promise<Blob>} PNG blob
 */
/**
 * Build a render target for either PNG or SVG output. Both branches expose the
 * same Canvas2D surface (`ctx`), so the figure draw* helpers are written once
 * and run against whichever target the caller asks for.
 *
 *   - 'png' → offscreen <canvas> 2D context; finish() → PNG Blob
 *   - 'svg' → SVGRecorder; finish() → SVG Blob with editable vector chrome and
 *             the SAR base image + raster insets embedded as <image> layers
 *
 * @param {number} W device-pixel width
 * @param {number} H device-pixel height
 * @param {'png'|'svg'} format
 * @param {object} [opts]
 * @param {string} [opts.background] background fill (SVG only; canvas is transparent by default)
 * @returns {{ ctx: (CanvasRenderingContext2D|SVGRecorder), finish: () => Promise<Blob> }}
 */
function makeTarget(W, H, format, { background = null } = {}) {
  if (format === 'svg') {
    const rec = new SVGRecorder(W, H);
    const S = getFigureStyle();
    rec.halo = S.halo || null;
    rec.haloWidthEm = S.haloWidthEm || 0;
    return {
      ctx: rec,
      finish: async () => svgToBlob(rec.toSVG({ background })),
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  installHaloText(ctx);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); }
  return {
    ctx,
    finish: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
  };
}

/**
 * Wrap a Canvas 2D context's fillText so every text draw gets a map-label halo
 * (white casing) when the active figure style defines one. Drawing the halo as
 * a stroke UNDER the fill — with round joins — matches the SVG paint-order path
 * and the modern soft-casing look. No-op when the style has no halo (dark).
 * Applied once per context so all draw* helpers get halos for free.
 */
function installHaloText(ctx) {
  const rawFill = ctx.fillText.bind(ctx);
  ctx.fillText = function (text, x, y, maxWidth) {
    const S = getFigureStyle();
    if (S.halo && S.haloWidthEm > 0) {
      // Font size from the current ctx.font (e.g. "600 15px 'Space Grotesk'").
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const size = m ? parseFloat(m[1]) : 12;
      // A translucent halo must composite the WHOLE stroke at its alpha via
      // globalAlpha — NOT bake the alpha into strokeStyle. strokeText overlaps
      // itself on curves and between glyphs; a per-pixel-transparent stroke then
      // accumulates and darkens at those overlaps (uneven, "broken" halo). Using
      // an OPAQUE stroke under a layer-wide globalAlpha makes it composite once.
      const { rgb, alpha } = splitCss(S.halo);
      const prevStroke = this.strokeStyle, prevWidth = this.lineWidth,
            prevJoin = this.lineJoin, prevMiter = this.miterLimit,
            prevAlpha = this.globalAlpha;
      this.globalAlpha = prevAlpha * alpha;
      this.strokeStyle = rgb;                                  // opaque
      this.lineWidth = Math.max(1, size * S.haloWidthEm * 2);  // *2: straddles the glyph edge
      this.lineJoin = 'round';
      this.miterLimit = 2;
      if (maxWidth != null) this.strokeText(text, x, y, maxWidth);
      else this.strokeText(text, x, y);
      this.globalAlpha = prevAlpha;
      this.strokeStyle = prevStroke; this.lineWidth = prevWidth;
      this.lineJoin = prevJoin; this.miterLimit = prevMiter;
    }
    if (maxWidth != null) rawFill(text, x, y, maxWidth);
    else rawFill(text, x, y);
  };
}

/** Split a css color into an opaque rgb string + separate alpha [0..1]. */
function splitCss(css) {
  const s = String(css).trim();
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((v) => v.trim());
    const a = p.length > 3 ? parseFloat(p[3]) : 1;
    return { rgb: `rgb(${p[0]},${p[1]},${p[2]})`, alpha: isFinite(a) ? a : 1 };
  }
  return { rgb: s, alpha: 1 };
}

export async function exportFigure(glCanvas, options = {}) {
  const {
    colormap = 'grayscale',
    contrastLimits,
    useDecibels = true,
    compositeId = null,
    viewState,
    bounds,
    filename = '',
    crs = '',
    histogramData = null,
    polarization = '',
    identification = null,
    colorblindMode = 'off',
    wgs84Bounds = null,
    attribution = null,
    annotations = [],
    classMode = false,
    classPalette = null,
    classNames = null,
    classLegend = null,
    format = 'png',
    theme = 'publication',
  } = options;

  const S = setFigureStyle(theme);
  const W = glCanvas.width;
  const H = glCanvas.height;

  // Target is either a real 2D context (PNG) or an SVGRecorder (SVG). Both
  // implement the same Canvas2D surface, so every draw* helper below is shared.
  const { ctx, finish } = makeTarget(W, H, format, { background: S.background });

  // Draw the WebGL canvas content (embedded as <image> in the SVG path)
  ctx.drawImage(glCanvas, 0, 0);

  // Chrome scales with FIGURE SIZE (not dpr) so labels/bars stay proportional
  // at any export resolution. dpr is still used for sub-canvas overlays that do
  // their own logical-pixel math (annotations, histogram/location insets).
  const dpr = window.devicePixelRatio || 1;
  const s = makeScale(W, H);

  // 0. User annotations (drawn on top of SAR pixels, below chrome)
  drawAnnotations(ctx, W, H, annotations, viewState, dpr);

  const projected = isProjectedBounds(bounds, crs || null);

  // 1. Figure border
  drawBorder(ctx, W, H, s);

  // 2. Coordinate grid + tick labels
  drawCoordinateGrid(ctx, W, H, viewState, bounds, projected, s);

  // 3. Corner coordinates
  drawCornerCoordinates(ctx, W, H, viewState, projected, s);

  // 4. Scale bar (bottom-left)
  drawScaleBar(ctx, W, H, viewState, bounds, projected, s);

  // 5. Legend (top-right)
  if (classMode) {
    drawClassLegend(ctx, W, H, { classPalette, classNames, classLegend }, s);
  } else if (compositeId) {
    drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, s, colorblindMode);
  } else {
    drawColormapBar(ctx, W, H, colormap, contrastLimits, useDecibels, s);
  }

  // 6. Metadata panel (bottom-right)
  // Metadata box (SOURCE/CRS/SCALE/…) intentionally omitted from exports — it
  // clutters the figure. Provenance lives in the {output}.tif.json sidecar.

  // 7. SARdine branding (top-left)
  drawBranding(ctx, W, H, s);

  // 8. Histogram inset (top-left, below branding)
  if (histogramData) {
    drawHistogramInset(ctx, W, H, {
      histogramData, compositeId, contrastLimits, useDecibels, polarization,
    }, dpr);
  }

  // 9. Location inset — Bing VirtualEarth satellite thumbnail (bottom-left)
  await drawLocationInset(ctx, W, H, wgs84Bounds, projected, dpr);

  // 10. Attribution strip (bottom edge, drawn last to sit on top)
  drawAttributionStrip(ctx, W, H, attribution, s);

  return finish();
}

/**
 * Capture the viewer and draw data overlays (ROI, profiles, histogram, pixel
 * explorer) directly on the export canvas using Canvas 2D API, then add the
 * standard SARdine figure decorations.
 *
 * @param {HTMLCanvasElement} glCanvas - The deck.gl WebGL canvas
 * @param {Object} options - Same as exportFigure options plus overlay data
 * @param {Object}  [options.roi]         - {left,top,width,height} in image px
 * @param {Object}  [options.profileData] - {rowMeans,colMeans,hist,...}
 * @param {Object}  [options.profileShow] - {v:bool, h:bool, i:bool}
 * @param {number}  [options.imageWidth]
 * @param {number}  [options.imageHeight]
 * @returns {Promise<Blob>} PNG blob
 */
export async function exportFigureWithOverlays(glCanvas, options = {}) {
  const {
    colormap = 'grayscale',
    contrastLimits,
    useDecibels = true,
    compositeId = null,
    viewState,
    bounds,
    filename = '',
    crs = '',
    roi = null,
    profileData = null,
    profileShow = { v: true, h: true, i: true },
    imageWidth = 0,
    imageHeight = 0,
    histogramData = null,
    polarization = '',
    identification = null,
    classificationMap = null,
    classRegions = [],
    classifierRoiDims = null,
    colorblindMode = 'off',
    wgs84Bounds = null,
    attribution = null,
    annotations = [],
    classMode = false,
    classPalette = null,
    classNames = null,
    classLegend = null,
    format = 'png',
    theme = 'publication',
  } = options;

  const S = setFigureStyle(theme);
  const W = glCanvas.width;
  const H = glCanvas.height;
  const dpr = window.devicePixelRatio || 1;

  const { ctx, finish } = makeTarget(W, H, format, { background: S.background });

  // 1. Draw the WebGL canvas content (base layer; embedded as <image> for SVG)
  ctx.drawImage(glCanvas, 0, 0);

  // 1.5 User annotations (above SAR pixels, below ROI/profile/chrome)
  drawAnnotations(ctx, W, H, annotations, viewState, dpr);

  // 2. Draw data overlays directly on canvas
  if (classificationMap && classifierRoiDims && classRegions?.length && roi && bounds && imageWidth && imageHeight && viewState) {
    drawClassificationOverlay(ctx, W, H, roi, viewState, bounds, imageWidth, imageHeight, classificationMap, classRegions, classifierRoiDims);
  }

  if (roi && bounds && imageWidth && imageHeight && viewState) {
    drawROIOverlay(ctx, W, H, roi, viewState, bounds, imageWidth, imageHeight, dpr);
  }

  if (profileData && roi && bounds && imageWidth && imageHeight && viewState) {
    drawProfileOverlays(ctx, W, H, roi, profileData, profileShow, viewState, bounds, imageWidth, imageHeight, useDecibels, dpr);
  }

  // 3. Draw the standard figure overlays (chrome scales with figure size)
  const s = makeScale(W, H);
  const projected = isProjectedBounds(bounds, crs || null);

  drawBorder(ctx, W, H, s);
  drawCoordinateGrid(ctx, W, H, viewState, bounds, projected, s);
  drawCornerCoordinates(ctx, W, H, viewState, projected, s);
  drawScaleBar(ctx, W, H, viewState, bounds, projected, s);

  if (classMode) {
    drawClassLegend(ctx, W, H, { classPalette, classNames, classLegend }, s);
  } else if (compositeId) {
    drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, s, colorblindMode);
  } else {
    drawColormapBar(ctx, W, H, colormap, contrastLimits, useDecibels, s);
  }

  // Metadata box (SOURCE/CRS/SCALE/…) intentionally omitted from exports — it
  // clutters the figure. Provenance lives in the {output}.tif.json sidecar.
  drawBranding(ctx, W, H, s);

  // Histogram inset (top-left, below branding)
  if (histogramData) {
    drawHistogramInset(ctx, W, H, {
      histogramData, compositeId, contrastLimits, useDecibels, polarization,
    }, dpr);
  }

  // Location inset — Bing VirtualEarth satellite thumbnail (bottom-left)
  await drawLocationInset(ctx, W, H, wgs84Bounds, projected, dpr);

  // Attribution strip (bottom edge, drawn last)
  drawAttributionStrip(ctx, W, H, attribution, s);

  return finish();
}

// ── Overlay drawing helpers (Canvas 2D, not SVG) ────────────────────────────

import { worldToPixel } from './geo-overlays.js';

function _imgToScreen(imgX, imgY, viewState, bounds, imageWidth, imageHeight, W, H) {
  const [minX, minY, maxX, maxY] = bounds;
  const wx = minX + (imgX / imageWidth) * (maxX - minX);
  // Y is flipped: image row 0 → world maxY (top), row H → world minY (bottom)
  const wy = maxY - (imgY / imageHeight) * (maxY - minY);
  return worldToPixel(wx, wy, viewState, W, H);
}

/** Draw classification overlay on the export canvas (mirrors ClassificationOverlay.jsx). */
function drawClassificationOverlay(ctx, W, H, roi, viewState, bounds, imageWidth, imageHeight, classificationMap, classRegions, roiDims) {
  const { w, h } = roiDims;
  if (w <= 0 || h <= 0) return;

  // Build RGBA ImageData from classificationMap + class colors
  const rgba = new Uint8ClampedArray(w * h * 4);
  const colorLUT = classRegions.map(r => {
    const hex = r.color.replace('#', '');
    return [
      parseInt(hex.substring(0, 2), 16),
      parseInt(hex.substring(2, 4), 16),
      parseInt(hex.substring(4, 6), 16),
    ];
  });

  for (let i = 0; i < classificationMap.length; i++) {
    const cls = classificationMap[i];
    if (cls === 0 || cls > colorLUT.length) continue;
    const [r, g, b] = colorLUT[cls - 1];
    const idx = i * 4;
    rgba[idx]     = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = 200;
  }

  const classImage = new ImageData(rgba, w, h);
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = w;
  tmpCanvas.height = h;
  tmpCanvas.getContext('2d').putImageData(classImage, 0, 0);

  const [sx0, sy0] = _imgToScreen(roi.left, roi.top, viewState, bounds, imageWidth, imageHeight, W, H);
  const [sx1, sy1] = _imgToScreen(roi.left + roi.width, roi.top + roi.height, viewState, bounds, imageWidth, imageHeight, W, H);
  const rx = Math.min(sx0, sx1);
  const ry = Math.min(sy0, sy1);
  const rw = Math.abs(sx1 - sx0);
  const rh = Math.abs(sy1 - sy0);

  if (rw < 2 || rh < 2) return;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmpCanvas, rx, ry, rw, rh);
  ctx.imageSmoothingEnabled = true;
}

/** Draw a gold dashed ROI rectangle on the export canvas. */
function drawROIOverlay(ctx, W, H, roi, viewState, bounds, imageWidth, imageHeight, dpr) {
  const [sx0, sy0] = _imgToScreen(roi.left, roi.top, viewState, bounds, imageWidth, imageHeight, W, H);
  const [sx1, sy1] = _imgToScreen(roi.left + roi.width, roi.top + roi.height, viewState, bounds, imageWidth, imageHeight, W, H);
  const rx = Math.min(sx0, sx1);
  const ry = Math.min(sy0, sy1);
  const rw = Math.abs(sx1 - sx0);
  const rh = Math.abs(sy1 - sy0);

  ctx.save();
  // Bounds only — no fill (matches ROIOverlay; the shading tinted the data)
  ctx.strokeStyle = '#ffc832';
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.setLineDash([]);
  ctx.restore();
}

/** Draw profile lines and histogram on the export canvas. */
function drawProfileOverlays(ctx, W, H, roi, profileData, show, viewState, bounds, imageWidth, imageHeight, useDecibels, dpr) {
  const { rowMeans, colMeans, hist, histMin, histMax, mean, count } = profileData;
  const db = profileData.useDecibels ?? useDecibels;
  const unit = db ? 'dB' : 'power';

  const [sx0, sy0] = _imgToScreen(roi.left, roi.top, viewState, bounds, imageWidth, imageHeight, W, H);
  const [sx1, sy1] = _imgToScreen(roi.left + roi.width, roi.top + roi.height, viewState, bounds, imageWidth, imageHeight, W, H);
  const lx0 = Math.min(sx0, sx1);
  const ly0 = Math.min(sy0, sy1);
  const roiW = Math.abs(sx1 - sx0);
  const roiH = Math.abs(sy1 - sy0);

  if (roiW < 30 || roiH < 30) return;

  const allMeans = [...(rowMeans || []), ...(colMeans || [])].filter(v => !isNaN(v));
  const vMin = allMeans.length ? Math.min(...allMeans) : (histMin ?? 0);
  const vMax = allMeans.length ? Math.max(...allMeans) : (histMax ?? 1);
  const vRange = vMax - vMin || 1;

  const C = { bg: 'rgba(10,22,40,0.88)', border: '#1e3a5f', cyan: '#4ec9d4', cyanDim: 'rgba(78,201,212,0.35)', orange: '#e8833a', muted: '#5a7099', text: '#e8edf5' };
  const font = (sz) => `${sz * dpr}px 'JetBrains Mono', monospace`;
  const fmtS = (v) => isNaN(v) ? '' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  const fmt = (v) => isNaN(v) ? '' : v.toFixed(1);

  const pad = { t: 4 * dpr, r: 6 * dpr, b: 20 * dpr, l: 36 * dpr };
  const gap = 6 * dpr;

  ctx.save();

  // Y-profile (left of ROI)
  if (show.v && rowMeans?.length) {
    const yProfW = Math.min(80 * dpr, Math.max(50 * dpr, roiH * 0.25));
    const x = lx0 - gap - yProfW;
    const y = ly0;
    const w = yProfW;
    const h = roiH;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;

    ctx.fillStyle = C.bg;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = dpr;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Mean marker
    if (!isNaN(mean)) {
      const mx = x + pad.l + ((mean - vMin) / vRange) * innerW;
      ctx.strokeStyle = C.orange;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.beginPath(); ctx.moveTo(mx, y + pad.t); ctx.lineTo(mx, y + h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Profile line
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < rowMeans.length; i++) {
      if (isNaN(rowMeans[i])) continue;
      const px = x + pad.l + ((rowMeans[i] - vMin) / vRange) * innerW;
      const py = y + pad.t + (i / Math.max(rowMeans.length - 1, 1)) * innerH;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = C.muted;
    ctx.font = font(8);
    ctx.textAlign = 'center';
    ctx.fillText(fmtS(vMin), x + pad.l, y + h - pad.b + 12 * dpr);
    ctx.fillText(fmtS(vMax), x + pad.l + innerW, y + h - pad.b + 12 * dpr);
    ctx.fillText('Y profile', x + w / 2, y - 3 * dpr);
    ctx.fillText(unit, x + w / 2, y + h + 11 * dpr);
  }

  // X-profile (below ROI)
  if (show.h && colMeans?.length) {
    const xProfH = Math.min(80 * dpr, Math.max(50 * dpr, roiW * 0.25));
    const x = lx0;
    const y = ly0 + roiH + gap;
    const w = roiW;
    const h = xProfH;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;

    ctx.fillStyle = C.bg;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = dpr;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Mean marker
    if (!isNaN(mean)) {
      const my = y + pad.t + (1 - (mean - vMin) / vRange) * innerH;
      ctx.strokeStyle = C.orange;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.beginPath(); ctx.moveTo(x + pad.l, my); ctx.lineTo(x + pad.l + innerW, my); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Profile line
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < colMeans.length; i++) {
      if (isNaN(colMeans[i])) continue;
      const px = x + pad.l + (i / Math.max(colMeans.length - 1, 1)) * innerW;
      const py = y + pad.t + (1 - (colMeans[i] - vMin) / vRange) * innerH;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Labels
    ctx.fillStyle = C.muted;
    ctx.font = font(8);
    ctx.textAlign = 'center';
    ctx.fillText(fmtS(vMin), x + pad.l, y + h - pad.b + 10 * dpr);
    ctx.textAlign = 'start';
    ctx.fillText(fmtS(vMax), x + pad.l, y + pad.t + 6 * dpr);
    ctx.textAlign = 'center';
    ctx.fillText('X profile', x + w / 2, y - 3 * dpr);
  }

  // Histogram inset (centred in ROI)
  if (show.i && hist?.length) {
    const hW = Math.min(160 * dpr, Math.max(80 * dpr, roiW * 0.55));
    const hH = Math.min(100 * dpr, Math.max(60 * dpr, roiH * 0.4));
    const x = lx0 + roiW / 2 - hW / 2;
    const y = ly0 + roiH / 2 - hH / 2;
    const hp = { t: 6 * dpr, r: 6 * dpr, b: 18 * dpr, l: 28 * dpr };
    const innerW = hW - hp.l - hp.r;
    const innerH = hH - hp.t - hp.b;
    const n = hist.length;
    const maxCount = Math.max(...hist, 1);
    const binW = innerW / n;

    // Background
    ctx.fillStyle = 'rgba(10,22,40,0.92)';
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.fillRect(x, y, hW, hH);
    ctx.strokeRect(x, y, hW, hH);
    ctx.setLineDash([]);

    // Bars
    ctx.fillStyle = C.cyanDim;
    for (let i = 0; i < n; i++) {
      const bh = (hist[i] / maxCount) * innerH;
      ctx.fillRect(x + hp.l + i * binW, y + hp.t + innerH - bh, Math.max(1, binW - 0.5 * dpr), bh);
    }

    // Axis
    ctx.strokeStyle = C.border;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x + hp.l, y + hp.t + innerH);
    ctx.lineTo(x + hp.l + innerW, y + hp.t + innerH);
    ctx.stroke();

    // Mean line
    if (!isNaN(mean) && !isNaN(histMin) && !isNaN(histMax)) {
      const mx = ((mean - histMin) / (histMax - histMin || 1)) * innerW;
      ctx.strokeStyle = C.orange;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.beginPath(); ctx.moveTo(x + hp.l + mx, y + hp.t); ctx.lineTo(x + hp.l + mx, y + hp.t + innerH); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Labels
    ctx.fillStyle = C.muted;
    ctx.font = font(8);
    ctx.textAlign = 'center';
    ctx.fillText(fmtS(histMin), x + hp.l, y + hH - 2 * dpr);
    ctx.fillText(fmtS(histMax), x + hp.l + innerW, y + hH - 2 * dpr);

    // Stats title
    ctx.fillStyle = C.text;
    ctx.font = `500 ${font(8.5)}`;
    ctx.textAlign = 'center';
    const countStr = count >= 1000 ? (count / 1000).toFixed(1) + 'k' : count;
    ctx.fillText(`\u03BC=${fmt(mean)} ${unit}  n=${countStr}`, x + hW / 2, y + hp.t - 1 * dpr);
  }

  ctx.restore();
}

// ── 1. Figure border ────────────────────────────────────────────────────────

function drawBorder(ctx, W, H, s) {
  const S = getFigureStyle();
  if (S.borderStyle === 'none') return; // modern figures breathe to the edge
  ctx.strokeStyle = S.borderColor;
  ctx.lineWidth = s(1);
  if (S.borderStyle === 'dashed') ctx.setLineDash([s(8), s(4)]);
  ctx.strokeRect(s(0.5), s(0.5), W - s(1), H - s(1));
  ctx.setLineDash([]);
}

// ── 2. Coordinate grid ─────────────────────────────────────────────────────

function drawCoordinateGrid(ctx, W, H, viewState, bounds, projected, s) {
  if (!viewState || !bounds) return;

  const extent = computeVisibleExtent(viewState, W, H);
  const ppu = extent.pixelsPerUnit;
  const [cx, cy] = viewState.target || [0, 0];

  const toX = (wx) => (wx - cx) * ppu + W / 2;
  const toY = (wy) => -(wy - cy) * ppu + H / 2;

  const dx = niceInterval(extent.width, 3);
  const dy = niceInterval(extent.height, 3);

  const S = getFigureStyle();

  // Gridlines — barely-there hairlines, solid (dashes read as busy on a figure).
  ctx.strokeStyle = S.gridLine;
  ctx.lineWidth = s(0.5);

  const tickFontSize = s(12);
  const tickPad = s(6);

  // Vertical gridlines
  const xStart = Math.ceil(extent.minX / dx) * dx;
  for (let wx = xStart; wx <= extent.maxX; wx += dx) {
    const px = toX(wx);
    if (px < s(2) || px > W - s(2)) continue;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();

    // Tick label at bottom (mono numerics)
    ctx.save();
    ctx.font = `${tickFontSize}px ${S.fontNumeric}`;
    ctx.fillStyle = S.inkMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatTickValue(wx, projected), px, H - tickPad);
    ctx.restore();
  }

  // Horizontal gridlines
  const yStart = Math.ceil(extent.minY / dy) * dy;
  for (let wy = yStart; wy <= extent.maxY; wy += dy) {
    const py = toY(wy);
    if (py < s(2) || py > H - s(2)) continue;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(W, py);
    ctx.stroke();

    // Tick label at left (mono numerics)
    ctx.save();
    ctx.font = `${tickFontSize}px ${S.fontNumeric}`;
    ctx.fillStyle = S.inkMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatTickValue(wy, projected), tickPad, py);
    ctx.restore();
  }
}

// ── 3. Corner coordinates ───────────────────────────────────────────────────

function drawCornerCoordinates(ctx, W, H, viewState, projected, s) {
  if (!viewState) return;

  const extent = computeVisibleExtent(viewState, W, H);
  // Only show bottom-right corner coordinate
  const corners = [
    { wx: extent.maxX, wy: extent.minY, align: 'right', baseline: 'bottom', px: W - s(10), py: H - s(10) },
  ];

  const fontSize = s(11);
  const pad = s(5);
  const lineH = s(12);

  const S = getFigureStyle();

  for (const c of corners) {
    const line1 = formatCoord(c.wy, projected, 'y');
    const line2 = formatCoord(c.wx, projected, 'x');

    ctx.font = `${fontSize}px ${S.fontNumeric}`;
    const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);

    const pillW = tw + pad * 2;
    const pillH = lineH * 2 + pad * 2;
    const pillX = c.align === 'left' ? c.px : c.px - pillW;
    const pillY = c.baseline === 'top' ? c.py : c.py - pillH;

    // Optional panel behind the text (dark style only; publication is open).
    if (S.panelFill) {
      ctx.fillStyle = S.panelFill;
      roundRect(ctx, pillX, pillY, pillW, pillH, s(S.radius));
      ctx.fill();
      if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
    }

    // Text (mono numerics, soft ink)
    ctx.fillStyle = S.inkSoft;
    ctx.font = `${fontSize}px ${S.fontNumeric}`;
    ctx.textAlign = c.align;
    ctx.textBaseline = 'top';
    const textX = c.align === 'left' ? pillX + pad : pillX + pillW - pad;
    ctx.fillText(line1, textX, pillY + pad);
    ctx.fillText(line2, textX, pillY + pad + lineH);
  }
}

// ── 4. Scale bar ────────────────────────────────────────────────────────────

function drawScaleBar(ctx, W, H, viewState, bounds, projected, s) {
  if (!viewState || !bounds || !projected) return;

  const ppu = Math.pow(2, viewState.zoom || 0);
  const { barPixels, label } = computeScaleBar(ppu, s(150));

  const S = getFigureStyle();

  const barH = s(3);
  const fontSize = s(12);
  const pad = s(8);
  const x = s(16);
  const y = H - s(16);

  // Optional panel behind the bar (dark style only; publication is open).
  if (S.panelFill) {
    const bgW = barPixels + pad * 2;
    const bgH = barH + fontSize + pad * 3;
    ctx.fillStyle = S.panelFill;
    roundRect(ctx, x - pad, y - bgH, bgW, bgH + pad, s(S.radius));
    ctx.fill();
    if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
  }

  // Bar — accent fill with end caps (classic map scale bar, square not rounded)
  ctx.fillStyle = S.accent;
  ctx.fillRect(x, y - barH, barPixels, barH);
  // subtle end ticks for a crisper read
  ctx.fillRect(x, y - barH - s(2), s(1), barH + s(2));
  ctx.fillRect(x + barPixels - s(1), y - barH - s(2), s(1), barH + s(2));

  // Label (mono numeric distance)
  ctx.font = `500 ${fontSize}px ${S.fontNumeric}`;
  ctx.fillStyle = S.inkSoft;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x + barPixels / 2, y - barH - s(5));
}

// ── 5a. RGB legend ──────────────────────────────────────────────────────────

/**
 * Compute the actual display color for each RGB channel under the active
 * colorblind mode. A pure R/G/B signal (1,0,0), (0,1,0), (0,0,1) is run
 * through the colorblind matrix so the swatches match what the viewer shows.
 */
function colorblindChannelColors(colorblindMode) {
  const matrix = COLORBLIND_MATRICES[colorblindMode];
  // No colorblind remap → legend swatches follow the display guns (R/G/B) per
  // the active figure style, NOT the app's brand channel colors. A magenta
  // swatch labeled "R" on a red-gun composite would misinform the reader.
  if (!matrix) return getFigureStyle().channelColors;
  const clamp = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  const toRgb = (r, g, b) => `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
  // matrix rows = output channels, columns = input channels
  return {
    R: toRgb(matrix[0][0], matrix[1][0], matrix[2][0]),
    G: toRgb(matrix[0][1], matrix[1][1], matrix[2][1]),
    B: toRgb(matrix[0][2], matrix[1][2], matrix[2][2]),
  };
}

function drawRGBLegend(ctx, W, H, compositeId, contrastLimits, useDecibels, s, colorblindMode = 'off') {
  const preset = SAR_COMPOSITES[compositeId];
  const title = preset?.name || 'RGB';

  const channelColors = colorblindChannelColors(colorblindMode);
  const channels = [
    { key: 'R', color: channelColors.R },
    { key: 'G', color: channelColors.G },
    { key: 'B', color: channelColors.B },
  ];

  const S = getFigureStyle();
  const fontSize = s(12);
  const titleFontSize = s(13);
  const swatchSize = s(11);
  const lineHeight = s(18);
  const pad = s(10);

  const labels = channels.map(({ key }) => {
    const chDef = preset?.channels?.[key];
    const label = chDef?.label || chDef?.dataset || key;
    const limStr = formatLimit(contrastLimits, key, useDecibels);
    return `${label}  ${limStr}`;
  });

  // Measure width
  ctx.font = `600 ${titleFontSize}px ${S.fontTitle}`;
  let maxWidth = ctx.measureText(title).width;
  ctx.font = `${fontSize}px ${S.fontLabel}`;
  for (const l of labels) {
    maxWidth = Math.max(maxWidth, ctx.measureText(l).width + swatchSize + s(8));
  }

  const boxW = maxWidth + pad * 2;
  const boxH = titleFontSize + lineHeight * 3 + pad * 2 + s(4);
  const boxX = W - s(20) - boxW;
  const boxY = s(20);

  // Optional plate (dark style only; publication legend floats open).
  if (S.panelFill) {
    ctx.fillStyle = S.panelFill;
    roundRect(ctx, boxX, boxY, boxW, boxH, s(S.radius));
    ctx.fill();
    if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
  }

  // Title (display grotesk)
  ctx.fillStyle = S.ink;
  ctx.font = `600 ${titleFontSize}px ${S.fontTitle}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, boxX + pad, boxY + pad);

  // Channels
  let cy = boxY + pad + titleFontSize + s(8);
  for (let i = 0; i < channels.length; i++) {
    const { color } = channels[i];

    // Swatch — square, thin hairline keeps it crisp on any ground.
    ctx.fillStyle = color;
    ctx.fillRect(boxX + pad, cy + s(1), swatchSize, swatchSize);
    ctx.strokeStyle = S.hairline;
    ctx.lineWidth = s(0.5);
    ctx.strokeRect(boxX + pad + s(0.25), cy + s(1.25), swatchSize - s(0.5), swatchSize - s(0.5));

    // Label (sans; short dB range reads fine here)
    ctx.fillStyle = S.inkSoft;
    ctx.font = `${fontSize}px ${S.fontLabel}`;
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i], boxX + pad + swatchSize + s(7), cy);

    cy += lineHeight;
  }
}

// ── 5b. Colormap bar ────────────────────────────────────────────────────────

function drawColormapBar(ctx, W, H, colormapName, contrastLimits, useDecibels, s) {
  const S = getFigureStyle();
  const [min, max] = Array.isArray(contrastLimits) ? contrastLimits : [0, 1];
  const unitLabel = useDecibels ? 'dB' : 'linear';
  const colormapFunc = getColormap(colormapName);

  const barW = s(14);
  const barH = s(160);
  const fontSize = s(12);
  // Right margin leaves room for the rotated unit caption to the RIGHT of the bar.
  const margin = s(34);
  // Right-aligned vertical bar; numeric labels sit to the LEFT of the ramp, open (no box).
  const barX = W - margin - barW;
  const barY = s(28);

  // Optional plate (dark style only).
  if (S.panelFill) {
    const pad = s(10);
    const boxX = barX - s(56) - pad;
    const boxY = barY - fontSize - pad;
    const boxW = (W - margin) - boxX + pad;
    const boxH = barH + fontSize * 2 + pad * 2 + s(10);
    ctx.fillStyle = S.panelFill;
    roundRect(ctx, boxX, boxY, boxW, boxH, s(S.radius));
    ctx.fill();
    if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
  }

  // Gradient ramp (top = max)
  for (let y = 0; y < barH; y++) {
    const t = 1 - y / barH;
    const rgb = colormapFunc(t);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(barX, barY + y, barW, 1);
  }
  // Thin frame around the ramp (hairline, square).
  ctx.strokeStyle = S.hairline;
  ctx.lineWidth = s(0.75);
  ctx.strokeRect(barX + s(0.5), barY + s(0.5), barW - s(1), barH - s(1));

  // End tick + numeric labels (mono), left of the bar.
  const labelX = barX - s(6);
  ctx.fillStyle = S.ink;
  ctx.font = `${fontSize}px ${S.fontNumeric}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(max.toFixed(1), labelX, barY);
  ctx.fillText(min.toFixed(1), labelX, barY + barH);
  // midpoint tick label for orientation
  ctx.fillStyle = S.inkMuted;
  ctx.fillText(((min + max) / 2).toFixed(1), labelX, barY + barH / 2);

  // Unit caption (sans), rotated up the right side of the bar.
  ctx.save();
  ctx.translate(barX + barW + s(12), barY + barH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = S.inkSoft;
  ctx.font = `${s(11)}px ${S.fontLabel}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(unitLabel, 0, 0);
  ctx.restore();
}

// ── 5c. Class-map legend (discrete swatches) ─────────────────────────────────

/**
 * Draw a discrete class legend for a class-map panel: one color swatch + name
 * per class. Replaces the continuous colormap bar (drawColormapBar), which is
 * meaningless for integer labels. Colors come from the panel's classPalette
 * (256×3 packed RGB); names from classNames (index → label). `legend.items`
 * (already computed for the live view) is preferred when present.
 */
function drawClassLegend(ctx, W, H, { classPalette, classNames, classLegend }, s) {
  // Prefer the already-computed live legend items; else derive from classNames.
  let items = Array.isArray(classLegend?.items) ? classLegend.items : null;
  if (!items && classNames) {
    items = Object.keys(classNames)
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > 0 && v <= 255)
      .sort((a, b) => a - b)
      .map((cls) => ({
        value: cls,
        color: classPalette
          ? [classPalette[cls * 3], classPalette[cls * 3 + 1], classPalette[cls * 3 + 2]]
          : [128, 128, 128],
        name: classNames[cls] || `Class ${cls}`,
      }));
  }
  if (!items || items.length === 0) return;

  const MAX = 16;
  const truncated = items.length > MAX || !!classLegend?.truncated;
  const shown = items.slice(0, MAX);

  const S = getFigureStyle();
  const fontSize = s(12);
  const rowH = fontSize + s(7);
  const swatch = fontSize;
  const pad = s(10);
  const boxW = pad * 2 + swatch + s(7) + s(150);
  const boxH = pad * 2 + rowH * (shown.length + (truncated ? 1 : 0));
  const boxX = W - s(20) - boxW;
  const boxY = s(20);

  if (S.panelFill) {
    ctx.fillStyle = S.panelFill;
    roundRect(ctx, boxX, boxY, boxW, boxH, s(S.radius));
    ctx.fill();
    if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
  }

  ctx.font = `${fontSize}px ${S.fontLabel}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let cy = boxY + pad;
  for (const it of shown) {
    const [r, g, b] = it.color || [128, 128, 128];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(boxX + pad, cy, swatch, swatch);
    ctx.strokeStyle = S.hairline;
    ctx.lineWidth = s(0.5);
    ctx.strokeRect(boxX + pad + s(0.25), cy + s(0.25), swatch - s(0.5), swatch - s(0.5));
    ctx.fillStyle = S.inkSoft;
    ctx.fillText(it.name || `Class ${it.value}`, boxX + pad + swatch + s(7), cy);
    cy += rowH;
  }
  if (truncated) {
    ctx.fillStyle = S.inkMuted;
    ctx.fillText('…', boxX + pad + swatch + s(7), cy);
  }
}

// ── 6. Metadata panel ───────────────────────────────────────────────────────

function drawMetadata(ctx, W, H, meta, s) {
  const { filename, crs, compositeId, useDecibels, viewState, bounds, projected, identification } = meta;
  const id = identification || {};

  // Build label:value pairs with semantic colors
  const entries = [];

  if (filename) {
    entries.push({ label: 'SOURCE', value: filename, color: THEME.textPrimary, serif: true });
  }

  // NISAR identification fields
  if (id.zeroDopplerStartTime) {
    const t = id.zeroDopplerStartTime;
    // Format: "2025-11-27T10:56:34" → "2025-11-27 10:56 UTC"
    const timeStr = typeof t === 'string' ? t.replace('T', ' ').slice(0, 16) + ' UTC' : String(t);
    entries.push({ label: 'TIME', value: timeStr, color: THEME.textSecondary });
  }
  if (id.orbitPassDirection) {
    entries.push({ label: 'ORBIT DIR', value: id.orbitPassDirection, color: THEME.cyan });
  }
  if (id.trackNumber != null) {
    entries.push({ label: 'TRACK', value: String(id.trackNumber), color: THEME.textSecondary });
  }
  if (id.frameNumber != null) {
    entries.push({ label: 'FRAME', value: String(id.frameNumber), color: THEME.textSecondary });
  }
  if (id.absoluteOrbitNumber != null) {
    entries.push({ label: 'ORBIT', value: String(id.absoluteOrbitNumber), color: THEME.textSecondary });
  }

  // Fallback fields for non-NISAR data
  if (!id.zeroDopplerStartTime) {
    if (compositeId) {
      const preset = SAR_COMPOSITES[compositeId];
      entries.push({ label: 'COMPOSITE', value: preset?.name || compositeId, color: THEME.cyan });
    }
    if (crs) {
      entries.push({ label: 'CRS', value: crs, color: THEME.orange });
    }
    entries.push({ label: 'SCALE', value: useDecibels ? 'dB' : 'linear', color: THEME.textSecondary });
  }

  const labelFontSize = s(9);
  const valueFontSize = s(11);
  const lineH = s(16);
  const pad = s(10);
  const labelWidth = s(72);  // fixed label column width

  // Measure max value width
  ctx.font = `${valueFontSize}px ${FONT_MONO}`;
  let maxValueW = 0;
  for (const e of entries) {
    maxValueW = Math.max(maxValueW, ctx.measureText(e.value).width);
  }

  const boxW = labelWidth + maxValueW + pad * 2 + s(4);
  const boxH = entries.length * lineH + pad * 2;
  const boxX = W - s(16) - boxW;
  const boxY = H - s(16) - boxH;

  // Background
  ctx.fillStyle = 'rgba(15, 31, 56, 0.85)';
  roundRect(ctx, boxX, boxY, boxW, boxH, s(THEME.radiusMd));
  ctx.fill();
  ctx.strokeStyle = 'rgba(30, 58, 95, 0.80)';
  ctx.lineWidth = s(1);
  ctx.stroke();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const y = boxY + pad + i * lineH;

    // Label — uppercase, letter-spaced, muted
    ctx.font = `600 ${labelFontSize}px ${FONT_MONO}`;
    ctx.fillStyle = THEME.textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(e.label, boxX + pad, y);

    // Value — semantic color, serif for descriptive values
    const valueFont = e.serif ? FONT_SERIF : FONT_MONO;
    ctx.font = `${valueFontSize}px ${valueFont}`;
    ctx.fillStyle = e.color;
    ctx.fillText(e.value, boxX + pad + labelWidth, y);
  }
}

// ── 7. Branding ─────────────────────────────────────────────────────────────

function drawBranding(ctx, W, H, s) {
  const S = getFigureStyle();
  if (!S.branding) return; // off by default for figures

  const fontSize = s(18);
  ctx.font = `600 ${fontSize}px ${S.fontTitle}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const x = s(14);
  const y = s(12);

  ctx.fillStyle = S.accent;
  const sarW = ctx.measureText('SAR').width;
  ctx.fillText('SAR', x, y);

  ctx.fillStyle = S.ink;
  ctx.fillText('dine', x + sarW, y);
}

/**
 * Draw all annotations (arrows + text labels) on the export canvas.
 * Annotations are stored in world coordinates and projected via worldToPixel.
 */
function drawAnnotations(ctx, W, H, annotations, viewState, dpr) {
  if (!Array.isArray(annotations) || annotations.length === 0 || !viewState) return;
  // worldToPixel uses logical canvas size; export canvas is in physical pixels,
  // so we pass W/H directly (already DPR-scaled by glCanvas.width/height).
  for (const a of annotations) {
    if (a.type === 'arrow') {
      const [x1, y1] = worldToPixel(a.worldX,  a.worldY,  viewState, W, H);
      const [x2, y2] = worldToPixel(a.worldX2, a.worldY2, viewState, W, H);
      drawAnnArrow(ctx, x1, y1, x2, y2, {
        colorKey: a.color, caption: a.text || '', dpr, size: a.size, fontSize: a.fontSize,
      });
    } else if (a.type === 'text') {
      const [x, y] = worldToPixel(a.worldX, a.worldY, viewState, W, H);
      drawAnnText(ctx, x, y, a.text || '', {
        colorKey: a.color, dpr, size: a.size, fontSize: a.fontSize,
      });
    }
  }
}

/**
 * Draw a full-width attribution strip along the bottom edge of the figure.
 * Auto-shrinks font if the text is too long for the canvas width.
 */
function drawAttributionStrip(ctx, W, H, text, s) {
  if (!text) return;
  const S = getFigureStyle();

  const margin = s(12);
  let fontSize = s(10);

  // Editorial micro-credit: letter-spaced, quiet, bottom-right — not a badge.
  const label = String(text);
  if ('letterSpacing' in ctx) { try { ctx.letterSpacing = `${s(0.5)}px`; } catch (_) {} }
  ctx.font = `${fontSize}px ${S.fontLabel}`;

  const maxTextW = W - margin * 2;
  let textW = ctx.measureText(label).width;
  if (textW > maxTextW) {
    fontSize = Math.max(s(8), Math.floor(fontSize * (maxTextW / textW)));
    ctx.font = `${fontSize}px ${S.fontLabel}`;
    textW = ctx.measureText(label).width;
  }

  if (S.panelFill) {
    // Dark style keeps a subtle plate so the credit stays legible over imagery.
    const padX = s(10), padY = s(5);
    const pillW = Math.min(W - margin * 2, textW + padX * 2);
    const pillH = fontSize + padY * 2;
    const x0 = W - margin - pillW;
    const y0 = H - pillH - margin;
    ctx.fillStyle = S.panelFill;
    roundRect(ctx, x0, y0, pillW, pillH, s(S.radius));
    ctx.fill();
    if (S.panelStroke) { ctx.strokeStyle = S.panelStroke; ctx.lineWidth = s(1); ctx.stroke(); }
    ctx.fillStyle = S.inkSoft;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x0 + pillW - padX, y0 + pillH / 2 + s(1));
  } else {
    // Publication: bare quiet credit, bottom-right.
    ctx.fillStyle = S.inkMuted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, W - margin, H - margin);
  }
  if ('letterSpacing' in ctx) { try { ctx.letterSpacing = '0px'; } catch (_) {} }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatLimit(contrastLimits, ch, useDecibels) {
  if (!contrastLimits) return '';
  if (Array.isArray(contrastLimits)) {
    const [min, max] = contrastLimits;
    return useDecibels
      ? `${min.toFixed(1)}–${max.toFixed(1)} dB`
      : `${min.toExponential(1)}–${max.toExponential(1)}`;
  }
  const lim = contrastLimits[ch];
  if (!lim) return '';
  return useDecibels
    ? `${lim[0].toFixed(1)}–${lim[1].toFixed(1)} dB`
    : `${lim[0].toExponential(1)}–${lim[1].toExponential(1)}`;
}

// ── 8. Histogram inset ───────────────────────────────────────────────────────

/**
 * Draw the histogram as an inset panel on the export canvas (top-left, below branding).
 */
function drawHistogramInset(ctx, W, H, opts, dpr) {
  const { histogramData, compositeId, contrastLimits, useDecibels, polarization } = opts;
  const mode = (histogramData.R || histogramData.G || histogramData.B) ? 'rgb' : 'single';

  const S = getFigureStyle();
  const s = makeScale(W, H); // box/border scale with the figure, like other chrome
  const insetW = Math.min(s(400), Math.round(W * 0.35));
  const insetH = Math.min(s(240), Math.round(H * 0.3));
  const pad = s(12);
  const ix = pad;
  const iy = pad; // branding is off by default → sit at top-left margin

  ctx.save();

  // The histogram readout keeps its own dark mini-panel (a self-contained
  // inset), but the frame follows the figure accent so it belongs to the figure.
  // Square corners in publication; subtle round in dark.
  ctx.fillStyle = 'rgba(10, 22, 40, 0.94)';
  ctx.strokeStyle = S.id === 'publication' ? S.hairline : 'rgba(78, 201, 212, 0.25)';
  ctx.lineWidth = dpr;
  roundRect(ctx, ix, iy, insetW, insetH, s(S.radius));
  ctx.fill();
  ctx.stroke();

  // Clip to inset bounds and draw histogram
  ctx.save();
  ctx.beginPath();
  ctx.rect(ix, iy, insetW, insetH);
  ctx.clip();
  ctx.translate(ix, iy);

  // The drawHistogramCanvas expects logical (unscaled) coordinates,
  // but here we're working in physical pixels. Scale down by dpr.
  const logW = insetW / dpr;
  const logH = insetH / dpr;
  ctx.scale(dpr, dpr);

  drawHistogramCanvas(ctx, logW, logH, {
    histograms: histogramData,
    mode,
    contrastLimits,
    useDecibels,
    polarization,
    compositeId,
    compact: true,
  });

  ctx.restore();
  ctx.restore();
}

// ── 9. Location inset (Bing VirtualEarth satellite) ─────────────────────────

/**
 * Convert lat/lon (degrees) to Web Mercator tile x/y at zoom z.
 */
function _latLonToTile(lat, lon, z) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  const n = Math.pow(2, z);
  const tx = Math.floor((lon + 180) / 360 * n);
  const ty = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return {
    x: Math.max(0, Math.min(n - 1, tx)),
    y: Math.max(0, Math.min(n - 1, ty)),
  };
}

/**
 * Convert tile x/y/z to Bing Maps quadkey string.
 */
function _tileToQuadkey(x, y, z) {
  let qk = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit++;
    if ((y & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}

/**
 * Fetch and stitch Bing VirtualEarth aerial tiles covering wgs84Bounds.
 * Returns { canvas, z, xMin, yMin, tileSize } or null on failure.
 */
async function _fetchBingTiles(wgs84Bounds, targetW, targetH) {
  const { minLon, minLat, maxLon, maxLat } = wgs84Bounds;
  const cMinLat = Math.max(-85.05, minLat);
  const cMaxLat = Math.min(85.05, maxLat);
  const dLon = Math.max(maxLon - minLon, 0.001);

  // Pick zoom so the scene spans ~65% of targetW in tile pixels
  const zLon = Math.log2((targetW * 0.65 * 360) / (dLon * 256));
  const z = Math.max(1, Math.min(13, Math.round(zLon)));

  const tl = _latLonToTile(cMaxLat, minLon, z);
  const br = _latLonToTile(cMinLat, maxLon, z);
  const xMin = Math.min(tl.x, br.x);
  const xMax = Math.max(tl.x, br.x);
  const yMin = Math.min(tl.y, br.y);
  const yMax = Math.max(tl.y, br.y);

  if ((xMax - xMin + 1) * (yMax - yMin + 1) > 25) return null;

  const TILE = 256;
  const cols = xMax - xMin + 1;
  const rows = yMax - yMin + 1;
  const stitchCanvas = document.createElement('canvas');
  stitchCanvas.width = cols * TILE;
  stitchCanvas.height = rows * TILE;
  const sCtx = stitchCanvas.getContext('2d');

  const fetches = [];
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      const qk = _tileToQuadkey(tx, ty, z);
      const srv = (tx + ty) % 4;
      const url = `https://ecn.t${srv}.tiles.virtualearth.net/tiles/a${qk}.jpeg?g=1`;
      fetches.push(
        fetch(url, { mode: 'cors' })
          .then(r => r.ok ? r.blob() : null)
          .then(b => b ? createImageBitmap(b) : null)
          .then(bmp => ({ bmp, tx, ty }))
          .catch(() => ({ bmp: null, tx, ty }))
      );
    }
  }

  const results = await Promise.all(fetches);
  let anyLoaded = false;
  for (const { bmp, tx, ty } of results) {
    if (!bmp) continue;
    anyLoaded = true;
    sCtx.drawImage(bmp, (tx - xMin) * TILE, (ty - yMin) * TILE);
    bmp.close();
  }
  if (!anyLoaded) return null;

  return { canvas: stitchCanvas, z, xMin, yMin, tileSize: TILE };
}

/**
 * Draw a Bing VirtualEarth satellite location inset in the bottom-left corner.
 * Shows the scene footprint as a cyan rectangle over the satellite imagery.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W - canvas width
 * @param {number} H - canvas height
 * @param {{ minLon, minLat, maxLon, maxLat }} wgs84Bounds
 * @param {boolean} projected - whether scale bar is present (affects y offset)
 * @param {number} dpr - device pixel ratio
 */
async function drawLocationInset(ctx, W, H, wgs84Bounds, projected, dpr) {
  if (!wgs84Bounds) return;
  const s = makeScale(W, H); // inset scales with the figure
  const insetW = Math.min(s(195), Math.round(W * 0.22));
  const insetH = Math.round(insetW * 0.70);
  const margin = s(14);
  // Leave room above the scale bar when projected bounds are present
  const scaleReserve = projected ? s(62) : 0;
  const ix = margin;
  const iy = H - margin - scaleReserve - insetH;
  if (iy < s(30)) return; // not enough vertical room

  const result = await _fetchBingTiles(wgs84Bounds, insetW, insetH);
  if (!result) return;

  const { canvas: tileCanvas, z, xMin, yMin, tileSize: TILE } = result;
  const n = Math.pow(2, z);
  const worldPx = n * TILE;

  // World pixel coords of scene bounds
  const sinMax = Math.sin(Math.min(85.05, wgs84Bounds.maxLat) * Math.PI / 180);
  const sinMin = Math.sin(Math.max(-85.05, wgs84Bounds.minLat) * Math.PI / 180);
  const wpxLeft   = (wgs84Bounds.minLon + 180) / 360 * worldPx;
  const wpxRight  = (wgs84Bounds.maxLon + 180) / 360 * worldPx;
  const wpxTop    = (0.5 - Math.log((1 + sinMax) / (1 - sinMax)) / (4 * Math.PI)) * worldPx;
  const wpxBottom = (0.5 - Math.log((1 + sinMin) / (1 - sinMin)) / (4 * Math.PI)) * worldPx;

  // Coords in tile canvas space
  const cx0 = wpxLeft  - xMin * TILE;
  const cx1 = wpxRight - xMin * TILE;
  const cy0 = wpxTop    - yMin * TILE;
  const cy1 = wpxBottom - yMin * TILE;
  const sceneW = Math.max(1, cx1 - cx0);
  const sceneH = Math.max(1, cy1 - cy0);

  // Source rect: scene + 20% padding
  const padX = sceneW * 0.20;
  const padY = sceneH * 0.20;
  let srcX = cx0 - padX;
  let srcY = cy0 - padY;
  let srcW = sceneW + 2 * padX;
  let srcH = sceneH + 2 * padY;
  if (srcX < 0) { srcW += srcX; srcX = 0; }
  if (srcY < 0) { srcH += srcY; srcY = 0; }
  srcW = Math.min(srcW, tileCanvas.width  - srcX);
  srcH = Math.min(srcH, tileCanvas.height - srcY);
  if (srcW <= 0 || srcH <= 0) return;

  // Letterbox-fit src into inset
  const scale = Math.min(insetW / srcW, insetH / srcH);
  const dstW  = Math.round(srcW * scale);
  const dstH  = Math.round(srcH * scale);
  const dstX  = ix + Math.round((insetW - dstW) / 2);
  const dstY  = iy + Math.round((insetH - dstH) / 2);

  ctx.save();

  // Background + border
  ctx.fillStyle = 'rgba(10, 22, 40, 0.92)';
  ctx.strokeStyle = 'rgba(78, 201, 212, 0.55)';
  ctx.lineWidth = dpr;
  roundRect(ctx, ix, iy, insetW, insetH, s(4));
  ctx.fill();
  ctx.stroke();

  // Clip to inset
  ctx.beginPath();
  ctx.rect(ix, iy, insetW, insetH);
  ctx.clip();

  // Satellite imagery
  ctx.drawImage(tileCanvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);

  // Scene footprint outline
  const rX = dstX + (cx0 - srcX) * scale;
  const rY = dstY + (cy0 - srcY) * scale;
  const rW = sceneW * scale;
  const rH = sceneH * scale;
  ctx.strokeStyle = getFigureStyle().accent;
  ctx.lineWidth = s(1.5);
  ctx.strokeRect(rX, rY, rW, rH);

  // Attribution strip (kept dark — sits over a photographic thumbnail)
  const attrH = s(12);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(ix, iy + insetH - attrH, insetW, attrH);
  ctx.fillStyle = 'rgba(220, 230, 240, 0.75)';
  ctx.font = `${s(8)}px ${getFigureStyle().fontLabel}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('© Bing Maps', ix + insetW - s(4), iy + insetH - s(2));

  ctx.restore();
}

// ── Standalone RGB colorbar (triangle) ───────────────────────────────────────

/**
 * Generate a standalone RGB colorbar as a triangular color-space diagram.
 *
 * The triangle vertices represent the three channels (R, G, B).  Each
 * interior pixel is coloured by its barycentric coordinates: wR, wG, wB
 * determine the relative intensity of each channel.  The stretch function
 * is applied so the gradient matches the on-screen rendering.
 *
 * Layout:
 *               R: HHHH
 *                 ▲
 *                ╱ ╲
 *               ╱   ╲
 *              ╱  ●  ╲
 *             ╱_______╲
 *       G: HVHV     B: HH/HV
 *
 *       R  −41.4 – −1.5 dB
 *       G  −24.7 – −8.2 dB
 *       B   −4.0 – 11.5 dB
 *
 * @param {Object} options
 * @param {string}   options.compositeId   - SAR composite preset ID
 * @param {Object}   options.contrastLimits - {R:[min,max], G:[min,max], B:[min,max]}
 * @param {boolean}  [options.useDecibels=true]
 * @param {string}   [options.stretchMode='linear']
 * @param {number}   [options.gamma=1.0]
 * @returns {Promise<Blob>} PNG blob
 */
export function exportRGBColorbar(options = {}) {
  const {
    compositeId,
    contrastLimits,
    useDecibels = true,
    stretchMode = 'linear',
    gamma = 1.0,
    colorblindMode = 'off',
    format = 'png',
    theme = 'publication',
  } = options;

  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return Promise.resolve(null);

  const S = setFigureStyle(theme);
  const dpr = window.devicePixelRatio || 1;
  const s = (v) => Math.round(v * dpr);

  const pad = s(14);
  const triSide = s(240);
  const triH = Math.round(triSide * Math.sqrt(3) / 2);

  // Canvas sizing: title, label above apex, triangle, labels below base, range table
  const titleH = s(28);
  const apexLabelH = s(20);
  const baseLabelH = s(22);
  const rangeTableH = s(56);
  // Reserve generous room on both sides so the base vertex labels
  // ("G: …" left, "B: …" right) never clip against the canvas edge.
  const sideRoom = s(90);
  const canvasW = triSide + sideRoom * 2;
  const canvasH = titleH + apexLabelH + triH + baseLabelH + rangeTableH + pad * 2;

  const { ctx, finish } = makeTarget(canvasW, canvasH, format, { background: S.background });

  // Background (SVG bg via makeTarget; canvas needs the explicit fill)
  if (format !== 'svg') {
    ctx.fillStyle = S.background;
    ctx.fillRect(0, 0, canvasW, canvasH);
  }

  // Optional frame (publication is open, no frame).
  if (S.borderStyle !== 'none') {
    ctx.strokeStyle = S.borderColor;
    ctx.lineWidth = s(0.75);
    ctx.strokeRect(s(0.5), s(0.5), canvasW - s(1), canvasH - s(1));
  }

  // ── Title row: composite name (display grotesk), no branding wordmark ──
  let y = pad;
  ctx.font = `600 ${s(14)}px ${S.fontTitle}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = S.ink;
  ctx.fillText(preset.name, pad, y);

  ctx.fillStyle = S.inkMuted;
  ctx.font = `${s(10)}px ${S.fontLabel}`;
  ctx.textAlign = 'right';
  ctx.fillText('RGB composite', canvasW - pad, y + s(3));
  ctx.textAlign = 'left';

  y += titleH;

  // ── Triangle vertices: R (top), G (bottom-left), B (bottom-right) ──
  const cx = canvasW / 2;
  const triTop = y + apexLabelH;
  const vR = [cx, triTop];
  const vG = [cx - triSide / 2, triTop + triH];
  const vB = [cx + triSide / 2, triTop + triH];

  // ── Render triangle via ImageData + barycentric interpolation ──
  // Drawn to its own temp canvas (not the target ctx) so it works for both PNG
  // and SVG: for SVG it becomes one embedded <image> layer while the triangle
  // outline, labels, and range table stay editable vector.
  const bboxX0 = Math.floor(vG[0]);
  const bboxX1 = Math.ceil(vB[0]);
  const bboxY0 = Math.floor(vR[1]);
  const bboxY1 = Math.ceil(vG[1]);
  const imgW = bboxX1 - bboxX0;
  const imgH = bboxY1 - bboxY0;
  const imgData = new ImageData(imgW, imgH);
  const px = imgData.data;

  // Pre-compute barycentric denominator
  const e0 = [vG[0] - vR[0], vG[1] - vR[1]];  // R → G
  const e1 = [vB[0] - vR[0], vB[1] - vR[1]];  // R → B
  const d00 = e0[0] * e0[0] + e0[1] * e0[1];
  const d01 = e0[0] * e1[0] + e0[1] * e1[1];
  const d11 = e1[0] * e1[0] + e1[1] * e1[1];
  const invDenom = 1 / (d00 * d11 - d01 * d01);
  const stretchFn = createStretchFn(stretchMode, gamma);

  for (let iy = 0; iy < imgH; iy++) {
    for (let ix = 0; ix < imgW; ix++) {
      const pX = bboxX0 + ix + 0.5;
      const pY = bboxY0 + iy + 0.5;
      const ep = [pX - vR[0], pY - vR[1]];
      const d20 = ep[0] * e0[0] + ep[1] * e0[1];
      const d21 = ep[0] * e1[0] + ep[1] * e1[1];

      const wG = (d11 * d20 - d01 * d21) * invDenom;
      const wB = (d00 * d21 - d01 * d20) * invDenom;
      const wR = 1 - wG - wB;

      if (wR >= 0 && wG >= 0 && wB >= 0) {
        let sr = stretchFn(wR);
        let sg = stretchFn(wG);
        let sb = stretchFn(wB);
        // Apply colorblind remap so triangle matches what the viewer shows
        const cbMatrix = COLORBLIND_MATRICES[colorblindMode];
        if (cbMatrix) {
          const dr = cbMatrix[0][0]*sr + cbMatrix[0][1]*sg + cbMatrix[0][2]*sb;
          const dg = cbMatrix[1][0]*sr + cbMatrix[1][1]*sg + cbMatrix[1][2]*sb;
          const db = cbMatrix[2][0]*sr + cbMatrix[2][1]*sg + cbMatrix[2][2]*sb;
          sr = dr; sg = dg; sb = db;
        }
        const idx = (iy * imgW + ix) * 4;
        px[idx]     = Math.round(Math.min(1, sr) * 255);
        px[idx + 1] = Math.round(Math.min(1, sg) * 255);
        px[idx + 2] = Math.round(Math.min(1, sb) * 255);
        px[idx + 3] = 255;
      }
    }
  }

  const triCanvas = document.createElement('canvas');
  triCanvas.width = imgW;
  triCanvas.height = imgH;
  triCanvas.getContext('2d').putImageData(imgData, 0, 0);
  ctx.drawImage(triCanvas, bboxX0, bboxY0);

  // Triangle outline (hairline)
  ctx.strokeStyle = S.hairline;
  ctx.lineWidth = s(1);
  ctx.beginPath();
  ctx.moveTo(vR[0], vR[1]);
  ctx.lineTo(vG[0], vG[1]);
  ctx.lineTo(vB[0], vB[1]);
  ctx.closePath();
  ctx.stroke();

  // ── Vertex labels ──
  const chDefs = {
    R: preset.channels.R,
    G: preset.channels.G,
    B: preset.channels.B,
  };

  const labelR = chDefs.R?.label || chDefs.R?.dataset || 'R';
  const labelG = chDefs.G?.label || chDefs.G?.dataset || 'G';
  const labelB = chDefs.B?.label || chDefs.B?.dataset || 'B';

  const labelFont = `600 ${s(11)}px ${S.fontLabel}`;
  const subFont = `${s(10)}px ${S.fontNumeric}`;
  const cbColors = colorblindChannelColors(colorblindMode);

  // R — above apex
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = cbColors.R;
  ctx.fillText(`R: ${labelR}`, vR[0], vR[1] - s(4));

  // G — below-left of base
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = cbColors.G;
  ctx.fillText(`G: ${labelG}`, vG[0] + s(4), vG[1] + s(4));

  // B — below-right of base
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = cbColors.B;
  ctx.fillText(`B: ${labelB}`, vB[0] - s(4), vB[1] + s(4));

  // ── Contrast range table ──
  y = vG[1] + baseLabelH + s(8);
  const rangeX = pad + s(4);
  const unit = useDecibels ? ' dB' : '';

  for (const ch of ['R', 'G', 'B']) {
    const color = cbColors[ch];
    const lim = contrastLimits?.[ch] || [-25, 0];
    const minStr = useDecibels ? lim[0].toFixed(1) : lim[0].toExponential(1);
    const maxStr = useDecibels ? lim[1].toFixed(1) : lim[1].toExponential(1);

    ctx.font = labelFont;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(ch, rangeX, y);

    ctx.font = subFont;
    ctx.fillStyle = S.inkMuted;
    ctx.fillText(`${minStr} – ${maxStr}${unit}`, rangeX + s(18), y + s(1));

    y += s(16);
  }

  return finish();
}

/**
 * Capture two viewers side-by-side and export as a single PNG figure.
 *
 * Each panel gets the full set of SARdine figure overlays (grid, scalebar,
 * colorbar, metadata, branding). A thin divider is drawn between panels.
 *
 * @param {Object} left  - { canvas: HTMLCanvasElement, options: Object }
 * @param {Object} right - { canvas: HTMLCanvasElement, options: Object }
 * @returns {Promise<Blob>} PNG blob
 */
export async function exportFigureSideBySide(left, right, { format = 'png', theme = 'publication' } = {}) {
  const S = setFigureStyle(theme);
  const dpr = window.devicePixelRatio || 1;
  const divider = Math.round(2 * dpr);

  const lW = left.canvas.width;
  const lH = left.canvas.height;
  const rW = right.canvas.width;
  const rH = right.canvas.height;

  // Use the taller of the two heights; scale the shorter panel up
  const H = Math.max(lH, rH);
  const W = lW + divider + rW;

  const BG = S.background;
  const { ctx, finish } = makeTarget(W, H, format, { background: BG });

  // Background fill (in case panels are shorter than H). SVG bg comes from
  // makeTarget; the canvas path needs the explicit fill.
  if (format !== 'svg') {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  // Draw left panel
  ctx.drawImage(left.canvas, 0, 0);

  // Draw right panel
  ctx.drawImage(right.canvas, lW + divider, 0);

  // Divider/frame scales to the whole figure.
  const s = makeScale(W, H);

  async function drawPanel(opts, offsetX, panelW, panelH) {
    const {
      colormap = 'grayscale',
      contrastLimits,
      useDecibels = true,
      compositeId = null,
      viewState,
      bounds,
      filename = '',
      crs = '',
      histogramData = null,
      polarization = '',
      identification = null,
      colorblindMode = 'off',
      wgs84Bounds = null,
      classMode = false,
      classPalette = null,
      classNames = null,
      classLegend = null,
    } = opts;

    const projected = isProjectedBounds(bounds, crs || null);
    // Chrome inside a panel scales to THAT panel's size.
    const s = makeScale(panelW, panelH);

    ctx.save();
    ctx.translate(offsetX, 0);
    ctx.beginPath();
    ctx.rect(0, 0, panelW, panelH);
    ctx.clip();

    // Border/divider drawn once after both panels (see below).
    drawCoordinateGrid(ctx, panelW, panelH, viewState, bounds, projected, s);
    drawCornerCoordinates(ctx, panelW, panelH, viewState, projected, s);
    drawScaleBar(ctx, panelW, panelH, viewState, bounds, projected, s);

    if (classMode) {
      drawClassLegend(ctx, panelW, panelH, { classPalette, classNames, classLegend }, s);
    } else if (compositeId) {
      drawRGBLegend(ctx, panelW, panelH, compositeId, contrastLimits, useDecibels, s, colorblindMode);
    } else {
      drawColormapBar(ctx, panelW, panelH, colormap, contrastLimits, useDecibels, s);
    }

    // Metadata box omitted from exports (see note in exportFigure).
    drawBranding(ctx, panelW, panelH, s);

    if (histogramData) {
      drawHistogramInset(ctx, panelW, panelH, {
        histogramData, compositeId, contrastLimits, useDecibels, polarization,
      }, dpr);
    }

    await drawLocationInset(ctx, panelW, panelH, wgs84Bounds, projected, dpr);

    ctx.restore();
  }

  await drawPanel(left.options,  0,          lW, lH);
  await drawPanel(right.options, lW + divider, rW, rH);

  // Single hairline divider between panels; outer frame only if the style asks.
  ctx.fillStyle = S.hairline;
  ctx.fillRect(lW, 0, divider, H);
  if (S.borderStyle !== 'none') {
    ctx.strokeStyle = S.borderColor;
    ctx.lineWidth = divider;
    ctx.strokeRect(divider / 2, divider / 2, W - divider, H - divider);
  }

  return finish();
}

/**
 * Capture N viewer panels (up to 4) in an adaptive grid and export as one PNG.
 *
 * Layout matches the on-screen CompareGrid: 1 → full, 2 → side-by-side,
 * 3-4 → 2×2. Each panel gets the full SARdine overlay set (grid, scalebar,
 * colorbar, metadata, branding) clipped to its cell. Cells are sized to the
 * largest panel canvas so the grid is uniform.
 *
 * @param {Array<{canvas: HTMLCanvasElement, options: Object}>} panels
 * @returns {Promise<Blob>} PNG blob
 */
export async function exportFigureGrid(panels, { format = 'png', theme = 'publication' } = {}) {
  const valid = (panels || []).filter((p) => p && p.canvas);
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    // Single panel — defer to the standard figure export.
    return exportFigure(valid[0].canvas, { ...valid[0].options, format, theme });
  }
  if (valid.length === 2) {
    return exportFigureSideBySide(valid[0], valid[1], { format, theme });
  }

  const S = setFigureStyle(theme);
  const dpr = window.devicePixelRatio || 1;
  const divider = Math.round(2 * dpr);

  // 3 or 4 panels → 2×2 grid. Uniform cell = largest panel dimensions.
  const cols = 2;
  const rows = 2;
  const cellW = Math.max(...valid.map((p) => p.canvas.width));
  const cellH = Math.max(...valid.map((p) => p.canvas.height));

  const W = cols * cellW + (cols - 1) * divider;
  const H = rows * cellH + (rows - 1) * divider;

  const BG = S.background;
  const { ctx, finish } = makeTarget(W, H, format, { background: BG });

  if (format !== 'svg') {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  const s = makeScale(W, H); // seams/frame scale to the whole grid

  async function drawPanel(opts, offsetX, offsetY, panelW, panelH, srcCanvas) {
    const {
      colormap = 'grayscale',
      contrastLimits,
      useDecibels = true,
      compositeId = null,
      viewState,
      bounds,
      filename = '',
      crs = '',
      histogramData = null,
      polarization = '',
      identification = null,
      colorblindMode = 'off',
      wgs84Bounds = null,
      classMode = false,
      classPalette = null,
      classNames = null,
      classLegend = null,
    } = opts;

    const projected = isProjectedBounds(bounds, crs || null);
    const s = makeScale(panelW, panelH); // panel chrome scales to the cell

    // Draw the captured image into its cell.
    ctx.drawImage(srcCanvas, offsetX, offsetY);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.beginPath();
    ctx.rect(0, 0, panelW, panelH);
    ctx.clip();

    // No per-cell dashed border in grid mode — a single clean divider + outer
    // frame is drawn once after all panels (see below). Doubled dashed borders
    // at interior seams read as noise.
    drawCoordinateGrid(ctx, panelW, panelH, viewState, bounds, projected, s);
    drawCornerCoordinates(ctx, panelW, panelH, viewState, projected, s);
    drawScaleBar(ctx, panelW, panelH, viewState, bounds, projected, s);

    if (classMode) {
      drawClassLegend(ctx, panelW, panelH, { classPalette, classNames, classLegend }, s);
    } else if (compositeId) {
      drawRGBLegend(ctx, panelW, panelH, compositeId, contrastLimits, useDecibels, s, colorblindMode);
    } else {
      drawColormapBar(ctx, panelW, panelH, colormap, contrastLimits, useDecibels, s);
    }

    // Metadata box omitted from exports (see note in exportFigure).
    drawBranding(ctx, panelW, panelH, s);

    if (histogramData) {
      drawHistogramInset(ctx, panelW, panelH, {
        histogramData, compositeId, contrastLimits, useDecibels, polarization,
      }, dpr);
    }

    await drawLocationInset(ctx, panelW, panelH, wgs84Bounds, projected, dpr);

    ctx.restore();
  }

  // Cell origins in 2×2 order: TL, TR, BL, BR.
  const origins = [
    [0, 0],
    [cellW + divider, 0],
    [0, cellH + divider],
    [cellW + divider, cellH + divider],
  ];

  for (let i = 0; i < valid.length; i++) {
    const [ox, oy] = origins[i];
    await drawPanel(
      valid[i].options,
      ox,
      oy,
      valid[i].canvas.width,
      valid[i].canvas.height,
      valid[i].canvas
    );
  }

  // Hairline seams between cells; outer frame only if the style asks for one.
  ctx.fillStyle = S.hairline;
  ctx.fillRect(cellW, 0, divider, H);          // vertical seam
  ctx.fillRect(0, cellH, W, divider);          // horizontal seam
  if (S.borderStyle !== 'none') {
    ctx.strokeStyle = S.borderColor;
    ctx.lineWidth = divider;
    ctx.strokeRect(divider / 2, divider / 2, W - divider, H - divider);
  }

  return finish();
}

/**
 * Download a Blob as a file.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
