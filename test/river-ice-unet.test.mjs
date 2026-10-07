/**
 * river-ice-unet.test.mjs — the exported L-band U-Net must actually classify
 * real NISAR tiles, in a real browser, through the real ml/registry path.
 *
 * Why a browser test and not a node one: the failure modes that matter here
 * are all browser-side — onnxruntime-web's EP negotiation, the lazy ORT
 * chunk, IndexedDB weight caching, and the registry's dB transform feeding
 * the graph's baked-in standardization. A node-side ORT run would pass while
 * any of those was broken.
 *
 * Fixtures are two labelled tiles from the training set (one ice-dominated
 * Yukon tile, one open-water Tanana tile) with their PlanetScope-derived
 * ground truth, so this asserts correctness, not merely "it ran". Synthetic
 * flat-value + speckle tiles do NOT work: the model reads texture, and
 * uniform fill reads as water regardless of brightness.
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const PORT = 5177;
const URL = `http://localhost:${PORT}/test/browser/river-ice-unet.html`;

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.test.config.js', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
  const scan = (b) => { if (/Local:\s+http/.test(String(b))) { clearTimeout(t); resolve(); } };
  vite.stdout.on('data', scan); vite.stderr.on('data', scan);
});

let code = 1;
try {
  await ready;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[chk]')) console.log('  ' + t.slice(6)); });
  page.on('pageerror', (e) => console.log('  PAGEERROR: ' + String(e).slice(0, 300)));
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // First run pays the ORT wasm fetch + session create; be generous.
  await page.waitForFunction('window.__done !== undefined', { timeout: 300000 });
  const d = await page.evaluate('window.__done');
  await browser.close();
  if (d.ok) { console.log('\n✓ PASS  river-ice U-Net classifies real NISAR tiles in-browser'); code = 0; }
  else { console.error('\n✗ FAIL  ' + JSON.stringify(d, null, 2)); }
} catch (e) {
  console.error('\n✗ FAIL  ' + e.message);
} finally {
  vite.kill('SIGTERM');
}
process.exit(code);
