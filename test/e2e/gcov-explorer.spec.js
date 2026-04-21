/**
 * GCOVExplorer smoke test (S291 acceptance).
 *
 * No fixture file is dropped — S291 didn't ship a small GCOV fixture, and
 * spinning up a multi-GB NISAR file in CI is out of scope. The goal here
 * is to catch the "extraction broke the page mount" failure mode: the
 * route loads, React commits, no uncaught errors reach the ErrorBoundary.
 *
 * Later phases (S292+) add data-flow e2e coverage when fixtures exist.
 */
import { test, expect } from '@playwright/test';

test('gcov-explorer: route mounts without crashing the ErrorBoundary', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/#/explore/gcov');

  // The Landing chooser is gone (we left it via hash nav).
  await expect(page.getByTestId('landing-grid')).toHaveCount(0);

  // The ErrorBoundary didn't fire.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // Build chrome is still visible on this route (R8).
  await expect(page.getByTestId('build-chrome')).toBeVisible();

  // The main viewer container mounts — the legacy explorer uses <main> as
  // its root inside App/GCOVExplorer (see app/pages/GCOVExplorer.jsx).
  await expect(page.locator('main')).toBeVisible();

  expect(errors, `uncaught page errors: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

test('gcov-explorer: back-to-landing link works from a coming-soon route', async ({ page }) => {
  // S292 promoted /inundation to live. /crop is still coming-soon (S293 lands it).
  await page.goto('/#/crop');
  await expect(page.getByTestId('coming-soon')).toBeVisible();
  await page.getByRole('link', { name: /Back to chooser/ }).click();
  await expect(page.getByTestId('landing-grid')).toBeVisible();
});
