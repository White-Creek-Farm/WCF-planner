import {test, expect} from './fixtures.js';

// ============================================================================
// Tasks v2 T2 — Task Center /tasks page smoke (read-only My Tasks tab).
//
// The signed-in storageState is the test admin. Each test seeds the four
// shapes Codex pinned in the T2 brief so we can assert each in one pass:
//
//   - admin's own task (overdue) — must land in the highlighted "My open
//     tasks" section
//   - admin's own task (upcoming) — same section
//   - public-webform task assigned to admin — must show "Submitted by"
//     (NOT "Created by")
//   - other-user task (Simon) with designation='recurring' — must group
//     under Simon and start collapsed; expanding it must show the
//     Recurring badge
//   - other-user task (Mak) generated from a system rule — must group
//     under Mak and start collapsed; expanding it must show the System
//     badge
//
// We deliberately do NOT exercise any mutation path here — T2 ships
// zero mutations and the static lock test enforces that for the
// component sources.
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

async function ensureSystemRule(supabaseAdmin, ruleId, assigneeProfileId, generatorKind) {
  await supabaseAdmin.from('task_system_rules').upsert(
    {
      id: ruleId,
      name: ruleId,
      description: 'seeded for tasks_v2_center spec',
      assignee_profile_id: assigneeProfileId,
      generator_kind: generatorKind,
      lead_time_days: 3,
      active: true,
    },
    {onConflict: 'id'},
  );
}

async function seedTaskCenterFixture(supabaseAdmin) {
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await profileIdByName(supabaseAdmin, 'Simon');
  const makId = await profileIdByName(supabaseAdmin, 'Mak');
  await ensureSystemRule(supabaseAdmin, 'broiler-4wk-weighin', simonId, 'broiler_4wk_weighin');

  // PostgREST harmonizes column sets across batched inserts, so every
  // row needs an explicit `from_recurring_template` (NOT NULL DEFAULT
  // false in mig 050) — otherwise rows that omit it get NULL instead
  // of the default and the insert rejects.
  const rows = [
    // admin's overdue task — must be first row in "My open tasks"
    {
      id: 'tic-mine-overdue',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2026-04-01',
      title: 'My overdue task',
      description: 'overdue admin task for the highlighted section',
      submission_source: 'admin_manual',
      status: 'open',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // admin's upcoming task — same section, sorted after the overdue one
    {
      id: 'tic-mine-upcoming',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2026-08-15',
      title: 'My upcoming task',
      description: 'upcoming admin task',
      submission_source: 'admin_manual',
      status: 'open',
      created_by_profile_id: adminId,
      created_by_display_name: 'Test Admin',
      from_recurring_template: false,
    },
    // public-webform task assigned to admin — surfaces "Submitted by"
    {
      id: 'tic-mine-pw',
      template_id: null,
      assignee_profile_id: adminId,
      due_date: '2026-06-01',
      title: 'Public webform request',
      description: 'task created by anon submit_task_instance flow',
      submitted_by_team_member: 'Public Operator',
      submission_source: 'public_webform',
      status: 'open',
      from_recurring_template: false,
    },
    // Simon — recurring designation (set explicitly; the BEFORE trigger
    // would also set it from a non-null template_id, but skipping the
    // template_id avoids needing a task_templates row)
    {
      id: 'tic-other-simon-recurring',
      template_id: null,
      assignee_profile_id: simonId,
      due_date: '2026-05-15',
      title: 'Simon recurring task',
      description: "Simon's recurring task",
      submission_source: 'admin_manual',
      status: 'open',
      from_recurring_template: true,
      designation: 'recurring',
    },
    // Mak — system rule. The BEFORE trigger sets designation='system'
    // when from_system_rule_id is non-null and designation is left NULL.
    {
      id: 'tic-other-mak-system',
      template_id: null,
      assignee_profile_id: makId,
      due_date: '2026-05-22',
      title: 'Mak system task',
      description: "Mak's system-generated task",
      submission_source: 'admin_manual',
      status: 'open',
      from_system_rule_id: 'broiler-4wk-weighin',
      from_system_source_event_key: 'broiler-B-26-09',
      from_recurring_template: false,
    },
  ];

  const {error} = await supabaseAdmin.from('task_instances').upsert(rows, {onConflict: 'id'});
  if (error) throw new Error(`seedTaskCenterFixture: ${error.message}`);
  return {adminId, simonId, makId};
}

test.describe('Task Center /tasks — read-only My Tasks tab', () => {
  test('renders the Task Center shell, tabs, and admin-only System Tasks tab', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedTaskCenterFixture(supabaseAdmin);

    await page.goto('/tasks');

    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();

    // All four tab buttons present (System Tasks visible because the
    // test storageState is the admin user).
    await expect(page.locator('[data-tasks-tab-button="mine"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="recurring"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="completed"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="system"]')).toBeVisible();

    // My Tasks tab is the default — its body marker is in the DOM.
    await expect(page.locator('[data-tasks-tab="my-tasks"]')).toBeVisible();
  });

  test('highlights own open tasks at top, including the public-webform Submitted by attribution', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedTaskCenterFixture(supabaseAdmin);

    await page.goto('/tasks');

    const mine = page.locator('[data-tasks-section="mine"]');
    await expect(mine).toBeVisible();

    // Admin owns three open tasks — overdue + upcoming + public-webform.
    await expect(mine.locator('[data-task-row="tic-mine-overdue"]')).toBeVisible();
    await expect(mine.locator('[data-task-row="tic-mine-upcoming"]')).toBeVisible();
    await expect(mine.locator('[data-task-row="tic-mine-pw"]')).toBeVisible();

    // Sort: oldest due first puts overdue at the top of the section.
    const ids = await mine.locator('[data-task-row]').evaluateAll((els) => els.map((e) => e.dataset.taskRow));
    expect(ids[0]).toBe('tic-mine-overdue');

    // Overdue badge fires for the overdue row only (today is 2026-05-08;
    // the overdue row's due_date is 2026-04-01).
    await expect(mine.locator('[data-task-row="tic-mine-overdue"] [data-due-state="overdue"]')).toBeVisible();
    await expect(mine.locator('[data-task-row="tic-mine-upcoming"] [data-due-state="overdue"]')).toHaveCount(0);

    // Public-webform attribution must say "Submitted by", not "Created by".
    const pw = mine.locator('[data-task-row="tic-mine-pw"]');
    await expect(pw.locator('[data-task-attribution-label="Submitted by"]')).toBeVisible();
    await expect(pw.locator('[data-task-attribution-label="Created by"]')).toHaveCount(0);
    await expect(pw).toContainText('Public Operator');
  });

  test('groups other users by name, collapses by default, surfaces designation badges on expand', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const {simonId, makId} = await seedTaskCenterFixture(supabaseAdmin);

    await page.goto('/tasks');

    const others = page.locator('[data-tasks-section="others"]');
    await expect(others).toBeVisible();

    const simonGroup = others.locator(`[data-tasks-group="${simonId}"]`);
    const makGroup = others.locator(`[data-tasks-group="${makId}"]`);
    await expect(simonGroup).toBeVisible();
    await expect(makGroup).toBeVisible();

    // Both groups start collapsed.
    await expect(simonGroup.locator('[data-tasks-group-state="collapsed"]')).toBeVisible();
    await expect(makGroup.locator('[data-tasks-group-state="collapsed"]')).toBeVisible();
    // Their bodies are not in the DOM until expanded.
    await expect(others.locator(`[data-tasks-group-body="${simonId}"]`)).toHaveCount(0);
    await expect(others.locator(`[data-tasks-group-body="${makId}"]`)).toHaveCount(0);

    // Expand Simon → shows the recurring task with the Recurring badge.
    await simonGroup.locator('button').first().click();
    await expect(simonGroup.locator('[data-tasks-group-state="expanded"]')).toBeVisible();
    const simonRow = others.locator('[data-task-row="tic-other-simon-recurring"]');
    await expect(simonRow).toBeVisible();
    await expect(simonRow.locator('[data-task-badge="recurring"]')).toBeVisible();
    await expect(simonRow.locator('[data-task-badge="system"]')).toHaveCount(0);

    // Expand Mak → shows the system task with the System badge.
    await makGroup.locator('button').first().click();
    await expect(makGroup.locator('[data-tasks-group-state="expanded"]')).toBeVisible();
    const makRow = others.locator('[data-task-row="tic-other-mak-system"]');
    await expect(makRow).toBeVisible();
    await expect(makRow.locator('[data-task-badge="system"]')).toBeVisible();
    await expect(makRow.locator('[data-task-badge="recurring"]')).toHaveCount(0);
  });

  test('non-admin (farm_team) signed-in user does NOT see the System Tasks tab', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedTaskCenterFixture(supabaseAdmin);

    // Drop the admin storageState by clearing browser session, then
    // sign in as the Simon test profile (role='farm_team' per
    // apply_test_mig_052.cjs). The Task Center mount itself stays
    // requireAdmin:false; only the System Tasks tab gates on admin.
    await page.context().clearCookies();
    await page.goto('/');
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_e) {
        /* test-only cleanup; ignore browser quirks */
      }
    });
    await page.goto('/');
    await page.getByPlaceholder('your@email.com').first().fill('simon.tasks@wcfplanner.test');
    await page.getByPlaceholder('••••••••').fill('apply_test_mig_052_placeholder_password');
    await page.getByRole('button', {name: /^sign in$/i}).click();
    await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});

    await page.goto('/tasks');

    await expect(page.getByRole('heading', {name: /^Task Center$/})).toBeVisible();
    // Three non-admin tabs visible.
    await expect(page.locator('[data-tasks-tab-button="mine"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="recurring"]')).toBeVisible();
    await expect(page.locator('[data-tasks-tab-button="completed"]')).toBeVisible();
    // System Tasks tab gated to admin — must NOT render for farm_team.
    await expect(page.locator('[data-tasks-tab-button="system"]')).toHaveCount(0);

    // Simon's own task lands in the highlighted "My open tasks" section.
    const mine = page.locator('[data-tasks-section="mine"]');
    await expect(mine).toBeVisible();
    await expect(mine.locator('[data-task-row="tic-other-simon-recurring"]')).toBeVisible();
  });

  test('other-user groups sort their tasks oldest-due first', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const {simonId} = await seedTaskCenterFixture(supabaseAdmin);

    // Add a second Simon task with an earlier due date so we can
    // verify the within-group sort order. After this insert Simon
    // carries 2 open tasks (recurring + earlier), which qualifies
    // his group for the top-2 pre-expand introduced in the Operator
    // Clarity pass — solo-task groups stay collapsed, ≥2-task groups
    // expand by default so cross-team workload is visible without
    // an extra click.
    await supabaseAdmin.from('task_instances').upsert(
      {
        id: 'tic-other-simon-earlier',
        template_id: null,
        assignee_profile_id: simonId,
        due_date: '2026-04-15',
        title: 'Simon earlier task',
        description: 'second simon task seeded for sort assertion',
        submission_source: 'admin_manual',
        status: 'open',
        from_recurring_template: false,
      },
      {onConflict: 'id'},
    );

    await page.goto('/tasks');

    // Simon has 2 open tasks so his group auto-expands. No click
    // needed; assert the body is in the DOM directly.
    const simonGroup = page.locator(`[data-tasks-group="${simonId}"]`);
    await expect(simonGroup.locator('[data-tasks-group-state="expanded"]')).toBeVisible();
    const body = page.locator(`[data-tasks-group-body="${simonId}"]`);
    await expect(body).toBeVisible();
    const ids = await body.locator('[data-task-row]').evaluateAll((els) => els.map((e) => e.dataset.taskRow));
    expect(ids).toEqual(['tic-other-simon-earlier', 'tic-other-simon-recurring']);
  });
});
