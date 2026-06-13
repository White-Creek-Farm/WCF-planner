import {test, expect} from './fixtures.js';

// ============================================================================
// To Do List — convert into an assigned Task (management/admin).
// ============================================================================
// Under the default admin storageState:
//
//   1  Cancel path: the prefilled convert modal closes without touching the
//      item — still open, still listed.
//   2  Submit path: convert_todo_item creates the task_instances row AND
//      flips the item to status='converted' in one transaction; the item
//      vanishes from the To Do UI (open list and Completed both); the
//      creator (Simon) receives a todo_converted notification carrying
//      task_instance_id; the record page now 404s to the friendly
//      no-longer-listed message.
//   3  A pending item shows no Convert affordance (approve/reject first).
// ============================================================================

async function clearTodoData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('todo_items').delete().neq('id', '__never__');
  if (error) throw new Error('clear todo_items: ' + error.message);
}

async function seedAdminProfile(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (process.env.VITE_TEST_ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found in TEST DB');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  return adminUser.id;
}

async function simonProfileId(supabaseAdmin) {
  const {data} = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', 'simon.tasks@wcfplanner.test')
    .maybeSingle();
  if (!data) throw new Error('standing Simon profile not found (scripts/apply_test_mig_052.cjs)');
  return data.id;
}

async function waitForTodoLoaded(page) {
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
}

test('cancel leaves the To Do open and unchanged', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  const simonId = await simonProfileId(supabaseAdmin);
  await supabaseAdmin.from('todo_items').upsert(
    {
      id: 'todo-cv-cancel',
      title: 'Replace the loader bucket pin',
      section: 'general',
      status: 'open',
      sort_order: 0,
      created_by: simonId,
    },
    {onConflict: 'id'},
  );

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-convert="todo-cv-cancel"]').click();
  const modal = page.locator('[data-todo-convert-modal="1"]');
  await expect(modal).toBeVisible();
  // Prefilled from the item.
  await expect(page.locator('#todo-convert-title')).toHaveValue('Replace the loader bucket pin');
  await page.getByRole('button', {name: /^cancel$/i}).click();
  await expect(modal).toHaveCount(0);

  // Item untouched: still open, still listed.
  await expect(page.locator('[data-todo-row="todo-cv-cancel"]')).toBeVisible();
  const {data: row} = await supabaseAdmin
    .from('todo_items')
    .select('status, converted_task_id')
    .eq('id', 'todo-cv-cancel')
    .single();
  expect(row.status).toBe('open');
  expect(row.converted_task_id).toBeNull();
});

test('submit creates the Task, hides the item from the To Do UI, and notifies the creator', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  const simonId = await simonProfileId(supabaseAdmin);
  await supabaseAdmin.from('todo_items').upsert(
    {
      id: 'todo-cv-go',
      title: 'Re-wire the brooder thermostat',
      description: 'Old wiring is brittle.',
      section: 'chicken_pigs',
      status: 'open',
      sort_order: 0,
      created_by: simonId,
    },
    {onConflict: 'id'},
  );

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-convert="todo-cv-go"]').click();
  const modal = page.locator('[data-todo-convert-modal="1"]');
  await expect(modal).toBeVisible();
  await expect(page.locator('#todo-convert-title')).toHaveValue('Re-wire the brooder thermostat');
  await expect(page.locator('#todo-convert-desc')).toHaveValue('Old wiring is brittle.');
  await page.locator('#todo-convert-assignee').selectOption({label: 'Simon'});
  await page.locator('[data-todo-convert-save="1"]').click();
  await expect(modal).toHaveCount(0, {timeout: 15_000});

  // Item left the To Do UI entirely.
  await expect(page.locator('[data-todo-row="todo-cv-go"]')).toHaveCount(0, {timeout: 10_000});
  await page.locator('[data-todo-completed-toggle="1"]').click();
  await expect(page.locator('[data-todo-completed-row="todo-cv-go"]')).toHaveCount(0);

  // One transaction: converted status + linked task row.
  const {data: item} = await supabaseAdmin
    .from('todo_items')
    .select('status, converted_task_id, converted_by')
    .eq('id', 'todo-cv-go')
    .single();
  expect(item.status).toBe('converted');
  expect(item.converted_task_id).toBeTruthy();

  const {data: task} = await supabaseAdmin
    .from('task_instances')
    .select('id, title, status, assignee_profile_id, created_by_profile_id')
    .eq('id', item.converted_task_id)
    .single();
  expect(task.title).toBe('Re-wire the brooder thermostat');
  expect(task.status).toBe('open');
  expect(task.assignee_profile_id).toBe(simonId);

  // Creator notification with the task link.
  const {data: notifs} = await supabaseAdmin
    .from('notifications')
    .select('type, recipient_profile_id, task_instance_id, activity_event_id')
    .eq('type', 'todo_converted')
    .eq('recipient_profile_id', simonId);
  expect(notifs).toHaveLength(1);
  expect(notifs[0].task_instance_id).toBe(item.converted_task_id);
  expect(notifs[0].activity_event_id).toBeTruthy();

  // Record page shows the friendly no-longer-listed message.
  await page.goto('/tasks/todo/todo-cv-go');
  await expect(page.getByText('no longer on the list')).toBeVisible({timeout: 15_000});
});

test('a pending item offers no Convert affordance', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  const simonId = await simonProfileId(supabaseAdmin);
  await supabaseAdmin.from('todo_items').upsert(
    {
      id: 'todo-cv-pend',
      title: 'Pending conversion guard',
      section: 'general',
      status: 'pending_approval',
      sort_order: 0,
      created_by: adminId,
      completion_submitted_by: simonId,
      completion_submitted_at: new Date().toISOString(),
      completion_note: 'Did it already.',
    },
    {onConflict: 'id'},
  );

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  const row = page.locator('[data-todo-row="todo-cv-pend"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-todo-pending-badge="1"]')).toBeVisible();
  await expect(page.locator('[data-todo-convert="todo-cv-pend"]')).toHaveCount(0);
  // Approve/Reject are the offered paths instead.
  await expect(page.locator('[data-todo-approve="todo-cv-pend"]')).toBeVisible();
  await expect(page.locator('[data-todo-reject="todo-cv-pend"]')).toBeVisible();
});
