#!/usr/bin/env node
/**
 * ui-primitives.test.mjs — W028.
 *
 * The primitives are the reference implementation for the whole app's
 * chrome, so the properties that make them worth having are asserted here
 * rather than left to review: they exist, they are token-pure, they carry
 * no bare hex or px type, and Button's default variant is `secondary`.
 *
 * The last one is the load-bearing assertion.  The default is what delivers
 * visual hierarchy — if it ever flips back to `primary`, every unclassed
 * button becomes a solid accent CTA again and the wall-of-buttons returns.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiDir = join(repoRoot, 'src', 'components', 'ui');
const themeCss = readFileSync(join(repoRoot, 'src', 'theme', 'sardine-theme.css'), 'utf8');

const { test, assert, run } = suite('ui primitives (W028)');
const files = readdirSync(uiDir);
const read = (f) => readFileSync(join(uiDir, f), 'utf8');

test('the six primitives plus their stylesheet exist', () => {
  for (const f of ['Button.jsx', 'Field.jsx', 'Section.jsx', 'Panel.jsx',
                   'Toolbar.jsx', 'Dialog.jsx', 'ui.css', 'index.js']) {
    assert.ok(files.includes(f), `src/components/ui/${f} is missing`);
  }
});

test('index.js exports every primitive', () => {
  const idx = read('index.js');
  for (const name of ['Button', 'Field', 'Section', 'Panel', 'Toolbar', 'Dialog']) {
    assert.match(idx, new RegExp(`\\b${name}\\b`), `${name} is not exported`);
  }
});

test('no bare hex colours anywhere in src/components/ui/', () => {
  for (const f of files) {
    const hex = [...read(f).matchAll(/(?:color|colour|background|backgroundColor|border|borderColor|fill|stroke)\s*[:=]\s*['"]?#[0-9a-fA-F]{3,8}/g)];
    assert.equal(hex.length, 0, `${f} carries bare hex: ${hex.map(m => m[0]).join(', ')}`);
  }
});

test('no px font sizes anywhere in src/components/ui/', () => {
  for (const f of files) {
    const px = [...read(f).matchAll(/font-?[sS]ize\s*[:=]\s*['"]?\d+(\.\d+)?px/g)];
    assert.equal(px.length, 0, `${f} sizes type in px: ${px.map(m => m[0]).join(', ')}`);
  }
});

test('every var() the primitives use is defined in the theme', () => {
  const declared = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]);
  const defined = new Set(declared(themeCss));
  for (const f of files) {
    const src = read(f);
    // A primitive may declare its own local custom property (a variant hook);
    // what it may not do is reference a token nothing defines.
    const scope = new Set([...defined, ...declared(src)]);
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      assert.ok(scope.has(m[1]), `${f} uses undefined token var(${m[1]})`);
    }
  }
});

test("Button's default variant is secondary, not primary", () => {
  assert.match(read('Button.jsx'), /variant\s*=\s*'secondary'/,
    "Button must default to 'secondary' — a primary default is what produced the wall of equal-weight CTAs");
});

test('the global button rule is reset-level, not a CTA', () => {
  const rule = themeCss.match(/\nbutton\s*\{([\s\S]*?)\}/);
  assert.ok(rule, 'the global button rule should still exist as a reset');
  const body = rule[1];
  assert.ok(!/background:\s*var\(--sardine-cyan\)/.test(body),
    'the global button rule must not fill with the accent — that belongs to .btn--primary');
  assert.ok(!/text-transform:\s*uppercase/.test(body),
    'the global button rule must not impose CTA typography on every button');
});

test('.btn--primary carries the CTA styling the global rule gave up', () => {
  const rule = themeCss.match(/\.btn--primary\s*\{([\s\S]*?)\}/)
    || readFileSync(join(uiDir, 'ui.css'), 'utf8').match(/\.btn--primary\s*\{([\s\S]*?)\}/);
  assert.ok(rule, '.btn--primary must exist');
  assert.match(rule[1], /background:\s*var\(--sardine-cyan\)/);
});

test('the theme carries no !important escapes', () => {
  const hits = themeCss.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('!important'));
  assert.equal(hits.length, 0,
    `!important remains at line(s) ${hits.map(([n]) => n).join(', ')} — a primitive should never need to be escaped`);
});

test('Field wires htmlFor to a generated id', () => {
  const src = read('Field.jsx');
  assert.match(src, /useId/, 'Field must generate an id');
  assert.match(src, /htmlFor=\{id\}/, 'Field must point the label at the control');
});

test('Dialog is a real modal: role, aria-modal, Escape, focus restore', () => {
  const src = read('Dialog.jsx');
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /'Escape'/);
  assert.match(src, /restoreRef/, 'Dialog must restore focus to the opener on close');
});

test('Section and Panel render real headings', () => {
  assert.match(read('Section.jsx'), /h\$\{level\}|`h\$\{level\}`/, 'Section must render a heading element');
  assert.match(read('Panel.jsx'), /h\$\{level\}|`h\$\{level\}`/, 'Panel must render a heading element');
});

test('one close glyph, exported for the whole app', () => {
  const src = read('Button.jsx');
  assert.match(src, /CLOSE_GLYPH\s*=\s*'✕'/);
});

await run();
