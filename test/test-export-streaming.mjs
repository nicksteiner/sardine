#!/usr/bin/env node
/**
 * Export streaming test — stream small patches from S3 to local GeoTIFF.
 *
 * For each file in the test bucket, opens the dataset via URL streaming,
 * then exports a 2048×2048 center patch (at ml=2 → 1024×1024 output) using
 * the same getExportStripe pipeline that the browser export uses.
 *
 * This exercises the full export-from-S3 data path:
 *   1. loadNISARGCOVFromUrl()     — open dataset
 *   2. getExportStripe()          — stripe-based chunk fetch + multilook
 *   3. writeFloat32GeoTIFF()      — encode GeoTIFF (tiles + DEFLATE)
 *   4. Write to local file
 *
 * Metrics tracked per file:
 *   - Open time (metadata + dataset load)
 *   - Per-stripe fetch time, HTTP request count, bytes transferred
 *   - Multilook time (box-filter averaging)
 *   - GeoTIFF encode time
 *   - Total export time & file size
 *
 * Usage:
 *   node test/test-export-streaming.mjs --all
 *   node test/test-export-streaming.mjs "<presigned-url>"
 *   node test/test-export-streaming.mjs --all --patch 4096  (custom patch size)
 *   node test/test-export-streaming.mjs --all --ml 4         (custom multilook)
 *   node test/test-export-streaming.mjs --all --full          (full image export)
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { listNISARDatasetsFromUrl, loadNISARGCOVFromUrl } from '../src/loaders/nisar-loader.js';
import { writeFloat32GeoTIFF } from '../src/utils/geotiff-writer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BUCKET = 'nisar-oasis';
const REGION = 'us-west-2';
const PREFIX = 'stream-test/';
const OUTPUT_DIR = 'test/export-output';

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Instrument fetch ─────────────────────────────────────────────────────────

let fetchCount = 0;
let fetchBytes = 0;
const errors = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async function (...args) {
  fetchCount++;
  try {
    const response = await originalFetch.apply(this, args);
    const contentLength = response.headers.get('content-length');
    if (contentLength) fetchBytes += parseInt(contentLength, 10);
    if (!response.ok && response.status !== 206) {
      errors.push(`HTTP ${response.status} for Range: ${args[1]?.headers?.Range || 'none'}`);
    }
    return response;
  } catch (e) {
    errors.push(`Fetch error: ${e.message}`);
    throw e;
  }
};

function resetStats() {
  fetchCount = 0;
  fetchBytes = 0;
  errors.length = 0;
}

function getStats() {
  return { count: fetchCount, bytes: fetchBytes, errors: [...errors] };
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

async function listTestFiles() {
  const { execSync } = await import('child_process');
  const output = execSync(
    `aws s3 ls s3://${BUCKET}/${PREFIX} --region ${REGION}`,
    { encoding: 'utf-8' }
  );
  const files = [];
  for (const line of output.trim().split('\n')) {
    const m = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(\d+)\s+(.+)/);
    if (m && (m[2].endsWith('.h5') || m[2].endsWith('.hdf5'))) {
      files.push({ key: `${PREFIX}${m[2]}`, size: parseInt(m[1], 10) });
    }
  }
  return files;
}

async function presignUrl(key) {
  const { execSync } = await import('child_process');
  return execSync(
    `aws s3 presign s3://${BUCKET}/${key} --expires-in 3600 --region ${REGION}`,
    { encoding: 'utf-8' }
  ).trim();
}

// ── Core export test ─────────────────────────────────────────────────────────

async function testExportStreaming(url, label, opts = {}) {
  const { patchSize = 2048, ml = 2, fullImage = false } = opts;

  console.log(`\n${'━'.repeat(76)}`);
  console.log(`  EXPORT STREAMING TEST: ${label}`);
  console.log(`${'━'.repeat(76)}`);

  // ─── Phase 1: Open file ────────────────────────────────────────────────────
  resetStats();
  const t0 = performance.now();

  const listResult = await listNISARDatasetsFromUrl(url);
  const datasets = listResult.datasets || listResult;
  const streamReader = listResult._streamReader || null;

  if (!datasets || datasets.length === 0) {
    console.log('  ✗ No datasets found — skipping');
    return null;
  }

  const freq = datasets[0].frequency;
  const pol = datasets[0].polarization;
  const openStats = getStats();

  // ─── Phase 2: Load dataset ─────────────────────────────────────────────────
  resetStats();
  const data = await loadNISARGCOVFromUrl(url, {
    frequency: freq,
    polarization: pol,
    _streamReader: streamReader,
  });

  const loadTime = performance.now() - t0;
  const loadStats = getStats();
  const { width, height } = data;

  console.log(`  Image: ${width}×${height}  |  Dataset: ${freq}/${pol}`);
  console.log(`  Open+Load: ${fmt(loadTime)}  |  ${openStats.count + loadStats.count} reqs  |  ${fmtSize(openStats.bytes + loadStats.bytes)}`);

  // Check export capability
  if (!data.getExportStripe) {
    console.log('  ✗ getExportStripe not available — skipping');
    return null;
  }

  // ─── Phase 3: Define export region ─────────────────────────────────────────

  let srcLeft, srcTop, srcW, srcH;
  if (fullImage) {
    srcLeft = 0;
    srcTop = 0;
    srcW = width;
    srcH = height;
  } else {
    // Center patch (clamp to image bounds)
    const halfPatch = Math.floor(patchSize / 2);
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    srcLeft = Math.max(0, cx - halfPatch);
    srcTop = Math.max(0, cy - halfPatch);
    srcW = Math.min(patchSize, width - srcLeft);
    srcH = Math.min(patchSize, height - srcTop);
  }

  const exportWidth = Math.floor(srcW / ml);
  const exportHeight = Math.floor(srcH / ml);

  // getExportStripe supports startCol/numCols for column-range subsetting.
  // This fetches only the chunks covering the patch — not the full image width.
  const patchStartRow = Math.floor(srcTop / ml); // Output row in full-image space
  const patchStartCol = Math.floor(srcLeft / ml); // Output col in full-image space

  console.log(`  Patch: [${srcLeft},${srcTop}] → [${srcLeft + srcW},${srcTop + srcH}] (${srcW}×${srcH} source pixels)`);
  console.log(`  Multilook: ${ml}×${ml}  |  Export: ${exportWidth}×${exportHeight} pixels`);
  console.log(`  Expected output: ~${fmtSize(exportWidth * exportHeight * 4)} (Float32, uncompressed)`);

  // ─── Phase 4: Stripe-based export ──────────────────────────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  STRIPE EXPORT — streaming chunks from S3`);
  console.log(`  ${'─'.repeat(68)}`);
  console.log(`  ${'Stripe'.padEnd(10)} ${'Rows'.padEnd(16)} ${'Time'.padStart(8)} ${'Reqs'.padStart(6)} ${'Data'.padStart(10)} ${'Fill%'.padStart(8)}`);

  const stripeRows = 256; // Output rows per stripe (matches main.jsx)
  const numStripes = Math.ceil(exportHeight / stripeRows);

  // Allocate output band
  const outputBand = new Float32Array(exportWidth * exportHeight);
  let totalStripeTime = 0;
  let totalStripeReqs = 0;
  let totalStripeBytes = 0;
  let totalNonZero = 0;

  for (let s = 0; s < numStripes; s++) {
    const localStartRow = s * stripeRows;
    const localNumRows = Math.min(stripeRows, exportHeight - localStartRow);

    // Map to full-image row coordinates; use startCol/numCols for subset
    const imageStartRow = patchStartRow + localStartRow;

    resetStats();
    const tStripe = performance.now();

    const stripe = await data.getExportStripe({
      startRow: imageStartRow,
      numRows: localNumRows,
      ml,
      exportWidth, // not used when numCols is set — kept for API compat
      startCol: patchStartCol,
      numCols: exportWidth,
    });

    const stripeTime = performance.now() - tStripe;
    const stripeStats = getStats();

    totalStripeTime += stripeTime;
    totalStripeReqs += stripeStats.count;
    totalStripeBytes += stripeStats.bytes;

    // Stripe is already column-subsetted — copy directly
    const bandData = stripe.bands[pol];
    let stripeNonZero = 0;
    for (let row = 0; row < localNumRows; row++) {
      for (let col = 0; col < exportWidth; col++) {
        const dstIdx = (localStartRow + row) * exportWidth + col;
        const v = bandData[row * exportWidth + col];
        outputBand[dstIdx] = v;
        if (v > 0 && !isNaN(v)) stripeNonZero++;
      }
    }
    totalNonZero += stripeNonZero;

    const fillPct = (100 * stripeNonZero / (localNumRows * exportWidth)).toFixed(0);

    console.log(
      `  ${(`${s + 1}/${numStripes}`).padEnd(10)} ` +
      `${(`${imageStartRow}→${imageStartRow + localNumRows - 1}`).padEnd(16)} ` +
      `${fmt(stripeTime).padStart(8)} ` +
      `${String(stripeStats.count).padStart(6)} ` +
      `${fmtSize(stripeStats.bytes).padStart(10)} ` +
      `${(fillPct + '%').padStart(8)}`
    );

    if (stripeStats.errors.length > 0) {
      for (const e of stripeStats.errors.slice(0, 2)) {
        console.log(`    ✗ ${e}`);
      }
    }
  }

  const totalFillPct = (100 * totalNonZero / (exportWidth * exportHeight)).toFixed(1);

  console.log(`\n  Stripe totals: ${fmt(totalStripeTime)}  |  ${totalStripeReqs} reqs  |  ${fmtSize(totalStripeBytes)}  |  ${totalFillPct}% fill`);

  // ─── Phase 5: Encode GeoTIFF ──────────────────────────────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  GEOTIFF ENCODING`);
  console.log(`  ${'─'.repeat(68)}`);

  const tEncode = performance.now();

  // Compute export bounds for the patch
  const geoBounds = data.worldBounds || data.bounds;
  const nativeSpacingX = (geoBounds[2] - geoBounds[0]) / (width - 1 || 1);
  const nativeSpacingY = (geoBounds[3] - geoBounds[1]) / (height - 1 || 1);

  // Pixel-edge bounds for the exported patch
  const exportBounds = [
    geoBounds[0] + srcLeft * nativeSpacingX - nativeSpacingX / 2,          // minX
    geoBounds[1] + (height - srcTop - srcH) * nativeSpacingY - nativeSpacingY / 2, // minY
    geoBounds[0] + (srcLeft + exportWidth * ml) * nativeSpacingX - nativeSpacingX / 2, // maxX
    geoBounds[1] + (height - srcTop) * nativeSpacingY - nativeSpacingY / 2,        // maxY
  ];

  const epsgMatch = data.crs?.match(/EPSG:(\d+)/);
  const epsgCode = epsgMatch ? parseInt(epsgMatch[1]) : 32610;

  const bands = { [pol]: outputBand };
  const geotiff = await writeFloat32GeoTIFF(bands, [pol], exportWidth, exportHeight, exportBounds, epsgCode, {});

  const encodeTime = performance.now() - tEncode;

  console.log(`  Encode: ${fmt(encodeTime)}  |  ${fmtSize(geotiff.byteLength)} compressed`);
  console.log(`  EPSG: ${epsgCode}  |  Bounds: [${exportBounds.map(b => b.toFixed(2)).join(', ')}]`);

  // ─── Phase 6: Write to disk ────────────────────────────────────────────────
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const baseName = label.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/_+/g, '_');
  const patchLabel = fullImage ? 'full' : `center${patchSize}`;
  const filename = `${baseName}_${patchLabel}_ml${ml}_${exportWidth}x${exportHeight}.tif`;
  const outputPath = `${OUTPUT_DIR}/${filename}`;

  writeFileSync(outputPath, Buffer.from(geotiff));
  console.log(`  Written: ${outputPath}`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  const totalTime = performance.now() - t0;

  console.log(`\n  ${'═'.repeat(68)}`);
  console.log(`  SUMMARY: ${label}`);
  console.log(`  ${'═'.repeat(68)}`);
  console.log(`  Open + Load              ${fmt(loadTime).padStart(10)}`);
  console.log(`  Stripe fetch + multilook ${fmt(totalStripeTime).padStart(10)}  (${totalStripeReqs} reqs, ${fmtSize(totalStripeBytes)})`);
  console.log(`  GeoTIFF encode           ${fmt(encodeTime).padStart(10)}  (${fmtSize(geotiff.byteLength)})`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  ★ Total export time      ${fmt(totalTime).padStart(10)}`);
  console.log(`  ★ Data fill              ${totalFillPct.padStart(9)}%`);
  console.log(`  ★ Output file            ${fmtSize(geotiff.byteLength).padStart(10)}`);
  console.log(`  ★ Transfer efficiency    ${fmtSize(totalStripeBytes).padStart(10)} fetched → ${fmtSize(geotiff.byteLength)} output`);

  if (totalStripeBytes > 0) {
    const ratio = geotiff.byteLength / totalStripeBytes;
    console.log(`    Compression ratio: ${(ratio * 100).toFixed(1)}% (output / fetched)`);
  }

  // Throughput
  const fetchSec = totalStripeTime / 1000;
  if (fetchSec > 0) {
    console.log(`    Fetch throughput: ${fmtSize(totalStripeBytes / fetchSec)}/s`);
  }

  const pass = totalNonZero > 0 && errors.length === 0;

  if (pass) {
    console.log(`  ✓ PASS — exported ${exportWidth}×${exportHeight} with ${totalFillPct}% fill`);
  } else {
    console.log(`  ✗ FAIL — ${totalNonZero === 0 ? 'all zeros' : ''} ${errors.length > 0 ? errors.length + ' errors' : ''}`);
  }

  return {
    label, width, height,
    patchSize: fullImage ? `${width}×${height}` : `${patchSize}×${patchSize}`,
    ml, exportWidth, exportHeight,
    loadTime,
    stripeTime: totalStripeTime,
    stripeReqs: totalStripeReqs,
    stripeBytes: totalStripeBytes,
    encodeTime,
    outputBytes: geotiff.byteLength,
    totalTime,
    fillPct: parseFloat(totalFillPct),
    pass,
    outputPath,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse options
  let patchSize = 2048;
  let ml = 2;
  let fullImage = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patch' && args[i + 1]) {
      patchSize = parseInt(args[++i], 10);
    } else if (args[i] === '--ml' && args[i + 1]) {
      ml = parseInt(args[++i], 10);
    } else if (args[i] === '--full') {
      fullImage = true;
    } else {
      positional.push(args[i]);
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  SARdine Export Streaming Test                                         ║');
  console.log('║  Stream patches from S3 → local GeoTIFF via getExportStripe            ║');
  console.log('║  Tests: chunk batch fetch, multilook box-filter, GeoTIFF encoding      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log(`  Config: patch=${fullImage ? 'full' : patchSize}, ml=${ml}`);

  let results = [];

  if (positional[0] === '--all') {
    console.log(`\nListing files in s3://${BUCKET}/${PREFIX}...`);
    const files = await listTestFiles();
    console.log(`Found ${files.length} test files`);

    for (const file of files) {
      try {
        console.log(`\nGenerating pre-signed URL for ${file.key.split('/').pop()}...`);
        const url = await presignUrl(file.key);
        const shortName = file.key.split('/').pop();
        const result = await testExportStreaming(url, shortName, { patchSize, ml, fullImage });
        if (result) results.push(result);
      } catch (e) {
        console.log(`  ✗ FATAL: ${e.message}`);
        console.error(e);
      }
    }
  } else if (positional[0]) {
    const url = positional[0];
    const name = decodeURIComponent(url.split('?')[0].split('/').pop());
    const result = await testExportStreaming(url, name, { patchSize, ml, fullImage });
    if (result) results.push(result);
  } else {
    console.log('\nUsage:');
    console.log('  node test/test-export-streaming.mjs --all');
    console.log('  node test/test-export-streaming.mjs "<presigned-url>"');
    console.log('  node test/test-export-streaming.mjs --all --patch 4096');
    console.log('  node test/test-export-streaming.mjs --all --ml 4');
    console.log('  node test/test-export-streaming.mjs --all --full');
    process.exit(1);
  }

  // ─── Final report ──────────────────────────────────────────────────────────
  if (results.length > 1) {
    console.log(`\n${'═'.repeat(90)}`);
    console.log('  FINAL REPORT');
    console.log(`${'═'.repeat(90)}`);
    console.log(
      `  ${'File'.padEnd(30)} ` +
      `${'Patch'.padStart(12)} ` +
      `${'Open'.padStart(8)} ` +
      `${'Fetch'.padStart(8)} ` +
      `${'Reqs'.padStart(6)} ` +
      `${'Xfer'.padStart(10)} ` +
      `${'Encode'.padStart(8)} ` +
      `${'Total'.padStart(8)} ` +
      `${'Output'.padStart(10)} ` +
      `${'Fill'.padStart(6)} ` +
      `${'Result'.padStart(8)}`
    );
    console.log(`  ${'─'.repeat(88)}`);

    for (const r of results) {
      const name = r.label.length > 28 ? r.label.slice(0, 28) + '…' : r.label;
      console.log(
        `  ${name.padEnd(30)} ` +
        `${`${r.exportWidth}×${r.exportHeight}`.padStart(12)} ` +
        `${fmt(r.loadTime).padStart(8)} ` +
        `${fmt(r.stripeTime).padStart(8)} ` +
        `${String(r.stripeReqs).padStart(6)} ` +
        `${fmtSize(r.stripeBytes).padStart(10)} ` +
        `${fmt(r.encodeTime).padStart(8)} ` +
        `${fmt(r.totalTime).padStart(8)} ` +
        `${fmtSize(r.outputBytes).padStart(10)} ` +
        `${(r.fillPct + '%').padStart(6)} ` +
        `${(r.pass ? '✓ PASS' : '✗ FAIL').padStart(8)}`
      );
    }

    const totalXfer = results.reduce((s, r) => s + r.stripeBytes, 0);
    const totalOutput = results.reduce((s, r) => s + r.outputBytes, 0);
    const totalTime = results.reduce((s, r) => s + r.totalTime, 0);
    const allPass = results.every(r => r.pass);

    console.log(`\n  Total: ${fmtSize(totalXfer)} fetched → ${fmtSize(totalOutput)} output in ${fmt(totalTime)}`);
    console.log(`  Overall: ${allPass ? '✓ ALL PASS' : '✗ SOME FAILED'}`);

    if (!allPass) {
      console.log(`\n  Output files in: ${OUTPUT_DIR}/`);
    }
  }

  if (results.length > 0) {
    console.log(`\n  Output files:`);
    for (const r of results) {
      console.log(`    ${r.outputPath}`);
    }
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
