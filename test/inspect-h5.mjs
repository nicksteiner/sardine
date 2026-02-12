import { readFileSync } from 'fs';
import h5wasm from 'h5wasm';

const file = process.argv[2] || '/mnt/c/Users/nicks/Downloads/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5';

await h5wasm.ready;
const { FS } = h5wasm;
const buf = readFileSync(file);
FS.writeFile('data.h5', new Uint8Array(buf));
const h5 = new h5wasm.File('data.h5', 'r');

const freq = 'frequencyA';
const base = `/science/LSAR/GCOV/grids/${freq}`;

// Helper to safely get dataset
function safeGet(path) {
  try { return h5.get(path); } catch { return null; }
}

// Check data datasets
console.log('=== Data Datasets ===');
for (const pol of ['HHHH', 'HVHV', 'VVVV', 'HHHV', 'VVHV', 'HVVV']) {
  const ds = safeGet(`${base}/${pol}`);
  if (ds && ds.shape) {
    console.log(`  ${pol}: shape=[${ds.shape.join(', ')}] dtype=${ds.dtype}`);
  }
}

// Check coordinate arrays
console.log('\n=== Coordinate Arrays ===');
for (const name of ['xCoordinates', 'yCoordinates']) {
  const ds = safeGet(`${base}/${name}`);
  if (ds) {
    console.log(`  ${name}: shape=[${ds.shape.join(', ')}] dtype=${ds.dtype}`);
    const vals = ds.value;
    if (vals && vals.length > 0) {
      console.log(`    first=${vals[0]} last=${vals[vals.length - 1]} length=${vals.length}`);
    }
  } else {
    console.log(`  ${name}: NOT FOUND`);
  }
}

// Check coordinate spacing
console.log('\n=== Coordinate Spacing ===');
for (const name of ['xCoordinateSpacing', 'yCoordinateSpacing']) {
  const ds = safeGet(`${base}/${name}`);
  if (ds) {
    console.log(`  ${name}: ${ds.value}`);
  } else {
    console.log(`  ${name}: NOT FOUND`);
  }
}

// Check numberOfLooks
const nlDs = safeGet(`${base}/numberOfLooks`);
if (nlDs) {
  console.log(`\n=== numberOfLooks ===`);
  console.log(`  shape=[${nlDs.shape.join(', ')}] dtype=${nlDs.dtype}`);
  if (nlDs.shape.length === 0 || (nlDs.shape.length === 1 && nlDs.shape[0] <= 1)) {
    console.log(`  value: ${nlDs.value}`);
  }
}

// Summary comparison
console.log('\n=== Dimension Comparison ===');
const dataDs = safeGet(`${base}/HHHH`);
const xDs = safeGet(`${base}/xCoordinates`);
const yDs = safeGet(`${base}/yCoordinates`);

if (dataDs && xDs && yDs) {
  const [dh, dw] = dataDs.shape;
  const xLen = xDs.shape[0];
  const yLen = yDs.shape[0];
  console.log(`  Data (HHHH):    [${dh}, ${dw}]  (height, width)`);
  console.log(`  xCoordinates:   length=${xLen}  (should match width=${dw})`);
  console.log(`  yCoordinates:   length=${yLen}  (should match height=${dh})`);

  if (xLen !== dw) {
    console.log(`  *** X MISMATCH: coord/data ratio = ${(xLen / dw).toFixed(4)} ***`);
  }
  if (yLen !== dh) {
    console.log(`  *** Y MISMATCH: coord/data ratio = ${(yLen / dh).toFixed(4)} ***`);
  }
  if (xLen === dw && yLen === dh) {
    console.log(`  All dimensions match.`);
  }
}

h5.close();
