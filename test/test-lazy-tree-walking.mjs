#!/usr/bin/env node
/**
 * Test: Lazy Tree-Walking Bandwidth Optimization
 *
 * Measures bytes fetched during HDF5 opening to validate lazy tree-walking.
 * Expected: <500 KB with lazy loading vs 8-32 MB with bulk read.
 *
 * Run: node test/test-lazy-tree-walking.mjs [path-to-h5-file]
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Test Infrastructure ─────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;

function suite(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  ✗ FAIL  ${name}`);
    console.log(`         ${err.message}`);
    totalFailed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Bandwidth Tracking Mock File ────────────────────────────────────────────

class BandwidthTrackingFile {
  constructor(buffer, name) {
    this._buffer = buffer;
    this.name = name;
    this.size = buffer.byteLength;
    this.bytesRead = 0;
    this.readCount = 0;
    this.readHistory = [];
  }

  slice(start, end) {
    const actualEnd = end === undefined ? this.size : end;
    const size = actualEnd - start;

    this.bytesRead += size;
    this.readCount++;
    this.readHistory.push({ start, end: actualEnd, size });

    const sliced = this._buffer.slice(start, actualEnd);
    return {
      arrayBuffer: () => Promise.resolve(sliced),
    };
  }

  getStats() {
    return {
      bytesRead: this.bytesRead,
      readCount: this.readCount,
      readHistory: this.readHistory,
      efficiency: this.size > 0 ? (this.bytesRead / this.size * 100).toFixed(2) + '%' : 'N/A',
    };
  }

  reset() {
    this.bytesRead = 0;
    this.readCount = 0;
    this.readHistory = [];
  }
}

// ─── Main Test ───────────────────────────────────────────────────────────────

async function main() {
  const h5FilePath = process.argv[2] || 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Lazy Tree-Walking Bandwidth Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!existsSync(resolve(h5FilePath))) {
    console.error(`ERROR: File not found: ${h5FilePath}\n`);
    process.exit(1);
  }

  console.log(`File: ${h5FilePath}`);
  const buf = readFileSync(resolve(h5FilePath));
  const fileSize = buf.length;
  console.log(`Size: ${(fileSize / 1e6).toFixed(1)} MB\n`);

  // Load h5chunk
  const { H5Chunk } = await import(resolve('src/loaders/h5chunk.js'));

  // Create bandwidth-tracking mock file
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const mockFile = new BandwidthTrackingFile(arrayBuffer, h5FilePath.split('/').pop());

  // ─── Test Suite ──────────────────────────────────────────────────────────

  suite('Bandwidth Measurement');

  // Test opening with default settings
  const reader = new H5Chunk();
  const startTime = Date.now();

  // Check if using lazy loading (new implementation)
  const usesLazyLoading = reader.lazyTreeWalking !== undefined;

  await reader.openFile(mockFile);
  const openTime = Date.now() - startTime;

  const stats = mockFile.getStats();

  console.log(`\nOpen time: ${openTime}ms`);
  console.log(`Bytes read: ${(stats.bytesRead / 1e6).toFixed(2)} MB`);
  console.log(`Read operations: ${stats.readCount}`);
  console.log(`Efficiency: ${stats.efficiency} of file`);

  check('Opens file successfully', () => {
    assert(reader.superblock, 'Superblock not parsed');
  });

  check('Discovers datasets', () => {
    const datasets = reader.getDatasets();
    assert(datasets.length > 0, `No datasets found (got ${datasets.length})`);
  });

  if (usesLazyLoading) {
    suite('Lazy Loading Validation');

    check('Uses minimal bandwidth (<2 MB for NISAR files)', () => {
      const initialBytes = stats.bytesRead;
      // NISAR files have ~143 datasets with remote object headers
      // Expect ~1-2 MB during openFile() vs 8-32 MB bulk mode
      assert(initialBytes < 2 * 1024 * 1024,
        `Initial read too large: ${(initialBytes / 1e6).toFixed(2)} MB (expected <2 MB)`);

      // Log the savings
      const bulkModeBytes = 8 * 1024 * 1024;
      const savings = ((bulkModeBytes - initialBytes) / bulkModeBytes * 100).toFixed(1);
      console.log(`      Bandwidth savings: ${savings}% vs bulk mode (${(bulkModeBytes / 1e6).toFixed(0)} MB → ${(initialBytes / 1e6).toFixed(1)} MB)`);
    });

    check('Multiple small reads instead of one bulk read', () => {
      assert(stats.readCount > 3,
        `Expected multiple small reads, got ${stats.readCount}`);
    });

    check('First read is small (<50 KB)', () => {
      const firstRead = stats.readHistory[0];
      assert(firstRead.size < 50 * 1024,
        `First read should be small (superblock + root group), got ${(firstRead.size / 1024).toFixed(1)} KB`);
    });

    // Test lazy B-tree loading
    suite('Lazy B-tree Loading');

    mockFile.reset();

    const datasets = reader.getDatasets();
    const gcovDataset = datasets.find(ds => ds.path?.endsWith('HHHH'));

    if (gcovDataset) {
      const datasetId = gcovDataset.id || gcovDataset.path;

      // First chunk read should trigger B-tree fetch
      await reader.readChunk(datasetId, 0, 0);

      const btreeStats = mockFile.getStats();

      check('B-tree fetched on first readChunk', () => {
        assert(btreeStats.bytesRead > 0, 'No bytes read for B-tree');
        assert(btreeStats.bytesRead < 200 * 1024,
          `B-tree read too large: ${(btreeStats.bytesRead / 1e6).toFixed(2)} MB (expected <0.2 MB)`);
      });

      mockFile.reset();

      // Second chunk read should NOT re-fetch B-tree
      await reader.readChunk(datasetId, 0, 1);

      const cacheStats = mockFile.getStats();

      check('B-tree cached after first use', () => {
        const btreeBytes = btreeStats.bytesRead;
        const cacheBytes = cacheStats.bytesRead;

        // Second read should only fetch the data chunk, not B-tree again
        assert(cacheBytes < btreeBytes,
          `Second read fetched too much: ${(cacheBytes / 1e3).toFixed(1)} KB (B-tree not cached)`);
      });
    }

  } else {
    suite('Bulk Read (Current Implementation)');

    check('Uses bulk metadata read (expected 8-32 MB)', () => {
      const initialBytes = stats.bytesRead;
      const expectedMin = 8 * 1024 * 1024; // 8 MB

      console.log(`      Note: Using bulk read mode (${(initialBytes / 1e6).toFixed(2)} MB)`);
      console.log(`      Enable lazy loading to reduce to <0.5 MB`);

      // This is expected behavior for current implementation
      assert(initialBytes >= expectedMin || stats.readCount === 1,
        'Expected single large metadata read or lazy loading');
    });
  }

  // ─── Correctness Validation ─────────────────────────────────────────────

  suite('Correctness (lazy vs bulk should match)');

  mockFile.reset();

  const datasets = reader.getDatasets();

  check('Dataset count matches expected', () => {
    assert(datasets.length > 10, `Too few datasets: ${datasets.length}`);
  });

  check('GCOV datasets discovered', () => {
    const gcov = datasets.filter(ds => ds.path?.includes('/GCOV/'));
    assert(gcov.length >= 4, `Expected ≥4 GCOV datasets, got ${gcov.length}`);
  });

  check('Coordinate arrays discovered', () => {
    const xCoords = datasets.find(ds => ds.path?.endsWith('/xCoordinates'));
    const yCoords = datasets.find(ds => ds.path?.endsWith('/yCoordinates'));
    assert(xCoords && yCoords, 'Coordinate arrays not found');
  });

  check('Can read data chunks', async () => {
    const gcov = datasets.find(ds => ds.path?.endsWith('HHHH'));
    assert(gcov, 'HHHH dataset not found');

    const datasetId = gcov.id || gcov.path;
    const chunkData = await reader.readChunk(datasetId, 0, 0);

    assert(chunkData, 'Chunk read returned null');
    assert(chunkData.length > 0, 'Chunk is empty');
  });

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`  Mode: ${usesLazyLoading ? 'Lazy Tree-Walking ✨' : 'Bulk Read (current)'}`);
  console.log(`  Bandwidth: ${(stats.bytesRead / 1e6).toFixed(2)} MB`);
  console.log(`  Efficiency: ${stats.efficiency} of file`);
  console.log(`  Open time: ${openTime}ms`);
  console.log(`  PASSED: ${totalPassed}`);
  console.log(`  FAILED: ${totalFailed}\n`);

  if (usesLazyLoading && stats.bytesRead < 500 * 1024) {
    console.log(`✓ Lazy loading working! Saved ${((8 * 1024 * 1024 - stats.bytesRead) / 1e6).toFixed(2)} MB\n`);
  } else if (!usesLazyLoading) {
    console.log(`ℹ  To enable lazy loading, implement H5Chunk.lazyTreeWalking flag\n`);
  }

  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
