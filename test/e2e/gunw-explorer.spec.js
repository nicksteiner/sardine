/**
 * GUNWExplorer smoke test (S294 acceptance).
 *
 * Same scope as gcov-explorer.spec: the route mounts, React commits, no
 * uncaught error reaches the ErrorBoundary. A full GUNW data-flow test
 * would need a multi-GB fixture that CI doesn't carry; manual workstation
 * verification with an ASF-hosted GUNW file covers the data path.
 */
import { test, expect } from '@playwright/test';

test('gunw-explorer: route mounts without crashing the ErrorBoundary', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/#/explore/gunw');

  await expect(page.getByTestId('landing-grid')).toHaveCount(0);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('build-chrome')).toBeVisible();
  await expect(page.locator('main')).toBeVisible();

  // The Data Source dropdown should default to the GUNW loader on this page.
  // (GCOV option is not in the select — see app/pages/GUNWExplorer.jsx.)
  const sourceSelect = page.locator('select').first();
  await expect(sourceSelect).toHaveValue('nisar-gunw');

  expect(errors, `uncaught page errors: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

test('gunw-explorer: landing card marks the route live', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('route-card-/explore/gunw');
  await expect(card).toBeVisible();
  // Live badge reads "live" (not "soon · S294")
  await expect(card).toContainText('live');
});
