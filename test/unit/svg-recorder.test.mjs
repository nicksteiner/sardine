/**
 * SVGRecorder — Canvas2D-shaped recorder that emits editable-vector SVG.
 *
 * Verifies the primitives figure-export relies on: transform composition,
 * nested clips, text attributes, dashed strokes, alpha, and raster embedding.
 * The emitted document must be well-formed XML so Illustrator/Inkscape open it.
 *
 * Run with:  node --test test/unit/svg-recorder.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM shim (recorder uses document.createElement for measureText and
//    for rasterizing image sources; ImageData for putImageData). ─────────────
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      font: '',
      measureText: (s) => ({ width: String(s).length * 7 }),
      putImageData() {}, drawImage() {},
    }),
    toDataURL: () => 'data:image/png;base64,SHIM',
  }),
};
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}

const { SVGRecorder, svgToBlob } = await import('../../src/utils/svg-recorder.js');

/** Naive well-formedness check: balanced tags + XML declaration + single root. */
function assertWellFormed(svg) {
  assert.match(svg, /^<\?xml /, 'has XML declaration');
  assert.match(svg, /<svg[\s>]/, 'has <svg> root');
  // Every opened element closes (self-closing or paired). Count < vs />/</.
  const opens = (svg.match(/<[a-zA-Z]/g) || []).length;
  const selfClose = (svg.match(/\/>/g) || []).length;
  const closes = (svg.match(/<\//g) || []).length;
  assert.equal(opens, selfClose + closes, 'every element is closed (self-closing or paired)');
  // No raw unescaped ampersands (must be entities).
  assert.doesNotMatch(svg, /&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/, 'all & are escaped');
}

test('emits a well-formed SVG document with correct dimensions', () => {
  const r = new SVGRecorder(800, 600);
  r.fillStyle = '#123456';
  r.fillRect(10, 20, 100, 50);
  const svg = r.toSVG();
  assertWellFormed(svg);
  assert.match(svg, /width="800"/);
  assert.match(svg, /viewBox="0 0 800 600"/);
});

test('transform stack composes translate + scale exactly', () => {
  const r = new SVGRecorder(200, 200);
  r.save();
  r.translate(20, 44);
  r.scale(2, 2);
  r.fillStyle = 'rgb(1,2,3)';
  r.fillRect(0, 0, 50, 30); // → device rect at (20,44) size (100,60)
  r.restore();
  const svg = r.toSVG();
  assert.match(svg, /<rect x="20" y="44" width="100" height="60"/, 'scaled+translated rect lands in device space');
});

test('restore pops transform so later draws are untransformed', () => {
  const r = new SVGRecorder(200, 200);
  r.save(); r.translate(100, 100); r.restore();
  r.fillStyle = '#000';
  r.fillRect(0, 0, 10, 10);
  assert.match(r.toSVG(), /<rect x="0" y="0" width="10" height="10"/, 'transform did not leak past restore');
});

test('nested clip emits <clipPath> and applies it to subsequent content', () => {
  const r = new SVGRecorder(200, 200);
  r.save();
  r.beginPath(); r.rect(10, 10, 80, 80); r.clip();
  r.fillStyle = '#fff'; r.fillRect(0, 0, 200, 200);
  r.restore();
  const svg = r.toSVG();
  assert.match(svg, /<clipPath id="clip\d+">/, 'clipPath defined');
  assert.match(svg, /clip-path="url\(#clip\d+\)"/, 'clip applied to fill');
});

test('text carries anchor, baseline, font, and is XML-escaped', () => {
  const r = new SVGRecorder(200, 200);
  r.font = "13px 'IBM Plex Mono', monospace";
  r.textAlign = 'center';
  r.textBaseline = 'bottom';
  r.fillStyle = '#4ec9d4';
  r.fillText('a<b>&"c', 100, 50);
  const svg = r.toSVG();
  assert.match(svg, /text-anchor="middle"/);
  assert.match(svg, /dominant-baseline="text-after-edge"/);
  assert.match(svg, /font-size="13"/);
  assert.match(svg, /a&lt;b&gt;&amp;&quot;c/, 'text content escaped');
  assertWellFormed(svg);
});

test('dashed stroke and stroke-opacity from rgba() are emitted', () => {
  const r = new SVGRecorder(200, 200);
  r.strokeStyle = 'rgba(30,58,95,0.8)';
  r.lineWidth = 2;
  r.setLineDash([8, 4]);
  r.strokeRect(1, 1, 198, 198);
  const svg = r.toSVG();
  assert.match(svg, /stroke-dasharray="8,4"/);
  assert.match(svg, /stroke-opacity="0.8"/);
  assert.match(svg, /stroke-width="2"/);
});

test('quadraticCurveTo (roundRect corners) produces a Q path segment', () => {
  const r = new SVGRecorder(200, 200);
  r.beginPath();
  r.moveTo(10, 0); r.lineTo(90, 0); r.quadraticCurveTo(100, 0, 100, 10); r.closePath();
  r.fillStyle = '#000'; r.fill();
  assert.match(r.toSVG(), /<path d="M10 0L90 0Q100 0 100 10Z"/);
});

test('drawImage embeds raster as <image> at the destination rect', () => {
  const r = new SVGRecorder(400, 400);
  const src = { width: 64, height: 64, toDataURL: () => 'data:image/png;base64,ZZZZ' };
  r.drawImage(src, 100, 50, 200, 150);
  const svg = r.toSVG();
  assert.match(svg, /<image x="100" y="50" width="200" height="150"/);
  assert.match(svg, /href="data:image\/png;base64,ZZZZ"/);
});

test('embedded <image> carries BOTH xlink:href and href (Illustrator/Inkscape compat)', () => {
  // SVG 1.1 tools (Illustrator, older Inkscape) read xlink:href and report a
  // missing link ("." ) if only a bare SVG2 href is present.
  const r = new SVGRecorder(100, 100);
  r.drawImage({ width: 8, height: 8, toDataURL: () => 'data:image/png;base64,QQ' }, 0, 0, 10, 10);
  const svg = r.toSVG();
  assert.match(svg, /xlink:href="data:image\/png;base64,QQ"/, 'has xlink:href for SVG 1.1 importers');
  assert.match(svg, /\shref="data:image\/png;base64,QQ"/, 'also has bare href for SVG 2 / browsers');
  // Namespace must be declared on the root for xlink:href to be valid.
  assert.match(svg, /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
});

test('imageSmoothingEnabled=false marks embedded image pixelated', () => {
  const r = new SVGRecorder(100, 100);
  r.imageSmoothingEnabled = false;
  r.drawImage({ width: 4, height: 4, toDataURL: () => 'data:,' }, 0, 0, 40, 40);
  assert.match(r.toSVG(), /image-rendering="pixelated"/);
});

test('background option paints a full-canvas rect first', () => {
  const r = new SVGRecorder(50, 50);
  r.fillStyle = '#abc'; r.fillRect(5, 5, 10, 10);
  const svg = r.toSVG({ background: '#0a1628' });
  const bgIdx = svg.indexOf('#0a1628');
  const fgIdx = svg.indexOf('#abc');
  assert.ok(bgIdx > -1 && fgIdx > -1 && bgIdx < fgIdx, 'background emitted before foreground');
});

test('svgToBlob yields an image/svg+xml blob', () => {
  const blob = svgToBlob('<svg/>');
  assert.equal(blob.type, 'image/svg+xml;charset=utf-8');
});
