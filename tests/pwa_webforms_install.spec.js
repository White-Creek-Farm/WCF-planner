import {test, expect} from './fixtures.js';

// ============================================================================
// PWA install entry points — manifest start_url + anon hub loads
// ============================================================================
// Locks the operator install instructions after the 2026-05-06 public-URL
// rename:
//
//   1. /manifest.webmanifest is served and start_url is /dailys (so the
//      installed PWA opens the operator daily-reports hub). Scope stays /
//      so a future change that scopes the SW to /dailys surfaces here
//      before it ships and breaks navigation back to /addfeed, /weighins,
//      or /equipment.
//
//   2. /manifest-equipment.webmanifest is served and start_url is /equipment
//      (the operator equipment/fueling hub). main.jsx swaps the link href
//      at runtime when pathname starts with /equipment or /fueling.
//
//   3. Anon load of /dailys renders WebformHub branding (not LoginScreen).
//
//   4. Anon load of /equipment renders FuelingHub branding (not LoginScreen).
// ============================================================================

// Anon context — operators arrive at the public hubs unauthenticated.
test.use({storageState: {cookies: [], origins: []}});

test('default manifest start_url is /dailys and scope is /', async ({request}) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.start_url).toBe('/dailys');
  expect(manifest.scope).toBe('/');
});

test('equipment manifest start_url is /equipment', async ({request}) => {
  const res = await request.get('/manifest-equipment.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.start_url).toBe('/equipment');
  expect(manifest.scope).toBe('/');
});

test('anon load of /dailys renders WebformHub, not LoginScreen', async ({page}) => {
  await page.goto('/dailys');

  // Boot loader fades after first paint.
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Negative — LoginScreen branding must NOT be visible.
  await expect(page.locator('text=Broiler, Layer & Pig Planner')).toHaveCount(0, {timeout: 15_000});

  // Positive — WebformHub form selector copy is unique to its !activeForm branch.
  await expect(page.getByText('Select a report type to fill out')).toBeVisible({timeout: 15_000});

  // URL stays at /dailys (no redirect to / or to login).
  await expect(page).toHaveURL(/\/dailys\/?$/);
});

test('anon load of /equipment renders FuelingHub, not LoginScreen', async ({page}) => {
  await page.goto('/equipment');

  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  await expect(page.locator('text=Broiler, Layer & Pig Planner')).toHaveCount(0, {timeout: 15_000});

  // FuelingHub root selector copy.
  await expect(page.getByText('Tap your equipment to log a fueling')).toBeVisible({timeout: 15_000});

  await expect(page).toHaveURL(/\/equipment\/?$/);
});

test('manifest link href swaps to equipment manifest on /equipment', async ({page}) => {
  await page.goto('/equipment');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The module-scope shim runs before React mounts, so the link href
  // should be set by the time we read the DOM.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-equipment.webmanifest');
});

test('manifest link href stays default on /dailys', async ({page}) => {
  await page.goto('/dailys');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
});

test('manifest link href tracks SPA navigation between /equipment and /dailys', async ({page}) => {
  // Land on /equipment — module-scope shim sets the equipment manifest.
  await page.goto('/equipment');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-equipment.webmanifest', {
    timeout: 5_000,
  });

  // SPA-navigate to /dailys via the FuelingHub "Back to Daily Reports"
  // button — that calls react-router's navigate('/dailys') without a
  // full reload, exercising the App pathname useEffect that calls
  // applyManifestHref on every location change.
  await page.getByRole('button', {name: /Back to Daily Reports/i}).click();
  await expect(page).toHaveURL(/\/dailys\/?$/, {timeout: 5_000});
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest', {timeout: 5_000});
});
