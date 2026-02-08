#!/usr/bin/env node

/**
 * Quick validation script - runs basic checks without browser
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

console.log('\n🔍 Running quick validation checks...\n');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   ${err.message}`);
    failed++;
  }
}

// Test 1: Required files exist
check('SARGPULayer.js exists', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
});

check('shaders.js exists', () => {
  const path = join(rootDir, 'src/layers/shaders.js');
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
});

// Test 2: Imports are valid
check('SARGPULayer imports are valid', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');

  // Check for required imports
  if (!content.includes('import { Layer')) throw new Error('Missing Layer import');
  if (!content.includes('project32')) throw new Error('Missing project32 import');
  if (!content.includes('Texture2D')) throw new Error('Missing Texture2D import');
  if (!content.includes('getColormapId')) throw new Error('Missing getColormapId import');
});

// Test 3: Super calls are present
check('super.initializeState() is called', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');
  if (!content.includes('super.initializeState()')) {
    throw new Error('Missing super.initializeState() call!');
  }
});

check('super.finalizeState() is called', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');
  if (!content.includes('super.finalizeState()')) {
    throw new Error('Missing super.finalizeState() call');
  }
});

// Test 4: Shader syntax
check('Vertex shader has required attributes', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');

  if (!content.includes('in vec3 positions')) throw new Error('Missing positions attribute');
  if (!content.includes('in vec2 texCoords')) throw new Error('Missing texCoords attribute');
  if (!content.includes('gl_Position')) throw new Error('Missing gl_Position assignment');
});

check('Fragment shader has required uniforms', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');

  if (!content.includes('uniform sampler2D uTexture')) throw new Error('Missing uTexture uniform');
  if (!content.includes('uniform float uMin')) throw new Error('Missing uMin uniform');
  if (!content.includes('uniform float uMax')) throw new Error('Missing uMax uniform');
});

// Test 5: Exported correctly
check('SARGPULayer is exported from index.js', () => {
  const path = join(rootDir, 'src/index.js');
  const content = readFileSync(path, 'utf8');

  if (!content.includes('SARGPULayer')) throw new Error('SARGPULayer not exported');
});

// Test 6: No syntax errors (basic check)
check('No obvious syntax errors in SARGPULayer', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');

  // Check for common syntax errors
  const openBraces = (content.match(/{/g) || []).length;
  const closeBraces = (content.match(/}/g) || []).length;

  if (openBraces !== closeBraces) {
    throw new Error(`Mismatched braces: ${openBraces} open, ${closeBraces} close`);
  }
});

// Test 7: Required methods exist
check('SARGPULayer has getShaders() method', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');
  if (!content.includes('getShaders()')) throw new Error('Missing getShaders method');
});

check('SARGPULayer has draw() method', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');
  if (!content.includes('draw({')) throw new Error('Missing draw method');
});

check('SARGPULayer has updateState() method', () => {
  const path = join(rootDir, 'src/layers/SARGPULayer.js');
  const content = readFileSync(path, 'utf8');
  if (!content.includes('updateState({')) throw new Error('Missing updateState method');
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log('❌ Some checks failed. Please fix before testing in browser.\n');
  process.exit(1);
} else {
  console.log('✅ All quick validation checks passed!\n');
  console.log('Next steps:');
  console.log('  1. Run "npm run debug:gpu" to test in browser');
  console.log('  2. Or run "npm run test:layer" for full layer tests\n');
  process.exit(0);
}
