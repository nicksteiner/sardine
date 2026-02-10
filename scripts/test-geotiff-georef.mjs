/**
 * Test GeoTIFF Georeferencing
 *
 * Reads a NISAR HDF5 file to extract the actual coordinate boundaries,
 * then writes a small test GeoTIFF using our geotiff-writer and saves it
 * for verification with GDAL (see verify-georef.py).
 *
 * Usage:
 *   node scripts/test-geotiff-georef.mjs [path-to-h5-file]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import h5wasm from 'h5wasm';

// We can't import the ES module geotiff-writer directly in Node,
// so we replicate the minimal GeoTIFF writing logic here for the test.

const TILE_SIZE = 512;

// TIFF tag IDs
const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_PLANAR_CONFIG = 284;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_EXTRA_SAMPLES = 338;
const TAG_SAMPLE_FORMAT = 339;
const TAG_MODEL_TIEPOINT = 33922;
const TAG_MODEL_PIXEL_SCALE = 33550;
const TAG_GEO_KEY_DIRECTORY = 34735;

// TIFF type IDs
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_DOUBLE = 12;

// GeoKey constants
const KEY_GT_MODEL_TYPE = 1024;
const KEY_GT_RASTER_TYPE = 1025;
const KEY_PROJECTED_CS_TYPE = 3072;
const KEY_GEOGRAPHIC_TYPE = 2048;
const MODEL_TYPE_PROJECTED = 1;
const MODEL_TYPE_GEOGRAPHIC = 2;
const RASTER_TYPE_PIXEL_IS_AREA = 1;

// NISAR HDF5 path builder
function nisarPaths(band = 'LSAR', productType = 'GCOV') {
  const base = `/science/${band}/${productType}`;
  return {
    projection: (f) => `${base}/grids/frequency${f}/projection`,
    xCoordinates: (f) => `${base}/grids/frequency${f}/xCoordinates`,
    yCoordinates: (f) => `${base}/grids/frequency${f}/yCoordinates`,
    xCoordinateSpacing: (f) => `${base}/grids/frequency${f}/xCoordinateSpacing`,
    yCoordinateSpacing: (f) => `${base}/grids/frequency${f}/yCoordinateSpacing`,
  };
}

function safeGet(h5file, path) {
  try { return h5file.get(path); } catch { return null; }
}

async function main() {
  const h5Path = process.argv[2] ||
    'test_data/NISAR_L2_PR_GCOV_013_155_D_091_2005_DHDH_A_20251226T231525_20251226T231556_P05006_N_F_J_001.h5';

  console.log(`\n=== GeoTIFF Georeferencing Test ===`);
  console.log(`HDF5 file: ${h5Path}\n`);

  // Initialize h5wasm
  await h5wasm.ready;
  const h5file = new h5wasm.File(h5Path, 'r');

  // Try LSAR and SSAR
  let band = 'LSAR';
  let frequency = 'A';
  let paths = nisarPaths(band);

  // Check if LSAR exists, otherwise try SSAR
  let projDs = safeGet(h5file, paths.projection(frequency));
  if (!projDs) {
    band = 'SSAR';
    paths = nisarPaths(band);
    projDs = safeGet(h5file, paths.projection(frequency));
  }

  // === 1. Extract EPSG code ===
  let epsgCode = 4326;
  if (projDs) {
    const projVal = projDs.value;
    if (typeof projVal === 'number' && projVal > 0) {
      epsgCode = projVal;
    }
  }
  console.log(`EPSG code: ${epsgCode}`);

  // === 2. Extract coordinate arrays ===
  const xCoordsDs = safeGet(h5file, paths.xCoordinates(frequency));
  const yCoordsDs = safeGet(h5file, paths.yCoordinates(frequency));

  if (!xCoordsDs || !yCoordsDs) {
    console.error('ERROR: Could not find xCoordinates/yCoordinates datasets');
    process.exit(1);
  }

  const xCoords = xCoordsDs.value;
  const yCoords = yCoordsDs.value;

  console.log(`\nCoordinate arrays:`);
  console.log(`  xCoordinates: ${xCoords.length} values`);
  console.log(`    first: ${xCoords[0]}`);
  console.log(`    last:  ${xCoords[xCoords.length - 1]}`);
  console.log(`  yCoordinates: ${yCoords.length} values`);
  console.log(`    first: ${yCoords[0]}`);
  console.log(`    last:  ${yCoords[yCoords.length - 1]}`);

  // === 3. Calculate bounds ===
  const minX = Math.min(xCoords[0], xCoords[xCoords.length - 1]);
  const maxX = Math.max(xCoords[0], xCoords[xCoords.length - 1]);
  const minY = Math.min(yCoords[0], yCoords[yCoords.length - 1]);
  const maxY = Math.max(yCoords[0], yCoords[yCoords.length - 1]);
  const bounds = [minX, minY, maxX, maxY];

  const width = xCoords.length;
  const height = yCoords.length;

  console.log(`\nImage dimensions: ${width} x ${height}`);
  console.log(`Bounds [minX, minY, maxX, maxY]: [${bounds.join(', ')}]`);

  // === 4. Pixel spacing ===
  const xSpacingDs = safeGet(h5file, paths.xCoordinateSpacing(frequency));
  const ySpacingDs = safeGet(h5file, paths.yCoordinateSpacing(frequency));
  const xSpacing = xSpacingDs ? xSpacingDs.value : null;
  const ySpacing = ySpacingDs ? ySpacingDs.value : null;

  console.log(`\nNative pixel spacing from HDF5:`);
  console.log(`  xCoordinateSpacing: ${xSpacing}`);
  console.log(`  yCoordinateSpacing: ${ySpacing}`);

  const calcPixelSizeX = (maxX - minX) / (width - 1);
  const calcPixelSizeY = (maxY - minY) / (height - 1);
  console.log(`Calculated pixel size from bounds/(N-1):`);
  console.log(`  pixelSizeX: ${calcPixelSizeX.toFixed(6)}`);
  console.log(`  pixelSizeY: ${calcPixelSizeY.toFixed(6)}`);

  // === 5. What geotiff-writer uses ===
  // geotiff-writer.js line 393-394: pixelScale = (max - min) / width (NOT width-1)
  const writerPixelScaleX = (maxX - minX) / width;
  const writerPixelScaleY = (maxY - minY) / height;
  console.log(`\ngeotiff-writer pixel scale (bounds/dimension):`);
  console.log(`  pixelScaleX: ${writerPixelScaleX.toFixed(6)}`);
  console.log(`  pixelScaleY: ${writerPixelScaleY.toFixed(6)}`);

  // === 6. Expected corner coordinates ===
  console.log(`\n--- Expected GeoTIFF corners ---`);
  console.log(`  Upper-left:  (${minX}, ${maxY})`);
  console.log(`  Upper-right: (${maxX}, ${maxY})`);
  console.log(`  Lower-left:  (${minX}, ${minY})`);
  console.log(`  Lower-right: (${maxX}, ${minY})`);

  // === 7. Write a small test GeoTIFF ===
  // Use a 64x64 pixel test image (solid red with alpha)
  const testWidth = 64;
  const testHeight = 64;
  const testData = new Uint8Array(testWidth * testHeight * 4);
  for (let i = 0; i < testWidth * testHeight; i++) {
    testData[i * 4] = 255;     // R
    testData[i * 4 + 1] = 0;   // G
    testData[i * 4 + 2] = 0;   // B
    testData[i * 4 + 3] = 255; // A
  }

  // Write a minimal (non-COG) GeoTIFF for testing
  const outPath = 'test_data/test_georef.tif';
  const buffer = writeMinimalGeoTIFF(testData, testWidth, testHeight, bounds, epsgCode);
  writeFileSync(outPath, Buffer.from(buffer));

  console.log(`\nWrote test GeoTIFF: ${outPath}`);
  console.log(`  Dimensions: ${testWidth}x${testHeight}`);
  console.log(`  Bounds: [${bounds.join(', ')}]`);
  console.log(`  EPSG: ${epsgCode}`);
  console.log(`  Pixel scale: ${((maxX - minX) / testWidth).toFixed(2)} x ${((maxY - minY) / testHeight).toFixed(2)}`);
  console.log(`\nRun: python scripts/verify-georef.py ${outPath}`);

  h5file.close();
}

/**
 * Write a minimal stripped (non-tiled) GeoTIFF for test purposes.
 * Simpler than the COG writer - just enough to test georeferencing tags.
 */
function writeMinimalGeoTIFF(rgbaData, width, height, bounds, epsgCode) {
  const [minX, minY, maxX, maxY] = bounds;
  const pixelScaleX = (maxX - minX) / width;
  const pixelScaleY = (maxY - minY) / height;

  // Build IFD entries
  const entries = [];

  entries.push({ tag: TAG_IMAGE_WIDTH, type: TYPE_LONG, count: 1, value: width });
  entries.push({ tag: TAG_IMAGE_LENGTH, type: TYPE_LONG, count: 1, value: height });
  entries.push({ tag: TAG_BITS_PER_SAMPLE, type: TYPE_SHORT, count: 4, values: [8, 8, 8, 8] });
  entries.push({ tag: TAG_COMPRESSION, type: TYPE_SHORT, count: 1, value: 1 }); // No compression
  entries.push({ tag: TAG_PHOTOMETRIC, type: TYPE_SHORT, count: 1, value: 2 }); // RGB
  entries.push({ tag: TAG_SAMPLES_PER_PIXEL, type: TYPE_SHORT, count: 1, value: 4 });
  entries.push({ tag: TAG_PLANAR_CONFIG, type: TYPE_SHORT, count: 1, value: 1 }); // Chunky

  // StripOffsets - placeholder
  entries.push({ tag: 273, type: TYPE_LONG, count: 1, value: 0 }); // StripOffsets
  entries.push({ tag: 278, type: TYPE_LONG, count: 1, value: height }); // RowsPerStrip
  entries.push({ tag: 279, type: TYPE_LONG, count: 1, value: width * height * 4 }); // StripByteCounts

  entries.push({ tag: TAG_EXTRA_SAMPLES, type: TYPE_SHORT, count: 1, value: 1 }); // Associated alpha
  entries.push({ tag: TAG_SAMPLE_FORMAT, type: TYPE_SHORT, count: 4, values: [1, 1, 1, 1] });

  // GeoTIFF tags
  entries.push({ tag: TAG_MODEL_TIEPOINT, type: TYPE_DOUBLE, count: 6, values: [0, 0, 0, minX, maxY, 0] });
  entries.push({ tag: TAG_MODEL_PIXEL_SCALE, type: TYPE_DOUBLE, count: 3, values: [pixelScaleX, pixelScaleY, 0] });

  const isGeographic = epsgCode >= 4000 && epsgCode < 5000;
  const modelType = isGeographic ? MODEL_TYPE_GEOGRAPHIC : MODEL_TYPE_PROJECTED;
  const csKeyId = isGeographic ? KEY_GEOGRAPHIC_TYPE : KEY_PROJECTED_CS_TYPE;

  entries.push({
    tag: TAG_GEO_KEY_DIRECTORY, type: TYPE_SHORT, count: 16, values: [
      1, 1, 0, 3,
      KEY_GT_MODEL_TYPE, 0, 1, modelType,
      KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA,
      csKeyId, 0, 1, epsgCode,
    ]
  });

  // Sort entries by tag
  entries.sort((a, b) => a.tag - b.tag);

  // Calculate sizes
  const numEntries = entries.length;
  const headerSize = 8;
  const ifdSize = 2 + numEntries * 12 + 4;

  // Calculate overflow data sizes
  let overflowSize = 0;
  for (const entry of entries) {
    const byteSize = getByteSize(entry);
    if (byteSize > 4) {
      entry.needsOverflow = true;
      entry.overflowBytes = byteSize;
      overflowSize += byteSize;
      if (overflowSize % 2 !== 0) overflowSize++;
    }
  }

  const ifdOffset = headerSize;
  const overflowOffset = ifdOffset + ifdSize;
  const stripOffset = overflowOffset + overflowSize;
  const stripSize = width * height * 4;
  const totalSize = stripOffset + stripSize;

  // Allocate buffer
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Write TIFF header (Little-endian)
  view.setUint16(0, 0x4949, true); // II = Little endian
  view.setUint16(2, 42, true);     // Magic
  view.setUint32(4, ifdOffset, true); // First IFD offset

  // Write IFD
  let pos = ifdOffset;
  view.setUint16(pos, numEntries, true); pos += 2;

  // Fix StripOffsets value
  for (const entry of entries) {
    if (entry.tag === 273) entry.value = stripOffset;
  }

  let curOverflow = overflowOffset;

  for (const entry of entries) {
    view.setUint16(pos, entry.tag, true); pos += 2;
    view.setUint16(pos, entry.type, true); pos += 2;
    view.setUint32(pos, entry.count, true); pos += 4;

    if (entry.needsOverflow) {
      view.setUint32(pos, curOverflow, true); pos += 4;
      // Write overflow data
      writeValues(view, curOverflow, entry);
      curOverflow += entry.overflowBytes;
      if (curOverflow % 2 !== 0) curOverflow++;
    } else if (entry.count === 1) {
      // Single value fits in 4 bytes
      if (entry.type === TYPE_SHORT) {
        view.setUint16(pos, entry.value, true);
        pos += 4;
      } else if (entry.type === TYPE_LONG) {
        view.setUint32(pos, entry.value, true);
        pos += 4;
      }
    } else {
      // Multiple small values fit in 4 bytes
      let vPos = pos;
      for (const v of entry.values) {
        if (entry.type === TYPE_SHORT) {
          view.setUint16(vPos, v, true);
          vPos += 2;
        }
      }
      pos += 4;
    }
  }

  // Next IFD pointer (0 = no more IFDs)
  view.setUint32(pos, 0, true);

  // Write strip data (RGBA pixels)
  bytes.set(rgbaData, stripOffset);

  return buffer;
}

function getByteSize(entry) {
  const typeSize = { [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_DOUBLE]: 8 };
  return (typeSize[entry.type] || 1) * entry.count;
}

function writeValues(view, offset, entry) {
  let pos = offset;
  const values = entry.values || [entry.value];
  for (const v of values) {
    if (entry.type === TYPE_SHORT) {
      view.setUint16(pos, v, true); pos += 2;
    } else if (entry.type === TYPE_LONG) {
      view.setUint32(pos, v, true); pos += 4;
    } else if (entry.type === TYPE_DOUBLE) {
      view.setFloat64(pos, v, true); pos += 8;
    }
  }
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
