#!/usr/bin/env node
/**
 * Benchmark 5: Interactive Responsiveness Harvester
 *
 * Launches headless Chrome with GPU, runs bench_interactive.html,
 * and extracts frame time measurements.
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const VITE_URL = process.env.VITE_URL || 'http://localhost:5175';

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log('=== Benchmark 5: Interactive Responsiveness Harvester ===');

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
    page.on('console', msg => {
      const text = msg.text();
      if (text.length < 200) console.log(`  [Chrome] ${text}`);
    });

    console.log('  Navigating to interactive benchmark...');
    await page.goto(`${VITE_URL}/test/benchmarks/bench_interactive.html`, {
      waitUntil: 'networkidle0',
      timeout: 30_000,
    });

    console.log('  Waiting for benchmarks to complete...');
    await page.waitForFunction(() => window.__INTERACTIVE_COMPLETE__ === true, {
      timeout: 120_000,
      polling: 1000,
    });

    const results = await page.evaluate(() => window.__INTERACTIVE_RESULTS__);

    if (results.error) {
      console.error(`  Benchmark failed: ${results.error}`);
      process.exit(1);
    }

    // Write JSON
    const jsonPath = join(RESULTS_DIR, 'bench5_interactive.json');
    writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`  Results written to: ${jsonPath}`);

    // Write CSV
    const csvPath = join(RESULTS_DIR, 'bench5_interactive.csv');
    const csvLines = ['test,p50_ms,p95_ms,p99_ms,mean_ms,min_ms,max_ms,frames'];
    for (const [name, data] of Object.entries(results)) {
      csvLines.push(`${name},${data.p50},${data.p95},${data.p99},${data.mean},${data.min},${data.max},${data.frames}`);
    }
    writeFileSync(csvPath, csvLines.join('\n') + '\n');
    console.log(`  CSV written to: ${csvPath}`);

    // Summary
    console.log('\n  --- Results ---');
    let allPass = true;
    for (const [name, data] of Object.entries(results)) {
      const pass = data.p95 < 16.0;
      if (!pass) allPass = false;
      console.log(`  ${name}: p50=${data.p50}ms p95=${data.p95}ms ${pass ? 'PASS' : 'FAIL'}`);
    }
    console.log(`\n  Overall: ${allPass ? 'ALL PASS' : 'SOME FAILED'}`);

    // Generate figure
    try {
      const { execSync } = await import('child_process');
      const figScript = `
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

with open('${jsonPath}') as f:
    data = json.load(f)

names = list(data.keys())
p50 = [data[n]['p50'] for n in names]
p95 = [data[n]['p95'] for n in names]
p99 = [data[n]['p99'] for n in names]

fig, ax = plt.subplots(figsize=(10, 5))
x = np.arange(len(names))
width = 0.25

ax.bar(x - width, p50, width, label='p50', color='#4ec9d4')
ax.bar(x, p95, width, label='p95', color='#76b900')
ax.bar(x + width, p99, width, label='p99', color='#e05858')

ax.axhline(y=16.0, color='#e05858', linestyle='--', linewidth=1.5, label='16ms target (60fps)')
ax.set_ylabel('Frame Time (ms)')
ax.set_title('Interactive Responsiveness: Frame Times by Operation')
ax.set_xticks(x)
ax.set_xticklabels([n.replace('_', '\\n') for n in names], fontsize=8)
ax.legend(fontsize=8)
ax.grid(True, alpha=0.2, axis='y')

plt.tight_layout()
plt.savefig('${join(RESULTS_DIR, 'fig_frame_times.pdf')}', dpi=150, bbox_inches='tight')
plt.close()
print('Figure saved')
`;
      execSync(`python3 -c ${JSON.stringify(figScript)}`, { stdio: 'inherit' });
    } catch {
      console.log('  [SKIP] Figure generation failed');
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
