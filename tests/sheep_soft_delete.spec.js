import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Sheep soft-delete/restore — parity with tests/cattle_soft_delete.spec.js
// ============================================================================
// Locks the sheep.animal soft-delete implementation (migration 074):
//
//   1  Admin soft-deletes a sheep from the UI → row hidden + deleted_at set
//   2  Admin restores sheep by RPC → reappears to anon (active surfaces)
//   3  Restore conflict: active-flock tag reuse returns backend error
//   4  Deceased restore does not conflict on tag with an active sheep
//   5  Non-admin cannot soft-delete/restore via RPC (admin role required)
//   6  Non-admin does not see the record-page Delete control
//   7  Anon RLS: deleted sheep invisible to public queries; active stays visible
//   8  Direct authenticated DELETE is blocked by RLS (no DELETE policy)
//   9  Direct UPDATE setting deleted_at is blocked by RLS
//  10  record.deleted + record.restored visible in global Activity
//  11  Record-page Activity log shows delete/restore events after restore
//
// Note: the sheep UI lacks the data-* list/flock hooks cattle has, so list
// disappearance is verified at the RLS/DB layer (the real contract) rather
// than by scraping rendered flock rows. The sheep processing-batch path is
// intentionally out of scope (admin-context exception, like cattle).
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

const MGMT_EMAIL = 'test-mgmt-sheep-sd@wcfplanner.test';
const MGMT_PASSWORD = 'SheepSoftDeleteMgmt123!';

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

async function anonSheepTags() {
  const anonSb = newAnonClient();
  const {data} = await anonSb.from('sheep').select('tag').order('tag');
  return (data || []).map((r) => r.tag);
}

// Record pages fail closed on a transient cold-load read error, which is more
// likely right after the mid-test DB reset. Mirror the page's own Retry UX with
// a bounded reload until the record page renders.
async function gotoSheepRecord(targetPage, sheepId) {
  await targetPage.goto('/sheep/flocks/' + sheepId);
  const marker = targetPage.locator('[data-sheep-animal-page="1"]');
  for (let i = 0; i < 6; i++) {
    if (await marker.isVisible().catch(() => false)) return;
    await targetPage.waitForTimeout(1000);
    await targetPage.reload();
  }
  await expect(marker).toBeVisible({timeout: 15_000});
}

// --------------------------------------------------------------------------
// Test 1 — Admin soft-deletes a sheep from the UI → hidden + deleted_at set
// --------------------------------------------------------------------------
test('admin delete: sheep soft-deleted from record page, hidden, deleted_at set', async ({
  page,
  supabaseAdmin,
  sheepSoftDeleteScenario,
}) => {
  const ids = sheepSoftDeleteScenario;

  await gotoSheepRecord(page, ids.delSheepId);
  await page.waitForFunction(() => typeof window._wcfConfirmDelete === 'function');
  await page.evaluate(() => {
    window._wcfConfirmDelete = (_msg, fn) => fn();
  });

  // The action-bar sheep Delete is the only exact "Delete" button on the page
  // (comments hidden, no lambing rows seeded). Admin role renders it.
  const deleteBtn = page.getByRole('button', {name: 'Delete', exact: true});
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // deleteSheep navigates back to the flocks list on success.
  await expect(page).toHaveURL(/\/sheep\/flocks$/, {timeout: 15_000});

  // Source row still exists, now soft-deleted with attribution.
  const {data: row, error} = await supabaseAdmin
    .from('sheep')
    .select('id,tag,deleted_at,deleted_by')
    .eq('id', ids.delSheepId)
    .single();
  expect(error).toBeNull();
  expect(row.tag).toBe('SD-100');
  expect(row.deleted_at).not.toBeNull();
  expect(row.deleted_by).not.toBeNull();

  // Hidden from anon (active) surfaces.
  expect(await anonSheepTags()).not.toContain('SD-100');
});

// --------------------------------------------------------------------------
// Test 2 — Admin restore by RPC brings the sheep back to active surfaces
// --------------------------------------------------------------------------
test('admin restore: sheep reappears to anon after restore', async ({supabaseAdmin, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  const del = await adminSb.rpc('soft_delete_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(del.error).toBeNull();
  expect(await anonSheepTags()).not.toContain('SD-100');

  const restore = await adminSb.rpc('restore_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(restore.error).toBeNull();
  expect(restore.data).toHaveProperty('ok', true);

  const {data: row} = await supabaseAdmin
    .from('sheep')
    .select('deleted_at,deleted_by')
    .eq('id', ids.delSheepId)
    .single();
  expect(row.deleted_at).toBeNull();
  expect(row.deleted_by).toBeNull();
  expect(await anonSheepTags()).toContain('SD-100');
});

// --------------------------------------------------------------------------
// Test 3 — Restore conflict: active-flock tag reuse returns backend error
// --------------------------------------------------------------------------
test('restore conflict: active-flock tag reuse returns backend error', async ({
  supabaseAdmin,
  sheepSoftDeleteScenario,
}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  const del = await adminSb.rpc('soft_delete_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(del.error).toBeNull();

  // New active sheep reuses the deleted tag in an active flock.
  const reuse = await supabaseAdmin.from('sheep').upsert(
    {
      id: 'sd-tag-reuse',
      tag: 'SD-100',
      sex: 'ewe',
      flock: 'ewes',
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );
  expect(reuse.error).toBeNull();

  const restore = await adminSb.rpc('restore_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(restore.error).not.toBeNull();
  expect(restore.error.message).toMatch(/already in use/);

  // Stays deleted.
  const {data: row} = await supabaseAdmin.from('sheep').select('deleted_at').eq('id', ids.delSheepId).single();
  expect(row.deleted_at).not.toBeNull();
});

// --------------------------------------------------------------------------
// Test 4 — Deceased restore does not conflict on tag with an active sheep
// --------------------------------------------------------------------------
test('deceased restore: no tag conflict with active sheep', async ({supabaseAdmin, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  const del = await adminSb.rpc('soft_delete_sheep_animal', {
    p_entity_id: ids.deadSheepId,
    p_entity_label: ids.deadSheepTag,
  });
  expect(del.error).toBeNull();

  // Active sheep with the same tag in an active flock.
  await supabaseAdmin.from('sheep').upsert(
    {
      id: 'sd-active-same-tag',
      tag: 'SD-DEAD',
      sex: 'wether',
      flock: 'feeders',
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );

  // Deceased is outside active-flock scope, so restore succeeds.
  const restore = await adminSb.rpc('restore_sheep_animal', {
    p_entity_id: ids.deadSheepId,
    p_entity_label: ids.deadSheepTag,
  });
  expect(restore.error).toBeNull();
  expect(restore.data).toHaveProperty('ok', true);

  const {data: row} = await supabaseAdmin.from('sheep').select('deleted_at').eq('id', ids.deadSheepId).single();
  expect(row.deleted_at).toBeNull();
});

// --------------------------------------------------------------------------
// Test 5 — Non-admin cannot soft-delete/restore via RPC
// --------------------------------------------------------------------------
test('non-admin: soft_delete/restore RPC rejected (admin role required)', async ({
  supabaseAdmin,
  sheepSoftDeleteScenario,
}) => {
  const ids = sheepSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);
  const mgmtSb = await newManagementAuthedClient();

  const del = await mgmtSb.rpc('soft_delete_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(del.error).not.toBeNull();
  expect(del.error.message).toMatch(/admin role required/);

  const restore = await mgmtSb.rpc('restore_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });
  expect(restore.error).not.toBeNull();

  // Row untouched.
  const {data: row} = await supabaseAdmin.from('sheep').select('deleted_at').eq('id', ids.delSheepId).single();
  expect(row.deleted_at).toBeNull();
});

// --------------------------------------------------------------------------
// Test 6 — Non-admin does not see the record-page Delete control
// --------------------------------------------------------------------------
test('non-admin: record-page Delete control hidden', async ({supabaseAdmin, sheepSoftDeleteScenario, browser}) => {
  const ids = sheepSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);

  const mgmtContext = await browser.newContext({storageState: undefined});
  const mgmtPage = await mgmtContext.newPage();
  await mgmtPage.goto('/');
  await mgmtPage.fill('input[type="email"]', MGMT_EMAIL);
  await mgmtPage.fill('input[type="password"]', MGMT_PASSWORD);
  await mgmtPage.getByRole('button', {name: /Sign In/i}).click();
  await expect(mgmtPage.locator('input[type="email"]')).toHaveCount(0, {timeout: 15_000});

  await gotoSheepRecord(mgmtPage, ids.delSheepId);

  // onDelete is gated to admins; SheepDetail renders the Delete button only
  // when onDelete is provided, so management sees zero exact "Delete" buttons.
  await expect(mgmtPage.getByRole('button', {name: 'Delete', exact: true})).toHaveCount(0);

  await mgmtContext.close();
});

// --------------------------------------------------------------------------
// Test 7 — Anon RLS: deleted sheep invisible; active stays visible
// --------------------------------------------------------------------------
test('anon RLS: deleted sheep hidden, active sheep visible', async ({sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_sheep_animal', {
    p_entity_id: ids.delSheepId,
    p_entity_label: ids.delSheepTag,
  });

  const tags = await anonSheepTags();
  expect(tags).toContain('SD-200'); // active control stays visible
  expect(tags).not.toContain('SD-100'); // deleted hidden by RLS
});

// --------------------------------------------------------------------------
// Test 8 — Direct authenticated DELETE is blocked by RLS (no DELETE policy)
// --------------------------------------------------------------------------
test('RLS: direct authenticated DELETE is blocked', async ({supabaseAdmin, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);
  const mgmtSb = await newManagementAuthedClient();

  await mgmtSb.from('sheep').delete().eq('id', ids.delSheepId);

  const {data: row} = await supabaseAdmin.from('sheep').select('id').eq('id', ids.delSheepId).single();
  expect(row).not.toBeNull();
  expect(row.id).toBe(ids.delSheepId);
});

// --------------------------------------------------------------------------
// Test 9 — Direct UPDATE setting deleted_at is blocked by RLS
// --------------------------------------------------------------------------
test('RLS: direct UPDATE setting deleted_at is blocked', async ({supabaseAdmin, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;
  await ensureManagementUser(supabaseAdmin);
  const mgmtSb = await newManagementAuthedClient();

  await mgmtSb.from('sheep').update({deleted_at: new Date().toISOString()}).eq('id', ids.delSheepId);

  const {data: row} = await supabaseAdmin.from('sheep').select('deleted_at').eq('id', ids.delSheepId).single();
  expect(row.deleted_at).toBeNull();
});

// --------------------------------------------------------------------------
// Test 10 — record.deleted + record.restored visible in global Activity
// --------------------------------------------------------------------------
test('Activity: delete/restore events visible in global Activity', async ({page, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_sheep_animal', {p_entity_id: ids.delSheepId, p_entity_label: ids.delSheepTag});
  await adminSb.rpc('restore_sheep_animal', {p_entity_id: ids.delSheepId, p_entity_label: ids.delSheepTag});

  // The global Activity log fails closed on a transient cold-load read error,
  // which can happen on the first load right after the mid-test DB reset.
  // Mirror the real Retry UX with a bounded reload until the timeline renders.
  await page.goto('/activity');
  const firstRow = page.locator('[data-activity-log-row]').first();
  for (let i = 0; i < 6; i++) {
    if (await firstRow.isVisible().catch(() => false)) break;
    await page.waitForTimeout(1000);
    await page.reload();
  }
  await expect(firstRow).toBeVisible({timeout: 15_000});

  await expect(page.getByText(/Deleted sheep animal.*SD-100/)).toBeVisible({timeout: 10_000});
  await expect(page.getByText(/Restored sheep animal.*SD-100/)).toBeVisible({timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 11 — Record-page Activity log shows delete/restore events after restore
// --------------------------------------------------------------------------
test('record-page Activity log: delete/restore events on restored sheep', async ({page, sheepSoftDeleteScenario}) => {
  const ids = sheepSoftDeleteScenario;

  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('soft_delete_sheep_animal', {p_entity_id: ids.delSheepId, p_entity_label: ids.delSheepTag});
  await adminSb.rpc('restore_sheep_animal', {p_entity_id: ids.delSheepId, p_entity_label: ids.delSheepTag});

  // After restore the source row is active, so the record page loads and its
  // read-only Activity log carries the delete/restore audit trail.
  await gotoSheepRecord(page, ids.delSheepId);

  await page.locator('[data-activity-log-toggle="1"]').click();

  const audit = page.locator('[data-activity-audit-log="1"]');
  await expect(audit).toBeVisible();
  await expect(audit.getByText(/Deleted sheep animal.*SD-100/)).toBeVisible({timeout: 10_000});
  await expect(audit.getByText(/Restored sheep animal.*SD-100/)).toBeVisible();
});
