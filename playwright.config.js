/**
 * Playwright config — per-route smoke tests for the hash-routed SARdine SPA.
 *
 * Each phase in S291–S295 adds a spec under `test/e2e/`. These run separately
 * from `npm test` because Playwright is slow (boots a browser) — CI should
 * run them as a distinct job.
 *
 * Uses the system Chrome channel so we don't pay for a Chromium download;
 * `npm run test:e2e` on a fresh machine still works as long as Chrome is
 * available (CI runners generally have it; dev machines usually do too).
 * Override with `PLAYWRIGHT_CHANNEL=chromium` if needed.
 */
import { defineConfig, devices } from '@playwright/test';

const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const PORT = Number(process.env.PLAYWRIGHT_PORT || 5179);

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: CHANNEL },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
