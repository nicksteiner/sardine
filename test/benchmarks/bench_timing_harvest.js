#!/usr/bin/env node
/**
 * Benchmark 2c: Puppeteer WebGL2 Harvester
 *
 * Launches headless Chrome with GPU, runs bench_timing_webgl.html,
 * and extracts structured JSON results.
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const VITE_URL = process.env.VITE_URL || 'http://localhost:5175';
const TIMEOUT = 600_000; // 10 minutes for large textures

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('=== Benchmark 2c: WebGL2 Harvester ===');
  console.log(`  Vite URL: ${VITE_URL}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--enable-webgl',
      '--use-gl=egl',
      '--enable-gpu',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      '--disable-software-rasterizer',
    ],
  });

  try {
    const page = await browser.newPage();

    // Capture console output
    page.on('console', msg => {
      const text = msg.text();
      if (text.length < 200) console.log(`  [Chrome] ${text}`);
    });
    page.on('pageerror', err => console.error(`  [Chrome ERROR] ${err.message}`));

    console.log('  Navigating to benchmark page...');
    await page.goto(`${VITE_URL}/test/benchmarks/bench_timing_webgl.html`, {
      waitUntil: 'networkidle0',
      timeout: 30_000,
    });

    console.log('  Waiting for benchmarks to complete...');
    await page.waitForFunction(() => window.__BENCHMARK_COMPLETE__ === true, {
      timeout: TIMEOUT,
      polling: 2000,
    });

    const results = await page.evaluate(() => window.__BENCHMARK_RESULTS__);

    if (results.error) {
      console.error(`  Benchmark failed: ${results.error}`);
      process.exit(1);
    }

    const outPath = join(RESULTS_DIR, 'bench2_webgl.json');
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`  ${results.length} results written to: ${outPath}`);

    // Print summary
    console.log('\n  --- WebGL2 Results Summary ---');
    const sizes = [...new Set(results.map(r => r.size))].sort((a, b) => a - b);
    for (const size of sizes) {
      const sizeResults = results.filter(r => r.size === size);
      console.log(`  ${size}x${size}:`);
      for (const r of sizeResults) {
        if (r.median_ms >= 0) {
          console.log(`    ${r.operation}: ${r.median_ms.toFixed(3)} ms`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n  Done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
