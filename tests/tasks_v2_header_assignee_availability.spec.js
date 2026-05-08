import {test, expect} from './fixtures.js';

// ============================================================================
// Header webforms grouping + Equipment rename + Tasks divider
// AND
// Task Center assignee availability mapping (writes use the same hidden-profile
// filter that /webforms/tasks already uses).
//
// Codex spec for this lane:
//   * Dailys + Equipment buttons live inside a labeled "Webforms" group;
//     a divider sits between that group and the ✅ Tasks button so Tasks
//     doesn't read as another webform link.
//   * The "🚜 Equipment" button keeps its setView('fuelingHub') routing —
//     only the label changed.
//   * Profiles hidden via webform_config.tasks_public_assignee_availability
//     (.hiddenProfileIds) must NOT appear in NewTask, Reassign,
//     RecurringTemplate, or SystemRule dropdowns.
//   * Existing tasks/templates/rules already assigned to a hidden profile
//     must still display the person's name (read-only).
//   * The 📎 photo icon button on My Tasks + Completed rows is at least
//     32px (we set 36px) so it's a real tap/click target.
//
// All tests run as the seeded test admin (storageState in playwright.config)
// so admin write controls render.
// ============================================================================

async function seedAdminProfile(supabaseAdmin) {
  const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
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

async function profileIdByName(supabaseAdmin, fullName) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', fullName).limit(1);
  if (!data || data.length === 0) throw new Error(`profile "${fullName}" not found in TEST DB`);
  return data[0].id;
}

async function seedHiddenAssignees(supabaseAdmin, hiddenProfileIds) {
  await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'tasks_public_assignee_availability', data: {hiddenProfileIds}}, {onConflict: 'key'});
}

test.describe('Header — Webforms grouping + Equipment rename + Tasks divider', () => {
  test('renders Webforms label, Dailys + Equipment buttons, and a divider before Tasks', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);

    await page.goto('/');

    // Webforms group + label.
    const group = page.locator('[data-header-webforms-group="1"]');
    await expect(group).toBeVisible();
    await expect(page.locator('[data-header-webforms-label="1"]')).toHaveText(/^Webforms$/);

    // Dailys still present (we didn't rename it). Equipment renamed.
    await expect(group.getByText('📝 Dailys')).toBeVisible();
    const equipmentBtn = page.locator('[data-header-webforms-equipment="1"]');
    await expect(equipmentBtn).toBeVisible();
    await expect(equipmentBtn).toHaveText(/🚜\s*Equipment/);

    // Equipment routes to fuelingHub (i.e. /equipment) after the label change.
    await equipmentBtn.click();
    await expect(page).toHaveURL(/\/equipment\b/);

    // Back to home so the divider + Tasks button are still in the dark bar.
    await page.goto('/');
    await expect(page.locator('[data-header-tasks-divider="1"]')).toBeVisible();
    await expect(page.locator('[data-tasks-header-link="1"]')).toBeVisible();
  });
});

test.describe('Tasks v2 — assignee availability filter on Task Center mutation dropdowns', () => {
  test('hidden profile is absent from NewTask/Reassign/RecurringTemplate/SystemRule dropdowns', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    const makId = await profileIdByName(supabaseAdmin, 'Mak');

    // Hide Simon via the public-tasks availability config. Mak stays visible.
    await seedHiddenAssignees(supabaseAdmin, [simonId]);

    // Seed a task to reassign and a template to edit.
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-hav-mak-row',
      assignee_profile_id: makId,
      due_date: '2026-06-01',
      title: 'Reassign target row (assigned to Mak)',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
    });
    await supabaseAdmin.from('task_templates').upsert(
      {
        id: 'tpl-hav-mak',
        title: 'hidden-availability template owned by Mak',
        assignee_profile_id: makId,
        recurrence: 'weekly',
        recurrence_interval: 1,
        first_due_date: '2026-08-01',
        active: false,
      },
      {onConflict: 'id'},
    );
    // The four built-in system rules are seeded by mig 052; rebind one to
    // Mak so we can open its edit modal and inspect the assignee dropdown.
    await supabaseAdmin
      .from('task_system_rules')
      .update({assignee_profile_id: makId, active: true})
      .eq('id', 'broiler-4wk-weighin');

    await page.goto('/tasks');

    async function expectDropdownOmits(selector, hiddenId, presentId) {
      // Wait for the dropdown to populate (the assignable map loads async).
      await expect
        .poll(
          async () => {
            const opts = page.locator(`${selector} option`);
            const ids = await opts.evaluateAll((els) => els.map((e) => e.getAttribute('value')));
            return ids.includes(presentId);
          },
          {timeout: 10_000},
        )
        .toBe(true);
      const opts = page.locator(`${selector} option`);
      const ids = await opts.evaluateAll((els) => els.map((e) => e.getAttribute('value')));
      expect(ids, `${selector} should not contain hidden id ${hiddenId}`).not.toContain(hiddenId);
      expect(ids, `${selector} should still contain visible id ${presentId}`).toContain(presentId);
    }

    // 1) NewTask modal.
    await page.locator('[data-tasks-new-task-button="1"]').click();
    await expect(page.locator('[data-new-task-modal="1"]')).toBeVisible();
    await expectDropdownOmits('[data-new-task-field="assignee"]', simonId, makId);
    await page
      .locator('[data-new-task-modal="1"] button', {hasText: /^Cancel$/})
      .first()
      .click();
    await expect(page.locator('[data-new-task-modal="1"]')).toHaveCount(0);

    // 2) Reassign modal — Mak's row sits under his "others" group. Expand
    //    it, then click the assign affordance.
    await page.locator(`[data-tasks-group="${makId}"] button`).first().click();
    await page.locator('[data-task-row="tic-hav-mak-row"] [data-task-assign-button="1"]').click();
    await expect(page.locator('[data-assign-task-modal="1"]')).toBeVisible();
    await expectDropdownOmits('[data-assign-task-field="target"]', simonId, makId);
    await page
      .locator('[data-assign-task-modal="1"] button', {hasText: /^Cancel$/})
      .first()
      .click();
    await expect(page.locator('[data-assign-task-modal="1"]')).toHaveCount(0);

    // 3) Recurring template modal.
    await page.locator('[data-tasks-tab-button="recurring"]').click();
    const recurringTab = page.locator('[data-tasks-tab="recurring"]');
    await recurringTab.locator('[data-recurring-template="tpl-hav-mak"] button').first().click();
    await recurringTab.locator('[data-recurring-edit-button="tpl-hav-mak"]').click();
    await expect(page.locator('[data-recurring-template-modal="1"]')).toBeVisible();
    await expectDropdownOmits('[data-recurring-template-field="assignee"]', simonId, makId);
    await page
      .locator('[data-recurring-template-modal="1"] button', {hasText: /^Cancel$/})
      .first()
      .click();
    await expect(page.locator('[data-recurring-template-modal="1"]')).toHaveCount(0);

    // 4) System rule edit modal.
    await page.locator('[data-tasks-tab-button="system"]').click();
    const systemTab = page.locator('[data-tasks-tab="system"]');
    await systemTab.locator('[data-system-rule="broiler-4wk-weighin"] button').first().click();
    await systemTab.locator('[data-system-rule-edit-button="broiler-4wk-weighin"]').click();
    await expect(page.locator('[data-system-rule-modal="1"]')).toBeVisible();
    await expectDropdownOmits('[data-system-rule-field="assignee"]', simonId, makId);
  });

  test('row already assigned to a hidden profile still displays the name in read-only context', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');

    // Seed a row owned by Simon, then hide Simon afterwards so the
    // existing row is "stranded" with a hidden assignee.
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-hav-simon-stranded',
      assignee_profile_id: simonId,
      due_date: '2026-06-01',
      title: 'Stranded Simon row — hidden assignee, name still shows',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
    });
    await seedHiddenAssignees(supabaseAdmin, [simonId]);

    await page.goto('/tasks');

    // Simon's group still renders with the proper name (display map is
    // unfiltered). The row is visible inside the group.
    const simonGroup = page.locator(`[data-tasks-group="${simonId}"]`);
    await expect(simonGroup).toBeVisible();
    await expect(simonGroup).toContainText('Simon');
    await simonGroup.locator('button').first().click();
    await expect(page.locator('[data-task-row="tic-hav-simon-stranded"]')).toBeVisible();

    // Reassign modal opens with target='' (— Select —) so admin must pick
    // a visible assignee. The hidden current assignee is NOT pre-selected.
    await page.locator('[data-task-row="tic-hav-simon-stranded"] [data-task-assign-button="1"]').click();
    const modal = page.locator('[data-assign-task-modal="1"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-assign-task-field="target"]')).toHaveValue('');
  });
});

test.describe('Tasks v2 — photo icon size on My Tasks and Completed', () => {
  test('paperclip 📎 button is at least 32px on both tabs', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);

    // Seed two rows that have photo paths so the indicator/button renders.
    await supabaseAdmin.from('task_instances').insert([
      {
        id: 'tic-photo-open',
        assignee_profile_id: adminId,
        due_date: '2026-06-01',
        title: 'open task with photo',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
        request_photo_path: `task-request-photos/${adminId}/tic-photo-open/r-1.jpg`,
      },
      {
        id: 'tic-photo-completed',
        assignee_profile_id: adminId,
        due_date: '2026-06-01',
        title: 'completed task with photo',
        submission_source: 'admin_manual',
        status: 'completed',
        from_recurring_template: false,
        completed_at: new Date().toISOString(),
        completion_photo_path: `task-photos/${adminId}/tic-photo-completed/c-1.jpg`,
      },
    ]);

    await page.goto('/tasks');

    // My Tasks: paperclip button on the open row.
    const openBtn = page.locator('[data-task-row="tic-photo-open"] [data-task-photo-open="1"]').first();
    await expect(openBtn).toBeVisible();
    const openSize = await openBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(openSize).toBeGreaterThanOrEqual(32);

    // Completed tab: paperclip button on the completed row.
    await page.locator('[data-tasks-tab-button="completed"]').click();
    const completedBtn = page
      .locator('[data-tasks-tab="completed"] [data-task-row="tic-photo-completed"] [data-task-photo-open="1"]')
      .first();
    await expect(completedBtn).toBeVisible();
    const completedSize = await completedBtn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(completedSize).toBeGreaterThanOrEqual(32);
  });
});
