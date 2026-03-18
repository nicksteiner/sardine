#!/usr/bin/env node
/**
 * Tests for src/utils/png-state.js
 *
 * Covers:
 *   - embedStateInPNG inserts a valid tEXt chunk
 *   - extractStateFromPNG reads it back (round-trip)
 *   - All state fields survive serialization
 *   - extractStateFromPNG returns null for a PNG with no state
 *   - extractStateFromPNG returns null for a non-PNG file
 *   - Multiple round-trips keep the last-written state
 *   - Large state payload embeds and extracts correctly
 *   - PNG signature and IHDR position are preserved after embed
 */

import { embedStateInPNG, extractStateFromPNG } from '../src/utils/png-state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label || 'Value'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertDeepEqual(a, b, label) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${label || 'Deep equal'} mismatch:\n  got:      ${sa}\n  expected: ${sb}`);
}

// ── Minimal valid 1×1 grayscale PNG ─────────────────────────────────────────
//
// Constructed manually so there is no external dependency.
// Structure: signature(8) + IHDR(25) + IDAT(~20) + IEND(12)

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(type);
  const dataBytes = data instanceof Uint8Array ? data : enc.encode(data);
  const buf = new Uint8Array(4 + 4 + dataBytes.length + 4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, dataBytes.length, false);
  buf.set(typeBytes, 4);
  buf.set(dataBytes, 8);
  const typeAndData = new Uint8Array(4 + dataBytes.length);
  typeAndData.set(typeBytes, 0);
  typeAndData.set(dataBytes, 4);
  view.setUint32(8 + dataBytes.length, crc32(typeAndData), false);
  return buf;
}

function buildMinimalPNG() {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: 1×1, 8-bit grayscale (colortype=0)
  const ihdrData = new Uint8Array([
    0, 0, 0, 1,  // width = 1
    0, 0, 0, 1,  // height = 1
    8,           // bit depth
    0,           // color type: grayscale
    0, 0, 0,     // compression, filter, interlace
  ]);
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT: zlib-compressed single 0x00 (filter) + 0x80 (pixel=128)
  // Minimal valid zlib: CMF=0x78 FLEVEL=0x01 (deflate, default compression)
  // then deflated block: BFINAL=1, BTYPE=00 (no compression), LEN=2, NLEN=~2, data
  const idatData = new Uint8Array([
    0x78, 0x01,              // zlib header
    0x62, 0x60, 0x80, 0x00, // deflate: fixed huffman, filter=0, pixel=128 (simplified)
    0x00, 0x00, 0x00, 0x02, // adler32 checksum (approximate - real decoders may vary)
    0x00, 0x01,
  ]);
  const idat = makeChunk('IDAT', idatData);

  const iend = makeChunk('IEND', new Uint8Array(0));

  const total = sig.length + ihdr.length + idat.length + iend.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const part of [sig, ihdr, idat, iend]) {
    png.set(part, off);
    off += part.length;
  }
  return png;
}

const MINIMAL_PNG = buildMinimalPNG();

function makePNGBlob() {
  return new Blob([MINIMAL_PNG], { type: 'image/png' });
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n━━━ PNG State: embed / extract ━━━');

const SAMPLE_STATE = {
  colormap: 'viridis',
  useDecibels: true,
  contrastMin: -25,
  contrastMax: 0,
  gamma: 1.2,
  stretchMode: 'sqrt',
  displayMode: 'single',
  compositeId: null,
  rgbContrastLimits: null,
  selectedFrequency: 'A',
  selectedPolarization: 'HHHH',
  multiLook: false,
  speckleFilterType: 'lee',
  maskInvalid: true,
  fileType: 'nisar',
  viewCenter: [-118.5, 34.2],
  viewZoom: 7,
  filename: 'NISAR_L2_GCOV_test.h5',
};

await check('round-trip: extracted state matches embedded state', async () => {
  const blob = makePNGBlob();
  const embedded = await embedStateInPNG(blob, SAMPLE_STATE);
  const extracted = await extractStateFromPNG(embedded);
  assert(extracted !== null, 'extractStateFromPNG should return an object');

  for (const [k, v] of Object.entries(SAMPLE_STATE)) {
    assertDeepEqual(extracted[k], v, `field "${k}"`);
  }
});

await check('extracted state includes _v version marker', async () => {
  const blob = makePNGBlob();
  const embedded = await embedStateInPNG(blob, SAMPLE_STATE);
  const extracted = await extractStateFromPNG(embedded);
  assertEqual(extracted._v, 1, '_v version');
});

await check('PNG signature preserved after embed', async () => {
  const blob = makePNGBlob();
  const embedded = await embedStateInPNG(blob, SAMPLE_STATE);
  const buf = await embedded.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    assertEqual(bytes[i], PNG_SIG[i], `signature byte ${i}`);
  }
});

await check('IHDR chunk is still at offset 8 after embed', async () => {
  const blob = makePNGBlob();
  const embedded = await embedStateInPNG(blob, SAMPLE_STATE);
  const buf = await embedded.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  // IHDR length should be 13
  assertEqual(view.getUint32(8, false), 13, 'IHDR length');
  // IHDR type bytes
  const dec = new TextDecoder();
  assertEqual(dec.decode(bytes.subarray(12, 16)), 'IHDR', 'IHDR type');
});

await check('output size increases by chunk size after embed', async () => {
  const blob = makePNGBlob();
  const embedded = await embedStateInPNG(blob, SAMPLE_STATE);
  const origSize = MINIMAL_PNG.byteLength;
  const newSize = (await embedded.arrayBuffer()).byteLength;
  // Chunk overhead is 4+4+4=12 bytes plus the tEXt data length
  assert(newSize > origSize, 'embedded PNG should be larger');
  assert(newSize < origSize + 10000, 'size growth should be bounded');
});

await check('extractStateFromPNG returns null for PNG with no state', async () => {
  const blob = makePNGBlob();
  const result = await extractStateFromPNG(blob);
  assertEqual(result, null, 'result for plain PNG');
});

await check('extractStateFromPNG returns null for non-PNG file', async () => {
  const notPNG = new Blob(['this is not a PNG'], { type: 'text/plain' });
  const result = await extractStateFromPNG(notPNG);
  assertEqual(result, null, 'result for non-PNG');
});

await check('extractStateFromPNG returns null for empty file', async () => {
  const empty = new Blob([]);
  const result = await extractStateFromPNG(empty);
  assertEqual(result, null, 'result for empty file');
});

await check('extractStateFromPNG returns null for truncated PNG (only signature)', async () => {
  const truncated = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]);
  const result = await extractStateFromPNG(truncated);
  assertEqual(result, null, 'result for truncated PNG');
});

await check('string field values survive round-trip', async () => {
  const state = { colormap: 'inferno', stretchMode: 'gamma', filename: 'test file with spaces & chars!.h5' };
  const embedded = await embedStateInPNG(makePNGBlob(), state);
  const extracted = await extractStateFromPNG(embedded);
  assertEqual(extracted.colormap, state.colormap, 'colormap');
  assertEqual(extracted.stretchMode, state.stretchMode, 'stretchMode');
  assertEqual(extracted.filename, state.filename, 'filename');
});

await check('numeric field values survive round-trip', async () => {
  const state = { contrastMin: -40.5, contrastMax: 3.14159, gamma: 0.7, viewZoom: 12 };
  const embedded = await embedStateInPNG(makePNGBlob(), state);
  const extracted = await extractStateFromPNG(embedded);
  assertEqual(extracted.contrastMin, state.contrastMin, 'contrastMin');
  assertEqual(extracted.contrastMax, state.contrastMax, 'contrastMax');
  assertEqual(extracted.gamma, state.gamma, 'gamma');
  assertEqual(extracted.viewZoom, state.viewZoom, 'viewZoom');
});

await check('null and boolean fields survive round-trip', async () => {
  const state = { compositeId: null, useDecibels: false, maskInvalid: true, multiLook: false };
  const embedded = await embedStateInPNG(makePNGBlob(), state);
  const extracted = await extractStateFromPNG(embedded);
  assertEqual(extracted.compositeId, null, 'compositeId null');
  assertEqual(extracted.useDecibels, false, 'useDecibels false');
  assertEqual(extracted.maskInvalid, true, 'maskInvalid true');
  assertEqual(extracted.multiLook, false, 'multiLook false');
});

await check('array fields survive round-trip', async () => {
  const state = { viewCenter: [-118.5, 34.2], rgbContrastLimits: { R: [-20, 0], G: [-25, -5], B: [-18, 2] } };
  const embedded = await embedStateInPNG(makePNGBlob(), state);
  const extracted = await extractStateFromPNG(embedded);
  assertDeepEqual(extracted.viewCenter, state.viewCenter, 'viewCenter');
  assertDeepEqual(extracted.rgbContrastLimits, state.rgbContrastLimits, 'rgbContrastLimits');
});

await check('large state payload (1KB JSON) embeds and extracts', async () => {
  const largeState = {
    colormap: 'plasma',
    notes: 'x'.repeat(800),
    contrastMin: -30,
    contrastMax: 5,
  };
  const embedded = await embedStateInPNG(makePNGBlob(), largeState);
  const extracted = await extractStateFromPNG(embedded);
  assertEqual(extracted.colormap, largeState.colormap, 'colormap');
  assertEqual(extracted.notes.length, 800, 'notes length');
  assertEqual(extracted.contrastMin, largeState.contrastMin, 'contrastMin');
});

await check('second embed overwrites: last state wins in extraction', async () => {
  // Two sequential embeds — the first tEXt chunk (closer to start) is found first,
  // so only one extraction is expected. But users should only embed once per export.
  // This test documents the current behavior: first chunk wins.
  const state1 = { colormap: 'viridis', contrastMin: -20 };
  const state2 = { colormap: 'inferno', contrastMin: -35 };
  const once = await embedStateInPNG(makePNGBlob(), state1);
  const twice = await embedStateInPNG(once, state2);
  const extracted = await extractStateFromPNG(twice);
  // state2 is inserted closer to IHDR (offset 33), so it is encountered first
  assertEqual(extracted.colormap, state2.colormap, 'second embed is found first');
  assertEqual(extracted.contrastMin, state2.contrastMin, 'contrastMin from second embed');
});

await check('embedStateInPNG rejects a non-PNG blob', async () => {
  const notPNG = new Blob(['not a png'], { type: 'image/png' });
  let threw = false;
  try {
    await embedStateInPNG(notPNG, { colormap: 'viridis' });
  } catch {
    threw = true;
  }
  assert(threw, 'embedStateInPNG should throw for non-PNG data');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
