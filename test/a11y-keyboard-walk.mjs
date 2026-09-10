#!/usr/bin/env node
/**
 * a11y-keyboard-walk.mjs — the keyboard-only pass, run rather than asserted.
 *
 * Drives the built app in headless Chrome using nothing but the keyboard and
 * records, for every focus stop, whether it has an accessible name and a
 * visible focus indicator. It opens each rail panel and expands every
 * collapsible section first, so the walk covers the whole control surface and
 * not just what happens to be on screen at load.
 *
 * This is what a static test cannot do: it resolves the real accessibility
 * name (aria-label, an associated <label>, a wrapping <label>, element text),
 * and it reads the *computed* outline after focus lands — which is how the
 * `transition: all` bug that faded the focus ring in over 150 ms was caught.
 *
 *   npm run build && npm run test:a11y
 *
 * Exits non-zero if any focus stop is unnamed, has no visible indicator, or
 * is focusable while invisible (a tab stop the user cannot see).
 */

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = Number(process.env.A11Y_PORT || 4317);
const BASE = process.env.A11Y_URL || `http://localhost:${PORT}/`;
const MAX_STOPS = 400;

/**
 * A scene to load before walking, so the walk covers the controls that only
 * exist once data is present — contrast, ROI, export. Set A11Y_COG='' to skip
 * the network and walk the empty app.
 */
const COG = process.env.A11Y_COG ?? 'https://huggingface.co/datasets/nicksteiner/'
  + 'sardine-demo-data/resolve/main/pacaya_full_hh.tif';
const URL = BASE;

/** Start `vite preview` unless something is already serving. */
async function serve() {
  try {
    await fetch(URL);
    return null;                       // already up; leave it alone
  } catch { /* not running */ }
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', detached: false });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await fetch(URL); return proc; } catch { /* keep waiting */ }
  }
  proc.kill();
  throw new Error(`vite preview never came up on ${URL}`);
}

/** Runs in the page: describe whatever currently has focus. */
const probe = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const labelledby = el.getAttribute('aria-labelledby');
  const name =
    el.getAttribute('aria-label') ||
    (labelledby && document.getElementById(labelledby)?.textContent?.trim()) ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) ||
    el.closest('label')?.textContent?.trim() ||
    (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) ? el.textContent.trim() : '') ||
    el.getAttribute('placeholder') ||
    '';
  const outlineWidth = parseFloat(cs.outlineWidth) || 0;
  const ring = outlineWidth >= 1 || (cs.boxShadow && cs.boxShadow !== 'none');
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    type: el.getAttribute('type') || '',
    name: name.replace(/\s+/g, ' ').slice(0, 52),
    ring,
    outline: `${cs.outlineWidth} ${cs.outlineStyle}`,
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    // Enough to find the element again when it fails a check.
    where: `${el.className || ''}`.slice(0, 40) + ' | ' + el.outerHTML.slice(0, 90).replace(/\s+/g, ' '),
  };
};

const server = await serve();
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const target = COG ? `${BASE}?cog=${encodeURIComponent(COG)}` : BASE;
  // Watch the live regions from before the app mounts, so the "Loading…"
  // utterance is recorded and not just the one that happens to be there when
  // polling starts. This is what a screen reader would actually be handed.
  await page.evaluateOnNewDocument(() => {
    window.__announced = [];
    const watch = (r) => new MutationObserver(() => {
      const t = r.textContent.trim();
      const line = `${r.getAttribute('aria-live')}: ${t}`;
      if (t && window.__announced.at(-1) !== line) window.__announced.push(line);
    }).observe(r, { childList: true, characterData: true, subtree: true });
    const tick = setInterval(() => {
      const rs = document.querySelectorAll('[aria-live]:not([data-watched])');
      rs.forEach(r => { r.setAttribute('data-watched', '1'); watch(r); });
    }, 50);
    setTimeout(() => clearInterval(tick), 20000);
  });
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));

  if (COG) {
    // Wait for the load to finish, and record what the live regions said —
    // this is the screen-reader half of the pass.
    let said = [];
    for (let i = 0; i < 60; i++) {
      said = await page.evaluate(() => window.__announced || []);
      if (said.some(t => /loaded|could not/.test(t))) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('\nLIVE REGIONS during load:');
    for (const t of said) console.log(`  ${t}`);
    if (!said.length) console.log('  (nothing announced — the load never started)');
  }

  const stops = [];
  const seen = new Set();

  // One walk per rail panel. Each panel is a different control surface, and
  // its sections are expanded first so the walk reaches controls that would
  // otherwise be behind a disclosure.
  const rails = await page.$$eval('.activity-rail [role="tab"]', els => els.length);
  for (let panel = 0; panel < Math.max(1, rails); panel++) {
    await page.evaluate(i => document.querySelectorAll('.activity-rail [role="tab"]')[i]?.click(), panel);
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => {
      document.querySelectorAll('.controls-panel [aria-expanded="false"]').forEach(el => el.click());
    });
    await new Promise(r => setTimeout(r, 300));

    await page.evaluate(() => { document.activeElement?.blur(); });
    const local = new Set();
    for (let i = 0; i < MAX_STOPS; i++) {
      await page.keyboard.press('Tab');
      // Let any focus transition settle before reading the computed outline.
      await new Promise(r => setTimeout(r, 30));
      const s = await page.evaluate(probe);
      if (!s) continue;
      const key = `${s.tag}|${s.role}|${s.type}|${s.name}`;
      if (local.has(key)) break;             // tab order wrapped around
      local.add(key);
      if (seen.has(key)) continue;           // already recorded from another panel
      seen.add(key);
      stops.push(s);
    }
  }

  const unnamed = stops.filter(s => !s.name && s.role !== 'tabpanel');
  const noRing = stops.filter(s => !s.ring);
  const invisible = stops.filter(s => !s.visible);

  console.log(`\nKEYBOARD WALK — ${stops.length} focus stops\n`);
  for (const s of stops) {
    const flag = !s.name ? '✗ UNNAMED' : !s.ring ? '✗ NO RING' : !s.visible ? '✗ INVISIBLE' : '  ok';
    const tag = `<${s.tag}${s.role ? ` role=${s.role}` : ''}${s.type ? ` type=${s.type}` : ''}>`;
    console.log(`  ${flag}  ${tag.padEnd(30)} ${s.name || '(no accessible name)'}`);
    if (flag !== '  ok') console.log(`              ↳ ${s.where}`);
  }
  console.log(`\nunnamed: ${unnamed.length}   no focus ring: ${noRing.length}   `
    + `focusable but invisible: ${invisible.length}`);

  process.exitCode = unnamed.length + noRing.length + invisible.length ? 1 : 0;
} finally {
  await browser.close();
  if (server) server.kill();
}
