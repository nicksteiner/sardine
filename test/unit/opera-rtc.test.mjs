/**
 * opera-rtc.test.mjs — OPERA RTC-S1 as a first-class CMR product.
 *
 * OPERA RTC-S1 differs from NISAR in three ways that each broke a NISAR
 * assumption baked into cmr-client:
 *   1. It is COG-native and multi-asset (one float32 gamma-0 COG per
 *      polarization + mask). Its .h5 sibling is orbit metadata, NOT the image.
 *   2. It is burst-based: track lives inside a burst ID (T022-046044-IW3),
 *      and there is no frame number.
 *   3. Its footprint is a GPolygon with no BoundingRectangle.
 *
 * The fixture is a trimmed live CMR UMM-JSON response (ASF, captured
 * 2026-09-11) covering both the RTC-S1 and RTC-S1-STATIC collections.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';
import {
  NISAR_PRODUCTS,
  OPERA_RTC_PRODUCTS,
  parseOperaGranuleName,
  findOperaAssets,
  searchGranules,
} from '../../src/loaders/cmr-client.js';

const { test, assert, run } = suite('opera-rtc-s1');

// ─── No-network guard ────────────────────────────────────────────────────────
globalThis.fetch = () => { throw new Error('network disabled in unit tests — inject fetchFn'); };

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = JSON.parse(
  readFileSync(join(fixturesDir, 'cmr-opera-rtc-s1.umm.json'), 'utf8'));

/** Fake fetch returning a canned UMM-JSON page; records the URL it was given. */
function stubFetch(payload, seen = {}) {
  return async (url) => {
    seen.url = url;
    return {
      ok: true,
      headers: { get: (h) => (h === 'CMR-Hits' ? String(payload.hits) : null) },
      json: async () => payload,
      text: async () => '',
    };
  };
}

// ─── Product registry ────────────────────────────────────────────────────────

test('OPERA collections are registered and route to the COG loader', () => {
  const ids = NISAR_PRODUCTS.map(p => p.id);
  assert.ok(ids.includes('OPERA_L2_RTC-S1_V1'), 'RTC-S1 registered');
  assert.ok(ids.includes('OPERA_L2_RTC-S1-STATIC_V1'), 'static layers registered');

  for (const id of OPERA_RTC_PRODUCTS) {
    const p = NISAR_PRODUCTS.find(x => x.id === id);
    // The .h5 in an RTC granule is metadata only — routing OPERA to the
    // h5chunk path would open a file with no image in it.
    assert.equal(p.type, 'cog', `${id} loads as COG`);
  }
});

// ─── Granule name parsing ────────────────────────────────────────────────────

test('parses an RTC-S1 burst granule name', () => {
  const g = parseOperaGranuleName(
    'OPERA_L2_RTC-S1_T022-046044-IW3_20260911T051622Z_20260911T124056Z_S1C_30_v1.0');
  assert.equal(g.productType, 'RTC-S1');
  assert.equal(g.burstId, 'T022-046044-IW3');
  assert.equal(g.track, 22);
  assert.equal(g.subswath, 'IW3');
  assert.equal(g.sensor, 'S1C');
  assert.equal(g.pixelSpacing, 30);
  assert.equal(g.productVersion, 'v1.0');
});

test('parses the STATIC variant, which has one fewer timestamp field', () => {
  // Regression: a fixed-index parser read sensor/spacing/version one slot
  // late here and returned nothing. The tail anchor fixes it.
  const g = parseOperaGranuleName(
    'OPERA_L2_RTC-S1-STATIC_T004-006637-IW3_20140403_S1A_30_v1.0');
  assert.equal(g.productType, 'RTC-S1-STATIC');
  assert.equal(g.track, 4);
  assert.equal(g.subswath, 'IW3');
  assert.equal(g.sensor, 'S1A');
  assert.equal(g.pixelSpacing, 30);
});

test('rejects non-OPERA and malformed names without throwing', () => {
  assert.deepEqual(parseOperaGranuleName('NISAR_L2_PR_GCOV_002_109_D_063_4005_DHDH_A'), {});
  assert.deepEqual(parseOperaGranuleName('OPERA_L2_RTC-S1_NOTABURST_x_y_S1A_30_v1.0'), {});
  assert.deepEqual(parseOperaGranuleName(''), {});
});

// ─── Asset extraction ────────────────────────────────────────────────────────

test('maps RTC-S1 assets to layers and picks co-pol, never the .h5', () => {
  const urls = fixture.rtc.items[0].umm.RelatedUrls;
  const a = findOperaAssets(urls);

  assert.deepEqual(Object.keys(a.byLayer).sort(), ['VH', 'VV', 'mask']);
  assert.deepEqual(a.polarizations, ['VV', 'VH'], 'co-pol first');
  assert.ok(a.primaryUrl.endsWith('_VV.tif'), 'VV is the default view');
  // The whole point: the metadata .h5 must never become the image URL.
  assert.ok(!a.primaryUrl.endsWith('.h5'));
  for (const href of Object.values(a.byLayer)) assert.ok(href.endsWith('.tif'));
});

test('maps STATIC layers and still resolves a primary with no polarizations', () => {
  const a = findOperaAssets(fixture.static.items[0].umm.RelatedUrls);
  assert.ok('number_of_looks' in a.byLayer, 'multi-word layer name survives');
  assert.ok('local_incidence_angle' in a.byLayer);
  assert.ok('rtc_anf_gamma0_to_beta0' in a.byLayer);
  assert.deepEqual(a.polarizations, [], 'static granules carry no pols');
  assert.ok(a.primaryUrl && a.primaryUrl.endsWith('.tif'), 'falls back to a layer');
});

test('tolerates a granule with no usable URLs', () => {
  const a = findOperaAssets([]);
  assert.equal(a.primaryUrl, null);
  assert.deepEqual(a.polarizations, []);
});

// ─── Search integration ──────────────────────────────────────────────────────

test('search returns OPERA granules with assets, bbox and burst fields', async () => {
  const { granules } = await searchGranules({
    shortName: 'OPERA_L2_RTC-S1_V1',
    fetchFn: stubFetch(fixture.rtc),
  });

  const g = granules[0];
  assert.equal(g.track, 22);
  assert.equal(g.subswath, 'IW3');
  assert.deepEqual(g.polarizations, ['VV', 'VH']);
  assert.ok(g.dataUrl.endsWith('_VV.tif'), 'dataUrl is a COG, not the .h5');
  assert.ok(g.assets.VH.endsWith('_VH.tif'), 'other pols reachable for the picker');

  // OPERA footprints are GPolygon-only; bbox must still be derived or the
  // "zoom to results" path silently skips every OPERA granule.
  assert.ok(Array.isArray(g.bbox) && g.bbox.length === 4, 'bbox derived from polygon');
  const [w, s, e, n] = g.bbox;
  assert.ok(w < e && s < n, 'bbox is well-ordered');
  assert.equal(g.geometry.type, 'Polygon');
});

test('track filter uses the OPERA burst pattern, not the NISAR one', async () => {
  const seen = {};
  await searchGranules({
    shortName: 'OPERA_L2_RTC-S1_V1', track: 35, frame: 120,
    fetchFn: stubFetch(fixture.rtc, seen),
  });
  const qs = new URL(seen.url).searchParams;
  const names = qs.getAll('readable_granule_name');
  assert.deepEqual(names, ['*_T035-*'], 'burst-style track pattern only');
  // Frame must be dropped: OPERA has none, and the NISAR pattern would make
  // the search return zero hits instead of ignoring an inapplicable field.
  assert.ok(!names.some(n => n === '*_120_*'), 'frame filter not applied');
});

test('NISAR track/frame patterns are unchanged', async () => {
  const seen = {};
  await searchGranules({
    shortName: 'NISAR_L2_GCOV_BETA_V1', track: 35, frame: 120,
    fetchFn: stubFetch({ hits: 0, items: [] }, seen),
  });
  const names = new URL(seen.url).searchParams.getAll('readable_granule_name');
  assert.deepEqual(names, ['*_035_*', '*_120_*']);
});

await run();
