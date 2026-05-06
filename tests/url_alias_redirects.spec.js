import {test, expect} from './fixtures.js';

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
// up on the canonical with the same hub rendered.
// ============================================================================

test.use({storageState: {cookies: [], origins: []}});

test('/webforms redirects to /dailys (anon)', async ({page}) => {
  await page.goto('/webforms');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page).toHaveURL(/\/dailys\/?$/, {timeout: 10_000});
  await expect(page.getByText('Select a report type to fill out')).toBeVisible({timeout: 10_000});
});

test('/webforms/sheep redirects to /dailys/sheep (anon)', async ({page}) => {
  await page.goto('/webforms/sheep');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page).toHaveURL(/\/dailys\/sheep\/?$/, {timeout: 10_000});
});

test('/webforms/tasks redirects to /dailys/tasks (anon)', async ({page}) => {
  await page.goto('/webforms/tasks');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page).toHaveURL(/\/dailys\/tasks\/?$/, {timeout: 10_000});
});

test('/fueling redirects to /equipment (anon)', async ({page}) => {
  await page.goto('/fueling');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page).toHaveURL(/\/equipment\/?$/, {timeout: 10_000});
  await expect(page.getByText('Tap your equipment to log a fueling')).toBeVisible({timeout: 10_000});
});

test('/fueling/supply redirects to /equipment/supply (anon)', async ({page}) => {
  await page.goto('/fueling/supply');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page).toHaveURL(/\/equipment\/supply\/?$/, {timeout: 10_000});
});
