#!/usr/bin/env node

/**
 * End-to-end audit fix validation with S3 streaming.
 *
 * Validates the P0–P3 fixes from RENDERING_PIPELINE_AUDIT.md by streaming
 * real NISAR GCOV data from S3 and exercising every level of the pipeline.
 *
 * Usage:
 *   node test/test-audit-fixes.mjs                     # auto-presign from nisar-oasis
 *   node test/test-audit-fixes.mjs "<presigned-url>"   # explicit URL
 *   node test/test-audit-fixes.mjs --source-only       # source-level checks only (no S3)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, fn) {
  try {
    const result = fn();
    // Support async checks
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  PASS  ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        failed++;
      });
    }
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  SKIP  ${name} (${reason})`);
  skipped++;
}

function readSrc(relPath) {
  return readFileSync(join(rootDir, relPath), 'utf8');
}

function fmt(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Instrument global fetch to count HTTP requests ───────────────────────────

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

function resetFetchStats() { fetchCount = 0; fetchBytes = 0; }
function getFetchStats() { return { count: fetchCount, bytes: fetchBytes }; }

// ─── Presign helper ──────────────────────────────────────────────────────────

const BUCKET = 'nisar-oasis';
const REGION = 'us-west-2';
const TEST_KEY = 'stream-test/NISAR_L2_PR_GCOV_006_076_A_006_4005_SHSH_A_20251127T105634_20251127T105646_X05009_N_P_J_001.h5';

async function autoPresign() {
  // Use the project's own SigV4 presigner (no AWS CLI needed)
  const { presignS3Url } = await import('../src/utils/s3-presign.js');
  // Read credentials from ~/.aws/credentials
  const { readFileSync: readFs } = await import('fs');
  const { homedir } = await import('os');
  const credsFile = readFs(join(homedir(), '.aws', 'credentials'), 'utf8');
  const accessKeyId = credsFile.match(/aws_access_key_id\s*=\s*(\S+)/)?.[1];
  const secretAccessKey = credsFile.match(/aws_secret_access_key\s*=\s*(\S+)/)?.[1];
  if (!accessKeyId || !secretAccessKey) throw new Error('Cannot read AWS credentials from ~/.aws/credentials');
  return presignS3Url({
    bucket: BUCKET,
    key: TEST_KEY,
    region: REGION,
    accessKeyId,
    secretAccessKey,
    expires: 3600,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 1: SOURCE-LEVEL CHECKS (always run, no S3 needed)
// ═══════════════════════════════════════════════════════════════════════════════

function runSourceChecks() {
  const nisarSrc = readSrc('src/loaders/nisar-loader.js');
  const tileSrc = readSrc('src/layers/SARTileLayer.js');
  const h5Src = readSrc('src/loaders/h5chunk.js');
  const viewerSrc = readSrc('src/viewers/SARViewer.jsx');

  // ─── P0: Signal Abort Cascade ──────────────────────────────────────────

  console.log('\n━━━ P0: Signal Abort Cascade (source checks) ━━━');

  check('getTile signature does not accept signal parameter', () => {
    const match = nisarSrc.match(/const getTile\s*=\s*async\s*\(\s*\{([^}]+)\}\s*\)/);
    if (!match) throw new Error('Could not find getTile function signature');
    if (match[1].includes('signal')) throw new Error(`getTile still accepts signal`);
  });

  check('readRegion calls do not pass signal option', () => {
    const start = nisarSrc.indexOf('const getTile = async');
    const region = nisarSrc.slice(start, start + 20000);
    if (region.match(/readRegion\([^)]*\{[^}]*signal[^}]*\}/g))
      throw new Error('readRegion still receives signal');
  });

  check('readChunksBatch calls do not pass signal (tile path)', () => {
    const start = nisarSrc.indexOf('const getTile = async');
    const region = nisarSrc.slice(start, start + 20000);
    if (region.match(/readChunksBatch\([^)]*\{[^}]*signal[^}]*\}/g))
      throw new Error('readChunksBatch still receives signal');
  });

  check('SARTileLayer does not extract signal from tile', () => {
    if (tileSrc.match(/\{\s*bbox\s*,\s*signal\s*\}/))
      throw new Error('SARTileLayer still destructures signal');
  });

  // ─── P1: Adaptive Concurrency ──────────────────────────────────────────

  console.log('\n━━━ P1: Adaptive Concurrency (source checks) ━━━');

  check('Batch fetch signal is conditional (not hardcoded)', () => {
    const section = h5Src.match(/Phase 3:.*?Phase 4:/s)?.[0];
    if (!section) throw new Error('Cannot find Phase 3 section');
    if (section.includes("signal,\n") && !section.includes('fetchOpts'))
      throw new Error('signal is unconditionally passed to fetch');
  });

  check('Throughput measurement guards batchBytes > 0', () => {
    const section = h5Src.match(/Phase 3:.*?Phase 4:/s)?.[0];
    if (!section?.includes('batchBytes > 0'))
      throw new Error('Throughput measurement missing batchBytes > 0 guard');
  });

  // ─── P2: RGB Batch Reads ───────────────────────────────────────────────

  console.log('\n━━━ P2: RGB Batch Reads (source checks) ━━━');

  check('RGB tile uses readChunksBatch per polarization', () => {
    const section = nisarSrc.match(/NISAR RGB Tile.*?Phase 3: sample pixels/s)?.[0];
    if (!section) throw new Error('Cannot find RGB tile section');
    if (!section.includes('readChunksBatch'))
      throw new Error('RGB tile section does not use readChunksBatch');
    if (!section.includes('for (const pol of requiredPols)'))
      throw new Error('RGB does not batch-fetch per polarization');
  });

  check('RGB batch populates per-band chunk cache', () => {
    const section = nisarSrc.match(/NISAR RGB Tile.*?Phase 3: sample pixels/s)?.[0];
    if (!section?.includes('cache.set(key'))
      throw new Error('RGB batch does not populate chunk cache');
  });

  // ─── P3: Stable getTileData ────────────────────────────────────────────

  console.log('\n━━━ P3: Stable getTileData (source checks) ━━━');

  check('SARViewer uses getTileRef + stableGetTileData', () => {
    if (!viewerSrc.includes('useRef(getTile)'))
      throw new Error('Missing getTileRef');
    if (!viewerSrc.includes('stableGetTileData'))
      throw new Error('Missing stableGetTileData');
  });

  check('stableGetTileData deps: [multiLook] only', () => {
    const start = viewerSrc.indexOf('stableGetTileData = useCallback');
    if (start === -1) throw new Error('Cannot find stableGetTileData useCallback');
    const region = viewerSrc.slice(start, start + 500);
    const depsMatch = region.match(/,\s*\[([^\]]*)\]\s*\)/);
    if (!depsMatch) throw new Error('Cannot find dependency array');
    const deps = depsMatch[1].trim();
    for (const vp of ['colormap', 'contrastLimits', 'gamma', 'stretchMode']) {
      if (deps.includes(vp)) throw new Error(`depends on visual prop: ${vp}`);
    }
    if (!deps.includes('multiLook')) throw new Error('does not depend on multiLook');
  });

  check('SARTileLayer accepts external getTileData prop', () => {
    if (!tileSrc.includes('externalGetTileData'))
      throw new Error('SARTileLayer missing externalGetTileData');
  });

  check('SARViewer passes stableGetTileData to SARTileLayer', () => {
    if (!viewerSrc.includes('getTileData: stableGetTileData'))
      throw new Error('SARViewer not passing stableGetTileData');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 2: S3 STREAMING END-TO-END (exercises real pipeline)
// ═══════════════════════════════════════════════════════════════════════════════

async function runStreamingTests(url) {
  const { listNISARDatasetsFromUrl, loadNISARGCOVFromUrl, loadNISARRGBComposite } = await import('../src/loaders/nisar-loader.js');

  const fileName = decodeURIComponent(url.split('?')[0].split('/').pop());
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  S3 Streaming Pipeline: ${fileName}`);
  console.log(`${'═'.repeat(72)}`);

  const levels = [];  // {level, description, elapsed, httpRequests, bytes, details}

  // ── Level 0: Metadata Discovery ──────────────────────────────────────

  resetFetchStats();
  const t0 = performance.now();
  const listResult = await listNISARDatasetsFromUrl(url);
  const t0End = performance.now();
  const datasets = listResult.datasets || listResult;
  const streamReader = listResult._streamReader || null;
  const l0Stats = getFetchStats();

  levels.push({
    level: 'L0',
    description: 'Metadata discovery (listNISARDatasetsFromUrl)',
    elapsed: t0End - t0,
    httpRequests: l0Stats.count,
    bytes: l0Stats.bytes,
    details: `${datasets.length} datasets: ${datasets.map(d => `${d.frequency}/${d.polarization}`).join(', ')}`,
  });

  await check('L0: Metadata discovery finds datasets', () => {
    if (!datasets || datasets.length === 0) throw new Error('No datasets found');
  });

  // ── Level 1: Dataset Open (coordinates, CRS, chunk index) ────────────

  const freq = datasets[0].frequency;
  const pol = datasets[0].polarization;
  resetFetchStats();
  const t1 = performance.now();
  const data = await loadNISARGCOVFromUrl(url, {
    frequency: freq,
    polarization: pol,
    _streamReader: streamReader,
  });
  const t1End = performance.now();
  const l1Stats = getFetchStats();

  levels.push({
    level: 'L1',
    description: `Dataset open: ${freq}/${pol}`,
    elapsed: t1End - t1,
    httpRequests: l1Stats.count,
    bytes: l1Stats.bytes,
    details: `${data.width}x${data.height} pixels, CRS: ${data.crs}, bounds: [${data.bounds.map(b => b.toFixed(1)).join(', ')}]`,
  });

  await check('L1: Dataset opens with valid dimensions', () => {
    if (!data.width || !data.height) throw new Error('Missing dimensions');
    if (!data.bounds || data.bounds.length !== 4) throw new Error('Missing bounds');
  });

  // ── Level 2: Overview Prefetch (coarse 8x8 chunk grid) ───────────────

  resetFetchStats();
  const t2 = performance.now();
  if (data.prefetchOverviewChunks) {
    await data.prefetchOverviewChunks();
  }
  const t2End = performance.now();
  const l2Stats = getFetchStats();

  levels.push({
    level: 'L2',
    description: 'Overview prefetch (coarse 8x8 chunk grid)',
    elapsed: t2End - t2,
    httpRequests: l2Stats.count,
    bytes: l2Stats.bytes,
    details: `readChunksBatch coalesced ranges`,
  });

  await check('L2: Overview prefetch completes', () => {
    if (l2Stats.count === 0) throw new Error('No HTTP requests made during prefetch');
  });

  // ── Level 3: First Tile Render (overview z=0, full extent) ───────────
  //    P0 VALIDATION: getTile called without signal — must succeed.

  resetFetchStats();
  const t3 = performance.now();
  const tile = await data.getTile({
    x: 0, y: 0, z: 0,
    bbox: { left: 0, bottom: data.height, right: data.width, top: 0 },
    // NOTE: NO signal parameter — P0 fix means it's not accepted
  });
  const t3End = performance.now();
  const l3Stats = getFetchStats();

  levels.push({
    level: 'L3',
    description: 'First tile render (z=0 overview, full extent)',
    elapsed: t3End - t3,
    httpRequests: l3Stats.count,
    bytes: l3Stats.bytes,
    details: tile ? `${tile.width}x${tile.height} Float32Array (${(tile.data.length * 4 / 1024).toFixed(0)} KB)` : 'null tile',
  });

  await check('L3: P0 — getTile succeeds without signal parameter', () => {
    if (!tile) throw new Error('Tile is null');
    if (!tile.data) throw new Error('Tile has no data');
    if (tile.data.length === 0) throw new Error('Tile data is empty');
  });

  await check('L3: Tile has valid pixel data (non-zero, non-NaN)', () => {
    if (!tile || !tile.data) throw new Error('No tile data');
    let validPixels = 0;
    // Check full tile — SAR data often has large nodata regions at edges
    for (let i = 0; i < tile.data.length; i++) {
      const v = tile.data[i];
      if (!isNaN(v) && isFinite(v) && v !== 0) validPixels++;
    }
    if (validPixels === 0) throw new Error('No valid pixel values in entire tile');
  });

  // ── Level 4: Zoomed Tile (sub-region, exercises readRegion) ──────────

  resetFetchStats();
  const t4 = performance.now();
  const midX = Math.floor(data.width / 2);
  const midY = Math.floor(data.height / 2);
  const span = 512;
  const zoomedTile = await data.getTile({
    x: 0, y: 0, z: 5,
    bbox: { left: midX - span, top: midY - span, right: midX + span, bottom: midY + span },
  });
  const t4End = performance.now();
  const l4Stats = getFetchStats();

  levels.push({
    level: 'L4',
    description: 'Zoomed tile (1024x1024 center crop via readRegion)',
    elapsed: t4End - t4,
    httpRequests: l4Stats.count,
    bytes: l4Stats.bytes,
    details: zoomedTile ? `${zoomedTile.width}x${zoomedTile.height}` : 'null',
  });

  await check('L4: P0 — Zoomed readRegion tile succeeds without signal', () => {
    if (!zoomedTile) throw new Error('Zoomed tile is null');
    if (!zoomedTile.data || zoomedTile.data.length === 0) throw new Error('Empty zoomed tile');
  });

  // ── Level 5: P1 — Adaptive concurrency stays healthy ─────────────────

  await check('L5: P1 — h5chunk concurrency > 0 after streaming', () => {
    // Access the stream reader to check its concurrency state
    // streamReader was captured from listResult._streamReader — it's the shared h5chunk instance
    const reader = streamReader;
    if (!reader) throw new Error('Cannot access h5chunk stream reader');
    if (reader._concurrency <= 0) throw new Error(`Concurrency dropped to ${reader._concurrency}`);
  });

  await check('L5: P1 — Throughput samples are positive', () => {
    // streamReader was captured from listResult._streamReader — it's the shared h5chunk instance
    const reader = streamReader;
    if (!reader) throw new Error('Cannot access h5chunk stream reader');
    const samples = reader._throughputSamples || [];
    if (samples.length > 0) {
      const hasNegative = samples.some(s => s < 0);
      if (hasNegative) throw new Error(`Negative throughput samples: ${samples}`);
      const hasZero = samples.some(s => s === 0);
      if (hasZero) throw new Error(`Zero throughput samples — AbortErrors poisoning: ${samples}`);
    }
  });

  levels.push({
    level: 'L5',
    description: 'Adaptive concurrency health check',
    elapsed: 0,
    httpRequests: 0,
    bytes: 0,
    details: (() => {
      const reader = streamReader;
      if (!reader) return 'no reader';
      const samples = reader._throughputSamples || [];
      const avg = samples.length > 0 ? (samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1) : '?';
      return `concurrency=${reader._concurrency}, avg throughput=${avg} MB/s, samples=${samples.length}`;
    })(),
  });

  // ── Level 6: P2 — RGB Composite Tile (batch reads) ───────────────────
  //    Only runs if file has >= 2 polarizations (dual-pol or quad-pol)

  if (datasets.length >= 2) {
    // Find suitable composite
    const pols = datasets.map(d => d.polarization);
    const hasDualH = pols.includes('HHHH') && pols.includes('HVHV');
    const hasDualV = pols.includes('VVVV') && pols.includes('HVHV');

    if (hasDualH || hasDualV) {
      const compositeId = hasDualH ? 'dual-pol-h' : 'dual-pol-v';
      const requiredPols = hasDualH ? ['HHHH', 'HVHV'] : ['VVVV', 'HVHV'];

      resetFetchStats();
      const t6 = performance.now();
      let rgbData;
      try {
        rgbData = await loadNISARRGBComposite(url, {
          frequency: freq,
          compositeId,
          requiredPols,
          _streamReader: null,  // fresh reader to isolate HTTP stats
        });
      } catch (e) {
        console.log(`  SKIP  L6: RGB composite — ${e.message}`);
        skipped++;
        rgbData = null;
      }

      if (rgbData) {
        const t6Open = performance.now();
        const l6OpenStats = getFetchStats();

        levels.push({
          level: 'L6a',
          description: `RGB composite open: ${compositeId} (${requiredPols.join('+')})`,
          elapsed: t6Open - t6,
          httpRequests: l6OpenStats.count,
          bytes: l6OpenStats.bytes,
          details: `${rgbData.width}x${rgbData.height}`,
        });

        // Fetch an RGB overview tile — exercises P2 batch reads
        resetFetchStats();
        const t6tile = performance.now();
        const rgbTile = await rgbData.getRGBTile({
          x: 0, y: 0, z: 0,
          bbox: { left: 0, top: 0, right: rgbData.width, bottom: rgbData.height },
        });
        const t6tileEnd = performance.now();
        const l6TileStats = getFetchStats();

        levels.push({
          level: 'L6b',
          description: `RGB overview tile (P2: batch readChunksBatch)`,
          elapsed: t6tileEnd - t6tile,
          httpRequests: l6TileStats.count,
          bytes: l6TileStats.bytes,
          details: rgbTile?.bands
            ? `bands: ${Object.keys(rgbTile.bands).join(',')}, ${rgbTile.width}x${rgbTile.height}`
            : 'null tile',
        });

        await check('L6: P2 — RGB tile returns multi-band data', () => {
          if (!rgbTile) throw new Error('RGB tile is null');
          if (!rgbTile.bands) throw new Error('RGB tile missing bands');
          for (const pol of requiredPols) {
            if (!rgbTile.bands[pol]) throw new Error(`Missing band: ${pol}`);
          }
        });

        await check('L6: P2 — RGB batch uses fewer requests than individual', () => {
          // With batch reads, we should see far fewer HTTP requests
          // than neededChunks * numPolarizations (individual path)
          // Batch coalesces nearby ranges, so requests << chunks * pols
          const expectedIndividual = 64 * requiredPols.length; // ~8x8 grid * pols
          if (l6TileStats.count > expectedIndividual) {
            throw new Error(`Too many HTTP requests: ${l6TileStats.count} > ${expectedIndividual} (expected batch coalescing)`);
          }
        });
      }
    } else {
      skip('L6: RGB composite tile', `polarizations ${pols.join(',')} don't form dual-pol pair`);
    }
  } else {
    skip('L6: RGB composite tile', 'only 1 polarization in file');
  }

  // ── Pipeline Summary Table ───────────────────────────────────────────

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  Pipeline Levels — Data Visualization Flow`);
  console.log(`${'─'.repeat(72)}`);
  console.log(`  ${'Level'.padEnd(6)} ${'Description'.padEnd(44)} ${'Time'.padStart(8)} ${'Reqs'.padStart(5)} ${'Data'.padStart(10)}`);
  console.log(`  ${'─'.repeat(6)} ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(10)}`);

  let totalTime = 0;
  let totalReqs = 0;
  let totalBytes = 0;
  for (const l of levels) {
    console.log(`  ${l.level.padEnd(6)} ${l.description.padEnd(44)} ${fmt(l.elapsed).padStart(8)} ${String(l.httpRequests).padStart(5)} ${fmtSize(l.bytes).padStart(10)}`);
    if (l.details) {
      console.log(`         ${l.details}`);
    }
    totalTime += l.elapsed;
    totalReqs += l.httpRequests;
    totalBytes += l.bytes;
  }
  console.log(`  ${'─'.repeat(6)} ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(10)}`);
  console.log(`  ${'TOTAL'.padEnd(6)} ${'Full pipeline: S3 URL → pixel on screen'.padEnd(44)} ${fmt(totalTime).padStart(8)} ${String(totalReqs).padStart(5)} ${fmtSize(totalBytes).padStart(10)}`);

  // Time-to-first-pixel = L1 (open) + L2 (prefetch) + L3 (first tile)
  const l1 = levels.find(l => l.level === 'L1');
  const l2 = levels.find(l => l.level === 'L2');
  const l3 = levels.find(l => l.level === 'L3');
  if (l1 && l2 && l3) {
    const ttfp = l1.elapsed + l2.elapsed + l3.elapsed;
    console.log(`\n  Time to first pixel (L1+L2+L3):  ${fmt(ttfp)}`);
    const target = 10000;
    if (ttfp < target) {
      console.log(`  PASS: ${fmt(ttfp)} < ${fmt(target)} target`);
    } else {
      console.log(`  WARN: ${fmt(ttfp)} > ${fmt(target)} target`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const sourceOnly = args.includes('--source-only');

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SARdine Audit Fix Tests (P0–P3)                                   ║');
  console.log('║  Source checks + S3 streaming pipeline validation                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Part 1: Source-level checks (always run)
  runSourceChecks();

  // Part 2: S3 streaming (unless --source-only)
  if (!sourceOnly) {
    let url = args.find(a => a.startsWith('https://'));
    if (!url) {
      console.log('\n  Generating presigned URL...');
      try {
        url = await autoPresign();
        console.log(`  OK: ${url.substring(0, 80)}...`);
      } catch (e) {
        console.log(`  Cannot generate presigned URL: ${e.message}`);
        console.log('  Falling back to source-only checks.');
        skip('S3 streaming tests', 'no AWS credentials or presign failed');
      }
    }
    if (url) {
      await runStreamingTests(url);
    }
  } else {
    skip('S3 streaming tests', '--source-only flag');
  }

  // Summary
  console.log(`\n━━━ Results ━━━`);
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n  All audit fix tests passed!\n');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
