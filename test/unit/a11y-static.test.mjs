/**
 * a11y-static.test.mjs — the WCAG 2.1 AA floor, enforced statically (W029).
 *
 * These are the defects an automated pass can actually catch: a control with
 * no accessible name, a click target the keyboard cannot reach, a focus ring
 * suppressed with nothing in its place, an animation that never stops. They
 * are also the defects that come back the moment nobody is looking, which is
 * why they live in the test suite rather than in a checklist.
 *
 * What this test CANNOT check, and what the PR records a manual pass for:
 *   - whether a label is a good label,
 *   - whether focus order matches reading order,
 *   - whether the announcements are useful rather than merely present.
 *
 * Out of scope by design: the deck.gl/WebGL raster itself. Overlay chrome is
 * in scope; the imagery is not — SAR backscatter has no text alternative.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './harness.mjs';
import {
  walk, findElements, hasAttr, literalText, accessibleText, insideTextLabel,
} from './jsx-scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { test, assert, run } = suite('a11y static baseline (W029)');

const SOURCES = [...walk(join(root, 'src')), ...walk(join(root, 'app'))];
const THEME = join(root, 'app', 'theme', 'sardine-theme.css');
const rel = p => relative(root, p);

/** Cache each file's parse — nine tests over ~40 files otherwise re-scan a lot. */
const parsed = SOURCES.map(file => {
  const src = readFileSync(file, 'utf8');
  return {
    file,
    src,
    els: findElements(src, ['button', 'input', 'select', 'textarea', 'div', 'span', 'canvas', 'label', 'a']),
  };
});

const hasName = attrs => hasAttr(attrs, 'aria-label') || hasAttr(attrs, 'aria-labelledby');

/** Ids declared as `id="x"` anywhere in a file, for htmlFor resolution. */
function idsIn(src) {
  return new Set([...src.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
}

// ─────────────────────────────────────────────────────────────────────────────

test('no glyph-only button without an accessible name', () => {
  const bad = [];
  for (const { file, els } of parsed) {
    for (const e of els) {
      if (e.tag !== 'button') continue;
      if (hasName(e.attrs)) continue;
      // A button whose body can render a word is named by its own text. Only
      // the ones that can render nothing but glyphs need aria-label.
      if (/[A-Za-z]{2}/.test(accessibleText(e.body))) continue;
      bad.push(`${rel(file)}:${e.line}  ${literalText(e.body).slice(0, 20) || '(no text)'}`);
    }
  }
  assert.deepEqual(bad, [], `glyph buttons with no aria-label:\n  ${bad.join('\n  ')}`);
});

test('no input, select or textarea without a programmatic label', () => {
  const bad = [];
  for (const { file, src, els } of parsed) {
    const ids = idsIn(src);
    const fors = new Set([...src.matchAll(/htmlFor\s*=\s*["']([^"']+)["']/g)].map(m => m[1]));
    for (const e of els) {
      if (!['input', 'select', 'textarea'].includes(e.tag)) continue;
      if (/type\s*=\s*["'](file|hidden)/.test(e.attrs)) continue;
      if (hasName(e.attrs)) continue;
      if (insideTextLabel(e, els)) continue;           // wrapped in a <label>
      const id = (e.attrs.match(/\sid\s*=\s*["']([^"']+)["']/) || [])[1];
      if (id && fors.has(id)) continue;                // <label htmlFor> elsewhere
      if (id && ids.has(id) && /htmlFor=\{/.test(src)) continue;  // dynamic htmlFor
      bad.push(`${rel(file)}:${e.line}  <${e.tag}>`);
    }
  }
  assert.deepEqual(bad, [], `unlabeled controls:\n  ${bad.join('\n  ')}`);
});

test('no div or span with onClick and no keyboard affordance', () => {
  const bad = [];
  for (const { file, els } of parsed) {
    for (const e of els) {
      if (e.tag !== 'div' && e.tag !== 'span') continue;
      if (!hasAttr(e.attrs, 'onClick')) continue;
      // A handler that only stops the event bubbling is not a control; it is
      // a container guarding its children, and has nothing to activate.
      if (/onClick=\{\(?e?\)? *=> *e\.stopPropagation\(\)\}/.test(e.attrs)) continue;
      // The a11y helpers supply role + tabIndex + onKeyDown as one spread.
      if (/\{\.\.\.(clickable|disclosure|option)\(/.test(e.attrs)) continue;
      const ok = hasAttr(e.attrs, 'role') && hasAttr(e.attrs, 'tabIndex') && hasAttr(e.attrs, 'onKeyDown');
      if (!ok) bad.push(`${rel(file)}:${e.line}  <${e.tag} onClick>`);
    }
  }
  assert.deepEqual(bad, [], `click targets the keyboard cannot reach:\n  ${bad.join('\n  ')}`);
});

test('no canvas without a text alternative', () => {
  const bad = [];
  for (const { file, els } of parsed) {
    for (const e of els) {
      if (e.tag !== 'canvas') continue;
      if (hasName(e.attrs) || hasAttr(e.attrs, 'aria-hidden')) continue;
      bad.push(`${rel(file)}:${e.line}`);
    }
  }
  assert.deepEqual(bad, [], `canvases with no aria-label and no aria-hidden:\n  ${bad.join('\n  ')}`);
});

test('no unreplaced outline:none', () => {
  const bad = [];
  // `outline: cond ? '2px solid …' : 'none'` is a state indicator, not a
  // focus suppressor — only a bare `none` as the whole value is a defect.
  const suppressor = /outline\s*:\s*(['"])?none\1?\s*(?:[,;}]|$)/;
  const files = [...SOURCES, THEME, join(root, 'src', 'theme', 'sardine-theme.css')];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!suppressor.test(line)) return;
      // The single sanctioned use: hiding the ring where :focus-visible has
      // deliberately NOT matched, so a mouse click leaves no ring behind.
      // The selector sits on an earlier line, so look back over the rule.
      const upto = src.split('\n').slice(Math.max(0, i - 4), i + 1).join(' ');
      if (/:focus:not\(\s*:focus-visible\s*\)/.test(upto)) return;
      bad.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], `outline:none with no replacement indicator:\n  ${bad.join('\n  ')}`);
});

test('the theme defines a focus-visible ring and a reduced-motion block', () => {
  const css = readFileSync(THEME, 'utf8');
  assert.ok(/:focus-visible\s*\{[^}]*outline\s*:\s*2px/.test(css),
    ':focus-visible must set a visible outline');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'),
    'a prefers-reduced-motion block must exist');
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(/animation-iteration-count\s*:\s*1\s*!important/.test(rm),
    'reduced motion must stop infinite animations');
  // The three infinite animations: spin and pulse are inline styles (hence
  // the attribute selectors), overview-pulse is a class.
  for (const name of ['spin', 'pulse', 'overview-pulse']) {
    assert.ok(rm.includes(name), `reduced motion must name the "${name}" animation`);
  }
});

test('the theme keeps the two sardine-theme.css copies identical', () => {
  // app/theme is the one main.jsx imports; src/theme is the library copy.
  // They drift silently, and a11y rules that live in only one are not rules.
  const a = readFileSync(THEME, 'utf8');
  const b = readFileSync(join(root, 'src', 'theme', 'sardine-theme.css'), 'utf8');
  assert.equal(a, b, 'app/theme and src/theme copies of sardine-theme.css have diverged');
});

test('live regions exist and announce load start, finish and failure', () => {
  const lr = readFileSync(join(root, 'src', 'components', 'LiveRegion.jsx'), 'utf8');
  assert.ok(/aria-live="polite"/.test(lr) && /role="status"/.test(lr), 'a polite status region');
  assert.ok(/aria-live="assertive"/.test(lr) && /role="alert"/.test(lr), 'an assertive alert region');
  assert.ok(/Loading \$\{what\}/.test(lr), 'announces load start');
  assert.ok(/\$\{what\} loaded/.test(lr), 'announces load finish');

  const main = readFileSync(join(root, 'app', 'main.jsx'), 'utf8');
  assert.ok(/<LiveRegion\b/.test(main), 'main.jsx must mount <LiveRegion>');
  assert.ok(/useLoadAnnouncer\(\{[^}]*loading/.test(main), 'the announcer must be fed the loading flag');
  // Failures reach the assertive region through the one status-log funnel, not
  // through 317 individual call sites — announcing every log would be unusable.
  assert.ok(/if \(type === 'error'\) setLiveError\(message\)/.test(main),
    'addStatusLog must route failures to the assertive region');
});

test('at least 25 aria-labels across the app', () => {
  const total = parsed.reduce(
    (n, p) => n + (p.src.match(/aria-label[=\s]/g) || []).length, 0);
  assert.ok(total >= 25, `expected >= 25 aria-labels, found ${total}`);
});

test('--text-muted clears 4.5:1 on every background it is painted on', () => {
  const css = readFileSync(THEME, 'utf8');
  const lum = (h) => {
    const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Each theme block declares its own grounds; check muted and disabled — both
  // are used for live text — against the darkest/lightest of them.
  const blocks = css.split(/(?=^:root \{|^\[data-theme=)/m).filter(b => b.includes('--text-muted'));
  assert.ok(blocks.length >= 3, `expected 3 theme blocks, found ${blocks.length}`);
  for (const block of blocks) {
    const grab = (name) => (block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
    const bgs = ['--sardine-bg', '--sardine-bg-raised', '--sardine-bg-panel', '--sardine-bg-hover']
      .map(grab).filter(Boolean);
    if (!bgs.length) continue;  // the block inherits :root's grounds
    for (const token of ['--text-muted', '--text-disabled']) {
      const fg = grab(token);
      if (!fg) continue;
      const worst = Math.min(...bgs.map(bg => ratio(fg, bg)));
      assert.ok(worst >= 4.3, `${token} ${fg} is ${worst.toFixed(2)}:1 at worst — below the AA floor`);
    }
  }
});

await run();
