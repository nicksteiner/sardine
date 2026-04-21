/**
 * Landing smoke test (S291 acceptance — ties to S290 R5 + R8).
 *
 * Asserts:
 *  - `/` mounts and renders the landing grid.
 *  - Every planned route has a card on the landing page.
 *  - The build chrome (version + SHA) is present — R8.
 */
import { test, expect } from '@playwright/test';

const ROUTES = [
  '/explore/gcov',
  '/inundation',
  '/crop',
  '/disturbance',
  '/explore/gunw',
  '/explore/cog',
  '/local',
];

test('landing: root mounts and lists every planned route', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('landing-grid')).toBeVisible();
  for (const href of ROUTES) {
    await expect(page.getByTestId(`route-card-${href}`)).toBeVisible();
  }
});

test('landing: build chrome shows version and SHA (R8)', async ({ page }) => {
  await page.goto('/');
  const chrome = page.getByTestId('build-chrome');
  await expect(chrome).toBeVisible();
  const text = (await chrome.textContent()) || '';
  // Format: "v<semver> · <sha>" — a minimal shape check.
  expect(text).toMatch(/v\d+\.\d+\.\d+.*·/);
});

test('landing: clicking GCOV card navigates to /explore/gcov', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('route-card-/explore/gcov').click();
  await expect(page).toHaveURL(/#\/explore\/gcov/);
});
