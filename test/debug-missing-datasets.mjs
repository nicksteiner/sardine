#!/usr/bin/env node
/**
 * Debug: why does h5chunk miss VVVV and mask from frequencyA?
 * Enumerates the frequencyA group directly and logs each child parse attempt.
 */

import { openSync, readSync, closeSync, statSync } from 'fs';
import { resolve } from 'path';

const h5FilePath = process.argv[2] || '/mnt/c/Users/nicks/Downloads/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5';

class LargeFileMock {
  constructor(filePath) {
    this._fd = openSync(filePath, 'r');
    this.size = statSync(filePath).size;
    this.name = filePath.split('/').pop();
  }
  slice(start, end) {
    const length = end - start;
    const buf = Buffer.alloc(length);
    readSync(this._fd, buf, 0, length, start);
    return {
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    };
  }
  close() { closeSync(this._fd); }
}

async function main() {
  const { H5Chunk } = await import(resolve('src/loaders/h5chunk.js'));
  const mockFile = new LargeFileMock(resolve(h5FilePath));
  const reader = new H5Chunk();
  await reader.openFile(mockFile);

  const datasets = reader.getDatasets();

  // Find the frequencyA group by looking at what paths we have
  const freqAPaths = datasets.filter(d => d.path?.includes('grids/frequencyA/'));
  const freqBPaths = datasets.filter(d => d.path?.includes('grids/frequencyB/'));

  console.log(`\nDiscovered under grids/frequencyA: ${freqAPaths.length}`);
  for (const ds of freqAPaths) {
    const tail = ds.path.split('/').pop();
    console.log(`  ${tail}: [${ds.shape?.join(', ') || '?'}] ${ds.dtype}`);
  }

  console.log(`\nDiscovered under grids/frequencyB: ${freqBPaths.length}`);
  for (const ds of freqBPaths) {
    const tail = ds.path.split('/').pop();
    console.log(`  ${tail}: [${ds.shape?.join(', ') || '?'}] ${ds.dtype}`);
  }

  // Expected children from h5py
  const expected = ['HHHH', 'HVHV', 'VHVH', 'VVVV', 'listOfCovarianceTerms', 'listOfPolarizations',
    'mask', 'numberOfLooks', 'numberOfSubSwaths', 'projection', 'rtcGammaToSigmaFactor',
    'xCoordinateSpacing', 'xCoordinates', 'yCoordinateSpacing', 'yCoordinates'];

  const foundNames = new Set(freqAPaths.map(d => d.path.split('/').pop()));
  const missing = expected.filter(n => !foundNames.has(n));
  console.log(`\nMissing from frequencyA: ${missing.length > 0 ? missing.join(', ') : 'NONE'}`);

  // Now try findDatasetByPath for each missing dataset
  for (const name of missing) {
    const fullPath = `/science/LSAR/GCOV/grids/frequencyA/${name}`;
    const id = reader.findDatasetByPath(fullPath);
    console.log(`  findDatasetByPath("${fullPath}"): ${id || 'NOT FOUND'}`);
  }

  // Try directly enumerating the frequencyA group via _enumerateRemoteGroup
  // First, find the frequencyA group's B-tree/heap by checking what children
  // the grids group has
  console.log('\n--- Direct group enumeration ---');

  // We need to find the grids group's symbol table to get frequencyA's btree/heap
  // Instead, let's just check what the grids group's children look like
  // by looking for any dataset whose path starts with grids/frequencyA
  // If frequencyA was enumerated as a group child, its children should all be found.

  // Let's check if the B-tree for frequencyA returns all 15 children
  // by accessing the _enumerateRemoteGroup method
  // We need the btreeAddr and heapAddr for the frequencyA group

  // Check frequencyB for comparison - it has mask but not VVVV
  const freqBNames = new Set(freqBPaths.map(d => d.path.split('/').pop()));
  console.log(`\nfreqB has mask: ${freqBNames.has('mask')}`);
  console.log(`freqB has numberOfSubSwaths: ${freqBNames.has('numberOfSubSwaths')}`);

  // Check object attributes - maybe frequencyA was partially parsed
  console.log('\n--- Checking all datasets for VVVV anywhere ---');
  for (const ds of datasets) {
    if (ds.path?.includes('VVVV')) {
      console.log(`  Found VVVV: ${ds.path} [${ds.shape?.join(', ')}]`);
    }
  }

  console.log('\n--- Checking all datasets for mask under grids ---');
  for (const ds of datasets) {
    if (ds.path?.includes('grids') && ds.path?.includes('mask')) {
      console.log(`  Found mask: ${ds.path} [${ds.shape?.join(', ')}]`);
    }
  }

  mockFile.close();
}

main().catch(err => { console.error(err); process.exit(1); });
