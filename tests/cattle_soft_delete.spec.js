import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle soft-delete/restore — 2026-05-24
// ============================================================================
// Locks the cattle.animal soft-delete implementation (migration 069):
//
//   1  Admin deletes a cow → cow disappears from active herds
//   2  Deleted cow appears in Recently Deleted Cattle
//   3  Admin restores cow → cow reappears in active herds
//   4  Restore conflict: active-herd tag reuse shows inline error
//   5  Sold/deceased restore does not fail on tag overlap with active cow
//   6  Public weigh-in webform does not show deleted cow tags
//   7  Non-admin cannot see cattle delete controls
//   8  Direct authenticated DELETE is blocked by RLS
//   9  Direct UPDATE setting deleted_at is blocked by RLS
//  10  record.deleted + record.restored visible in global Activity
//  11  Cow Activity modal shows delete/restore events after restore
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

async function newAdminAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({
    email: TEST_ADMIN_EMAIL,
    password: TEST_ADMIN_PASSWORD,
  });
  if (error) throw new Error(`admin signInWithPassword failed: ${error.message}`);
  return sb;
}

const MGMT_EMAIL = 'test-mgmt-cattle-sd@wcfplanner.test';
const MGMT_PASSWORD = 'CattleSoftDeleteMgmt123!';

async function ensureManagementUser(supabaseAdmin) {
  let mgmtUser;
  const existing = await supabaseAdmin.auth.admin.listUsers();
  mgmtUser = existing.data?.users?.find((u) => u.email === MGMT_EMAIL);
  if (!mgmtUser) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: MGMT_EMAIL,
      password: MGMT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create mgmt user: ${created.error.message}`);
    mgmtUser = created.data?.user;
  }
  if (mgmtUser) {
    await supabaseAdmin
      .from('profiles')
      .upsert({id: mgmtUser.id, email: MGMT_EMAIL, role: 'management'}, {onConflict: 'id'});
  }
  return mgmtUser;
}

async function newManagementAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({
    email: MGMT_EMAIL,
    password: MGMT_PASSWORD,
  });
  if (error) throw new Error(`mgmt signInWithPassword failed: ${error.message}`);
  return sb;
}

async function waitForCattleLoaded(page) {
  await expect(page.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-cattle-match-count]')).not.toHaveText(/^0 /, {timeout: 15_000});
}

async function expandHerd(page, herd) {
  const tile = page.locator(`[data-herd-tile="${herd}"]`);
  await expect(tile).toBeVisible();
  if ((await tile.getAttribute('data-herd-open')) !== '1') {
    await tile.click();
  }
  await expect(tile).toHaveAttribute('data-herd-open', '1');
}

// --------------------------------------------------------------------------
// Test 1 — Admin deletes a cow → it disappears from active herds
// --------------------------------------------------------------------------
test('admin delete: cow disappears from active herds', async ({page, cattleSoftDeleteScenario}) => {
  await page.goto('/cattle/herds');
  await waitForCattleLoaded(page);

  await expandHerd(page, 'mommas');
  await expect(page.locator('[data-cow-row-tag="SD-100"]')).toBeVisible();

  // Expand the cow detail.
  await page.locator('[data-cow-row-tag="SD-100"]').click();
  await expect(page.locator('[data-cow-detail]')).toBeVisible();

  // Click the action-bar Delete (last Delete button in cow detail).
  const deleteBtn = page.locator('[data-cow-detail] button:has-text("Delete")').last();
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // DeleteModal: type "delete" and press Enter to confirm.
  await expect(page.locator('input[placeholder="delete"]')).toBeVisible();
  await page.fill('input[placeholder="delete"]', 'delete');
  await page.locator('input[placeholder="delete"]').press('Enter');

  // Cow disappears from herds list.
  await expect(page.locator('[data-cow-row-tag="SD-100"]')).toHaveCount(0, {timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 2 — Deleted cow appears in Recently Deleted Cattle
// --------------------------------------------------------------------------
test('deleted cow appears in Recently Deleted', async ({page, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  // Delete via authenticated admin client (not service-role).
  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  await page.goto('/cattle/herds');
  await waitForCattleLoaded(page);

  await expect(page.locator('[data-cow-row-tag="SD-100"]')).toHaveCount(0);

  // Open Recently Deleted.
  const recentlyDeletedBtn = page.getByRole('button', {name: /Recently Deleted/});
  await expect(recentlyDeletedBtn).toBeVisible();
  await recentlyDeletedBtn.click();

  await expect(page.getByText('#SD-100')).toBeVisible({timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 3 — Admin restores cow → cow reappears in active herds
// --------------------------------------------------------------------------
test('admin restore: cow reappears in active herds', async ({page, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  await page.goto('/cattle/herds');
  await waitForCattleLoaded(page);

  await page.getByRole('button', {name: /Recently Deleted/}).click();
  await expect(page.getByText('#SD-100')).toBeVisible({timeout: 10_000});

  // Click Restore.
  const row = page.locator('div').filter({hasText: '#SD-100'}).last();
  await row.getByRole('button', {name: 'Restore'}).click();

  // Cow reappears in mommas.
  await expandHerd(page, 'mommas');
  await expect(page.locator('[data-cow-row-tag="SD-100"]')).toBeVisible({timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 4 — Restore conflict: tag reuse in active herd shows error
// --------------------------------------------------------------------------
test('restore conflict: tag reuse shows inline error', async ({page, supabaseAdmin, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  // Create a new active cow with the same tag in an active herd.
  await supabaseAdmin.from('cattle').insert({
    id: 'sd-tag-reuse',
    tag: 'SD-100',
    sex: 'heifer',
    herd: 'backgrounders',
    old_tags: [],
  });

  await page.goto('/cattle/herds');
  await waitForCattleLoaded(page);

  await page.getByRole('button', {name: /Recently Deleted/}).click();
  await expect(page.getByText('#SD-100')).toBeVisible({timeout: 10_000});

  const row = page.locator('div').filter({hasText: '#SD-100'}).last();
  await row.getByRole('button', {name: 'Restore'}).click();

  await expect(page.getByText(/Restore failed/)).toBeVisible({timeout: 10_000});
  await expect(page.getByText(/already in use/)).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 5 — Sold/deceased restore does not conflict on tag
// --------------------------------------------------------------------------
test('sold/deceased restore: no tag conflict with active cows', async ({supabaseAdmin, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();

  // Soft-delete the deceased cow.
  const delResult = await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.deadCowId,
    p_entity_label: ids.deadCowTag,
  });
  expect(delResult.error).toBeNull();

  // Insert an active cow with the same tag in an active herd.
  await supabaseAdmin.from('cattle').insert({
    id: 'sd-active-same-tag',
    tag: 'SD-DEAD',
    sex: 'steer',
    herd: 'finishers',
    old_tags: [],
  });

  // Restore deceased cow — should succeed (deceased is outside active-herd scope).
  const restoreResult = await adminSb.rpc('restore_cattle_animal', {
    p_entity_id: ids.deadCowId,
    p_entity_label: ids.deadCowTag,
  });

  expect(restoreResult.error).toBeNull();
  expect(restoreResult.data).toHaveProperty('ok', true);

  // Verify deleted_at cleared.
  const {data: cow} = await supabaseAdmin.from('cattle').select('deleted_at').eq('id', ids.deadCowId).single();
  expect(cow.deleted_at).toBeNull();
});

// --------------------------------------------------------------------------
// Test 6 — Public weigh-in webform does not show deleted cow tags
// --------------------------------------------------------------------------
test('anon RLS: deleted cattle invisible to public queries', async ({cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  // Query cattle as anon — same path the public weigh-in webform takes.
  const anonSb = newAnonClient();
  const {data: tags} = await anonSb.from('cattle').select('tag').order('tag');
  const tagList = (tags || []).map((r) => r.tag);

  // Positive: non-deleted tag is visible to anon.
  expect(tagList).toContain('SD-200');
  // Negative: deleted tag is hidden by RLS.
  expect(tagList).not.toContain('SD-100');
});

// --------------------------------------------------------------------------
// Test 7 — Non-admin cannot see cattle delete controls
// --------------------------------------------------------------------------
test('non-admin: delete button is not visible', async ({supabaseAdmin, cattleSoftDeleteScenario, browser}) => {
  await ensureManagementUser(supabaseAdmin);

  // Log in as management user.
  const mgmtContext = await browser.newContext({storageState: undefined});
  const mgmtPage = await mgmtContext.newPage();
  await mgmtPage.goto('/');
  await mgmtPage.fill('input[type="email"]', MGMT_EMAIL);
  await mgmtPage.fill('input[type="password"]', MGMT_PASSWORD);
  await mgmtPage.getByRole('button', {name: /Sign In/i}).click();
  // Wait for login to complete — the login form should disappear.
  await expect(mgmtPage.locator('input[type="email"]')).toHaveCount(0, {timeout: 15_000});

  await mgmtPage.goto('/cattle/herds');
  await expect(mgmtPage.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});

  await expandHerd(mgmtPage, 'mommas');
  await mgmtPage.locator('[data-cow-row-tag="SD-100"]').click();
  await expect(mgmtPage.locator('[data-cow-detail]')).toBeVisible();

  // Cow-level Delete should NOT be visible for management role.
  // The comment Delete button (1) may exist, but the action-bar cow Delete
  // should not render (onDelete is undefined). Admin would see 2 Delete
  // buttons (comment + cow); management sees at most 1 (comment only).
  const deleteButtons = mgmtPage.locator('[data-cow-detail] button:has-text("Delete")');
  const count = await deleteButtons.count();
  // If the comment Delete exists, count is 1. The cow Delete would make it 2.
  expect(count).toBeLessThanOrEqual(1);

  // Recently Deleted button should also not be visible.
  await expect(mgmtPage.getByRole('button', {name: /Recently Deleted/})).toHaveCount(0);

  await mgmtContext.close();
});

// --------------------------------------------------------------------------
// Test 8 — Direct authenticated DELETE is blocked by RLS
// --------------------------------------------------------------------------
test('RLS: direct authenticated DELETE is blocked', async ({supabaseAdmin, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);

  // Use a signed-in management client (not service-role).
  const mgmtSb = await newManagementAuthedClient();

  // Attempt direct hard-delete.
  const {error} = await mgmtSb.from('cattle').delete().eq('id', ids.delCowId);

  // Verify row still exists via supabaseAdmin.
  const {data: cow} = await supabaseAdmin.from('cattle').select('id').eq('id', ids.delCowId).single();
  expect(cow).not.toBeNull();
  expect(cow.id).toBe(ids.delCowId);
});

// --------------------------------------------------------------------------
// Test 9 — Direct UPDATE setting deleted_at is blocked by RLS
// --------------------------------------------------------------------------
test('RLS: direct UPDATE setting deleted_at is blocked', async ({supabaseAdmin, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);

  const mgmtSb = await newManagementAuthedClient();

  // Attempt to set deleted_at directly.
  await mgmtSb.from('cattle').update({deleted_at: new Date().toISOString()}).eq('id', ids.delCowId);

  // Verify deleted_at is still null via supabaseAdmin.
  const {data: cow} = await supabaseAdmin.from('cattle').select('deleted_at').eq('id', ids.delCowId).single();
  expect(cow.deleted_at).toBeNull();
});

// --------------------------------------------------------------------------
// Test 10 — record.deleted + record.restored visible in global Activity
// --------------------------------------------------------------------------
test('Activity: delete/restore events visible in global Activity', async ({page, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });
  await adminSb.rpc('restore_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  await page.goto('/activity');
  await expect(page.locator('[data-activity-log-row]').first()).toBeVisible({timeout: 15_000});

  await expect(page.getByText(/Deleted cattle animal.*SD-100/)).toBeVisible({timeout: 10_000});
  await expect(page.getByText(/Restored cattle animal.*SD-100/)).toBeVisible({timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 11 — Cow Activity modal shows delete/restore events after restore
// --------------------------------------------------------------------------
test('Activity modal: delete/restore events on restored cow', async ({page, cattleSoftDeleteScenario}) => {
  const ids = cattleSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });
  await adminSb.rpc('restore_cattle_animal', {
    p_entity_id: ids.delCowId,
    p_entity_label: ids.delCowTag,
  });

  await page.goto('/cattle/herds');
  await waitForCattleLoaded(page);

  await expandHerd(page, 'mommas');
  await expect(page.locator('[data-cow-row-tag="SD-100"]')).toBeVisible();

  // Click the Activity compact chip on SD-100.
  const activityChip = page.locator('[data-cow-row-tag="SD-100"] [data-activity-compact-chip="1"]');
  // The chip may need the row to be visible first. If inside collapsed row,
  // click the row first to expand.
  if (await activityChip.isVisible().catch(() => false)) {
    await activityChip.click();
  } else {
    // Expand the cow first, then find the chip.
    await page.locator('[data-cow-row-tag="SD-100"]').click();
    await expect(page.locator('[data-cow-detail]')).toBeVisible();
    const detailChip = page.locator('[data-activity-compact-chip="1"]').first();
    await detailChip.click();
  }

  // ActivityModal should open.
  await expect(page.locator('[data-activity-modal="1"]')).toBeVisible({timeout: 10_000});

  // Both events should be in the modal.
  const modal = page.locator('[data-activity-modal="1"]');
  await expect(modal.getByText(/Deleted cattle animal/)).toBeVisible({timeout: 10_000});
  await expect(modal.getByText(/Restored cattle animal/)).toBeVisible();
});
