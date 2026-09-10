import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const OUT  = process.argv[3];
mkdirSync(OUT, { recursive: true });

const THEMES = [['dark',''], ['sardine','sardine'], ['light','light']];

const COG = 'https://huggingface.co/datasets/nicksteiner/sardine-demo-data/resolve/main/pacaya_full_hh.tif';
const COG_LINK = `?cog=${encodeURIComponent(COG)}&db=1&stretch=sigmoid&z=-1.5`;

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});

for (const [name, value] of THEMES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((v) => {
    localStorage.setItem('sardine.theme', v);
    localStorage.setItem('sardine.pages-banner.dismissed', '1');
  }, value);
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));

  await page.screenshot({ path: `${OUT}/${name}-01-nodata.png` });

  // Control panel alone
  const panel = await page.$('.controls-panel');
  if (panel) await panel.screenshot({ path: `${OUT}/${name}-02-controlpanel.png` });

  // Command palette — opened from the activity rail's COMMANDS button
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find(el => /commands/i.test(el.textContent || '') || /command/i.test(el.getAttribute('aria-label') || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!opened) console.warn('  (no COMMANDS button found for', name, ')');
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/${name}-03-palette.png` });
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 400));

  // ── COG loaded (deep link) ──
  try {
    await page.goto(BASE + '/' + COG_LINK, { waitUntil: 'networkidle2', timeout: 120000 });
    await new Promise(r => setTimeout(r, 12000));
    await page.screenshot({ path: `${OUT}/${name}-04-cog.png` });
    const p2 = await page.$('.controls-panel');
    if (p2) await p2.screenshot({ path: `${OUT}/${name}-05-cog-controlpanel.png` });
  } catch (e) {
    console.warn('  COG state failed for', name, '-', e.message);
  }

  await page.close();
  console.log('captured', name);
}
await browser.close();
