/**
 * DEM Loader integration tests
 *
 * Run: node test/dem-loader-test.mjs
 *
 * GLO-30 tests hit AWS Open Data (network required).
 * FABDEM V2 tests require DEM_FABDEM_V2_ROOT to be set; skipped otherwise.
 */

import { loadDEM, clearDEMCache, glo30Url, fabdemUrl } from '../src/loaders/dem-loader.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function approx(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: expected ~${b}, got ${a} (tol ${tol})`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    if (e.message === 'SKIP') {
      skipped++;
      console.log(`  ○ ${name} (skipped)`);
    } else {
      failed++;
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Unit tests (no network)
// ---------------------------------------------------------------------------

console.log('\n— URL pattern tests —');

await test('GLO-30 URL for N36 W118 (Mt. Whitney)', () => {
  const url = glo30Url(36, -118);
  assert(url.includes('Copernicus_DSM_COG_10_N36_00_W118_00_DEM'), `URL wrong: ${url}`);
  assert(url.startsWith('https://copernicus-dem-30m.s3.amazonaws.com/'), `URL prefix: ${url}`);
});

await test('GLO-30 URL for S34 E151 (Sydney)', () => {
  const url = glo30Url(-34, 151);
  assert(url.includes('S34_00_E151_00_DEM'), `URL wrong: ${url}`);
});

await test('FABDEM URL for N40 W074 (Manhattan)', () => {
  const url = fabdemUrl('https://mirror/fabdem/', 40, -74);
  assert(url === 'https://mirror/fabdem/N40W074_FABDEM_V2.tif', `URL wrong: ${url}`);
});

await test('FABDEM URL with trailing slash root', () => {
  const url = fabdemUrl('file:///data/fabdem-v2/', 40, -74);
  assert(url === 'file:///data/fabdem-v2/N40W074_FABDEM_V2.tif', `URL wrong: ${url}`);
});

await test('FABDEM URL without trailing slash root', () => {
  const url = fabdemUrl('file:///data/fabdem-v2', 40, -74);
  assert(url === 'file:///data/fabdem-v2/N40W074_FABDEM_V2.tif', `URL wrong: ${url}`);
});

// ---------------------------------------------------------------------------
// GLO-30 integration test — Mt. Whitney summit (~4421 m)
// ---------------------------------------------------------------------------

console.log('\n— GLO-30 integration tests (network) —');

await test('GLO-30 sample at Mt. Whitney summit ≈ 4421 m', async () => {
  clearDEMCache();
  // Mt. Whitney: 36.5785°N, 118.2923°W
  const lat = 36.5785;
  const lon = -118.2923;
  const dem = await loadDEM([lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01], { source: 'glo30' });

  assert(dem.source === 'glo30', `source should be glo30, got ${dem.source}`);
  assert(dem.isBareEarth === false, 'GLO-30 is not bare-earth');

  const elev = dem.sampleDEM(lat, lon);
  console.log(`    Mt. Whitney elevation: ${elev.toFixed(1)} m`);
  // Accept 4380–4450 m (30m DEM, bilinear, summit may not be exact pixel center)
  approx(elev, 4421, 50, 'Mt. Whitney elevation');
});

await test('GLO-30 out-of-bbox throws', async () => {
  clearDEMCache();
  const dem = await loadDEM([-118.3, 36.57, -118.28, 36.59], { source: 'glo30' });
  let threw = false;
  try {
    dem.sampleDEM(0, 0); // way outside bbox
  } catch (_) {
    threw = true;
  }
  assert(threw, 'Should throw for out-of-bbox sample');
});

// ---------------------------------------------------------------------------
// FABDEM V2 integration tests — gated on DEM_FABDEM_V2_ROOT
// ---------------------------------------------------------------------------

console.log('\n— FABDEM V2 integration tests —');

const fabdemRoot = process.env.DEM_FABDEM_V2_ROOT;

await test('FABDEM V2 sample over Manhattan returns bare-earth (< 100 m)', async () => {
  if (!fabdemRoot) throw new Error('SKIP');
  clearDEMCache();
  // Midtown Manhattan: 40.7484°N, 73.9857°W — buildings 200-400 m, ground ~10 m
  const lat = 40.7484;
  const lon = -73.9857;
  const dem = await loadDEM([lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01], { source: 'fabdem-v2' });

  assert(dem.source === 'fabdem-v2', `source should be fabdem-v2, got ${dem.source}`);
  assert(dem.isBareEarth === true, 'FABDEM is bare-earth');

  const elev = dem.sampleDEM(lat, lon);
  console.log(`    Manhattan bare-earth elevation: ${elev.toFixed(1)} m`);
  // Bare-earth in Midtown Manhattan should be < 100 m (ground is ~10-30 m ASL)
  assert(elev < 100, `Bare-earth elevation should be < 100 m, got ${elev.toFixed(1)} m`);
  assert(elev > -10, `Elevation should be > -10 m, got ${elev.toFixed(1)} m`);
});

await test('FABDEM V2 auto-source prefers FABDEM when configured', async () => {
  if (!fabdemRoot) throw new Error('SKIP');
  clearDEMCache();
  const lat = 40.7484;
  const lon = -73.9857;
  const dem = await loadDEM([lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01], { source: 'auto' });
  assert(dem.source === 'fabdem-v2', `auto should prefer fabdem-v2, got ${dem.source}`);
  assert(dem.isBareEarth === true, 'auto+fabdem should be bare-earth');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
