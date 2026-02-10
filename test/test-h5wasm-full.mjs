/**
 * Test: Patch the HDF5 superblock to make h5wasm think the partial buffer IS the full file.
 *
 * HDF5 Superblock v2 layout (spec):
 *   offset 0: signature (8 bytes: \x89HDF\r\n\x1a\n)
 *   offset 8: version (1 byte)
 *   offset 9: offset size (1 byte)
 *   offset 10: length size (1 byte)
 *   offset 11: file consistency flags (1 byte)
 *   offset 12: base address (8 bytes)
 *   offset 20: superblock extension address (8 bytes)
 *   offset 28: end of file address (8 bytes)  ← PATCH THIS
 *   offset 36: root group object header address (8 bytes)
 *   offset 44: superblock checksum (4 bytes)
 */
import h5wasm from 'h5wasm';
import fs from 'fs';

const filePath = 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const fullSize = fs.statSync(filePath).size;

// Read only the first 32MB
const META_SIZE = 32 * 1024 * 1024;
const fd = fs.openSync(filePath, 'r');
const buf = Buffer.alloc(META_SIZE);
fs.readSync(fd, buf, 0, META_SIZE, 0);
fs.closeSync(fd);

console.log(`File size: ${(fullSize / 1e9).toFixed(2)} GB`);
console.log(`Buffer: ${(META_SIZE / 1e6).toFixed(1)} MB`);

// Parse superblock
const sig = buf.toString('ascii', 0, 4);
console.log(`Signature: ${buf.slice(0, 8).toString('hex')}`);
const version = buf[8];
console.log(`Superblock version: ${version}`);
const offsetSize = buf[9];
const lengthSize = buf[10];
console.log(`Offset size: ${offsetSize}, Length size: ${lengthSize}`);

if (version >= 2) {
  // Read current EOF address (at offset 28, 8 bytes LE)
  const eofAddr = buf.readBigUInt64LE(28);
  console.log(`Current EOF address: 0x${eofAddr.toString(16)} (${Number(eofAddr) / 1e9} GB)`);
  console.log(`Root group address: 0x${buf.readBigUInt64LE(36).toString(16)}`);

  // DON'T patch — h5wasm uses checksums. Instead just see what we can learn.
  // Let's try reading metadata up to 64MB instead and see if that helps
}

// Try with the full file via h5wasm (loading everything - will be slow but informative)
console.log('\n--- Loading FULL file with h5wasm for comparison ---');
const startTime = performance.now();
const fullBuf = fs.readFileSync(filePath);
const loadTime = performance.now() - startTime;
console.log(`Full file loaded in ${(loadTime/1000).toFixed(1)}s`);

await h5wasm.ready;
const h5file = new h5wasm.File(fullBuf.buffer, 'full.h5');

console.log('\nRoot keys:', h5file.get('/').keys());

const science = h5file.get('/science');
if (science) {
  console.log('/science keys:', science.keys());

  for (const band of ['LSAR', 'SSAR']) {
    const bandGroup = h5file.get(`/science/${band}`);
    if (!bandGroup) continue;
    console.log(`\n/science/${band} keys:`, bandGroup.keys());

    // identification
    const ident = h5file.get(`/science/${band}/identification`);
    if (ident) {
      console.log(`/science/${band}/identification keys:`, ident.keys());
      for (const key of ['productType', 'listOfFrequencies', 'absoluteOrbitNumber',
                         'trackNumber', 'frameNumber', 'lookDirection', 'orbitPassDirection',
                         'zeroDopplerStartTime', 'zeroDopplerEndTime']) {
        try {
          const ds = h5file.get(`/science/${band}/identification/${key}`);
          if (ds) console.log(`  ${key}:`, ds.value);
        } catch (e) { console.log(`  ${key}: error - ${e.message}`); }
      }
    }

    // GCOV grids
    const gcov = h5file.get(`/science/${band}/GCOV`);
    if (gcov) {
      console.log(`\n/science/${band}/GCOV keys:`, gcov.keys());
      const grids = h5file.get(`/science/${band}/GCOV/grids`);
      if (grids) {
        console.log(`/science/${band}/GCOV/grids keys:`, grids.keys());

        for (const freq of ['frequencyA', 'frequencyB']) {
          const freqGroup = h5file.get(`/science/${band}/GCOV/grids/${freq}`);
          if (!freqGroup) continue;
          console.log(`\n/science/${band}/GCOV/grids/${freq} keys:`, freqGroup.keys());

          // Read all metadata datasets
          for (const key of ['listOfCovarianceTerms', 'listOfPolarizations',
                             'projection', 'xCoordinateSpacing', 'yCoordinateSpacing']) {
            try {
              const ds = h5file.get(`/science/${band}/GCOV/grids/${freq}/${key}`);
              if (ds) console.log(`  ${key}:`, ds.value);
            } catch (e) { console.log(`  ${key}: error - ${e.message}`); }
          }

          // Check which covariance terms exist as datasets
          const allTerms = ['HHHH', 'HVHV', 'VHVH', 'VVVV', 'HHHV', 'HHVH', 'HHVV', 'HVVH', 'HVVV', 'VHVV'];
          const found = [];
          for (const term of allTerms) {
            const ds = h5file.get(`/science/${band}/GCOV/grids/${freq}/${term}`);
            if (ds) {
              found.push(term);
              console.log(`  ${term}: shape=${ds.shape} dtype=${ds.dtype}`);
            }
          }
          console.log(`  Found terms: [${found.join(', ')}]`);
        }
      }
    }
  }
}

h5file.close();
