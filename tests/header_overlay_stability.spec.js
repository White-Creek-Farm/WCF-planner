import {test, expect} from './fixtures.js';

// ============================================================================
// Header-local overlay state must survive background App re-renders.
//
// Regression (Final Playwright closure lane): App defined <Header/> as a fresh
// arrow function every render, so ANY App state change remounted HeaderBase
// and discarded its local state — an open notifications panel silently closed
// while a Home update landed (CI: cattle_log_mention_deeplink saw the panel
// vanish between the bell click and the panel assertion). The stable
// AppBoundHeader wrapper keeps one component identity for the App lifetime.
//
// The probe uses window._wcfConfirm — the global confirm prompt is App-level
// state, so raising and dismissing it is a deterministic background App
// re-render of exactly the class that used to remount the Header.
// ============================================================================

test('notifications panel stays open across background App re-renders', async ({page, resetDb}) => {
  await resetDb();
  await page.goto('/');

  await page.locator('[data-notifications-header-link="1"]').click();
  const panel = page.locator('[data-notifications-panel-loaded="1"]');
  await expect(panel).toBeVisible({timeout: 15_000});

  // Background App re-render #1: raise the app-level confirm prompt.
  await page.evaluate(() => window._wcfConfirm('header identity probe', () => {}));
  const confirm = page.locator('[data-confirm-modal="1"]');
  await expect(confirm).toBeVisible();
  await expect(panel).toBeVisible();

  // Background App re-render #2: dismiss it again.
  await confirm.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(confirm).toHaveCount(0);
  await expect(panel).toBeVisible();

  // The panel still closes through its own affordance (scrim click), so the
  // stable identity did not freeze overlay behavior.
  await page.locator('[data-notifications-panel-scrim="1"]').click();
  await expect(page.locator('[data-notifications-panel="1"]')).toHaveCount(0);
});
