import puppeteer from 'puppeteer';

const FILES = [
  ['dL L-band change Jan17-29', 'dL_flood_jan17_29.tif'],
  ['dC C-band change Jan16-28', 'dC_flood_jan16_28.tif'],
  ['L coherence Jan17-29', 'l_coh_jan29.tif'],
  ['C coherence Jan16-28', 'c_coh_jan16_28.tif'],
];
const base = 'http://localhost:5173';
const compare = FILES.map(([l, f]) => `${l}~${base}/data/tensor_20m/features/${f}`).join(',');

const withBbox = process.argv[2] === 'bbox';
const url = `${base}/?compare=${encodeURIComponent(compare)}` +
  (withBbox ? '&bbox=33.62279,-25.06412,33.66226,-25.02782' : '');

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const logs = [];
page.on('console', (m) => logs.push(m.text()));

console.log(`--- ${withBbox ? 'WITH &bbox=' : 'NO bbox (control)'} ---`);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 18000));

for (const l of logs.filter((x) => /\[CompareGrid\] fit|does not intersect|Could not reproject/.test(x))) {
  console.log('  ', l);
}
await browser.close();
