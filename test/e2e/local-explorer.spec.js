/**
 * LocalExplorer smoke test (S295 acceptance — ties to S290 R5).
 *
 * No shippable fixture HDF5 or COG (multi-MB min), so this test stubs the
 * file input with a tiny Blob. The in-place delegation decision (NISAR vs
 * COG) is filename-driven, so a fake `.tif` is enough to verify that
 *   - /local mounts + dropzone renders
 *   - picking a .tif hands control to the COG explorer *without navigating*
 *   - unsupported extensions surface the error message
 */
import { test, expect } from '@playwright/test';

test('local-explorer: route mounts with dropzone visible', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/#/local');

  await expect(page.getByTestId('local-explorer')).toBeVisible();
  await expect(page.getByTestId('local-dropzone')).toBeVisible();
  await expect(page.getByTestId('local-file-input')).toBeVisible();
  await expect(page.getByTestId('build-chrome')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  expect(errors, `uncaught page errors: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

test('local-explorer: unsupported file extension surfaces the error', async ({ page }) => {
  await page.goto('/#/local');

  await page.getByTestId('local-file-input').setInputFiles({
    name: 'readme.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });

  await expect(page.getByTestId('local-error')).toBeVisible();
  await expect(page.getByTestId('local-explorer')).toBeVisible();
});

test('local-explorer: dropping a .tif delegates to COG explorer in-place', async ({ page }) => {
  await page.goto('/#/local');

  await page.getByTestId('local-file-input').setInputFiles({
    name: 'sample.tif',
    mimeType: 'image/tiff',
    buffer: Buffer.from([0x49, 0x49, 0x2a, 0x00]), // TIFF magic; enough to pick the delegate
  });

  // URL must remain /local — delegation is in-place, not a navigation.
  await expect(page).toHaveURL(/#\/local/);

  // COG explorer mounts as a child. Load may fail (not a real COG) but the
  // page structure must be present and the ErrorBoundary must not fire.
  await expect(page.getByTestId('cog-explorer')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
