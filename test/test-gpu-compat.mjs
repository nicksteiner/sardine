#!/usr/bin/env node
/**
 * Headless GPU compatibility test using Puppeteer.
 *
 * Validates WebGL2 + float texture support in a real browser environment.
 * Works on Linux (headless Chromium) and macOS (headed or headless).
 *
 * Usage:
 *   node test/test-gpu-compat.mjs              # auto-detect
 *   node test/test-gpu-compat.mjs --software   # force SwiftShader (CI)
 */

import { execSync } from 'child_process';
import { platform, arch } from 'os';

const useSoftware = process.argv.includes('--software');

let puppeteer;
try {
  puppeteer = await import('puppeteer');
} catch {
  console.error('Puppeteer not installed. Run: npm install');
  process.exit(1);
}

const os = platform();
const cpu = arch();
console.log(`\n══════════════════════════════════════════════`);
console.log(`  GPU Compatibility Test`);
console.log(`  Platform: ${os} ${cpu}`);
console.log(`══════════════════════════════════════════════\n`);

// Platform-specific Chromium flags
const args = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

if (useSoftware) {
  // SwiftShader: software WebGL2 renderer bundled with Chromium
  // Modern Chrome (v112+) uses --use-angle=swiftshader instead of --use-gl
  args.push('--use-gl=swiftshader', '--use-angle=swiftshader');
  console.log('  Mode: SwiftShader (software WebGL2)\n');
} else if (os === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  // Headless Linux without display — use SwiftShader automatically
  args.push('--use-gl=swiftshader', '--use-angle=swiftshader');
  console.log('  Mode: SwiftShader (no display detected)\n');
} else {
  console.log('  Mode: hardware GPU\n');
}

const browser = await puppeteer.default.launch({
  headless: 'new',
  args,
});

const page = await browser.newPage();

// Inject GPU probe directly (no server needed)
const results = await page.evaluate(() => {
  const report = {
    webgl2: false,
    renderer: null,
    vendor: null,
    maxTextureSize: 0,
    floatTextures: false,
    floatLinear: false,
    r32fUpload: false,
    r32fRender: false,
    shaderCompile: false,
    errors: [],
  };

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      report.errors.push('WebGL2 context creation failed');
      return report;
    }
    report.webgl2 = true;

    // GPU info
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      report.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      report.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
    }
    report.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // Float texture extensions
    report.floatTextures = !!gl.getExtension('EXT_color_buffer_float');
    report.floatLinear = !!gl.getExtension('OES_texture_float_linear');

    // Test R32F texture upload (core SARdine requirement)
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const testData = new Float32Array(64 * 64);
    for (let i = 0; i < testData.length; i++) testData[i] = Math.random();

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 64, 64, 0, gl.RED, gl.FLOAT, testData);
    const uploadErr = gl.getError();
    report.r32fUpload = uploadErr === gl.NO_ERROR;
    if (!report.r32fUpload) {
      report.errors.push(`R32F texImage2D error: 0x${uploadErr.toString(16)}`);
    }

    // Test render-to-framebuffer with R32F (needed for readback)
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    report.r32fRender = fbStatus === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);

    // Test shader compilation (SARdine's fragment shader pattern)
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es
      in vec4 position;
      void main() { gl_Position = position; }
    `);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uMin, uMax;
      out vec4 fragColor;
      void main() {
        float amplitude = texelFetch(uTexture, ivec2(0), 0).r;
        float db = 10.0 * log2(max(amplitude, 1e-10)) * 0.30103;
        float t = clamp((db - uMin) / (uMax - uMin), 0.0, 1.0);
        t = sqrt(t);
        fragColor = vec4(vec3(t), 1.0);
      }
    `);
    gl.compileShader(fs);

    const vsOk = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
    const fsOk = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
    report.shaderCompile = vsOk && fsOk;

    if (!vsOk) report.errors.push('Vertex shader: ' + gl.getShaderInfoLog(vs));
    if (!fsOk) report.errors.push('Fragment shader: ' + gl.getShaderInfoLog(fs));

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const loseExt = gl.getExtension('WEBGL_lose_context');
    if (loseExt) loseExt.loseContext();

  } catch (e) {
    report.errors.push(e.message);
  }

  return report;
});

await browser.close();

// Report
const checks = [
  ['WebGL2 context',           results.webgl2],
  ['EXT_color_buffer_float',   results.floatTextures],
  ['OES_texture_float_linear', results.floatLinear],
  ['R32F texture upload',      results.r32fUpload],
  ['R32F framebuffer render',  results.r32fRender],
  ['Shader compilation',       results.shaderCompile],
];

let passed = 0;
let failed = 0;

console.log(`  GPU:  ${results.renderer || 'unknown'}`);
console.log(`  Vendor: ${results.vendor || 'unknown'}`);
console.log(`  Max texture: ${results.maxTextureSize}x${results.maxTextureSize}`);
console.log('');

for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) passed++; else failed++;
}

if (results.errors.length > 0) {
  console.log('\n  Errors:');
  for (const e of results.errors) console.log(`    ${e}`);
}

// SARdine compatibility verdict
const gpuOk = results.webgl2 && results.floatTextures && results.r32fUpload && results.shaderCompile;
const cpuFallback = results.webgl2 && !results.floatTextures;

console.log('\n──────────────────────────────────────────────');
if (gpuOk) {
  console.log('  RESULT: GPU rendering supported (full SARGPULayer)');
} else if (cpuFallback) {
  console.log('  RESULT: CPU fallback only (SARBitmapLayer)');
  console.log('          Missing float textures — GPU path disabled');
} else {
  console.log('  RESULT: WebGL2 not available — SARdine will not render');
}
console.log(`  ${passed}/${checks.length} checks passed`);
console.log('──────────────────────────────────────────────\n');

process.exit(failed > 0 ? 1 : 0);
