import {test, expect} from './fixtures.js';

// ============================================================================
// Session role resolution fails CLOSED (Final Playwright closure lane).
//
// Regression: loadUser resolved `profile?.role || 'farm_team'` when the
// profile fetch raced out or errored, so a transient DB stall silently
// DEMOTED the signed-in admin to the farm_team UI tier (CI: admin-only
// Templates button / System tab / Recurring controls / To Do Managers callout
// all "randomly" missing) — and would have ELEVATED a light/inactive user the
// same way. The contract: a profile fetch that cannot produce a row is
// retried, then fails closed to least-privilege 'inactive', never farm_team.
// ============================================================================

test('a failed profile load fails CLOSED to inactive — never the farm_team tier', async ({page, resetDb}) => {
  await resetDb();

  let abortedReads = 0;
  await page.route('**/rest/v1/profiles*', (route) => {
    if (route.request().method() === 'GET') {
      abortedReads += 1;
      route.abort();
      return;
    }
    route.continue();
  });

  await page.goto('/');

  // The app must land in the least-privilege state, not an assumed role.
  // (The chip's name line falls back to the account EMAIL when the profile is
  // unavailable — wcf-test-admin@… itself contains "admin", so assert on the
  // role tier only.)
  const chip = page.locator('[data-header-username]');
  await expect(chip).toBeVisible({timeout: 25_000});
  await expect(chip).toContainText('inactive');
  await expect(chip).not.toContainText('farm_team');

  // The capped fetch retried before giving up.
  expect(abortedReads).toBeGreaterThanOrEqual(3);
});
