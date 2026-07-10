import {test, expect} from './fixtures.js';

const createdUserIds = new Set();

async function createUser(supabaseAdmin, label, role = 'farm_team') {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const email = `user-mgmt-${label}-${stamp}@example.invalid`;
  const password = `UserMgmt-${crypto.randomUUID()}!`;
  const {data, error} = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {full_name: `User Mgmt ${label}`},
  });
  if (error || !data?.user?.id) throw new Error(`create user: ${error?.message || 'no id'}`);
  const id = data.user.id;
  createdUserIds.add(id);
  const {error: profileError} = await supabaseAdmin
    .from('profiles')
    .upsert({id, email, full_name: `User Mgmt ${label}`, role, program_access: null}, {onConflict: 'id'});
  if (profileError) throw new Error(`create profile: ${profileError.message}`);
  return {id, email, password};
}

async function openUsers(page) {
  await page.goto('/');
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 20_000});
  await page.locator('[data-header-menu-toggle="1"]').click();
  await page.locator('[data-header-menu-item="users"]').click();
  await expect(page.locator('[data-user-management-modal="1"]')).toBeVisible();
}

async function profileRow(supabaseAdmin, id) {
  const {data, error} = await supabaseAdmin.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

test.describe.serial('audited user management', () => {
  test.afterEach(async ({supabaseAdmin}) => {
    const ids = [...createdUserIds];
    if (ids.length) {
      await supabaseAdmin.from('user_management_audit').delete().in('target_profile_id', ids);
      await supabaseAdmin.from('user_management_audit').delete().in('actor_profile_id', ids);
    }
    for (const id of ids) await supabaseAdmin.auth.admin.deleteUser(id);
    createdUserIds.clear();
  });

  test('admin edits name/access/role, deactivates, and sees delete failure without local data loss', async ({
    page,
    supabaseAdmin,
  }) => {
    const target = await createUser(supabaseAdmin, 'admin-flow');
    await openUsers(page);

    // The signed-in admin cannot lock out the final administration path from
    // the browser: self role is disabled and self destructive actions are not
    // rendered. Server-side RPC checks independently enforce the same rule.
    const selfRow = page.locator('[data-user-management-row]').filter({hasText: 'you'});
    await expect(selfRow.locator('[data-user-management-role]')).toBeDisabled();
    await expect(selfRow.locator('[data-user-management-delete]')).toHaveCount(0);

    const row = page.locator(`[data-user-management-row="${target.id}"]`);
    await expect(row).toBeVisible();

    await row.locator(`[data-user-management-edit-name="${target.id}"]`).click();
    const nameInput = row.locator(`[data-user-management-name-input="${target.id}"]`);
    await nameInput.fill('Browser Audited Name');
    await nameInput.press('Enter');
    await expect.poll(async () => (await profileRow(supabaseAdmin, target.id))?.full_name).toBe('Browser Audited Name');
    await expect(row).toContainText('Browser Audited Name');

    // Null means all six programs. Clicking Equipment removes only that key.
    await row.locator(`[data-user-management-program="${target.id}:equipment"]`).click();
    await expect
      .poll(async () => (await profileRow(supabaseAdmin, target.id))?.program_access)
      .toEqual(['broiler', 'layer', 'pig', 'cattle', 'sheep']);

    await row.locator(`[data-user-management-role="${target.id}"]`).selectOption('equipment_tech');
    await expect.poll(async () => (await profileRow(supabaseAdmin, target.id))?.role).toBe('equipment_tech');

    await row.locator(`[data-user-management-deactivate="${target.id}"]`).click();
    const confirm = page.locator('[data-confirm-modal="1"]');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', {name: 'Deactivate', exact: true}).click();
    await expect.poll(async () => (await profileRow(supabaseAdmin, target.id))?.role).toBe('inactive');

    const {data: events} = await supabaseAdmin
      .from('user_management_audit')
      .select('event_type')
      .eq('target_profile_id', target.id);
    const eventTypes = new Set((events || []).map((event) => event.event_type));
    for (const eventType of [
      'profile.name_changed',
      'profile.program_access_changed',
      'profile.role_changed',
      'profile.deactivated',
    ]) {
      expect(eventTypes.has(eventType), eventType).toBe(true);
    }

    // Browser failure behavior is deterministic and does not require deploying
    // rapid-processor into TEST for this source-code lane.
    await page.route('**/functions/v1/rapid-processor', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        headers: {'access-control-allow-origin': '*'},
        body: JSON.stringify({
          error: 'user delete: account has retained farm records; deactivate it instead',
          step: 'deletePreflight',
        }),
      });
    });
    await row.locator(`[data-user-management-delete="${target.id}"]`).click();
    const deleteModal = page.locator('[data-delete-modal="1"]');
    await deleteModal.getByLabel('Type delete to confirm').fill('delete');
    await deleteModal.getByRole('button', {name: 'Delete', exact: true}).click();
    await expect(page.locator('[data-user-management-message="error"]')).toContainText(/Could not delete/i);
    await expect(row).toBeVisible();
    expect((await profileRow(supabaseAdmin, target.id))?.role).toBe('inactive');
  });

  test('non-admin browser never receives the Users management entry', async ({browser, supabaseAdmin}) => {
    const user = await createUser(supabaseAdmin, 'non-admin');
    const context = await browser.newContext({storageState: {cookies: [], origins: []}});
    const page = await context.newPage();
    await page.goto('/');
    await page.getByPlaceholder('your@email.com').first().fill(user.email);
    await page.getByPlaceholder('••••••••').fill(user.password);
    await page.getByRole('button', {name: /^sign in$/i}).click();
    await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 20_000});
    await page.locator('[data-header-menu-toggle="1"]').click();
    await expect(page.locator('[data-header-menu-item="users"]')).toHaveCount(0);
    await context.close();
  });
});
