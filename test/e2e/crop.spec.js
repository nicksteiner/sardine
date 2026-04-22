/**
 * Crop ATBD route smoke test (S293 acceptance — ties to S290 R5).
 *
 * The full autostack → stream → classify path requires an EDL token +
 * live ASF access. The always-on asserts stay offline: navigation,
 * initial mount, stepper wiring, URL-state hydration, CV slider control.
 *
 * Network-dependent asserts run only when `EARTHDATA_TOKEN` is present.
 */
import { test, expect } from '@playwright/test';

test('crop: landing card navigates to /#/crop', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('route-card-/crop').click();
  await expect(page).toHaveURL(/#\/crop/);
  await expect(page.getByTestId('crop-step-1')).toBeVisible();
});

// Playwright's .fill() validates range-step arithmetic and trips on floating-
// point imprecision (e.g. (0.50 - 0.1) / 0.01 != int in IEEE-754). Use a
// React-compatible value setter + input event instead — this is the standard
// pattern for driving controlled range inputs.
async function setRange(locator, value) {
  await locator.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('crop: search-query hydrates lon/lat + persists cv override', async ({ page }) => {
  await page.goto('/?lon=-94.0&lat=38.5&cv=0.40#/crop');
  await expect(page.getByTestId('crop-lon')).toHaveValue('-94.0');
  await expect(page.getByTestId('crop-lat')).toHaveValue('38.5');
  await expect(page.getByTestId('crop-cv-value')).toHaveText('0.40');

  // Default (0.25) should strip cv from the URL — slider back to default.
  await setRange(page.getByTestId('crop-cv-slider'), '0.25');
  await page.waitForFunction(() => !window.location.search.includes('cv='));
});

test('crop: autostack button disabled until valid point entered', async ({ page }) => {
  await page.goto('/#/crop');
  const btn = page.getByTestId('crop-autostack');
  await expect(btn).toBeDisabled();
  await page.getByTestId('crop-lon').fill('-94.0');
  await page.getByTestId('crop-lat').fill('38.5');
  await expect(btn).toBeEnabled();
});

test('crop: CV slider updates displayed value', async ({ page }) => {
  await page.goto('/#/crop');
  await expect(page.getByTestId('crop-cv-value')).toHaveText('0.25');
  await setRange(page.getByTestId('crop-cv-slider'), '0.50');
  await expect(page.getByTestId('crop-cv-value')).toHaveText('0.50');
});

test('crop: build chrome visible (R8)', async ({ page }) => {
  await page.goto('/#/crop');
  await expect(page.getByTestId('build-chrome')).toBeVisible();
});

// Network-dependent — same EDL-token gate as inundation.spec.js.
test.describe('crop (with EDL token)', () => {
  test.skip(!process.env.EARTHDATA_TOKEN, 'EARTHDATA_TOKEN not set in env');

  test('autostack finds a stack at a known NISAR coverage point', async ({ page }) => {
    await page.goto('/#/crop');
    await page.getByTestId('crop-lon').fill(process.env.CROP_TEST_LON || '-94.0');
    await page.getByTestId('crop-lat').fill(process.env.CROP_TEST_LAT || '38.5');
    await page.getByTestId('crop-autostack').click();
    await expect(page.getByTestId('crop-autostack-result')).toBeVisible({ timeout: 60_000 });
  });
});
