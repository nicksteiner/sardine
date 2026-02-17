#!/usr/bin/env node
/**
 * End-to-end S3 streaming performance test.
 *
 * Exercises the exact same pipeline as the SARdine visualizer:
 *   1. listNISARDatasetsFromUrl()  — metadata discovery
 *   2. loadNISARGCOVFromUrl()      — open dataset + coordinate/projection reads
 *   3. prefetchOverviewChunks()    — warm chunk cache with coarse grid
 *   4. getTile()                   — render first tile (uses cached chunks)
 *
 * Usage:
 *   # Generate a 1-hour pre-signed URL (us-west-2):
 *   aws s3 presign s3://nisar-oasis/stream-test/<FILE>.h5 --expires-in 3600 --region us-west-2
 *
 *   # Run with the pre-signed URL:
 *   node test/test-s3-streaming.mjs "<presigned-url>"
 *
 *   # Or test all files in the stream-test prefix:
 *   node test/test-s3-streaming.mjs --all
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

async function timer(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const elapsed = performance.now() - t0;
  console.log(`  ${label.padEnd(40)} ${fmt(elapsed).padStart(10)}`);
  return { result, elapsed };
}

// ── Instrument global fetch to count HTTP requests ───────────────────────────

let fetchCount = 0;
let fetchBytes = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (...args) {
  fetchCount++;
  const response = await originalFetch.apply(this, args);
  const contentLength = response.headers.get('content-length');
  if (contentLength) fetchBytes += parseInt(contentLength, 10);
  return response;
};

function resetFetchStats() {
  fetchCount = 0;
  fetchBytes = 0;
}

function getFetchStats() {
  return { count: fetchCount, bytes: fetchBytes };
}

// ── S3 bucket listing (minimal, no SDK) ──────────────────────────────────────

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
  // Use AWS CLI to generate pre-signed URL
  const { execSync } = await import('child_process');
  const cmd = `aws s3 presign s3://${BUCKET}/${key} --expires-in 3600 --region ${REGION}`;
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

// ── Core test: exercises the full SARdine loading pipeline ───────────────────

async function testFile(url, label) {
  console.log(`\n${'━'.repeat(72)}`);
  console.log(`  ${label}`);
  console.log(`${'━'.repeat(72)}`);

  resetFetchStats();
  const totalT0 = performance.now();

  // Phase 1: Metadata discovery (same as handleRemoteFileSelect in main.jsx)
  let datasets, streamReader;
  const { result: listResult, elapsed: listTime } = await timer(
    'Phase 1: listNISARDatasetsFromUrl',
    () => listNISARDatasetsFromUrl(url)
  );
  datasets = listResult.datasets || listResult;
  streamReader = listResult._streamReader || null;

  if (!datasets || datasets.length === 0) {
    console.log('  ✗ No datasets found — skipping');
    return null;
  }

  console.log(`  Found ${datasets.length} datasets: ${datasets.map(d => `${d.frequency}/${d.polarization}`).join(', ')}`);
  const phase1Stats = getFetchStats();
  console.log(`  HTTP requests: ${phase1Stats.count}  |  Data: ${fmtSize(phase1Stats.bytes)}`);

  // Phase 2: Load dataset (same as handleLoadRemoteNISAR in main.jsx)
  const freq = datasets[0].frequency;
  const pol = datasets[0].polarization;
  resetFetchStats();

  let data;
  const { result: loadResult, elapsed: loadTime } = await timer(
    `Phase 2: loadNISARGCOVFromUrl (${freq}/${pol})`,
    () => loadNISARGCOVFromUrl(url, {
      frequency: freq,
      polarization: pol,
      _streamReader: streamReader,
    })
  );
  data = loadResult;

  const phase2Stats = getFetchStats();
  console.log(`  Image: ${data.width}×${data.height}  |  Bounds: [${data.bounds.map(b => b.toFixed(1)).join(', ')}]  |  CRS: ${data.crs}`);
  console.log(`  HTTP requests: ${phase2Stats.count}  |  Data: ${fmtSize(phase2Stats.bytes)}`);

  // Phase 3: Prefetch overview chunks (same as main.jsx after loadNISARGCOVFromUrl)
  resetFetchStats();
  let prefetchTime = 0;
  if (data.prefetchOverviewChunks) {
    const { elapsed } = await timer(
      'Phase 3: prefetchOverviewChunks',
      () => data.prefetchOverviewChunks()
    );
    prefetchTime = elapsed;
  }
  const phase3Stats = getFetchStats();
  console.log(`  HTTP requests: ${phase3Stats.count}  |  Data: ${fmtSize(phase3Stats.bytes)}`);

  // Phase 4: Render first tile (same as SARTileLayer.getTileData at overview zoom)
  // Use pixel coordinates (matching how deck.gl's TileLayer with orthographic view works)
  resetFetchStats();
  const { elapsed: tileTime, result: tile } = await timer(
    'Phase 4: getTile (first overview tile)',
    () => data.getTile({
      x: 0, y: 0, z: 0,
      bbox: {
        left: 0,
        bottom: data.height,
        right: data.width,
        top: 0,
      },
    })
  );
  const phase4Stats = getFetchStats();
  console.log(`  Tile: ${tile ? `${tile.width}×${tile.height}` : 'null'}  |  HTTP requests: ${phase4Stats.count}  |  Data: ${fmtSize(phase4Stats.bytes)}`);

  // Phase 5: Wait for identification metadata (background)
  resetFetchStats();
  if (data.identificationReady) {
    const { elapsed: idTime } = await timer(
      'Phase 5: identification metadata (async)',
      () => data.identificationReady
    );
  }
  const phase5Stats = getFetchStats();
  const idKeys = Object.keys(data.identification || {});
  console.log(`  Identification fields: ${idKeys.length}  |  HTTP requests: ${phase5Stats.count}`);

  const totalTime = performance.now() - totalT0;

  // ── Summary ──
  console.log(`\n  ${'─'.repeat(52)}`);
  const fileOpenTime = listTime;
  const loadToPaint = loadTime + prefetchTime + tileTime;
  const fullPipeline = listTime + loadTime + prefetchTime + tileTime;

  console.log(`  File open (Phase 1)                 ${fmt(fileOpenTime).padStart(10)}`);
  console.log(`  Load → first paint (Phases 2-4)     ${fmt(loadToPaint).padStart(10)}`);
  console.log(`  Full pipeline (Phases 1-4)          ${fmt(fullPipeline).padStart(10)}`);

  const target = 10000;
  if (loadToPaint < target) {
    console.log(`  ✓ PASS: Load→paint ${fmt(loadToPaint)} < ${fmt(target)} target`);
  } else {
    console.log(`  ✗ FAIL: Load→paint ${fmt(loadToPaint)} > ${fmt(target)} target`);
  }

  return {
    label,
    datasets: datasets.length,
    width: data.width,
    height: data.height,
    crs: data.crs,
    bounds: data.bounds,
    listTime,
    loadTime,
    prefetchTime,
    tileTime,
    fileOpenTime,
    loadToPaint,
    fullPipeline,
    totalTime,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SARdine S3 Streaming Performance Test                             ║');
  console.log('║  Tests the exact visualization pipeline: list → load → prefetch →  ║');
  console.log('║  getTile                                                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  let results = [];

  if (args[0] === '--all') {
    // Test all files in the stream-test prefix
    console.log(`\nListing files in s3://${BUCKET}/${PREFIX}...`);
    const files = await listTestFiles();
    console.log(`Found ${files.length} test files:`);
    for (const f of files) {
      console.log(`  ${f.key.split('/').pop()}  (${fmtSize(f.size)})`);
    }

    for (const file of files) {
      try {
        console.log(`\nGenerating pre-signed URL for ${file.key.split('/').pop()}...`);
        const url = await presignUrl(file.key);
        const result = await testFile(url, `${file.key.split('/').pop()} (${fmtSize(file.size)})`);
        if (result) results.push(result);
      } catch (e) {
        console.log(`  ✗ ERROR: ${e.message}`);
      }
    }
  } else if (args[0]) {
    // Single URL provided
    const url = args[0];
    const name = decodeURIComponent(url.split('?')[0].split('/').pop());
    const result = await testFile(url, name);
    if (result) results.push(result);
  } else {
    console.log('\nUsage:');
    console.log('  node test/test-s3-streaming.mjs "<presigned-url>"');
    console.log('  node test/test-s3-streaming.mjs --all');
    console.log('\nGenerate a URL with:');
    console.log(`  aws s3 presign s3://${BUCKET}/${PREFIX}<FILE>.h5 --expires-in 3600 --region ${REGION}`);
    process.exit(1);
  }

  // ── Final report ──
  if (results.length > 1) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(72)}`);
    console.log(`  ${'File'.padEnd(30)} ${'Size'.padStart(12)} ${'File Open'.padStart(12)} ${'Load→Paint'.padStart(12)} ${'Result'.padStart(8)}`);
    console.log(`  ${'─'.repeat(30)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(8)}`);
    for (const r of results) {
      const name = r.label.length > 28 ? r.label.slice(0, 28) + '…' : r.label;
      const pass = r.loadToPaint < 10000 ? '✓ PASS' : '✗ FAIL';
      console.log(`  ${name.padEnd(30)} ${`${r.width}×${r.height}`.padStart(12)} ${fmt(r.fileOpenTime).padStart(12)} ${fmt(r.loadToPaint).padStart(12)} ${pass.padStart(8)}`);
    }

    const allPass = results.every(r => r.loadToPaint < 10000);
    console.log(`\n  Overall: ${allPass ? '✓ ALL PASS' : '✗ SOME FAILED'} (target: <10s load→paint)`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
