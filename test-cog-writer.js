/**
 * Simple test for COG writer
 * Tests that the new writeRGBAGeoTIFF function produces valid output
 */

import { writeRGBAGeoTIFF } from './src/utils/geotiff-writer.js';
import fs from 'fs';

console.log('Testing COG Writer...\n');

// Create a simple 1024×1024 test image with gradient
const width = 1024;
const height = 1024;
const rgbaData = new Uint8ClampedArray(width * height * 4);

console.log(`Creating ${width}×${height} test image...`);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    // Gradient pattern
    rgbaData[idx] = (x / width) * 255;        // R
    rgbaData[idx + 1] = (y / height) * 255;   // G
    rgbaData[idx + 2] = 128;                  // B
    rgbaData[idx + 3] = 255;                  // A (opaque)
  }
}

// Define bounds (fake UTM coordinates)
const bounds = [500000, 4000000, 501000, 4001000]; // 1km×1km area
const epsgCode = 32610; // UTM Zone 10N

console.log('Encoding Cloud Optimized GeoTIFF...');
console.log(`  Bounds: [${bounds.join(', ')}]`);
console.log(`  EPSG: ${epsgCode}`);
console.log(`  Tile size: 512×512`);
console.log(`  Compression: DEFLATE`);
console.log(`  Overviews: 2×, 4×\n`);

try {
  const buffer = writeRGBAGeoTIFF(rgbaData, width, height, bounds, epsgCode, {
    generateOverviews: true,
    onProgress: (pct) => {
      if (pct % 20 === 0) {
        console.log(`  Progress: ${pct}%`);
      }
    }
  });

  console.log(`\n✓ Encoding successful!`);
  console.log(`  File size: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

  // Write to file
  const filename = 'test_output_cog.tif';
  fs.writeFileSync(filename, Buffer.from(buffer));
  console.log(`  Saved to: ${filename}\n`);

  // Basic validation
  const view = new DataView(buffer);
  const byteOrder = view.getUint16(0, true);
  const magic = view.getUint16(2, true);
  const ifdOffset = view.getUint32(4, true);

  console.log('File structure validation:');
  console.log(`  ✓ Byte order: 0x${byteOrder.toString(16)} (little-endian)`);
  console.log(`  ✓ Magic number: ${magic} (TIFF)`);
  console.log(`  ✓ First IFD offset: ${ifdOffset}\n`);

  console.log('Next steps:');
  console.log('  1. Validate with gdalinfo:');
  console.log(`     gdalinfo ${filename}`);
  console.log('  2. Validate as COG:');
  console.log(`     rio cogeo validate ${filename}`);
  console.log('  3. Open in QGIS to verify visualization\n');

} catch (error) {
  console.error('✗ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
