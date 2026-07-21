import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

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
//   5. Anon load of /dailys shows the login gate (Lane 1 CP1 made the hubs
//      login-required) with the /dailys URL preserved for return-after-login.
//
//   6. Anon load of /equipment shows the login gate with the /equipment URL
//      preserved.
//
// The manifest behavior (start_url, per-URL link href, runtime swap) is
// unchanged by the auth gate — the manifest shim keys on the URL, not on
// which component renders — so those assertions still hold for anon loads.
// ============================================================================

// Anon context — operators arrive at the hubs unauthenticated and hit login.
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
  await waitForAppReady(page);
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

test('anon load of /dailys shows the login gate, URL preserved', async ({page}) => {
  await page.goto('/dailys');

  // Boot loader fades after first paint.
  await waitForAppReady(page);

  // Login-required (Lane 1 CP1): LoginScreen is shown, the hub is NOT.
  await expect(page.locator('[data-login-screen]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Select a report type to fill out')).toHaveCount(0);

  // URL stays at /dailys so login returns the operator to the requested hub.
  await expect(page).toHaveURL(/\/dailys\/?$/);
});

test('anon load of /equipment shows the login gate, URL preserved', async ({page}) => {
  await page.goto('/equipment');

  await waitForAppReady(page);

  await expect(page.locator('[data-login-screen]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Tap your equipment to log a fueling')).toHaveCount(0);

  await expect(page).toHaveURL(/\/equipment\/?$/);
});

test('manifest link href is /manifest.webmanifest on root', async ({page}) => {
  await page.goto('/');
  await waitForAppReady(page);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
});

test('manifest link href swaps to dailys manifest on /dailys', async ({page}) => {
  await page.goto('/dailys');
  await waitForAppReady(page);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-dailys.webmanifest');
});

test('manifest link href swaps to equipment manifest on /equipment', async ({page}) => {
  await page.goto('/equipment');
  await waitForAppReady(page);

  // The module-scope shim runs before React mounts, so the link href
  // should be set by the time we read the DOM.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest-equipment.webmanifest');
});

test('manifest link href tracks navigation between /equipment and /dailys', async ({page}) => {
  // Land on /equipment — module-scope shim sets the equipment manifest.
  await page.goto('/equipment');
  await waitForAppReady(page);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-equipment.webmanifest', {
    timeout: 5_000,
  });

  // Navigate to /dailys and confirm the manifest href tracks the active URL.
  // (The former in-app SPA hop used the anon FuelingHub "Back to Daily
  // Reports" button; the hubs are login-required as of Lane 1 CP1, so this
  // exercises the same applyManifestHref pathname effect via a fresh load.)
  await page.goto('/dailys');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/dailys\/?$/, {timeout: 5_000});
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-dailys.webmanifest', {
    timeout: 5_000,
  });
});
