/**
 * COGExplorer smoke test (S295 acceptance — ties to S290 R5).
 *
 * No small COG fixture ships with the repo, so we don't drive a real tile
 * fetch here. The goal is to catch the "extraction broke the route mount"
 * failure mode:
 *   - /explore/cog mounts
 *   - sidebar controls render
 *   - ErrorBoundary doesn't fire
 *   - ?url= query param flows into the URL input
 */
import { test, expect } from '@playwright/test';

test('cog-explorer: route mounts without crashing', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err));

  await page.goto('/#/explore/cog');

  await expect(page.getByTestId('cog-explorer')).toBeVisible();
  await expect(page.getByTestId('cog-url-input')).toBeVisible();
  await expect(page.getByTestId('cog-load-btn')).toBeVisible();

  // Build chrome (R8) must render on this route too.
  await expect(page.getByTestId('build-chrome')).toBeVisible();

  // No ErrorBoundary crash.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  expect(errors, `uncaught page errors: ${errors.map((e) => e.message).join('; ')}`).toHaveLength(0);
});

test('cog-explorer: ?url= query param populates the URL input', async ({ page }) => {
  const sample = 'https://example.com/fake.tif';
  // Query param in window.location.search — this is the form wouter's navigate
  // produces for the S291 legacy redirect and what S295 Landing links look
  // like when the user shares a route URL.
  //
  // Vite's dev server rejects requests whose *query* looks like a filesystem
  // path outside the allow list. Land on `/` first, then push the query-bearing
  // URL via history — same end state, without triggering Vite's guard.
  await page.goto('/');
  await page.evaluate(([url]) => {
    window.history.replaceState(null, '', `/?url=${encodeURIComponent(url)}#/explore/cog`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [sample]);

  const input = page.getByTestId('cog-url-input');
  await expect(input).toHaveValue(sample);
});
