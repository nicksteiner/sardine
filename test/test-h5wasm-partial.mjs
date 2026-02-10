/**
 * Test: Can h5wasm read group structure from a partial (metadata-only) buffer?
 *
 * NISAR cloud-optimized files put all metadata at the front.
 * If h5wasm can open a truncated buffer and traverse groups,
 * we can use it for metadata discovery without loading the whole file.
 */
import h5wasm from 'h5wasm';
import fs from 'fs';

const filePath = 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';
const fullSize = fs.statSync(filePath).size;

// Read only the first 32MB (same as h5chunk metadata read)
const META_SIZE = 32 * 1024 * 1024;
const fd = fs.openSync(filePath, 'r');
const buf = Buffer.alloc(META_SIZE);
fs.readSync(fd, buf, 0, META_SIZE, 0);
fs.closeSync(fd);

console.log(`File size: ${(fullSize / 1e9).toFixed(2)} GB`);
console.log(`Metadata buffer: ${(META_SIZE / 1e6).toFixed(1)} MB`);

await h5wasm.ready;

try {
  const h5file = new h5wasm.File(buf.buffer, 'partial.h5');
  console.log('\nh5wasm opened partial buffer successfully!');

  // Try to traverse the group tree
  const root = h5file.get('/');
  console.log('Root keys:', root.keys());

  // Try science group
  const science = h5file.get('/science');
  if (science) {
    console.log('/science keys:', science.keys());

    // Try LSAR
    const lsar = h5file.get('/science/LSAR');
    if (lsar) {
      console.log('/science/LSAR keys:', lsar.keys());

      // Try identification
      const ident = h5file.get('/science/LSAR/identification');
      if (ident) {
        console.log('/science/LSAR/identification keys:', ident.keys());

        // Read listOfFrequencies
        try {
          const freqDs = h5file.get('/science/LSAR/identification/listOfFrequencies');
          if (freqDs) console.log('listOfFrequencies:', freqDs.value);
        } catch (e) { console.log('listOfFrequencies error:', e.message); }

        // Read productType
        try {
          const ptDs = h5file.get('/science/LSAR/identification/productType');
          if (ptDs) console.log('productType:', ptDs.value);
        } catch (e) { console.log('productType error:', e.message); }

        // Read listOfPolarizations (if at identification level)
        try {
          const polDs = h5file.get('/science/LSAR/identification/listOfPolarizations');
          if (polDs) console.log('listOfPolarizations:', polDs.value);
        } catch (e) { console.log('listOfPolarizations error:', e.message); }
      }

      // Try GCOV grids
      const gcov = h5file.get('/science/LSAR/GCOV');
      if (gcov) {
        console.log('/science/LSAR/GCOV keys:', gcov.keys());

        const grids = h5file.get('/science/LSAR/GCOV/grids');
        if (grids) {
          console.log('/science/LSAR/GCOV/grids keys:', grids.keys());

          const freqA = h5file.get('/science/LSAR/GCOV/grids/frequencyA');
          if (freqA) {
            console.log('/science/LSAR/GCOV/grids/frequencyA keys:', freqA.keys());

            // Check each known covariance term
            for (const term of ['HHHH', 'HVHV', 'VHVH', 'VVVV', 'HHHV', 'HHVV']) {
              const ds = h5file.get(`/science/LSAR/GCOV/grids/frequencyA/${term}`);
              if (ds) {
                console.log(`  ${term}: shape=${ds.shape} dtype=${ds.dtype}`);
              }
            }

            // Check listOfCovarianceTerms
            try {
              const termsDs = h5file.get('/science/LSAR/GCOV/grids/frequencyA/listOfCovarianceTerms');
              if (termsDs) console.log('  listOfCovarianceTerms:', termsDs.value);
            } catch (e) { console.log('  listOfCovarianceTerms error:', e.message); }

            // Check listOfPolarizations
            try {
              const polDs = h5file.get('/science/LSAR/GCOV/grids/frequencyA/listOfPolarizations');
              if (polDs) console.log('  listOfPolarizations:', polDs.value);
            } catch (e) { console.log('  listOfPolarizations error:', e.message); }

            // Check projection
            try {
              const projDs = h5file.get('/science/LSAR/GCOV/grids/frequencyA/projection');
              if (projDs) console.log('  projection:', projDs.value);
            } catch (e) { console.log('  projection error:', e.message); }
          }
        }
      }
    }
  }

  h5file.close();
} catch (e) {
  console.error('h5wasm failed on partial buffer:', e.message);
  console.log('(This might mean h5wasm needs the full file, or the file layout is different)');
}
