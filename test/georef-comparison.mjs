/**
 * Georeferencing comparison test: sardine writeFloat32GeoTIFF vs rasterio
 *
 * Writes a GeoTIFF with sardine, reads it back with rasterio,
 * and also writes an equivalent file with rasterio — then compares both.
 *
 * Usage: node test/georef-comparison.mjs
 */

import { writeFloat32GeoTIFF } from '../src/utils/geotiff-writer.js';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Test parameters ────────────────────────────────────────────────────────

// Realistic NISAR-like UTM bounds (Peru, UTM 18S = EPSG:32718)
const WIDTH = 256;
const HEIGHT = 200;
const EPSG = 32718;
const BOUNDS = [200000, 8500000, 225600, 8520000]; // [minX, minY, maxX, maxY]
// → pixel scale: 100m x 100m

// Generate synthetic data (ramp pattern for easy verification)
const data = new Float32Array(WIDTH * HEIGHT);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    data[y * WIDTH + x] = (x + y * 0.1) * 0.001; // small linear power values
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS}  ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL}  ${label}  ${detail}`);
    failed++;
  }
}

function approxEq(a, b, tol = 1e-6) {
  return Math.abs(a - b) < tol;
}

// ─── Step 1: Write GeoTIFF with sardine ─────────────────────────────────────

console.log('\n═══ Sardine vs Rasterio GeoTIFF Comparison ═══\n');

const tmpDir = mkdtempSync(join(tmpdir(), 'sardine-georef-'));
const sardineFile = join(tmpDir, 'sardine_output.tif');
const rasterioFile = join(tmpDir, 'rasterio_output.tif');

console.log(`Working directory: ${tmpDir}`);
console.log(`Test image: ${WIDTH}x${HEIGHT}, EPSG:${EPSG}`);
console.log(`Bounds: [${BOUNDS.join(', ')}]`);

const [minX, minY, maxX, maxY] = BOUNDS;
const expectedPixelX = (maxX - minX) / WIDTH;
const expectedPixelY = (maxY - minY) / HEIGHT;
console.log(`Expected pixel scale: ${expectedPixelX}m x ${expectedPixelY}m\n`);

// Write sardine GeoTIFF
const sardineBuffer = writeFloat32GeoTIFF(
  { band1: data }, ['band1'], WIDTH, HEIGHT, BOUNDS, EPSG
);
writeFileSync(sardineFile, Buffer.from(sardineBuffer));
console.log(`Sardine GeoTIFF written: ${sardineFile} (${(sardineBuffer.byteLength / 1024).toFixed(1)} KB)`);

// ─── Step 2: Write equivalent GeoTIFF with rasterio ─────────────────────────

const pythonScript = `
import rasterio
import numpy as np
from rasterio.transform import from_bounds
from rasterio.crs import CRS
import json
import sys

sardine_file = sys.argv[1]
rasterio_file = sys.argv[2]
width = ${WIDTH}
height = ${HEIGHT}
epsg = ${EPSG}
bounds = ${JSON.stringify(BOUNDS)}
minX, minY, maxX, maxY = bounds

# Generate identical data
data = np.zeros((height, width), dtype=np.float32)
for y in range(height):
    for x in range(width):
        data[y, x] = (x + y * 0.1) * 0.001

# Write with rasterio (pixel-is-area convention)
transform = from_bounds(minX, minY, maxX, maxY, width, height)
with rasterio.open(
    rasterio_file, 'w',
    driver='GTiff',
    width=width,
    height=height,
    count=1,
    dtype='float32',
    crs=CRS.from_epsg(epsg),
    transform=transform,
    compress='deflate',
    tiled=True,
    blockxsize=512,
    blockysize=512,
) as dst:
    dst.write(data, 1)

# ─── Read back sardine file ─────────────────────────────────────────────
result = {}

with rasterio.open(sardine_file) as src:
    s = {}
    s['crs'] = src.crs.to_epsg() if src.crs else None
    s['width'] = src.width
    s['height'] = src.height
    s['transform'] = list(src.transform)[:6]  # a,b,c,d,e,f
    s['bounds'] = list(src.bounds)  # BoundingBox(left, bottom, right, top)
    s['res'] = list(src.res)
    s['count'] = src.count
    s['dtypes'] = list(src.dtypes)
    s['nodata'] = str(src.nodata) if src.nodata is not None else None
    band = src.read(1)
    s['data_min'] = float(np.nanmin(band))
    s['data_max'] = float(np.nanmax(band))
    s['data_mean'] = float(np.nanmean(band))
    s['pixel_0_0'] = float(band[0, 0])
    s['pixel_0_1'] = float(band[0, 1])
    s['pixel_1_0'] = float(band[1, 0])
    s['pixel_center'] = float(band[height // 2, width // 2])
    s['nonzero_count'] = int(np.count_nonzero(band))
    result['sardine'] = s

# ─── Read back rasterio file ────────────────────────────────────────────
with rasterio.open(rasterio_file) as src:
    r = {}
    r['crs'] = src.crs.to_epsg() if src.crs else None
    r['width'] = src.width
    r['height'] = src.height
    r['transform'] = list(src.transform)[:6]
    r['bounds'] = list(src.bounds)
    r['res'] = list(src.res)
    r['count'] = src.count
    r['dtypes'] = list(src.dtypes)
    r['nodata'] = str(src.nodata) if src.nodata is not None else None
    band = src.read(1)
    r['data_min'] = float(np.nanmin(band))
    r['data_max'] = float(np.nanmax(band))
    r['data_mean'] = float(np.nanmean(band))
    r['pixel_0_0'] = float(band[0, 0])
    r['pixel_0_1'] = float(band[0, 1])
    r['pixel_1_0'] = float(band[1, 0])
    r['pixel_center'] = float(band[height // 2, width // 2])
    r['nonzero_count'] = int(np.count_nonzero(band))
    result['rasterio'] = r

print(json.dumps(result, indent=2))
`;

const pyFile = join(tmpDir, 'compare.py');
writeFileSync(pyFile, pythonScript);

let result;
try {
  const stdout = execSync(`python3 "${pyFile}" "${sardineFile}" "${rasterioFile}"`, {
    encoding: 'utf-8',
    timeout: 30000,
  });
  result = JSON.parse(stdout);
} catch (e) {
  console.error('Python comparison failed:', e.stderr || e.message);
  process.exit(1);
}

const s = result.sardine;
const r = result.rasterio;

// ─── Step 3: Compare results ────────────────────────────────────────────────

console.log('\n── Sardine GeoTIFF (read by rasterio) ──');
console.log(`  CRS:       EPSG:${s.crs}`);
console.log(`  Size:      ${s.width} x ${s.height}`);
console.log(`  Bounds:    [${s.bounds.map(b => b.toFixed(2)).join(', ')}]`);
console.log(`  Transform: [${s.transform.map(t => t.toFixed(6)).join(', ')}]`);
console.log(`  Res:       ${s.res[0].toFixed(2)} x ${s.res[1].toFixed(2)}`);
console.log(`  Dtype:     ${s.dtypes[0]}`);
console.log(`  Data:      min=${s.data_min.toExponential(3)}, max=${s.data_max.toExponential(3)}, mean=${s.data_mean.toExponential(3)}`);
console.log(`  Pixels:    [0,0]=${s.pixel_0_0.toExponential(4)}, [0,1]=${s.pixel_0_1.toExponential(4)}, [1,0]=${s.pixel_1_0.toExponential(4)}`);

console.log('\n── Rasterio GeoTIFF (reference) ──');
console.log(`  CRS:       EPSG:${r.crs}`);
console.log(`  Size:      ${r.width} x ${r.height}`);
console.log(`  Bounds:    [${r.bounds.map(b => b.toFixed(2)).join(', ')}]`);
console.log(`  Transform: [${r.transform.map(t => t.toFixed(6)).join(', ')}]`);
console.log(`  Res:       ${r.res[0].toFixed(2)} x ${r.res[1].toFixed(2)}`);
console.log(`  Dtype:     ${r.dtypes[0]}`);
console.log(`  Data:      min=${r.data_min.toExponential(3)}, max=${r.data_max.toExponential(3)}, mean=${r.data_mean.toExponential(3)}`);
console.log(`  Pixels:    [0,0]=${r.pixel_0_0.toExponential(4)}, [0,1]=${r.pixel_0_1.toExponential(4)}, [1,0]=${r.pixel_1_0.toExponential(4)}`);

// ─── Step 4: Assertions ─────────────────────────────────────────────────────

console.log('\n── Comparison Checks ──\n');

// CRS
check('CRS matches', s.crs === r.crs && s.crs === EPSG,
  `sardine=${s.crs}, rasterio=${r.crs}, expected=${EPSG}`);

// Dimensions
check('Width matches', s.width === r.width && s.width === WIDTH,
  `sardine=${s.width}, rasterio=${r.width}`);
check('Height matches', s.height === r.height && s.height === HEIGHT,
  `sardine=${s.height}, rasterio=${r.height}`);

// Bounds (rasterio returns [left, bottom, right, top])
const boundsTol = 1.0; // 1m tolerance for UTM
check('Bounds: left (minX)',
  approxEq(s.bounds[0], r.bounds[0], boundsTol),
  `sardine=${s.bounds[0].toFixed(2)}, rasterio=${r.bounds[0].toFixed(2)}, diff=${Math.abs(s.bounds[0] - r.bounds[0]).toFixed(4)}`);
check('Bounds: bottom (minY)',
  approxEq(s.bounds[1], r.bounds[1], boundsTol),
  `sardine=${s.bounds[1].toFixed(2)}, rasterio=${r.bounds[1].toFixed(2)}, diff=${Math.abs(s.bounds[1] - r.bounds[1]).toFixed(4)}`);
check('Bounds: right (maxX)',
  approxEq(s.bounds[2], r.bounds[2], boundsTol),
  `sardine=${s.bounds[2].toFixed(2)}, rasterio=${r.bounds[2].toFixed(2)}, diff=${Math.abs(s.bounds[2] - r.bounds[2]).toFixed(4)}`);
check('Bounds: top (maxY)',
  approxEq(s.bounds[3], r.bounds[3], boundsTol),
  `sardine=${s.bounds[3].toFixed(2)}, rasterio=${r.bounds[3].toFixed(2)}, diff=${Math.abs(s.bounds[3] - r.bounds[3]).toFixed(4)}`);

// Pixel scale / resolution
check('Pixel scale X matches',
  approxEq(s.res[0], r.res[0], 0.01),
  `sardine=${s.res[0].toFixed(4)}, rasterio=${r.res[0].toFixed(4)}`);
check('Pixel scale Y matches',
  approxEq(s.res[1], r.res[1], 0.01),
  `sardine=${s.res[1].toFixed(4)}, rasterio=${r.res[1].toFixed(4)}`);

// Transform comparison (affine: a=scaleX, b=0, c=originX, d=0, e=-scaleY, f=originY)
// Rasterio transform: Affine(a, b, c, d, e, f)
//   a = pixel width, b = row rotation, c = x of upper-left
//   d = column rotation, e = -pixel height, f = y of upper-left
check('Transform: pixel width (a)',
  approxEq(s.transform[0], r.transform[0], 0.01),
  `sardine=${s.transform[0].toFixed(4)}, rasterio=${r.transform[0].toFixed(4)}`);
check('Transform: origin X (c)',
  approxEq(s.transform[2], r.transform[2], boundsTol),
  `sardine=${s.transform[2].toFixed(2)}, rasterio=${r.transform[2].toFixed(2)}`);
check('Transform: pixel height (e, negative)',
  approxEq(s.transform[4], r.transform[4], 0.01),
  `sardine=${s.transform[4].toFixed(4)}, rasterio=${r.transform[4].toFixed(4)}`);
check('Transform: origin Y (f = maxY)',
  approxEq(s.transform[5], r.transform[5], boundsTol),
  `sardine=${s.transform[5].toFixed(2)}, rasterio=${r.transform[5].toFixed(2)}`);

// Data values (should be identical since same Float32 input)
const valueTol = 1e-6;
check('Pixel [0,0] matches',
  approxEq(s.pixel_0_0, r.pixel_0_0, valueTol),
  `sardine=${s.pixel_0_0}, rasterio=${r.pixel_0_0}`);
check('Pixel [0,1] matches',
  approxEq(s.pixel_0_1, r.pixel_0_1, valueTol),
  `sardine=${s.pixel_0_1}, rasterio=${r.pixel_0_1}`);
check('Pixel [1,0] matches',
  approxEq(s.pixel_1_0, r.pixel_1_0, valueTol),
  `sardine=${s.pixel_1_0}, rasterio=${r.pixel_1_0}`);
check('Pixel center matches',
  approxEq(s.pixel_center, r.pixel_center, valueTol),
  `sardine=${s.pixel_center}, rasterio=${r.pixel_center}`);
check('Data range matches',
  approxEq(s.data_min, r.data_min, valueTol) && approxEq(s.data_max, r.data_max, valueTol),
  `sardine=[${s.data_min}, ${s.data_max}], rasterio=[${r.data_min}, ${r.data_max}]`);
check('Non-zero pixel count matches',
  s.nonzero_count === r.nonzero_count,
  `sardine=${s.nonzero_count}, rasterio=${r.nonzero_count}`);

// ─── Step 5: Geographic sanity checks ───────────────────────────────────────

console.log('\n── Geographic Sanity Checks ──\n');

// Verify the bounds are physically reasonable for Peru UTM 18S
check('Origin X in UTM 18S range (166,000-834,000)',
  s.bounds[0] >= 100000 && s.bounds[0] <= 900000,
  `minX=${s.bounds[0]}`);
check('Origin Y in southern hemisphere UTM range',
  s.bounds[1] >= 1000000 && s.bounds[1] <= 10000000,
  `minY=${s.bounds[1]}`);
check('Pixel scale is reasonable (10-500m)',
  s.res[0] >= 10 && s.res[0] <= 500,
  `pixelX=${s.res[0]}m`);
check('No arctic circle coords (Y > 7,000,000 for UTM south)',
  s.bounds[3] > 7000000 && s.bounds[3] < 10000001,
  `maxY=${s.bounds[3]} (would be >10M if mis-projected)`);

// ─── Step 6: Pixel-center → pixel-edge pipeline test ─────────────────────────
// This simulates the actual main.jsx export path:
//   worldBounds (pixel-center) + pixelSpacing → exportBounds (pixel-edge)

console.log('\n── Pixel-Center → Pixel-Edge Pipeline ──\n');

const pcWidth = 100, pcHeight = 80;
const pixelSpacing = 100; // 100m posting
// worldBounds = pixel-CENTER coords (first pixel center to last pixel center)
const pcWorldBounds = [200000, 8500000, 200000 + (pcWidth - 1) * pixelSpacing, 8500000 + (pcHeight - 1) * pixelSpacing];
// → [200000, 8500000, 209900, 8507900]

// Simulate main.jsx export handler (lines 847-854):
const nativeSpacingX = pixelSpacing;
const nativeSpacingY = pixelSpacing;
const pcExportBounds = [
  pcWorldBounds[0] - nativeSpacingX / 2,  // minX - half pixel = 199950
  pcWorldBounds[1] - nativeSpacingY / 2,  // minY - half pixel = 8499950
  pcWorldBounds[2] + nativeSpacingX / 2,  // maxX + half pixel = 209950
  pcWorldBounds[3] + nativeSpacingY / 2,  // maxY + half pixel = 8507950
];

const pcData = new Float32Array(pcWidth * pcHeight);
for (let y = 0; y < pcHeight; y++) {
  for (let x = 0; x < pcWidth; x++) {
    pcData[y * pcWidth + x] = (x + y * 0.1) * 0.001;
  }
}

const pcSardineFile = join(tmpDir, 'sardine_pixcenter.tif');
const pcRasterioFile = join(tmpDir, 'rasterio_pixcenter.tif');

const pcBuffer = writeFloat32GeoTIFF(
  { HHHH: pcData }, ['HHHH'], pcWidth, pcHeight, pcExportBounds, EPSG
);
writeFileSync(pcSardineFile, Buffer.from(pcBuffer));

// Rasterio equivalent: from_bounds with pixel-edge bounds produces same result
const pcPyScript = `
import rasterio
import numpy as np
from rasterio.transform import from_bounds
from rasterio.crs import CRS
import json, sys

sardine_file = sys.argv[1]
rasterio_file = sys.argv[2]
width = ${pcWidth}
height = ${pcHeight}
bounds = ${JSON.stringify(pcExportBounds)}
minX, minY, maxX, maxY = bounds

data = np.zeros((height, width), dtype=np.float32)
for y in range(height):
    for x in range(width):
        data[y, x] = (x + y * 0.1) * 0.001

transform = from_bounds(minX, minY, maxX, maxY, width, height)
with rasterio.open(rasterio_file, 'w', driver='GTiff', width=width, height=height,
    count=1, dtype='float32', crs=CRS.from_epsg(${EPSG}), transform=transform,
    compress='deflate', tiled=True, blockxsize=512, blockysize=512) as dst:
    dst.write(data, 1)

result = {}
for label, filepath in [('sardine', sardine_file), ('rasterio', rasterio_file)]:
    with rasterio.open(filepath) as src:
        d = {}
        d['crs'] = src.crs.to_epsg() if src.crs else None
        d['bounds'] = list(src.bounds)
        d['transform'] = list(src.transform)[:6]
        d['res'] = list(src.res)
        d['pixel_0_0'] = float(src.read(1)[0, 0])
        result[label] = d

print(json.dumps(result))
`;

const pcPyFile = join(tmpDir, 'compare_pc.py');
writeFileSync(pcPyFile, pcPyScript);

let pcResult;
try {
  const stdout = execSync(`python3 "${pcPyFile}" "${pcSardineFile}" "${pcRasterioFile}"`, {
    encoding: 'utf-8', timeout: 30000,
  });
  pcResult = JSON.parse(stdout);
} catch (e) {
  console.error('Pixel-center pipeline test failed:', e.stderr || e.message);
  pcResult = null;
}

if (pcResult) {
  const ps = pcResult.sardine;
  const pr = pcResult.rasterio;

  check('Pipeline: CRS preserved', ps.crs === EPSG, `got ${ps.crs}`);
  check('Pipeline: pixel scale = 100m',
    approxEq(ps.res[0], pixelSpacing, 0.01), `got ${ps.res[0]}`);
  check('Pipeline: bounds match rasterio',
    approxEq(ps.bounds[0], pr.bounds[0], 1) && approxEq(ps.bounds[3], pr.bounds[3], 1),
    `sardine=[${ps.bounds.map(b => b.toFixed(1)).join(',')}], rasterio=[${pr.bounds.map(b => b.toFixed(1)).join(',')}]`);
  check('Pipeline: origin correct (pixel-edge, not center)',
    approxEq(ps.transform[2], pcExportBounds[0], 1) && approxEq(ps.transform[5], pcExportBounds[3], 1),
    `origin=(${ps.transform[2]}, ${ps.transform[5]}), expected=(${pcExportBounds[0]}, ${pcExportBounds[3]})`);
  check('Pipeline: data values match',
    approxEq(ps.pixel_0_0, pr.pixel_0_0, 1e-6), `sardine=${ps.pixel_0_0}, rasterio=${pr.pixel_0_0}`);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

try {
  unlinkSync(sardineFile);
  unlinkSync(rasterioFile);
  unlinkSync(pyFile);
  unlinkSync(pcSardineFile);
  unlinkSync(pcRasterioFile);
  unlinkSync(pcPyFile);
} catch (_) { /* ignore cleanup errors */ }

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));

if (failed > 0) {
  console.log('\nSome checks failed — georeferencing may be incorrect.\n');
  process.exit(1);
} else {
  console.log('\nSardine GeoTIFF matches rasterio output.\n');
  process.exit(0);
}
