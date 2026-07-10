/**
 * granule-resolve.test.mjs — W017 region-first granule resolution.
 *
 * All CMR traffic goes through an injected fetchFn returning canned UMM-JSON
 * fixtures — global fetch is stubbed to THROW so any accidental network use
 * fails loudly. The real-footprint fixture (cmr-gcov-chesapeake.umm.json) is
 * a trimmed live CMR response for bbox -77.48,38.90,-77.26,39.01 captured
 * 2026-07-10.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';
import {
  resolveGranulesForBbox,
  bboxCoveragePct,
  clipRingToBbox,
  ringArea,
  DEFAULT_GCOV_COLLECTIONS,
} from '../../src/utils/granule-resolve.js';

const { test, assert, assertClose, run } = suite('granule-resolve (W017)');

// ─── No-network guard ────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('network disabled in unit tests — inject fetchFn'); };

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const chesapeakeFixture = JSON.parse(
  readFileSync(join(fixturesDir, 'cmr-gcov-chesapeake.umm.json'), 'utf8'));

// The verified Chesapeake link bbox from the work order / docs/DEMO.md.
const CHESAPEAKE_BBOX = [-77.48, 38.90, -77.26, 39.01];
// Real granule footprint ring (lon, lat) — from the work order acceptance
// criteria and confirmed against the live CMR record.
const CHESAPEAKE_RING = [
  [-74.90906, 37.82659],
  [-75.72862, 39.93324],
  [-78.60313, 39.20224],
  [-77.70641, 37.11711],
  [-74.90906, 37.82659],
];

// ─── Fixture builders (synthetic UMM-JSON in the exact CMR shape) ───────────

function ummItem({ name, ring, start = '2026-01-01T00:00:00.000000Z', dataUrl }) {
  const item = {
    meta: { 'concept-id': `G-${name.slice(-20)}`, 'collection-concept-id': 'C-TEST' },
    umm: {
      GranuleUR: name,
      TemporalExtent: { RangeDateTime: { BeginningDateTime: start, EndingDateTime: start } },
      SpatialExtent: {
        HorizontalSpatialDomain: {
          Geometry: {
            GPolygons: [{
              Boundary: { Points: ring.map(([lon, lat]) => ({ Longitude: lon, Latitude: lat })) },
            }],
          },
        },
      },
      RelatedUrls: dataUrl === null ? [] : [
        { Type: 'GET DATA', URL: dataUrl || `https://nisar.example/${name}.h5` },
      ],
    },
  };
  return item;
}

/** Granule name in the real NISAR convention with pol + frame-coverage knobs. */
function granuleName({ pol = 'DHDH', frameFlag = 'F', stamp = '20260101T000000' }) {
  return `NISAR_L2_PR_GCOV_010_162_A_021_4005_${pol}_A_${stamp}_${stamp}_X05010_N_${frameFlag}_J_001`;
}

/**
 * fetchFn stub: responders is a map of collection short_name → items array
 * (or a function url → items). Records every requested URL for assertions.
 */
function mockCmrFetch(responders, calls = []) {
  return async (url) => {
    calls.push(url);
    const params = new URL(url).searchParams;
    const shortName = params.get('short_name');
    const items = typeof responders === 'function'
      ? responders(url)
      : (responders[shortName] || []);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'cmr-hits' ? String(items.length) : null) },
      json: async () => ({ items }),
    };
  };
}

// ─── Coverage math ───────────────────────────────────────────────────────────

test('coverage: bbox fully inside the real Chesapeake footprint → 100%', () => {
  assertClose(bboxCoveragePct(CHESAPEAKE_BBOX, CHESAPEAKE_RING), 100, 1e-9, 'coveragePct');
});

test('coverage: hand-computed partial overlap (square footprint)', () => {
  // Footprint (0,0)-(10,0)-(10,10)-(0,10); bbox [5,5,15,15]:
  // intersection is the 5×5 square [5,10]×[5,10] = 25; bbox area 10×10 = 100.
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assertClose(bboxCoveragePct([5, 5, 15, 15], ring), 25, 1e-9, 'coveragePct');
  // Half overlap: footprint (0,0)-(4,4); bbox [2,0,6,4] → 2×4 / 4×4 = 50%.
  const small = [[0, 0], [4, 0], [4, 4], [0, 4]];
  assertClose(bboxCoveragePct([2, 0, 6, 4], small), 50, 1e-9, 'coveragePct');
});

test('coverage: disjoint footprint → 0%; degenerate inputs → 0%', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(bboxCoveragePct([10, 10, 11, 11], ring), 0);
  assert.equal(bboxCoveragePct([0, 0, 1, 1], []), 0);
  assert.equal(bboxCoveragePct([0, 0, 1, 1], [[0, 0], [1, 1]]), 0, 'ring with < 3 points');
});

test('clipRingToBbox + ringArea: closed and open rings agree', () => {
  const open = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const closed = [...open, [0, 0]];
  assertClose(ringArea(open), 100, 1e-12);
  assertClose(ringArea(closed), 100, 1e-12);
  const clipped = clipRingToBbox(closed, [5, 5, 15, 15]);
  assertClose(ringArea(clipped), 25, 1e-12);
});

// ─── Resolution + ranking against the real fixture ──────────────────────────

test('real Chesapeake fixture: resolves ranked candidates with parsed fields', async () => {
  const calls = [];
  const fetchFn = mockCmrFetch({ NISAR_L2_GCOV_BETA_V1: chesapeakeFixture.items }, calls);
  const candidates = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['NISAR_L2_GCOV_BETA_V1'],
    fetchFn,
  });

  assert.equal(candidates.length, 3);
  for (const c of candidates) {
    assert.ok(c.url.endsWith('.h5'), `data URL is the .h5: ${c.url}`);
    assert.ok(c.name.endsWith('.h5'), 'name is the filename');
    assert.equal(c.fullFrame, true, '_N_F_ granules flagged full-frame');
    assert.equal(c.polMode, 'DHDH');
    assert.equal(c.collection, 'NISAR_L2_GCOV_BETA_V1');
    assert.ok(Array.isArray(c.footprint) && c.footprint.length >= 4, 'footprint ring present');
  }
  // Real coverage geometry: tracks 162 (asc) and 098 (desc) fully cover the
  // bbox; track 090 (2026-01-15, the NEWEST-but-one pass CMR returned last)
  // only clips ~24% of it, so coverage ranking demotes it below both.
  assertClose(candidates[0].coveragePct, 100, 1e-6);
  assertClose(candidates[1].coveragePct, 100, 1e-6);
  assertClose(candidates[2].coveragePct, 23.882, 0.01, 'partial-coverage track 090 ranks last');
  assert.ok(candidates[2].granuleId.includes('_010_090_'), 'coverage beats recency on real data');
  // The two full-coverage granules tie on frame/pol → newest first.
  assert.equal(candidates[0].granuleId,
    'NISAR_L2_PR_GCOV_010_162_A_021_4005_DHDH_A_20260120T101446_20260120T101521_X05010_N_F_J_001');
  assert.ok(Date.parse(candidates[0].startTime) > Date.parse(candidates[1].startTime));
  // Query shape: spatial search over the bbox, newest first.
  assert.ok(calls[0].includes('bounding_box=-77.48%2C38.9%2C-77.26%2C39.01')
    || decodeURIComponent(calls[0]).includes('bounding_box=-77.48,38.9,-77.26,39.01'),
    `bounding_box param present: ${calls[0]}`);
});

// ─── Ranking order ───────────────────────────────────────────────────────────

const INSIDE_RING = [[-78, 37], [-74, 37], [-74, 40], [-78, 40]];   // covers bbox fully
const HALF_RING = [[-77.37, 37], [-74, 37], [-74, 40], [-77.37, 40]]; // covers east half

test('ranking: coverage beats recency', async () => {
  const items = [
    // CMR returns newest-first; the newer granule only covers half the bbox.
    ummItem({ name: granuleName({ stamp: '20260601T000000' }), ring: HALF_RING, start: '2026-06-01T00:00:00Z' }),
    ummItem({ name: granuleName({ stamp: '20250101T000000' }), ring: INSIDE_RING, start: '2025-01-01T00:00:00Z' }),
  ];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], fetchFn: mockCmrFetch({ C: items }),
  });
  assert.ok(out[0].coveragePct > out[1].coveragePct);
  assert.equal(out[0].startTime, '2025-01-01T00:00:00Z', 'older-but-full-coverage granule wins');
});

test('ranking: full-frame beats partial at equal coverage', async () => {
  const items = [
    ummItem({ name: granuleName({ frameFlag: 'P', stamp: '20260601T000000' }), ring: INSIDE_RING, start: '2026-06-01T00:00:00Z' }),
    ummItem({ name: granuleName({ frameFlag: 'F', stamp: '20250101T000000' }), ring: INSIDE_RING, start: '2025-01-01T00:00:00Z' }),
  ];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], fetchFn: mockCmrFetch({ C: items }),
  });
  assert.equal(out[0].fullFrame, true, 'full-frame first despite being older');
  assert.equal(out[1].fullFrame, false);
});

test('ranking: dual-pol lean file (DHDH) beats other pol modes at equal coverage/frame', async () => {
  const items = [
    ummItem({ name: granuleName({ pol: 'QQQQ', stamp: '20260601T000000' }), ring: INSIDE_RING, start: '2026-06-01T00:00:00Z' }),
    ummItem({ name: granuleName({ pol: 'DHDH', stamp: '20250101T000000' }), ring: INSIDE_RING, start: '2025-01-01T00:00:00Z' }),
  ];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], fetchFn: mockCmrFetch({ C: items }),
  });
  assert.equal(out[0].polMode, 'DHDH');
});

test('ranking: newest wins a full tie', async () => {
  const items = [
    ummItem({ name: granuleName({ stamp: '20250101T000000' }), ring: INSIDE_RING, start: '2025-01-01T00:00:00Z' }),
    ummItem({ name: granuleName({ stamp: '20260601T000000' }), ring: INSIDE_RING, start: '2026-06-01T00:00:00Z' }),
  ];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], fetchFn: mockCmrFetch({ C: items }),
  });
  assert.equal(out[0].startTime, '2026-06-01T00:00:00Z');
});

test('granules without a data URL are skipped', async () => {
  const items = [
    ummItem({ name: granuleName({ stamp: '20260601T000000' }), ring: INSIDE_RING, start: '2026-06-01T00:00:00Z', dataUrl: null }),
    ummItem({ name: granuleName({ stamp: '20250101T000000' }), ring: INSIDE_RING, start: '2025-01-01T00:00:00Z' }),
  ];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], fetchFn: mockCmrFetch({ C: items }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].startTime, '2025-01-01T00:00:00Z');
});

// ─── Date filtering ──────────────────────────────────────────────────────────

test('dateRange forwards to the CMR temporal param (day boundaries appended)', async () => {
  const calls = [];
  const items = [ummItem({ name: granuleName({}), ring: INSIDE_RING })];
  await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'],
    dateRange: { start: '2026-01-01', end: '2026-01-31' },
    fetchFn: mockCmrFetch({ C: items }, calls),
  });
  assert.ok(decodeURIComponent(calls[0])
    .includes('temporal=2026-01-01T00:00:00Z,2026-01-31T23:59:59Z'), calls[0]);
});

test('half-open dateRange: start-only and end-only', async () => {
  const items = [ummItem({ name: granuleName({}), ring: INSIDE_RING })];
  const callsA = [];
  await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], dateRange: { start: '2026-01-01', end: null },
    fetchFn: mockCmrFetch({ C: items }, callsA),
  });
  assert.ok(decodeURIComponent(callsA[0]).includes('temporal=2026-01-01T00:00:00Z,'), callsA[0]);

  const callsB = [];
  await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['C'], dateRange: { start: null, end: '2026-02-01' },
    fetchFn: mockCmrFetch({ C: items }, callsB),
  });
  assert.ok(decodeURIComponent(callsB[0]).includes('temporal=,2026-02-01T23:59:59Z'), callsB[0]);
});

// ─── Collection fallback order ───────────────────────────────────────────────

test('collection fallback: VALIDATED → PROVISIONAL → BETA, first with hits wins', async () => {
  const calls = [];
  const items = [ummItem({ name: granuleName({}), ring: INSIDE_RING })];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    fetchFn: mockCmrFetch({ NISAR_L2_GCOV_BETA_V1: items }, calls), // others → 0 hits
  });
  assert.equal(calls.length, 3, 'tried all three collections');
  assert.ok(calls[0].includes('short_name=NISAR_L2_GCOV_VALIDATED_V1'));
  assert.ok(calls[1].includes('short_name=NISAR_L2_GCOV_PROVISIONAL_V1'));
  assert.ok(calls[2].includes('short_name=NISAR_L2_GCOV_BETA_V1'));
  assert.equal(out[0].collection, 'NISAR_L2_GCOV_BETA_V1');
});

test('collection fallback stops at the first collection with hits', async () => {
  const calls = [];
  const items = [ummItem({ name: granuleName({}), ring: INSIDE_RING })];
  const out = await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    fetchFn: mockCmrFetch({ NISAR_L2_GCOV_VALIDATED_V1: items }, calls),
  });
  assert.equal(calls.length, 1, 'no fallthrough after a hit');
  assert.equal(out[0].collection, 'NISAR_L2_GCOV_VALIDATED_V1');
});

test('col override: a caller-supplied collection list replaces the defaults', async () => {
  const calls = [];
  const items = [ummItem({ name: granuleName({}), ring: INSIDE_RING })];
  await resolveGranulesForBbox(CHESAPEAKE_BBOX, {
    collections: ['MY_CUSTOM_GCOV'],
    fetchFn: mockCmrFetch({ MY_CUSTOM_GCOV: items }, calls),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('short_name=MY_CUSTOM_GCOV'));
});

// ─── Failure modes ───────────────────────────────────────────────────────────

test('zero hits everywhere → clear error naming bbox + searched collections', async () => {
  await assert.rejects(
    resolveGranulesForBbox(CHESAPEAKE_BBOX, { fetchFn: mockCmrFetch({}) }),
    (e) => e.message.includes('No NISAR GCOV granules found')
      && e.message.includes('-77.48')
      && DEFAULT_GCOV_COLLECTIONS.every((c) => e.message.includes(c)),
  );
});

test('zero hits with a date range names the range in the error', async () => {
  await assert.rejects(
    resolveGranulesForBbox(CHESAPEAKE_BBOX, {
      dateRange: { start: '2020-01-01', end: '2020-02-01' },
      fetchFn: mockCmrFetch({}),
    }),
    (e) => e.message.includes('2020-01-01/2020-02-01'),
  );
});

test('invalid bbox rejects before any network call', async () => {
  const calls = [];
  const fetchFn = mockCmrFetch({}, calls);
  for (const bad of [null, [1, 2, 3], [0, 0, 0, 1], ['a', 0, 1, 1], [5, 0, 1, 1]]) {
    await assert.rejects(resolveGranulesForBbox(bad, { fetchFn }),
      /invalid bbox/, `bbox ${JSON.stringify(bad)}`);
  }
  assert.equal(calls.length, 0, 'no CMR call for invalid input');
});

await run();
globalThis.fetch = realFetch;
