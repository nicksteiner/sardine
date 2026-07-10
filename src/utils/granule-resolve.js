/**
 * granule-resolve.js — region-first granule resolution for SARdine (W017).
 *
 * Turns a WGS84 bbox into a ranked list of NISAR GCOV granule candidates via
 * CMR spatial search. This makes the region the primary key of a deep link:
 * granule IDs churn across BETA → PROVISIONAL → VALIDATED reprocessing, but
 * coordinates don't.
 *
 * Pure module: no React, no window. All network goes through an injectable
 * `fetchFn` (threaded into cmr-client's searchGranules) so the ranking and
 * coverage logic unit-test against canned CMR UMM-JSON fixtures with zero
 * network. See test/unit/granule-resolve.test.mjs.
 *
 * Ranking (resolveGranulesForBbox result order):
 *   1. region coverage %  — area(footprint ∩ bbox) / area(bbox), computed by
 *      Sutherland–Hodgman clipping of the CMR footprint ring against the bbox
 *      (ties within COVERAGE_TIE_PCT percentage points fall through)
 *   2. full-frame granules (`_N_F_` in the granule name) over partial frames
 *   3. dual-pol lean files (DHDH) over other pol modes
 *   4. newest acquisition start time
 *
 * Coverage is computed in lon/lat degree space — not equal-area, but both the
 * numerator and denominator live in the same space and the bboxes involved
 * are small, so it's more than adequate for ranking.
 */

import { searchGranules } from '../loaders/cmr-client.js';

// Collection try order: first collection with hits wins. VALIDATED and
// PROVISIONAL don't exist in CMR yet (0 hits, no error — verified 2026-07),
// so today BETA always wins; when reprocessed products appear they take
// precedence automatically.
export const DEFAULT_GCOV_COLLECTIONS = [
  'NISAR_L2_GCOV_VALIDATED_V1',
  'NISAR_L2_GCOV_PROVISIONAL_V1',
  'NISAR_L2_GCOV_BETA_V1',
];

// Coverage differences at or below this many percentage points are treated as
// a tie so float noise between repeat passes of the same track doesn't defeat
// the full-frame / pol / recency tie-breakers.
export const COVERAGE_TIE_PCT = 0.5;

// ─── Coverage math (pure geometry helpers) ───────────────────────────────────

/**
 * Clip a polygon ring against one axis-aligned half-plane
 * (Sutherland–Hodgman step). `keepGreater` keeps points with
 * point[axis] >= bound, otherwise <= bound.
 */
function clipHalfPlane(pts, axis, bound, keepGreater) {
  const out = [];
  const inside = (p) => (keepGreater ? p[axis] >= bound : p[axis] <= bound);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (bound - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * Clip a polygon ring to an axis-aligned bbox (Sutherland–Hodgman).
 * @param {number[][]} ring - [[lon, lat], ...], open or closed
 * @param {number[]} bbox - [west, south, east, north]
 * @returns {number[][]} clipped ring (open; may be empty)
 */
export function clipRingToBbox(ring, bbox) {
  const [w, s, e, n] = bbox;
  // Drop a duplicated closing point — clipping treats the ring as cyclic.
  let pts = ring;
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0, -1);
  }
  pts = clipHalfPlane(pts, 0, w, true);   // lon >= west
  if (pts.length) pts = clipHalfPlane(pts, 0, e, false);  // lon <= east
  if (pts.length) pts = clipHalfPlane(pts, 1, s, true);   // lat >= south
  if (pts.length) pts = clipHalfPlane(pts, 1, n, false);  // lat <= north
  return pts;
}

/** Shoelace area of a ring (open or closed), in the ring's coordinate units². */
export function ringArea(ring) {
  let pts = ring;
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Percentage of a bbox covered by a footprint ring:
 * area(footprint ∩ bbox) / area(bbox) × 100, clamped to [0, 100].
 * @param {number[]} bbox - [west, south, east, north] WGS84
 * @param {number[][]} footprintRing - [[lon, lat], ...] single ring
 * @returns {number} 0–100
 */
export function bboxCoveragePct(bbox, footprintRing) {
  if (!Array.isArray(footprintRing) || footprintRing.length < 3) return 0;
  const [w, s, e, n] = bbox;
  const bboxArea = (e - w) * (n - s);
  if (!(bboxArea > 0)) return 0;
  const clipped = clipRingToBbox(footprintRing, bbox);
  const pct = (ringArea(clipped) / bboxArea) * 100;
  return Math.min(100, Math.max(0, pct));
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

function compareCandidates(a, b) {
  if (Math.abs(a.coveragePct - b.coveragePct) > COVERAGE_TIE_PCT) {
    return b.coveragePct - a.coveragePct;               // 1. coverage
  }
  if (a.fullFrame !== b.fullFrame) return a.fullFrame ? -1 : 1;  // 2. full-frame
  const aLean = a.polMode === 'DHDH';
  const bLean = b.polMode === 'DHDH';
  if (aLean !== bLean) return aLean ? -1 : 1;           // 3. dual-pol lean file
  return (Date.parse(b.startTime) || 0) - (Date.parse(a.startTime) || 0); // 4. newest
}

/** Map a parsed cmr-client granule to a ranked-candidate record. */
function toCandidate(granule, bbox, collection) {
  const footprint = granule.geometry?.coordinates?.[0] || null;
  const url = granule.dataUrl;
  const name = url ? (url.split('?')[0].split('/').pop() || granule.id) : granule.id;
  return {
    url,
    name,
    granuleId: granule.id,
    footprint,                                           // [[lon, lat], ...] ring
    coveragePct: footprint ? bboxCoveragePct(bbox, footprint) : 0,
    fullFrame: /_N_F_/.test(granule.id),
    polMode: granule.polarization || null,               // e.g. 'DHDH'
    startTime: granule.datetime || null,
    collection,
  };
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve ranked NISAR GCOV granule candidates for a WGS84 bbox.
 *
 * Tries each collection in order and returns candidates from the FIRST
 * collection with usable hits (so reprocessed products shadow BETA once they
 * exist). Throws with a descriptive message when nothing matches anywhere.
 *
 * @param {number[]} bbox4326 - [west, south, east, north] WGS84
 * @param {Object} [opts]
 * @param {{start: ?string, end: ?string}} [opts.dateRange] - ISO acquisition
 *   date filter; either half optional (forwarded to CMR `temporal`)
 * @param {string[]} [opts.collections] - CMR short_name try order
 *   (default VALIDATED → PROVISIONAL → BETA)
 * @param {Function} [opts.fetchFn] - injectable fetch for tests
 * @param {number} [opts.pageSize=25]
 * @returns {Promise<Array<{url, name, granuleId, footprint, coveragePct,
 *   fullFrame, polMode, startTime, collection}>>} ranked best-first
 */
export async function resolveGranulesForBbox(bbox4326, opts = {}) {
  const {
    dateRange = null,
    collections = DEFAULT_GCOV_COLLECTIONS,
    fetchFn,
    pageSize = 25,
  } = opts;

  if (!Array.isArray(bbox4326) || bbox4326.length !== 4
      || !bbox4326.every(Number.isFinite)
      || !(bbox4326[0] < bbox4326[2]) || !(bbox4326[1] < bbox4326[3])) {
    throw new Error(`resolveGranulesForBbox: invalid bbox [${String(bbox4326)}] — want [west, south, east, north] with west<east, south<north`);
  }

  const tried = [];
  for (const shortName of collections) {
    tried.push(shortName);
    const { granules } = await searchGranules({
      shortName,
      bbox: bbox4326,
      dateStart: dateRange?.start || undefined,
      dateEnd: dateRange?.end || undefined,
      pageSize,
      fetchFn,
    });
    const candidates = granules
      .filter((g) => g.dataUrl)
      .map((g) => toCandidate(g, bbox4326, shortName))
      .sort(compareCandidates);
    if (candidates.length > 0) return candidates;
  }

  const when = dateRange && (dateRange.start || dateRange.end)
    ? ` in date range ${dateRange.start || '…'}/${dateRange.end || '…'}`
    : '';
  throw new Error(`No NISAR GCOV granules found for bbox [${bbox4326.join(', ')}]${when} (searched ${tried.join(', ')})`);
}
