#!/usr/bin/env node
/**
 * Benchmark 5: Harvest interactive responsiveness results via Puppeteer.
 * Launches headless Chrome, opens bench_interactive.html on Vite dev server,
 * waits for completion, extracts frame time results.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const PORT = 5175;
const URL = `http://localhost:${PORT}/test/benchmarks/bench_interactive.html`;
const TIMEOUT = 120_000; // 2 min

async function main() {
  console.log('=== Benchmark 5: Interactive Responsiveness (Puppeteer) ===');
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

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
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
    await new Promise(r => setTimeout(r, 1000));
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
  const outPath = join(RESULTS_DIR, 'bench5_interactive.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);

  // Print summary
  console.log('\nResults:');
  console.log('Test'.padEnd(25) + 'p50'.padStart(10) + 'p95'.padStart(10) + 'p99'.padStart(10) + 'Pass'.padStart(8));
  for (const [name, r] of Object.entries(results)) {
    console.log(
      name.padEnd(25) +
      `${r.p50.toFixed(2)}ms`.padStart(10) +
      `${r.p95.toFixed(2)}ms`.padStart(10) +
      `${r.p99.toFixed(2)}ms`.padStart(10) +
      (r.pass ? '  YES' : '   NO').padStart(8)
    );
  }

  const allPass = Object.values(results).every(r => r.pass);
  console.log(`\nOverall: ${allPass ? 'PASS' : 'FAIL'}`);

  // Write summary
  const summary = {
    benchmark: '5_interactive',
    tests: results,
    allPass,
  };
  writeFileSync(join(RESULTS_DIR, 'bench5_summary.json'), JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
