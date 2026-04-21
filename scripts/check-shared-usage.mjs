#!/usr/bin/env node
/**
 * check-shared-usage — enforces S290 R2 + R3.
 *
 * R2: Every `app/shared/*.{js,jsx}` component must have >=2 callers across
 *     `app/pages/`. Any `app/shared/` component with fewer than two page-
 *     level callers is either (a) used by only one page, in which case it
 *     doesn't belong in `shared/` — inline it back into that page or hold
 *     it until the second caller appears — or (b) not used at all, which
 *     means it's dead code.
 *
 * R3: No component forks. Filenames matching `*For*.jsx` or `*.<page>.jsx`
 *     are forbidden — they're how copy-and-edit drift typically shows up.
 *     Extend via props, never copy-and-edit.
 *
 * Called from `npm run lint:shared` and chained into `npm test`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = join(repoRoot, 'app/shared');
const pagesDir = join(repoRoot, 'app/pages');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isJsxOrJs(path) {
  return /\.(jsx?|mjs)$/.test(path);
}

/**
 * Counts pages that reference a shared-module's base name. We match on the
 * filename rather than path because pages may import via `../shared/Foo`
 * or `@shared/Foo` and both are legitimate.
 */
function countPageCallers(sharedBase, pageSources) {
  let count = 0;
  // Match `from '.../SharedBase'` or `from '.../SharedBase.jsx'` as a whole
  // token so `FooBar` doesn't accidentally count for a shared `Foo`.
  const re = new RegExp(`from\\s+['"][^'"]*shared/${sharedBase}(\\.jsx|\\.js|\\.mjs)?['"]`);
  for (const { src } of pageSources) {
    if (re.test(src)) count++;
  }
  return count;
}

const pageFiles = walk(pagesDir).filter(isJsxOrJs);
const pageSources = pageFiles.map((f) => ({ path: f, src: readFileSync(f, 'utf8') }));

const sharedFiles = walk(sharedDir).filter(isJsxOrJs);

const errors = [];
const warnings = [];

// R3 — no forks via filename convention.
const forkPatterns = [
  { re: /For[A-Z][A-Za-z0-9]+\.(jsx?|mjs)$/, label: '*For*.jsx' },
  { re: /\.(GCOVExplorer|GUNWExplorer|COGExplorer|Landing|Inundation|Crop|Disturbance|LocalExplorer)\.(jsx?|mjs)$/,
    label: '*.<page>.jsx' },
];

for (const dir of [pagesDir, sharedDir, join(repoRoot, 'app')]) {
  for (const f of walk(dir).filter(isJsxOrJs)) {
    const name = basename(f);
    for (const { re, label } of forkPatterns) {
      if (re.test(name)) {
        errors.push(
          `R3 fork filename: ${relative(repoRoot, f)} matches ${label}. ` +
          `Copy-and-edit drift is forbidden — extend the base component via props instead.`
        );
      }
    }
  }
}

// R2 — every shared component has >=2 page-level callers.
for (const f of sharedFiles) {
  const base = basename(f).replace(/\.(jsx?|mjs)$/, '');
  const callers = countPageCallers(base, pageSources);
  if (callers < 2) {
    errors.push(
      `R2 shared with <2 page callers: ${relative(repoRoot, f)} has ${callers} ` +
      `caller${callers === 1 ? '' : 's'} in app/pages/. Either move it to a single ` +
      `page, or wait until a second page consumes it before promoting to app/shared/.`
    );
  }
}

if (warnings.length) {
  for (const w of warnings) console.warn('[check-shared-usage] WARN: ' + w);
}

if (errors.length) {
  console.error('[check-shared-usage] FAILED:');
  for (const e of errors) console.error('  • ' + e);
  process.exit(1);
}

const sharedCount = sharedFiles.length;
const pageCount = pageFiles.length;
console.log(
  `[check-shared-usage] OK — ${sharedCount} shared module${sharedCount === 1 ? '' : 's'}, ` +
  `${pageCount} page${pageCount === 1 ? '' : 's'}, R2+R3 green.`
);
