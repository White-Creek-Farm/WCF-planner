import {test, expect} from './fixtures.js';

// ============================================================================
// Tasks v2 T3 + T4 — Header Tasks button + functional Completed/Recurring tabs.
//
// T3 (Header):
//   - Header Tasks button is visible to authenticated users.
//   - Clicking it lands on /tasks.
//   - Badge shows the count of own open task_instances with
//     due_date <= todayCentralISO(); hidden when zero.
//
// T4 (Task Center tabs):
//   - Completed tab shows completed rows, hides open rows, surfaces
//     completion_note / completed-by attribution / paperclip when a
//     photo path is populated.
//   - Recurring tab groups open recurring instances under their
//     parent templates, surfaces active/inactive state and open
//     counts, and routes orphans (template_id NULL) into the
//     dedicated bottom group. No edit/delete affordance.
//
// We deliberately use 2025-* due dates for "definitely past" rows and
// 2099-* due dates for "definitely future" rows so the assertions hold
// regardless of when the spec runs.
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

async function seedT3T4Fixture(supabaseAdmin) {
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await profileIdByName(supabaseAdmin, 'Simon');

  // Recurring templates — both upserted up front so the FK on
  // task_instances.template_id resolves when the instance batch lands.
  const {error: tplErrA} = await supabaseAdmin.from('task_templates').upsert(
    {
      id: 'tpl-spec-active',
      title: 'Spec recurring chore',
      description: 'seeded for tasks_v2_t3_t4 spec',
      assignee_profile_id: simonId,
      recurrence: 'daily',
      recurrence_interval: 1,
      first_due_date: '2026-01-01',
      active: true,
      created_by_profile_id: adminId,
    },
    {onConflict: 'id'},
  );
  if (tplErrA) throw new Error(`seedT3T4Fixture: tpl-spec-active upsert: ${tplErrA.message}`);
  const {error: tplErrB} = await supabaseAdmin.from('task_templates').upsert(
    {
      id: 'tpl-spec-inactive',
      title: 'Spec inactive chore',
      description: 'seeded inactive template',
      assignee_profile_id: simonId,
      recurrence: 'weekly',
      recurrence_interval: 2,
      first_due_date: '2026-01-15',
      active: false,
      created_by_profile_id: adminId,
    },
    {onConflict: 'id'},
  );
  if (tplErrB) throw new Error(`seedT3T4Fixture: tpl-spec-inactive upsert: ${tplErrB.message}`);

  const rows = [
    // Admin overdue — counts toward badge.
    {
      id: 'tic-t34-mine-overdue-1',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2025-01-01',
      title: 'Admin overdue 1',
      submission_source: 'admin_manual',
      status: 'open',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // Admin overdue — counts toward badge.
    {
      id: 'tic-t34-mine-overdue-2',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2025-06-01',
      title: 'Admin overdue 2',
      submission_source: 'admin_manual',
      status: 'open',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // Admin future — does NOT count toward badge.
    {
      id: 'tic-t34-mine-future',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2099-12-31',
      title: 'Admin future task',
      submission_source: 'admin_manual',
      status: 'open',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // Other-user overdue — does NOT count toward badge (not assigned to caller).
    {
      id: 'tic-t34-other-overdue',
      template_id: null,
      assignee_profile_id: simonId,
      due_date: '2025-01-01',
      title: 'Other-user overdue task',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: false,
    },
    // Admin completed task — surfaces in Completed tab. Note + photo + completed_by.
    {
      id: 'tic-t34-completed-mine',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2025-12-15',
      title: 'Admin completed task',
      description: 'description for the completed admin task',
      submission_source: 'admin_manual',
      status: 'completed',
      completed_at: '2025-12-16T17:30:00Z',
      completed_by_profile_id: adminId,
      completion_note: 'all done; cleaned and locked up',
      completion_photo_path: 'task-photos/admin/tic-t34-completed-mine/photo-1.jpg',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // Recurring open instance — bucket under tpl-spec-active.
    {
      id: 'tic-t34-recurring-a',
      template_id: 'tpl-spec-active',
      assignee_profile_id: simonId,
      due_date: '2026-05-15',
      title: 'Recurring instance A',
      submission_source: 'generated',
      status: 'open',
      from_recurring_template: true,
      designation: 'recurring',
    },
    // Recurring open instance — bucket under tpl-spec-active.
    {
      id: 'tic-t34-recurring-b',
      template_id: 'tpl-spec-active',
      assignee_profile_id: simonId,
      due_date: '2026-05-16',
      title: 'Recurring instance B',
      submission_source: 'generated',
      status: 'open',
      from_recurring_template: true,
      designation: 'recurring',
    },
    // Orphan recurring instance — template_id NULL (parent deleted).
    {
      id: 'tic-t34-recurring-orphan',
      template_id: null,
      assignee_profile_id: simonId,
      due_date: '2026-05-20',
      title: 'Orphan recurring instance',
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: true,
      designation: 'recurring',
    },
  ];

  const {error} = await supabaseAdmin.from('task_instances').insert(rows);
  if (error) throw new Error(`seedT3T4Fixture: ${error.message}`);
  return {adminId, simonId};
}

test.describe('Tasks v2 T3 — Header Tasks button + own due/past-due badge', () => {
  test('Header Tasks button is visible and badge shows the caller-scoped count', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedT3T4Fixture(supabaseAdmin);

    await page.goto('/');

    const headerLink = page.locator('[data-tasks-header-link="1"]').first();
    await expect(headerLink).toBeVisible();

    // Two admin-owned overdue rows count; the future admin row does not;
    // Simon's overdue row does not.
    const badge = headerLink.locator('[data-tasks-header-badge]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('2');
    await expect(badge).toHaveAttribute('data-tasks-header-badge', '2');
  });

  test('clicking the Header Tasks button navigates to /tasks', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedT3T4Fixture(supabaseAdmin);

    await page.goto('/');
    await page.locator('[data-tasks-header-link="1"]').first().click();

    await expect(page).toHaveURL(/\/tasks(?:[/?#]|$)/);
    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();
    await expect(page.locator('[data-tasks-tab="my-tasks"]')).toBeVisible();
  });

  test('Header badge hides entirely when the caller has no due-or-past-due tasks', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await seedAdminProfile(supabaseAdmin);
    const simonId = await profileIdByName(supabaseAdmin, 'Simon');
    // Caller has only a future task; Simon has overdue. Caller's badge
    // count should be zero, so the badge pill must NOT render.
    await supabaseAdmin.from('task_instances').insert([
      {
        id: 'tic-t34-mine-only-future',
        assignee_profile_id: adminId,
        due_date: '2099-12-31',
        title: 'Only future',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
      },
      {
        id: 'tic-t34-other-only-overdue',
        assignee_profile_id: simonId,
        due_date: '2025-01-01',
        title: 'Other overdue',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
      },
    ]);

    await page.goto('/');

    const headerLink = page.locator('[data-tasks-header-link="1"]').first();
    await expect(headerLink).toBeVisible();
    await expect(headerLink.locator('[data-tasks-header-badge]')).toHaveCount(0);
  });
});

test.describe('Tasks v2 T4 — Completed tab', () => {
  test('renders completed rows with note + completed-by + paperclip; excludes open rows', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedT3T4Fixture(supabaseAdmin);

    await page.goto('/tasks');
    await page.locator('[data-tasks-tab-button="completed"]').click();

    const tab = page.locator('[data-tasks-tab="completed"]');
    await expect(tab).toBeVisible();

    const completedRow = tab.locator('[data-task-row="tic-t34-completed-mine"]');
    await expect(completedRow).toBeVisible();
    await expect(completedRow).toHaveAttribute('data-task-status', 'completed');
    await expect(completedRow.locator('[data-completion-note="1"]')).toContainText('all done');
    await expect(completedRow.locator('[data-completed-by-name="Test Admin"]')).toBeVisible();
    await expect(completedRow.locator('[data-task-has-photo="1"]')).toBeVisible();

    // Open rows must NOT appear in Completed.
    await expect(tab.locator('[data-task-row="tic-t34-mine-overdue-1"]')).toHaveCount(0);
    await expect(tab.locator('[data-task-row="tic-t34-recurring-a"]')).toHaveCount(0);
  });
});

test.describe('Tasks v2 T4 — Recurring tab', () => {
  test('groups open recurring instances under their templates, surfaces orphans, no edit/delete UI', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedT3T4Fixture(supabaseAdmin);

    await page.goto('/tasks');
    await page.locator('[data-tasks-tab-button="recurring"]').click();

    const tab = page.locator('[data-tasks-tab="recurring"]');
    await expect(tab).toBeVisible();

    // Both seeded templates render as cards. The active template lives
    // under the Active templates sub-section; the inactive template
    // lives inside the Inactive templates collapsed group — expand the
    // group toggle once so its body is in the DOM before locating the
    // inactive card.
    const activeCard = tab.locator('[data-recurring-template="tpl-spec-active"]');
    await expect(activeCard).toBeVisible();
    await tab.locator('[data-recurring-inactive-toggle="1"]').click();
    const inactiveCard = tab.locator('[data-recurring-template="tpl-spec-inactive"]');
    await expect(inactiveCard).toBeVisible();

    // Active pill on the active template, Inactive pill on the inactive one.
    await expect(activeCard.locator('[data-template-state="active"]')).toBeVisible();
    await expect(inactiveCard.locator('[data-template-state="inactive"]')).toBeVisible();

    // Open count on the active template = 2 (instances A + B).
    await expect(activeCard.locator('[data-template-open-count]')).toHaveAttribute('data-template-open-count', '2');
    await expect(inactiveCard.locator('[data-template-open-count]')).toHaveAttribute('data-template-open-count', '0');

    // Conservative pre-expand rule (Codex 2026-05-13 remaining-tabs pass):
    // templates with ≥1 open instance auto-expand. The active template
    // here has 2 open instances, so its body is already in the DOM —
    // no manual click needed. The inactive template has 0 opens so it
    // stays collapsed inside the inactive group.
    await expect(activeCard.locator('[data-tasks-group-state="expanded"]')).toBeVisible();
    const activeBody = tab.locator('[data-recurring-template-body="tpl-spec-active"]');
    await expect(activeBody).toBeVisible();
    await expect(activeBody.locator('[data-task-row="tic-t34-recurring-a"]')).toBeVisible();
    await expect(activeBody.locator('[data-task-row="tic-t34-recurring-b"]')).toBeVisible();
    await expect(tab.locator('[data-recurring-template-body="tpl-spec-inactive"]')).toHaveCount(0);

    // Orphan group at the bottom contains the orphan instance.
    const orphans = tab.locator('[data-recurring-orphans="1"]');
    await expect(orphans).toBeVisible();
    await expect(orphans.locator('[data-task-row="tic-t34-recurring-orphan"]')).toBeVisible();

    // T9 added admin write controls (+ New Template, Edit, Delete). Lock
    // that they exist for the admin viewer of this spec — the non-admin
    // gating is covered by tasks_v2_t8_t9_admin_controls.spec.js.
    await expect(tab.locator('[data-recurring-new-button="1"]')).toBeVisible();
    // Modal panes themselves are not yet open; no orphan input/textarea
    // inside the tab body.
    await expect(tab.locator('input, textarea').filter({hasNotText: /./})).toHaveCount(0);
    // No Save button surfaces until a modal opens.
    await expect(tab.getByRole('button', {name: /^Save/i})).toHaveCount(0);
  });
});
