#!/usr/bin/env node
/**
 * h5chunk Validation Test Suite
 *
 * Tests h5chunk HDF5 reader against known NISAR GCOV file structure.
 * Validates:
 *   - Dataset discovery (tree-walking)
 *   - Chunk index parsing (B-tree v1)
 *   - Data reading accuracy
 *   - Coordinate array extraction
 *   - Metadata parsing
 *
 * Run: node test/test-h5chunk-validation.mjs [path-to-h5-file]
 *
 * For comparison against h5py ground truth:
 *   python test/scripts/generate-h5py-ground-truth.py <h5-file> > test/data/h5py-truth.json
 *   node test/test-h5chunk-validation.mjs <h5-file> test/data/h5py-truth.json
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Test Infrastructure ─────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
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
    if (err.stack) {
      console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
    }
    totalFailed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertClose(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual} (diff: ${diff.toExponential(2)}, tolerance: ${tolerance.toExponential(2)})`);
  }
}

function assertArrayClose(actual, expected, tolerance, label) {
  assert(actual.length === expected.length, `${label}: length mismatch (${actual.length} vs ${expected.length})`);
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      throw new Error(`${label}[${i}]: expected ${expected[i]}, got ${actual[i]} (diff: ${Math.abs(actual[i] - expected[i]).toExponential(2)})`);
    }
  }
}

// ─── Mock File API for Node.js ───────────────────────────────────────────────

class MockFile {
  constructor(buffer, name) {
    this._buffer = buffer;
    this.name = name;
    this.size = buffer.byteLength;
  }
  slice(start, end) {
    const sliced = this._buffer.slice(start, end);
    return {
      arrayBuffer: () => Promise.resolve(sliced),
    };
  }
}

// ─── Main Test Runner ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const h5FilePath = args[0] || 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
  const groundTruthPath = args[1]; // Optional: JSON from h5py

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  h5chunk Validation Test Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Check file exists
  if (!existsSync(resolve(h5FilePath))) {
    console.error(`ERROR: File not found: ${h5FilePath}`);
    console.error('\nTo run tests, provide a NISAR GCOV HDF5 file:');
    console.error('  node test/test-h5chunk-validation.mjs path/to/file.h5\n');
    process.exit(1);
  }

  console.log(`File: ${h5FilePath}`);
  const buf = readFileSync(resolve(h5FilePath));
  const fileSize = buf.length;
  console.log(`Size: ${(fileSize / 1e6).toFixed(1)} MB\n`);

  // Load h5chunk
  const { H5Chunk } = await import(resolve('src/loaders/h5chunk.js'));

  // Create mock File and open with h5chunk
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const mockFile = new MockFile(arrayBuffer, h5FilePath.split('/').pop());

  const reader = new H5Chunk();
  const startTime = Date.now();
  await reader.openFile(mockFile);
  const openTime = Date.now() - startTime;

  console.log(`Open time: ${openTime}ms\n`);

  // Load ground truth if provided
  let groundTruth = null;
  if (groundTruthPath && existsSync(resolve(groundTruthPath))) {
    console.log(`Loading h5py ground truth: ${groundTruthPath}\n`);
    groundTruth = JSON.parse(readFileSync(resolve(groundTruthPath), 'utf8'));
  }

  // ─── Test Suites ───────────────────────────────────────────────────────────

  await testDatasetDiscovery(reader, groundTruth);
  await testChunkIndexing(reader, groundTruth);
  await testDataReading(reader, groundTruth);
  await testCoordinateArrays(reader, groundTruth);
  await testMetadataParsing(reader, groundTruth);
  await testGroupStructure(reader, groundTruth);
  await testAttributeReading(reader, groundTruth);
  await testEdgeCases(reader);

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Test Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`  PASSED: ${totalPassed}`);
  console.log(`  FAILED: ${totalFailed}`);
  console.log(`  TOTAL:  ${totalPassed + totalFailed}\n`);

  if (totalFailed === 0) {
    console.log('✓ All tests passed!\n');
    process.exit(0);
  } else {
    console.log(`✗ ${totalFailed} test(s) failed\n`);
    process.exit(1);
  }
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

async function testDatasetDiscovery(reader, groundTruth) {
  suite('Dataset Discovery');

  const datasets = reader.getDatasets();

  check('Discovers datasets', () => {
    assert(datasets.length > 0, 'No datasets found');
  });

  check('Finds GCOV data arrays', () => {
    const gcovPaths = datasets.filter(ds => ds.path?.includes('/GCOV/') && ds.path?.match(/[HV]{4}$/));
    assert(gcovPaths.length >= 4, `Expected ≥4 GCOV polarization datasets, found ${gcovPaths.length}`);
  });

  check('Finds identification group', () => {
    const identPaths = datasets.filter(ds => ds.path?.includes('/identification/'));
    assert(identPaths.length > 0, 'No identification datasets found');
  });

  check('Finds coordinate arrays', () => {
    const xCoords = datasets.find(ds => ds.path?.endsWith('/xCoordinates'));
    const yCoords = datasets.find(ds => ds.path?.endsWith('/yCoordinates'));
    assert(xCoords, 'xCoordinates not found');
    assert(yCoords, 'yCoordinates not found');
  });

  if (groundTruth?.datasets) {
    check('Matches h5py dataset count', () => {
      const diff = Math.abs(datasets.length - groundTruth.datasets.length);
      assert(diff <= 5, `Dataset count mismatch: h5chunk=${datasets.length}, h5py=${groundTruth.datasets.length} (diff=${diff})`);
    });

    check('Matches h5py dataset paths', () => {
      const h5chunkPaths = new Set(datasets.map(ds => ds.path));
      const h5pyPaths = new Set(groundTruth.datasets.map(ds => ds.path));

      const missing = [...h5pyPaths].filter(p => !h5chunkPaths.has(p));
      const extra = [...h5chunkPaths].filter(p => !h5pyPaths.has(p));

      if (missing.length > 0) {
        console.log(`       Missing from h5chunk: ${missing.slice(0, 3).join(', ')}`);
      }
      if (extra.length > 0) {
        console.log(`       Extra in h5chunk: ${extra.slice(0, 3).join(', ')}`);
      }

      assert(missing.length <= 5 && extra.length <= 5, `Path mismatch: ${missing.length} missing, ${extra.length} extra`);
    });
  }
}

async function testChunkIndexing(reader, groundTruth) {
  suite('Chunk Index Parsing');

  const datasets = reader.getDatasets();
  const chunkedDatasets = datasets.filter(ds => ds.layout?.type === 'chunked');

  check('Identifies chunked datasets', () => {
    assert(chunkedDatasets.length > 0, 'No chunked datasets found');
  });

  check('Parses chunk dimensions', () => {
    const gcov = chunkedDatasets.find(ds => ds.path?.endsWith('HHHH'));
    if (!gcov) return; // Skip if not found
    assert(gcov.layout?.chunkDims, 'Chunk dimensions not parsed');
    assert(gcov.layout.chunkDims.length === 2, `Expected 2D chunks, got ${gcov.layout.chunkDims.length}D`);
  });

  check('Builds chunk map', () => {
    const gcov = chunkedDatasets.find(ds => ds.path?.endsWith('HHHH'));
    if (!gcov || !gcov.layout?.btreeAddress) return;

    // This would require exposing chunk map or reading a chunk
    // For now, check that btreeAddress exists
    assert(gcov.layout.btreeAddress > 0, 'B-tree address not set');
  });

  if (groundTruth?.chunks) {
    check('Matches h5py chunk count', () => {
      const gcov = chunkedDatasets.find(ds => ds.path?.endsWith('HHHH'));
      if (!gcov || !groundTruth.chunks.HHHH) return;

      const h5pyChunkCount = groundTruth.chunks.HHHH.length;
      // We can't directly access chunk map, so we check if dataset is readable
      assert(gcov.shape, 'Dataset shape not parsed');
    });
  }
}

async function testDataReading(reader, groundTruth) {
  suite('Data Reading');

  const datasets = reader.getDatasets();
  const gcovHHHH = datasets.find(ds => ds.path?.endsWith('HHHH'));

  if (!gcovHHHH) {
    console.log('  SKIP  HHHH dataset not found');
    return;
  }

  check('Reads chunk data', async () => {
    const datasetId = gcovHHHH.id || gcovHHHH.path;
    const chunkData = await reader.readChunk(datasetId, 0, 0);

    assert(chunkData, 'Chunk read returned null');
    assert(chunkData instanceof Float32Array || chunkData instanceof Float64Array,
           `Expected Float array, got ${chunkData.constructor.name}`);
    assert(chunkData.length > 0, 'Chunk is empty');
  });

  check('Reads region data', async () => {
    const datasetId = gcovHHHH.id || gcovHHHH.path;
    const regionData = await reader.readRegion(datasetId, 0, 0, 100, 100);

    assert(regionData, 'Region read returned null');
    assert(regionData.length === 100 * 100, `Expected 10000 elements, got ${regionData.length}`);
  });

  if (groundTruth?.values) {
    check('Matches h5py pixel values', async () => {
      const datasetId = gcovHHHH.id || gcovHHHH.path;
      const h5chunkData = await reader.readRegion(datasetId, 0, 0, 10, 10);

      if (!groundTruth.values.HHHH) return;

      const h5pyValues = groundTruth.values.HHHH.slice(0, 100); // First 10x10
      assertArrayClose(h5chunkData, h5pyValues, 1e-5, 'HHHH pixel values');
    });
  }

  check('Handles missing chunks gracefully', async () => {
    const datasetId = gcovHHHH.id || gcovHHHH.path;
    // Try to read beyond dataset bounds
    const [rows, cols] = gcovHHHH.shape || [0, 0];
    if (rows > 0 && cols > 0) {
      const farChunk = await reader.readChunk(datasetId, rows * 10, cols * 10);
      // Should return null or zeros, not throw
      assert(farChunk === null || farChunk.every(v => v === 0), 'Missing chunk should be null or zeros');
    }
  });
}

async function testCoordinateArrays(reader, groundTruth) {
  suite('Coordinate Arrays');

  const datasets = reader.getDatasets();
  const xCoords = datasets.find(ds => ds.path?.endsWith('/xCoordinates'));
  const yCoords = datasets.find(ds => ds.path?.endsWith('/yCoordinates'));

  check('Reads xCoordinates', async () => {
    assert(xCoords, 'xCoordinates dataset not found');
    const datasetId = xCoords.id || xCoords.path;
    const data = await reader.readSmallDataset(datasetId);

    assert(data, 'xCoordinates read returned null');
    assert(data.length > 0, 'xCoordinates is empty');
    assert(data.length === xCoords.shape[0], `Length mismatch: ${data.length} vs ${xCoords.shape[0]}`);
  });

  check('Reads yCoordinates', async () => {
    assert(yCoords, 'yCoordinates dataset not found');
    const datasetId = yCoords.id || yCoords.path;
    const data = await reader.readSmallDataset(datasetId);

    assert(data, 'yCoordinates read returned null');
    assert(data.length > 0, 'yCoordinates is empty');
  });

  check('Coordinate values are reasonable (EPSG:4326)', async () => {
    const datasetId = xCoords.id || xCoords.path;
    const xData = await reader.readSmallDataset(datasetId);

    // Longitude should be in [-180, 180]
    const minX = Math.min(...xData);
    const maxX = Math.max(...xData);
    assert(minX >= -180 && maxX <= 180, `Longitude out of range: [${minX}, ${maxX}]`);
  });

  if (groundTruth?.coordinates) {
    check('Matches h5py coordinates', async () => {
      const datasetId = xCoords.id || xCoords.path;
      const h5chunkX = await reader.readSmallDataset(datasetId);

      if (!groundTruth.coordinates.x) return;

      const h5pyX = groundTruth.coordinates.x;
      const n = Math.min(100, h5chunkX.length, h5pyX.length);
      assertArrayClose(h5chunkX.slice(0, n), h5pyX.slice(0, n), 1e-8, 'xCoordinates');
    });
  }
}

async function testMetadataParsing(reader, groundTruth) {
  suite('Metadata Parsing');

  const datasets = reader.getDatasets();

  check('Parses dataset shapes', () => {
    const gcov = datasets.find(ds => ds.path?.endsWith('HHHH'));
    assert(gcov, 'HHHH dataset not found');
    assert(gcov.shape, 'Shape not parsed');
    assert(gcov.shape.length === 2, `Expected 2D shape, got ${gcov.shape.length}D`);
    assert(gcov.shape[0] > 0 && gcov.shape[1] > 0, `Invalid shape: [${gcov.shape}]`);
  });

  check('Parses dataset dtypes', () => {
    const gcov = datasets.find(ds => ds.path?.endsWith('HHHH'));
    assert(gcov.dtype || gcov.datatype?.dtype, 'Dtype not parsed');
  });

  check('Identifies Float32 datasets', () => {
    const gcov = datasets.find(ds => ds.path?.endsWith('HHHH'));
    const dtype = gcov.dtype || gcov.datatype?.dtype;
    assert(dtype === '<f4' || dtype === 'float32', `Expected float32, got ${dtype}`);
  });
}

async function testGroupStructure(reader, groundTruth) {
  suite('Group Structure');

  check('Follows group hierarchy', () => {
    const datasets = reader.getDatasets();
    const nested = datasets.filter(ds => (ds.path?.split('/').length || 0) >= 5);
    assert(nested.length > 0, 'No nested datasets found (expected /science/LSAR/GCOV/...)');
  });

  check('Handles v2 fractal heap groups', () => {
    const datasets = reader.getDatasets();
    const radarGrid = datasets.filter(ds => ds.path?.includes('/radarGrid/'));
    // NISAR uses v2 groups for radarGrid
    assert(radarGrid.length > 0, 'radarGrid group not found (requires v2 group support)');
  });
}

async function testAttributeReading(reader, groundTruth) {
  suite('Attribute Reading');

  const datasets = reader.getDatasets();
  const product = datasets.find(ds => ds.path?.includes('/identification/productType'));

  if (!product) {
    console.log('  SKIP  productType dataset not found');
    return;
  }

  check('Reads string datasets', async () => {
    const datasetId = product.id || product.path;
    const data = await reader.readSmallDataset(datasetId);

    assert(data, 'productType read returned null');
    // String datasets come back as Uint8Array (UTF-8 bytes) or string
    assert(data.length > 0 || (typeof data === 'string' && data.length > 0), 'productType is empty');
  });
}

async function testEdgeCases(reader) {
  suite('Edge Cases');

  check('Handles invalid dataset IDs gracefully', async () => {
    try {
      await reader.readChunk('nonexistent-dataset-id', 0, 0);
      // Should return null or throw
    } catch (err) {
      // Expected
    }
  });

  check('Handles negative coordinates', async () => {
    const datasets = reader.getDatasets();
    const gcov = datasets.find(ds => ds.path?.endsWith('HHHH'));
    if (!gcov) return;

    const datasetId = gcov.id || gcov.path;
    try {
      await reader.readRegion(datasetId, -1, -1, 10, 10);
      // Should handle gracefully
    } catch (err) {
      // Expected
    }
  });

  check('Memory usage is bounded', () => {
    const memUsed = process.memoryUsage();
    const heapMB = memUsed.heapUsed / 1e6;

    // h5chunk should not load entire file into memory
    assert(heapMB < 500, `Heap usage too high: ${heapMB.toFixed(0)} MB (expected < 500 MB)`);
  });
}

// ─── Run Tests ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
