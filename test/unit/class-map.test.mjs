/**
 * class-map.test.mjs — behavioral tests for the classification-map helpers in
 * src/loaders/cog-loader.js (extractColorTable, looksCategorical).
 *
 * These back the "class maps in comparison panels" feature: a palette GeoTIFF's
 * embedded ColorMap becomes a per-class RGB table, and integer-valued rasters
 * without a table are detected so class rendering can auto-enable with fallback
 * colors.
 *
 * Run: node test/unit/class-map.test.mjs
 */

import { extractColorTable, extractClassNames, looksCategorical } from '../../src/loaders/cog-loader.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('class-map helpers');

// ─── extractColorTable ───────────────────────────────────────────────────────

test('extractColorTable: 16-bit palette scales to 0–255 and unpacks per class', () => {
  // TIFF ColorMap layout: [R0..R(N-1), G0..G(N-1), B0..B(N-1)], 16-bit (0–65535).
  const N = 4;
  const colorMap = new Uint16Array(N * 3);
  // class 0 = black, class 1 = full red, class 2 = full green, class 3 = full blue
  colorMap[0 * 1 + 1] = 65535;            // R for class 1
  colorMap[N + 2] = 65535;                // G for class 2
  colorMap[2 * N + 3] = 65535;            // B for class 3

  const ct = extractColorTable({ PhotometricInterpretation: 3, ColorMap: colorMap });
  assert.ok(ct, 'returns a table');
  assert.equal(ct.entries, N);
  // class 1 → (255,0,0)
  assert.equal(ct.rgb[1 * 3 + 0], 255);
  assert.equal(ct.rgb[1 * 3 + 1], 0);
  // class 2 → (0,255,0)
  assert.equal(ct.rgb[2 * 3 + 1], 255);
  // class 3 → (0,0,255)
  assert.equal(ct.rgb[3 * 3 + 2], 255);
  // palette buffer is always 256 entries (768 bytes), rest zero
  assert.equal(ct.rgb.length, 256 * 3);
  assert.equal(ct.rgb[10 * 3 + 0], 0);
});

test('extractColorTable: already-8-bit ColorMap is passed through unscaled', () => {
  const N = 3;
  const colorMap = new Uint16Array(N * 3);
  colorMap[1] = 200;          // R class 1 = 200 (already ≤255)
  const ct = extractColorTable({ PhotometricInterpretation: 3, ColorMap: colorMap });
  assert.ok(ct);
  assert.equal(ct.rgb[1 * 3 + 0], 200);   // not rescaled down
});

test('extractColorTable: no ColorMap → null (not a palette image)', () => {
  assert.equal(extractColorTable({ PhotometricInterpretation: 1 }), null);
  assert.equal(extractColorTable({}), null);
  assert.equal(extractColorTable(null), null);
});

test('extractColorTable: non-palette photometric with a ColorMap → null', () => {
  // A grayscale (photometric 1) image that happens to carry a stray ColorMap
  // is not a class map.
  const cm = new Uint16Array(6);
  assert.equal(extractColorTable({ PhotometricInterpretation: 1, ColorMap: cm }), null);
});

// ─── extractClassNames ───────────────────────────────────────────────────────

test('extractClassNames: CATEGORY_NAMES_<n> indexed items', () => {
  const xml = `<GDALMetadata>
    <Item name="CATEGORY_NAMES_0">Nodata</Item>
    <Item name="CATEGORY_NAMES_1">Water</Item>
    <Item name="CATEGORY_NAMES_2">Forest</Item>
  </GDALMetadata>`;
  const names = extractClassNames({ GDAL_METADATA: xml });
  assert.ok(names);
  assert.equal(names[0], 'Nodata');
  assert.equal(names[1], 'Water');
  assert.equal(names[2], 'Forest');
});

test('extractClassNames: role="category" sample="N" form', () => {
  const xml = `<GDALMetadata>
    <Item name="CATEGORY" sample="3" role="category">Urban</Item>
    <Item name="CLASS_NAME" sample="5" role="category">Cropland</Item>
  </GDALMetadata>`;
  const names = extractClassNames({ GDAL_METADATA: xml });
  assert.ok(names);
  assert.equal(names[3], 'Urban');
  assert.equal(names[5], 'Cropland');
});

test('extractClassNames: band DESCRIPTION (role="description") is NOT a class name', () => {
  // Real GDAL output — a raster title on band 0. Must not become names[0].
  const xml = `<GDALMetadata>
    <Item name="DESCRIPTION" sample="0" role="description">C(arm1) vs L(arm3) regimes</Item>
  </GDALMetadata>`;
  assert.equal(extractClassNames({ GDAL_METADATA: xml }), null);
});

test('extractClassNames: single delimited CLASS_NAMES list', () => {
  const xml = `<GDALMetadata><Item name="CLASS_NAMES">Water,Forest,Urban</Item></GDALMetadata>`;
  const names = extractClassNames({ GDAL_METADATA: xml });
  assert.ok(names);
  assert.equal(names[0], 'Water');
  assert.equal(names[1], 'Forest');
  assert.equal(names[2], 'Urban');
});

test('extractClassNames: decodes XML entities in labels', () => {
  const xml = `<GDALMetadata><Item name="CATEGORY_NAMES_1">Shrub &amp; scrub</Item></GDALMetadata>`;
  const names = extractClassNames({ GDAL_METADATA: xml });
  assert.equal(names[1], 'Shrub & scrub');
});

test('extractClassNames: no GDAL_METADATA → null', () => {
  assert.equal(extractClassNames({}), null);
  assert.equal(extractClassNames({ GDAL_METADATA: '' }), null);
  assert.equal(extractClassNames(null), null);
});

test('extractClassNames: metadata without recognizable class items → null', () => {
  const xml = `<GDALMetadata><Item name="AREA_OR_POINT">Area</Item></GDALMetadata>`;
  assert.equal(extractClassNames({ GDAL_METADATA: xml }), null);
});

// ─── looksCategorical ────────────────────────────────────────────────────────

test('looksCategorical: small non-negative integers (with 0 background) → true', () => {
  const data = new Float32Array([0, 1, 2, 3, 0, 2, 1, 4, 0, 3]);
  assert.equal(looksCategorical(data), true);
});

test('looksCategorical: continuous float data → false', () => {
  const data = new Float32Array([0.13, 1.7, 22.5, 3.14159, 0.0001, 88.2]);
  assert.equal(looksCategorical(data), false);
});

test('looksCategorical: negative values → false', () => {
  const data = new Float32Array([0, 1, -2, 3]);
  assert.equal(looksCategorical(data), false);
});

test('looksCategorical: values above 255 → false', () => {
  const data = new Float32Array([0, 1, 2, 300]);
  assert.equal(looksCategorical(data), false);
});

test('looksCategorical: all-zero / all-NaN (no real data) → false', () => {
  assert.equal(looksCategorical(new Float32Array([0, 0, 0])), false);
  assert.equal(looksCategorical(new Float32Array([NaN, NaN])), false);
  assert.equal(looksCategorical(new Float32Array(0)), false);
  assert.equal(looksCategorical(null), false);
});

await run();
