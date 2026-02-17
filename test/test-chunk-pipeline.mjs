#!/usr/bin/env node
/**
 * Chunk pipeline performance test — tiles down the center of the image.
 *
 * Exercises the exact SARdine visualization pipeline at multiple zoom levels,
 * requesting tiles along a vertical transect through the image center.
 * This stresses chunk reads that are NOT covered by the coarse prefetch grid.
 *
 * Pipeline tested:
 *   1. loadNISARGCOVFromUrl()      — open dataset
 *   2. prefetchOverviewChunks()    — warm coarse 8×8 grid
 *   3. getTile() at z=0           — full-image overview (chunk-sampling path)
 *   4. getTile() at mid zoom      — center strip (mix of cached + new chunks)
 *   5. getTile() at high zoom     — small center region (readRegion path)
 *
 * Metrics:
 *   - First paint: load + prefetch + z0 tile (what the user sees first)
 *   - Foreground tiles: time for all tiles without Phase 2 interference
 *   - Total with refinement: foreground + Phase 2 background work
 *
 * Usage:
 *   node test/test-chunk-pipeline.mjs "<presigned-url>"
 *   node test/test-chunk-pipeline.mjs --all
 */

import { listNISARDatasetsFromUrl, loadNISARGCOVFromUrl } from '../src/loaders/nisar-loader.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BUCKET = 'nisar-oasis';
const REGION = 'us-west-2';
const PREFIX = 'stream-test/';

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ── Capture console.warn/error ───────────────────────────────────────────────

const warnings = [];
const originalWarn = console.warn;
const originalError = console.error;

console.warn = function (...args) {
  warnings.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  originalWarn.apply(console, args);
};

console.error = function (...args) {
  warnings.push('[ERROR] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  originalError.apply(console, args);
};

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

// ── Core test ────────────────────────────────────────────────────────────────

async function testChunkPipeline(url, label) {
  console.log(`\n${'━'.repeat(76)}`);
  console.log(`  CHUNK PIPELINE TEST: ${label}`);
  console.log(`${'━'.repeat(76)}`);

  warnings.length = 0;

  // ─── Phase 1: Open file ────────────────────────────────────────────────────
  resetStats();
  const t0 = performance.now();

  const listResult = await listNISARDatasetsFromUrl(url);
  const datasets = listResult.datasets || listResult;
  const streamReader = listResult._streamReader || null;

  const openTime = performance.now() - t0;
  const openStats = getStats();

  if (!datasets || datasets.length === 0) {
    console.log('  ✗ No datasets found — skipping');
    return null;
  }

  const freq = datasets[0].frequency;
  const pol = datasets[0].polarization;
  console.log(`  File open: ${fmt(openTime)}  |  ${openStats.count} reqs  |  ${fmtSize(openStats.bytes)}`);
  console.log(`  Dataset: ${freq}/${pol}  |  ${datasets.length} available`);
  if (openStats.errors.length) console.log(`  ⚠ Open errors: ${openStats.errors.join('; ')}`);

  // ─── Phase 2: Load dataset ─────────────────────────────────────────────────
  resetStats();
  const t1 = performance.now();

  const data = await loadNISARGCOVFromUrl(url, {
    frequency: freq,
    polarization: pol,
    _streamReader: streamReader,
  });

  const loadTime = performance.now() - t1;
  const loadStats = getStats();
  const { width, height } = data;
  const chunkW = 512, chunkH = 512; // NISAR GCOV standard
  const totalCR = Math.ceil(height / chunkH);
  const totalCC = Math.ceil(width / chunkW);

  console.log(`\n  Image: ${width}×${height}  |  Chunks: ${totalCC}×${totalCR} (${totalCC * totalCR} total)`);
  console.log(`  Load: ${fmt(loadTime)}  |  ${loadStats.count} reqs  |  ${fmtSize(loadStats.bytes)}`);
  if (loadStats.errors.length) console.log(`  ⚠ Load errors: ${loadStats.errors.join('; ')}`);

  // ─── Phase 3: Prefetch overview ────────────────────────────────────────────
  resetStats();
  const t2 = performance.now();

  if (data.prefetchOverviewChunks) {
    await data.prefetchOverviewChunks();
  }

  const prefetchTime = performance.now() - t2;
  const prefetchStats = getStats();
  console.log(`  Prefetch: ${fmt(prefetchTime)}  |  ${prefetchStats.count} reqs  |  ${fmtSize(prefetchStats.bytes)}`);
  if (prefetchStats.errors.length) console.log(`  ⚠ Prefetch errors: ${prefetchStats.errors.join('; ')}`);

  // ─── Phase 4: Tile transect down the center ───────────────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  TILE TRANSECT — vertical strip through image center`);
  console.log(`  Phase 2 refinement defers until foreground tiles complete`);
  console.log(`  ${'─'.repeat(68)}`);
  console.log(`  ${'Zoom'.padEnd(6)} ${'Tile'.padEnd(16)} ${'Bbox (pixels)'.padEnd(36)} ${'Time'.padStart(8)} ${'Reqs'.padStart(6)} ${'Data'.padStart(10)} ${'Path'.padStart(10)} ${'Errors'.padStart(8)}`);

  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);

  const tileRequests = [];

  // z=0: Full overview (1 tile covers entire image)
  tileRequests.push({
    label: 'z0 overview',
    z: 0, x: 0, y: 0,
    bbox: { left: 0, bottom: height, right: width, top: 0 },
    expectPath: 'chunk-sample',
  });

  // z=1: 4 quadrants — request the two center tiles
  const halfW = Math.ceil(width / 2);
  const halfH = Math.ceil(height / 2);
  tileRequests.push({
    label: 'z1 center-TL',
    z: 1, x: 0, y: 0,
    bbox: { left: 0, bottom: height, right: halfW, top: halfH },
    expectPath: 'chunk-sample',
  });
  tileRequests.push({
    label: 'z1 center-BR',
    z: 1, x: 1, y: 1,
    bbox: { left: halfW, bottom: halfH, right: width, top: 0 },
    expectPath: 'chunk-sample',
  });

  // Mid zoom: ~8×8 tiles across image, pick center column
  const midTileW = Math.ceil(width / 8);
  const midTileH = Math.ceil(height / 8);
  const midCol = Math.floor(4); // center column
  for (let row = 3; row <= 4; row++) {
    const tLeft = midCol * midTileW;
    const tTop = row * midTileH;
    tileRequests.push({
      label: `z3 col${midCol}-row${row}`,
      z: 3, x: midCol, y: row,
      bbox: {
        left: tLeft,
        bottom: height - tTop,
        right: Math.min(tLeft + midTileW, width),
        top: height - Math.min(tTop + midTileH, height),
      },
      expectPath: 'chunk-sample',
    });
  }

  // High zoom: 1024×1024 region at center → readRegion path (1M pixels)
  const regionSize = 1024;
  const rLeft = centerX - regionSize / 2;
  const rTop = centerY - regionSize / 2;
  tileRequests.push({
    label: 'z-hi center',
    z: 5, x: 0, y: 0,
    bbox: {
      left: rLeft,
      bottom: height - rTop,
      right: rLeft + regionSize,
      top: height - (rTop + regionSize),
    },
    expectPath: 'readRegion',
  });

  // Max zoom: 512×512 region at center — single chunk
  const sLeft = centerX - 256;
  const sTop = centerY - 256;
  tileRequests.push({
    label: 'z-max center',
    z: 7, x: 0, y: 0,
    bbox: {
      left: sLeft,
      bottom: height - sTop,
      right: sLeft + 512,
      top: height - (sTop + 512),
    },
    expectPath: 'readRegion',
  });

  // Even smaller: 256×256 at center — sub-chunk read
  tileRequests.push({
    label: 'z-max2 center',
    z: 8, x: 0, y: 0,
    bbox: {
      left: centerX - 128,
      bottom: height - (centerY - 128),
      right: centerX + 128,
      top: height - (centerY + 128),
    },
    expectPath: 'readRegion',
  });

  let totalTileTime = 0;
  let totalTileReqs = 0;
  let totalTileBytes = 0;
  let tileErrors = 0;
  let firstPaintTileTime = 0; // z0 only

  for (let i = 0; i < tileRequests.length; i++) {
    const req = tileRequests[i];
    resetStats();
    warnings.length = 0;
    const tStart = performance.now();

    const tile = await data.getTile({
      x: req.x, y: req.y, z: req.z,
      bbox: req.bbox,
      multiLook: false,
    });

    const tileTime = performance.now() - tStart;
    const tileStats = getStats();
    totalTileTime += tileTime;
    totalTileReqs += tileStats.count;
    totalTileBytes += tileStats.bytes;
    if (i === 0) firstPaintTileTime = tileTime;

    const bboxStr = `[${req.bbox.left},${req.bbox.top}→${req.bbox.right},${req.bbox.bottom}]`;
    const pathUsed = tileStats.count === 0 ? 'cached' :
      ((req.bbox.right - req.bbox.left) * (req.bbox.bottom - req.bbox.top) <= 1024 * 1024 ? 'readRegion' : 'chunk-sample');

    // Validate tile data
    let errStr = '';
    if (!tile) {
      errStr = 'NULL';
      tileErrors++;
    } else {
      const arr = tile.data;
      let nonZero = 0, nanCount = 0;
      for (let i = 0; i < arr.length; i++) {
        if (isNaN(arr[i])) nanCount++;
        else if (arr[i] !== 0) nonZero++;
      }
      const pctNonZero = (100 * nonZero / arr.length).toFixed(0);
      const pctNaN = (100 * nanCount / arr.length).toFixed(0);
      if (nonZero === 0) {
        errStr = 'ALL-ZERO';
        tileErrors++;
      } else {
        errStr = `${pctNonZero}%ok`;
      }
      if (nanCount > 0) errStr += ` ${pctNaN}%NaN`;
    }

    const warnCount = warnings.length;
    if (warnCount > 0) errStr += ` ${warnCount}w`;

    console.log(
      `  ${(`z${req.z}`).padEnd(6)} ` +
      `${req.label.padEnd(16)} ` +
      `${bboxStr.padEnd(36)} ` +
      `${fmt(tileTime).padStart(8)} ` +
      `${String(tileStats.count).padStart(6)} ` +
      `${fmtSize(tileStats.bytes).padStart(10)} ` +
      `${pathUsed.padStart(10)} ` +
      `${errStr.padStart(8)}`
    );

    if (warnCount > 0) {
      const shown = warnings.slice(0, 3);
      for (const w of shown) {
        console.log(`    ⚠ ${w.length > 120 ? w.slice(0, 120) + '…' : w}`);
      }
      if (warnCount > 3) console.log(`    ⚠ ... and ${warnCount - 3} more warnings`);
    }

    if (tileStats.errors.length > 0) {
      for (const e of tileStats.errors.slice(0, 3)) {
        console.log(`    ✗ ${e}`);
      }
    }
  }

  // ─── Phase 5: Wait for refinement and measure ──────────────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  PHASE 2 REFINEMENT — waiting for background work to complete`);
  console.log(`  ${'─'.repeat(68)}`);

  resetStats();
  const refT0 = performance.now();
  if (data.drainRefinement) {
    await data.drainRefinement();
  }
  const refTime = performance.now() - refT0;
  const refStats = getStats();
  console.log(`  Refinement drain: ${fmt(refTime)}  |  ${refStats.count} reqs  |  ${fmtSize(refStats.bytes)}`);

  // ─── Phase 6: Re-request same tiles (should be cached) ────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  CACHE VALIDATION — re-request same tiles (expect 0 HTTP requests)`);
  console.log(`  ${'─'.repeat(68)}`);

  resetStats();
  const cacheT0 = performance.now();
  let cacheHits = 0;

  for (const req of tileRequests) {
    const tile = await data.getTile({
      x: req.x, y: req.y, z: req.z,
      bbox: req.bbox,
      multiLook: false,
    });
    if (tile) cacheHits++;
  }

  const cacheTime = performance.now() - cacheT0;
  const cacheStats = getStats();
  console.log(`  ${cacheHits}/${tileRequests.length} tiles returned  |  ${fmt(cacheTime)}  |  ${cacheStats.count} HTTP reqs  |  ${cacheStats.count === 0 ? '✓ all cached' : '✗ cache misses!'}`);

  // ─── Phase 7: Multilooked tile at center ───────────────────────────────────
  console.log(`\n  ${'─'.repeat(68)}`);
  console.log(`  MULTILOOK TILE — center region with multiLook=true`);
  console.log(`  ${'─'.repeat(68)}`);

  resetStats();
  warnings.length = 0;
  const mlT0 = performance.now();

  const mlTile = await data.getTile({
    x: 0, y: 0, z: 0,
    bbox: { left: 0, bottom: height, right: width, top: 0 },
    multiLook: true,
  });

  const mlTime = performance.now() - mlT0;
  const mlStats = getStats();

  if (mlTile) {
    let nonZero = 0;
    for (let i = 0; i < mlTile.data.length; i++) {
      if (mlTile.data[i] !== 0 && !isNaN(mlTile.data[i])) nonZero++;
    }
    console.log(`  ${mlTile.width}×${mlTile.height}  |  ${fmt(mlTime)}  |  ${mlStats.count} reqs  |  ${fmtSize(mlStats.bytes)}  |  ${(100 * nonZero / mlTile.data.length).toFixed(0)}% non-zero`);
  } else {
    console.log(`  ✗ NULL tile returned`);
  }
  if (warnings.length > 0) {
    console.log(`  ⚠ ${warnings.length} warnings during multilook`);
    for (const w of warnings.slice(0, 5)) {
      console.log(`    ⚠ ${w.length > 120 ? w.slice(0, 120) + '…' : w}`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const firstPaint = loadTime + prefetchTime + firstPaintTileTime;
  const foregroundTotal = loadTime + prefetchTime + totalTileTime;
  const withRefinement = foregroundTotal + refTime;

  console.log(`\n  ${'═'.repeat(68)}`);
  console.log(`  SUMMARY: ${label}`);
  console.log(`  ${'═'.repeat(68)}`);
  console.log(`  File open (metadata)           ${fmt(openTime).padStart(10)}`);
  console.log(`  Dataset load                   ${fmt(loadTime).padStart(10)}`);
  console.log(`  Prefetch overview              ${fmt(prefetchTime).padStart(10)}`);
  console.log(`  z0 overview tile               ${fmt(firstPaintTileTime).padStart(10)}  (first paint tile)`);
  console.log(`  ${tileRequests.length} tile requests               ${fmt(totalTileTime).padStart(10)}  (${totalTileReqs} reqs, ${fmtSize(totalTileBytes)})`);
  console.log(`  Phase 2 refinement             ${fmt(refTime).padStart(10)}  (${refStats.count} reqs, ${fmtSize(refStats.bytes)})`);
  console.log(`  Cache re-request               ${fmt(cacheTime).padStart(10)}  (${cacheStats.count} reqs)`);
  console.log(`  Multilook overview             ${fmt(mlTime).padStart(10)}`);

  console.log(`  ─────────────────────────────────────────`);
  console.log(`  ★ First paint (load+prefetch+z0) ${fmt(firstPaint).padStart(8)}`);
  console.log(`  ★ All foreground tiles         ${fmt(foregroundTotal).padStart(10)}`);
  console.log(`    + Phase 2 refinement         ${fmt(withRefinement).padStart(10)}`);
  console.log(`  Tile errors                    ${String(tileErrors).padStart(10)}`);

  // Targets:
  //   First paint < 10s — what the user sees first (load + prefetch + z0)
  //   All foreground tiles < 30s — all zoom levels painted without Phase 2 interference
  const FIRST_PAINT_TARGET = 10000;
  const FOREGROUND_TARGET = 30000;

  const fpPass = firstPaint < FIRST_PAINT_TARGET;
  const fgPass = foregroundTotal < FOREGROUND_TARGET;

  if (fpPass) {
    console.log(`  ✓ First paint: ${fmt(firstPaint)} < ${fmt(FIRST_PAINT_TARGET)}`);
  } else {
    console.log(`  ✗ First paint: ${fmt(firstPaint)} > ${fmt(FIRST_PAINT_TARGET)} target`);
  }
  if (fgPass) {
    console.log(`  ✓ Foreground tiles: ${fmt(foregroundTotal)} < ${fmt(FOREGROUND_TARGET)}`);
  } else {
    console.log(`  ✗ Foreground tiles: ${fmt(foregroundTotal)} > ${fmt(FOREGROUND_TARGET)} target`);
  }
  if (tileErrors > 0) {
    console.log(`  ✗ FAIL: ${tileErrors} tile errors`);
  }

  const pass = fpPass && fgPass && tileErrors === 0;

  return {
    label, width, height, totalCR, totalCC,
    openTime, loadTime, prefetchTime,
    firstPaintTileTime, firstPaint,
    totalTileTime, totalTileReqs, totalTileBytes,
    refTime, refReqs: refStats.count, refBytes: refStats.bytes,
    foregroundTotal, withRefinement,
    cacheTime, cacheReqs: cacheStats.count,
    mlTime,
    tileErrors,
    pass,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  SARdine Chunk Pipeline Test                                           ║');
  console.log('║  Tiles down the center of the image at multiple zoom levels            ║');
  console.log('║  Tests: chunk-sampling, readRegion, caching, multilook, error capture  ║');
  console.log('║  Phase 2 refinement deferred — foreground tiles get full bandwidth     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  let results = [];

  if (args[0] === '--all') {
    console.log(`\nListing files in s3://${BUCKET}/${PREFIX}...`);
    const files = await listTestFiles();
    console.log(`Found ${files.length} test files`);

    for (const file of files) {
      try {
        console.log(`\nGenerating pre-signed URL for ${file.key.split('/').pop()}...`);
        const url = await presignUrl(file.key);
        const result = await testChunkPipeline(url, `${file.key.split('/').pop()} (${fmtSize(file.size)})`);
        if (result) results.push(result);
      } catch (e) {
        console.log(`  ✗ FATAL: ${e.message}`);
      }
    }
  } else if (args[0]) {
    const url = args[0];
    const name = decodeURIComponent(url.split('?')[0].split('/').pop());
    const result = await testChunkPipeline(url, name);
    if (result) results.push(result);
  } else {
    console.log('\nUsage:');
    console.log('  node test/test-chunk-pipeline.mjs "<presigned-url>"');
    console.log('  node test/test-chunk-pipeline.mjs --all');
    console.log('\nGenerate a URL with:');
    console.log(`  aws s3 presign s3://${BUCKET}/${PREFIX}<FILE>.h5 --expires-in 3600 --region ${REGION}`);
    process.exit(1);
  }

  if (results.length > 1) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log('  FINAL REPORT');
    console.log(`${'═'.repeat(80)}`);
    console.log(`  ${'File'.padEnd(30)} ${'Size'.padStart(14)} ${'1st Paint'.padStart(10)} ${'FG Tiles'.padStart(10)} ${'+Refine'.padStart(10)} ${'Errs'.padStart(6)} ${'Result'.padStart(8)}`);
    console.log(`  ${'─'.repeat(30)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);
    for (const r of results) {
      const name = r.label.length > 28 ? r.label.slice(0, 28) + '…' : r.label;
      console.log(
        `  ${name.padEnd(30)} ` +
        `${`${r.width}×${r.height}`.padStart(14)} ` +
        `${fmt(r.firstPaint).padStart(10)} ` +
        `${fmt(r.foregroundTotal).padStart(10)} ` +
        `${fmt(r.withRefinement).padStart(10)} ` +
        `${String(r.tileErrors).padStart(6)} ` +
        `${(r.pass ? '✓ PASS' : '✗ FAIL').padStart(8)}`
      );
    }
    const allPass = results.every(r => r.pass);
    console.log(`\n  Overall: ${allPass ? '✓ ALL PASS' : '✗ SOME FAILED'}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
