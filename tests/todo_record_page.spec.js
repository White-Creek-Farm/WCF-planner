import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// To Do item record page — /tasks/todo/<id>.
// ============================================================================
//   1  Whole-row open lands on the record page (loaded marker, details,
//      actions); creator edit saves through update_todo_item.
//   2  Comments mount on the todo.item entity through the GENERIC comment
//      RPCs (the _activity_can_write delegation), and an @mention lands a
//      comment_mention notification whose resolved route deep-links back to
//      /tasks/todo/<id>#comment-<id>; visiting that URL shows the comment.
//   3  Light (real auth user) can open the record page and comment.
//   4  equipment_tech (real auth user) bounces off /tasks/todo/<id> back to
//      /tasks and never sees the meaty toggle.
// ============================================================================

test.use({storageState: {cookies: [], origins: []}});

const ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

const LIGHT_EMAIL = 'test-light-todo@wcfplanner.test';
const LIGHT_PASSWORD = 'LightTodo123!';
const TECH_EMAIL = 'test-tech-todo@wcfplanner.test';
const TECH_PASSWORD = 'TechTodo123!';

async function clearTodoData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('todo_items').delete().neq('id', '__never__');
  if (error) throw new Error('clear todo_items: ' + error.message);
  const {error: cErr} = await supabaseAdmin.from('comments').delete().eq('entity_type', 'todo.item');
  if (cErr) throw new Error('clear todo comments: ' + cErr.message);
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

async function ensureRoleUser(supabaseAdmin, {email, password, fullName, role}) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === email);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({email, password, email_confirm: true});
    if (created.error) throw new Error(`create ${role} user: ${created.error.message}`);
    user = created.data?.user;
  } else {
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password});
  }
  await supabaseAdmin.from('profiles').upsert({id: user.id, email, full_name: fullName, role}, {onConflict: 'id'});
  return user;
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

// Authed (non-service-role) admin client so node-side comments run the REAL
// post_comment path (entity gate via _activity_can_write -> todo.item branch,
// mention validation, comment_mention notification fan-out).
async function newAdminAuthedClient() {
  const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
  const {error} = await sb.auth.signInWithPassword({email: ADMIN_EMAIL, password: ADMIN_PASSWORD});
  if (error) throw new Error(`admin signInWithPassword failed: ${error.message}`);
  return sb;
}

async function seedItem(supabaseAdmin, creatorId, {id, title, description}) {
  const {error} = await supabaseAdmin.from('todo_items').upsert(
    {
      id,
      title,
      description: description || null,
      section: 'general',
      status: 'open',
      sort_order: 0,
      created_by: creatorId,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seed todo item: ' + error.message);
}

test('row opens the record page; creator edit saves; comments + @mention deeplink round-trip', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  // A second mentionable participant.
  const light = await ensureRoleUser(supabaseAdmin, {
    email: LIGHT_EMAIL,
    password: LIGHT_PASSWORD,
    fullName: 'Light Field User',
    role: 'light',
  });
  await seedItem(supabaseAdmin, adminId, {
    id: 'todo-rec-1',
    title: 'Check the rain gutters',
    description: 'Both barns, after the next storm.',
  });

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/tasks/todo');
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});

  // Whole-row open.
  await page.locator('[data-todo-row="todo-rec-1"]').click();
  await expect(page).toHaveURL(/\/tasks\/todo\/todo-rec-1/, {timeout: 10_000});
  await expect(page.locator('[data-todo-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Both barns, after the next storm.')).toBeVisible();

  // Creator edit through update_todo_item.
  await page.locator('[data-todo-edit="todo-rec-1"]').click();
  await page.locator('#todo-edit-title').fill('Check the rain gutters and downspouts');
  await page.locator('[data-todo-edit-save="1"]').click();
  await expect(page.locator('[data-todo-edit-panel="1"]')).toHaveCount(0, {timeout: 10_000});
  await expect(page.locator('[data-record-title="1"]')).toContainText('downspouts', {timeout: 10_000});

  // Plain comment through the UI composer (generic comments on todo.item).
  const composer = page.locator('[data-mention-textarea="1"]').last();
  await composer.fill('Ladder is behind the shop door.');
  await page.locator('[data-comments-post-button="1"]').click();
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin
          .from('comments')
          .select('id')
          .eq('entity_type', 'todo.item')
          .eq('entity_id', 'todo-rec-1');
        return data && data.length;
      },
      {timeout: 10_000},
    )
    .toBe(1);

  // @mention via the REAL authed post_comment RPC (mention validation +
  // comment_mention fan-out run server-side on the todo.item entity).
  const authed = await newAdminAuthedClient();
  const {data: posted, error: postErr} = await authed.rpc('post_comment', {
    p_entity_type: 'todo.item',
    p_entity_id: 'todo-rec-1',
    p_body: 'Heads up @Light Field User this one is yours if it rains.',
    p_entity_label: 'Check the rain gutters',
    p_mentions: [light.id],
    p_attachments: [],
  });
  expect(postErr).toBeNull();
  const mentionCommentId = posted.comment_id || posted.id;

  const {data: notifs} = await supabaseAdmin
    .from('notifications')
    .select('type, comment_entity_type, comment_entity_id, comment_id, recipient_profile_id')
    .eq('comment_id', mentionCommentId);
  expect(notifs).toHaveLength(1);
  expect(notifs[0]).toMatchObject({
    type: 'comment_mention',
    comment_entity_type: 'todo.item',
    comment_entity_id: 'todo-rec-1',
    recipient_profile_id: light.id,
  });

  // Deeplink round-trip: the anchored comment is on the page. Navigate away
  // first — a same-path hash-only goto would not remount the record page, and
  // the mention comment landed node-side after the list rendered.
  await page.goto('/tasks/todo');
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
  await page.goto(`/tasks/todo/todo-rec-1#comment-${mentionCommentId}`);
  await expect(page.locator('[data-todo-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator(`#comment-${mentionCommentId}`)).toBeVisible({timeout: 10_000});
});

test('light user opens the record page and comments; equipment_tech is bounced and sees no toggle', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  await ensureRoleUser(supabaseAdmin, {
    email: LIGHT_EMAIL,
    password: LIGHT_PASSWORD,
    fullName: 'Light Field User',
    role: 'light',
  });
  await ensureRoleUser(supabaseAdmin, {
    email: TECH_EMAIL,
    password: TECH_PASSWORD,
    fullName: 'Eq Tech User',
    role: 'equipment_tech',
  });
  await seedItem(supabaseAdmin, adminId, {id: 'todo-rec-2', title: 'Stack the spare lumber'});

  // Light: list + record page + comment all work (server role checks run as light).
  await signIn(page, LIGHT_EMAIL, LIGHT_PASSWORD);
  await page.goto('/tasks/todo');
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
  await page.locator('[data-todo-row="todo-rec-2"]').click();
  await expect(page.locator('[data-todo-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  // Light is not a manager: no convert/remove.
  await expect(page.locator('[data-todo-convert="todo-rec-2"]')).toHaveCount(0);
  await expect(page.locator('[data-todo-remove="todo-rec-2"]')).toHaveCount(0);

  const composer = page.locator('[data-mention-textarea="1"]').last();
  await composer.fill('I can grab this Friday.');
  await page.locator('[data-comments-post-button="1"]').click();
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin
          .from('comments')
          .select('id')
          .eq('entity_type', 'todo.item')
          .eq('entity_id', 'todo-rec-2');
        return data && data.length;
      },
      {timeout: 10_000},
    )
    .toBe(1);

  // equipment_tech: no toggle on /tasks; BOTH the list URL and a record URL
  // bounce back to /tasks (URL normalized, surface never shown).
  await signIn(page, TECH_EMAIL, TECH_PASSWORD);
  await page.goto('/tasks');
  await expect(page.locator('[data-tasks-tab-bar="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-tasks-mode-toggle="1"]')).toHaveCount(0);

  await page.goto('/tasks/todo');
  await expect(page).toHaveURL(/\/tasks$/, {timeout: 10_000});
  await expect(page.locator('[data-tasks-mode-toggle="1"]')).toHaveCount(0);
  await expect(page.locator('[data-todo-list-loaded="1"]')).toHaveCount(0);

  await page.goto('/tasks/todo/todo-rec-2');
  await expect(page).toHaveURL(/\/tasks$/, {timeout: 10_000});
  await expect(page.locator('[data-tasks-mode-toggle="1"]')).toHaveCount(0);
});

test('To Do mention eligibility: picker source excludes equipment_tech; post_comment rejects an equipment_tech mention; participant mention works', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearTodoData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  const light = await ensureRoleUser(supabaseAdmin, {
    email: LIGHT_EMAIL,
    password: LIGHT_PASSWORD,
    fullName: 'Light Field User',
    role: 'light',
  });
  const tech = await ensureRoleUser(supabaseAdmin, {
    email: TECH_EMAIL,
    password: TECH_PASSWORD,
    fullName: 'Eq Tech User',
    role: 'equipment_tech',
  });
  await seedItem(supabaseAdmin, adminId, {id: 'todo-rec-3', title: 'Oil the shop door hinges'});

  const authed = await newAdminAuthedClient();

  // 1. The To Do mention picker SOURCE (list_todo_mentionable_profiles)
  //    excludes equipment_tech and includes the participant.
  const {data: picker, error: pickErr} = await authed.rpc('list_todo_mentionable_profiles');
  expect(pickErr).toBeNull();
  const pickerIds = (picker || []).map((p) => p.id);
  expect(pickerIds).toContain(light.id);
  expect(pickerIds).not.toContain(tech.id);
  // The generic comment picker still includes equipment_tech (unchanged).
  const {data: generic} = await authed.rpc('list_comment_mentionable_profiles');
  expect((generic || []).map((p) => p.id)).toContain(tech.id);

  // 2. post_comment REJECTS a direct equipment_tech mention on todo.item.
  const {error: rejErr} = await authed.rpc('post_comment', {
    p_entity_type: 'todo.item',
    p_entity_id: 'todo-rec-3',
    p_body: 'Trying to loop in the tech.',
    p_entity_label: 'Oil the shop door hinges',
    p_mentions: [tech.id],
    p_attachments: [],
  });
  expect(rejErr).not.toBeNull();
  expect(String(rejErr.message)).toMatch(/not a To Do participant/);
  // Nothing landed.
  const {data: afterReject} = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('entity_type', 'todo.item')
    .eq('entity_id', 'todo-rec-3');
  expect(afterReject).toHaveLength(0);

  // 3. A participant (light) mention still works and notifies + deep-links.
  const {data: ok, error: okErr} = await authed.rpc('post_comment', {
    p_entity_type: 'todo.item',
    p_entity_id: 'todo-rec-3',
    p_body: 'This one is yours @Light Field User.',
    p_entity_label: 'Oil the shop door hinges',
    p_mentions: [light.id],
    p_attachments: [],
  });
  expect(okErr).toBeNull();
  const okCommentId = ok.comment_id || ok.id;
  const {data: notifs} = await supabaseAdmin
    .from('notifications')
    .select('type, comment_entity_type, comment_entity_id, recipient_profile_id')
    .eq('comment_id', okCommentId);
  expect(notifs).toHaveLength(1);
  expect(notifs[0]).toMatchObject({
    type: 'comment_mention',
    comment_entity_type: 'todo.item',
    comment_entity_id: 'todo-rec-3',
    recipient_profile_id: light.id,
  });

  // 4. edit_comment also rejects adding an equipment_tech mention on todo.item.
  const {error: editRejErr} = await authed.rpc('edit_comment', {
    p_comment_id: okCommentId,
    p_body: 'This one is yours @Light Field User (and tech).',
    p_mentions: [light.id, tech.id],
    p_attachments: [],
  });
  expect(editRejErr).not.toBeNull();
  expect(String(editRejErr.message)).toMatch(/not a To Do participant/);
});
