import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle Log — #tag mirrors on cow record pages.
// ============================================================================
// A matched '#<digits>' tag in a log entry creates a REAL comments row on the
// cow's record ('cattle.animal' / cattle.id) with the deterministic id
// 'clog-<entryId>--<cattleId>'. The cow page's CommentsSection renders the
// mirror with a 'From Cattle Log' provenance chip (link to /cattle/log) and
// NEVER shows edit/delete actions on it — mirrors are managed exclusively by
// the Cattle Log RPCs. Mirrors never appear on the log page itself.
//
//   1  Single tag: submit '#701' entry → mirror on cow 701's page, provenance
//      chip routes back to /cattle/log, no Edit/Delete even for the author.
//   2  Multi-tag: one entry tagging two cows mirrors onto BOTH cow pages;
//      the log page still shows exactly one row.
//   3  Server-side mirror guard: the generic edit_comment/delete_comment RPCs
//      reject the MIRROR id even for the entry author; the mirror row is
//      unchanged after the attempts.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

// Authed (non-service-role) admin client so the entry runs the real
// submit_cattle_log_entry path and the guard attempts run as the AUTHOR.
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

function mintEntryId(prefix) {
  return `cl-${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

async function seedCow(supabaseAdmin, {id, tag, herd = 'finishers', sex = 'steer'}) {
  const {error} = await supabaseAdmin.from('cattle').upsert(
    {
      id,
      tag,
      herd,
      sex,
      old_tags: [],
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

// Submit a log entry through the page composer, waiting for the matched-tag
// preview chips first (the tag gate blocks submit until the active-cattle
// preview list is loaded).
async function submitViaComposer(page, body, matchedTags) {
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  for (const tag of matchedTags) {
    await expect(page.getByText(`#${tag} →`)).toBeVisible({timeout: 15_000});
  }
  await page.locator('[data-cattle-log-submit="1"]').click();
  await expect(page.getByText('Log entry submitted.')).toBeVisible({timeout: 10_000});
}

async function loadLogEntryId(supabaseAdmin) {
  const {data, error} = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('entity_type', 'cattle.log')
    .eq('entity_id', 'cattle-log');
  if (error) throw new Error('load entry id: ' + error.message);
  if (!data || data.length !== 1) throw new Error(`expected exactly 1 cattle.log entry, got ${data ? data.length : 0}`);
  return data[0].id;
}

// --------------------------------------------------------------------------
// Test 1 — single-tag mirror + provenance chip + no edit/delete
// --------------------------------------------------------------------------
test('#tag entry mirrors onto the cow page with From Cattle Log and no edit/delete', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedCow(supabaseAdmin, {id: 'cow-mir-701', tag: '701'});

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const body = 'Limping on the back left #701 after the move';
  await submitViaComposer(page, body, ['701']);

  const entryId = await loadLogEntryId(supabaseAdmin);
  const mirrorId = `clog-${entryId}--cow-mir-701`;

  // Mirror is a real comments row on the cow entity with the same body.
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin
          .from('comments')
          .select('id, entity_type, entity_id, body')
          .eq('id', mirrorId);
        return data && data.length === 1 ? data[0] : null;
      },
      {timeout: 10_000},
    )
    .toMatchObject({entity_type: 'cattle.animal', entity_id: 'cow-mir-701', body});

  // Link row records the mirror.
  const {data: links, error: linkErr} = await supabaseAdmin
    .from('cattle_log_tag_links')
    .select('tag, cattle_id, mirror_comment_id')
    .eq('comment_id', entryId);
  expect(linkErr).toBeNull();
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({tag: '701', cattle_id: 'cow-mir-701', mirror_comment_id: mirrorId});

  // Cow record page shows the mirror with provenance and no actions. The
  // signed-in admin IS the mirror's author — the strongest no-edit/delete
  // case (CommentsSection would normally offer both to the author).
  await page.goto('/cattle/herds/cow-mir-701');
  await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});

  const mirrorRow = page.locator(`[data-comment-id="${mirrorId}"]`);
  await expect(mirrorRow).toBeVisible({timeout: 10_000});
  await expect(mirrorRow).toContainText('Limping on the back left');
  await expect(mirrorRow).toContainText('From Cattle Log');
  await expect(mirrorRow.getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0);
  await expect(mirrorRow.getByRole('button', {name: 'Delete', exact: true})).toHaveCount(0);

  // Provenance chip routes back to the log page.
  await mirrorRow.getByText('From Cattle Log').click();
  await expect(page).toHaveURL(/\/cattle\/log/, {timeout: 10_000});
  await waitForLogLoaded(page);
});

// --------------------------------------------------------------------------
// Test 2 — multi-tag mirrors on every tagged cow; log shows one row
// --------------------------------------------------------------------------
test('multi-tag entry mirrors onto each cow page; the log page shows a single original row', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedCow(supabaseAdmin, {id: 'cow-mir-701', tag: '701'});
  await seedCow(supabaseAdmin, {id: 'cow-mir-702', tag: '702', herd: 'backgrounders', sex: 'heifer'});

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const body = '#701 and #702 both drinking from the cracked trough';
  await submitViaComposer(page, body, ['701', '702']);

  const entryId = await loadLogEntryId(supabaseAdmin);

  // One mirror per tagged cow.
  for (const cowId of ['cow-mir-701', 'cow-mir-702']) {
    const mirrorId = `clog-${entryId}--${cowId}`;
    await expect
      .poll(
        async () => {
          const {data} = await supabaseAdmin.from('comments').select('id, entity_id').eq('id', mirrorId);
          return data && data.length === 1 ? data[0].entity_id : null;
        },
        {timeout: 10_000},
      )
      .toBe(cowId);
  }

  // The log page renders ONLY the original (mirrors live on cow pages).
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1);
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toBeVisible();

  // Both cow pages render their mirror with provenance.
  for (const cowId of ['cow-mir-701', 'cow-mir-702']) {
    await page.goto('/cattle/herds/' + cowId);
    await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});
    const mirrorRow = page.locator(`[data-comment-id="clog-${entryId}--${cowId}"]`);
    await expect(mirrorRow).toBeVisible({timeout: 10_000});
    await expect(mirrorRow).toContainText('cracked trough');
    await expect(mirrorRow).toContainText('From Cattle Log');
  }
});

// --------------------------------------------------------------------------
// Test 3 — server-side mirror guard on the generic comment RPCs
// --------------------------------------------------------------------------
// Test 1 proves the UI hides Edit/Delete on mirrors; this proves the server
// guard itself: the entry AUTHOR (the strongest case — generic edit_comment
// is author-only, delete_comment allows author or admin) calling the generic
// RPCs against the MIRROR id must be refused, and a service-role read shows
// the mirror row unchanged.
test('generic edit_comment/delete_comment reject the mirror id and leave the mirror untouched', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  await seedCow(supabaseAdmin, {id: 'cow-mir-703', tag: '703'});

  const authed = await newAdminAuthedClient();
  const entryId = mintEntryId('mirg');
  const body = 'Swollen eye on #703, flagging for treatment';
  const {error: subErr} = await authed.rpc('submit_cattle_log_entry', {
    p_id: entryId,
    p_body: body,
    p_mentions: [],
    p_attachments: [],
    p_is_issue: true,
    p_calf_notes: {},
  });
  expect(subErr).toBeNull();

  const mirrorId = `clog-${entryId}--cow-mir-703`;
  const before = await supabaseAdmin
    .from('comments')
    .select('id, entity_type, entity_id, author_profile_id, body, edited_at, deleted_at, created_at')
    .eq('id', mirrorId)
    .single();
  expect(before.error).toBeNull();
  expect(before.data).toMatchObject({entity_type: 'cattle.animal', entity_id: 'cow-mir-703', body, deleted_at: null});

  const editAttempt = await authed.rpc('edit_comment', {
    p_comment_id: mirrorId,
    p_body: 'mirror tamper attempt',
    p_mentions: [],
    p_attachments: [],
  });
  expect(editAttempt.error, 'edit_comment must reject the mirror').toBeTruthy();
  expect(editAttempt.error.message).toContain('cattle log mirrors are managed by the Cattle Log RPCs');

  const deleteAttempt = await authed.rpc('delete_comment', {p_comment_id: mirrorId});
  expect(deleteAttempt.error, 'delete_comment must reject the mirror').toBeTruthy();
  expect(deleteAttempt.error.message).toContain('cattle log mirrors are managed by the Cattle Log RPCs');

  // Service-role read: the mirror row is unchanged after both attempts.
  const after = await supabaseAdmin
    .from('comments')
    .select('id, entity_type, entity_id, author_profile_id, body, edited_at, deleted_at, created_at')
    .eq('id', mirrorId)
    .single();
  expect(after.error).toBeNull();
  expect(after.data).toEqual(before.data);
});
