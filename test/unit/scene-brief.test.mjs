/**
 * scene-brief.test.mjs — "Copy scene for agent" brief.
 *
 * Pins that the pasted brief carries the grounding (ambiguities + contract),
 * and that credentials in a source URL never reach the clipboard.
 */

import { formatSceneBrief, redactSource, layoutBrief } from '../../src/utils/scene-brief.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ PASS  ${name}`); passed++; }
  catch (err) { console.log(`  ✗ FAIL  ${name}\n          ${err.message}`); failed++; }
}

const NISAR_L = {
  identification: { radarBand: 'L', lookDirection: 'Right', orbitPassDirection: 'Ascending', platformName: 'NISAR' },
  pixelSpacing: 20,
  crs: 'EPSG:4326',
};
const RENDER = {
  useDecibels: true, contrastMin: -25, contrastMax: 0,
  selectedPolarization: 'HHHH', multiLook: false, speckleFilterType: 'none',
  colormap: 'grayscale', stretchMode: 'linear', displayMode: 'single',
  viewCenter: [-122.1234567, 37.7654321], viewZoom: 9.5,
  filename: 'https://bucket.s3.amazonaws.com/NISAR_GCOV.h5?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA',
};

console.log('\nscene-brief\n');

test('redactSource drops query and fragment from URLs', () => {
  assert.strictEqual(redactSource('https://h.example/a/b.tif?token=abc#x'), 'https://h.example/a/b.tif');
});

test('redactSource leaves local filenames alone', () => {
  assert.strictEqual(redactSource('NISAR_L2_GCOV.h5'), 'NISAR_L2_GCOV.h5');
  assert.strictEqual(redactSource(null), null);
});

test('brief never contains presign credentials', () => {
  const md = formatSceneBrief({ render: RENDER, imageData: NISAR_L });
  assert.ok(!md.includes('X-Amz'), 'signature leaked');
  assert.ok(!md.includes('AKIA'), 'credential leaked');
  assert.ok(md.includes('https://bucket.s3.amazonaws.com/NISAR_GCOV.h5'));
});

test('brief carries acquisition, extent and attached image size', () => {
  const md = formatSceneBrief({
    render: RENDER, imageData: NISAR_L,
    bounds: { minLon: -123, minLat: 37, maxLon: -121.5, maxLat: 38.25 },
    image: { width: 1024, height: 640 },
  });
  assert.ok(md.includes('Band: L'));
  assert.ok(md.includes('Ascending pass, Right-looking'));
  assert.ok(md.includes('Product extent (WGS84, whole file'));
  assert.ok(md.includes('lon -123 to -121.5, lat 37 to 38.25'));
  assert.ok(md.includes('1024×640'));
});

test('brief states the dark-target ambiguity and interpretation rules', () => {
  const md = formatSceneBrief({ render: RENDER, imageData: NISAR_L });
  assert.ok(md.includes('Does a dark region indicate open water?'));
  assert.ok(md.includes('## How to interpret'));
  assert.ok(md.includes('not an optical image'));
});

test('brief tolerates an empty scene', () => {
  const md = formatSceneBrief();
  assert.ok(md.startsWith('# SAR scene from SARdine'));
  assert.ok(!md.includes('undefined'));
});

test('layoutBrief wraps to width and strips markdown markers', () => {
  const measure = (t) => t.length * 7; // monospace stand-in
  const md = formatSceneBrief({ render: RENDER, imageData: NISAR_L });
  const lines = layoutBrief(md, 580, measure);
  for (const l of lines) {
    if (l.gap) continue;
    assert.ok(measure(l.text) + (l.indent || 0) <= 580 || !l.text.includes(' '), `overflow: ${l.text}`);
    assert.ok(!/\*\*|`|^#/.test(l.text), `markdown left in: ${l.text}`);
  }
  assert.ok(lines.some(l => l.heading && l.text === 'What this view cannot settle'));
});

const COG_3413 = { crs: 'EPSG:3413', pixelSpacing: { x: 20, y: 20 } };
const RENDER_LINEAR_BAND = {
  useDecibels: false, contrastMin: 0, contrastMax: 0.4, selectedPolarization: 'HH',
  colormap: 'grayscale', stretchMode: 'linear', displayMode: 'single',
  viewCenter: [12233.5197, 3065.5422], viewZoom: 0.33,
  colormapBand: { min: 0, max: 0.02, colormap: 'inferno', reverse: false },
};

test('object pixel spacing is formatted, never [object Object]', () => {
  const md = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: COG_3413 });
  assert.ok(!md.includes('[object Object]'));
  assert.ok(md.includes('Pixel spacing: 20 m'));
  const md2 = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: { crs: 'EPSG:3413', pixelSpacing: { x: 10, y: 20 } } });
  assert.ok(md2.includes('10 m × 20 m'));
});

test('pixel spacing is rounded to three significant figures', () => {
  const md = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: { crs: 'EPSG:3413', pixelSpacing: { x: 9.994373, y: 9.991536 } } });
  assert.ok(md.includes('Pixel spacing: 9.99 m\n'), 'near-equal spacing collapses to one value');
  const geo = formatSceneBrief({ render: {}, imageData: { crs: 'EPSG:4326', pixelSpacing: 0.000277778 } });
  assert.ok(geo.includes('Pixel spacing: 0.000278°'));
});

test('projected view centre is labelled with its CRS, not as lon/lat', () => {
  const md = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: COG_3413 });
  assert.ok(md.includes('View center (EPSG:3413 map units)'));
  assert.ok(!md.includes('zoom'));
});

test('colormap band is reported with its range and colormap', () => {
  const md = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: COG_3413 });
  assert.ok(md.includes('Colormap band: values 0 to 0.02 are highlighted with the inferno colormap'));
});

test('linear quantity is not repeated', () => {
  const md = formatSceneBrief({ render: RENDER_LINEAR_BAND, imageData: COG_3413 });
  assert.ok(md.includes('- Quantity: linear radar power\n'));
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
