/**
 * geotiff-roundtrip.test.mjs — behavioral round-trip tests for geotiff-writer.js.
 *
 * Writes small synthetic Float32 + RGBA GeoTIFFs with src/utils/geotiff-writer.js,
 * re-reads them with geotiff.js (already a dependency), and asserts that
 * dimensions, pixel values (Float32 bit-exact), ModelTiepoint, ModelPixelScale,
 * and the GeoKey EPSG code survive the round trip.
 *
 * Run: node test/unit/geotiff-roundtrip.test.mjs
 */

import { fromArrayBuffer } from 'geotiff';
import { writeFloat32GeoTIFF, writeRGBAGeoTIFF } from '../../src/utils/geotiff-writer.js';
import { suite } from './harness.mjs';

const { test, assert, assertClose, run } = suite('geotiff round-trip');

// ─── Synthetic fixtures ──────────────────────────────────────────────────────

const F32_W = 33;
const F32_H = 21;

/** Deterministic Float32 band with fractional values, zeros and NaN nodata. */
function makeFloat32Band(seed) {
  const band = new Float32Array(F32_W * F32_H);
  for (let i = 0; i < band.length; i++) {
    if (i % 47 === 0) band[i] = NaN;        // nodata
    else if (i % 31 === 0) band[i] = 0;      // zero nodata
    else band[i] = Math.fround(Math.sin(i * 0.37 + seed) * 1234.5678);
  }
  return band;
}

/** Deterministic RGBA image. */
function makeRGBA(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 7) % 256;
    rgba[i * 4 + 1] = (i * 13 + 5) % 256;
    rgba[i * 4 + 2] = (i * 29 + 11) % 256;
    rgba[i * 4 + 3] = i % 5 === 0 ? 0 : 255;
  }
  return rgba;
}

/** Assert two Float32Arrays are bit-exact (NaN-safe, per element). */
function assertBitExact(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  const aBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  const eBits = new Uint32Array(
    Float32Array.from(expected).buffer, 0, expected.length
  );
  for (let i = 0; i < actual.length; i++) {
    // NaN payload may legally differ between encoders; require both-NaN there,
    // bit-identity everywhere else.
    if (Number.isNaN(expected[i])) {
      assert.ok(Number.isNaN(actual[i]), `${label}[${i}]: expected NaN, got ${actual[i]}`);
    } else {
      assert.equal(aBits[i], eBits[i],
        `${label}[${i}]: bits differ (${actual[i]} vs ${expected[i]})`);
    }
  }
}

// ─── Float32 GeoTIFF ─────────────────────────────────────────────────────────

const F32_BOUNDS = [500000, 4000000, 500000 + F32_W * 10, 4000000 + F32_H * 10];
const F32_EPSG = 32610; // UTM 10N (projected)
const bandHH = makeFloat32Band(1);
const bandHV = makeFloat32Band(2);

let f32Image; // shared across Float32 tests (written once)

test('writeFloat32GeoTIFF: 2-band file opens and has correct dimensions', async () => {
  const buffer = await writeFloat32GeoTIFF(
    { HHHH: bandHH, HVHV: bandHV }, ['HHHH', 'HVHV'],
    F32_W, F32_H, F32_BOUNDS, F32_EPSG
  );
  assert.ok(buffer instanceof ArrayBuffer && buffer.byteLength > 0, 'non-empty ArrayBuffer');

  const tiff = await fromArrayBuffer(buffer);
  f32Image = await tiff.getImage();
  assert.equal(f32Image.getWidth(), F32_W, 'width');
  assert.equal(f32Image.getHeight(), F32_H, 'height');
  assert.equal(f32Image.getSamplesPerPixel(), 2, 'samplesPerPixel');
  assert.deepEqual(Array.from(f32Image.fileDirectory.BitsPerSample), [32, 32], 'BitsPerSample');
  assert.deepEqual(Array.from(f32Image.fileDirectory.SampleFormat), [3, 3], 'SampleFormat = IEEE float');
});

test('Float32 round-trip: pixel values are bit-exact (both bands)', async () => {
  const rasters = await f32Image.readRasters();
  assert.equal(rasters.length, 2, 'two bands returned');
  assert.ok(rasters[0] instanceof Float32Array, 'band 0 is Float32Array');
  assertBitExact(rasters[0], bandHH, 'HHHH');
  assertBitExact(rasters[1], bandHV, 'HVHV');
});

test('Float32 round-trip: ModelTiepoint survives', async () => {
  const tiepoint = Array.from(f32Image.fileDirectory.ModelTiepoint);
  // Pixel (0,0,0) → world (minX, maxY, 0)
  assert.deepEqual(tiepoint, [0, 0, 0, F32_BOUNDS[0], F32_BOUNDS[3], 0], 'ModelTiepoint');
});

test('Float32 round-trip: ModelPixelScale survives', async () => {
  const scale = Array.from(f32Image.fileDirectory.ModelPixelScale);
  const expX = (F32_BOUNDS[2] - F32_BOUNDS[0]) / F32_W;
  const expY = (F32_BOUNDS[3] - F32_BOUNDS[1]) / F32_H;
  assertClose(scale[0], expX, 1e-9, 'pixelScaleX');
  assertClose(scale[1], expY, 1e-9, 'pixelScaleY');
  assert.equal(scale[2], 0, 'pixelScaleZ');
});

test('Float32 round-trip: projected GeoKey EPSG code survives', async () => {
  const geoKeys = f32Image.getGeoKeys();
  assert.equal(geoKeys.ProjectedCSTypeGeoKey, F32_EPSG, 'ProjectedCSTypeGeoKey');
  assert.equal(geoKeys.GTModelTypeGeoKey, 1, 'GTModelTypeGeoKey = projected');
  assert.equal(geoKeys.GTRasterTypeGeoKey, 1, 'GTRasterTypeGeoKey = PixelIsArea');
});

test('Float32 round-trip: bounding box reconstructs from tiepoint + scale', async () => {
  const bbox = f32Image.getBoundingBox();
  for (let i = 0; i < 4; i++) {
    assertClose(bbox[i], F32_BOUNDS[i], 1e-6, `bbox[${i}]`);
  }
});

test('Float32 round-trip: GDAL_NODATA marks NaN', async () => {
  const nodata = f32Image.fileDirectory.GDAL_NODATA;
  assert.ok(typeof nodata === 'string', 'GDAL_NODATA present');
  assert.equal(nodata.replace(/\0+$/, '').trim(), 'nan', 'GDAL_NODATA value');
});

test('writeFloat32GeoTIFF: single-band file round-trips bit-exact', async () => {
  const band = makeFloat32Band(3);
  const buffer = await writeFloat32GeoTIFF(
    { VV: band }, ['VV'], F32_W, F32_H, F32_BOUNDS, F32_EPSG
  );
  const image = await (await fromArrayBuffer(buffer)).getImage();
  assert.equal(image.getSamplesPerPixel(), 1, 'single band');
  const rasters = await image.readRasters();
  assertBitExact(rasters[0], band, 'VV');
});

test('writeFloat32GeoTIFF: rejects band size mismatch', async () => {
  await assert.rejects(
    () => writeFloat32GeoTIFF({ HHHH: new Float32Array(10) }, ['HHHH'], F32_W, F32_H, F32_BOUNDS, F32_EPSG),
    /size mismatch/,
    'size mismatch throws'
  );
});

// ─── RGBA GeoTIFF ────────────────────────────────────────────────────────────

const RGBA_W = 40;
const RGBA_H = 30;
const RGBA_BOUNDS = [-123.5, 45.0, -122.5, 46.0];
const RGBA_EPSG = 4326; // geographic
const rgbaData = makeRGBA(RGBA_W, RGBA_H);

let rgbaImage; // shared across RGBA tests

test('writeRGBAGeoTIFF: file opens and has correct dimensions', async () => {
  const buffer = await writeRGBAGeoTIFF(rgbaData, RGBA_W, RGBA_H, RGBA_BOUNDS, RGBA_EPSG);
  assert.ok(buffer instanceof ArrayBuffer && buffer.byteLength > 0, 'non-empty ArrayBuffer');

  const tiff = await fromArrayBuffer(buffer);
  rgbaImage = await tiff.getImage();
  assert.equal(rgbaImage.getWidth(), RGBA_W, 'width');
  assert.equal(rgbaImage.getHeight(), RGBA_H, 'height');
  assert.equal(rgbaImage.getSamplesPerPixel(), 4, 'samplesPerPixel = RGBA');
});

test('RGBA round-trip: pixel values exact through DEFLATE + predictor', async () => {
  const interleaved = await rgbaImage.readRasters({ interleave: true });
  assert.equal(interleaved.length, RGBA_W * RGBA_H * 4, 'interleaved length');
  for (let i = 0; i < rgbaData.length; i++) {
    if (interleaved[i] !== rgbaData[i]) {
      assert.fail(`RGBA[${i}]: expected ${rgbaData[i]}, got ${interleaved[i]}`);
    }
  }
  assert.ok(true, 'all RGBA bytes identical');
});

test('RGBA round-trip: ModelTiepoint + ModelPixelScale survive', async () => {
  const tiepoint = Array.from(rgbaImage.fileDirectory.ModelTiepoint);
  assert.deepEqual(tiepoint, [0, 0, 0, RGBA_BOUNDS[0], RGBA_BOUNDS[3], 0], 'ModelTiepoint');

  const scale = Array.from(rgbaImage.fileDirectory.ModelPixelScale);
  assertClose(scale[0], (RGBA_BOUNDS[2] - RGBA_BOUNDS[0]) / RGBA_W, 1e-12, 'pixelScaleX');
  assertClose(scale[1], (RGBA_BOUNDS[3] - RGBA_BOUNDS[1]) / RGBA_H, 1e-12, 'pixelScaleY');
});

test('RGBA round-trip: geographic GeoKey EPSG code survives', async () => {
  const geoKeys = rgbaImage.getGeoKeys();
  assert.equal(geoKeys.GeographicTypeGeoKey, RGBA_EPSG, 'GeographicTypeGeoKey');
  assert.equal(geoKeys.GTModelTypeGeoKey, 2, 'GTModelTypeGeoKey = geographic');
});

test('RGBA round-trip: multi-tile image (600x520, 4 tiles) is pixel-exact', async () => {
  // Complements the single-tile case above (which regression-guards the
  // inline-TileOffsets bug): >512px images exercise the overflow-array path.
  const w = 600, h = 520;
  const data = makeRGBA(w, h);
  const buffer = await writeRGBAGeoTIFF(data, w, h, RGBA_BOUNDS, RGBA_EPSG, { generateOverviews: false });
  const image = await (await fromArrayBuffer(buffer)).getImage();
  assert.equal(image.getWidth(), w, 'width');
  assert.equal(image.getHeight(), h, 'height');
  const bands = await image.readRasters();
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 4; c++) {
      if (bands[c][i] !== data[i * 4 + c]) {
        assert.fail(`pixel ${i} channel ${c}: expected ${data[i * 4 + c]}, got ${bands[c][i]}`);
      }
    }
  }
  assert.ok(true, 'all multi-tile RGBA bytes identical');
});

test('writeRGBAGeoTIFF: rejects RGBA size mismatch', async () => {
  await assert.rejects(
    () => writeRGBAGeoTIFF(new Uint8ClampedArray(16), RGBA_W, RGBA_H, RGBA_BOUNDS, RGBA_EPSG),
    /size mismatch/,
    'size mismatch throws'
  );
});

await run();
