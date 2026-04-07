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

check('STRETCH_MODE_IDS has all 5 modes', () => {
  for (const sm of ['linear', 'sqrt', 'log', 'gamma', 'sigmoid']) {
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

check('stretch.js handles all 5 modes', () => {
  for (const mode of ['sqrt', 'log', 'gamma', 'sigmoid', 'linear']) {
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

  check('log stretch: maps [0,1] to [0,1], enhances low values', () => {
    const at0 = applyStretch(0, 'log', 1.0);
    const at1 = applyStretch(1, 'log', 1.0);
    const atMid = applyStretch(0.1, 'log', 1.0);
    if (Math.abs(at0) > 1e-10) throw new Error(`log(0) = ${at0}, expected 0`);
    if (Math.abs(at1 - 1) > 0.01) throw new Error(`log(1) = ${at1}, expected ~1`);
    // Log stretch should pull 0.1 upward (enhance low values)
    if (atMid <= 0.1) throw new Error(`log(0.1) = ${atMid}, expected > 0.1 (enhancement)`);
    if (atMid >= 1.0) throw new Error(`log(0.1) = ${atMid}, expected < 1.0`);
  });
} catch (err) {
  skip('stretch correctness tests', `import failed: ${err.message}`);
}

// ─── 10b. Colormap LUT correctness ─────────────────────────────────────────

suite('Colormap LUT correctness');

try {
  const { buildColormapLUT, getColormap, COLORMAP_NAMES } = await import(join(rootDir, 'src/utils/colormap.js'));

  check('buildColormapLUT returns 1024-byte Uint8Array', () => {
    const lut = buildColormapLUT('viridis');
    if (!(lut instanceof Uint8Array)) throw new Error('Expected Uint8Array');
    if (lut.length !== 1024) throw new Error(`Expected 1024 bytes, got ${lut.length}`);
  });

  check('LUT matches direct colormap evaluation', () => {
    for (const name of ['grayscale', 'viridis', 'inferno']) {
      const lut = buildColormapLUT(name);
      const fn = getColormap(name);
      // Check a few sample points
      for (const idx of [0, 64, 128, 192, 255]) {
        const [r, g, b] = fn(idx / 255);
        const off = idx * 4;
        if (Math.abs(lut[off] - r) > 1) throw new Error(`${name} LUT[${idx}].r = ${lut[off]}, expected ${r}`);
        if (Math.abs(lut[off + 1] - g) > 1) throw new Error(`${name} LUT[${idx}].g = ${lut[off+1]}, expected ${g}`);
        if (Math.abs(lut[off + 2] - b) > 1) throw new Error(`${name} LUT[${idx}].b = ${lut[off+2]}, expected ${b}`);
      }
    }
  });
} catch (err) {
  skip('colormap LUT tests', `import failed: ${err.message}`);
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

// ─── 14. Lite report charts ─────────────────────────────────────────────────

suite('Lite report charts (source)');

check('src/lite/index.js exists', () => { if (!fileExists('src/lite/index.js')) throw new Error('missing'); });
check('src/lite/report-charts.js exists', () => { if (!fileExists('src/lite/report-charts.js')) throw new Error('missing'); });
check('src/lite/report-viewer.html exists', () => { if (!fileExists('src/lite/report-viewer.html')) throw new Error('missing'); });

const liteIndexSrc = readFile('src/lite/index.js');
const liteChartsSrc = readFile('src/lite/report-charts.js');

for (const fn of ['drawDbBarChart', 'drawChangeDetectionPlot', 'drawFootprintMap',
  'drawRegionEstimates', 'drawTimelinePlot', 'drawHorizontalBars', 'renderReportDashboard']) {
  check(`report-charts.js exports ${fn}`, () => {
    assertContains(liteChartsSrc, `export function ${fn}`, `${fn} export`);
  });
  check(`lite/index.js re-exports ${fn}`, () => {
    assertContains(liteIndexSrc, fn, `${fn} re-export`);
  });
}

check('REPORT_COLORS exported', () => {
  assertContains(liteChartsSrc, 'REPORT_COLORS', 'REPORT_COLORS export');
});

check('report-viewer.html imports from report-charts.js', () => {
  const viewerHtml = readFile('src/lite/report-viewer.html');
  assertContains(viewerHtml, "from './report-charts.js'", 'report-charts import');
});

check('report-viewer.html supports ?report= URL param', () => {
  const viewerHtml = readFile('src/lite/report-viewer.html');
  assertContains(viewerHtml, "get('report')", 'URL param support');
});

check('src/index.js re-exports lite charts', () => {
  const mainIndex = readFile('src/index.js');
  assertContains(mainIndex, "from './lite/index.js'", 'lite re-export');
});

suite('Lite report charts (functional)');

try {
  const {
    drawDbBarChart, drawChangeDetectionPlot, drawFootprintMap,
    drawRegionEstimates, drawTimelinePlot, drawHorizontalBars,
    renderReportDashboard, REPORT_COLORS,
  } = await import(join(rootDir, 'src/lite/index.js'));

  // Minimal mock canvas context — records calls, doesn't render
  function mockCtx() {
    const calls = [];
    const handler = {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Return a function that records the call
        return (...args) => { calls.push({ method: prop, args }); };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    };
    return { ctx: new Proxy({ fillStyle: '', strokeStyle: '', font: '', textAlign: '', lineWidth: 1 }, handler), calls };
  }

  const rect = { x: 0, y: 0, w: 800, h: 400 };

  const demoScenes = [
    { date: '2025-06-15', meanDb: -12.3, floodSignal: false, bbox: [-163, 60, -162, 61] },
    { date: '2025-06-27', meanDb: -11.8, floodSignal: false, bbox: [-162.5, 60.5, -161.5, 61.2] },
    { date: '2025-07-09', meanDb: -18.5, floodSignal: true, bbox: [-163, 60, -162, 61] },
    { date: '2025-07-21', meanDb: -13.1, floodSignal: false, bbox: [-162.5, 60.5, -161.5, 61.2] },
  ];

  check('drawDbBarChart runs without error', () => {
    const { ctx } = mockCtx();
    drawDbBarChart(ctx, demoScenes, rect);
  });

  check('drawDbBarChart is a no-op for empty scenes', () => {
    const { ctx, calls } = mockCtx();
    drawDbBarChart(ctx, [], rect);
    if (calls.length > 0) throw new Error('Expected no calls for empty input');
  });

  check('drawChangeDetectionPlot runs without error', () => {
    const { ctx } = mockCtx();
    const pairs = [
      { primary: 'A', secondary: 'B', dbChange: -3.2, significantChange: true },
      { primary: 'B', secondary: 'C', dbChange: 1.5, significantChange: false },
    ];
    drawChangeDetectionPlot(ctx, pairs, rect);
  });

  check('drawFootprintMap runs without error', () => {
    const { ctx } = mockCtx();
    drawFootprintMap(ctx, demoScenes, rect);
  });

  check('drawRegionEstimates runs without error', () => {
    const { ctx } = mockCtx();
    drawRegionEstimates(ctx, {
      'Bethel': { floodDetected: true, date: '2025-08-03', meanDb: -19.2 },
      'Fairbanks': { floodDetected: false, date: '2025-07-22', meanDb: -11.4 },
    }, rect);
  });

  check('drawTimelinePlot runs without error', () => {
    const { ctx } = mockCtx();
    drawTimelinePlot(ctx, demoScenes, rect);
  });

  check('drawTimelinePlot needs ≥2 points', () => {
    const { ctx, calls } = mockCtx();
    drawTimelinePlot(ctx, [demoScenes[0]], rect);
    // Should not draw anything meaningful with 1 point
    if (calls.some(c => c.method === 'lineTo')) throw new Error('Should not draw line for single point');
  });

  check('drawHorizontalBars runs without error', () => {
    const { ctx } = mockCtx();
    drawHorizontalBars(ctx, [
      { label: 'search', value: 5 },
      { label: 'analyze', value: 8 },
    ], 'Exploration Log', rect);
  });

  check('renderReportDashboard runs without error', () => {
    const { ctx } = mockCtx();
    renderReportDashboard(ctx, { sceneResults: demoScenes, pairsTested: [] }, 1200, 600);
  });

  check('REPORT_COLORS has expected keys', () => {
    for (const key of ['bg', 'panel', 'grid', 'text', 'accent', 'flood', 'normal']) {
      if (!REPORT_COLORS[key]) throw new Error(`Missing color: ${key}`);
    }
  });

  check('REPORT_COLORS values are CSS color strings', () => {
    for (const [key, val] of Object.entries(REPORT_COLORS)) {
      if (typeof val !== 'string' || !val.startsWith('#')) {
        throw new Error(`${key}: expected hex color, got ${val}`);
      }
    }
  });

} catch (err) {
  skip('lite report charts functional tests', `import failed: ${err.message}`);
}

// ─── Overture Buildings loader ──────────────────────────────────────────────

suite('Overture Buildings loader');

try {
  const { getBuildingHeight, extrudeBuilding } = await import('../src/loaders/overture-buildings.js');
  const fixtureRaw = readFileSync(join(__dirname, 'fixtures', 'overture-buildings-sample.geojson'), 'utf8');
  const fixture = JSON.parse(fixtureRaw);

  check('fixture has 3 buildings', () => {
    if (fixture.features.length !== 3) throw new Error(`expected 3 features, got ${fixture.features.length}`);
  });

  // Height fallback tests
  check('getBuildingHeight uses explicit height when present', () => {
    const h = getBuildingHeight({ height: 25, num_floors: 8 });
    if (h !== 25) throw new Error(`expected 25, got ${h}`);
  });

  check('getBuildingHeight falls back to num_floors * 3', () => {
    const h = getBuildingHeight({ num_floors: 3 });
    if (h !== 9) throw new Error(`expected 9, got ${h}`);
  });

  check('getBuildingHeight defaults to 6m', () => {
    const h = getBuildingHeight({});
    if (h !== 6) throw new Error(`expected 6, got ${h}`);
  });

  check('getBuildingHeight ignores height=0', () => {
    const h = getBuildingHeight({ height: 0, num_floors: 4 });
    if (h !== 12) throw new Error(`expected 12 (4*3), got ${h}`);
  });

  // Extrusion tests with a flat DEM (elevation = 100m everywhere)
  const flatDEM = () => 100;

  check('extrudeBuilding with height feature', () => {
    const result = extrudeBuilding(fixture.features[0], flatDEM);
    if (result.baseElev !== 100) throw new Error(`baseElev: expected 100, got ${result.baseElev}`);
    if (result.topElev !== 125) throw new Error(`topElev: expected 125, got ${result.topElev}`);
    if (result.footprint.length !== 5) throw new Error(`footprint: expected 5 coords (closed ring), got ${result.footprint.length}`);
    // 4 walls for a rectangular building (5 coords, last = first)
    if (result.walls.length !== 4) throw new Error(`walls: expected 4, got ${result.walls.length}`);
  });

  check('extrudeBuilding with floors-only feature', () => {
    const result = extrudeBuilding(fixture.features[1], flatDEM);
    if (result.topElev !== 109) throw new Error(`topElev: expected 109 (100+9), got ${result.topElev}`);
    if (result.walls.length !== 4) throw new Error(`walls: expected 4, got ${result.walls.length}`);
  });

  check('extrudeBuilding with no height info defaults to 6m', () => {
    const result = extrudeBuilding(fixture.features[2], flatDEM);
    if (result.topElev !== 106) throw new Error(`topElev: expected 106 (100+6), got ${result.topElev}`);
  });

  // DEM snapping: min elevation across footprint
  check('extrudeBuilding snaps to min DEM elevation', () => {
    // Create a DEM that varies across the footprint
    const slopeDEM = (lon, lat) => 100 + (lon + 122.42) * 1000;
    const result = extrudeBuilding(fixture.features[0], slopeDEM);
    // Feature coords: lon from -122.4194 to -122.4190
    // Elevations: 100 + (-122.4194+122.42)*1000 = 100.6, up to 101.0
    // Min should be ~100.6
    if (Math.abs(result.baseElev - 100.6) > 0.1) throw new Error(`baseElev should be ~100.6, got ${result.baseElev}`);
    if (Math.abs(result.topElev - (result.baseElev + 25)) > 1e-6) throw new Error(`topElev should be baseElev+25`);
  });

  // DEM with NaN/null: should fallback to 0
  check('extrudeBuilding falls back to 0 when DEM returns null', () => {
    const nullDEM = () => null;
    const result = extrudeBuilding(fixture.features[0], nullDEM);
    if (result.baseElev !== 0) throw new Error(`baseElev: expected 0, got ${result.baseElev}`);
    if (result.topElev !== 25) throw new Error(`topElev: expected 25, got ${result.topElev}`);
  });

  // Wall normals are unit vectors in 2D
  check('wall facingNormal is unit-length in XY', () => {
    const result = extrudeBuilding(fixture.features[0], flatDEM);
    for (const wall of result.walls) {
      const [nx, ny, nz] = wall.facingNormal;
      const len = Math.sqrt(nx * nx + ny * ny);
      if (nz !== 0) throw new Error(`normal Z should be 0, got ${nz}`);
      if (Math.abs(len - 1) > 1e-6) throw new Error(`normal length should be 1, got ${len}`);
    }
  });

  // Wall vertex count: each wall has p0, p1
  check('each wall has p0 and p1 with 2 coordinates', () => {
    const result = extrudeBuilding(fixture.features[0], flatDEM);
    for (const wall of result.walls) {
      if (wall.p0.length !== 2) throw new Error(`p0 should have 2 coords`);
      if (wall.p1.length !== 2) throw new Error(`p1 should have 2 coords`);
    }
  });

} catch (err) {
  skip('Overture Buildings loader tests', `import failed: ${err.message}`);
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
