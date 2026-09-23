/**
 * vrt-loader.test.mjs — GDAL VRT parsing + lazy window reads.
 *
 * Fixtures in fixtures/vrt/ were built by real GDAL (see
 * fixtures/generate-vrt-fixtures.mjs), including GDAL's own rendering of
 * each VRT (*_expected.tif). The loader must match GDAL pixel-for-pixel,
 * both from local Files and over HTTP Range from a URL.
 *
 * Run: node test/unit/vrt-loader.test.mjs
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { parseXml, parseVRT, epsgFromSrs, resolveVrtSourcePath } from '../../src/loaders/vrt-parser.js';
import { loadVRT, isVRTPath, polarizationFromName } from '../../src/loaders/vrt-loader.js';
import { rgbContrastFromBandStats } from '../../src/utils/sar-composites.js';
import { pathSegments, candidatePaths, dirHandleSource, dirEntrySource, makeFolderResolver } from '../../src/loaders/vrt-local-sources.js';
import { powerBandStats, toDb } from '../../src/utils/stats.js';
import { detectFormat, bucketByFormat } from '../../src/loaders/types.js';
import { inferDataTypeFromUrl } from '../../src/utils/deep-link.js';
import { unproxyUrl } from '../../src/utils/proxy.js';
import { suite } from './harness.mjs';

const { test, assert, run } = suite('vrt loader');

// geotiff.js fromBlob reads slices with FileReader, which browsers (and
// workers) have and Node does not. Minimal stand-in for the one method used.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (buf) => { this.result = buf; this.onload?.({ target: this }); this.onloadend?.({ target: this }); },
      (err) => { this.error = err; this.onerror?.({ target: this }); });
  }
};

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vrt');
const fixtureFile = (name) => new File([readFileSync(join(FIX, name))], name);
const allFiles = () => readdirSync(FIX).filter(n => !n.endsWith('.vrt')).map(fixtureFile);

async function readExpected(name) {
  const buf = readFileSync(join(FIX, name));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const img = await tiff.getImage();
  const [data] = await img.readRasters();
  return { data, width: img.getWidth(), height: img.getHeight(), nodata: img.getGDALNoData() };
}

/** Loader NaN ⇔ GDAL nodata; everything else equal within tol. */
function assertMatchesGdal(actual, expected, tol = 0) {
  assert.equal(actual.length, expected.data.length);
  let mismatches = 0, first = null;
  for (let i = 0; i < actual.length; i++) {
    const e = expected.data[i];
    const eMissing = Number.isNaN(e) || (expected.nodata !== null && e === expected.nodata);
    const a = actual[i];
    const ok = eMissing ? Number.isNaN(a) : Math.abs(a - e) <= tol;
    if (!ok) { mismatches++; first ??= { i, a, e }; }
  }
  assert.equal(mismatches, 0, `${mismatches} pixels differ from GDAL; first at ${JSON.stringify(first)}`);
}

// ─── Parser ─────────────────────────────────────────────────────────────

test('parseXml handles entities, self-closing tags, comments', () => {
  const el = parseXml('<?xml version="1.0"?><!-- c --><A k="x &amp; y"><B v=\'1\'/><C>a &lt; b</C></A>');
  assert.equal(el.name, 'A');
  assert.equal(el.attrs.k, 'x & y');
  assert.equal(el.children[0].name, 'B');
  assert.equal(el.children[0].attrs.v, '1');
  assert.equal(el.children[1].text, 'a < b');
});

test('epsgFromSrs picks the CRS authority, not the datum/ellipsoid', () => {
  const wkt = readFileSync(join(FIX, 'mosaic.vrt'), 'utf8').match(/<SRS[^>]*>([\s\S]*?)<\/SRS>/)[1];
  assert.equal(epsgFromSrs(wkt), 'EPSG:32610');
  assert.equal(epsgFromSrs('EPSG:3413'), 'EPSG:3413');
  assert.equal(epsgFromSrs('GEOGCRS["WGS 84",DATUM["x",ELLIPSOID["WGS 84",6378137,298.25,ID["EPSG",7030]]],ID["EPSG",4326]]'), 'EPSG:4326');
  assert.equal(epsgFromSrs('LOCAL_CS["arbitrary"]'), null);
});

test('resolveVrtSourcePath: relative, /vsicurl/, /vsis3/, local', () => {
  const base = 'https://host.example/data/stack/m.vrt?sig=abc';
  assert.deepEqual(resolveVrtSourcePath('tiles/a.tif', true, base), { kind: 'url', url: 'https://host.example/data/stack/tiles/a.tif' });
  assert.deepEqual(resolveVrtSourcePath('../b.tif', true, base), { kind: 'url', url: 'https://host.example/data/b.tif' });
  assert.deepEqual(resolveVrtSourcePath('/vsicurl/https://x.org/c.tif', false, base), { kind: 'url', url: 'https://x.org/c.tif' });
  assert.deepEqual(resolveVrtSourcePath('/vsis3/bkt/k/d.tif', false, base), { kind: 'url', url: 's3://bkt/k/d.tif' });
  assert.throws(() => resolveVrtSourcePath('/mnt/data/e.tif', false, base), /local absolute path/);
  assert.throws(() => resolveVrtSourcePath('HDF5:"f.h5"://x', false, base), /subdatasets/);
  assert.deepEqual(resolveVrtSourcePath('/mnt/data/e.tif', false, null), { kind: 'local', name: 'e.tif', path: '/mnt/data/e.tif' });
});

test('parseVRT reads grid, bands, and ComplexSource fields', () => {
  const v = parseVRT(readFileSync(join(FIX, 'subset_scaled.vrt'), 'utf8'));
  assert.equal(v.width, 20);
  assert.equal(v.height, 15);
  assert.deepEqual(v.geoTransform, [500005, 1, 0, 4000026, 0, -1]);
  assert.equal(v.crs, 'EPSG:32610');
  const s = v.bands[0].sources[0];
  assert.deepEqual(s.srcRect, { x: 5, y: 4, w: 20, h: 15 });
  assert.ok(Number.isNaN(s.nodata));
  assert.equal(s.scaleRatio, 0.000833333);
  assert.equal(parseVRT(readFileSync(join(FIX, 'separate.vrt'), 'utf8')).bands.length, 2);
});

test('parseVRT rejects warped VRTs and pixel functions with a clear message', () => {
  assert.throws(() => parseVRT('<VRTDataset subClass="VRTWarpedDataset" rasterXSize="1" rasterYSize="1"/>'), /Warped VRTs/);
  assert.throws(() => parseVRT(
    '<VRTDataset rasterXSize="1" rasterYSize="1"><VRTRasterBand band="1" subClass="VRTDerivedRasterBand">'
    + '<PixelFunctionType>sum</PixelFunctionType></VRTRasterBand></VRTDataset>'), /pixel function "sum"/);
  assert.throws(() => parseVRT('<GDAL/>'), /Not a VRT/);
});

test('isVRTPath ignores query strings', () => {
  assert.ok(isVRTPath('https://x/y/m.vrt?X-Amz-Signature=1'));
  assert.ok(!isVRTPath('https://x/y/m.tif?a=b.vrt'));
});

test('app routing: .vrt detected for drops, ?url= links, and un-proxied', () => {
  assert.equal(detectFormat('stack.VRT'), 'vrt');
  assert.deepEqual(bucketByFormat([{ name: 'm.vrt' }, { name: 'a.tif' }]).vrt.map(f => f.name), ['m.vrt']);
  assert.equal(inferDataTypeFromUrl('https://h/m.vrt?sig=1'), 'cog');
  const raw = 'https://bucket.example/data/m.vrt';
  assert.equal(unproxyUrl(`http://localhost:5173/stac-proxy/${encodeURIComponent(raw)}`), raw);
  assert.equal(unproxyUrl(`https://w.workers.dev/proxy?url=${encodeURIComponent(raw)}&t=tok`), raw);
  assert.equal(unproxyUrl(raw), raw);
});

// ─── Loader vs GDAL (local Files) ───────────────────────────────────────

for (const name of ['plain', 'mosaic', 'subset_scaled']) {
  test(`${name}.vrt matches GDAL's rendering (local files)`, async () => {
    const src = await loadVRT(fixtureFile(`${name}.vrt`), { files: allFiles() });
    const exp = await readExpected(`${name}_expected.tif`);
    assert.equal(src.width, exp.width);
    assert.equal(src.height, exp.height);
    const got = await src.readWindow(0, 0, src.width, src.height, src.width, src.height);
    assertMatchesGdal(got, exp, name === 'subset_scaled' ? 1e-6 : 0);
  });
}

test('mosaic georeferencing: worldBounds, resolution, crs, pixel-space bounds', async () => {
  const src = await loadVRT(fixtureFile('mosaic.vrt'), { files: allFiles() });
  assert.deepEqual(src.bounds, [0, 0, 70, 60]);
  assert.deepEqual(src.worldBounds, [500000, 3999970, 500070, 4000030]);
  assert.deepEqual(src.resolution, [1, -1]);
  assert.equal(src.crs, 'EPSG:32610');
  assert.equal(src.nodata, 0);
  assert.equal(src.vrt.sourceCount, 3);
});

test('band 2 of a -separate VRT', async () => {
  const src = await loadVRT(fixtureFile('separate.vrt'), { files: allFiles(), band: 2 });
  const exp = await readExpected('separate_b2_expected.tif');
  assertMatchesGdal(await src.readWindow(0, 0, 40, 30, 40, 30), exp);
  assert.equal(src.vrt.bandCount, 2);
});

test('getExportStripe box-averages the GDAL grid', async () => {
  const src = await loadVRT(fixtureFile('mosaic.vrt'), { files: allFiles() });
  const exp = await readExpected('mosaic_expected.tif');
  const ml = 2;
  const { bands } = await src.getExportStripe({ startRow: 5, numRows: 10, ml, startCol: 3, numCols: 20 });
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 20; c++) {
      let sum = 0, n = 0;
      for (let dr = 0; dr < ml; dr++) for (let dc = 0; dc < ml; dc++) {
        const v = exp.data[((5 + r) * ml + dr) * 70 + (3 + c) * ml + dc];
        if (v !== 0) { sum += v; n++; }
      }
      const want = n ? sum / n : NaN;
      const got = bands.band0[r * 20 + c];
      if (Number.isNaN(want)) assert.ok(Number.isNaN(got));
      else assert.ok(Math.abs(got - want) < 1e-3, `stripe (${r},${c}) ${got} vs ${want}`);
    }
  }
});

test('getPixelValue and getTile', async () => {
  const src = await loadVRT(fixtureFile('mosaic.vrt'), { files: allFiles() });
  const exp = await readExpected('mosaic_expected.tif');
  assert.equal(await src.getPixelValue(12, 35), exp.data[12 * 70 + 35]);
  assert.ok(Number.isNaN(await src.getPixelValue(59, 69))); // uncovered corner
  // Whole scene as one tile: world y is flipped (0 = bottom)
  const tile = await src.getTile({ x: 0, y: 0, z: 0, bbox: { left: 0, right: 70, top: 60, bottom: 0 } });
  assert.equal(tile.width, 256);
  assert.equal(tile.data.length, 256 * 256);
  // Top-left output pixel samples VRT pixel (0,0) = a.tif's first value
  assert.equal(tile.data[0], 100);
  assert.equal(await src.getTile({ x: 9, y: 9, z: 0, bbox: { left: 500, right: 600, top: 600, bottom: 500 } }), null);
});

test('decimated reads use the source COG overview', async () => {
  const src = await loadVRT(fixtureFile('cog.vrt'), { files: allFiles() });
  // 4× decimation → 32×24 overview. AVERAGE overview values are block
  // means (col ≈ 4k+1.5, rows mix 0/1000), which no full-res pixel has.
  const got = await src.readWindow(0, 0, 128, 96, 32, 24);
  const buf = readFileSync(join(FIX, 'd_cog.tif'));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ovImg = [];
  for (let i = 0; i < await tiff.getImageCount(); i++) ovImg.push(await tiff.getImage(i));
  const ov = ovImg.find(im => im.getWidth() === 32);
  const [want] = await ov.readRasters();
  assert.deepEqual(Array.from(got), Array.from(want));
  // Full-res read is exact
  const full = await src.readWindow(0, 0, 128, 96, 128, 96);
  assert.equal(full[1 * 128 + 7], 1007);
});

// A source with no overviews, read at 8× decimation → synthetic overview:
// each output pixel is the mean of the source's 8×8 block (nodata excluded).
const singleSourceVrt = (file, extra = '') => new File([
  `<VRTDataset rasterXSize="40" rasterYSize="30"><VRTRasterBand dataType="Float32" band="1">
     <ComplexSource><SourceFilename relativeToVRT="1">${file}</SourceFilename><SourceBand>1</SourceBand>${extra}</ComplexSource>
   </VRTRasterBand></VRTDataset>`], `${file}.vrt`);

test('sources without overviews get block-averaged synthetic overviews when zoomed out', async () => {
  // a.tif: value = 100 + r*40 + c; implicit SrcRect/DstRect (read from the header)
  const src = await loadVRT(singleSourceVrt('a.tif'), { files: allFiles() });
  const got = await src.readWindow(0, 0, 40, 24, 5, 3); // 8× in both axes
  for (let oy = 0; oy < 3; oy++) {
    for (let ox = 0; ox < 5; ox++) {
      const want = 100 + (8 * oy + 3.5) * 40 + (8 * ox + 3.5);
      assert.ok(Math.abs(got[oy * 5 + ox] - want) < 1e-3, `(${oy},${ox}) ${got[oy * 5 + ox]} vs ${want}`);
    }
  }
  // Below 8× the read stays exact nearest-neighbour from full resolution
  const near = await src.readWindow(0, 0, 40, 30, 10, 10); // 4× × 3×
  assert.equal(near[0], 100 + 1 * 40 + 2);
});

test('synthetic overviews exclude the source NODATA value from block means', async () => {
  // b.tif has a zero block at rows 10–19, cols 0–9; with NODATA 0 the block
  // (rows 8–15, cols 0–7) averages only rows 8–9.
  const src = await loadVRT(singleSourceVrt('b.tif', '<NODATA>0</NODATA>'), { files: allFiles() });
  const got = await src.readWindow(0, 0, 40, 24, 5, 3);
  const want = 5000 + 8.5 * 40 + 3.5;
  assert.ok(Math.abs(got[1 * 5 + 0] - want) < 1e-3, `${got[5]} vs ${want}`);
  // Synthetic blocks follow the source file's own grid (as GDAL overviews
  // do), not the VRT's SrcRect. c.tif's first 8×8 block minus its one
  // NODATA pixel (9000 at 0,0) averages the other 63.
  const edge = await loadVRT(new File([
    `<VRTDataset rasterXSize="16" rasterYSize="16"><VRTRasterBand dataType="Float32" band="1">
       <ComplexSource><SourceFilename relativeToVRT="1">c.tif</SourceFilename><SourceBand>1</SourceBand>
         <SrcRect xOff="0" yOff="0" xSize="20" ySize="15"/><DstRect xOff="0" yOff="0" xSize="20" ySize="15"/><NODATA>9000</NODATA>
       </ComplexSource></VRTRasterBand></VRTDataset>`], 'c.vrt'), { files: allFiles() });
  let sum = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (r || c) sum += 9000 + r * 20 + c;
  assert.ok(Math.abs((await edge.readWindow(0, 0, 16, 16, 2, 2))[0] - sum / 63) < 1e-3);
});

test('missing companion files fail the load, all listed at once', async () => {
  await assert.rejects(
    loadVRT(fixtureFile('mosaic.vrt'), { files: [fixtureFile('a.tif')] }),
    (err) => {
      assert.equal(err.code, 'VRT_MISSING_SOURCES');
      assert.deepEqual(err.missing, ['b.tif', 'c.tif']);
      assert.match(err.message, /2 of 3 VRT source files not found/);
      return true;
    });
});

// ─── Absolute local source paths + picked folders ───────────────────────

// A gdalbuildvrt run on the data machine writes absolute paths
// (relativeToVRT="0"), like /mnt/archive/nisar_breakup_2026/gcov/<scene>.tif.
const absMosaic = () => new File([readFileSync(join(FIX, 'mosaic.vrt'), 'utf8')
  .replace(/relativeToVRT="1">([^<]+)</g, 'relativeToVRT="0">/mnt/archive/campaign/gcov/$1<')], 'abs_mosaic.vrt');

/** Minimal FileSystemDirectoryHandle over a real folder, named `name`, with optional subfolders. */
function fakeDirHandle(name, dirPath, subdirs = {}) {
  const lookups = [];
  const handle = {
    name,
    kind: 'directory',
    lookups,
    async getDirectoryHandle(sub) {
      lookups.push(`dir:${sub}`);
      if (!subdirs[sub]) throw new DOMException(`${sub} not found`, 'NotFoundError');
      return subdirs[sub];
    },
    async getFileHandle(file) {
      lookups.push(`file:${file}`);
      let buf;
      try { buf = readFileSync(join(dirPath, file)); } catch {
        throw new DOMException(`${file} not found`, 'NotFoundError');
      }
      return { kind: 'file', name: file, getFile: async () => new File([buf], file) };
    },
  };
  return handle;
}

test('candidatePaths prefers the suffix after the picked folder\'s own name', () => {
  const segs = pathSegments('/mnt/archive/campaign/gcov/s1_HH.tif');
  assert.deepEqual(candidatePaths(segs, 'gcov')[0], ['s1_HH.tif']);
  assert.deepEqual(candidatePaths(segs, 'campaign')[0], ['gcov', 's1_HH.tif']);
  assert.deepEqual(candidatePaths(segs, 'elsewhere').map(c => c.join('/')).slice(0, 2), ['s1_HH.tif', 'gcov/s1_HH.tif']);
  assert.deepEqual(pathSegments('..\\..\\gcov\\x.tif'), ['gcov', 'x.tif']);
});

test('absolute-path VRT loads from the picked source folder and matches GDAL', async () => {
  const gcov = fakeDirHandle('gcov', FIX);
  const src = await loadVRT(absMosaic(), { findFile: makeFolderResolver([dirHandleSource(gcov)]) });
  assertMatchesGdal(await src.readWindow(0, 0, 70, 60, 70, 60), await readExpected('mosaic_expected.tif'));
  // Direct name lookups — the folder is never listed
  assert.ok(gcov.lookups.every(l => l.startsWith('file:')));
});

test('picking an ancestor folder also resolves (gcov/ subfolder)', async () => {
  const campaign = fakeDirHandle('campaign', '/nonexistent', { gcov: fakeDirHandle('gcov', FIX) });
  const src = await loadVRT(absMosaic(), { findFile: makeFolderResolver([dirHandleSource(campaign)]) });
  assertMatchesGdal(await src.readWindow(0, 0, 70, 60, 70, 60), await readExpected('mosaic_expected.tif'));
});

test('a folder without the sources still reports every missing path', async () => {
  const wrong = fakeDirHandle('elsewhere', '/nonexistent');
  await assert.rejects(
    loadVRT(absMosaic(), { findFile: makeFolderResolver([dirHandleSource(wrong)]) }),
    (err) => err.code === 'VRT_MISSING_SOURCES' && err.missing.length === 3
      && err.missing[0] === '/mnt/archive/campaign/gcov/a.tif');
});

test('big local mosaics resolve a sample at load and the rest on demand', async () => {
  // 10 copies of a.tif side by side, absolute paths; s7 is missing from disk
  const srcs = Array.from({ length: 10 }, (_, i) =>
    `<ComplexSource><SourceFilename relativeToVRT="0">/mnt/archive/gcov/s${i}.tif</SourceFilename><SourceBand>1</SourceBand>
       <SrcRect xOff="0" yOff="0" xSize="40" ySize="30"/><DstRect xOff="${i * 40}" yOff="0" xSize="40" ySize="30"/></ComplexSource>`).join('');
  const vrt = new File([`<VRTDataset rasterXSize="400" rasterYSize="30"><VRTRasterBand dataType="Float32" band="1">${srcs}</VRTRasterBand></VRTDataset>`], 'row.vrt');
  const a = readFileSync(join(FIX, 'a.tif'));
  const looked = [];
  const findFile = async (p) => {
    looked.push(p);
    return p.endsWith('s7.tif') ? null : new File([a], p.split('/').pop());
  };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...m) => warnings.push(m.join(' '));
  try {
    const src = await loadVRT(vrt, { findFile });
    assert.deepEqual(looked.map(p => p.split('/').pop()).sort(), ['s0.tif', 's4.tif', 's9.tif']);
    // Reading s1–s2 looks up just those two
    const got = await src.readWindow(40, 0, 120, 30, 80, 30);
    assert.equal(got[0], 100);
    assert.equal(looked.length, 5);
    // The missing s7 renders as a hole, with one warning, instead of failing the tile
    const hole = await src.readWindow(240, 0, 360, 30, 120, 30);
    assert.equal(hole[0], 100);              // s6
    assert.ok(Number.isNaN(hole[40]));       // s7
    assert.equal(hole[80], 100);             // s8
    assert.equal(warnings.filter(w => /s7\.tif/.test(w)).length, 1);
    // Auto-contrast sample is bounded and skips the hole too
    assert.ok((await src.readSample(4)).some(v => v === 100));
  } finally {
    console.warn = warn;
  }
});

test('dropped-folder entries resolve through dirEntrySource', async () => {
  // FileSystemDirectoryEntry.getFile(path, opts, ok, err) — callback API
  const entry = {
    name: 'gcov',
    getFile(path, _opts, ok, fail) {
      let buf;
      try { buf = readFileSync(join(FIX, path)); } catch (e) { fail(e); return; }
      ok({ file: (res) => res(new File([buf], path.split('/').pop())) });
    },
  };
  const src = await loadVRT(absMosaic(), { findFile: makeFolderResolver([dirEntrySource(entry)]) });
  assert.equal(src.vrt.sourceCount, 3);
});

// ─── Band stacks → RGB composite ────────────────────────────────────────

test('polarizationFromName: descriptions and product filenames', () => {
  assert.equal(polarizationFromName('HH'), 'HHHH');
  assert.equal(polarizationFromName('HVHV'), 'HVHV');
  assert.equal(polarizationFromName('pacaya_full_hh.tif'), 'HHHH');
  assert.equal(polarizationFromName('/vsicurl/https://h/x/OPERA_L2_RTC-S1_T001_VH.tif'), 'VHVH');
  assert.equal(polarizationFromName('scene_VV.tif?sig=HH'), 'VVVV');
  assert.equal(polarizationFromName('HHVV'), null);        // off-diagonal term
  assert.equal(polarizationFromName('dhhaka_mosaic.tif'), null); // letters inside a word
  assert.equal(polarizationFromName(null), null);
});

test('-separate HH/HV stack opens as a dual-pol-h composite matching GDAL per band', async () => {
  const src = await loadVRT(fixtureFile('stack.vrt'), { files: allFiles(), composite: 'auto' });
  assert.equal(src.composite, 'dual-pol-h');
  assert.deepEqual(src.requiredPols, ['HHHH', 'HVHV']);
  assert.deepEqual(src.vrt.bandMap, { HHHH: 1, HVHV: 2 });
  assert.equal(src.getTile, src.getRGBTile);
  assert.deepEqual(src.pixelSpacing, { x: 1, y: 1 });

  const { bands } = await src.getExportStripe({ startRow: 0, numRows: 30, ml: 1, startCol: 0, numCols: 40 });
  assertMatchesGdal(bands.HHHH, await readExpected('stack_b1_expected.tif'));
  assertMatchesGdal(bands.HVHV, await readExpected('stack_b2_expected.tif'));

  const tile = await src.getRGBTile({ x: 0, y: 0, z: 0, bbox: { left: 0, right: 40, top: 30, bottom: 0 } });
  assert.equal(tile.compositeId, 'dual-pol-h');
  assert.equal(tile.bands.HHHH.length, 256 * 256);
  assert.equal(tile.bands.HVHV[0], bands.HVHV[0]);

  // Stats feed the app's per-channel contrast: HH ≈ 5× HV → ~7 dB apart
  const { HHHH, HVHV } = src.bandStats;
  assert.ok(HHHH.count > 0 && HVHV.count > 0);
  assert.ok(Math.abs(HHHH.mean_db - HVHV.mean_db - 6.5) < 1, `HH−HV ${HHHH.mean_db - HVHV.mean_db} dB`);
});

test('band <Description> wins over neutral filenames', async () => {
  const xml = readFileSync(join(FIX, 'separate.vrt'), 'utf8')
    .replace('<VRTRasterBand dataType="Float32" band="1">', '<VRTRasterBand dataType="Float32" band="1"><Description>VV</Description>')
    .replace('<VRTRasterBand dataType="Float32" band="2">', '<VRTRasterBand dataType="Float32" band="2"><Description>VH</Description>');
  const src = await loadVRT(new File([xml], 'described.vrt'), { files: allFiles(), composite: 'auto' });
  assert.equal(src.composite, 'dual-pol-v');
  assert.deepEqual(src.vrt.bandMap, { VVVV: 1, VHVH: 2 });
});

test('composite: auto falls back to single band; explicit id fails clearly', async () => {
  const single = await loadVRT(fixtureFile('separate.vrt'), { files: allFiles(), composite: 'auto' });
  assert.equal(single.composite, undefined);
  assert.deepEqual(single.vrt.bandPolarizations, [null, null]);
  assert.equal(typeof single.readPreview, 'function');
  await assert.rejects(
    loadVRT(fixtureFile('stack.vrt'), { files: allFiles(), composite: 'dual-pol-v' }),
    /cannot form composite 'dual-pol-v': no band for VVVV, VHVH/);
});

test('rgbContrastFromBandStats: dB windows per channel, ratio window for B', () => {
  const stats = {
    HHHH: { mean_value: 0.1, sample_stddev: 0.05, mean_db: -10, sample_stddev_db: 2, count: 9 },
    HVHV: { mean_value: 0.02, sample_stddev: 0.01, mean_db: -17, sample_stddev_db: 1, count: 9 },
  };
  const db = rgbContrastFromBandStats('dual-pol-h', stats, ['HHHH', 'HVHV'], true);
  assert.deepEqual(db.R, [-14, -6]);
  assert.deepEqual(db.G, [-20, -14]); // σ floor: ±3 dB
  assert.ok(Math.abs(db.B[0] - (toDb(5, 0) - 5)) < 1e-9);
  const lin = rgbContrastFromBandStats('dual-pol-h', stats, ['HHHH', 'HVHV'], false);
  assert.deepEqual(lin.R, [0, 0.2]);
  assert.equal(rgbContrastFromBandStats('dual-pol-h', {}, ['HHHH', 'HVHV'], true), null);
});

test('powerBandStats ignores NaN, zero, and negatives', () => {
  const s = powerBandStats(new Float32Array([NaN, 0, -1, 1, 100]));
  assert.equal(s.count, 2);
  assert.equal(s.mean_value, 50.5);
  assert.equal(s.mean_db, 10);
  assert.equal(powerBandStats(new Float32Array([NaN, 0])), null);
});

// ─── Loader over HTTP Range (URL mode) ──────────────────────────────────

function startRangeServer() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // /proxy/<encoded upstream> — stands in for the CORS proxy
    const m = /^\/proxy\/(.+)$/.exec(path);
    const target = m ? new URL(m[1]).pathname : path;
    let body;
    try { body = readFileSync(join(FIX, target.replace(/^\/data\//, ''))); } catch {
      res.writeHead(404); res.end(); return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

test('URL VRT: relative sources resolve against the raw URL, then go through resolveUrl', async () => {
  const { server, requests, port } = await startRangeServer();
  try {
    const origin = `http://127.0.0.1:${port}`;
    const upstream = 'https://bucket.example/data/mosaic.vrt';
    const resolveUrl = (u) => `${origin}/proxy/${encodeURIComponent(u)}`;
    const src = await loadVRT(upstream, { resolveUrl });
    const exp = await readExpected('mosaic_expected.tif');
    assertMatchesGdal(await src.readWindow(0, 0, 70, 60, 70, 60), exp);
    const fetched = requests.map(r => decodeURIComponent(r));
    for (const f of ['mosaic.vrt', 'a.tif', 'b.tif', 'c.tif']) {
      assert.ok(fetched.some(r => r.endsWith(`https://bucket.example/data/${f}`)), `proxied fetch of ${f}`);
    }
  } finally {
    server.close();
  }
});

test('URL VRT: a tile only opens the sources it overlaps', async () => {
  const { server, requests, port } = await startRangeServer();
  try {
    const src = await loadVRT(`http://127.0.0.1:${port}/data/mosaic.vrt`);
    requests.length = 0;
    // Top-left 20×20 VRT pixels lie inside a.tif only
    await src.getTile({ x: 0, y: 0, z: 0, bbox: { left: 0, right: 20, top: 60, bottom: 40 } });
    assert.ok(requests.some(r => r.endsWith('/a.tif')));
    assert.ok(!requests.some(r => r.endsWith('/b.tif') || r.endsWith('/c.tif')));
  } finally {
    server.close();
  }
});

await run();
