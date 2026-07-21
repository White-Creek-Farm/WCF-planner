import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// URL alias redirects — 2026-05-06 public-URL rename
// ============================================================================
// The rename moved the public daily-reports hub from /webforms to /dailys
// and the public equipment/fueling hub from /fueling to /equipment, with the
// logged-in equipment module moving to /fleet. Operators with bookmarks or
// printed materials hitting the legacy paths must still land on the right
// hub, and the address bar should update to canonical (so a refresh shows
// the new URL).
//
// main.jsx's URL→view effect resolves aliases via react-router
// navigate({replace:true}), so the assertion is: visit a legacy path, end
// up on the canonical URL.
//
// Lane 1 CP1: the form surfaces are now login-required. Alias resolution still
// runs FIRST (before the auth decision), so a legacy path still redirects to
// canonical — then a logged-out visitor sees the LoginScreen (and returns to
// the requested URL after authenticating). These specs lock that order:
// legacy path → canonical URL → LoginScreen, with the canonical URL preserved.
// ============================================================================

test.use({storageState: {cookies: [], origins: []}});

test('/webforms redirects to /dailys then login gate (anon)', async ({page}) => {
  await page.goto('/webforms');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/dailys\/?$/, {timeout: 10_000});
  // Login-required: logged-out visitor sees LoginScreen, not the hub. The
  // canonical URL is preserved so login returns them to /dailys.
  await expect(page.locator('[data-login-screen]')).toBeVisible({timeout: 10_000});
});

test('/webforms/sheep redirects to /dailys/sheep (anon)', async ({page}) => {
  await page.goto('/webforms/sheep');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/dailys\/sheep\/?$/, {timeout: 10_000});
});

test('/webforms/tasks redirects to /dailys/tasks (anon)', async ({page}) => {
  await page.goto('/webforms/tasks');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/dailys\/tasks\/?$/, {timeout: 10_000});
});

test('/fueling redirects to /equipment then login gate (anon)', async ({page}) => {
  await page.goto('/fueling');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/equipment\/?$/, {timeout: 10_000});
  // Login-required: logged-out visitor sees LoginScreen, not the hub.
  await expect(page.locator('[data-login-screen]')).toBeVisible({timeout: 10_000});
});

test('/fueling/supply redirects to /equipment/supply (anon)', async ({page}) => {
  await page.goto('/fueling/supply');
  await waitForAppReady(page);
  await expect(page).toHaveURL(/\/equipment\/supply\/?$/, {timeout: 10_000});
});
