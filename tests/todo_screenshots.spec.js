import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from './fixtures.js';

// ============================================================================
// To Do List — approval screenshot packet (NOT regression testing).
// ============================================================================
// Idempotent capture utility (cattle_log_screenshots pattern): every capture
// rebuilds the identical baseline in beforeEach (fixed ids + upsert-on-id),
// writes desktop (1366x900) and mobile (390x844) shots into todo-shots/ at
// the repo root, and can be re-run any time:
//
//   npx playwright test tests/todo_screenshots.spec.js --workers=1
//
// Covers the Ronnie review packet: meaty toggle (both sides), All view with
// the three sections (pending badge, rejected cue, due cue, photo thumbs,
// manager reorder/move controls), single-section filter, New To Do modal,
// record page with comments, Complete modal, pending-approval manager view,
// Reject modal, expanded Completed section, How to Use modal, and the
// prefilled Convert modal.
// ============================================================================

const SHOT_DIR = path.resolve(process.cwd(), 'todo-shots');
const DESKTOP = {width: 1366, height: 900};
const MOBILE = {width: 390, height: 844};

// Known-good 1x1 PNG for thumbnail seeding.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, {recursive: true});
  await page.screenshot({path: path.join(SHOT_DIR, `${name}.png`), fullPage: false});
}

async function seedProfiles(supabaseAdmin) {
  const {data: u} = await supabaseAdmin.auth.admin.listUsers();
  const adminUser = (u && u.users ? u.users : []).find(
    (x) => (x.email || '').toLowerCase() === (process.env.VITE_TEST_ADMIN_EMAIL || '').toLowerCase(),
  );
  if (!adminUser) throw new Error('admin auth user not found');
  await supabaseAdmin
    .from('profiles')
    .upsert({id: adminUser.id, email: adminUser.email, full_name: 'Test Admin', role: 'admin'}, {onConflict: 'id'});
  const {data: simon} = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', 'simon.tasks@wcfplanner.test')
    .maybeSingle();
  return {adminId: adminUser.id, simonId: simon ? simon.id : adminUser.id};
}

function daysFromNowISO(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function seedScenario(supabaseAdmin) {
  const {error: clearErr} = await supabaseAdmin.from('todo_items').delete().neq('id', '__never__');
  if (clearErr) throw new Error('clear todo_items: ' + clearErr.message);
  const {adminId, simonId} = await seedProfiles(supabaseAdmin);

  const now = Date.now();
  const items = [
    {
      id: 'todo-shot-lumber',
      title: 'Re-stack the lumber pile behind the shop',
      description: 'Sort by length; scrap goes in the burn pile.',
      section: 'general',
      status: 'open',
      sort_order: 0,
      created_by: simonId,
      created_at: new Date(now - 9 * 86400000).toISOString(),
    },
    {
      id: 'todo-shot-gutters',
      title: 'Clean out the shop gutters',
      section: 'general',
      status: 'open',
      sort_order: 1,
      created_by: adminId,
      due_date: daysFromNowISO(4),
      created_at: new Date(now - 2 * 86400000).toISOString(),
    },
    {
      id: 'todo-shot-brooder',
      title: 'Re-hang the brooder door',
      description: 'Hinge bolts are in the shop drawer, second from the top.',
      section: 'chicken_pigs',
      status: 'open',
      sort_order: 0,
      created_by: adminId,
      created_at: new Date(now - 86400000).toISOString(),
    },
    {
      id: 'todo-shot-fence',
      title: 'Patch the chicken run fence',
      section: 'chicken_pigs',
      status: 'pending_approval',
      sort_order: 1,
      created_by: adminId,
      completion_submitted_by: simonId,
      completion_submitted_at: new Date(now - 3600000).toISOString(),
      completion_note: 'Stapled new wire on the north side.',
      created_at: new Date(now - 5 * 86400000).toISOString(),
    },
    {
      id: 'todo-shot-mineral',
      title: 'Move mineral feeders to the east paddock',
      section: 'cattle_sheep',
      status: 'open',
      sort_order: 0,
      created_by: simonId,
      rejected_by: adminId,
      rejected_at: new Date(now - 7200000).toISOString(),
      rejection_note: 'Two feeders are still by the gate, finish the row.',
      created_at: new Date(now - 4 * 86400000).toISOString(),
    },
    {
      id: 'todo-shot-headgate',
      title: 'Grease the head gate',
      section: 'cattle_sheep',
      status: 'completed',
      sort_order: 1,
      created_by: adminId,
      completion_submitted_by: simonId,
      completion_submitted_at: new Date(now - 2 * 86400000).toISOString(),
      completion_note: 'Greased and cycled it a few times.',
      approved_by: adminId,
      approved_at: new Date(now - 2 * 86400000 + 3600000).toISOString(),
      created_at: new Date(now - 12 * 86400000).toISOString(),
    },
  ];
  const {error} = await supabaseAdmin.from('todo_items').upsert(items, {onConflict: 'id'});
  if (error) throw new Error('seed todo_items: ' + error.message);

  // Two origination photo thumbnails on the brooder item.
  for (const slot of [1, 2]) {
    await supabaseAdmin.storage.from('task-photos').upload(`todo/todo-shot-brooder/origination-${slot}.jpg`, TINY_PNG, {
      contentType: 'image/png',
      upsert: true,
    });
  }
  await supabaseAdmin.from('todo_item_photos').upsert(
    [
      {
        id: 'tip-shot-1',
        todo_id: 'todo-shot-brooder',
        kind: 'origination',
        storage_path: 'task-photos/todo/todo-shot-brooder/origination-1.jpg',
        sort_order: 0,
      },
      {
        id: 'tip-shot-2',
        todo_id: 'todo-shot-brooder',
        kind: 'origination',
        storage_path: 'task-photos/todo/todo-shot-brooder/origination-2.jpg',
        sort_order: 1,
      },
    ],
    {onConflict: 'id'},
  );
}

async function waitForTodoLoaded(page) {
  await expect(page.locator('[data-todo-list-loaded="1"]')).toBeVisible({timeout: 15_000});
}

test.beforeEach(async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedScenario(supabaseAdmin);
});

test('packet 1: meaty toggle on both sides, desktop + mobile', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks');
  await expect(page.locator('[data-tasks-mode-toggle="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-tasks-tab-bar="1"]')).toBeVisible();
  await shot(page, '01-desktop-task-center-with-toggle');

  await page.setViewportSize(MOBILE);
  await shot(page, '02-mobile-task-center-with-toggle');

  await page.setViewportSize(DESKTOP);
  await page.locator('[data-tasks-mode-todo="1"]').click();
  await waitForTodoLoaded(page);
  await shot(page, '03-desktop-todo-all-sections');

  await page.setViewportSize(MOBILE);
  await shot(page, '04-mobile-todo-all-sections');
});

test('packet 2: single-section filter + pending-approval manager view', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-section-chip="chicken_pigs"]').click();
  await shot(page, '05-desktop-todo-section-chicken-pigs');

  await page.locator('[data-todo-section-chip="all"]').click();
  await page.locator('[data-todo-pending-filter="1"]').click();
  await shot(page, '06-desktop-todo-pending-approval-filter');
});

test('packet 3: New To Do modal, desktop + mobile', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);
  await page.locator('[data-todo-new-button="1"]').click();
  await expect(page.locator('[data-todo-new-modal="1"]')).toBeVisible();
  await page.locator('#todo-new-title').fill('Re-hang the gate by the pig barn');
  await page.locator('#todo-new-due').fill(daysFromNowISO(7));
  await shot(page, '07-desktop-new-todo-modal');

  await page.setViewportSize(MOBILE);
  await shot(page, '08-mobile-new-todo-modal');
});

test('packet 4: record page with comments + completion info, desktop + mobile', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo/todo-shot-brooder');
  await expect(page.locator('[data-todo-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  await shot(page, '09-desktop-todo-record-page');

  await page.setViewportSize(MOBILE);
  await shot(page, '10-mobile-todo-record-page');

  // Pending item record page shows the submitted-completion panel.
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo/todo-shot-fence');
  await expect(page.locator('[data-todo-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  await shot(page, '11-desktop-todo-record-pending');
});

test('packet 5: complete + reject modals', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-complete="todo-shot-brooder"]').click();
  await expect(page.locator('[data-todo-complete-modal="1"]')).toBeVisible();
  await page.locator('#todo-complete-note').fill('Re-hung and swinging clean.');
  await shot(page, '12-desktop-complete-modal');
  await page.getByRole('button', {name: /^cancel$/i}).click();

  await page.locator('[data-todo-reject="todo-shot-fence"]').click();
  await expect(page.locator('[data-todo-reject-modal="1"]')).toBeVisible();
  await page.locator('#todo-reject-note').fill('South side still has a gap.');
  await shot(page, '13-desktop-reject-modal');
});

test('packet 6: completed section expanded + How to Use + convert modal + mobile controls', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/tasks/todo');
  await waitForTodoLoaded(page);

  await page.locator('[data-todo-completed-toggle="1"]').click();
  await page.locator('[data-todo-completed-section="1"]').scrollIntoViewIfNeeded();
  await shot(page, '14-desktop-completed-expanded');

  await page.locator('[data-todo-howto="1"]').click();
  await expect(page.locator('[data-todo-howto-modal="1"]')).toBeVisible();
  await shot(page, '15-desktop-howto-modal');
  await page.locator('[data-todo-howto-close="1"]').click();

  await page.locator('[data-todo-convert="todo-shot-brooder"]').click();
  await expect(page.locator('[data-todo-convert-modal="1"]')).toBeVisible();
  await shot(page, '16-desktop-convert-modal-prefilled');
  await page.getByRole('button', {name: /^cancel$/i}).click();

  // Mobile manager controls (arrows + section select) on the list rows.
  await page.setViewportSize(MOBILE);
  await waitForTodoLoaded(page);
  await shot(page, '17-mobile-manager-controls');
});
