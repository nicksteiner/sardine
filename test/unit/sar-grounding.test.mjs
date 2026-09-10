/**
 * sar-grounding.test.mjs — W018 Phase 1.5.
 *
 * The point of grounding is not that fields are populated; it is that the
 * payload constrains an agent. So these tests pin two things: that physical
 * context is reported from real metadata (never invented), and that the
 * view's unresolvable questions are declared rather than glossed over.
 */

import { buildGrounding, describeAmbiguities, describeTerrain } from '../../src/utils/sar-grounding.js';
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
const RENDER_DB = {
  useDecibels: true, contrastMin: -25, contrastMax: 0,
  selectedPolarization: 'HHHH', multiLook: false, speckleFilterType: 'none',
  maskLayoverShadow: false, colormap: 'viridis', stretchMode: 'linear',
};

console.log('\nsar-grounding (W018 Phase 1.5)\n');

test('band physics derived from radarBand', () => {
  const g = buildGrounding(NISAR_L, RENDER_DB);
  assert.strictEqual(g.acquisition.radarBand, 'L');
  assert.strictEqual(g.acquisition.wavelengthCm, 24);
  assert.strictEqual(g.acquisition.canopyPenetration, 'high');
  assert.match(g.acquisition.bandNote, /penetrates vegetation canopy/i);
});

test('C-band reports low penetration (not L-band physics)', () => {
  const g = buildGrounding({ identification: { radarBand: 'C' } }, RENDER_DB);
  assert.strictEqual(g.acquisition.wavelengthCm, 5.6);
  assert.strictEqual(g.acquisition.canopyPenetration, 'low');
});

test('GCOV covariance term HHHH normalizes to HH', () => {
  const g = buildGrounding(NISAR_L, RENDER_DB);
  assert.strictEqual(g.acquisition.polarization, 'HH');
  assert.match(g.acquisition.polarizationNote, /double-bounce/i);
});

test('cross-pol reports volume scattering sensitivity', () => {
  const g = buildGrounding(NISAR_L, { ...RENDER_DB, selectedPolarization: 'HVHV' });
  assert.strictEqual(g.acquisition.polarization, 'HV');
  assert.match(g.acquisition.polarizationNote, /volume scattering/i);
});

test('unknown metadata stays null — never invented', () => {
  const g = buildGrounding({}, {});
  assert.strictEqual(g.acquisition.radarBand, null);
  assert.strictEqual(g.acquisition.wavelengthCm, null);
  assert.strictEqual(g.acquisition.lookDirection, null);
  assert.strictEqual(g.measurement.pixelSpacing, null);
});

test('dB view states units and that brightness is a render choice', () => {
  const g = buildGrounding(NISAR_L, RENDER_DB);
  assert.strictEqual(g.measurement.units, 'dB');
  assert.deepStrictEqual(g.measurement.displayRange, [-25, 0]);
  assert.match(g.measurement.displayRangeNote, /NOT an absolute measurement/);
});

test('linear view is not described as dB', () => {
  const g = buildGrounding(NISAR_L, { ...RENDER_DB, useDecibels: false });
  assert.match(g.measurement.units, /linear/);
  assert.doesNotMatch(g.measurement.quantity, /dB/);
});

test('dark-target ambiguity is ALWAYS declared', () => {
  const g = buildGrounding(NISAR_L, RENDER_DB);
  const dark = g.ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.ok(dark, 'dark-target ambiguity must always be present');
  assert.strictEqual(dark.resolved, false);
  assert.match(dark.why, /shadow/i);
  assert.ok(dark.resolveWith.length > 0, 'must name a resolving measurement');
});

test('shadow is excluded once a terrain mask is applied, but smooth-dry is not', () => {
  const g = buildGrounding(NISAR_L, { ...RENDER_DB, maskLayoverShadow: true });
  const dark = g.ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.match(dark.why, /smooth dry/i);
  assert.doesNotMatch(dark.why, /No layover\/shadow mask is applied/);
});

test('speckle ambiguity appears only when unmitigated', () => {
  const raw = buildGrounding(NISAR_L, RENDER_DB);
  assert.ok(raw.ambiguities.some((a) => a.id === 'speckle-vs-texture'));
  const filtered = buildGrounding(NISAR_L, { ...RENDER_DB, speckleFilterType: 'lee' });
  assert.ok(!filtered.ambiguities.some((a) => a.id === 'speckle-vs-texture'));
});

test('single cross-pol channel flags mechanism ambiguity', () => {
  const g = buildGrounding(NISAR_L, { ...RENDER_DB, selectedPolarization: 'HVHV' });
  assert.ok(g.ambiguities.some((a) => a.id === 'single-channel-mechanism'));
  const copol = buildGrounding(NISAR_L, RENDER_DB);
  assert.ok(!copol.ambiguities.some((a) => a.id === 'single-channel-mechanism'));
});

test('no fabricated absolute dB thresholds anywhere in the payload', () => {
  // The critical guard: a plausible-but-wrong threshold is worse than none.
  const json = JSON.stringify(buildGrounding(NISAR_L, RENDER_DB));
  // Any "<number> dB" claim that is not the user's own display range.
  const claims = (json.match(/-?\d+(\.\d+)?\s*dB/g) || [])
    .filter((m) => !/-25|(^|[^\d])0\s*dB/.test(m));
  assert.deepStrictEqual(claims, [], `payload asserts dB thresholds: ${claims.join(', ')}`);
});

test('interpretation contract forbids optical reading and demands verification', () => {
  const rules = buildGrounding(NISAR_L, RENDER_DB).interpretationContract.rules.join(' ');
  assert.match(rules, /not an optical image/i);
  assert.match(rules, /HYPOTHESIS/);
  assert.match(rules, /Do not assert absolute dB thresholds/i);
  assert.match(rules, /Deferring is the correct answer/i);
});

test('describeAmbiguities is usable standalone', () => {
  const a = describeAmbiguities({ render: {}, terrain: {} });
  assert.ok(Array.isArray(a) && a.length > 0);
});

// ── Terrain: the imaging model, not an enrichment ──────────────────

const GCOV_TERRAIN = {
  ...NISAR_L,
  isGCOV: true,
  hasMask: true,
  metadataCube: { getIncidenceAngle: () => 35.2 },
};

test('COG without terrain reports it as unavailable, not assumed flat', () => {
  const t = describeTerrain({ resolution: [20, 20] }, {});
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.incidenceAngleAvailable, false);
  assert.match(t.note, /Radar shadow cannot be excluded/i);
});

test('GCOV metadata cube supplies per-pixel incidence angle', () => {
  const t = describeTerrain(GCOV_TERRAIN, {});
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.incidenceAngleAvailable, true);
  assert.match(t.source, /metadata cube/i);
});

test('GCOV zero-power encodes zero illuminated area (shadow/layover)', () => {
  assert.strictEqual(describeTerrain(GCOV_TERRAIN, {}).zeroMeansNoIllumination, true);
  assert.strictEqual(describeTerrain({ resolution: [20, 20] }, {}).zeroMeansNoIllumination, false);
});

test('no terrain → slope-vs-surface confound is declared', () => {
  const g = buildGrounding({ resolution: [20, 20] }, RENDER_DB);
  const slope = g.ambiguities.find((a) => a.id === 'slope-vs-surface');
  assert.ok(slope, 'must flag that slope and surface change are confounded');
  assert.match(slope.why, /local incidence angle/i);
});

test('per-pixel incidence angle retires the slope confound', () => {
  const g = buildGrounding(GCOV_TERRAIN, RENDER_DB);
  assert.ok(!g.ambiguities.some((a) => a.id === 'slope-vs-surface'));
});

test('dark-target candidate causes shrink as terrain knowledge improves', () => {
  // No terrain at all: water, shadow, and smooth-dry all remain possible.
  const none = buildGrounding({ resolution: [20, 20] }, RENDER_DB)
    .ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.strictEqual(none.candidateCauses.length, 3);
  assert.match(none.why, /No terrain geometry/i);

  // Mask present but not applied: still three, and the payload says why.
  const unapplied = buildGrounding(GCOV_TERRAIN, RENDER_DB)
    .ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.strictEqual(unapplied.candidateCauses.length, 3);
  assert.match(unapplied.why, /NOT currently applied/i);
  assert.match(unapplied.resolveWith.join(' '), /available in this product/i);

  // Mask applied: shadow is excluded, two causes remain.
  const applied = buildGrounding(GCOV_TERRAIN, { ...RENDER_DB, maskLayoverShadow: true })
    .ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.strictEqual(applied.candidateCauses.length, 2);
  assert.ok(!applied.candidateCauses.some((c) => /shadow/i.test(c)));
});

test('shadow is never silently dropped — only an applied mask removes it', () => {
  // The failure mode this guards: terrain data existing is NOT the same as
  // terrain being accounted for.
  const g = buildGrounding(GCOV_TERRAIN, { ...RENDER_DB, maskLayoverShadow: false });
  const dark = g.ambiguities.find((a) => a.id === 'dark-target-ambiguity');
  assert.ok(dark.candidateCauses.some((c) => /shadow/i.test(c)));
});

console.log(`\nsar-grounding: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
