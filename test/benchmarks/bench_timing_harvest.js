#!/usr/bin/env node
/**
 * Benchmark 2b: Harvest WebGL2 timing results via Puppeteer.
 * Launches headless Chrome, opens bench_timing_webgl.html on Vite dev server,
 * waits for completion, extracts JSON results.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const PORT = 5175;
const URL = `http://localhost:${PORT}/test/benchmarks/bench_timing_webgl.html`;
const TIMEOUT = 600_000; // 10 min

async function main() {
  console.log('=== Benchmark 2b: WebGL2 Timing (Puppeteer) ===');
  console.log(`Opening ${URL}`);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--use-gl=angle',
      '--use-angle=gl-egl',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-gpu-rasterization',
      '--window-size=1,1',
      '--window-position=0,0',
    ],
  });

  const page = await browser.newPage();
  page.on('console', msg => console.log(`  [browser] ${msg.text()}`));
  page.on('pageerror', err => console.error(`  [browser error] ${err.message}`));

  await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
  console.log('Page loaded, waiting for benchmarks to complete...');

  // Poll for completion
  const startTime = Date.now();
  let results = null;
  while (Date.now() - startTime < TIMEOUT) {
    const complete = await page.evaluate(() => window.__BENCHMARK_COMPLETE__);
    if (complete) {
      results = await page.evaluate(() => window.__BENCHMARK_RESULTS__);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  if (!results) {
    console.error('TIMEOUT: Benchmark did not complete in time');
    process.exit(1);
  }

  if (results.error) {
    console.error(`Benchmark error: ${results.error}`);
    process.exit(1);
  }

  // Write results
  const outPath = join(RESULTS_DIR, 'bench2_webgl.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);
  console.log(`${results.length} measurements recorded`);

  // Print summary
  const ops = [...new Set(results.map(r => r.operation))];
  const sizes = [...new Set(results.map(r => r.size))];
  console.log('\nSummary:');
  console.log('Op'.padEnd(25) + sizes.map(s => `${s}`.padStart(10)).join(''));
  for (const op of ops) {
    const row = sizes.map(s => {
      const r = results.find(x => x.operation === op && x.size === s);
      return r ? `${r.median_ms.toFixed(2)}ms`.padStart(10) : 'N/A'.padStart(10);
    }).join('');
    console.log(op.padEnd(25) + row);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
