import {test, expect} from './fixtures.js';

// ============================================================================
// To Do List — manager priority ordering: arrows, cross-section move.
// ============================================================================
// Under the default admin storageState:
//
//   1  ▲/▼ explicit move controls (the touch/mobile path) persist a new
//      section order through reorder_todo_items; survives reload.
//   2  The move-to-section select relocates an item through move_todo_item
//      (lands at the bottom of the target section) and is audited.
//
// HTML5 drag-and-drop shares the same persistSectionOrder →
// reorder_todo_items path as the arrows; simulated dragstart/drop events are
// notoriously flaky under Playwright, so the arrows cover the contract here
// and the drag handles are asserted present for managers.
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

async function generalOrder(supabaseAdmin) {
  const {data} = await supabaseAdmin
    .from('todo_items')
    .select('id, sort_order')
    .eq('section', 'general')
    .in('status', ['open', 'pending_approval'])
    .order('sort_order', {ascending: true});
  return (data || []).map((r) => r.id);
}

test('▲/▼ controls persist the section order through reorder_todo_items', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  await supabaseAdmin.from('todo_items').upsert(
    [
      {
        id: 'todo-ord-a',
        title: 'Order item Alpha',
        section: 'general',
        status: 'open',
        sort_order: 0,
        created_by: adminId,
      },
      {
        id: 'todo-ord-b',
        title: 'Order item Bravo',
        section: 'general',
        status: 'open',
        sort_order: 1,
        created_by: adminId,
      },
      {
        id: 'todo-ord-c',
        title: 'Order item Charlie',
        section: 'general',
        status: 'open',
        sort_order: 2,
        created_by: adminId,
      },
    ],
    {onConflict: 'id'},
  );

  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  // Manager affordances are present: drag handle + arrows + section select.
  const rowB = page.locator('[data-todo-row="todo-ord-b"]');
  await expect(rowB).toHaveAttribute('draggable', 'true');
  await expect(page.locator('[data-todo-move-section="todo-ord-b"]')).toBeVisible();

  // Edge buttons disable correctly.
  await expect(page.locator('[data-todo-move-up="todo-ord-a"]')).toBeDisabled();
  await expect(page.locator('[data-todo-move-down="todo-ord-c"]')).toBeDisabled();

  // Move Charlie up one slot: a, c, b.
  await page.locator('[data-todo-move-up="todo-ord-c"]').click();
  await expect
    .poll(async () => generalOrder(supabaseAdmin), {timeout: 10_000})
    .toEqual(['todo-ord-a', 'todo-ord-c', 'todo-ord-b']);

  // Move Alpha down one slot: c, a, b.
  await page.locator('[data-todo-move-down="todo-ord-a"]').click();
  await expect
    .poll(async () => generalOrder(supabaseAdmin), {timeout: 10_000})
    .toEqual(['todo-ord-c', 'todo-ord-a', 'todo-ord-b']);

  // The persisted order survives a reload.
  await page.reload();
  await waitForTodoLoaded(page);
  const titles = await page.locator('[data-todo-section="general"] [data-todo-row]').allTextContents();
  expect(titles[0]).toContain('Charlie');
  expect(titles[1]).toContain('Alpha');
  expect(titles[2]).toContain('Bravo');
});

test('move-to-section select relocates the item to the bottom of the target section', async ({
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
        id: 'todo-mv-a',
        title: 'Stays in general',
        section: 'general',
        status: 'open',
        sort_order: 0,
        created_by: adminId,
      },
      {
        id: 'todo-mv-b',
        title: 'Moves to cattle',
        section: 'general',
        status: 'open',
        sort_order: 1,
        created_by: adminId,
      },
      {
        id: 'todo-mv-c',
        title: 'Existing cattle item',
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

  await page.locator('[data-todo-move-section="todo-mv-b"]').selectOption('cattle_sheep');

  // Renders under Cattle & Sheep, below the existing item (bottom insert).
  await expect(page.locator('[data-todo-section="cattle_sheep"] [data-todo-row="todo-mv-b"]')).toBeVisible({
    timeout: 10_000,
  });
  const cattleTitles = await page.locator('[data-todo-section="cattle_sheep"] [data-todo-row]').allTextContents();
  expect(cattleTitles[0]).toContain('Existing cattle item');
  expect(cattleTitles[1]).toContain('Moves to cattle');

  const {data: moved} = await supabaseAdmin
    .from('todo_items')
    .select('section, sort_order')
    .eq('id', 'todo-mv-b')
    .single();
  expect(moved.section).toBe('cattle_sheep');
  expect(moved.sort_order).toBe(1);

  // Section moves are audited on the entity.
  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('event_type, payload')
    .eq('entity_type', 'todo.item')
    .eq('entity_id', 'todo-mv-b');
  const move = (events || []).find((e) => e.payload && e.payload.to_section === 'cattle_sheep');
  expect(move).toBeTruthy();
  expect(move.payload.from_section).toBe('general');
});

test('move into a SPARSE section still lands at the bottom (vacated sort_order slots)', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  // Sparse general section: sort_orders 0, 3, 4 — the normal state after
  // mid-list items complete/convert/remove without compaction.
  await supabaseAdmin.from('todo_items').upsert(
    [
      {id: 'todo-sp-a', title: 'Sparse Alpha', section: 'general', status: 'open', sort_order: 0, created_by: adminId},
      {id: 'todo-sp-b', title: 'Sparse Bravo', section: 'general', status: 'open', sort_order: 3, created_by: adminId},
      {
        id: 'todo-sp-c',
        title: 'Sparse Charlie',
        section: 'general',
        status: 'open',
        sort_order: 4,
        created_by: adminId,
      },
      {
        id: 'todo-sp-x',
        title: 'Incoming from cattle',
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

  // NULL-position move (the UI section select) must land at the BOTTOM.
  await page.locator('[data-todo-move-section="todo-sp-x"]').selectOption('general');
  await expect
    .poll(async () => generalOrder(supabaseAdmin), {timeout: 10_000})
    .toEqual(['todo-sp-a', 'todo-sp-b', 'todo-sp-c', 'todo-sp-x']);

  // The section is renumbered contiguously 0..n-1 after the move.
  const {data: rows} = await supabaseAdmin
    .from('todo_items')
    .select('id, sort_order')
    .eq('section', 'general')
    .order('sort_order', {ascending: true});
  expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2, 3]);

  // Web-first retrying assertion: the UI refetch after the move RPC is
  // asynchronous, so a one-shot allTextContents() read can race it even
  // though the DB polls above already passed (the CI failure snapshot shows
  // the row present milliseconds later). Same expectation, retry-safe form.
  await expect(page.locator('[data-todo-section="general"] [data-todo-row]').nth(3)).toContainText(
    'Incoming from cattle',
  );
});
