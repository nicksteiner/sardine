#!/usr/bin/env node
/**
 * Harvest GPU multilook benchmark results via Puppeteer.
 * Launches Chrome with GPU access, opens bench_multilook_webgl.html,
 * waits for completion, extracts JSON results.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const PORT = 5175;
const URL = `http://localhost:${PORT}/test/benchmarks/bench_multilook_webgl.html`;
const TIMEOUT = 300_000; // 5 min

async function main() {
  console.log('=== GPU Multilook Benchmark (Puppeteer) ===');
  console.log(`Opening ${URL}`);

  const browser = await puppeteer.launch({
    headless: false,
    protocolTimeout: 600_000, // 10 min — large scenes take time
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

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Page loaded, waiting for benchmarks to complete...');

  const startTime = Date.now();
  let results = null;
  while (Date.now() - startTime < TIMEOUT) {
    try {
      const complete = await page.evaluate(() => window.__BENCHMARK_COMPLETE__);
      if (complete) {
        results = await page.evaluate(() => window.__BENCHMARK_RESULTS__);
        break;
      }
    } catch (e) {
      // Protocol timeout during long GPU runs — just keep polling
      console.log(`  (poll: ${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed, still running...)`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  await browser.close();

  if (!results) {
    console.error('TIMEOUT: Benchmark did not complete');
    process.exit(1);
  }
  if (results.error) {
    console.error(`Benchmark error: ${results.error}`);
    process.exit(1);
  }

  // Write results
  const outPath = join(RESULTS_DIR, 'bench_multilook_webgl.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);

  // Print summary table
  const sizes = [...new Set(results.map(r => r.scene_size))].sort((a, b) => a - b);
  const kernels = [...new Set(results.map(r => r.kernel_size))].sort((a, b) => a - b);

  console.log('\nGPU Multilook Timing (ms):');
  console.log('Kernel'.padEnd(10) + sizes.map(s => `${s}`.padStart(12)).join(''));
  for (const ks of kernels) {
    const row = sizes.map(s => {
      const r = results.find(x => x.kernel_size === ks && x.scene_size === s);
      return r ? `${r.median_ms.toFixed(3)}`.padStart(12) : 'N/A'.padStart(12);
    }).join('');
    console.log(`${ks}x${ks}`.padEnd(10) + row);
  }

  console.log('\nAll <16ms (interactive)?');
  for (const s of sizes) {
    const allOk = results.filter(r => r.scene_size === s).every(r => r.under_16ms);
    console.log(`  ${s}x${s}: ${allOk ? 'YES' : 'NO'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
