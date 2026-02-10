/**
 * Test inverse-dB multilook for SAR data
 */

import { writeRGBAGeoTIFF } from './src/utils/geotiff-writer.js';
import fs from 'fs';

console.log('Testing Inverse-dB Multilook for SAR Data...\n');

// Simulate SAR data processing pipeline
const width = 2048;
const height = 2048;

// Step 1: Generate synthetic SAR data in linear power
console.log('Generating synthetic SAR backscatter (linear power)...');
const linearPower = new Float32Array(width * height * 3);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 3;

    // Simulate different land cover types with realistic backscatter
    const landType = Math.floor(Math.random() * 3);

    if (landType === 0) {
      // Water: very low backscatter (~-25 to -20 dB)
      linearPower[idx] = Math.pow(10, (-23 + Math.random() * 3) / 10);
      linearPower[idx + 1] = Math.pow(10, (-24 + Math.random() * 3) / 10);
      linearPower[idx + 2] = Math.pow(10, (-25 + Math.random() * 3) / 10);
    } else if (landType === 1) {
      // Vegetation: medium backscatter (~-15 to -8 dB)
      linearPower[idx] = Math.pow(10, (-12 + Math.random() * 5) / 10);
      linearPower[idx + 1] = Math.pow(10, (-13 + Math.random() * 5) / 10);
      linearPower[idx + 2] = Math.pow(10, (-11 + Math.random() * 5) / 10);
    } else {
      // Urban: high backscatter (~-5 to 0 dB)
      linearPower[idx] = Math.pow(10, (-3 + Math.random() * 3) / 10);
      linearPower[idx + 1] = Math.pow(10, (-4 + Math.random() * 3) / 10);
      linearPower[idx + 2] = Math.pow(10, (-2 + Math.random() * 3) / 10);
    }
  }
}

// Step 2: Convert to dB and scale to uint8 (like createRGBTexture does)
console.log('Converting to dB and scaling to uint8 RGBA...');

const dbMin = -25;  // Typical SAR contrast limits
const dbMax = 0;
const rgbaData = new Uint8ClampedArray(width * height * 4);

for (let i = 0; i < width * height; i++) {
  for (let c = 0; c < 3; c++) {
    const linear = linearPower[i * 3 + c];
    const db = 10 * Math.log10(Math.max(linear, 1e-10));
    const normalized = Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)));
    rgbaData[i * 4 + c] = Math.round(normalized * 255);
  }
  rgbaData[i * 4 + 3] = 255; // Alpha
}

const bounds = [500000, 4000000, 502048, 4002048]; // 2km × 2km
const epsgCode = 32610;

console.log(`  Image size: ${width} × ${height}`);
console.log(`  dB range: ${dbMin} to ${dbMax} dB`);
console.log(`  Bounds: [${bounds.join(', ')}]`);
console.log(`  EPSG: ${epsgCode}\n`);

// Test 1: With inverse-dB multilook (SAR-correct)
console.log('=== Test 1: Inverse-dB Multilook (SAR-correct) ===');
try {
  const buffer1 = writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode, {
    generateOverviews: true,
    dbLimits: [dbMin, dbMax],
    useDecibels: true,
    onProgress: (pct) => {
      if (pct % 20 === 0) {
        console.log(`  Progress: ${pct}%`);
      }
    }
  });

  const filename1 = 'test_sar_inverse_db.tif';
  fs.writeFileSync(filename1, Buffer.from(buffer1));
  console.log(`✓ Saved: ${filename1}`);
  console.log(`  Size: ${(buffer1.byteLength / 1024 / 1024).toFixed(2)} MB\n`);
} catch (error) {
  console.error('✗ Error:', error.message);
  console.error(error.stack);
}

// Test 2: Without inverse-dB (simple averaging - should look noisier)
console.log('=== Test 2: Simple uint8 Averaging (reference) ===');
try {
  const buffer2 = writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode, {
    generateOverviews: true,
    dbLimits: null,  // No dB limits = simple averaging
    useDecibels: false,
    onProgress: (pct) => {
      if (pct % 20 === 0) {
        console.log(`  Progress: ${pct}%`);
      }
    }
  });

  const filename2 = 'test_sar_simple_avg.tif';
  fs.writeFileSync(filename2, Buffer.from(buffer2));
  console.log(`✓ Saved: ${filename2}`);
  console.log(`  Size: ${(buffer2.byteLength / 1024 / 1024).toFixed(2)} MB\n`);
} catch (error) {
  console.error('✗ Error:', error.message);
  console.error(error.stack);
}

console.log('=== Comparison ===');
console.log('Open both files in QGIS and compare the overview quality:');
console.log('  1. test_sar_inverse_db.tif - Should have smooth, low-noise overviews');
console.log('  2. test_sar_simple_avg.tif - Overviews may look noisier');
console.log('\nThe inverse-dB method properly averages in linear power space,');
console.log('equivalent to spatial multi-looking in SAR processing.\n');
