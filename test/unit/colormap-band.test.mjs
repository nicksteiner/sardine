/**
 * colormap-band.test.mjs — colormap band: a value range drawn with its own
 * colormap + stretch while the rest of the scene keeps the base ramp.
 * Covers the CPU helpers (layer fallback + export parity), the colorbar ramp,
 * the deep-link `band=` param, and the export-sidecar field.
 *
 * Run: node test/unit/colormap-band.test.mjs
 */

import { suite } from './harness.mjs';
import {
  normalizeColormapBand,
  createColormapBandFn,
  createColorbarRamp,
  inferno,
  grayscale,
} from '../../src/utils/colormap.js';
import { parseShareLink, buildShareLink, parseColormapBand } from '../../src/utils/deep-link.js';
import { buildExportSidecar } from '../../src/utils/export-sidecar.js';

const { test, assert, run } = suite('colormap band');

const BAND = { min: -12, max: -4, colormap: 'inferno', reverse: false };

test('normalizeColormapBand rejects missing, non-finite and inverted ranges', () => {
  assert.equal(normalizeColormapBand(null), null);
  assert.equal(normalizeColormapBand({ min: NaN, max: 0 }), null);
  assert.equal(normalizeColormapBand({ min: -4, max: -12 }), null);
  assert.equal(normalizeColormapBand({ min: -4, max: -4 }), null);
  assert.deepEqual(normalizeColormapBand({ min: -12, max: -4 }),
    { min: -12, max: -4, colormap: 'inferno', reverse: false });
});

test('band fn stretches over its own range and misses outside it', () => {
  const fn = createColormapBandFn(BAND);
  assert.deepEqual(fn(-12), inferno(0));
  assert.deepEqual(fn(-4), inferno(1));
  assert.deepEqual(fn(-8), inferno(0.5));
  assert.equal(fn(-12.01), null);
  assert.equal(fn(-3.9), null);
  assert.equal(fn(NaN), null);
  assert.equal(createColormapBandFn(null), null);
});

test('band fn honours reverse and the shared stretch', () => {
  const rev = createColormapBandFn({ ...BAND, reverse: true });
  assert.deepEqual(rev(-12), inferno(1));
  const sq = createColormapBandFn(BAND, Math.sqrt);
  assert.deepEqual(sq(-10), inferno(Math.sqrt(0.25)));
});

test('colorbar ramp spans base ∪ band and samples band inside it', () => {
  const ramp = createColorbarRamp('grayscale', false, [-25, -5], BAND);
  assert.equal(ramp.min, -25);
  assert.equal(ramp.max, -4);
  assert.deepEqual(ramp.sample(-8), inferno(0.5));
  assert.deepEqual(ramp.sample(-25), grayscale(0));
  assert.deepEqual(ramp.sample(-15), grayscale(0.5));
  const plain = createColorbarRamp('grayscale', false, [-25, -5], null);
  assert.equal(plain.max, -5);
});

test('deep link round-trips band=min,max,cmap[,r]', () => {
  const view = { colormapBand: { min: -12.5, max: -3, colormap: 'turbo', reverse: true } };
  const link = buildShareLink({ baseUrl: 'https://x/', dataUrl: 'https://d/s.tif', dataType: 'cog', view });
  assert.ok(link.includes('band=-12.5%2C-3%2Cturbo%2Cr'), link);
  const parsed = parseShareLink(new URL(link).search);
  assert.deepEqual(parsed.view.colormapBand, view.colormapBand);
});

test('parseColormapBand defaults the colormap and ignores malformed input', () => {
  assert.deepEqual(parseColormapBand('-12,-4'), { min: -12, max: -4, colormap: 'inferno', reverse: false });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(parseColormapBand('-4,-12,turbo'), null);
    assert.equal(parseColormapBand('abc'), null);
  } finally { console.warn = warn; }
});

test('export sidecar records the band only when one was applied', () => {
  const base = { mode: 'rendered', colormap: 'grayscale', contrastLimits: [-25, 0] };
  const without = buildExportSidecar({ renderState: base });
  assert.ok(!('colormapBand' in without.render));
  const withBand = buildExportSidecar({ renderState: { ...base, colormapBand: BAND } });
  assert.deepEqual(withBand.render.colormapBand, BAND);
});

await run();
