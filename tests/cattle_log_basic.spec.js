import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle Log — basic create / search / filter / load-more (/cattle/log).
// ============================================================================
// Entries are canonical comments on the singleton ('cattle.log', 'cattle-log')
// driven exclusively through the migration 112 SECDEF RPC family. This spec
// covers the page fundamentals under the default admin storageState:
//
//   1  Composer create: submit renders a row + lands a comments row with an
//      issue-state row (Issue defaults checked).
//   2  Filters: 'Issues' is the default; is_issue=false entries only appear
//      under 'All'.
//   3  Server-side search: body ILIKE, author name ILIKE, exact #tag match
//      (with and without the leading '#'); '#0404' ≠ '#404' (exact text).
//   4  Keyset pagination: first 200 newest-first, 'Load more' reveals the
//      rest and then disappears.
//
// comments / cattle_log_* tables are NOT in the reset truncate whitelist
// (tests/setup/reset.js), so each test clears them explicitly — link/issue
// rows cascade off the comments hard delete (FK ON DELETE CASCADE).
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

// Authed (non-service-role) admin client so seeded entries run the real
// submit_cattle_log_entry path (role check, issue-state row, tag links).
async function newAdminAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({
    email: TEST_ADMIN_EMAIL,
    password: TEST_ADMIN_PASSWORD,
  });
  if (error) throw new Error(`admin signInWithPassword failed: ${error.message}`);
  return sb;
}

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

// comments is not reset-truncated; cattle_log_tag_links + cattle_log_issue_state
// cascade off the hard delete.
async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

// Entry ids: 'cl-…', never 'clog-' prefixed, never containing '--'.
function mintEntryId(prefix) {
  return `cl-${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function submitEntryViaRpc(
  authedSb,
  {id, body, mentions = [], attachments = [], isIssue = true, calfNotes = {}},
) {
  const {data, error} = await authedSb.rpc('submit_cattle_log_entry', {
    p_id: id,
    p_body: body,
    p_mentions: mentions,
    p_attachments: attachments,
    p_is_issue: isIssue,
    p_calf_notes: calfNotes,
  });
  if (error) throw new Error(`submit_cattle_log_entry(${id}): ${error.message}`);
  return data;
}

async function seedCow(supabaseAdmin, {id, tag, herd = 'finishers', sex = 'steer', oldTags = []}) {
  const {error} = await supabaseAdmin.from('cattle').upsert(
    {
      id,
      tag,
      herd,
      sex,
      old_tags: oldTags,
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error(`seedCow(${id}): ${error.message}`);
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';

// --------------------------------------------------------------------------
// Test 1 — composer create
// --------------------------------------------------------------------------
test('composer create: entry lands as a cattle.log comment with issue-state and renders newest-first', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const body = 'Water line leak by the north trough';
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  // Issue checkbox defaults checked.
  await expect(page.locator('[data-cattle-log-composer="1"] input[type="checkbox"]')).toBeChecked();
  await page.locator('[data-cattle-log-submit="1"]').click();

  await expect(page.getByText('Log entry submitted.')).toBeVisible({timeout: 10_000});
  const row = page.locator('[data-cattle-log-row]').filter({hasText: body});
  await expect(row).toBeVisible({timeout: 10_000});
  await expect(row).toContainText('Test Admin');
  // Composer resets after a successful submit.
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveValue('');

  // Canonical comments row + issue-state row (Issue default true).
  const {data: comments, error} = await supabaseAdmin
    .from('comments')
    .select('id, entity_type, entity_id, body, deleted_at')
    .eq('entity_type', 'cattle.log');
  expect(error).toBeNull();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({entity_type: 'cattle.log', entity_id: 'cattle-log', body, deleted_at: null});
  expect(comments[0].id.startsWith('cl-')).toBe(true);

  const {data: issueRow, error: issueErr} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .select('is_issue')
    .eq('comment_id', comments[0].id)
    .single();
  expect(issueErr).toBeNull();
  expect(issueRow.is_issue).toBe(true);

  // Row toggle reflects the issue state and the row id carries the mention
  // deep-link anchor.
  await expect(page.locator(`[data-cattle-log-issue-toggle="${comments[0].id}"]`)).toBeChecked();
  await expect(page.locator(`#comment-${comments[0].id}`)).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 2 — Issues default filter vs All
// --------------------------------------------------------------------------
test('filters: Issues is the default; non-issue entries only appear under All', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  const authed = await newAdminAuthedClient();
  await submitEntryViaRpc(authed, {id: mintEntryId('flt1'), body: 'Issue entry alpha', isIssue: true});
  await submitEntryViaRpc(authed, {id: mintEntryId('flt2'), body: 'Plain note bravo', isIssue: false});

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  // Default = Issues: only the is_issue entry shows.
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Issue entry alpha'})).toBeVisible();
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Plain note bravo'})).toHaveCount(0);

  await page.locator('[data-cattle-log-filter-all="1"]').click();
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Issue entry alpha'})).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Plain note bravo'})).toBeVisible();

  await page.locator('[data-cattle-log-filter-issues="1"]').click();
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Plain note bravo'})).toHaveCount(0, {
    timeout: 10_000,
  });
});

// --------------------------------------------------------------------------
// Test 3 — server-side search (body / author / exact #tag)
// --------------------------------------------------------------------------
test('search: body text, author name, and exact #tag (with or without #)', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  await seedCow(supabaseAdmin, {id: 'cow-srch-404', tag: '404', herd: 'finishers'});

  const authed = await newAdminAuthedClient();
  // Tagged entry (matched link on cow 404).
  await submitEntryViaRpc(authed, {id: mintEntryId('srch1'), body: 'Fence walk #404 complete'});
  // Plain admin entry.
  await submitEntryViaRpc(authed, {id: mintEntryId('srch2'), body: 'Mineral feeder refilled'});
  // Entry authored by the standing seeded farm_team profile 'Simon' — the
  // author-name search target. Direct service-role insert (author search only
  // cares about the row's author_profile_id).
  const {data: simonRows} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  if (!simonRows || simonRows.length === 0) throw new Error('profile "Simon" not found in TEST DB');
  const simonEntryId = mintEntryId('srch3');
  const {error: insErr} = await supabaseAdmin.from('comments').insert({
    id: simonEntryId,
    entity_type: 'cattle.log',
    entity_id: 'cattle-log',
    author_profile_id: simonRows[0].id,
    body: 'Gate latch fixed at the barn',
    mentions: [],
    attachments: [],
  });
  expect(insErr).toBeNull();
  const {error: issErr} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .insert({comment_id: simonEntryId, is_issue: true, last_set_by: adminId});
  expect(issErr).toBeNull();

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(3, {timeout: 10_000});

  const search = page.locator('[data-cattle-log-search="1"]');

  // Body search.
  await search.fill('Mineral feeder');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]')).toContainText('Mineral feeder refilled');

  // Author search (full_name ILIKE). Bodies deliberately avoid 'Simon'.
  await search.fill('Simon');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]')).toContainText('Gate latch fixed at the barn');

  // Tag search with '#'.
  await search.fill('#404');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]')).toContainText('Fence walk');

  // Tag search without '#': leading '#' is optional.
  await search.fill('404');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]')).toContainText('Fence walk');

  // Exact text match: '#0404' is a different tag from '#404' — no hit.
  await search.fill('#0404');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(0, {timeout: 10_000});
  await expect(page.getByText('No open issues.')).toBeVisible();

  // Clearing the search restores the full Issues list.
  await search.fill('');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(3, {timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 4 — keyset pagination (first 200 + Load more)
// --------------------------------------------------------------------------
test('pagination: first 200 newest-first, Load more reveals the rest and disappears', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(120_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);

  // 205 entries: direct service-role seed (the create path is covered by
  // Test 1; pagination only needs real rows). Distinct descending created_at
  // so the keyset cursor (created_at DESC, id DESC) walks deterministically.
  const TOTAL = 205;
  const base = Date.now();
  const commentRows = [];
  const issueRows = [];
  for (let i = 0; i < TOTAL; i++) {
    const id = `cl-page-${String(i).padStart(4, '0')}`;
    commentRows.push({
      id,
      entity_type: 'cattle.log',
      entity_id: 'cattle-log',
      author_profile_id: adminId,
      body: `Seed entry ${String(i).padStart(3, '0')}`,
      mentions: [],
      attachments: [],
      created_at: new Date(base - i * 1000).toISOString(),
    });
    issueRows.push({comment_id: id, is_issue: true, last_set_by: adminId});
  }
  for (let off = 0; off < TOTAL; off += 105) {
    const {error} = await supabaseAdmin.from('comments').insert(commentRows.slice(off, off + 105));
    expect(error).toBeNull();
  }
  for (let off = 0; off < TOTAL; off += 105) {
    const {error} = await supabaseAdmin.from('cattle_log_issue_state').insert(issueRows.slice(off, off + 105));
    expect(error).toBeNull();
  }

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(200, {timeout: 20_000});
  // Newest-first: entry 000 (latest created_at) is the first row.
  await expect(page.locator('[data-cattle-log-row]').first()).toContainText('Seed entry 000');

  const loadMore = page.locator('[data-cattle-log-load-more="1"]');
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(TOTAL, {timeout: 20_000});
  // Oldest entry surfaced by the second page; button gone (has_more=false).
  await expect(page.locator('[data-cattle-log-row]').last()).toContainText('Seed entry 204');
  await expect(loadMore).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 5 — edit/delete runtime paths + the generic-RPC originals guard
// --------------------------------------------------------------------------
// edit_cattle_log_entry: tag diff hard-deletes removed mirrors, resyncs the
// survivors, copies the ORIGINAL created_at onto late mirrors, and records
// the previous version in comment_edits. delete_cattle_log_entry soft-deletes
// the original and hard-deletes its mirrors. The generic edit_comment /
// delete_comment must REJECT 'cl-…' originals (entity_type guard) so authors
// cannot bypass tag re-diff / mirror resync or the management/admin delete
// contract.
test('edit/delete: mirrors follow the tag diff, delete soft-deletes; generic comment RPCs reject originals', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  await seedCow(supabaseAdmin, {id: 'cow-ed-801', tag: '801'});
  await seedCow(supabaseAdmin, {id: 'cow-ed-802', tag: '802', herd: 'backgrounders', sex: 'heifer'});
  await seedCow(supabaseAdmin, {id: 'cow-ed-803', tag: '803', herd: 'mommas', sex: 'cow'});

  const authed = await newAdminAuthedClient();
  const entryId = mintEntryId('edit1');
  const originalBody = 'Limping #801 and #802 near the gate';
  await submitEntryViaRpc(authed, {id: entryId, body: originalBody});

  const mirror801 = `clog-${entryId}--cow-ed-801`;
  const mirror802 = `clog-${entryId}--cow-ed-802`;
  const mirror803 = `clog-${entryId}--cow-ed-803`;
  for (const mid of [mirror801, mirror802]) {
    const {data, error} = await supabaseAdmin.from('comments').select('id').eq('id', mid);
    expect(error).toBeNull();
    expect(data, `mirror ${mid} landed`).toHaveLength(1);
  }

  // NEW originals guard: the generic comment RPCs refuse the live original
  // even for its own author (the strongest case — edit_comment is
  // author-only, delete_comment allows author or admin).
  const editAttempt = await authed.rpc('edit_comment', {
    p_comment_id: entryId,
    p_body: 'bypass attempt body',
    p_mentions: [],
    p_attachments: [],
  });
  expect(editAttempt.error, 'generic edit_comment must reject the original').toBeTruthy();
  expect(editAttempt.error.message).toContain('managed by the Cattle Log RPCs');

  const deleteAttempt = await authed.rpc('delete_comment', {p_comment_id: entryId});
  expect(deleteAttempt.error, 'generic delete_comment must reject the original').toBeTruthy();
  expect(deleteAttempt.error.message).toContain('managed by the Cattle Log RPCs');

  // Rejected attempts left the original untouched.
  const {data: untouched, error: untouchedErr} = await supabaseAdmin
    .from('comments')
    .select('body, edited_at, deleted_at, created_at')
    .eq('id', entryId)
    .single();
  expect(untouchedErr).toBeNull();
  expect(untouched).toMatchObject({body: originalBody, edited_at: null, deleted_at: null});

  // EDIT via the contract RPC: change body, drop #801, add #803, keep #802.
  // p_mentions is omitted on purpose: the NULL default must mean 'preserve
  // existing mentions' (and the RPC must accept the omission).
  const editedBody = 'Limping #802 near the gate, also check #803';
  const {error: editErr} = await authed.rpc('edit_cattle_log_entry', {
    p_id: entryId,
    p_body: editedBody,
    p_attachments: [],
    p_calf_notes: {},
  });
  expect(editErr).toBeNull();

  // Body updated, edited_at stamped, still live.
  const {data: afterEdit, error: afterEditErr} = await supabaseAdmin
    .from('comments')
    .select('body, edited_at, deleted_at, created_at')
    .eq('id', entryId)
    .single();
  expect(afterEditErr).toBeNull();
  expect(afterEdit.body).toBe(editedBody);
  expect(afterEdit.edited_at).toBeTruthy();
  expect(afterEdit.deleted_at).toBeNull();

  // Removed tag -> mirror hard-deleted; surviving mirror resynced to the new
  // body; the LATE mirror (#803, added by the edit) carries the ORIGINAL
  // entry's created_at, not the edit time ('mirrors show same time').
  const {data: gone801} = await supabaseAdmin.from('comments').select('id').eq('id', mirror801);
  expect(gone801, 'removed-tag mirror hard-deleted').toHaveLength(0);
  const {data: kept802} = await supabaseAdmin.from('comments').select('id, body').eq('id', mirror802);
  expect(kept802).toHaveLength(1);
  expect(kept802[0].body).toBe(editedBody);
  const {data: late803, error: late803Err} = await supabaseAdmin
    .from('comments')
    .select('id, body, created_at')
    .eq('id', mirror803)
    .single();
  expect(late803Err).toBeNull();
  expect(late803.body).toBe(editedBody);
  expect(new Date(late803.created_at).getTime()).toBe(new Date(afterEdit.created_at).getTime());

  // Previous version recorded in comment_edits.
  const {data: edits, error: editsErr} = await supabaseAdmin
    .from('comment_edits')
    .select('previous_body')
    .eq('comment_id', entryId);
  expect(editsErr).toBeNull();
  expect(edits).toHaveLength(1);
  expect(edits[0].previous_body).toBe(originalBody);

  // DELETE via the contract RPC (admin satisfies management/admin): original
  // soft-deleted, every remaining mirror hard-deleted.
  const {error: delErr} = await authed.rpc('delete_cattle_log_entry', {p_id: entryId});
  expect(delErr).toBeNull();

  const {data: afterDel, error: afterDelErr} = await supabaseAdmin
    .from('comments')
    .select('deleted_at, deleted_by')
    .eq('id', entryId)
    .single();
  expect(afterDelErr).toBeNull();
  expect(afterDel.deleted_at).toBeTruthy();
  expect(afterDel.deleted_by).toBeTruthy();

  for (const mid of [mirror802, mirror803]) {
    const {data} = await supabaseAdmin.from('comments').select('id').eq('id', mid);
    expect(data, `mirror ${mid} hard-deleted on entry delete`).toHaveLength(0);
  }
});
