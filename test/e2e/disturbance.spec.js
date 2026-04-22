/**
 * Disturbance ATBD route smoke test (S293 acceptance — ties to S290 R5).
 *
 * Same offline/online split as the inundation + crop specs: navigation,
 * stepper wiring, URL hydration, percentile + window controls always on;
 * autostack asserts gated on EARTHDATA_TOKEN.
 */
import { test, expect } from '@playwright/test';

// See crop.spec.js — Playwright's .fill() fails step validation for range
// inputs on non-exact step sums. Use native setter + input event dispatch.
async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('disturbance: landing card navigates to /#/disturbance', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('route-card-/disturbance').click();
  await expect(page).toHaveURL(/#\/disturbance/);
  await expect(page.getByTestId('disturbance-step-1')).toBeVisible();
});

test('disturbance: search-query hydrates lon/lat + persists pct/win', async ({ page }) => {
  await page.goto('/?lon=-122.4&lat=47.6&pct=90&win=180#/disturbance');
  await expect(page.getByTestId('disturbance-lon')).toHaveValue('-122.4');
  await expect(page.getByTestId('disturbance-lat')).toHaveValue('47.6');
  await expect(page.getByTestId('disturbance-pct-value')).toHaveText('90');
  await expect(page.getByTestId('disturbance-window-value')).toHaveText('180d');

  // Default (80, 90d) should strip pct + win from the URL.
  await setRange(page.getByTestId('disturbance-pct-slider'), '80');
  await page.getByTestId('disturbance-window-select').selectOption('90');
  await page.waitForFunction(() => {
    const s = window.location.search;
    return !s.includes('pct=') && !s.includes('win=');
  });
});

test('disturbance: autostack button disabled until valid point entered', async ({ page }) => {
  await page.goto('/#/disturbance');
  const btn = page.getByTestId('disturbance-autostack');
  await expect(btn).toBeDisabled();
  await page.getByTestId('disturbance-lon').fill('-122.4');
  await page.getByTestId('disturbance-lat').fill('47.6');
  await expect(btn).toBeEnabled();
});

test('disturbance: percentile slider + window selector update displayed values', async ({ page }) => {
  await page.goto('/#/disturbance');
  await expect(page.getByTestId('disturbance-pct-value')).toHaveText('80');
  await setRange(page.getByTestId('disturbance-pct-slider'), '95');
  await expect(page.getByTestId('disturbance-pct-value')).toHaveText('95');

  await page.getByTestId('disturbance-window-select').selectOption('365');
  await expect(page.getByTestId('disturbance-window-value')).toHaveText('365d');
});

test('disturbance: build chrome visible (R8)', async ({ page }) => {
  await page.goto('/#/disturbance');
  await expect(page.getByTestId('build-chrome')).toBeVisible();
});

test.describe('disturbance (with EDL token)', () => {
  test.skip(!process.env.EARTHDATA_TOKEN, 'EARTHDATA_TOKEN not set in env');

  test('autostack finds a stack at a known NISAR coverage point', async ({ page }) => {
    await page.goto('/#/disturbance');
    await page.getByTestId('disturbance-lon').fill(process.env.DISTURBANCE_TEST_LON || '-122.4');
    await page.getByTestId('disturbance-lat').fill(process.env.DISTURBANCE_TEST_LAT || '47.6');
    await page.getByTestId('disturbance-autostack').click();
    await expect(page.getByTestId('disturbance-autostack-result')).toBeVisible({ timeout: 60_000 });
  });
});
