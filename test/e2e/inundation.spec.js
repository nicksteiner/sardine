/**
 * Inundation ATBD route smoke test (S292 acceptance — ties to S290 R5).
 *
 * The full end-to-end flow (auto-stack → stream → classify) depends on an
 * Earthdata Login token + live ASF access, which isn't guaranteed in CI.
 * The always-on asserts stay offline: navigation, initial mount, the
 * stepper wiring, and URL-state hydration.
 *
 * Network-dependent asserts run only when `EARTHDATA_TOKEN` is present;
 * the `test.skip` keeps CI green without the token.
 */
import { test, expect } from '@playwright/test';

test('inundation: landing card navigates to /#/inundation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('route-card-/inundation').click();
  await expect(page).toHaveURL(/#\/inundation/);
  await expect(page.getByTestId('inundation-step-1')).toBeVisible();
});

test('inundation: search-query hydrates lon/lat + updates on edit', async ({ page }) => {
  // Hash routing puts per-page state in `location.search`, not the hash.
  // See app/shared/urlState.js for the reasoning.
  await page.goto('/?lon=-73.8&lat=-8.4#/inundation');
  await expect(page.getByTestId('inundation-lon')).toHaveValue('-73.8');
  await expect(page.getByTestId('inundation-lat')).toHaveValue('-8.4');

  // Typing updates URL via history.replaceState.
  await page.getByTestId('inundation-lat').fill('-8.5');
  await page.waitForFunction(() => window.location.search.includes('lat=-8.5'));
});

test('inundation: autostack button disabled until valid point entered', async ({ page }) => {
  await page.goto('/#/inundation');
  const btn = page.getByTestId('inundation-autostack');
  await expect(btn).toBeDisabled();
  await page.getByTestId('inundation-lon').fill('-73.8');
  await page.getByTestId('inundation-lat').fill('-8.4');
  await expect(btn).toBeEnabled();
});

test('inundation: build chrome visible (R8)', async ({ page }) => {
  await page.goto('/#/inundation');
  await expect(page.getByTestId('build-chrome')).toBeVisible();
});

// ─── Network-dependent (Earthdata token required) ──────────────────────────
// These are the "real" acceptance checks. Skipped when EARTHDATA_TOKEN isn't
// set so CI stays green without a secret. Run locally after `export
// EARTHDATA_TOKEN=...`.
test.describe('inundation (with EDL token)', () => {
  test.skip(!process.env.EARTHDATA_TOKEN, 'EARTHDATA_TOKEN not set in env');

  test('autostack finds a stack at a known NISAR coverage point', async ({ page }) => {
    await page.goto('/#/inundation');
    await page.getByTestId('inundation-lon').fill(process.env.INUNDATION_TEST_LON || '-73.8');
    await page.getByTestId('inundation-lat').fill(process.env.INUNDATION_TEST_LAT || '-8.4');
    await page.getByTestId('inundation-autostack').click();
    await expect(page.getByTestId('inundation-autostack-result')).toBeVisible({ timeout: 60_000 });
  });
});
