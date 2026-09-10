#!/usr/bin/env node
/**
 * lint-tokens.mjs — W027 token-layer lint.  `npm run lint:tokens`.
 *
 * A lint rule prevents recurrence far more cheaply than any individual fix.
 * The design system was well-conceived but unenforced: ~90% of spacing, ~50%
 * of colour and 100% of type sizing were decided inline at the point of use.
 * This guards the parts that are now clean so they stay clean.
 *
 * Rules (each fails the build):
 *   1. no px/numeric font sizes in JSX  — px ignores the user's font-size
 *      preference; use --text-* which is rem.
 *   2. no sub-11px font sizes anywhere  — the audited floor.
 *   3. --ink-faint is never used as a text colour — it is 2.94:1, below AA by
 *      design, and exists for rules and disabled fills only.
 *   4. no undefined design tokens       — var(--x) must resolve in the theme.
 *   5. no CDN stylesheets in app/index.html — "no server required" is the pitch.
 *
 * NOT linted yet: bare hex in JSX style objects.  79 remain and they are
 * replaced component-by-component as W028 moves each onto primitives; failing
 * on them today would only mean 79 mechanical edits that W028 redoes.  The
 * count is reported so it can only go down.
 *
 * Zero dependencies — plain node + regex, run from the repo root.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = join(repoRoot, 'src', 'theme', 'sardine-theme.css');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'lite']);

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some(e => entry.endsWith(e))) out.push(p);
  }
  return out;
}

const sourceFiles = [
  ...walk(join(repoRoot, 'app'), ['.js', '.jsx']),
  ...walk(join(repoRoot, 'src'), ['.js', '.jsx']),
];
const cssFiles = [
  ...walk(join(repoRoot, 'src', 'theme'), ['.css']),
];

const violations = [];
const notes = [];

function report(file, line, rule, detail) {
  violations.push(`${relative(repoRoot, file)}:${line}  [${rule}] ${detail}`);
}

function eachLine(file, fn) {
  readFileSync(file, 'utf8').split('\n').forEach((text, i) => fn(text, i + 1));
}

// ── 1 & 2. type sizing ──────────────────────────────────────────────────────
// Canvas drawing sizes numbers for ctx.font in device px; those are geometry,
// not chrome type, so only style-object font sizes are linted.
const CANVAS_FILES = new Set(['src/utils/annotation-render.js']);

for (const file of sourceFiles) {
  const rel = relative(repoRoot, file);
  eachLine(file, (text, line) => {
    if (!CANVAS_FILES.has(rel)) {
      const px = text.match(/fontSize: *['"]?(\d+(?:\.\d+)?)(px)?['"]?[,\s}]/);
      if (px && (px[2] || !text.includes('var('))) {
        report(file, line, 'type/no-px', `fontSize ${px[1]}${px[2] || ''} — use var(--text-*), which is rem`);
      }
    }
    const rem = text.match(/font-?[sS]ize: *['"]?(\d*\.?\d+)rem/);
    if (rem && parseFloat(rem[1]) * 16 < 11 - 1e-9) {
      report(file, line, 'type/floor-11px', `${rem[1]}rem is below the 11px floor — use var(--text-xs)`);
    }
  });
}

for (const file of cssFiles) {
  eachLine(file, (text, line) => {
    if (/^\s*--text-/.test(text)) return;   // the scale's own declarations
    const rem = text.match(/font-size: *(\d*\.?\d+)rem/);
    if (rem && parseFloat(rem[1]) * 16 < 11 - 1e-9) {
      report(file, line, 'type/floor-11px', `${rem[1]}rem is below the 11px floor`);
    }
    const px = text.match(/font-size: *(\d+)px/);
    if (px) report(file, line, 'type/no-px', `font-size ${px[1]}px — use var(--text-*)`);
  });
}

// ── 3. --ink-faint must never carry text ────────────────────────────────────
const TEXT_PROP = /(?:^|[^-\w])(color|colour)\s*[:=]/i;
for (const file of [...sourceFiles, ...cssFiles]) {
  eachLine(file, (text, line) => {
    if (!text.includes('--ink-faint')) return;
    if (/^\s*--ink-faint\s*:/.test(text)) return;                 // declaration
    if (/--(?:text-disabled|sardine-text-disabled)\s*:/.test(text)) return; // alias
    const idx = text.indexOf('--ink-faint');
    if (TEXT_PROP.test(text.slice(0, idx))) {
      report(file, line, 'color/ink-faint-is-not-text',
        '--ink-faint is 2.94:1 (below AA) and is for rules and disabled fills only');
    }
  });
}

// ── 4. every referenced token is defined ────────────────────────────────────
const themeCss = readFileSync(THEME, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const defined = new Set([...themeCss.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const RUNTIME_SUPPLIED = new Set(['--bottom-dock']);   // set by components inline

for (const file of [...sourceFiles, ...cssFiles]) {
  eachLine(file, (text, line) => {
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      const [, token, next] = m;
      if (defined.has(token) || RUNTIME_SUPPLIED.has(token)) continue;
      if (next === ',') continue;    // has an explicit fallback — degrades cleanly
      report(file, line, 'token/undefined', `var(${token}) is not defined in sardine-theme.css`);
    }
  });
}

// ── 5. no CDN stylesheets in the app shell ──────────────────────────────────
const indexHtml = join(repoRoot, 'app', 'index.html');
eachLine(indexHtml, (text, line) => {
  if (/rel=["']stylesheet["']/.test(text) || /unpkg\.com|cdn\.jsdelivr\.net|cdnjs/.test(text)) {
    if (/unpkg\.com|jsdelivr|cdnjs/.test(text)) {
      report(indexHtml, line, 'shell/no-cdn-css',
        'load it from the local package — "no server required" is the pitch');
    }
  }
});

// ── informational: bare hex in JSX style objects (W028 territory) ───────────
let bareHex = 0;
for (const file of sourceFiles) {
  if (!file.endsWith('.jsx') && !file.endsWith('main.jsx')) continue;
  eachLine(file, (text) => {
    for (const _ of text.matchAll(/(?:color|background|backgroundColor|borderColor|fill|stroke): *['"]#[0-9a-fA-F]{3,8}['"]/g)) bareHex++;
  });
}
notes.push(`bare hex colours in component style objects: ${bareHex} (W028 replaces these; this count must not grow)`);

// ── report ──────────────────────────────────────────────────────────────────
console.log('lint:tokens — W027 design token layer\n');
for (const note of notes) console.log(`  note: ${note}`);
if (violations.length === 0) {
  console.log(`\n✓ token lint passed (${sourceFiles.length} source + ${cssFiles.length} css files)`);
  process.exit(0);
}
console.error(`\n✗ ${violations.length} token violation(s):\n`);
for (const v of violations) console.error(`  ${v}`);
process.exit(1);
