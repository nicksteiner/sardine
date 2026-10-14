/**
 * NaN never reaches the GPU: SARGPULayer rewrites it to a finite sentinel at
 * upload and the fragment shader tests `< -1e30` instead of isnan(), which
 * some GPU drivers optimise away (NaN nodata then rendered opaque black).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sanitizeNaN, NODATA_SENTINEL } from '../../src/layers/SARGPULayer.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../src/layers/SARGPULayer.js'), 'utf8');

test('sanitizeNaN returns the same array when there is no NaN', () => {
  const a = new Float32Array([0, 1.5, -2, 3e30]);
  assert.equal(sanitizeNaN(a), a);
});

test('sanitizeNaN copies and replaces every NaN with the sentinel', () => {
  const a = new Float32Array([NaN, 1, NaN, 0]);
  const out = sanitizeNaN(a);
  assert.notEqual(out, a, 'input is not mutated');
  assert.ok(Number.isNaN(a[0]), 'original keeps its NaN');
  assert.deepEqual([...out], [NODATA_SENTINEL, 1, NODATA_SENTINEL, 0]);
  assert.ok(Number.isFinite(out[0]) && out[0] < -1e30, 'sentinel is finite and below the shader threshold');
  assert.equal(Math.fround(NODATA_SENTINEL), NODATA_SENTINEL, 'sentinel is exactly representable in float32');
});

test('fragment shader has no isnan() call and tests the sentinel threshold', () => {
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const shaderCalls = code.match(/\bisnan\(/g) || [];
  assert.equal(shaderCalls.length, 0, 'isnan() is unreliable on some GPU drivers');
  assert.match(src, /bool isNodata\(float v\) \{ return v < -1\.0e30; \}/);
  assert.match(src, /texData = sanitizeNaN\(texData\);/, 'every R32F upload is sanitized');
});
