import {test, expect} from './fixtures.js';

// ============================================================================
// To Do List — meaty toggle, create, sections, filters, persistence (/tasks).
// ============================================================================
// The shared To Do List rides inside the Task Center behind the mig 115 RPC
// family. This spec covers the fundamentals under the default admin
// storageState:
//
//   1  Meaty toggle: /tasks renders Task Center by default; the To Do List
//      side renders the list; the mode persists in localStorage across a
//      reload; /tasks/todo deep-links straight into the list.
//   2  + New To Do: modal create lands a todo_items row (RPC path), renders
//      in the right section with creator + "Listed today", and the Completed
//      section stays collapsed.
//   3  Section chips: All shows the three stacked sections; a single-section
//      chip filters; the chip choice persists in localStorage.
//   4  How to Use opens as a modal and closes.
//
// todo_items is NOT in the reset truncate whitelist, so each test clears it
// explicitly (todo_item_photos cascades off the FK).
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

async function waitForTodoLoaded(page) {
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
}

test('meaty toggle: default Task Center, To Do side renders, mode + deep link persist', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/tasks');
  await expect(page.locator('[data-tasks-mode-toggle="1"]')).toBeVisible({timeout: 15_000});
  // Default side is Task Center (tab bar visible, list not mounted).
  await expect(page.locator('[data-tasks-tab-bar="1"]')).toBeVisible();
  await expect(page.locator('[data-tasks-mode-center="1"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-tasks-mode-todo="1"]').click();
  await expect(page).toHaveURL(/\/tasks\/todo$/, {timeout: 10_000});
  await waitForTodoLoaded(page);
  await expect(page.locator('[data-todo-section="general"]')).toBeVisible();

  // Mode persists across reload (localStorage), landing back on the list.
  await page.goto('/tasks');
  await waitForTodoLoaded(page);
  await expect(page.locator('[data-tasks-mode-todo="1"]')).toHaveAttribute('aria-pressed', 'true');

  // Toggle back to Task Center.
  await page.locator('[data-tasks-mode-center="1"]').click();
  await expect(page.locator('[data-tasks-tab-bar="1"]')).toBeVisible({timeout: 10_000});

  // Deep link forces the To Do side regardless of the stored preference.
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);
});

test('+ New To Do: modal create lands an RPC-backed row in the chosen section', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-new-button="1"]').click();
  await expect(page.locator('[data-todo-new-modal="1"]')).toBeVisible();
  await page.locator('#todo-new-title').fill('Re-hang the gate by the pig barn');
  await page.locator('#todo-new-desc').fill('Hinge bolts are in the shop drawer.');
  await page.locator('#todo-new-section').selectOption('chicken_pigs');
  await page.locator('[data-todo-new-save="1"]').click();
  await expect(page.locator('[data-todo-new-modal="1"]')).toHaveCount(0, {timeout: 10_000});

  const row = page.locator('[data-todo-row]').filter({hasText: 'Re-hang the gate by the pig barn'});
  await expect(row).toBeVisible({timeout: 10_000});
  await expect(row).toContainText('Test Admin');
  await expect(row).toContainText('Listed today');
  // It rendered inside the Chicken & Pigs section.
  await expect(
    page.locator('[data-todo-section="chicken_pigs"] [data-todo-row]').filter({hasText: 'Re-hang the gate'}),
  ).toBeVisible();

  // RPC-backed row exists with server-stamped creator + open status.
  const {data: rows, error} = await supabaseAdmin
    .from('todo_items')
    .select('id, title, section, status, created_by, sort_order');
  expect(error).toBeNull();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    title: 'Re-hang the gate by the pig barn',
    section: 'chicken_pigs',
    status: 'open',
  });
  expect(rows[0].created_by).toBeTruthy();
  expect(rows[0].id.startsWith('todo-')).toBe(true);

  // Completed section is present and collapsed by default.
  const completedToggle = page.locator('[data-todo-completed-toggle="1"]');
  await expect(completedToggle).toBeVisible();
  await expect(completedToggle).toHaveAttribute('aria-expanded', 'false');
});

test('section chips: All stacks the three sections; single-section filters and persists', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);

  await supabaseAdmin.from('todo_items').upsert(
    [
      {
        id: 'todo-e2e-gen',
        title: 'General chore item',
        section: 'general',
        status: 'open',
        sort_order: 0,
        created_by: adminId,
      },
      {
        id: 'todo-e2e-cp',
        title: 'Chicken house latch',
        section: 'chicken_pigs',
        status: 'open',
        sort_order: 0,
        created_by: adminId,
      },
      {
        id: 'todo-e2e-cs',
        title: 'Cattle mineral feeder',
        section: 'cattle_sheep',
        status: 'open',
        sort_order: 0,
        created_by: adminId,
      },
    ],
    {onConflict: 'id'},
  );

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  // All view: three stacked sections, each with its item.
  for (const key of ['general', 'chicken_pigs', 'cattle_sheep']) {
    await expect(page.locator(`[data-todo-section="${key}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-todo-row]')).toHaveCount(3);

  // Single-section chip filters down to one section.
  await page.locator('[data-todo-section-chip="cattle_sheep"]').click();
  await expect(page.locator('[data-todo-section="cattle_sheep"]')).toBeVisible();
  await expect(page.locator('[data-todo-section="general"]')).toHaveCount(0);
  await expect(page.locator('[data-todo-row]')).toHaveCount(1);

  // The chip choice persists across a reload (localStorage).
  await page.reload();
  await waitForTodoLoaded(page);
  await expect(page.locator('[data-todo-section-chip="cattle_sheep"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-todo-row]')).toHaveCount(1);
});

test('How to Use opens as a modal and closes', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-howto="1"]').click();
  const modal = page.locator('[data-todo-howto-modal="1"]');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Task or To Do?');
  // Admin sees the management callout.
  await expect(modal).toContainText('Managers');
  await page.locator('[data-todo-howto-close="1"]').click();
  await expect(modal).toHaveCount(0);
});
