/**
 * theme-mirror.test.mjs — W027: the enforcement that was missing.
 *
 * src/utils/theme-tokens.js claims to mirror src/theme/sardine-theme.css. It
 * had silently drifted on 10 of 10 dark surface/text values because nothing
 * checked. This test parses the stylesheet's `:root` and `[data-theme="light"]`
 * blocks, resolves `var()` aliases, and asserts every mirrored key matches —
 * failing loudly on drift in EITHER direction.
 *
 * Authority direction is CSS → JS: when this fails, the CSS is right unless
 * someone deliberately changed the JS first.
 *
 * Run: node test/unit/theme-mirror.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { suite } from './harness.mjs';
import {
  DARK, LIGHT, CSS_VAR_MAP, FONTS, FONT_VAR_MAP, TEXT, SPACE, Z, OVERLAY,
} from '../../src/utils/theme-tokens.js';

const { test, assert, run } = suite('theme-mirror (W027)');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssPath = join(repoRoot, 'src', 'theme', 'sardine-theme.css');
const css = readFileSync(cssPath, 'utf8');

// ---------------------------------------------------------------------------
// Minimal custom-property extraction. Comments are stripped first so a token
// mentioned inside a /* … */ note cannot masquerade as a declaration.
// ---------------------------------------------------------------------------

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Custom properties declared in the first block matching `selector`. */
function blockTokens(selector) {
  const bare = stripComments(css);
  const at = bare.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in sardine-theme.css: ${selector}`);
  const open = bare.indexOf('{', at);
  const close = bare.indexOf('}', open);
  if (open === -1 || close === -1) throw new Error(`unterminated block: ${selector}`);
  const body = bare.slice(open + 1, close);
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const ROOT = blockTokens(':root');
const LIGHT_BLOCK = blockTokens('[data-theme="light"]');
const SARDINE_BLOCK = blockTokens('[data-theme="sardine"]');

/**
 * Resolve a custom property to a literal, following `var(--other)` aliases.
 * A theme block inherits anything it does not override from `:root`.
 */
function resolve(prop, block, depth = 0) {
  if (depth > 10) throw new Error(`var() cycle resolving ${prop}`);
  const raw = block[prop] ?? ROOT[prop];
  if (raw === undefined) throw new Error(`token not defined in sardine-theme.css: ${prop}`);
  const alias = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (alias) return resolve(alias[1], block, depth + 1);
  return raw;
}

/** '#ABC' → '#aabbcc'; '4px' → 4 stays a string here, normalised by caller. */
function normHex(value) {
  const v = String(value).trim().toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return v;
}

function expectedLiteral(jsValue) {
  // Numeric tokens (radii) are px in CSS.
  return typeof jsValue === 'number' ? `${jsValue}px` : normHex(jsValue);
}

function checkTheme(label, jsTheme, block) {
  const mismatches = [];
  for (const [key, prop] of Object.entries(CSS_VAR_MAP)) {
    const actual = normHex(resolve(prop, block));
    const expected = expectedLiteral(jsTheme[key]);
    if (actual !== expected) {
      mismatches.push(`  ${label}.${key}  JS ${expected}  ≠  CSS ${prop} ${actual}`);
    }
  }
  assert.equal(
    mismatches.length, 0,
    `theme-tokens.js has drifted from sardine-theme.css (CSS is authoritative):\n${mismatches.join('\n')}`,
  );
}

// ---------------------------------------------------------------------------

test('every DARK key resolves to the same value as :root', () => {
  checkTheme('DARK', DARK, ROOT);
});

test('every LIGHT key resolves to the same value as [data-theme="light"]', () => {
  checkTheme('LIGHT', LIGHT, LIGHT_BLOCK);
});

test('the mirror covers every key of DARK and LIGHT (no silent omissions)', () => {
  const mapped = new Set(Object.keys(CSS_VAR_MAP));
  for (const [label, theme] of [['DARK', DARK], ['LIGHT', LIGHT]]) {
    const unmapped = Object.keys(theme).filter(k => !mapped.has(k));
    assert.deepEqual(unmapped, [], `${label} keys missing from CSS_VAR_MAP: ${unmapped.join(', ')}`);
  }
});

test('DARK and LIGHT declare the same key set', () => {
  assert.deepEqual(Object.keys(DARK).sort(), Object.keys(LIGHT).sort());
});

test('font stacks mirror the CSS font tokens', () => {
  const squash = s => s.replace(/\s+/g, ' ').trim();
  for (const [key, prop] of Object.entries(FONT_VAR_MAP)) {
    assert.equal(squash(resolve(prop, ROOT)), squash(FONTS[key]), `font stack drift: ${prop}`);
  }
});

test('every font stack ends in a generic family (air-gapped fallback)', () => {
  const generics = ['monospace', 'sans-serif', 'serif', 'system-ui', 'cursive'];
  for (const [key, stack] of Object.entries(FONTS)) {
    const last = stack.split(',').pop().trim().replace(/['"]/g, '');
    assert.ok(generics.includes(last), `FONTS.${key} has no generic fallback (ends "${last}")`);
  }
});

test('the type scale mirrors --text-* and holds an 11px floor, rem only', () => {
  for (const [key, value] of Object.entries(TEXT)) {
    assert.equal(resolve(`--text-${key}`, ROOT), value, `type scale drift: --text-${key}`);
    assert.ok(value.endsWith('rem'), `--text-${key} must be rem, got ${value}`);
    assert.ok(parseFloat(value) * 16 >= 11 - 1e-9, `--text-${key} is below the 11px floor`);
  }
});

test('the spacing scale mirrors --space-*', () => {
  for (const [key, px] of Object.entries(SPACE)) {
    assert.equal(resolve(`--space-${key}`, ROOT), `${px}px`, `spacing drift: --space-${key}`);
  }
});

test('the z scale mirrors --z-*', () => {
  for (const [key, value] of Object.entries(Z)) {
    assert.equal(resolve(`--z-${key}`, ROOT), String(value), `z-scale drift: --z-${key}`);
  }
});

test('overlay ink/halo pair mirrors the CSS and is defined for imagery use', () => {
  assert.equal(normHex(resolve('--overlay-ink', ROOT)), normHex(OVERLAY.ink));
  assert.equal(resolve('--overlay-halo', ROOT).replace(/\s+/g, ''), OVERLAY.halo.replace(/\s+/g, ''));
});

test('the navy [data-theme="sardine"] variant defines the full ink ramp', () => {
  for (const prop of ['--ink', '--ink-soft', '--ink-muted', '--ink-faint']) {
    assert.ok(SARDINE_BLOCK[prop], `[data-theme="sardine"] does not override ${prop}`);
  }
});

test('every var() referenced by the stylesheet itself is defined somewhere', () => {
  const bare = stripComments(css);
  const referenced = new Set([...bare.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
  // Set at runtime by components rather than declared in the stylesheet.
  const runtimeSupplied = new Set(['--bottom-dock']);
  const known = new Set([
    ...Object.keys(ROOT), ...Object.keys(LIGHT_BLOCK), ...Object.keys(SARDINE_BLOCK),
    ...runtimeSupplied,
  ]);
  const missing = [...referenced].filter(p => !known.has(p)).sort();
  assert.deepEqual(missing, [], `undefined tokens referenced in sardine-theme.css: ${missing.join(', ')}`);
});

await run();
