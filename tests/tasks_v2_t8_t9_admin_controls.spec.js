import {test, expect} from './fixtures.js';

// ============================================================================
// Tasks v2 T8 + T9 — due-date edits, assign/delete, recurring + system admin.
//
// Every DB write hits a v2 SECURITY DEFINER RPC (mig 053) or the
// admin-RLS-gated direct write to task_templates / task_system_rules.
// The spec asserts the surface, not the RPC internals — those are
// already covered by tasks_v2_rpcs.spec.js.
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

async function profileIdByName(supabaseAdmin, fullName) {
  const {data} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', fullName).limit(1);
  if (!data || data.length === 0) throw new Error(`profile "${fullName}" not found in TEST DB`);
  return data[0].id;
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

test.describe('Tasks v2 T8 — Edit Due Date', () => {
  test('regular assignee edits own due date; new edit appears in history', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-t8-simon-edit',
      template_id: null,
      assignee_profile_id: simonId,
      due_date: '2026-06-01',
      title: 'T8 Simon edits own due date',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
    });

    await signInAsSimon(page);
    await page.goto('/tasks');

    const row = page.locator('[data-task-row="tic-t8-simon-edit"]');
    await expect(row).toBeVisible();
    await row.locator('[data-task-edit-due-button="1"]').click();

    const modal = page.locator('[data-edit-due-date-modal="1"]');
    await expect(modal).toBeVisible();
    // History starts empty.
    await expect(modal.locator('[data-edit-due-history-empty="1"]')).toBeVisible();
    // Cap state shows 0/2 used for regular Simon.
    await expect(modal.locator('[data-edit-due-cap-state="0/2"]')).toBeVisible();

    await modal.locator('[data-edit-due-field="new-date"]').fill('2026-07-15');
    await modal.locator('[data-edit-due-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // Reopen — history now has one entry, cap shows 1/2.
    await page.locator('[data-task-row="tic-t8-simon-edit"] [data-task-edit-due-button="1"]').click();
    const modal2 = page.locator('[data-edit-due-date-modal="1"]');
    await expect(modal2.locator('[data-edit-due-history-list="1"]')).toBeVisible();
    await expect(modal2.locator('[data-edit-due-cap-state="1/2"]')).toBeVisible();
    // The single audit row's role is 'regular'.
    await expect(modal2.locator('[data-edit-due-history-row][data-edit-due-history-role="regular"]')).toHaveCount(1);
  });

  test('regular user cannot see Edit Due button on another user’s task', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    await supabaseAdmin.from('task_instances').insert([
      {
        id: 'tic-t8-admin-only',
        assignee_profile_id: adminId,
        due_date: '2026-06-01',
        title: 'admin task simon should NOT edit',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
      },
      {
        id: 'tic-t8-simon-own',
        assignee_profile_id: simonId,
        due_date: '2026-06-01',
        title: 'simon row',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
      },
    ]);

    await signInAsSimon(page);
    await page.goto('/tasks');

    // Simon sees own row with Edit Due button.
    await expect(page.locator('[data-task-row="tic-t8-simon-own"] [data-task-edit-due-button="1"]')).toBeVisible();

    // Expand admin's group; Simon does NOT see Edit Due on the admin row.
    const adminGroup = page.locator(`[data-tasks-group="${adminId}"]`);
    await adminGroup.locator('button').first().click();
    await expect(page.locator('[data-task-row="tic-t8-admin-only"] [data-task-edit-due-button="1"]')).toHaveCount(0);
  });

  test('regular user blocked at 2/2 edit cap; admin edits same row without bumping the cap', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    // Pre-seed Simon at 2/2 cap.
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-t8-cap-hit',
      assignee_profile_id: simonId,
      due_date: '2026-06-01',
      title: 'T8 cap-hit row',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
      due_date_edit_count: 2,
    });

    // Simon: cap hit, Save disabled.
    await signInAsSimon(page);
    await page.goto('/tasks');
    await page.locator('[data-task-row="tic-t8-cap-hit"] [data-task-edit-due-button="1"]').click();
    const simonModal = page.locator('[data-edit-due-date-modal="1"]');
    await expect(simonModal.locator('[data-edit-due-cap-state="2/2"]')).toBeVisible();
    await expect(simonModal.locator('[data-edit-due-save="1"]')).toBeDisabled();
    await simonModal
      .locator('button', {hasText: /^Cancel$/})
      .first()
      .click();

    // Admin signs back in (overwrite Simon storage).
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_e) {
        /* test cleanup */
      }
    });
    await page.goto('/');
    await page.getByPlaceholder('your@email.com').first().fill(TEST_ADMIN_EMAIL);
    await page.getByPlaceholder('••••••••').fill(process.env.VITE_TEST_ADMIN_PASSWORD || 'admin_password_unset');
    await page.getByRole('button', {name: /^sign in$/i}).click();
    await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});

    await page.goto('/tasks');
    // Simon's row is in the others section; expand and click Edit Due as admin.
    await page.locator(`[data-tasks-group="${simonId}"] button`).first().click();
    await page.locator('[data-task-row="tic-t8-cap-hit"] [data-task-edit-due-button="1"]').click();
    const adminModal = page.locator('[data-edit-due-date-modal="1"]');
    await expect(adminModal.locator('[data-edit-due-cap-state="admin-unlimited"]')).toBeVisible();
    await adminModal.locator('[data-edit-due-field="new-date"]').fill('2026-08-20');
    await adminModal.locator('[data-edit-due-save="1"]').click();
    await expect(adminModal).toHaveCount(0);

    // Server-side: admin edit doesn't bump the regular cap.
    const {data: row} = await supabaseAdmin
      .from('task_instances')
      .select('due_date, due_date_edit_count')
      .eq('id', 'tic-t8-cap-hit')
      .maybeSingle();
    expect(row.due_date).toBe('2026-08-20');
    expect(row.due_date_edit_count).toBe(2);
  });
});

test.describe('Tasks v2 T9 — Assign / Delete / Admin controls', () => {
  test('admin reassigns an open task; UI grouping refreshes', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    const makId = await profileIdByName(supabaseAdmin, 'Mak');
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-t9-assign',
      assignee_profile_id: simonId,
      due_date: '2026-06-01',
      title: 'T9 admin reassigns simon row to mak',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
      created_by_profile_id: adminId,
    });

    await page.goto('/tasks');
    await page.locator(`[data-tasks-group="${simonId}"] button`).first().click();
    await page.locator('[data-task-row="tic-t9-assign"] [data-task-assign-button="1"]').click();

    const modal = page.locator('[data-assign-task-modal="1"]');
    await expect(modal).toBeVisible();
    await modal.locator('[data-assign-task-field="target"]').selectOption(makId);
    await modal.locator('[data-assign-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // Row now lives under Mak's group.
    await page.locator(`[data-tasks-group="${makId}"] button`).first().click();
    await expect(page.locator(`[data-tasks-group-body="${makId}"] [data-task-row="tic-t9-assign"]`)).toBeVisible();
  });

  test('admin deletes an open task with typed confirmation', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    await supabaseAdmin.from('task_instances').insert({
      id: 'tic-t9-delete',
      assignee_profile_id: adminId,
      due_date: '2099-12-31',
      title: 'T9 admin deletes a task',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
      created_by_profile_id: adminId,
    });

    await page.goto('/tasks');
    await page.locator('[data-task-row="tic-t9-delete"] [data-task-delete-button="1"]').click();

    const modal = page.locator('[data-delete-task-modal="1"]');
    await expect(modal).toBeVisible();
    // Save is disabled until "DELETE" is typed.
    await expect(modal.locator('[data-delete-task-save="1"]')).toBeDisabled();
    await modal.locator('[data-delete-task-field="confirm"]').fill('DELETE');
    await expect(modal.locator('[data-delete-task-save="1"]')).toBeEnabled();
    await modal.locator('[data-delete-task-save="1"]').click();
    await expect(modal).toHaveCount(0);

    await expect(page.locator('[data-task-row="tic-t9-delete"]')).toHaveCount(0);
    const {data: row} = await supabaseAdmin.from('task_instances').select('id').eq('id', 'tic-t9-delete').maybeSingle();
    expect(row).toBeNull();
  });

  test('admin creates, edits, and deletes a recurring template', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');

    await page.goto('/tasks');
    await page.locator('[data-tasks-tab-button="recurring"]').click();
    const tab = page.locator('[data-tasks-tab="recurring"]');
    await expect(tab).toBeVisible();

    // Create.
    await tab.locator('[data-recurring-new-button="1"]').click();
    const newModal = page.locator('[data-recurring-template-modal="1"][data-recurring-template-mode="new"]');
    await newModal.locator('[data-recurring-template-field="title"]').fill('T9 admin recurring create');
    await newModal.locator('[data-recurring-template-field="description"]').fill('seeded by t8t9 spec');
    await newModal.locator('[data-recurring-template-field="assignee"]').selectOption(simonId);
    await newModal.locator('[data-recurring-template-field="recurrence"]').selectOption('weekly');
    await newModal.locator('[data-recurring-template-field="interval"]').fill('1');
    await newModal.locator('[data-recurring-template-field="first-due-date"]').fill('2026-08-01');
    await newModal.locator('[data-recurring-template-field="active"]').check();
    await newModal.locator('[data-recurring-template-save="1"]').click();
    await expect(newModal).toHaveCount(0);

    // The new template appears in the list.
    const card = tab.locator('[data-recurring-template]').filter({hasText: 'T9 admin recurring create'});
    await expect(card).toBeVisible();

    // Capture the new template's id from the data attribute.
    const newTplId = await card.evaluate((el) => el.getAttribute('data-recurring-template'));
    expect(newTplId).toBeTruthy();

    // Edit: expand card, change title, save.
    await tab.locator(`[data-recurring-template="${newTplId}"] button`).first().click();
    await tab.locator(`[data-recurring-edit-button="${newTplId}"]`).click();
    const editModal = page.locator('[data-recurring-template-modal="1"][data-recurring-template-mode="edit"]');
    await editModal.locator('[data-recurring-template-field="title"]').fill('T9 admin recurring renamed');
    await editModal.locator('[data-recurring-template-save="1"]').click();
    await expect(editModal).toHaveCount(0);
    await expect(
      tab.locator('[data-recurring-template]').filter({hasText: 'T9 admin recurring renamed'}),
    ).toBeVisible();

    // Delete with typed confirmation. The card's expanded state is local
    // React state and survives the post-edit data refresh, so the body
    // (and the Delete button inside it) is already in the DOM.
    await tab.locator(`[data-recurring-delete-button="${newTplId}"]`).click();
    const deleteModal = page.locator('[data-delete-template-modal="1"]');
    await expect(deleteModal).toBeVisible();
    await expect(deleteModal.locator('[data-delete-template-save="1"]')).toBeDisabled();
    await deleteModal.locator('[data-delete-template-field="confirm"]').fill('DELETE');
    await deleteModal.locator('[data-delete-template-save="1"]').click();
    await expect(deleteModal).toHaveCount(0);
    await expect(tab.locator(`[data-recurring-template="${newTplId}"]`)).toHaveCount(0);
  });

  test('admin updates a system rule’s assignee, lead time, and active state', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    const makId = await profileIdByName(supabaseAdmin, 'Mak');
    // Ensure the rule exists with a known starting state. Mig 052 seeds
    // the four built-ins; resetDb keeps them intact.
    await supabaseAdmin.from('task_system_rules').upsert(
      {
        id: 'broiler-4wk-weighin',
        name: 'Broiler 4-week weigh-in',
        description: 'seeded by t8t9 spec',
        assignee_profile_id: simonId,
        generator_kind: 'broiler_4wk_weighin',
        lead_time_days: 3,
        active: true,
      },
      {onConflict: 'id'},
    );

    await page.goto('/tasks');
    await page.locator('[data-tasks-tab-button="system"]').click();
    const tab = page.locator('[data-tasks-tab="system"]');

    // Expand and click Edit Rule.
    await tab.locator('[data-system-rule="broiler-4wk-weighin"] button').first().click();
    await tab.locator('[data-system-rule-edit-button="broiler-4wk-weighin"]').click();

    const modal = page.locator('[data-system-rule-modal="1"]');
    await expect(modal).toBeVisible();
    // id and generator_kind are read-only labels, not editable inputs.
    await expect(modal.locator('[data-system-rule-readonly-id="broiler-4wk-weighin"]')).toBeVisible();
    await expect(modal.locator('[data-system-rule-readonly-kind="broiler_4wk_weighin"]')).toBeVisible();
    await expect(modal.locator('[data-system-rule-field="name"]')).toHaveCount(0);
    await expect(modal.locator('[data-system-rule-field="generator-kind"]')).toHaveCount(0);

    // Change assignee → Mak; lead time → 5; active → false.
    await modal.locator('[data-system-rule-field="assignee"]').selectOption(makId);
    await modal.locator('[data-system-rule-field="lead-time-days"]').fill('5');
    await modal.locator('[data-system-rule-field="active"]').uncheck();
    await modal.locator('[data-system-rule-save="1"]').click();
    await expect(modal).toHaveCount(0);

    // DB confirms.
    const {data: row} = await supabaseAdmin
      .from('task_system_rules')
      .select('assignee_profile_id, lead_time_days, active')
      .eq('id', 'broiler-4wk-weighin')
      .maybeSingle();
    expect(row.assignee_profile_id).toBe(makId);
    expect(row.lead_time_days).toBe(5);
    expect(row.active).toBe(false);
  });

  test('non-admin (Simon) does not see admin write controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    // Seed a recurring template owned by simon-as-assignee.
    await supabaseAdmin.from('task_templates').upsert(
      {
        id: 'tpl-t9-simon-visible',
        title: 'simon-visible template',
        description: 'visible to all but write-controls hidden',
        assignee_profile_id: simonId,
        recurrence: 'weekly',
        recurrence_interval: 1,
        first_due_date: '2026-08-01',
        active: false,
      },
      {onConflict: 'id'},
    );

    await signInAsSimon(page);
    await page.goto('/tasks');

    // Recurring tab — Simon sees templates but no admin controls. The
    // simon-visible template is seeded inactive (active=false), so under
    // the 2026-05-13 remaining-tabs pass it lives behind the collapsible
    // Inactive templates toggle (collapsed by default); expand it once
    // so the card is in the DOM before locating it.
    await page.locator('[data-tasks-tab-button="recurring"]').click();
    const recurringTab = page.locator('[data-tasks-tab="recurring"]');
    await recurringTab.locator('[data-recurring-inactive-toggle="1"]').click();
    await expect(recurringTab.locator('[data-recurring-template="tpl-t9-simon-visible"]')).toBeVisible();
    await expect(recurringTab.locator('[data-recurring-new-button="1"]')).toHaveCount(0);
    await expect(recurringTab.locator('[data-recurring-edit-button="tpl-t9-simon-visible"]')).toHaveCount(0);
    await expect(recurringTab.locator('[data-recurring-delete-button="tpl-t9-simon-visible"]')).toHaveCount(0);

    // System tab — Simon doesn't see the tab button at all.
    await expect(page.locator('[data-tasks-tab-button="system"]')).toHaveCount(0);
  });
});
