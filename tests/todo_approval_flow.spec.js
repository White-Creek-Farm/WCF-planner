import {test, expect} from './fixtures.js';

// ============================================================================
// To Do List — two-step completion: submit, approve, reject, auto-approve.
// ============================================================================
// Drives REAL role-gated RPC paths with genuine logins (no role override):
//
//   1  farm_team (standing 'Simon' account) submits a completion → the row
//      stays in place with the Awaiting-approval badge; Simon sees NO
//      Approve/Reject; the row is pending_approval server-side.
//   2  admin approves → item moves into the collapsed Completed section with
//      completion + approval attribution.
//   3  admin rejects a second pending item with a note → back to Open with
//      the rejected cue; completion fields cleared on the row; the Activity
//      event preserves the submitted note.
//   4  admin completing an open item directly auto-approves (single step).
//
// Run one spec file at a time against the shared TEST DB.
// ============================================================================

test.use({storageState: {cookies: [], origins: []}});

const ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

async function clearTodoData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('todo_items').delete().neq('id', '__never__');
  if (error) throw new Error('clear todo_items: ' + error.message);
}

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function seedSimonProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const simonUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === 'simon.tasks@wcfplanner.test',
  );
  if (!simonUser) throw new Error('Simon auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: simonUser.id, email: simonUser.email, full_name: 'Simon', role: 'farm_team'}, {onConflict: 'id'});
  return simonUser.id;
}

async function seedItems(supabaseAdmin, creatorId, items) {
  const {error} = await supabaseAdmin.from('todo_items').upsert(
    items.map((it, i) => ({
      id: it.id,
      title: it.title,
      section: it.section || 'general',
      status: 'open',
      sort_order: i,
      created_by: creatorId,
    })),
    {onConflict: 'id'},
  );
  if (error) throw new Error('seed todo_items: ' + error.message);
}

async function signIn(page, email, password) {
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
  await page.getByPlaceholder('your@email.com').first().fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

// Standing farm_team account seeded by scripts/apply_test_mig_052.cjs.
async function signInAsSimon(page) {
  await signIn(page, 'simon.tasks@wcfplanner.test', 'apply_test_mig_052_placeholder_password');
}

async function waitForTodoLoaded(page) {
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
}

test('farm_team completion goes pending; admin approves into the collapsed Completed section', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await seedSimonProfile(supabaseAdmin);
  await seedItems(supabaseAdmin, simonId, [{id: 'todo-e2e-appr', title: 'Sweep the feed room'}]);

  // farm_team submits the completion.
  await signInAsSimon(page);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  const row = page.locator('[data-todo-row="todo-e2e-appr"]');
  await expect(row).toBeVisible();
  // Non-managers get no reorder/remove/convert controls.
  await expect(page.locator('[data-todo-move-up="todo-e2e-appr"]')).toHaveCount(0);
  await expect(page.locator('[data-todo-remove="todo-e2e-appr"]')).toHaveCount(0);

  await page.locator('[data-todo-complete="todo-e2e-appr"]').click();
  await expect(page.locator('[data-todo-complete-modal="1"]')).toBeVisible();
  await page.locator('#todo-complete-note').fill('Swept and restacked the pallets.');
  await page.locator('[data-todo-complete-save="1"]').click();
  await expect(page.locator('[data-todo-complete-modal="1"]')).toHaveCount(0, {timeout: 10_000});

  // Row stays in place with the badge; Simon cannot approve.
  await expect(row.locator('[data-todo-pending-badge="1"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-todo-approve="todo-e2e-appr"]')).toHaveCount(0);

  const {data: pendingRow} = await supabaseAdmin
    .from('todo_items')
    .select('status, completion_note, completion_submitted_by')
    .eq('id', 'todo-e2e-appr')
    .single();
  expect(pendingRow.status).toBe('pending_approval');
  expect(pendingRow.completion_note).toBe('Swept and restacked the pallets.');
  expect(pendingRow.completion_submitted_by).toBe(simonId);

  const {data: managerNotifs, error: managerNotifErr} = await supabaseAdmin
    .from('notifications')
    .select('id, recipient_profile_id, actor_profile_id, type, activity_event_id, task_instance_id, title, body')
    .eq('recipient_profile_id', adminId)
    .eq('actor_profile_id', simonId)
    .eq('type', 'todo_completion_submitted');
  if (managerNotifErr) throw new Error('load manager todo notification: ' + managerNotifErr.message);
  expect(managerNotifs).toHaveLength(1);
  expect(managerNotifs[0].activity_event_id).toBeTruthy();
  expect(managerNotifs[0].task_instance_id).toBeNull();
  expect(managerNotifs[0].title).toContain('submitted a to do for approval');
  expect(managerNotifs[0].body).toContain('Swept and restacked');

  // Admin approves.
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  // Manager pending filter shows the count and the item.
  const pendingFilter = page.locator('[data-todo-pending-filter="1"]');
  await expect(pendingFilter).toContainText('Pending approval (1)');
  await pendingFilter.click();
  await expect(page.locator('[data-todo-row="todo-e2e-appr"]')).toBeVisible();

  await page.locator('[data-todo-approve="todo-e2e-appr"]').click();
  await expect(page.locator('[data-todo-row="todo-e2e-appr"]')).toHaveCount(0, {timeout: 10_000});

  // Lands in the collapsed Completed section with attribution.
  await pendingFilter.click(); // clear the pending filter
  const completedToggle = page.locator('[data-todo-completed-toggle="1"]');
  await expect(completedToggle).toContainText('Completed (1)');
  await completedToggle.click();
  const completedRow = page.locator('[data-todo-completed-row="todo-e2e-appr"]');
  await expect(completedRow).toBeVisible();
  await expect(completedRow).toContainText('Done by Simon');
  await expect(completedRow).toContainText('approved by Test Admin');

  const {data: doneRow} = await supabaseAdmin
    .from('todo_items')
    .select('status, approved_by')
    .eq('id', 'todo-e2e-appr')
    .single();
  expect(doneRow.status).toBe('completed');
  expect(doneRow.approved_by).toBeTruthy();

  const {data: creatorNotifs, error: creatorNotifErr} = await supabaseAdmin
    .from('notifications')
    .select('id, recipient_profile_id, actor_profile_id, type, activity_event_id, task_instance_id, title, body')
    .eq('recipient_profile_id', simonId)
    .eq('actor_profile_id', adminId)
    .eq('type', 'todo_completion_approved');
  if (creatorNotifErr) throw new Error('load creator todo notification: ' + creatorNotifErr.message);
  expect(creatorNotifs).toHaveLength(1);
  expect(creatorNotifs[0].activity_event_id).toBeTruthy();
  expect(creatorNotifs[0].task_instance_id).toBeNull();
  expect(creatorNotifs[0].title).toContain('Sweep the feed room');
});

test('admin rejects a pending completion with a note; item reopens and Activity keeps the history', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedItems(supabaseAdmin, adminId, [{id: 'todo-e2e-rej', title: 'Patch the chicken run fence'}]);

  await signInAsSimon(page);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);
  await page.locator('[data-todo-complete="todo-e2e-rej"]').click();
  await page.locator('#todo-complete-note').fill('Stapled new wire on the north side.');
  await page.locator('[data-todo-complete-save="1"]').click();
  await expect(page.locator('[data-todo-row="todo-e2e-rej"] [data-todo-pending-badge="1"]')).toBeVisible({
    timeout: 10_000,
  });

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-reject="todo-e2e-rej"]').click();
  await expect(page.locator('[data-todo-reject-modal="1"]')).toBeVisible();
  // The submitted completion context is visible to the manager.
  await expect(page.locator('[data-todo-reject-modal="1"]')).toContainText('Stapled new wire');
  await page.locator('#todo-reject-note').fill('South side still has a gap, please finish it.');
  await page.locator('[data-todo-reject-save="1"]').click();
  await expect(page.locator('[data-todo-reject-modal="1"]')).toHaveCount(0, {timeout: 10_000});

  // Back to open with the rejected cue.
  const row = page.locator('[data-todo-row="todo-e2e-rej"]');
  await expect(row.locator('[data-todo-pending-badge="1"]')).toHaveCount(0, {timeout: 10_000});
  await expect(row.locator('[data-todo-rejected-cue="1"]')).toContainText('South side still has a gap');

  const {data: reopened} = await supabaseAdmin
    .from('todo_items')
    .select('status, completion_note, completion_submitted_by, rejection_note')
    .eq('id', 'todo-e2e-rej')
    .single();
  expect(reopened.status).toBe('open');
  expect(reopened.completion_note).toBeNull();
  expect(reopened.completion_submitted_by).toBeNull();
  expect(reopened.rejection_note).toBe('South side still has a gap, please finish it.');

  // The Activity event preserves the rejected submission's note.
  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('event_type, payload')
    .eq('entity_type', 'todo.item')
    .eq('entity_id', 'todo-e2e-rej')
    .eq('event_type', 'todo.completion_rejected');
  expect(events).toHaveLength(1);
  expect(events[0].payload.completion_note).toBe('Stapled new wire on the north side.');
  expect(events[0].payload.rejection_note).toContain('South side still has a gap');
});

test('admin completion auto-approves in a single step', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedItems(supabaseAdmin, adminId, [{id: 'todo-e2e-auto', title: 'Grease the auger bearings'}]);

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-complete="todo-e2e-auto"]').click();
  const modal = page.locator('[data-todo-complete-modal="1"]');
  await expect(modal).toContainText('completes the item immediately');
  await page.locator('[data-todo-complete-save="1"]').click();
  await expect(modal).toHaveCount(0, {timeout: 10_000});

  await expect(page.locator('[data-todo-row="todo-e2e-auto"]')).toHaveCount(0, {timeout: 10_000});
  const {data: row} = await supabaseAdmin
    .from('todo_items')
    .select('status, completion_submitted_by, approved_by')
    .eq('id', 'todo-e2e-auto')
    .single();
  expect(row.status).toBe('completed');
  expect(row.completion_submitted_by).toBe(row.approved_by);
});
