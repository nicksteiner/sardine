/**
 * Validate COG structure manually
 */

import fs from 'fs';

const filename = 'test_output_cog.tif';
console.log(`Validating: ${filename}\n`);

const buffer = fs.readFileSync(filename);
const view = new DataView(buffer.buffer);

// Read TIFF header
const byteOrder = view.getUint16(0, true);
const magic = view.getUint16(2, true);
let ifdOffset = view.getUint32(4, true);

console.log('=== TIFF Header ===');
console.log(`Byte order: ${byteOrder === 0x4949 ? 'Little-endian (0x4949)' : 'Big-endian (0x4d4d)'}`);
console.log(`Magic: ${magic} (should be 42)`);
console.log(`First IFD offset: ${ifdOffset}\n`);

// TIFF tag names
const tagNames = {
  254: 'NewSubfileType',
  256: 'ImageWidth',
  257: 'ImageLength',
  258: 'BitsPerSample',
  259: 'Compression',
  262: 'PhotometricInterpretation',
  277: 'SamplesPerPixel',
  284: 'PlanarConfiguration',
  317: 'Predictor',
  322: 'TileWidth',
  323: 'TileLength',
  324: 'TileOffsets',
  325: 'TileByteCounts',
  338: 'ExtraSamples',
  339: 'SampleFormat',
  33550: 'ModelPixelScale',
  33922: 'ModelTiepoint',
  34735: 'GeoKeyDirectory',
};

const compressionNames = {
  1: 'None',
  5: 'LZW',
  8: 'DEFLATE',
  32946: 'DEFLATE (alternate)',
};

// Read IFDs
let ifdNum = 0;
const ifds = [];

while (ifdOffset !== 0) {
  console.log(`=== IFD ${ifdNum} (offset: ${ifdOffset}) ===`);

  const numEntries = view.getUint16(ifdOffset, true);
  console.log(`Entries: ${numEntries}`);

  const ifdData = { entries: {}, numEntries };
  let pos = ifdOffset + 2;

  for (let i = 0; i < numEntries; i++) {
    const tag = view.getUint16(pos, true);
    const type = view.getUint16(pos + 2, true);
    const count = view.getUint32(pos + 4, true);
    const valueOffset = view.getUint32(pos + 8, true);

    const tagName = tagNames[tag] || `Tag${tag}`;

    // Decode value
    let value = null;
    if (type === 3 && count === 1) { // SHORT
      value = view.getUint16(pos + 8, true);
    } else if (type === 4 && count === 1) { // LONG
      value = valueOffset;
    } else if (tag === 324 || tag === 325) { // TileOffsets/TileByteCounts
      value = `array[${count}]`;
    } else if (count <= 4) {
      value = `...`;
    } else {
      value = `offset:${valueOffset}, count:${count}`;
    }

    ifdData.entries[tag] = { tag, tagName, type, count, value };

    pos += 12;
  }

  const nextIFDOffset = view.getUint32(pos, true);
  console.log(`Next IFD: ${nextIFDOffset === 0 ? 'none' : nextIFDOffset}`);

  // Print key tags
  const keyTags = [256, 257, 258, 259, 277, 322, 323, 324, 325, 338, 33550, 33922, 34735];
  console.log('\nKey tags:');
  for (const tag of keyTags) {
    const entry = ifdData.entries[tag];
    if (entry) {
      const tagName = entry.tagName.padEnd(30);
      let displayValue = entry.value;

      // Special formatting for compression
      if (tag === 259) {
        displayValue = `${entry.value} (${compressionNames[entry.value] || 'Unknown'})`;
      }

      console.log(`  ${tagName}: ${displayValue}`);
    }
  }

  ifds.push(ifdData);
  ifdOffset = nextIFDOffset;
  ifdNum++;
  console.log('');
}

// Summary
console.log('=== Summary ===');
console.log(`Total IFDs: ${ifds.length}`);
const width0 = ifds[0].entries[256] && ifds[0].entries[256].value;
const height0 = ifds[0].entries[257] && ifds[0].entries[257].value;
console.log(`Full resolution: ${width0} × ${height0}`);

if (ifds.length > 1) {
  console.log('Overviews:');
  for (let i = 1; i < ifds.length; i++) {
    const width = ifds[i].entries[256] && ifds[i].entries[256].value;
    const height = ifds[i].entries[257] && ifds[i].entries[257].value;
    const scale = Math.pow(2, i);
    console.log(`  Level ${i}: ${width} × ${height} (${scale}× downsample)`);
  }
}

const compression = ifds[0].entries[259] && ifds[0].entries[259].value;
console.log(`\nCompression: ${compressionNames[compression] || compression}`);

const samplesPerPixel = ifds[0].entries[277] && ifds[0].entries[277].value;
console.log(`Samples per pixel: ${samplesPerPixel}`);

const tileWidth = ifds[0].entries[322] && ifds[0].entries[322].value;
const tileLength = ifds[0].entries[323] && ifds[0].entries[323].value;
console.log(`Tile size: ${tileWidth} × ${tileLength}`);

const hasGeo = ifds[0].entries[33550] || ifds[0].entries[33922];
console.log(`Georeferencing: ${hasGeo ? 'Yes ✓' : 'No ✗'}`);

const extraSamples = ifds[0].entries[338];
console.log(`Extra samples (alpha): ${extraSamples ? 'Yes ✓' : 'No ✗'}`);

console.log('\n=== Validation ===');
const checks = [
  { name: 'Is valid TIFF', pass: magic === 42 },
  { name: 'Has tiling', pass: tileWidth && tileLength },
  { name: 'Tile size is 512×512', pass: tileWidth === 512 && tileLength === 512 },
  { name: 'Has compression', pass: compression === 8 },
  { name: 'Is RGBA (4 bands)', pass: samplesPerPixel === 4 },
  { name: 'Has alpha channel', pass: !!extraSamples },
  { name: 'Has overviews', pass: ifds.length > 1 },
  { name: 'Has georeferencing', pass: !!hasGeo },
];

let passCount = 0;
for (const check of checks) {
  const status = check.pass ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${status}: ${check.name}`);
  if (check.pass) passCount++;
}

console.log(`\nResult: ${passCount}/${checks.length} checks passed`);

if (passCount === checks.length) {
  console.log('\n🎉 This is a valid Cloud Optimized GeoTIFF!\n');
} else {
  console.log('\n⚠️  Some validation checks failed.\n');
}
