/**
 * SVGRecorder — a CanvasRenderingContext2D-shaped recorder that emits SVG.
 *
 * The figure-export draw* helpers (drawBorder, drawScaleBar, drawColormapBar,
 * legends, coordinate grid, …) are written against the Canvas 2D API. This
 * recorder implements exactly the subset of that API they use, but instead of
 * rasterizing it accumulates SVG elements. Passing a recorder where those
 * helpers expect a `ctx` therefore yields **editable vector chrome** — real
 * <text>, <line>, <rect>, <path> — with zero duplication of the drawing code.
 *
 * What stays raster: pixels you cannot vectorize (the SAR base image, satellite
 * thumbnail tiles). Those arrive via drawImage()/putImageData() and are embedded
 * as <image href="data:image/png;base64,…"> layers, positioned through the
 * current transform. Everything else is vector.
 *
 * Design notes:
 *   - A 2×3 affine CTM (current transform matrix) stack backs save()/restore()/
 *     translate()/scale(). Every emitted coordinate is mapped through the CTM so
 *     nested transforms (the histogram inset scales by dpr, clips, translates)
 *     land correctly. Uniform scale is the common case; non-uniform scale still
 *     maps points exactly, and stroke widths use the mean scale factor.
 *   - Path state (beginPath/moveTo/lineTo/quadraticCurveTo/rect/closePath) builds
 *     an SVG path `d` string in *device* space; fill()/stroke() flush it to a
 *     <path>. clip() pushes a <clipPath> that wraps subsequently-emitted content
 *     until the matching restore().
 *   - A real offscreen 2D context backs measureText() and font parsing so text
 *     metrics match the PNG path exactly.
 *
 * Only the primitives figure-export actually uses are implemented (verified by
 * enumerating ctx.* usages). Unused Canvas2D surface is intentionally absent —
 * add here if a new draw helper needs it.
 */

// ── Affine matrix helpers (2×3: [a, b, c, d, e, f]) ─────────────────────────
// x' = a·x + c·y + e ;  y' = b·x + d·y + f

const IDENTITY = [1, 0, 0, 1, 0, 0];

function matMul(m, n) {
  // m ∘ n  (apply n, then m) — i.e. m * n in column-vector convention
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyPt(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Mean linear scale of a CTM — used for stroke widths / dash lengths. */
function meanScale(m) {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return (sx + sy) / 2 || 1;
}

/** True when the CTM has no rotation/skew (axis-aligned) — lets us emit <rect>. */
function isAxisAligned(m) {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
}

// ── XML / number formatting ─────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Compact number: trim to 2 decimals, drop trailing zeros. */
function n(v) {
  if (!isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

/**
 * Normalize a Canvas fillStyle/strokeStyle color string into an SVG
 * {fill|stroke, opacity} pair. Handles #rgb/#rrggbb/rgb()/rgba()/named.
 */
function splitColor(css) {
  if (css == null) return { color: '#000', alpha: 1 };
  const str = String(css).trim();
  const m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    return { color: `rgb(${r},${g},${b})`, alpha: isFinite(a) ? a : 1 };
  }
  return { color: str, alpha: 1 };
}

// ── Font string parsing (for <text> attributes) ─────────────────────────────

function parseFont(font) {
  // e.g. "13px 'IBM Plex Mono', monospace" | "600 15px serif"
  const out = { size: 12, family: 'sans-serif', weight: null, style: null };
  if (!font) return out;
  const m = String(font).match(/(italic|oblique)?\s*(normal|bold|[1-9]00)?\s*([\d.]+)px\s+(.+)$/i);
  if (m) {
    if (m[1]) out.style = m[1];
    if (m[2]) out.weight = m[2];
    out.size = parseFloat(m[3]);
    out.family = m[4].trim();
  }
  return out;
}

const ANCHOR = { left: 'start', center: 'middle', right: 'end', start: 'start', end: 'end' };
// Canvas textBaseline → SVG dominant-baseline (alphabetic is SVG default)
const BASELINE = {
  top: 'text-before-edge',
  middle: 'central',
  bottom: 'text-after-edge',
  alphabetic: 'alphabetic',
  hanging: 'hanging',
  ideographic: 'ideographic',
};

// ── Graphics state ──────────────────────────────────────────────────────────

function defaultState() {
  return {
    ctm: IDENTITY.slice(),
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineDash: [],
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    letterSpacing: '0px',
    clipId: null, // id of the enclosing <clipPath>, or null
  };
}

export class SVGRecorder {
  /**
   * @param {number} width  device-pixel width (matches glCanvas.width)
   * @param {number} height device-pixel height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._els = [];        // emitted SVG element strings (document order = z-order)
    this._defs = [];       // <defs> entries (clipPaths, patterns)
    this._state = defaultState();
    this._stack = [];      // saved states
    this._path = [];       // current path segments in device space
    this._uid = 0;
    this.imageSmoothingEnabled = true;

    // Real offscreen ctx purely for text measurement.
    const c = typeof document !== 'undefined'
      ? document.createElement('canvas') : null;
    this._measureCtx = c ? c.getContext('2d') : null;
  }

  _id(prefix) { return `${prefix}${++this._uid}`; }

  // ── State accessors mirroring Canvas2D properties ─────────────────────────
  get fillStyle() { return this._state.fillStyle; }
  set fillStyle(v) { this._state.fillStyle = v; }
  get strokeStyle() { return this._state.strokeStyle; }
  set strokeStyle(v) { this._state.strokeStyle = v; }
  get lineWidth() { return this._state.lineWidth; }
  set lineWidth(v) { this._state.lineWidth = v; }
  get font() { return this._state.font; }
  set font(v) { this._state.font = v; if (this._measureCtx) this._measureCtx.font = v; }
  get textAlign() { return this._state.textAlign; }
  set textAlign(v) { this._state.textAlign = v; }
  get textBaseline() { return this._state.textBaseline; }
  set textBaseline(v) { this._state.textBaseline = v; }
  get globalAlpha() { return this._state.globalAlpha; }
  set globalAlpha(v) { this._state.globalAlpha = v; }
  get lineCap() { return this._state.lineCap; }
  set lineCap(v) { this._state.lineCap = v; }
  get lineJoin() { return this._state.lineJoin; }
  set lineJoin(v) { this._state.lineJoin = v; }
  get letterSpacing() { return this._state.letterSpacing; }
  set letterSpacing(v) { this._state.letterSpacing = v; }

  setLineDash(arr) { this._state.lineDash = Array.isArray(arr) ? arr.slice() : []; }
  getLineDash() { return this._state.lineDash.slice(); }

  // ── Transform stack ───────────────────────────────────────────────────────
  save() {
    this._stack.push({ ...this._state, ctm: this._state.ctm.slice(), lineDash: this._state.lineDash.slice() });
  }
  restore() {
    if (this._stack.length) this._state = this._stack.pop();
  }
  translate(x, y) { this._state.ctm = matMul(this._state.ctm, [1, 0, 0, 1, x, y]); }
  scale(x, y) { this._state.ctm = matMul(this._state.ctm, [x, 0, 0, y, 0, 0]); }
  rotate(rad) { const c = Math.cos(rad), s = Math.sin(rad); this._state.ctm = matMul(this._state.ctm, [c, s, -s, c, 0, 0]); }
  transform(a, b, c, d, e, f) { this._state.ctm = matMul(this._state.ctm, [a, b, c, d, e, f]); }
  setTransform(a, b, c, d, e, f) { this._state.ctm = [a, b, c, d, e, f]; }

  // ── Path building (accumulates in device space) ───────────────────────────
  beginPath() { this._path = []; }
  closePath() { this._path.push('Z'); }
  moveTo(x, y) { const [dx, dy] = applyPt(this._state.ctm, x, y); this._path.push(`M${n(dx)} ${n(dy)}`); }
  lineTo(x, y) { const [dx, dy] = applyPt(this._state.ctm, x, y); this._path.push(`L${n(dx)} ${n(dy)}`); }
  quadraticCurveTo(cx, cy, x, y) {
    const [qx, qy] = applyPt(this._state.ctm, cx, cy);
    const [ex, ey] = applyPt(this._state.ctm, x, y);
    this._path.push(`Q${n(qx)} ${n(qy)} ${n(ex)} ${n(ey)}`);
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    const [a1, b1] = applyPt(this._state.ctm, c1x, c1y);
    const [a2, b2] = applyPt(this._state.ctm, c2x, c2y);
    const [ex, ey] = applyPt(this._state.ctm, x, y);
    this._path.push(`C${n(a1)} ${n(b1)} ${n(a2)} ${n(b2)} ${n(ex)} ${n(ey)}`);
  }
  rect(x, y, w, h) {
    const m = this._state.ctm;
    const p0 = applyPt(m, x, y), p1 = applyPt(m, x + w, y);
    const p2 = applyPt(m, x + w, y + h), p3 = applyPt(m, x, y + h);
    this._path.push(`M${n(p0[0])} ${n(p0[1])}L${n(p1[0])} ${n(p1[1])}L${n(p2[0])} ${n(p2[1])}L${n(p3[0])} ${n(p3[1])}Z`);
  }
  arcTo(x1, y1, x2, y2, r) {
    // Canvas arcTo: line to the tangent point, then an arc of radius r toward
    // (x2,y2). Chrome only uses this for small rounded corners; approximate the
    // fillet as a quadratic through the corner (x1,y1). Visually indistinguishable
    // at the radii used, and keeps the path a single vector element.
    this.quadraticCurveTo(x1, y1, x2, y2);
  }
  arc(cx, cy, r, a0, a1) {
    // Not used by figure-export today, but cheap to support (polyline approx).
    const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 16)));
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      const [dx, dy] = applyPt(this._state.ctm, cx + r * Math.cos(a), cy + r * Math.sin(a));
      this._path.push(`${i === 0 ? 'M' : 'L'}${n(dx)} ${n(dy)}`);
    }
  }

  _clipAttr() { return this._state.clipId ? ` clip-path="url(#${this._state.clipId})"` : ''; }
  _alphaAttr(base) {
    const a = this._state.globalAlpha;
    return a < 1 ? (base * a) : base;
  }

  // ── Paint operations ──────────────────────────────────────────────────────
  fill() {
    if (!this._path.length) return;
    const { color, alpha } = splitColor(this._state.fillStyle);
    const fo = this._alphaAttr(alpha);
    this._els.push(
      `<path d="${this._path.join('')}" fill="${color}"` +
      (fo < 1 ? ` fill-opacity="${n(fo)}"` : '') +
      this._clipAttr() + `/>`
    );
  }
  stroke() {
    if (!this._path.length) return;
    const { color, alpha } = splitColor(this._state.strokeStyle);
    const so = this._alphaAttr(alpha);
    const sw = this._state.lineWidth * meanScale(this._state.ctm);
    const dash = this._state.lineDash.length
      ? ` stroke-dasharray="${this._state.lineDash.map((d) => n(d * meanScale(this._state.ctm))).join(',')}"` : '';
    this._els.push(
      `<path d="${this._path.join('')}" fill="none" stroke="${color}" stroke-width="${n(sw)}"` +
      (so < 1 ? ` stroke-opacity="${n(so)}"` : '') + dash + this._capJoinAttr() +
      this._clipAttr() + `/>`
    );
  }

  _capJoinAttr() {
    let out = '';
    if (this._state.lineCap && this._state.lineCap !== 'butt') out += ` stroke-linecap="${this._state.lineCap}"`;
    if (this._state.lineJoin && this._state.lineJoin !== 'miter') out += ` stroke-linejoin="${this._state.lineJoin}"`;
    return out;
  }
  fillRect(x, y, w, h) {
    const m = this._state.ctm;
    const { color, alpha } = splitColor(this._state.fillStyle);
    const fo = this._alphaAttr(alpha);
    const foAttr = fo < 1 ? ` fill-opacity="${n(fo)}"` : '';
    if (isAxisAligned(m)) {
      const [px, py] = applyPt(m, x, y);
      const [qx, qy] = applyPt(m, x + w, y + h);
      const rx = Math.min(px, qx), ry = Math.min(py, qy);
      this._els.push(`<rect x="${n(rx)}" y="${n(ry)}" width="${n(Math.abs(qx - px))}" height="${n(Math.abs(qy - py))}" fill="${color}"${foAttr}${this._clipAttr()}/>`);
    } else {
      const p0 = applyPt(m, x, y), p1 = applyPt(m, x + w, y), p2 = applyPt(m, x + w, y + h), p3 = applyPt(m, x, y + h);
      this._els.push(`<path d="M${n(p0[0])} ${n(p0[1])}L${n(p1[0])} ${n(p1[1])}L${n(p2[0])} ${n(p2[1])}L${n(p3[0])} ${n(p3[1])}Z" fill="${color}"${foAttr}${this._clipAttr()}/>`);
    }
  }
  clearRect() {
    // SVG has no destination-erase. Our only clearRect callers immediately paint
    // an opaque background over the same region, so emitting nothing is correct;
    // the transparent SVG canvas already reads as "cleared".
  }
  strokeRect(x, y, w, h) {
    const m = this._state.ctm;
    const { color, alpha } = splitColor(this._state.strokeStyle);
    const so = this._alphaAttr(alpha);
    const sw = this._state.lineWidth * meanScale(m);
    const dash = this._state.lineDash.length
      ? ` stroke-dasharray="${this._state.lineDash.map((d) => n(d * meanScale(m))).join(',')}"` : '';
    const soAttr = so < 1 ? ` stroke-opacity="${n(so)}"` : '';
    if (isAxisAligned(m)) {
      const [px, py] = applyPt(m, x, y);
      const [qx, qy] = applyPt(m, x + w, y + h);
      const rx = Math.min(px, qx), ry = Math.min(py, qy);
      this._els.push(`<rect x="${n(rx)}" y="${n(ry)}" width="${n(Math.abs(qx - px))}" height="${n(Math.abs(qy - py))}" fill="none" stroke="${color}" stroke-width="${n(sw)}"${soAttr}${dash}${this._clipAttr()}/>`);
    } else {
      const p0 = applyPt(m, x, y), p1 = applyPt(m, x + w, y), p2 = applyPt(m, x + w, y + h), p3 = applyPt(m, x, y + h);
      this._els.push(`<path d="M${n(p0[0])} ${n(p0[1])}L${n(p1[0])} ${n(p1[1])}L${n(p2[0])} ${n(p2[1])}L${n(p3[0])} ${n(p3[1])}Z" fill="none" stroke="${color}" stroke-width="${n(sw)}"${soAttr}${dash}${this._clipAttr()}/>`);
    }
  }

  // ── Text ──────────────────────────────────────────────────────────────────
  measureText(str) {
    if (this._measureCtx) { this._measureCtx.font = this._state.font; return this._measureCtx.measureText(str); }
    // Fallback heuristic if no DOM: ~0.6em per char.
    const size = parseFont(this._state.font).size;
    return { width: String(str).length * size * 0.6 };
  }
  fillText(str, x, y) {
    if (str == null || str === '') return;
    const m = this._state.ctm;
    const [dx, dy] = applyPt(m, x, y);
    const f = parseFont(this._state.font);
    const { color, alpha } = splitColor(this._state.fillStyle);
    const fo = this._alphaAttr(alpha);
    const scale = meanScale(m);
    // Map-label halo: white casing drawn UNDER the fill via paint-order:stroke,
    // so it's one editable <text> element (no duplicated node). Off when unset.
    let haloAttrs = '';
    if (this.halo && this.haloWidthEm > 0) {
      const { color: hc, alpha: ha } = splitColor(this.halo);
      const sw = f.size * scale * this.haloWidthEm * 2; // *2: stroke straddles the glyph edge
      haloAttrs = ` stroke="${hc}"${ha < 1 ? ` stroke-opacity="${n(ha)}"` : ''}` +
        ` stroke-width="${n(sw)}" stroke-linejoin="round" paint-order="stroke"`;
    }
    const attrs = [
      `x="${n(dx)}"`, `y="${n(dy)}"`,
      `font-family="${esc(f.family)}"`,
      `font-size="${n(f.size * scale)}"`,
      f.weight ? `font-weight="${f.weight}"` : '',
      f.style ? `font-style="${f.style}"` : '',
      `fill="${color}"`,
      fo < 1 ? `fill-opacity="${n(fo)}"` : '',
      `text-anchor="${ANCHOR[this._state.textAlign] || 'start'}"`,
      `dominant-baseline="${BASELINE[this._state.textBaseline] || 'alphabetic'}"`,
      this._letterSpacingAttr(scale),
      'style="white-space:pre"',
    ].filter(Boolean).join(' ');
    this._els.push(`<text ${attrs}${haloAttrs}${this._clipAttr()}>${esc(str)}</text>`);
  }
  _letterSpacingAttr(scale) {
    const ls = parseFloat(this._state.letterSpacing);
    if (!ls) return '';
    return `letter-spacing="${n(ls * scale)}"`;
  }
  strokeText(str, x, y) { this.fillText(str, x, y); } // outlines rare in chrome; approximate as fill

  // ── Clipping ──────────────────────────────────────────────────────────────
  // Wraps *subsequent* content (until restore) in a <clipPath>. The current
  // path defines the region. Nested clips intersect via clip-path chaining on
  // the group, matching Canvas semantics closely enough for our insets.
  clip() {
    if (!this._path.length) return;
    const id = this._id('clip');
    this._defs.push(`<clipPath id="${id}">${
      `<path d="${this._path.join('')}"${this._state.clipId ? ` clip-path="url(#${this._state.clipId})"` : ''}/>`
    }</clipPath>`);
    this._state.clipId = id;
  }

  // ── Raster embedding (drawImage / putImageData) ───────────────────────────
  // Anything genuinely pixel-based becomes an embedded <image>. Positioned via
  // the CTM; honors the (sx,sy,sw,sh,dx,dy,dw,dh) source-crop overload.
  drawImage(src, ...args) {
    const iw = src.width || src.videoWidth || 0;
    const ih = src.height || src.videoHeight || 0;
    let dx, dy, dw, dh, sx, sy, sw, sh, hasCrop = false;
    if (args.length === 2) { [dx, dy] = args; dw = iw; dh = ih; }
    else if (args.length === 4) { [dx, dy, dw, dh] = args; }
    else if (args.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = args; hasCrop = true; }
    else return;

    // With a source crop, re-raster just the cropped region to a temp canvas so
    // the embedded <image> holds exactly the drawn pixels (SVG <image> has no
    // source-rect). Without a crop, embed the whole source.
    let dataUri;
    if (hasCrop) {
      try {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(sw));
        c.height = Math.max(1, Math.round(sh));
        c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
        dataUri = c.toDataURL('image/png');
      } catch (e) { dataUri = null; }
    } else {
      dataUri = this._sourceToDataURI(src);
    }
    if (!dataUri) return;
    this._emitImage(dataUri, dx, dy, dw, dh);
  }

  putImageData(imageData, dx, dy) {
    const c = document.createElement('canvas');
    c.width = imageData.width; c.height = imageData.height;
    c.getContext('2d').putImageData(imageData, 0, 0);
    this._emitImage(c.toDataURL('image/png'), dx, dy, imageData.width, imageData.height, null);
  }

  getImageData(x, y, w, h) {
    // Draw helpers only read pixels off a *real* backing canvas they created
    // themselves; the recorder is never that canvas. Return zeros defensively.
    return { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h };
  }

  _sourceToDataURI(src) {
    try {
      if (typeof src === 'string') return src; // already a data/URL
      if (src && typeof src.toDataURL === 'function') return src.toDataURL('image/png'); // canvas
      // ImageBitmap / HTMLImageElement → route through a canvas
      const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
      if (!w || !h) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) {
      return null; // e.g. tainted canvas — skip rather than throw
    }
  }

  /** Embed a data-URI image at destination rect (dx,dy,dw,dh), mapped by the CTM. */
  _emitImage(uri, dx, dy, dw, dh) {
    const m = this._state.ctm;
    const smooth = this.imageSmoothingEnabled ? '' : ' image-rendering="pixelated"';
    // Emit BOTH xlink:href (SVG 1.1 — Illustrator, older Inkscape) and href
    // (SVG 2 — browsers, current Inkscape). SVG-1.1 importers ignore a bare
    // `href` and then report a missing/empty link ("."); browsers accept either.
    // The URI is XML-escaped (& → &amp;) so strict XML parsers don't reject it.
    const u = esc(uri);
    const hrefs = `xlink:href="${u}" href="${u}"`;
    if (isAxisAligned(m)) {
      const [px, py] = applyPt(m, dx, dy);
      const [qx, qy] = applyPt(m, dx + dw, dy + dh);
      const x = Math.min(px, qx), y = Math.min(py, qy);
      const w = Math.abs(qx - px), h = Math.abs(qy - py);
      this._els.push(`<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none" ${hrefs}${smooth}${this._clipAttr()}/>`);
    } else {
      const t = `matrix(${m.map(n).join(' ')})`;
      this._els.push(`<g transform="${t}"${this._clipAttr()}><image x="${n(dx)}" y="${n(dy)}" width="${n(dw)}" height="${n(dh)}" preserveAspectRatio="none" ${hrefs}${smooth}/></g>`);
    }
  }

  // ── Serialize ─────────────────────────────────────────────────────────────
  /**
   * @param {object} [opts]
   * @param {string} [opts.background] optional solid background fill
   * @returns {string} standalone SVG document
   */
  toSVG({ background = null } = {}) {
    const defs = this._defs.length ? `<defs>${this._defs.join('')}</defs>` : '';
    const bg = background ? `<rect width="${n(this.width)}" height="${n(this.height)}" fill="${background}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${n(this.width)}" height="${n(this.height)}" viewBox="0 0 ${n(this.width)} ${n(this.height)}">\n` +
      defs + bg + this._els.join('') + `\n</svg>`;
  }
}

/** Download an SVG string as a file (mirrors downloadBlob in figure-export). */
export function svgToBlob(svgString) {
  return new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
}
