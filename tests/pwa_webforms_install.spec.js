import {test, expect} from './fixtures.js';

// ============================================================================
// PWA install entry points — manifest start_url + anon hub loads
// ============================================================================
// Locks the operator install instructions:
//
//   1. /manifest.webmanifest start_url is "/" (installing from
//      wcfplanner.com opens the authenticated app root, not the public
//      daily-reports hub). Scope stays / so a future SW scope change
//      surfaces here before it ships and breaks navigation between hubs.
//
//   2. /manifest-dailys.webmanifest start_url is /dailys (operators who
//      land on /dailys and tap Add to Home Screen still get the daily-
//      reports hub).
//
//   3. /manifest-equipment.webmanifest start_url is /equipment (the
//      operator equipment/fueling hub).
//
//   4. main.jsx swaps the link href at runtime as the operator SPA-
//      navigates between hubs, keyed on /dailys|/webforms vs /equipment|
//      /fueling vs everything else.
//
//   5. Anon load of /dailys renders WebformHub branding (not LoginScreen).
//
//   6. Anon load of /equipment renders FuelingHub branding (not LoginScreen).
// ============================================================================

// Anon context — operators arrive at the public hubs unauthenticated.
test.use({storageState: {cookies: [], origins: []}});

test('root manifest start_url is "/" and scope is /', async ({request}) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
});

test('dailys manifest start_url is /dailys and scope is /', async ({request}) => {
  const res = await request.get('/manifest-dailys.webmanifest');
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

test('GET /dailys.html serves the dailys manifest at HTML level (pre-JS)', async ({request}) => {
  // The install banner reads link[rel="manifest"] at HTML parse time,
  // before any JS runs. dailys.html must have the dailys manifest baked
  // in — JS swap is too late for Add to Home Screen.
  const res = await request.get('/dailys.html');
  expect(res.ok()).toBe(true);
  const html = await res.text();
  const m = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"\s*\/?>/);
  expect(m, 'expected <link rel="manifest"> in dailys.html').not.toBeNull();
  expect(m[1]).toBe('/manifest-dailys.webmanifest');
});

test('manifest link href on legacy /webforms is the dailys manifest after load', async ({page}) => {
  // Netlify _redirects routes /webforms → /dailys.html so Add to Home
  // Screen reads the dailys manifest at HTML parse time on the deployed
  // site. The deploy-side rewrite is locked by the static _redirects
  // test (tests/static/pwa_install_html.test.js); this Playwright test
  // covers the runtime side — after the React app boots, applyManifestHref
  // keeps link[rel="manifest"] pointing at the dailys manifest as the
  // route alias navigates from /webforms to /dailys.
  await page.goto('/webforms');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-dailys.webmanifest');
});

test('GET /equipment.html serves the equipment manifest at HTML level (pre-JS)', async ({request}) => {
  const res = await request.get('/equipment.html');
  expect(res.ok()).toBe(true);
  const html = await res.text();
  const m = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"\s*\/?>/);
  expect(m, 'expected <link rel="manifest"> in equipment.html').not.toBeNull();
  expect(m[1]).toBe('/manifest-equipment.webmanifest');
});

test('GET /index.html serves the root manifest at HTML level', async ({request}) => {
  const res = await request.get('/index.html');
  expect(res.ok()).toBe(true);
  const html = await res.text();
  const m = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"\s*\/?>/);
  expect(m, 'expected <link rel="manifest"> in index.html').not.toBeNull();
  expect(m[1]).toBe('/manifest.webmanifest');
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

test('manifest link href is /manifest.webmanifest on root', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
});

test('manifest link href swaps to dailys manifest on /dailys', async ({page}) => {
  await page.goto('/dailys');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-dailys.webmanifest');
});

test('manifest link href swaps to equipment manifest on /equipment', async ({page}) => {
  await page.goto('/equipment');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The module-scope shim runs before React mounts, so the link href
  // should be set by the time we read the DOM.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-equipment.webmanifest');
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
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-dailys.webmanifest', {
    timeout: 5_000,
  });
});
