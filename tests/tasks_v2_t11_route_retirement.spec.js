import {test, expect} from './fixtures.js';

// ============================================================================
// Tasks v2 T11 — legacy route retirement.
//
// /tasks is the canonical Task Center surface. Direct visits to the
// retired /my-tasks and /admin/tasks paths must redirect to /tasks via
// the URL adapter's ALIASES_EXACT map. The Header burger menu's
// pre-T11 entries are gone; the dark-bar ✅ Tasks button is the single
// canonical destination. The non-admin gate on the System tab still
// holds across the redirect.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (TEST_ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function signInAsSimon(page) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (_e) {
      /* test cleanup */
    }
  });
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill('simon.tasks@wcfplanner.test');
  await page.getByPlaceholder('••••••••').fill('apply_test_mig_052_placeholder_password');
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

test.describe('Tasks v2 T11 — legacy route retirement', () => {
  test('admin visiting /my-tasks lands on /tasks Task Center', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);

    await page.goto('/my-tasks');
    await expect(page).toHaveURL(/\/tasks(?:[/?#]|$)/);
    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();
    await expect(page.locator('[data-tasks-tab="my-tasks"]')).toBeVisible();
  });

  test('admin visiting /admin/tasks lands on /tasks with the System tab visible', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);

    await page.goto('/admin/tasks');
    await expect(page).toHaveURL(/\/tasks(?:[/?#]|$)/);
    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="system"]')).toBeVisible();
  });

  test('non-admin visiting /admin/tasks lands on /tasks but the System tab stays hidden', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);

    await signInAsSimon(page);
    await page.goto('/admin/tasks');
    await expect(page).toHaveURL(/\/tasks(?:[/?#]|$)/);
    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();
    // Non-admin gating still holds across the redirect.
    await expect(page.locator('[data-tasks-tab-button="system"]')).toHaveCount(0);
    // The other three tabs still render.
    await expect(page.locator('[data-tasks-tab-button="mine"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="recurring"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="completed"]')).toBeVisible();
  });

  test('Header exposes a single Tasks destination — burger menu drops the legacy entries', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);

    await page.goto('/');
    // Dark-bar Tasks button still present.
    await expect(page.locator('[data-tasks-header-link="1"]').first()).toBeVisible();

    // Open the burger menu (admin sees Users + Sign Out only — no
    // Tasks/My Tasks entries). The button's accessible NAME is "Menu"
    // (aria-label) — the ☰ glyph is its visual content, not its name.
    await page.getByRole('button', {name: 'Menu'}).click();
    // The burger no longer shows "My Tasks" or "Tasks Center" entries.
    await expect(page.getByRole('button', {name: /My Tasks/})).toHaveCount(0);
    await expect(page.getByRole('button', {name: /Tasks Center/})).toHaveCount(0);
    // 👥 Users still surfaces for admins.
    await expect(page.getByRole('button', {name: /Users/})).toBeVisible();
  });
});
