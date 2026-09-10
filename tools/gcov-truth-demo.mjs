#!/usr/bin/env node
/**
 * gcov-truth-demo.mjs — ground-truth demo for SAR agent grounding.
 *
 * Reads a real NISAR GCOV granule and, for a set of sample points, reports
 * what the PRODUCT ITSELF says about each one — then contrasts that with what
 * the pixel alone would suggest. This is the reference the agent-facing
 * grounding payload is checked against.
 *
 * The point being demonstrated: a dark pixel is not self-explaining. Radar
 * shadow, calm open water and a smooth dry surface all produce low
 * backscatter and are visually identical. What separates them is geometry and
 * the product's own mask — which is why terrain is part of the measurement
 * rather than an optional enrichment.
 *
 * Usage:
 *   node tools/gcov-truth-demo.mjs <granule.h5> [--pol HHHH] [--freq A]
 */

import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { loadNISARGCOV } from '../src/loaders/nisar-loader.js';
import { buildGrounding } from '../src/utils/sar-grounding.js';
import { toDb } from '../src/utils/stats.js';

class NodeFile {
  constructor(p) { this._path = p; const s = statSync(p); this.size = s.size; this.name = basename(p); }
  slice(start, end) {
    const path = this._path, length = end - start;
    return { async arrayBuffer() {
      const fd = openSync(path, 'r');
      const b = Buffer.alloc(length);
      readSync(fd, b, 0, length, start);
      closeSync(fd);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } };
  }
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/gcov-truth-demo.mjs <granule.h5> [--pol HHHH] [--freq A]');
  process.exit(1);
}
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const pol = argVal('pol', 'HHHH');
const freq = argVal('freq', 'A');

console.log(`\nGranule : ${basename(file)}`);
console.log(`Reading : frequency ${freq}, ${pol}\n`);

let data;
try {
  data = await loadNISARGCOV(new NodeFile(file), { frequency: freq, polarization: pol, multilook: 4 });
} catch (err) {
  console.error(`Failed to open granule: ${err.message}`);
  process.exit(1);
}

const render = {
  useDecibels: true, contrastMin: -25, contrastMax: 0,
  selectedPolarization: pol, selectedFrequency: freq,
  multiLook: 4, speckleFilterType: 'none', maskLayoverShadow: false,
  colormap: 'grayscale', stretchMode: 'linear',
};
const g = buildGrounding(data, render);

// ── What the product says about itself ────────────────────────────────
console.log('── ACQUISITION ' + '─'.repeat(50));
console.log(`  band            : ${g.acquisition.radarBand}  (${g.acquisition.wavelengthCm} cm)`);
console.log(`  penetration     : ${g.acquisition.canopyPenetration}`);
console.log(`  polarization    : ${g.acquisition.polarization}`);
console.log(`  look / pass     : ${g.acquisition.lookDirection} / ${g.acquisition.orbitPass}`);
console.log(`  acquired        : ${g.acquisition.acquisitionStart || 'unknown'}`);

console.log('\n── MEASUREMENT ' + '─'.repeat(50));
const sp = g.measurement.pixelSpacing;
console.log(`  quantity        : ${g.measurement.quantity}`);
console.log(`  units           : ${g.measurement.units}`);
console.log(`  pixel spacing   : ${typeof sp === 'object' && sp ? `${sp.x} x ${sp.y}` : sp} m`);
console.log(`  CRS             : ${g.measurement.crs}`);

console.log('\n── TERRAIN (part of the measurement) ' + '─'.repeat(28));
console.log(`  available       : ${g.terrain.available}`);
console.log(`  source          : ${g.terrain.source || 'none'}`);
console.log(`  incidence angle : ${g.terrain.incidenceAngleAvailable ? 'per-pixel' : 'UNKNOWN'}`);
console.log(`  shadow mask     : ${g.terrain.terrainMaskAvailable ? 'present' : 'absent'}` +
            `${g.terrain.terrainMaskAvailable ? (g.terrain.terrainMaskApplied ? ' (applied)' : ' (NOT applied)') : ''}`);
console.log(`  zero = no illum : ${g.terrain.zeroMeansNoIllumination}`);

// ── Sample real pixels and adjudicate them ────────────────────────────
console.log('\n── GROUND TRUTH SAMPLES ' + '─'.repeat(41));
const [w, s, e, n] = data.bounds;
const cube = data.metadataCube;

const tile = await data.getTile({ x: 0, y: 0, z: 0 }).catch(() => null);
const vals = tile?.data || tile;

if (vals && vals.length) {
  const finite = Array.from(vals).filter(v => Number.isFinite(v) && v > 0);
  finite.sort((a, b) => a - b);
  const pct = (p) => finite[Math.floor(p * (finite.length - 1))];
  const zeroCount = Array.from(vals).filter(v => v === 0).length;

  console.log(`  samples         : ${vals.length} (${finite.length} positive, ${zeroCount} exactly zero)`);
  console.log(`  p02 / p50 / p98 : ${toDb(pct(0.02)).toFixed(1)} / ${toDb(pct(0.5)).toFixed(1)} / ${toDb(pct(0.98)).toFixed(1)} dB`);

  // Exactly-zero pixels are the product telling us the area was never
  // illuminated — shadow or layover. This is truth, not inference.
  if (zeroCount > 0) {
    const frac = (100 * zeroCount / vals.length).toFixed(1);
    console.log(`\n  ${frac}% of sampled pixels are EXACTLY ZERO.`);
    console.log('  Per the GCOV spec that is zero illuminated area — shadow, layover, or');
    console.log('  no contributing samples. These pixels are dark for a GEOMETRIC reason,');
    console.log('  not because the surface is smooth or wet. An agent reading brightness');
    console.log('  alone would classify them as water.');
  } else {
    console.log('\n  No exactly-zero pixels in this sample — no shadow/layover here.');
  }
}

if (cube && Number.isFinite(w)) {
  console.log('\n  Per-pixel incidence angle (from the product, not assumed):');
  const pts = [
    ['scene centre  ', (w + e) / 2, (s + n) / 2],
    ['near range    ', w + (e - w) * 0.1, (s + n) / 2],
    ['far range     ', w + (e - w) * 0.9, (s + n) / 2],
  ];
  for (const [label, x, y] of pts) {
    const inc = cube.getIncidenceAngle(x, y);
    console.log(`    ${label}: ${inc == null ? 'n/a' : inc.toFixed(2) + '°'}`);
  }
  console.log('\n  sigma-0 is defined against the LOCAL incidence angle. Because these');
  console.log('  differ across the swath, identical surfaces return different');
  console.log('  brightness — a difference that is geometry, not surface change.');
}

// ── What remains unresolved ───────────────────────────────────────────
console.log('\n── UNRESOLVED IN THIS VIEW ' + '─'.repeat(38));
for (const a of g.ambiguities) {
  console.log(`  • ${a.question}`);
  if (a.candidateCauses) console.log(`    causes still possible: ${a.candidateCauses.join('; ')}`);
  console.log(`    resolve with: ${a.resolveWith.join(' | ')}`);
}

console.log('\n── CONTRACT ' + '─'.repeat(53));
for (const r of g.interpretationContract.rules) console.log(`  - ${r}`);
console.log();
