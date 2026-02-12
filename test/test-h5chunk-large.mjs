#!/usr/bin/env node
/**
 * h5chunk validation for large (>2GB) HDF5 files.
 * Uses fs.read() random access to mimic browser File.slice() without loading entire file.
 */

import { openSync, readSync, closeSync, statSync } from 'fs';
import { resolve } from 'path';

const h5FilePath = process.argv[2] || '/mnt/c/Users/nicks/Downloads/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5';

let totalPassed = 0;
let totalFailed = 0;

function suite(name) { console.log(`\n━━━ ${name} ━━━`); }

function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => {
        console.log(`  PASS  ${name}`);
        totalPassed++;
      }).catch(err => {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
        totalFailed++;
      });
    }
    console.log(`  PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    totalFailed++;
  }
}

// File-backed mock that uses random access reads (no full file in memory)
class LargeFileMock {
  constructor(filePath) {
    this._fd = openSync(filePath, 'r');
    const stat = statSync(filePath);
    this.size = stat.size;
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
  close() {
    closeSync(this._fd);
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  h5chunk Large File Validation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const stat = statSync(resolve(h5FilePath));
  console.log(`File: ${h5FilePath}`);
  console.log(`Size: ${(stat.size / 1e9).toFixed(2)} GB\n`);

  const { H5Chunk } = await import(resolve('src/loaders/h5chunk.js'));
  const mockFile = new LargeFileMock(resolve(h5FilePath));

  const reader = new H5Chunk();
  const t0 = Date.now();
  await reader.openFile(mockFile);
  console.log(`Open time: ${Date.now() - t0}ms\n`);

  const datasets = reader.getDatasets();

  // ─── Dataset Discovery ──────────────────────────────────────────────────────
  suite('Dataset Discovery');

  await check('Found datasets', () => {
    if (datasets.length === 0) throw new Error('No datasets discovered');
    console.log(`        ${datasets.length} datasets found`);
  });

  // Check for expected NISAR GCOV structure
  const freqAPaths = datasets.filter(d => d.path?.includes('frequencyA'));
  const freqBPaths = datasets.filter(d => d.path?.includes('frequencyB'));

  await check('Found frequencyA datasets', () => {
    if (freqAPaths.length === 0) throw new Error('No frequencyA datasets found');
    console.log(`        ${freqAPaths.length} frequencyA datasets`);
  });

  await check('Found frequencyB datasets', () => {
    if (freqBPaths.length === 0) throw new Error('No frequencyB datasets found');
    console.log(`        ${freqBPaths.length} frequencyB datasets`);
  });

  // Detail: all frequencyA and frequencyB paths
  console.log('\n  frequencyA datasets:');
  for (const ds of freqAPaths) {
    const dimStr = ds.shape ? `[${ds.shape.join(', ')}]` : '(no shape)';
    console.log(`    ${ds.path} ${dimStr}`);
  }
  console.log('\n  frequencyB datasets:');
  for (const ds of freqBPaths) {
    const dimStr = ds.shape ? `[${ds.shape.join(', ')}]` : '(no shape)';
    console.log(`    ${ds.path} ${dimStr}`);
  }

  // Print all dataset paths for debugging (only 2D datasets and key metadata)
  const datasets2D = datasets.filter(d => d.shape?.length === 2);
  console.log(`\n  2D datasets (${datasets2D.length}):`)
  for (const ds of datasets2D) {
    console.log(`    ${ds.id}: ${ds.path || '(no path)'} [${ds.shape.join(', ')}]`);
  }

  // Also check internal datasets Map directly
  console.log(`\n  All dataset paths containing 'HHHH' or 'Coordinates':`)
  for (const ds of datasets) {
    if (ds.path && (ds.path.includes('HHHH') || ds.path.includes('Coordinate'))) {
      const dimStr = ds.shape ? `[${ds.shape.join(', ')}]` : '(no shape)';
      console.log(`    ${ds.id}: "${ds.path}" ${dimStr}`);
    }
  }

  // ─── findDatasetByPath ─────────────────────────────────────────────────────
  suite('findDatasetByPath (frequency selection)');

  const freqAHHHH = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyA/HHHH');
  const freqBHHHH = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyB/HHHH');

  await check('findDatasetByPath resolves frequencyA/HHHH', () => {
    if (freqAHHHH == null) throw new Error('Could not find frequencyA/HHHH');
    const ds = datasets.find(d => d.id === freqAHHHH);
    console.log(`        id=${freqAHHHH} path=${ds?.path} shape=[${ds?.shape?.join(', ')}]`);
  });

  await check('findDatasetByPath resolves frequencyB/HHHH', () => {
    if (freqBHHHH == null) throw new Error('Could not find frequencyB/HHHH');
    const ds = datasets.find(d => d.id === freqBHHHH);
    console.log(`        id=${freqBHHHH} path=${ds?.path} shape=[${ds?.shape?.join(', ')}]`);
  });

  await check('frequencyA/HHHH != frequencyB/HHHH', () => {
    if (freqAHHHH === freqBHHHH) throw new Error(`Both resolve to same dataset: ${freqAHHHH}`);
  });

  // Check dimensions - frequencyA should be ~4x larger
  const dsA = datasets.find(d => d.id === freqAHHHH);
  const dsB = datasets.find(d => d.id === freqBHHHH);

  await check('frequencyA/HHHH shape is ~4x frequencyB', () => {
    if (!dsA?.shape || !dsB?.shape) throw new Error('Missing shape info');
    const [hA, wA] = dsA.shape;
    const [hB, wB] = dsB.shape;
    const ratioH = hA / hB;
    const ratioW = wA / wB;
    console.log(`        freqA: [${hA}, ${wA}], freqB: [${hB}, ${wB}]`);
    console.log(`        ratio: ${ratioH.toFixed(2)} x ${ratioW.toFixed(2)}`);
    if (ratioH < 3 || ratioH > 5 || ratioW < 3 || ratioW > 5) {
      throw new Error(`Unexpected ratio: ${ratioH.toFixed(2)} x ${ratioW.toFixed(2)}`);
    }
  });

  await check('frequencyA/HHHH has expected 20m dimensions', () => {
    if (!dsA?.shape) throw new Error('Missing shape info');
    const [h, w] = dsA.shape;
    // From h5py: (16956, 17244)
    if (h < 10000 || w < 10000) {
      throw new Error(`Dimensions too small for 20m posting: [${h}, ${w}]`);
    }
    console.log(`        [${h}, ${w}] (expected ~16956 x 17244)`);
  });

  // ─── Coordinate Arrays ─────────────────────────────────────────────────────
  suite('Coordinate Arrays');

  const xCoordId = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyA/xCoordinates');
  const yCoordId = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyA/yCoordinates');

  await check('Found frequencyA xCoordinates', () => {
    if (xCoordId == null) throw new Error('Could not find frequencyA/xCoordinates');
    const ds = datasets.find(d => d.id === xCoordId);
    console.log(`        id=${xCoordId} shape=[${ds?.shape?.join(', ')}]`);
  });

  await check('Found frequencyA yCoordinates', () => {
    if (yCoordId == null) throw new Error('Could not find frequencyA/yCoordinates');
    const ds = datasets.find(d => d.id === yCoordId);
    console.log(`        id=${yCoordId} shape=[${ds?.shape?.join(', ')}]`);
  });

  // Check coordinate spacing datasets
  const xSpId = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyA/xCoordinateSpacing');
  const ySpId = reader.findDatasetByPath('/science/LSAR/GCOV/grids/frequencyA/yCoordinateSpacing');

  if (xSpId != null) {
    await check('xCoordinateSpacing reads as 20.0', async () => {
      const result = await reader.readSmallDataset(xSpId);
      const val = result?.data?.[0];
      console.log(`        value: ${val}`);
      if (Math.abs(val - 20.0) > 0.1) throw new Error(`Expected ~20.0, got ${val}`);
    });
  }

  if (ySpId != null) {
    await check('yCoordinateSpacing reads as -20.0', async () => {
      const result = await reader.readSmallDataset(ySpId);
      const val = result?.data?.[0];
      console.log(`        value: ${val}`);
      if (Math.abs(Math.abs(val) - 20.0) > 0.1) throw new Error(`Expected ~20.0 (abs), got ${val}`);
    });
  }

  // ─── Coordinate-Data Dimension Match ────────────────────────────────────────
  suite('Coordinate-Data Dimension Match');

  if (xCoordId != null && dsA?.shape) {
    const xCoordDs = datasets.find(d => d.id === xCoordId);
    await check('xCoordinates length matches data width', () => {
      const xLen = xCoordDs?.shape?.[0];
      const dataW = dsA.shape[1];
      console.log(`        xCoords: ${xLen}, data width: ${dataW}`);
      if (xLen !== dataW) throw new Error(`Mismatch: ${xLen} vs ${dataW}`);
    });
  }

  if (yCoordId != null && dsA?.shape) {
    const yCoordDs = datasets.find(d => d.id === yCoordId);
    await check('yCoordinates length matches data height', () => {
      const yLen = yCoordDs?.shape?.[0];
      const dataH = dsA.shape[0];
      console.log(`        yCoords: ${yLen}, data height: ${dataH}`);
      if (yLen !== dataH) throw new Error(`Mismatch: ${yLen} vs ${dataH}`);
    });
  }

  // ─── NISAR Loader Integration ───────────────────────────────────────────────
  suite('NISAR Loader Integration');

  try {
    const { listNISARDatasets } = await import(resolve('src/loaders/nisar-loader.js'));

    const t1 = Date.now();
    const dsInfo = await listNISARDatasets(mockFile);
    const listTime = Date.now() - t1;

    await check('listNISARDatasets returns datasets', () => {
      if (!dsInfo || dsInfo.length === 0) throw new Error('No datasets returned');
      console.log(`        ${dsInfo.length} datasets in ${listTime}ms`);
    });

    // Print all returned datasets
    console.log('\n  Listed datasets:');
    for (const d of dsInfo) {
      console.log(`    freq=${d.frequency} pol=${d.polarization} shape=[${d.shape?.join(', ')}] spacing=${d.pixelSpacing?.x}m x ${d.pixelSpacing?.y}m`);
    }

    const freqADs = dsInfo.filter(d => d.frequency === 'A' || d.frequency === 'frequencyA');

    await check('Has frequencyA datasets', () => {
      if (freqADs.length === 0) throw new Error('No frequencyA datasets found');
      console.log(`        ${freqADs.length} frequencyA datasets`);
    });

    await check('frequencyA pixel spacing is ~20m', () => {
      const ds0 = freqADs[0];
      if (!ds0?.pixelSpacing) throw new Error('No pixel spacing info');
      const { x, y } = ds0.pixelSpacing;
      console.log(`        spacing: ${x}m x ${y}m`);
      if (Math.abs(x - 20) > 1 || Math.abs(y - 20) > 1) {
        throw new Error(`Expected ~20m, got ${x}m x ${y}m`);
      }
    });

    await check('frequencyA dimensions are large (20m grid)', () => {
      const ds0 = freqADs[0];
      if (!ds0?.shape) throw new Error('No shape info');
      const [h, w] = ds0.shape;
      console.log(`        [${h}, ${w}]`);
      if (h < 10000 || w < 10000) {
        throw new Error(`Dimensions too small: [${h}, ${w}]`);
      }
    });
  } catch (err) {
    console.log(`  FAIL  NISAR loader integration`);
    console.log(`        ${err.message}`);
    if (err.stack) console.log(`        ${err.stack.split('\n').slice(1, 3).join('\n        ')}`);
    totalFailed++;
  }

  // ─── Data Reading ──────────────────────────────────────────────────────────
  suite('Data Reading');

  if (freqAHHHH != null) {
    await check('Can read a chunk from frequencyA/HHHH', async () => {
      const chunk = await reader.readChunk(freqAHHHH, 0, 0);
      if (!chunk) throw new Error('readChunk returned null');
      console.log(`        chunk length: ${chunk.length} values`);
      let nonZero = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0 && !isNaN(chunk[i])) nonZero++;
      }
      console.log(`        non-zero/NaN: ${nonZero}/${chunk.length}`);
    });
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  RESULTS: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  mockFile.close();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
