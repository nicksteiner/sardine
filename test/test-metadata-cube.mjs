#!/usr/bin/env node
/**
 * Test: Metadata Cube Integration
 *
 * Validates that metadata cube (incidence angle, slant range, etc.)
 * is properly loaded and integrated into nisar-loader.js
 *
 * Run: node test/test-metadata-cube.mjs [path-to-nisar-h5-file]
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

function assertClose(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual} (diff: ${diff.toExponential(2)})`);
  }
}

// ─── Main Test ───────────────────────────────────────────────────────────────

async function main() {
  const h5FilePath = process.argv[2] || 'test/data/NISAR_L2_PR_GCOV_013_147_A_175_2005_DHDH_A_20251226T104404_20251226T104439_P05006_N_F_J_001.h5';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Metadata Cube Integration Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!existsSync(resolve(h5FilePath))) {
    console.error(`ERROR: File not found: ${h5FilePath}\n`);
    process.exit(1);
  }

  console.log(`File: ${h5FilePath}`);
  const fileSize = readFileSync(resolve(h5FilePath)).length;
  console.log(`Size: ${(fileSize / 1e6).toFixed(1)} MB\n`);

  // Load nisar-loader
  const { loadNISARGCOV } = await import(resolve('src/loaders/nisar-loader.js'));

  // Create File-like object from buffer
  const buf = readFileSync(resolve(h5FilePath));
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const mockFile = {
    name: h5FilePath.split('/').pop(),
    size: arrayBuffer.byteLength,
    slice: (start, end) => {
      const sliced = arrayBuffer.slice(start, end === undefined ? arrayBuffer.byteLength : end);
      return { arrayBuffer: () => Promise.resolve(sliced) };
    }
  };

  // ─── Test Suites ─────────────────────────────────────────────────────────

  suite('Metadata Cube Loading');

  const startTime = Date.now();
  const imageData = await loadNISARGCOV(mockFile, { frequency: 'A', polarization: 'HHHH' });
  const loadTime = Date.now() - startTime;

  console.log(`\nLoad time: ${loadTime}ms`);

  check('Image data loaded successfully', () => {
    assert(imageData, 'imageData is null');
    assert(imageData.getTile, 'getTile function missing');
  });

  check('Metadata cube is present', () => {
    assert('metadataCube' in imageData, 'metadataCube property not found in result');
  });

  if (!imageData.metadataCube) {
    console.log('\n⚠️  Metadata cube is null - file may not have radarGrid metadata');
    console.log('    This is expected for some NISAR products');
  } else {
    const cube = imageData.metadataCube;

    suite('Metadata Cube Structure');

    check('Has coordinate arrays', () => {
      assert(cube.x && cube.x.length > 0, 'xCoordinates empty');
      assert(cube.y && cube.y.length > 0, 'yCoordinates empty');
      assert(cube.z && cube.z.length > 0, 'heights empty');
    });

    check('Has dimensions', () => {
      assert(cube.nx > 0 && cube.ny > 0 && cube.nz > 0,
        `Invalid dimensions: ${cube.nx}×${cube.ny}×${cube.nz}`);
    });

    check('Has field data', () => {
      const fields = cube.getFieldNames();
      assert(fields.length > 0, 'No fields loaded');
      console.log(`      Fields: ${fields.join(', ')}`);
    });

    check('Coordinate axes are reasonable', () => {
      // Easting should be increasing
      assert(cube.x[cube.nx - 1] > cube.x[0], 'Easting not increasing');

      // Northing should be decreasing (north-up convention)
      assert(cube.y[cube.ny - 1] < cube.y[0], 'Northing not decreasing');

      // Heights should be positive
      assert(cube.z[0] >= 0, `Negative height: ${cube.z[0]}`);
    });

    suite('Metadata Cube Interpolation');

    const fields = cube.getFieldNames();

    if (fields.includes('incidenceAngle')) {
      check('Incidence angle is reasonable', () => {
        // Sample at cube center
        const midX = (cube.x[0] + cube.x[cube.nx - 1]) / 2;
        const midY = (cube.y[0] + cube.y[cube.ny - 1]) / 2;

        const angle = cube.getIncidenceAngle(midX, midY);

        assert(angle !== null, 'Incidence angle is null at center');
        assert(angle >= 0 && angle <= 90,
          `Incidence angle out of range: ${angle}° (expected 0-90°)`);

        console.log(`      Center incidence angle: ${angle.toFixed(2)}°`);
      });

      check('Interpolation works at corners', () => {
        // Test all four corners
        const corners = [
          [cube.x[0], cube.y[0]],
          [cube.x[cube.nx - 1], cube.y[0]],
          [cube.x[0], cube.y[cube.ny - 1]],
          [cube.x[cube.nx - 1], cube.y[cube.ny - 1]],
        ];

        let validCount = 0;
        for (const [x, y] of corners) {
          const angle = cube.getIncidenceAngle(x, y);
          if (angle !== null && angle >= 0 && angle <= 90) {
            validCount++;
          }
        }

        assert(validCount >= 3, `Only ${validCount}/4 corners have valid incidence angle`);
      });

      check('Handles out-of-bounds gracefully', () => {
        // Try point way outside cube bounds
        const farX = cube.x[0] + (cube.x[cube.nx - 1] - cube.x[0]) * 10;
        const farY = cube.y[0] + (cube.y[cube.ny - 1] - cube.y[0]) * 10;

        const angle = cube.getIncidenceAngle(farX, farY);
        assert(angle === null, 'Out-of-bounds should return null');
      });
    }

    if (fields.includes('slantRange')) {
      check('Slant range is reasonable', () => {
        const midX = (cube.x[0] + cube.x[cube.nx - 1]) / 2;
        const midY = (cube.y[0] + cube.y[cube.ny - 1]) / 2;

        const range = cube.interpolate('slantRange', midX, midY);

        assert(range !== null, 'Slant range is null at center');
        // NISAR slant range should be ~700-1000 km
        assert(range > 500e3 && range < 1200e3,
          `Slant range out of range: ${(range / 1e3).toFixed(0)} km (expected 500-1200 km)`);

        console.log(`      Center slant range: ${(range / 1e3).toFixed(1)} km`);
      });
    }

    suite('Grid Evaluation');

    if (imageData.xCoords && imageData.yCoords && fields.includes('incidenceAngle')) {
      check('evaluateOnGrid produces correct shape', () => {
        // Evaluate on small subsampled grid
        const width = 100;
        const height = 100;

        const subsampledX = new Float64Array(width);
        const subsampledY = new Float64Array(height);

        for (let i = 0; i < width; i++) {
          const idx = Math.floor(i / width * imageData.xCoords.length);
          subsampledX[i] = imageData.xCoords[idx];
        }
        for (let i = 0; i < height; i++) {
          const idx = Math.floor(i / height * imageData.yCoords.length);
          subsampledY[i] = imageData.yCoords[idx];
        }

        const gridData = cube.evaluateOnGrid(
          'incidenceAngle',
          subsampledX,
          subsampledY,
          width,
          height,
          null, // ground level
          1     // no subsampling
        );

        assert(gridData instanceof Float32Array, 'Grid data not Float32Array');
        assert(gridData.length === width * height,
          `Grid data length mismatch: ${gridData.length} vs ${width * height}`);

        // Check that some values are valid
        const validCount = Array.from(gridData).filter(v => !isNaN(v) && v > 0 && v < 90).length;
        const validPercent = (validCount / gridData.length * 100).toFixed(1);

        assert(validCount > gridData.length * 0.5,
          `Too few valid values: ${validCount}/${gridData.length} (${validPercent}%)`);

        console.log(`      Valid incidence angles: ${validPercent}%`);
      });

      check('evaluateAllFields returns all fields', () => {
        const width = 50;
        const height = 50;

        const subsampledX = new Float64Array(width);
        const subsampledY = new Float64Array(height);

        for (let i = 0; i < width; i++) {
          const idx = Math.floor(i / width * imageData.xCoords.length);
          subsampledX[i] = imageData.xCoords[idx];
        }
        for (let i = 0; i < height; i++) {
          const idx = Math.floor(i / height * imageData.yCoords.length);
          subsampledY[i] = imageData.yCoords[idx];
        }

        const allFields = cube.evaluateAllFields(
          subsampledX,
          subsampledY,
          width,
          height,
          1 // no multilook
        );

        const expectedFields = cube.getFieldNames();
        for (const fieldName of expectedFields) {
          assert(fieldName in allFields,
            `Field ${fieldName} missing from evaluateAllFields result`);
          assert(allFields[fieldName] instanceof Float32Array,
            `Field ${fieldName} not Float32Array`);
          assert(allFields[fieldName].length === width * height,
            `Field ${fieldName} has wrong length`);
        }

        console.log(`      Evaluated ${expectedFields.length} fields on ${width}×${height} grid`);
      });
    }

    suite('Integration with Export');

    check('Metadata cube can be used for GeoTIFF export', () => {
      // This tests that the cube can produce export-ready bands
      // Actual GeoTIFF writing is tested elsewhere
      assert(cube.evaluateAllFields, 'evaluateAllFields method missing');
      assert(cube.getFieldNames().length > 0, 'No fields available for export');

      console.log('      ✓ Metadata cube ready for GeoTIFF export integration');
    });
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log(`  Metadata cube: ${imageData.metadataCube ? '✓ Loaded' : '✗ Not available'}`);
  if (imageData.metadataCube) {
    const cube = imageData.metadataCube;
    console.log(`  Dimensions: ${cube.nx}×${cube.ny}×${cube.nz}`);
    console.log(`  Fields: ${cube.getFieldNames().join(', ')}`);
    console.log(`  Coverage: ${((cube.x[cube.nx-1] - cube.x[0])/1e3).toFixed(1)}×${((cube.y[0] - cube.y[cube.ny-1])/1e3).toFixed(1)} km`);
  }
  console.log(`  PASSED: ${totalPassed}`);
  console.log(`  FAILED: ${totalFailed}\n`);

  if (totalFailed === 0) {
    console.log('✓ All tests passed!\n');
    process.exit(0);
  } else {
    console.log(`✗ ${totalFailed} test(s) failed\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
