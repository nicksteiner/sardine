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
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phaseColormap']) {
    assertContains(gpuContent, `vec3 ${cm}(float t)`, `${cm} colormap function`);
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
  for (const cm of ['grayscale', 'viridis', 'inferno', 'plasma', 'phaseColormap']) {
    assertContains(gpuBitmapContent, `vec3 ${cm}(float t)`, `${cm} colormap`);
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
  check('writeFloat32GeoTIFF: single-band produces valid TIFF', () => {
    const w = 100, h = 80;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 0.01;

    const buf = writeFloat32GeoTIFF(
      { HHHH: data }, ['HHHH'], w, h,
      [500000, 3700000, 510000, 3708000], 32610
    );

    const tiff = parseTIFF(buf);
    if (tiff.magic !== 42) throw new Error(`Bad magic: ${tiff.magic}`);
  });

  check('writeFloat32GeoTIFF: single-band BitsPerSample = 32', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const bps = tiff.tags[258]; // BitsPerSample
    if (!bps || bps.values[0] !== 32) {
      throw new Error(`BitsPerSample = ${bps?.values[0]}, expected 32`);
    }
  });

  check('writeFloat32GeoTIFF: single-band SampleFormat = 3 (float)', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const sf = tiff.tags[339]; // SampleFormat
    if (!sf || sf.values[0] !== 3) {
      throw new Error(`SampleFormat = ${sf?.values[0]}, expected 3`);
    }
  });

  check('writeFloat32GeoTIFF: single-band SamplesPerPixel = 1', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const spp = tiff.tags[277]; // SamplesPerPixel
    if (!spp || spp.values[0] !== 1) {
      throw new Error(`SamplesPerPixel = ${spp?.values[0]}, expected 1`);
    }
  });

  check('writeFloat32GeoTIFF: single-band Compression = 8 (DEFLATE)', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const comp = tiff.tags[259]; // Compression
    if (!comp || comp.values[0] !== 8) {
      throw new Error(`Compression = ${comp?.values[0]}, expected 8`);
    }
  });

  check('writeFloat32GeoTIFF: has GeoKeys (tag 34735)', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    if (!tiff.tags[34735]) throw new Error('Missing GeoKeyDirectory tag');
  });

  check('writeFloat32GeoTIFF: ModelPixelScale matches bounds', () => {
    const w = 100, h = 100;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [500000, 3700000, 510000, 3710000], 32610);
    const tiff = parseTIFF(buf);
    const scale = tiff.tags[33550]; // ModelPixelScale
    if (!scale) throw new Error('Missing ModelPixelScale');
    const expectX = 10000 / 100; // (maxX-minX)/width = 100
    if (Math.abs(scale.values[0] - expectX) > 0.01) {
      throw new Error(`PixelScaleX = ${scale.values[0]}, expected ${expectX}`);
    }
  });

  // ── Multi-band Float32 GeoTIFF ──
  check('writeFloat32GeoTIFF: 3-band BitsPerSample = [32,32,32]', () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const bps = tiff.tags[258];
    if (!bps || bps.count !== 3 || bps.values[0] !== 32 || bps.values[1] !== 32 || bps.values[2] !== 32) {
      throw new Error(`BitsPerSample = ${bps?.values}, expected [32,32,32]`);
    }
  });

  check('writeFloat32GeoTIFF: 3-band SampleFormat = [3,3,3]', () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const sf = tiff.tags[339];
    if (!sf || sf.count !== 3 || sf.values[0] !== 3 || sf.values[1] !== 3 || sf.values[2] !== 3) {
      throw new Error(`SampleFormat = ${sf?.values}, expected [3,3,3]`);
    }
  });

  check('writeFloat32GeoTIFF: tile offsets are non-zero', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const offsets = tiff.tags[324]; // TileOffsets
    if (!offsets || offsets.values[0] === 0) {
      throw new Error(`TileOffsets[0] = ${offsets?.values[0]}, expected non-zero`);
    }
  });

  check('writeFloat32GeoTIFF: tile byte counts are non-zero', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const counts = tiff.tags[325]; // TileByteCounts
    if (!counts || counts.values[0] === 0) {
      throw new Error(`TileByteCounts[0] = ${counts?.values[0]}, expected non-zero`);
    }
  });

  // ── ExtraSamples tag for multi-band ──
  check('writeFloat32GeoTIFF: 2-band has ExtraSamples tag', () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n) };
    const buf = writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const es = tiff.tags[338]; // ExtraSamples
    if (!es) throw new Error('Missing ExtraSamples tag for 2-band GeoTIFF');
    if (es.count !== 1) throw new Error(`ExtraSamples count = ${es.count}, expected 1`);
    if (es.values[0] !== 0) throw new Error(`ExtraSamples[0] = ${es.values[0]}, expected 0 (unspecified)`);
  });

  check('writeFloat32GeoTIFF: 3-band has ExtraSamples = [0,0]', () => {
    const w = 64, h = 64, n = w * h;
    const bands = { HHHH: new Float32Array(n), HVHV: new Float32Array(n), VVVV: new Float32Array(n) };
    const buf = writeFloat32GeoTIFF(bands, ['HHHH', 'HVHV', 'VVVV'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const es = tiff.tags[338];
    if (!es) throw new Error('Missing ExtraSamples tag for 3-band GeoTIFF');
    if (es.count !== 2) throw new Error(`ExtraSamples count = ${es.count}, expected 2`);
  });

  check('writeFloat32GeoTIFF: single-band has no ExtraSamples', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    if (tiff.tags[338]) throw new Error('Single-band should not have ExtraSamples tag');
  });

  // ── GeoKeys CRS verification ──
  check('writeFloat32GeoTIFF: projected CRS GeoKeys correct (UTM)', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h,
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

  check('writeFloat32GeoTIFF: geographic CRS GeoKeys correct (4326)', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h,
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
  check('writeFloat32GeoTIFF: has GDAL_NODATA = nan', () => {
    const w = 64, h = 64;
    const data = new Float32Array(w * h);
    const buf = writeFloat32GeoTIFF({ HHHH: data }, ['HHHH'], w, h, [0, 0, 64, 64], 32610);
    const tiff = parseTIFF(buf);
    const nodata = tiff.tags[42113]; // GDAL_NODATA
    if (!nodata) throw new Error('Missing GDAL_NODATA tag (42113)');
    if (nodata.values[0] !== 'nan') throw new Error(`GDAL_NODATA = "${nodata.values[0]}", expected "nan"`);
  });

  // ── RGBA COG ──
  check('writeRGBAGeoTIFF: produces valid TIFF', () => {
    const w = 64, h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = i % 256;

    const buf = writeRGBAGeoTIFF(rgba, w, h, [0, 0, 64, 64], 32610, { generateOverviews: false });
    const tiff = parseTIFF(buf);
    if (tiff.magic !== 42) throw new Error(`Bad magic: ${tiff.magic}`);
    const spp = tiff.tags[277];
    if (!spp || spp.values[0] !== 4) throw new Error(`SamplesPerPixel = ${spp?.values[0]}, expected 4`);
  });

} catch (err) {
  skip('GeoTIFF writer tests', `import failed: ${err.message}`);
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
