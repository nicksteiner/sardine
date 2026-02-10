#!/usr/bin/env node
/**
 * Debug script: list all datasets h5chunk discovers in a NISAR file.
 * Run: node test/debug-h5chunk-datasets.mjs <path-to-h5-file>
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// We need to load h5chunk in a Node-compatible way
const filePath = process.argv[2] || 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';

console.log(`\nReading: ${filePath}\n`);

// Read the file into an ArrayBuffer (simulating File API)
const buf = readFileSync(resolve(filePath));
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

console.log(`File size: ${(buf.length / 1e6).toFixed(1)} MB`);

// Import h5chunk
const h5chunkPath = resolve('src/loaders/h5chunk.js');  // run from project root
const { H5Chunk } = await import(h5chunkPath);

// Create a mock File object
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

const mockFile = new MockFile(arrayBuffer, filePath.split('/').pop());

// Open with h5chunk
const reader = new H5Chunk();
await reader.openFile(mockFile);

// List all datasets
const datasets = reader.getDatasets();
console.log(`\n=== h5chunk discovered ${datasets.length} datasets ===\n`);

// Group by path prefix
const byPrefix = {};
for (const ds of datasets) {
  const path = ds.path || ds.id || '(no path)';
  const prefix = path.split('/').slice(0, 4).join('/');
  if (!byPrefix[prefix]) byPrefix[prefix] = [];
  byPrefix[prefix].push({
    path,
    shape: ds.shape,
    dtype: ds.dtype || ds.datatype?.dtype,
    layout: ds.layout?.type,
  });
}

for (const [prefix, items] of Object.entries(byPrefix).sort()) {
  console.log(`\n── ${prefix} (${items.length} datasets) ──`);
  for (const item of items) {
    const shape = item.shape ? item.shape.join('×') : '?';
    console.log(`  ${item.path}  [${shape}]  dtype=${item.dtype}  layout=${item.layout}`);
  }
}

// Specifically check identification paths
console.log('\n\n=== Checking identification paths ===\n');
const identPaths = [
  '/science/LSAR/identification/productType',
  '/science/LSAR/identification/absoluteOrbitNumber',
  '/science/LSAR/identification/trackNumber',
  '/science/LSAR/identification/lookDirection',
  '/science/LSAR/identification/orbitPassDirection',
  '/science/LSAR/identification/zeroDopplerStartTime',
  '/science/LSAR/identification/listOfFrequencies',
];

for (const p of identPaths) {
  const dsId = reader.findDatasetByPath(p);
  console.log(`  ${p}: ${dsId != null ? `FOUND (id=${dsId})` : 'NOT FOUND'}`);
}

// Check what's in the datasets map directly
console.log('\n\n=== All dataset paths containing "identification" ===\n');
for (const ds of datasets) {
  const path = ds.path || '';
  if (path.toLowerCase().includes('identif') || path.toLowerCase().includes('science')) {
    console.log(`  ${path}  [${ds.shape?.join('×') || '?'}]  dtype=${ds.dtype || ds.datatype?.dtype}`);
  }
}

// Check attributes on identification group
console.log('\n\n=== Attributes on identification group ===\n');
const attrs = reader.getAttributes?.('/science/LSAR/identification');
if (attrs) {
  console.log('  Found:', Object.keys(attrs));
  for (const [k, v] of Object.entries(attrs)) {
    console.log(`    ${k} = ${JSON.stringify(v)}`);
  }
} else {
  console.log('  No attributes found (or getAttributes not available)');
}

// Also check objectAttributes map directly
console.log('\n\n=== All paths in objectAttributes ===\n');
if (reader.objectAttributes) {
  for (const [path, attrs] of reader.objectAttributes.entries()) {
    if (path.includes('identification') || path.includes('science')) {
      console.log(`  ${path}: ${JSON.stringify(Object.keys(attrs))}`);
    }
  }
} else {
  console.log('  objectAttributes not accessible');
}
