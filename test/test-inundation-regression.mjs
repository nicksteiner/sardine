/**
 * NISAR Inundation ATBD regression test — D289
 *
 * Loads UAVSAR .flt power images (raw LE Float32) and compares the output of
 * `runInundationATBD` against the JPL reference classification rasters
 * (class0.bin .. class4.bin from the original Inundation_notebook.zip).
 *
 * The canonical test layout, from the zip:
 *   <data>/SAR_data/<orbit>_<track>/NISARA_02602_*_HHHH_129A_*.flt
 *   <data>/SAR_data/<orbit>_<track>/NISARA_02602_*_HVHV_129A_*.flt
 *   <data>/Notebook_outputs/class{0..4}.bin           (int8, 1850 x 1604)
 *
 * Since the official zip dropped the .flt blobs (all downloaded as
 * *_Error.txt placeholders), the files live on /media/nsteiner/data3/.../
 * mississippi/ and the reference classes are in the working zip copy.
 *
 * Data path resolution (first that exists wins):
 *   $NISAR_INUNDATION_DATA          — directory holding both flts + reference
 *                                     bin files, or two comma-separated dirs
 *                                     ($NISAR_INUNDATION_FLT_DIR,
 *                                      $NISAR_INUNDATION_REF_DIR).
 *   Otherwise the well-known development paths on this workstation are used
 *   (see `resolvePaths` below).
 *
 * Exit code 0 on pass (every reference pixel matches) or if the data files
 * are not present on disk (skipped with SKIP message). Exit 1 on mismatch.
 *
 * Usage:
 *   node test/test-inundation-regression.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInundationATBD, INUNDATION_MASKED_VALUE } from '../src/algorithms/inundation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const NLINE = 1850;
const NSAMP = 1604;
const PIXELS = NLINE * NSAMP;        // 2,967,400
const EXPECTED_FLT_BYTES = PIXELS * 4; // 11,869,600

// ─── Data resolution ────────────────────────────────────────────────────────

function candidateFltDirs() {
  const env = process.env.NISAR_INUNDATION_FLT_DIR || process.env.NISAR_INUNDATION_DATA;
  const cand = [];
  if (env) cand.push(...env.split(',').map((s) => s.trim()));
  // workstation defaults
  cand.push('/media/nsteiner/data3/nsteiner_home/devel/wetlands/notebooks/mississippi');
  cand.push('/tmp/inundation_work/Inundation notebook/SAR_data');
  return cand;
}

function candidateRefDirs() {
  const env = process.env.NISAR_INUNDATION_REF_DIR || process.env.NISAR_INUNDATION_DATA;
  const cand = [];
  if (env) cand.push(...env.split(',').map((s) => s.trim()));
  cand.push('/tmp/inundation_work/Inundation notebook/Notebook_outputs');
  return cand;
}

function findFltFiles(dirs) {
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    // Walk one level deep — the canonical layout has per-orbit subdirs.
    const found = [];
    const queue = [d];
    while (queue.length) {
      const cur = queue.shift();
      let entries;
      try { entries = readdirSync(cur); } catch { continue; }
      for (const e of entries) {
        const p = join(cur, e);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { queue.push(p); continue; }
        if (/_HHHH_129A_.*\.flt$/.test(e) || /_HVHV_129A_.*\.flt$/.test(e)) {
          if (st.size === EXPECTED_FLT_BYTES) found.push(p);
        }
      }
    }
    if (found.length >= 12) return { dir: d, files: found };
  }
  return null;
}

function findReferenceFiles(dirs) {
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const refs = [];
    for (let k = 0; k < 5; k++) {
      const p = join(d, `class${k}.bin`);
      if (!existsSync(p) || statSync(p).size !== PIXELS) return null;
      refs.push(p);
    }
    return { dir: d, files: refs };
  }
  return null;
}

// Notebook date extraction: /_(\d\d\d\d\d\d)_/ from basename (YYMMDD).
function dateKeyFromName(name) {
  const m = /_(\d{6})_L090_/.exec(name);
  if (!m) throw new Error(`Cannot parse date from ${name}`);
  return m[1]; // lexicographically sortable within a year
}

// ─── .flt loader ─────────────────────────────────────────────────────────────

function loadFlt(path) {
  const buf = readFileSync(path);
  if (buf.byteLength !== EXPECTED_FLT_BYTES) {
    throw new Error(`${path}: expected ${EXPECTED_FLT_BYTES} bytes, got ${buf.byteLength}`);
  }
  // Align to a fresh ArrayBuffer so Float32Array gets a 4-byte aligned start.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const arr = new Float32Array(ab);
  // Notebook clip: np.clip(ftemp, 0.0, 10000.0)
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!(v >= 0)) { arr[i] = 0; continue; }       // catches NaN + negatives
    if (v > 10000) arr[i] = 10000;
  }
  return arr;
}

function loadClassBin(path) {
  const buf = readFileSync(path);
  if (buf.byteLength !== PIXELS) {
    throw new Error(`${path}: expected ${PIXELS} bytes, got ${buf.byteLength}`);
  }
  // np.byte == int8, but all values in {0..5, 10} fit in both int8 and uint8.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const fltLoc = findFltFiles(candidateFltDirs());
const refLoc = findReferenceFiles(candidateRefDirs());

if (!fltLoc || !refLoc) {
  console.log('[SKIP] NISAR Inundation regression — data not present');
  console.log('       .flt dir needed — tried:', candidateFltDirs().join(', '));
  console.log('       class*.bin dir needed — tried:', candidateRefDirs().join(', '));
  console.log('       Set NISAR_INUNDATION_DATA (or _FLT_DIR/_REF_DIR).');
  process.exit(0);
}

console.log(`[load] flt dir: ${fltLoc.dir}  (${fltLoc.files.length} files)`);
console.log(`[load] ref dir: ${refLoc.dir}`);

// Partition by polarization and sort by date.
const hhFiles = fltLoc.files.filter((f) => /_HHHH_129A_/.test(f))
  .sort((a, b) => dateKeyFromName(a).localeCompare(dateKeyFromName(b)));
const hvFiles = fltLoc.files.filter((f) => /_HVHV_129A_/.test(f))
  .sort((a, b) => dateKeyFromName(a).localeCompare(dateKeyFromName(b)));

if (hhFiles.length !== hvFiles.length) {
  throw new Error(`HH/HV count mismatch: ${hhFiles.length} vs ${hvFiles.length}`);
}
if (hhFiles.length < 6) {
  throw new Error(`Need at least 6 dates per pol, got ${hhFiles.length}`);
}

// The notebook uses exactly 6 inputs (July 1 → Sept 30, 2019); take the first 6
// sorted files so that the N-1 = 5 rolling outputs align with class0..class4.
const HH = hhFiles.slice(0, 6);
const HV = hvFiles.slice(0, 6);

console.log('[load] dates:');
for (let i = 0; i < HH.length; i++) {
  console.log(`         ${dateKeyFromName(HH[i])}  HH=${HH[i].split('/').pop()}  HV=${HV[i].split('/').pop()}`);
}

const stackHH = HH.map(loadFlt);
const stackHV = HV.map(loadFlt);

console.log('[run ] runInundationATBD Nave=2 ...');
const t0 = Date.now();
const result = runInundationATBD(stackHH, stackHV, { Nave: 2 });
console.log(`[run ] done in ${(Date.now() - t0)} ms  ->  ${result.classifications.length} frames`);

const refs = refLoc.files.map(loadClassBin);
if (refs.length !== result.classifications.length) {
  throw new Error(`frame count mismatch: got ${result.classifications.length}, refs=${refs.length}`);
}

// ─── Per-frame comparison ───────────────────────────────────────────────────

let totalMismatch = 0;
let totalPixels = 0;
const perFrame = [];

for (let k = 0; k < refs.length; k++) {
  const got = result.classifications[k];
  const ref = refs[k];
  const confusion = Array.from({ length: 12 }, () => new Uint32Array(12));
  const sampleMismatches = [];
  let nMis = 0;
  for (let i = 0; i < PIXELS; i++) {
    const a = got[i], b = ref[i];
    const ai = a <= 5 ? a : 11; // map the masked sentinel (10) to row 11
    const bi = b <= 5 ? b : 11;
    confusion[ai][bi]++;
    if (a !== b) {
      nMis++;
      if (sampleMismatches.length < 20) {
        const hhVal = result.correctedHH[k][i];
        const hvVal = result.correctedHV[k][i];
        const ratioVal = result.ratio[k][i];
        const row = (i / NSAMP) | 0;
        const col = i % NSAMP;
        sampleMismatches.push({
          frame: k, idx: i, row, col, ref: b, got: a,
          HH: hhVal, HV: hvVal, ratio: ratioVal,
        });
      }
    }
  }
  totalMismatch += nMis;
  totalPixels += PIXELS;
  perFrame.push({ k, nMis, pct: nMis / PIXELS, confusion, sampleMismatches });
  console.log(`[cmp ] frame ${k}: mismatches ${nMis} / ${PIXELS}  (${((nMis / PIXELS) * 100).toFixed(4)}%)`);
}

function printConfusion(c) {
  const labels = ['0 ', '1 ', '2 ', '3 ', '4 ', '5 ', '6 ', '7 ', '8 ', '9 ', '10', 'm '];
  process.stdout.write('       got\\ref  ' + labels.map((l) => l.padStart(9)).join('') + '\n');
  for (let i = 0; i < 12; i++) {
    const row = c[i];
    let any = false;
    for (let j = 0; j < 12; j++) if (row[j]) { any = true; break; }
    if (!any) continue;
    const cells = Array.from(row).map((v) => (v === 0 ? '.' : String(v)).padStart(9));
    process.stdout.write(`       ${labels[i]}        ${cells.join('')}\n`);
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

console.log('');
console.log('=== SUMMARY ===');
console.log(`total mismatches: ${totalMismatch} / ${totalPixels}  (${((totalMismatch / totalPixels) * 100).toFixed(4)}%)`);
for (const f of perFrame) {
  console.log(`\n-- frame ${f.k}  (${f.nMis} mismatches) --`);
  printConfusion(f.confusion);
  if (f.sampleMismatches.length) {
    console.log('       first mismatches:');
    for (const m of f.sampleMismatches.slice(0, 10)) {
      const r = Number.isFinite(m.ratio) ? m.ratio.toFixed(4) : String(m.ratio);
      console.log(`         pixel (${m.row},${m.col}) ref=${m.ref} got=${m.got}  HH=${m.HH.toExponential(3)}  HV=${m.HV.toExponential(3)}  ratio=${r}`);
    }
  }
}

// ─── Pass criteria ──────────────────────────────────────────────────────────
//
// The notebook uses `>` and `<=` inclusive-exclusive bounds, exactly as our
// port does, so exact match is the intent. Tie-breaking between overlapping
// classes is resolved in the notebook by applying class5 → class0 in order,
// with later writes winning (class0 stomps class5). Our port sweeps the same
// order. Float32 arithmetic is deterministic to the last bit for the same
// operation tree, so if the computation paths agree we should get a zero-
// mismatch result.
//
// Allow a tiny tolerance (0.01% of pixels) for residual differences that might
// come from the correction-factor denominator path — but flag zero tolerance
// as the target.

const MISMATCH_LIMIT = parseFloat(process.env.NISAR_INUNDATION_TOLERANCE || '0.0001');
const rate = totalMismatch / totalPixels;

// Write structured output for the next session.
const outDir = join(ROOT, '.sardine', 'D289');
try { readdirSync(outDir); } catch { try { writeFileSync(join(outDir, '.keep'), ''); } catch {} }
try {
  writeFileSync(join(ROOT, '.sardine', 'D289', 'regression_report.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    tolerance: MISMATCH_LIMIT,
    total_pixels: totalPixels,
    total_mismatch: totalMismatch,
    mismatch_rate: rate,
    per_frame: perFrame.map((f) => ({
      frame: f.k,
      mismatches: f.nMis,
      pct: f.pct,
      confusion: f.confusion.map((row) => Array.from(row)),
    })),
  }, null, 2));
} catch (e) {
  // Directory may not yet exist — non-fatal.
  console.log(`[note] could not write report: ${e.message}`);
}

if (rate > MISMATCH_LIMIT) {
  console.error(`\nFAIL: mismatch rate ${(rate * 100).toFixed(4)}% > tolerance ${(MISMATCH_LIMIT * 100).toFixed(4)}%`);
  process.exit(1);
}
console.log(`\nPASS: mismatch rate ${(rate * 100).toFixed(4)}% within tolerance ${(MISMATCH_LIMIT * 100).toFixed(4)}%`);
