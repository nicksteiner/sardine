/**
 * atbd-auto-stack — pick the best NISAR GCOV time-series stack for a point.
 *
 * Pure data-fetching module shared by the ATBD apps (S292 Inundation, S293
 * Crop + Disturbance). Given a point, query CMR, group granules by the
 * stackability key (orbit-pass-direction + track + frame), filter by
 * frequency + polarization availability, rank groups, and return the
 * winning group along with rejected alternatives for UI swap-ability.
 *
 * The grouping + ranking logic is pure — unit-testable against fixture
 * CMR responses without any network access. `selectATBDStack` is the
 * only function that hits the network; it composes `searchGranules`
 * from `cmr-client.js` with the pure helpers below.
 */

import { searchGranules } from '../loaders/cmr-client.js';

// ─── Algorithm → required polarizations ──────────────────────────────────────

/**
 * Which polarizations each ATBD needs per frame. Matches the dual-pol-h
 * composite that loadNISARRGBComposite uses so each frame carries the
 * HHHH + HVHV bands the runner consumes.
 */
export const ALGORITHM_POL_REQUIREMENTS = Object.freeze({
  inundation: ['HHHH', 'HVHV'],
  crop: ['HHHH'],
  disturbance: ['HHHH'],
});

// ─── Algorithm → stack-selection policy (S293) ──────────────────────────────

/**
 * Per-algorithm policy for what counts as a viable stack.
 *
 * - `minFrames` — fewer frames than this → rejected (algorithm can't run).
 * - `minSpanDays` — stack spans less time than this → rejected. Meaningful
 *   for crop (temporal CV needs a phenological signal) but 0 for inundation
 *   (event detection works on any recent pair).
 * - `defaultMaxFrames` — UI default for the "Max frames" control.
 */
export const ALGORITHM_POLICIES = Object.freeze({
  inundation:  Object.freeze({ minFrames: 2, minSpanDays:  0, defaultMaxFrames: 6 }),
  crop:        Object.freeze({ minFrames: 6, minSpanDays: 60, defaultMaxFrames: 8 }),
  disturbance: Object.freeze({ minFrames: 3, minSpanDays:  0, defaultMaxFrames: 10 }),
});

/**
 * Back-compat: flat {algorithm: minFrames} derived from ALGORITHM_POLICIES.
 * Prefer `ALGORITHM_POLICIES[algo].minFrames` for new code.
 */
export const ALGORITHM_MIN_FRAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(ALGORITHM_POLICIES).map(([algo, p]) => [algo, p.minFrames]),
  ),
);

// ─── Pure: polarization decoding from NISAR granule name ─────────────────────

/**
 * The granule-name parser in cmr-client.js exposes a `polarization` string
 * like 'DHDH' (dual-pol HH + HV) or 'QHQV' (quad-pol). Decode into the
 * covariance-term labels the ATBDs refer to.
 *
 * 'D' = dual-pol, 'S' = single-pol, 'Q' = quad-pol.
 * 'H'/'V' indicates the channel; 'DH' means HH + HV available.
 *
 * @param {string|undefined} code - e.g. 'DHDH', 'SHSH', 'QQQQ'
 * @returns {string[]} Available polarizations, e.g. ['HHHH','HVHV'] for dual-pol-h
 */
export function decodePolarizationCode(code) {
  if (!code || typeof code !== 'string') return [];
  const c = code.toUpperCase();
  // Quad-pol → HH, HV, VH, VV
  if (c.startsWith('Q')) return ['HHHH', 'HVHV', 'VHVH', 'VVVV'];
  // Dual-pol H-transmit → HH + HV
  if (c.startsWith('DH')) return ['HHHH', 'HVHV'];
  // Dual-pol V-transmit → VV + VH
  if (c.startsWith('DV')) return ['VVVV', 'VHVH'];
  // Single-pol H or V
  if (c.startsWith('SH')) return ['HHHH'];
  if (c.startsWith('SV')) return ['VVVV'];
  return [];
}

/** True if the granule's polarization code satisfies every required pol. */
export function granuleHasRequiredPols(granule, requiredPols) {
  const avail = decodePolarizationCode(granule.polarization);
  return requiredPols.every((p) => avail.includes(p));
}

// ─── Pure: stackability grouping ─────────────────────────────────────────────

/**
 * Pixel-registered granules share (pass direction, track, frame). Group by
 * this tuple — the stackability key.
 *
 * @param {Object[]} granules - parsed granules from searchGranules
 * @returns {Map<string, Object[]>} key "DIR/track/frame" → granule array
 */
export function groupByStackKey(granules) {
  const groups = new Map();
  for (const g of granules) {
    if (g.track == null || g.frame == null || !g.direction) continue;
    const key = `${g.direction}/${g.track}/${g.frame}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  // Sort each group by datetime ascending (earliest → latest) so downstream
  // callers get a stable temporal order.
  for (const [, arr] of groups) {
    arr.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  }
  return groups;
}

// ─── Pure: ranking ───────────────────────────────────────────────────────────

/**
 * Convert a Map of groups into ranked descriptors. Ranking is a 3-key
 * lex compare: most frames first, then shortest time span, then most
 * recent end date (prefer newer data at the tiebreak).
 *
 * @param {Map<string, Object[]>} groups
 * @returns {Object[]} [{key, direction, track, frame, granules, numFrames, startDate, endDate, spanDays, bbox}]
 */
export function rankGroups(groups) {
  const out = [];
  for (const [key, granules] of groups) {
    if (granules.length === 0) continue;
    const [direction, track, frame] = key.split('/');
    const first = granules[0];
    const last = granules[granules.length - 1];
    const startDate = first.datetime || null;
    const endDate = last.datetime || null;
    const spanDays = startDate && endDate
      ? (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)
      : 0;
    // Bbox union across all granules in the group — the stack's valid
    // extent. Callers should clamp ROIs to this.
    const bbox = unionBboxes(granules.map((g) => g.bbox).filter(Boolean));
    out.push({
      key,
      direction,
      track: Number(track),
      frame: Number(frame),
      granules,
      numFrames: granules.length,
      startDate,
      endDate,
      spanDays,
      bbox,
    });
  }
  out.sort((a, b) => {
    if (b.numFrames !== a.numFrames) return b.numFrames - a.numFrames;
    if (a.spanDays !== b.spanDays) return a.spanDays - b.spanDays;
    // Newer end date wins tiebreak
    return new Date(b.endDate) - new Date(a.endDate);
  });
  return out;
}

/** Union of [west, south, east, north] bboxes. */
export function unionBboxes(bboxes) {
  if (!bboxes || bboxes.length === 0) return null;
  let [w, s, e, n] = bboxes[0];
  for (let i = 1; i < bboxes.length; i++) {
    const [w2, s2, e2, n2] = bboxes[i];
    w = Math.min(w, w2);
    s = Math.min(s, s2);
    e = Math.max(e, e2);
    n = Math.max(n, n2);
  }
  return [w, s, e, n];
}

// ─── Pure: trim to maxFrames ─────────────────────────────────────────────────

/**
 * Keep the most-recent N frames of a ranked group. If the caller asked for
 * more frames than are available, returns the full group unchanged.
 */
export function trimToMostRecent(rankedGroup, maxFrames) {
  if (!rankedGroup || !Array.isArray(rankedGroup.granules)) return rankedGroup;
  if (!Number.isFinite(maxFrames) || maxFrames <= 0) return rankedGroup;
  if (rankedGroup.granules.length <= maxFrames) return rankedGroup;
  const trimmed = rankedGroup.granules.slice(-maxFrames);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const spanDays = first.datetime && last.datetime
    ? (new Date(last.datetime) - new Date(first.datetime)) / (1000 * 60 * 60 * 24)
    : 0;
  return {
    ...rankedGroup,
    granules: trimmed,
    numFrames: trimmed.length,
    startDate: first.datetime || rankedGroup.startDate,
    endDate: last.datetime || rankedGroup.endDate,
    spanDays,
  };
}

// ─── Impure: fetch + select (composes the pure helpers) ──────────────────────

/**
 * Query CMR + pick the best stack for an ATBD at a point.
 *
 * @param {Object} params
 * @param {number} params.lon
 * @param {number} params.lat
 * @param {'inundation'|'crop'|'disturbance'} params.algorithm
 * @param {string} [params.startDate] - ISO YYYY-MM-DD
 * @param {string} [params.endDate]
 * @param {number} [params.maxFrames=6]
 * @param {number} [params.pageSize=50]
 * @returns {Promise<{winner: Object, alternatives: Object[], requiredPols: string[], hits: number}>}
 */
export async function selectATBDStack(params) {
  const {
    lon, lat, algorithm,
    startDate, endDate,
    maxFrames, pageSize = 50,
  } = params;

  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error('selectATBDStack: valid lon/lat required');
  }
  const requiredPols = ALGORITHM_POL_REQUIREMENTS[algorithm];
  const policy = ALGORITHM_POLICIES[algorithm];
  if (!requiredPols || !policy) {
    throw new Error(`selectATBDStack: unknown algorithm "${algorithm}"`);
  }
  const effMaxFrames = Number.isFinite(maxFrames) && maxFrames > 0
    ? maxFrames : policy.defaultMaxFrames;

  // CMR bbox needs some width — a pure point returns nothing. Expand by
  // a small epsilon in each direction.
  const eps = 0.01;
  const bbox = [lon - eps, lat - eps, lon + eps, lat + eps];

  const { granules, hits } = await searchGranules({
    shortName: 'NISAR_L2_GCOV_BETA_V1',
    bbox,
    dateStart: startDate,
    dateEnd: endDate,
    pageSize,
  });

  // Client-side pol filter (CMR metadata doesn't expose per-pol flags).
  const matching = granules.filter((g) => granuleHasRequiredPols(g, requiredPols));
  const groups = groupByStackKey(matching);
  const ranked = rankGroups(groups);
  const viable = ranked.filter(
    (g) => g.numFrames >= policy.minFrames && g.spanDays >= policy.minSpanDays,
  );
  if (viable.length === 0) {
    return { winner: null, alternatives: ranked, requiredPols, hits, policy };
  }
  const winner = trimToMostRecent(viable[0], effMaxFrames);
  const alternatives = viable.slice(1).map((g) => trimToMostRecent(g, effMaxFrames));
  return { winner, alternatives, requiredPols, hits, policy };
}
