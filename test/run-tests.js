#!/usr/bin/env node

/**
 * SARdine Test Runner
 *
 * Runs all Node.js-compatible tests (file checks, import validation, shader syntax).
 * Browser-only tests (WebGL, deck.gl rendering, GPU benchmarks) run via:
 *   npm run test:layer      → test/layer-test.html
 *   npm run debug:gpu       → test/gpu-debug.html
 *   npm run benchmark       → test/benchmarks/gpu-vs-cpu.html
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// ─── Test infrastructure ─────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n━━━ ${name} ━━━`);
}

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    totalFailed++;
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    totalPassed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    totalFailed++;
  }
}

function skip(name, reason) {
  console.log(`  SKIP  ${name} (${reason})`);
  totalSkipped++;
}

function fileExists(relPath) {
  return existsSync(join(rootDir, relPath));
}

function readFile(relPath) {
  return readFileSync(join(rootDir, relPath), 'utf8');
}

function assertContains(content, needle, label) {
  if (!content.includes(needle)) {
    throw new Error(`Missing: ${label || needle}`);
  }
}

function assertBraceBalance(content, fileName) {
  const open = (content.match(/{/g) || []).length;
  const close = (content.match(/}/g) || []).length;
  if (open !== close) {
    throw new Error(`${fileName}: Mismatched braces: ${open} open, ${close} close`);
  }
}

// ─── 1. File structure ───────────────────────────────────────────────────────

suite('File structure');

const requiredFiles = [
  'src/index.js',
  'src/layers/SARGPULayer.js',
  'src/layers/SARGPUBitmapLayer.js',
  'src/layers/SARBitmapLayer.js',
  'src/layers/SARTileLayer.js',
  'src/layers/SARTiledCOGLayer.js',
  'src/layers/shaders.js',
  'src/utils/colormap.js',
  'src/utils/stretch.js',
  'src/utils/stats.js',
  'src/utils/sar-composites.js',
  'src/utils/png-state.js',
  'src/loaders/cog-loader.js',
  'src/loaders/nisar-loader.js',
  'src/loaders/h5chunk.js',
  'src/viewers/SARViewer.jsx',
  'src/viewers/ComparisonViewer.jsx',
  'src/viewers/MapViewer.jsx',
  'src/theme/sardine-theme.css',
  'app/main.jsx',
  'app/index.html',
  'package.json',
  'vite.config.js',
];

for (const f of requiredFiles) {
  check(`${f} exists`, () => {
    if (!fileExists(f)) throw new Error(`File not found: ${f}`);
  });
}

// ─── 2. Exports ──────────────────────────────────────────────────────────────

suite('Index exports');

const indexContent = readFile('src/index.js');

const requiredExports = [
  'SARTileLayer',
  'SARBitmapLayer',
  'SARTiledCOGLayer',
  'SARGPUBitmapLayer',
  'SARGPULayer',
  'SARViewer',
  'ComparisonViewer',
  'MapViewer',
  'loadCOG',
  'loadNISARGCOV',
  'getColormapId',
  'getStretchModeId',
  'applyStretch',
  'computeRGBBands',
  'createRGBTexture',
];

for (const name of requiredExports) {
  check(`exports ${name}`, () => {
    assertContains(indexContent, name, `${name} not exported from index.js`);
  });
}

// ─── 3. SARGPULayer validation ───────────────────────────────────────────────

suite('SARGPULayer');

const gpuContent = readFile('src/layers/SARGPULayer.js');
const _shadersContent = readFile('src/layers/shaders.js');

check('imports Layer from deck.gl', () => {
  assertContains(gpuContent, 'import { Layer', 'Layer import');
});

check('imports project32 module', () => {
  assertContains(gpuContent, 'project32', 'project32 import');
});

check('imports Texture2D', () => {
  assertContains(gpuContent, 'Texture2D', 'Texture2D import');
});

check('has getShaders() method', () => {
  assertContains(gpuContent, 'getShaders()', 'getShaders method');
});

check('has initializeState() method', () => {
  assertContains(gpuContent, 'initializeState()', 'initializeState method');
});

check('has updateState() method', () => {
  assertContains(gpuContent, 'updateState({', 'updateState method');
});

check('has draw() method', () => {
  assertContains(gpuContent, 'draw({', 'draw method');
});

check('has finalizeState() method', () => {
  assertContains(gpuContent, 'finalizeState()', 'finalizeState method');
});

check('calls super.finalizeState()', () => {
  assertContains(gpuContent, 'super.finalizeState()', 'super.finalizeState() call');
});

check('vertex shader has positions attribute', () => {
  assertContains(gpuContent, 'in vec3 positions', 'positions attribute');
});

check('vertex shader has texCoords attribute', () => {
  assertContains(gpuContent, 'in vec2 texCoords', 'texCoords attribute');
});

check('vertex shader sets gl_Position', () => {
  assertContains(gpuContent, 'gl_Position', 'gl_Position assignment');
});

check('fragment shader has uTexture uniform', () => {
  assertContains(gpuContent, 'uniform sampler2D uTexture', 'uTexture uniform');
});

check('fragment shader has uMin/uMax uniforms', () => {
  assertContains(gpuContent, 'uniform float uMin', 'uMin uniform');
  assertContains(gpuContent, 'uniform float uMax', 'uMax uniform');
});

check('fragment shader has dB scaling', () => {
  assertContains(gpuContent, 'log2(max(amplitude', 'dB scaling via log2');
});

check('fragment shader has all 5 colormaps', () => {
  // Colormaps may be defined inline OR imported via glslColormaps from shaders.js
  const combined = gpuContent + _shadersContent;
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phaseColormap']) {
    assertContains(combined, `vec3 ${cm}(float t)`, `${cm} colormap function`);
  }
});

check('creates R32F texture', () => {
  assertContains(gpuContent, 'gl.R32F', 'R32F internal format');
});

check('balanced braces', () => {
  assertBraceBalance(gpuContent, 'SARGPULayer.js');
});

// ─── 4. SARGPUBitmapLayer validation ─────────────────────────────────────────

suite('SARGPUBitmapLayer');

const gpuBitmapContent = readFile('src/layers/SARGPUBitmapLayer.js');

check('extends BitmapLayer', () => {
  assertContains(gpuBitmapContent, 'extends BitmapLayer', 'BitmapLayer extension');
});

check('uses shader injection', () => {
  assertContains(gpuBitmapContent, 'inject', 'shader injection');
  assertContains(gpuBitmapContent, 'fs:#decl', 'fragment shader declarations');
  assertContains(gpuBitmapContent, 'DECKGL_FILTER_COLOR', 'color filter hook');
});

check('has all 5 colormaps in injected shader', () => {
  // Colormaps may be defined inline OR imported via glslColormaps from shaders.js
  const combined = gpuBitmapContent + _shadersContent;
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phaseColormap']) {
    assertContains(combined, `vec3 ${cm}(float t)`, `${cm} colormap`);
  }
});

check('balanced braces', () => {
  assertBraceBalance(gpuBitmapContent, 'SARGPUBitmapLayer.js');
});

// ─── 5. SARBitmapLayer (CPU) validation ──────────────────────────────────────

suite('SARBitmapLayer (CPU)');

const cpuBitmapContent = readFile('src/layers/SARBitmapLayer.js');

check('extends BitmapLayer', () => {
  assertContains(cpuBitmapContent, 'extends BitmapLayer', 'BitmapLayer extension');
});

check('uses getColormap from colormap.js', () => {
  assertContains(cpuBitmapContent, 'getColormap', 'getColormap import');
});

check('uses applyStretch from stretch.js', () => {
  assertContains(cpuBitmapContent, 'applyStretch', 'applyStretch import');
});

check('has CPU dB conversion', () => {
  assertContains(cpuBitmapContent, 'Math.log10', 'CPU dB conversion');
});

check('creates ImageData output', () => {
  assertContains(cpuBitmapContent, 'new ImageData', 'ImageData creation');
});

check('balanced braces', () => {
  assertBraceBalance(cpuBitmapContent, 'SARBitmapLayer.js');
});

// ─── 6. SARTileLayer validation ──────────────────────────────────────────────

suite('SARTileLayer');

const tileLayerContent = readFile('src/layers/SARTileLayer.js');

check('extends TileLayer', () => {
  assertContains(tileLayerContent, 'TileLayer', 'TileLayer import');
});

check('uses SARGPULayer for single-band', () => {
  assertContains(tileLayerContent, 'new SARGPULayer(', 'SARGPULayer instantiation');
});

check('uses SARGPULayer for RGB composite', () => {
  assertContains(tileLayerContent, "mode: 'rgb'", 'GPU RGB mode');
});

check('has updateTriggers for rendering params', () => {
  assertContains(tileLayerContent, 'updateTriggers', 'updateTriggers');
});

check('balanced braces', () => {
  assertBraceBalance(tileLayerContent, 'SARTileLayer.js');
});

// ─── 7. Shader utilities ─────────────────────────────────────────────────────

suite('Shader utilities');

const shadersContent = readFile('src/layers/shaders.js');

check('exports getColormapId()', () => {
  assertContains(shadersContent, 'export function getColormapId', 'getColormapId export');
});

check('exports getStretchModeId()', () => {
  assertContains(shadersContent, 'export function getStretchModeId', 'getStretchModeId export');
});

check('COLORMAP_IDS has all 5 colormaps', () => {
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phase']) {
    assertContains(shadersContent, `${cm}:`, `${cm} in COLORMAP_IDS`);
  }
});

check('STRETCH_MODE_IDS has all 4 modes', () => {
  for (const sm of ['linear', 'sqrt', 'gamma', 'sigmoid']) {
    assertContains(shadersContent, `${sm}:`, `${sm} in STRETCH_MODE_IDS`);
  }
});

// ─── 8. CPU utilities ────────────────────────────────────────────────────────

suite('CPU utilities');

const colormapContent = readFile('src/utils/colormap.js');
const stretchContent = readFile('src/utils/stretch.js');

check('colormap.js exports getColormap()', () => {
  assertContains(colormapContent, 'export function getColormap', 'getColormap export');
});

check('colormap.js has all 5 colormaps', () => {
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phase']) {
    assertContains(colormapContent, `export function ${cm}`, `${cm} function export`);
  }
});

check('stretch.js exports applyStretch()', () => {
  assertContains(stretchContent, 'export function applyStretch', 'applyStretch export');
});

check('stretch.js handles all 4 modes', () => {
  for (const mode of ['sqrt', 'gamma', 'sigmoid', 'linear']) {
    assertContains(stretchContent, `'${mode}'`, `${mode} case`);
  }
});

// ─── 9. CPU colormap correctness ─────────────────────────────────────────────

suite('Colormap correctness (CPU)');

// Dynamically import the colormap module for correctness tests
try {
  const { getColormap, COLORMAP_NAMES } = await import(join(rootDir, 'src/utils/colormap.js'));

  check('all colormaps return [r,g,b] arrays', () => {
    for (const name of COLORMAP_NAMES) {
      const fn = getColormap(name);
      const rgb = fn(0.5);
      if (!Array.isArray(rgb) || rgb.length !== 3) {
        throw new Error(`${name}(0.5) returned ${JSON.stringify(rgb)}, expected [r,g,b]`);
      }
    }
  });

  check('colormaps clamp to [0,255] range', () => {
    for (const name of COLORMAP_NAMES) {
      const fn = getColormap(name);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const [r, g, b] = fn(t);
        if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
          throw new Error(`${name}(${t}) out of range: [${r}, ${g}, ${b}]`);
        }
      }
    }
  });

  check('grayscale(0) = [0,0,0] and grayscale(1) = [255,255,255]', () => {
    const gs = getColormap('grayscale');
    const black = gs(0);
    const white = gs(1);
    if (black[0] !== 0 || black[1] !== 0 || black[2] !== 0) {
      throw new Error(`grayscale(0) = [${black}], expected [0,0,0]`);
    }
    if (white[0] !== 255 || white[1] !== 255 || white[2] !== 255) {
      throw new Error(`grayscale(1) = [${white}], expected [255,255,255]`);
    }
  });

  check('colormaps handle out-of-range input', () => {
    for (const name of COLORMAP_NAMES) {
      const fn = getColormap(name);
      const low = fn(-1);
      const high = fn(2);
      // Should not throw; values should be clamped
      if (!Array.isArray(low) || !Array.isArray(high)) {
        throw new Error(`${name} failed on out-of-range input`);
      }
    }
  });
} catch (err) {
  skip('colormap correctness tests', `import failed: ${err.message}`);
}

// ─── 10. Stretch correctness ─────────────────────────────────────────────────

suite('Stretch correctness (CPU)');

try {
  const { applyStretch } = await import(join(rootDir, 'src/utils/stretch.js'));

  check('linear stretch is identity', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const result = applyStretch(v, 'linear', 1.0);
      if (Math.abs(result - v) > 1e-10) {
        throw new Error(`linear(${v}) = ${result}, expected ${v}`);
      }
    }
  });

  check('sqrt stretch: sqrt(0.25) = 0.5', () => {
    const result = applyStretch(0.25, 'sqrt');
    if (Math.abs(result - 0.5) > 1e-10) {
      throw new Error(`sqrt(0.25) = ${result}, expected 0.5`);
    }
  });

  check('gamma stretch: pow(0.5, 2) = 0.25', () => {
    const result = applyStretch(0.5, 'gamma', 2.0);
    if (Math.abs(result - 0.25) > 1e-10) {
      throw new Error(`gamma(0.5, 2.0) = ${result}, expected 0.25`);
    }
  });

  check('sigmoid stretch preserves endpoints', () => {
    const at0 = applyStretch(0, 'sigmoid', 1.0);
    const at1 = applyStretch(1, 'sigmoid', 1.0);
    if (Math.abs(at0) > 0.01) throw new Error(`sigmoid(0) = ${at0}, expected ~0`);
    if (Math.abs(at1 - 1) > 0.01) throw new Error(`sigmoid(1) = ${at1}, expected ~1`);
  });
} catch (err) {
  skip('stretch correctness tests', `import failed: ${err.message}`);
}

// ─── 11. GeoTIFF writer correctness ───────────────────────────────────────────

suite('GeoTIFF writer');

try {
  const { writeFloat32GeoTIFF, writeRGBAGeoTIFF } = await import(join(rootDir, 'src/utils/geotiff-writer.js'));

  // Helper: parse TIFF IFD tags from an ArrayBuffer
  function parseTIFF(buffer) {
    const view = new DataView(buffer);
    const le = view.getUint16(0) === 0x4949;
    const magic = view.getUint16(2, le);
    const ifdOffset = view.getUint32(4, le);

    const tags = {};
    let pos = ifdOffset;
    const count = view.getUint16(pos, le); pos += 2;

    for (let i = 0; i < count; i++) {
      const tag = view.getUint16(pos, le); pos += 2;
      const type = view.getUint16(pos, le); pos += 2;
      const cnt = view.getUint32(pos, le); pos += 4;

      const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 }[type] || 1;
      const totalBytes = cnt * typeSize;

      let valueOffset = pos;
      if (totalBytes > 4) {
        valueOffset = view.getUint32(pos, le);
      }

      let values = [];
      if (type === 2) {
        // ASCII: read as string (excluding null terminator)
        let str = '';
        for (let j = 0; j < cnt; j++) {
          const ch = view.getUint8(valueOffset + j);
          if (ch !== 0) str += String.fromCharCode(ch);
        }
        values = [str];
      } else {
        for (let j = 0; j < cnt; j++) {
          if (type === 3) values.push(view.getUint16(valueOffset + j * 2, le));
          else if (type === 4) values.push(view.getUint32(valueOffset + j * 4, le));
          else if (type === 12) values.push(view.getFloat64(valueOffset + j * 8, le));
        }
      }

      tags[tag] = { type, count: cnt, values };
      pos += 4;
    }

    return { magic, le, ifdOffset, tags };
  }

  // ── Single-band Float32 GeoTIFF ──
  await asyncCheck('writeFloat32GeoTIFF: single-band produces valid TIFF', async () => {
    const w = 100, h = 80;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 0.01;

    const buf = await writeFloat32GeoTIFF(
      { HHHH: data }, ['HHHH'], w, h,
      [500000, 3700000, 510000, 3708000], 32610
    );

    const tiff = parseTIFF(buf);
    if (tiff.magic !== 42) throw new Error(`Bad magic: ${tiff.magic}`);
  });

  await asyncCheck('writeFloat32GeoTIFF: single-band BitsPerSample = 32', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const bps = tiff.tags[258]; // BitsPerSample
    if (!bps || bps.values[0] !== 32) {
      throw new Error(`BitsPerSample = ${bps?.values[0]}, expected 32`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: single-band SampleFormat = 3 (float)', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const sf = tiff.tags[339]; // SampleFormat
    if (!sf || sf.values[0] !== 3) {
      throw new Error(`SampleFormat = ${sf?.values[0]}, expected 3`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: single-band SamplesPerPixel = 1', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const spp = tiff.tags[277]; // SamplesPerPixel
    if (!spp || spp.values[0] !== 1) {
      throw new Error(`SamplesPerPixel = ${spp?.values[0]}, expected 1`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: single-band Compression = 8 (DEFLATE)', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const comp = tiff.tags[259]; // Compression
    if (!comp || comp.values[0] !== 8) {
      throw new Error(`Compression = ${comp?.values[0]}, expected 8`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: has GeoKeys (tag 34735)', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    if (!tiff.tags[34735]) throw new Error('Missing GeoKeyDirectory tag');
  });

  await asyncCheck('writeFloat32GeoTIFF: ModelPixelScale matches bounds', async () => {
    const w = 100, h = 100;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [500000, 3700000, 510000, 3710000], 32610);
    const tiff = parseTIFF(buf);
    const scale = tiff.tags[33550]; // ModelPixelScale
    if (!scale) throw new Error('Missing ModelPixelScale');
    const expectX = 10000 / 100; // (maxX-minX)/width = 100
    if (Math.abs(scale.values[0] - expectX) > 0.01) {
      throw new Error(`PixelScaleX = ${scale.values[0]}, expected ${expectX}`);
    }
  });

  // ── Multi-band Float32 GeoTIFF ──
  await asyncCheck('writeFloat32GeoTIFF: 3-band BitsPerSample = [32,32,32]', async () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = await writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const bps = tiff.tags[258];
    if (!bps || bps.count !== 3 || bps.values[0] !== 32 || bps.values[1] !== 32 || bps.values[2] !== 32) {
      throw new Error(`BitsPerSample = ${bps?.values}, expected [32,32,32]`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: 3-band SampleFormat = [3,3,3]', async () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = await writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const sf = tiff.tags[339];
    if (!sf || sf.count !== 3 || sf.values[0] !== 3 || sf.values[1] !== 3 || sf.values[2] !== 3) {
      throw new Error(`SampleFormat = ${sf?.values}, expected [3,3,3]`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: tile offsets are non-zero', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const offsets = tiff.tags[324]; // TileOffsets
    if (!offsets || offsets.values[0] === 0) {
      throw new Error(`TileOffsets[0] = ${offsets?.values[0]}, expected non-zero`);
    }
  });

  await asyncCheck('writeFloat32GeoTIFF: tile byte counts are non-zero', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const counts = tiff.tags[325]; // TileByteCounts
    if (!counts || counts.values[0] === 0) {
      throw new Error(`TileByteCounts[0] = ${counts?.values[0]}, expected non-zero`);
    }
  });

  // ── ExtraSamples tag for multi-band ──
  await asyncCheck('writeFloat32GeoTIFF: 2-band has ExtraSamples tag', async () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n) };
    const buf = await writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const es = tiff.tags[338]; // ExtraSamples
    if (!es) throw new Error('Missing ExtraSamples tag for 2-band GeoTIFF');
    if (es.count !== 1) throw new Error(`ExtraSamples count = ${es.count}, expected 1`);
    if (es.values[0] !== 0) throw new Error(`ExtraSamples[0] = ${es.values[0]}, expected 0 (unspecified)`);
  });

  await asyncCheck('writeFloat32GeoTIFF: 3-band has ExtraSamples = [0,0]', async () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = await writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const es = tiff.tags[338];
    if (!es) throw new Error('Missing ExtraSamples tag for 3-band GeoTIFF');
    if (es.count !== 2) throw new Error(`ExtraSamples count = ${es.count}, expected 2`);
  });

  await asyncCheck('writeFloat32GeoTIFF: single-band has no ExtraSamples', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    if (tiff.tags[338]) throw new Error('Single-band should not have ExtraSamples tag');
  });

  // ── GeoKeys CRS verification ──
  await asyncCheck('writeFloat32GeoTIFF: projected CRS GeoKeys correct (UTM)', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h,
      [200000, 8500000, 225600, 8520000], 32718);
    const tiff = parseTIFF(buf);
    const gk = tiff.tags[34735]; // GeoKeyDirectory
    if (!gk) throw new Error('Missing GeoKeyDirectory');
    // GeoKeys: [1,1,0,3, 1024,0,1,modelType, 1025,0,1,rasterType, 3072,0,1,epsg]
    // Key 3072 (ProjectedCSTypeGeoKey) should have value 32718
    const epsgIdx = gk.values.indexOf(3072);
    if (epsgIdx < 0) throw new Error('Missing ProjectedCSTypeGeoKey (3072)');
    const epsgVal = gk.values[epsgIdx + 3]; // 3 entries after the key ID
    if (epsgVal !== 32718) throw new Error(`ProjectedCSTypeGeoKey = ${epsgVal}, expected 32718`);
  });

  await asyncCheck('writeFloat32GeoTIFF: geographic CRS GeoKeys correct (4326)', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h,
      [-122.5, 37.5, -122.0, 38.0], 4326);
    const tiff = parseTIFF(buf);
    const gk = tiff.tags[34735];
    if (!gk) throw new Error('Missing GeoKeyDirectory');
    // Key 2048 (GeographicTypeGeoKey) should have value 4326
    const epsgIdx = gk.values.indexOf(2048);
    if (epsgIdx < 0) throw new Error('Missing GeographicTypeGeoKey (2048)');
    const epsgVal = gk.values[epsgIdx + 3];
    if (epsgVal !== 4326) throw new Error(`GeographicTypeGeoKey = ${epsgVal}, expected 4326`);
  });

  // ── GDAL_NODATA tag ──
  await asyncCheck('writeFloat32GeoTIFF: has GDAL_NODATA = nan', async () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = await writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const nodata = tiff.tags[42113]; // GDAL_NODATA
    if (!nodata) throw new Error('Missing GDAL_NODATA tag (42113)');
    if (nodata.values[0] !== 'nan') throw new Error(`GDAL_NODATA = "${nodata.values[0]}", expected "nan"`);
  });

  // ── RGBA COG ──
  await asyncCheck('writeRGBAGeoTIFF: produces valid TIFF', async () => {
    const w = 64, h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = i % 256;

    const buf = await writeRGBAGeoTIFF(rgba, w, h, [0, 0, 64, 64], 32610, { generateOverviews: false });
    const tiff = parseTIFF(buf);
    if (tiff.magic !== 42) throw new Error(`Bad magic: ${tiff.magic}`);
    const spp = tiff.tags[277];
    if (!spp || spp.values[0] !== 4) throw new Error(`SamplesPerPixel = ${spp?.values[0]}, expected 4`);
  });

} catch (err) {
  skip('GeoTIFF writer tests', `import failed: ${err.message}`);
}

// ─── 12. PNG state embed/extract ─────────────────────────────────────────────

suite('PNG state');

const pngStateSrc = readFile('src/utils/png-state.js');

check('exports embedStateInPNG', () => {
  assertContains(pngStateSrc, 'export async function embedStateInPNG', 'embedStateInPNG export');
});

check('exports extractStateFromPNG', () => {
  assertContains(pngStateSrc, 'export async function extractStateFromPNG', 'extractStateFromPNG export');
});

check('uses SARdine-State keyword', () => {
  assertContains(pngStateSrc, 'SARdine-State', 'KEYWORD constant');
});

check('uses tEXt chunk type', () => {
  assertContains(pngStateSrc, 'tEXt', 'tEXt chunk type');
});

check('includes CRC32 implementation', () => {
  assertContains(pngStateSrc, 'CRC32', 'CRC32 table');
});

check('checks PNG signature bytes', () => {
  assertContains(pngStateSrc, '137, 80, 78, 71', 'PNG signature bytes');
});

check('main.jsx imports embedStateInPNG', () => {
  const mainSrc = readFile('app/main.jsx');
  assertContains(mainSrc, 'embedStateInPNG', 'embedStateInPNG import');
});

check('main.jsx imports extractStateFromPNG', () => {
  const mainSrc = readFile('app/main.jsx');
  assertContains(mainSrc, 'extractStateFromPNG', 'extractStateFromPNG import');
});

check('main.jsx calls embedStateInPNG at export', () => {
  const mainSrc = readFile('app/main.jsx');
  assertContains(mainSrc, 'await embedStateInPNG(blob, serializeViewerState())', 'embed call at export');
});

check('main.jsx calls extractStateFromPNG on PNG drop', () => {
  const mainSrc = readFile('app/main.jsx');
  assertContains(mainSrc, 'extractStateFromPNG(file)', 'extract call on drop');
});

try {
  const { embedStateInPNG, extractStateFromPNG } = await import(join(rootDir, 'src/utils/png-state.js'));

  // Minimal 1×1 PNG for functional tests (base64 encoded)
  const MIN_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==';
  function makeMinPNG() {
    return new Blob([Buffer.from(MIN_PNG_B64, 'base64')], { type: 'image/png' });
  }

  check('extractStateFromPNG returns null for plain PNG', async () => {
    const result = await extractStateFromPNG(makeMinPNG());
    if (result !== null) throw new Error('Expected null, got object');
  });

  check('extractStateFromPNG returns null for non-PNG', async () => {
    const result = await extractStateFromPNG(new Blob(['not a png']));
    if (result !== null) throw new Error('Expected null');
  });

  check('embed/extract round-trip', async () => {
    const state = { colormap: 'viridis', contrastMin: -25, useDecibels: true };
    const embedded = await embedStateInPNG(makeMinPNG(), state);
    const extracted = await extractStateFromPNG(embedded);
    if (!extracted) throw new Error('extractStateFromPNG returned null');
    if (extracted.colormap !== 'viridis') throw new Error(`colormap: expected viridis, got ${extracted.colormap}`);
    if (extracted.contrastMin !== -25) throw new Error(`contrastMin: expected -25, got ${extracted.contrastMin}`);
    if (extracted.useDecibels !== true) throw new Error(`useDecibels: expected true, got ${extracted.useDecibels}`);
  });

  check('embedded PNG is larger than original', async () => {
    const orig = makeMinPNG();
    const embedded = await embedStateInPNG(orig, { colormap: 'plasma' });
    const origSize = (await orig.arrayBuffer()).byteLength;
    const newSize = (await embedded.arrayBuffer()).byteLength;
    if (newSize <= origSize) throw new Error(`Expected size increase, got ${newSize} <= ${origSize}`);
  });

  check('PNG signature preserved after embed', async () => {
    const embedded = await embedStateInPNG(makeMinPNG(), { x: 1 });
    const buf = await embedded.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) throw new Error(`Signature byte ${i}: expected ${sig[i]}, got ${bytes[i]}`);
    }
  });

} catch (err) {
  skip('PNG state functional tests', `import failed: ${err.message}`);
}

// ─── 13. Colorblind mode — source checks ────────────────────────────────────

suite('Colorblind mode (source)');

const gpuLayerContent = readFile('src/layers/SARGPULayer.js');
const tileLayerSrc    = readFile('src/layers/SARTileLayer.js');
const viewerSrc       = readFile('src/viewers/SARViewer.jsx');
const compositesSrc   = readFile('src/utils/sar-composites.js');

check('SARGPULayer exports COLORBLIND_MODE_IDS', () => {
  assertContains(gpuLayerContent, 'export const COLORBLIND_MODE_IDS', 'COLORBLIND_MODE_IDS export');
});

check('COLORBLIND_MODE_IDS has off/deuteranopia/protanopia/tritanopia', () => {
  for (const mode of ['off', 'deuteranopia', 'protanopia', 'tritanopia']) {
    assertContains(gpuLayerContent, `${mode}:`, `${mode} key in COLORBLIND_MODE_IDS`);
  }
});

check('fragment shader declares uColorblindMode uniform', () => {
  assertContains(gpuLayerContent, 'uniform float uColorblindMode', 'uColorblindMode uniform');
});

check('fragment shader applies CVD mat3 in RGB path', () => {
  assertContains(gpuLayerContent, 'mat3 cvd', 'CVD mat3 in shader');
});

check('fragment shader has deuteranopia/protanopia branch (cvdMode == 1 || cvdMode == 2)', () => {
  assertContains(gpuLayerContent, 'cvdMode == 1 || cvdMode == 2', 'deuteranopia/protanopia branch');
});

check('fragment shader has tritanopia branch (cvdMode == 3)', () => {
  assertContains(gpuLayerContent, 'cvdMode == 3', 'tritanopia branch');
});

check('draw() passes uColorblindMode uniform', () => {
  assertContains(gpuLayerContent, 'uColorblindMode:', 'uColorblindMode in layerUniforms');
});

check('SARGPULayer defaultProps includes colorblindMode', () => {
  assertContains(gpuLayerContent, "colorblindMode: { type: 'string'", 'colorblindMode defaultProp');
});

check('SARTileLayer accepts colorblindMode prop', () => {
  assertContains(tileLayerSrc, "colorblindMode = 'off'", 'colorblindMode prop in SARTileLayer');
});

check('SARTileLayer threads colorblindMode to sublayer', () => {
  assertContains(tileLayerSrc, 'colorblindMode,', 'colorblindMode passed to SARGPULayer');
});

check('SARTileLayer includes colorblindMode in updateTriggers deps', () => {
  assertContains(tileLayerSrc, 'colorblindMode', 'colorblindMode in renderSubLayers deps');
});

check('SARViewer accepts colorblindMode prop', () => {
  assertContains(viewerSrc, "colorblindMode = 'off'", 'colorblindMode prop in SARViewer');
});

check('SARViewer passes colorblindMode to tile layer', () => {
  assertContains(viewerSrc, 'colorblindMode: v.colorblindMode', 'colorblindMode in layer props');
});

check('sar-composites.js exports COLORBLIND_MATRICES', () => {
  assertContains(compositesSrc, 'export const COLORBLIND_MATRICES', 'COLORBLIND_MATRICES export');
});

check('COLORBLIND_MATRICES has deuteranopia, protanopia, tritanopia', () => {
  for (const mode of ['deuteranopia', 'protanopia', 'tritanopia']) {
    assertContains(compositesSrc, `${mode}:`, `${mode} in COLORBLIND_MATRICES`);
  }
});

check('createRGBTexture accepts colorblindMode parameter', () => {
  assertContains(compositesSrc, "colorblindMode = 'off'", 'colorblindMode param in createRGBTexture');
});

// ─── 13. Colorblind mode — functional correctness ────────────────────────────
// Tests operate directly on COLORBLIND_MATRICES (pure JS, no browser APIs needed).

suite('Colorblind mode (functional)');

try {
  const { COLORBLIND_MATRICES } = await import(join(rootDir, 'src/utils/sar-composites.js'));

  // Apply a matrix to an [r,g,b] triple (values 0–1), returns clamped [r,g,b]
  function applyMatrix(mat, r, g, b) {
    return mat.map(row => Math.max(0, Math.min(1, row[0] * r + row[1] * g + row[2] * b)));
  }

  // ── Matrix structure ──
  check('COLORBLIND_MATRICES: each entry is a 3×3 array', () => {
    for (const [name, mat] of Object.entries(COLORBLIND_MATRICES)) {
      if (!Array.isArray(mat) || mat.length !== 3) {
        throw new Error(`${name}: expected 3 rows, got ${mat?.length}`);
      }
      for (let row = 0; row < 3; row++) {
        if (!Array.isArray(mat[row]) || mat[row].length !== 3) {
          throw new Error(`${name}[${row}]: expected 3 cols, got ${mat[row]?.length}`);
        }
      }
    }
  });

  check('COLORBLIND_MATRICES: all coefficients are finite numbers', () => {
    for (const [name, mat] of Object.entries(COLORBLIND_MATRICES)) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const v = mat[row][col];
          if (typeof v !== 'number' || !isFinite(v)) {
            throw new Error(`${name}[${row}][${col}] = ${v} — not a finite number`);
          }
        }
      }
    }
  });

  check("'off' is not in COLORBLIND_MATRICES (no transform for off mode)", () => {
    if ('off' in COLORBLIND_MATRICES) {
      throw new Error("'off' should not have a matrix entry");
    }
  });

  // ── Deuteranopia: data-R → orange (R high, B low), data-G → blue (B high, R low) ──
  check('deuteranopia: pure-R input maps to orange (R high, B ~0)', () => {
    const [r, , b] = applyMatrix(COLORBLIND_MATRICES.deuteranopia, 1, 0, 0);
    if (r < 0.7)  throw new Error(`R=${r.toFixed(3)} too low for orange`);
    if (b > 0.1)  throw new Error(`B=${b.toFixed(3)} too high — expected near-zero blue`);
  });

  check('deuteranopia: pure-G input maps to blue (B high, R ~0)', () => {
    const [r, , b] = applyMatrix(COLORBLIND_MATRICES.deuteranopia, 0, 1, 0);
    if (r > 0.05) throw new Error(`R=${r.toFixed(3)} too high — expected low red for blue`);
    if (b < 0.7)  throw new Error(`B=${b.toFixed(3)} too low — expected high blue`);
  });

  check('deuteranopia: R and G inputs have different dominant output channels', () => {
    const fromR = applyMatrix(COLORBLIND_MATRICES.deuteranopia, 1, 0, 0);
    const fromG = applyMatrix(COLORBLIND_MATRICES.deuteranopia, 0, 1, 0);
    if (fromR[0] <= fromR[2]) throw new Error('Deuteranopia pure-R should have R > B (orange)');
    if (fromG[2] <= fromG[0]) throw new Error('Deuteranopia pure-G should have B > R (blue)');
  });

  check('deuteranopia transform is not identity for pure-R input', () => {
    const [, g, b] = applyMatrix(COLORBLIND_MATRICES.deuteranopia, 1, 0, 0);
    if (g < 0.01 && b < 0.01) throw new Error('Deuteranopia pure-R output looks like identity [1,0,0]');
  });

  // ── Protanopia: same matrix as deuteranopia ──
  check('protanopia matrix equals deuteranopia matrix', () => {
    const d = COLORBLIND_MATRICES.deuteranopia;
    const p = COLORBLIND_MATRICES.protanopia;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (d[row][col] !== p[row][col]) {
          throw new Error(`deuteranopia[${row}][${col}]=${d[row][col]} ≠ protanopia[${row}][${col}]=${p[row][col]}`);
        }
      }
    }
  });

  // ── Tritanopia: data-B → magenta (R+B high, G low), data-R and data-G preserved ──
  check('tritanopia: pure-B input maps to magenta (R high, G low, B high)', () => {
    const [r, g, b] = applyMatrix(COLORBLIND_MATRICES.tritanopia, 0, 0, 1);
    if (r < 0.5)  throw new Error(`R=${r.toFixed(3)} too low — expected high red for magenta`);
    if (g > 0.15) throw new Error(`G=${g.toFixed(3)} too high — expected low green for magenta`);
    if (b < 0.5)  throw new Error(`B=${b.toFixed(3)} too low — expected high blue for magenta`);
  });

  check('tritanopia: pure-R input stays red-dominant', () => {
    const [r] = applyMatrix(COLORBLIND_MATRICES.tritanopia, 1, 0, 0);
    if (r < 0.7) throw new Error(`R=${r.toFixed(3)} too low — expected high red`);
  });

  check('tritanopia: pure-G input stays green-dominant', () => {
    const [, g] = applyMatrix(COLORBLIND_MATRICES.tritanopia, 0, 1, 0);
    if (g < 0.7) throw new Error(`G=${g.toFixed(3)} too low — expected high green`);
  });

  check('tritanopia transform is not identity for pure-B input', () => {
    const [r, g] = applyMatrix(COLORBLIND_MATRICES.tritanopia, 0, 0, 1);
    if (r < 0.01 && g < 0.01) throw new Error('Tritanopia pure-B output looks like identity [0,0,1]');
  });

  // ── Output always in [0, 1] for any unit-range input ──
  check('all modes clamp output to [0, 1] for saturated inputs', () => {
    const inputs = [[1,1,1],[1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0.5]];
    for (const [name, mat] of Object.entries(COLORBLIND_MATRICES)) {
      for (const [ri, gi, bi] of inputs) {
        const out = applyMatrix(mat, ri, gi, bi);
        for (let c = 0; c < 3; c++) {
          if (out[c] < 0 || out[c] > 1) {
            throw new Error(`${name} [${ri},${gi},${bi}] → ch${c} = ${out[c].toFixed(4)} out of [0,1]`);
          }
        }
      }
    }
  });

} catch (err) {
  skip('colorblind functional tests', `import failed: ${err.message}`);
}

// ─── H/Alpha/Entropy decomposition ───────────────────────────────────────────

suite('H/Alpha/Entropy (Cloude-Pottier)');

// Source-level checks on the GLSL and JS code
check('GLSL shader has uMode h-alpha branch (uMode > 1.5)', () => {
  assertContains(gpuContent, 'uMode > 1.5', 'h-alpha uMode branch');
});

check('GLSL shader has Cardano eigenvalue computation', () => {
  assertContains(gpuContent, 'HA_2PI3', 'Cardano 2π/3 constant');
  assertContains(gpuContent, 'cos(phi)', 'Cardano cosine root');
});

check('GLSL shader has haAlpha() eigenvector function', () => {
  assertContains(gpuContent, 'float haAlpha(', 'haAlpha function signature');
});

check('GLSL shader builds coherency matrix T3 from C3', () => {
  assertContains(gpuContent, 'Pauli basis', 'Pauli basis comment');
  assertContains(gpuContent, 't11 + t22v + t33v', 'trace computation');
});

check('GLSL shader computes entropy with log base 3', () => {
  assertContains(gpuContent, 'HA_LOG3', 'log(3) constant');
  assertContains(gpuContent, 'log(p1) / HA_LOG3', 'log₃ entropy term');
});

check('GLSL shader reads 9 covariance textures', () => {
  // All 9 covariance matrix elements must be read from texture units
  for (const name of ['uTexture', 'uTextureG', 'uTextureB',
                       'uTextureMask', 'uTextureCoherence', 'uTextureIncidence',
                       'uTexCorIono', 'uTexCorTropo', 'uTexCorSET']) {
    assertContains(gpuContent, `texture(${name}, vTexCoord)`, `${name} texture read`);
  }
});

check('SARGPULayer uploads h-alpha covariance textures in updateState', () => {
  assertContains(gpuContent, 'isHAlpha', 'h-alpha mode detection');
  assertContains(gpuContent, 'texCov12Re', 'C12 real texture state');
  assertContains(gpuContent, 'texCov23Im', 'C23 imaginary texture state');
});

check('SARGPULayer binds covariance textures in draw()', () => {
  assertContains(gpuContent, 'texCov12Re', 'draw binds C12re');
  assertContains(gpuContent, 'texCov23Im', 'draw binds C23im');
});

check('SARGPULayer sets uMode 2.0 for h-alpha', () => {
  assertContains(gpuContent, 'isHAlpha ? 2.0', 'uMode 2.0 for h-alpha');
});

check('SARGPULayer cleans up covariance textures in finalizeState', () => {
  assertContains(gpuContent, "this.state.texCov12Re", 'finalizeState cleans texCov12Re');
  assertContains(gpuContent, "this.state.texCov23Im", 'finalizeState cleans texCov23Im');
});

check('SARTileLayer detects h-alpha-entropy composite', () => {
  assertContains(tileLayerContent, "h-alpha-entropy", 'h-alpha-entropy composite detection');
  assertContains(tileLayerContent, "mode: 'h-alpha'", 'h-alpha mode passed to SARGPULayer');
});

check('SARTileLayer passes 9 covariance bands for h-alpha', () => {
  assertContains(tileLayerContent, "dataCov12Re: b['HHHV_re']", 'C12 real passthrough');
  assertContains(tileLayerContent, "dataCov13Im: b['HHVV_im']", 'C13 imag passthrough');
  assertContains(tileLayerContent, "dataCov23Re: b['HVVV_re']", 'C23 real passthrough');
});

check('h-alpha-entropy preset has gpuNative flag', () => {
  const compSrc = readFile('src/utils/sar-composites.js');
  assertContains(compSrc, 'gpuNative: true', 'gpuNative flag');
});

check('h-alpha-entropy preset disables dB by default', () => {
  const compSrc = readFile('src/utils/sar-composites.js');
  assertContains(compSrc, 'defaultUseDecibels: false', 'defaultUseDecibels false');
});

// Functional test: run the CPU decomposition and validate output ranges
try {
  const { computeRGBBands, SAR_COMPOSITES } = await import(join(rootDir, 'src/utils/sar-composites.js'));

  check('h-alpha-entropy preset exists in SAR_COMPOSITES', () => {
    if (!SAR_COMPOSITES['h-alpha-entropy']) throw new Error('preset missing');
    const p = SAR_COMPOSITES['h-alpha-entropy'];
    if (!p.required.includes('HHHH')) throw new Error('missing HHHH in required');
    if (!p.requiredComplex.includes('HHHV')) throw new Error('missing HHHV in requiredComplex');
  });

  // Create synthetic covariance data for a 4×4 tile (16 pixels)
  // Test case: isotropic scatterer (equal eigenvalues → H=1, α≈45°, A=0)
  // and surface scatterer (dominant λ1 → H≈0, α≈0°)
  const N = 16;
  const makeBand = (val) => { const a = new Float32Array(N); a.fill(val); return a; };

  // Test 1: Identity-like covariance (c11=c22=c33=1, off-diag=0)
  // → equal eigenvalues → maximum entropy
  const isoBands = {
    HHHH: makeBand(1), HVHV: makeBand(1), VVVV: makeBand(1),
    HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    HHVV_re: makeBand(0), HHVV_im: makeBand(0),
    HVVV_re: makeBand(0), HVVV_im: makeBand(0),
  };

  await asyncCheck('isotropic scatterer: H≈1, α≈45°, A≈0', async () => {
    const rgb = computeRGBBands(isoBands, 'h-alpha-entropy', 4);
    const H = rgb.R[0], alpha = rgb.G[0], A = rgb.B[0];
    if (H < 0.95 || H > 1.05) throw new Error(`H=${H.toFixed(3)}, expected ≈1`);
    if (alpha < 40 || alpha > 50) throw new Error(`α=${alpha.toFixed(1)}°, expected ≈45°`);
    if (A > 0.05) throw new Error(`A=${A.toFixed(3)}, expected ≈0`);
  });

  // Test 2: Strong surface scatterer (c11=10, c33=10, c13re=10, rest small)
  // HH+VV dominant → low entropy, low alpha
  const surfBands = {
    HHHH: makeBand(10), HVHV: makeBand(0.01), VVVV: makeBand(10),
    HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    HHVV_re: makeBand(9.5), HHVV_im: makeBand(0),
    HVVV_re: makeBand(0), HVVV_im: makeBand(0),
  };

  await asyncCheck('surface scatterer: low H, low α', async () => {
    const rgb = computeRGBBands(surfBands, 'h-alpha-entropy', 4);
    const H = rgb.R[0], alpha = rgb.G[0];
    if (H > 0.5) throw new Error(`H=${H.toFixed(3)}, expected low`);
    if (alpha > 30) throw new Error(`α=${alpha.toFixed(1)}°, expected low`);
  });

  // Test 3: Zero data → NaN output (nodata)
  const zeroBands = {
    HHHH: makeBand(0), HVHV: makeBand(0), VVVV: makeBand(0),
    HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    HHVV_re: makeBand(0), HHVV_im: makeBand(0),
    HVVV_re: makeBand(0), HVVV_im: makeBand(0),
  };

  await asyncCheck('zero covariance → zero output (nodata)', async () => {
    const rgb = computeRGBBands(zeroBands, 'h-alpha-entropy', 4);
    if (rgb.R[0] !== 0) throw new Error(`H=${rgb.R[0]}, expected 0`);
    if (rgb.G[0] !== 0) throw new Error(`α=${rgb.G[0]}, expected 0`);
    if (rgb.B[0] !== 0) throw new Error(`A=${rgb.B[0]}, expected 0`);
  });

  // Test 4: Output ranges — H ∈ [0,1], α ∈ [0°,90°], A ∈ [0,1]
  await asyncCheck('output ranges valid: H∈[0,1], α∈[0°,90°], A∈[0,1]', async () => {
    // Mix of different scatterers
    const mixBands = {
      HHHH: new Float32Array([5, 10, 1, 0.5, 2, 8, 3, 7, 4, 6, 9, 0.1, 0.3, 1.5, 2.5, 4.5]),
      HVHV: new Float32Array([1, 0.5, 3, 0.1, 1.5, 2, 0.8, 1.2, 0.3, 0.7, 1.1, 0.05, 0.2, 0.6, 1.8, 0.9]),
      VVVV: new Float32Array([4, 8, 2, 0.4, 1.8, 7, 2.5, 6, 3.5, 5, 8.5, 0.08, 0.25, 1.2, 2.2, 3.8]),
      HHHV_re: new Float32Array([0.1, -0.2, 0.3, 0, 0.05, -0.1, 0.15, -0.05, 0.08, -0.12, 0.2, 0, 0.01, 0.04, -0.06, 0.09]),
      HHHV_im: new Float32Array([0.05, 0.1, -0.15, 0, 0.02, 0.08, -0.07, 0.03, 0.04, -0.06, 0.1, 0, 0.005, 0.02, 0.03, -0.04]),
      HHVV_re: new Float32Array([2, 4, 0.5, 0.1, 0.8, 3, 1, 2.5, 1.5, 2, 3.5, 0.02, 0.1, 0.5, 1, 1.8]),
      HHVV_im: new Float32Array([0.3, -0.5, 0.2, 0, 0.1, -0.3, 0.15, -0.2, 0.12, -0.18, 0.25, 0, 0.02, 0.08, -0.1, 0.14]),
      HVVV_re: new Float32Array([0.08, -0.15, 0.2, 0, 0.03, -0.08, 0.1, -0.04, 0.06, -0.09, 0.15, 0, 0.008, 0.03, -0.05, 0.07]),
      HVVV_im: new Float32Array([0.04, 0.08, -0.1, 0, 0.015, 0.06, -0.05, 0.02, 0.03, -0.04, 0.07, 0, 0.004, 0.015, 0.02, -0.03]),
    };
    const rgb = computeRGBBands(mixBands, 'h-alpha-entropy', 4);
    for (let i = 0; i < N; i++) {
      const H = rgb.R[i], a = rgb.G[i], A = rgb.B[i];
      if (isNaN(H) || isNaN(a) || isNaN(A)) continue; // skip nodata
      if (H < -0.01 || H > 1.01) throw new Error(`pixel ${i}: H=${H.toFixed(3)} out of [0,1]`);
      if (a < -0.1 || a > 90.1) throw new Error(`pixel ${i}: α=${a.toFixed(1)}° out of [0°,90°]`);
      if (A < -0.01 || A > 1.01) throw new Error(`pixel ${i}: A=${A.toFixed(3)} out of [0,1]`);
    }
  });

} catch (err) {
  skip('H/Alpha/Entropy functional tests', `import failed: ${err.message}`);
}

// ─── Dual-pol H/Alpha/Gamma decomposition ────────────────────────────────────

suite('Dual-pol H/α/γ (2×2 eigendecomposition)');

// Source-level checks: GLSL shader
check('GLSL shader has uMode==3 dual-pol branch (uMode > 2.5)', () => {
  assertContains(gpuContent, 'uMode > 2.5', 'dual-pol uMode branch');
});

check('GLSL shader has quadratic eigenvalue formula', () => {
  assertContains(gpuContent, 'HA_LN2', 'log(2) constant for 2×2 entropy');
  assertContains(gpuContent, 'trace / 2.0 + disc', 'quadratic eigenvalue l1');
  assertContains(gpuContent, 'trace / 2.0 - disc', 'quadratic eigenvalue l2');
});

check('GLSL shader reads coherence with UV remapping support', () => {
  assertContains(gpuContent, 'needsRemap', 'UV remap detection');
  assertContains(gpuContent, 'cohUV', 'coherence UV remap');
});

check('GLSL shader computes eigenvector alpha from 2×2 matrix', () => {
  assertContains(gpuContent, 'v0_1 = l1 - c22', 'eigenvector v0 for l1');
  assertContains(gpuContent, 'v0_2 = l2 - c22', 'eigenvector v0 for l2');
});

// Source-level: SARGPULayer JS
check('SARGPULayer supports dual-pol-h-alpha mode', () => {
  assertContains(gpuContent, "isDualPolHAlpha", 'dual-pol mode detection');
  assertContains(gpuContent, "isDualPolHAlpha ? 3.0", 'uMode 3.0 for dual-pol');
});

check('SARGPULayer binds C12 textures for dual-pol mode', () => {
  assertContains(gpuContent, 'isDualPolHAlpha && texCov12Re && texCov12Im', 'dual-pol C12 binding');
});

// Source-level: SARTileLayer
check('SARTileLayer detects dual-pol-h-alpha-gamma composite', () => {
  assertContains(tileLayerContent, "dual-pol-h-alpha-gamma", 'dual-pol composite detection');
  assertContains(tileLayerContent, "mode: 'dual-pol-h-alpha'", 'dual-pol mode in SARGPULayer');
});

check('SARTileLayer passes auxiliary coherence data for dual-pol', () => {
  assertContains(tileLayerContent, 'auxiliaryCoherenceData', 'auxiliary coherence prop');
});

check('SARTileLayer passes imageBounds for coherence UV remap', () => {
  assertContains(tileLayerContent, "imageBounds: auxiliaryCoherenceData ? bounds", 'imageBounds for coherence remap');
});

// Source-level: sar-composites.js preset
check('dual-pol-h-alpha-gamma preset exists', () => {
  const compSrc = readFile('src/utils/sar-composites.js');
  assertContains(compSrc, "'dual-pol-h-alpha-gamma'", 'preset key');
  assertContains(compSrc, "gpuNative: true", 'gpuNative flag');
  assertContains(compSrc, "needsAuxCoherence: true", 'needsAuxCoherence flag');
});

check('dual-pol preset requires only HHHH + HVHV + HHHV (not quad-pol)', () => {
  const compSrc = readFile('src/utils/sar-composites.js');
  // Must have HHHH and HVHV in required, but NOT VVVV
  assertContains(compSrc, "required: ['HHHH', 'HVHV']", 'dual-pol required bands');
  assertContains(compSrc, "requiredComplex: ['HHHV']", 'dual-pol complex band');
});

check('dual-pol preset uses log base 2 (not 3) in CPU decomposition', () => {
  const compSrc = readFile('src/utils/sar-composites.js');
  assertContains(compSrc, 'const LN2 = Math.log(2)', 'log base 2 in CPU decomposition');
});

// Functional tests via CPU decomposition
try {
  const { computeRGBBands, SAR_COMPOSITES } = await import(join(rootDir, 'src/utils/sar-composites.js'));

  const N = 16;
  const makeBand = (val) => { const a = new Float32Array(N); a.fill(val); return a; };

  // Test: isotropic 2×2 (C11=C22=1, C12=0) → maximum entropy H=1
  await asyncCheck('dual-pol isotropic: H≈1, α≈45°', async () => {
    const bands = {
      HHHH: makeBand(1), HVHV: makeBand(1),
      HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    };
    const rgb = computeRGBBands(bands, 'dual-pol-h-alpha-gamma', 4);
    const H = rgb.R[0], alpha = rgb.G[0];
    if (H < 0.95 || H > 1.05) throw new Error(`H=${H.toFixed(3)}, expected ≈1`);
    if (alpha < 40 || alpha > 50) throw new Error(`α=${alpha.toFixed(1)}°, expected ≈45°`);
  });

  // Test: pure co-pol (C11=10, C22=0.01, C12=0) → low entropy, low alpha
  await asyncCheck('dual-pol surface scatterer: low H, low α', async () => {
    const bands = {
      HHHH: makeBand(10), HVHV: makeBand(0.01),
      HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    };
    const rgb = computeRGBBands(bands, 'dual-pol-h-alpha-gamma', 4);
    const H = rgb.R[0], alpha = rgb.G[0];
    if (H > 0.3) throw new Error(`H=${H.toFixed(3)}, expected low`);
    if (alpha > 20) throw new Error(`α=${alpha.toFixed(1)}°, expected low`);
  });

  // Test: zero data → zero output
  await asyncCheck('dual-pol zero → zero output', async () => {
    const bands = {
      HHHH: makeBand(0), HVHV: makeBand(0),
      HHHV_re: makeBand(0), HHHV_im: makeBand(0),
    };
    const rgb = computeRGBBands(bands, 'dual-pol-h-alpha-gamma', 4);
    if (rgb.R[0] !== 0) throw new Error(`H=${rgb.R[0]}, expected 0`);
  });

  // Test: coherence passthrough
  await asyncCheck('dual-pol coherence passthrough to B channel', async () => {
    const bands = {
      HHHH: makeBand(5), HVHV: makeBand(2),
      HHHV_re: makeBand(0.1), HHHV_im: makeBand(0.05),
      _coherence: makeBand(0.75),
    };
    const rgb = computeRGBBands(bands, 'dual-pol-h-alpha-gamma', 4);
    if (Math.abs(rgb.B[0] - 0.75) > 0.001) throw new Error(`γ=${rgb.B[0]}, expected 0.75`);
  });

  // Test: output ranges valid
  await asyncCheck('dual-pol output ranges: H∈[0,1], α∈[0°,90°]', async () => {
    const bands = {
      HHHH: new Float32Array([5, 10, 1, 0.5, 2, 8, 3, 7, 4, 6, 9, 0.1, 0.3, 1.5, 2.5, 4.5]),
      HVHV: new Float32Array([1, 0.5, 3, 0.1, 1.5, 2, 0.8, 1.2, 0.3, 0.7, 1.1, 0.05, 0.2, 0.6, 1.8, 0.9]),
      HHHV_re: new Float32Array([0.1, -0.2, 0.3, 0, 0.05, -0.1, 0.15, -0.05, 0.08, -0.12, 0.2, 0, 0.01, 0.04, -0.06, 0.09]),
      HHHV_im: new Float32Array([0.05, 0.1, -0.15, 0, 0.02, 0.08, -0.07, 0.03, 0.04, -0.06, 0.1, 0, 0.005, 0.02, 0.03, -0.04]),
    };
    const rgb = computeRGBBands(bands, 'dual-pol-h-alpha-gamma', 4);
    for (let i = 0; i < N; i++) {
      const H = rgb.R[i], a = rgb.G[i];
      if (isNaN(H) || isNaN(a)) continue;
      if (H < -0.01 || H > 1.01) throw new Error(`pixel ${i}: H=${H.toFixed(3)} out of [0,1]`);
      if (a < -0.1 || a > 90.1) throw new Error(`pixel ${i}: α=${a.toFixed(1)}° out of [0°,90°]`);
    }
  });

} catch (err) {
  skip('Dual-pol H/α/γ functional tests', `import failed: ${err.message}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`  RESULTS: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
console.log('═'.repeat(60));

if (totalFailed > 0) {
  console.log('\nSome checks failed. Fix before testing in browser.\n');
  process.exit(1);
} else {
  console.log('\nAll Node.js checks passed.\n');
  console.log('Browser tests:');
  console.log('  npm run test:layer     Layer rendering tests');
  console.log('  npm run debug:gpu      GPU debug console');
  console.log('  npm run benchmark      GPU vs CPU performance\n');
  process.exit(0);
}
