import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle Log — @mention → notification → deep link (/cattle/log#comment-<id>).
// ============================================================================
// submit_cattle_log_entry fans out 'comment_mention' notifications (mig 071
// shape: comment_entity_type 'cattle.log', comment_entity_id 'cattle-log',
// comment_id = entry id). The Header bell resolves the route through the
// activityRegistry 'cattle.log' entry → '/cattle/log#comment-<id>', and the
// page scrolls the anchored row into view once content is up.
//
// Flow: a management author mentions the admin via the real RPC (node-side
// authed client), filler entries are stacked ABOVE the mention so the scroll
// is load-bearing, then the admin (default storageState) opens the bell and
// clicks the notification.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

const AUTHOR_EMAIL = 'test-mgmt-cattle-log-mention@wcfplanner.test';
const AUTHOR_PASSWORD = 'CattleLogMentionMgmt123!';
const AUTHOR_NAME = 'Mention Author Mgmt';

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
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

async function ensureMentionAuthor(supabaseAdmin) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === AUTHOR_EMAIL);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: AUTHOR_EMAIL,
      password: AUTHOR_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create mention author: ${created.error.message}`);
    user = created.data?.user;
  } else {
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password: AUTHOR_PASSWORD});
  }
  await supabaseAdmin
    .from('profiles')
    .upsert({id: user.id, email: AUTHOR_EMAIL, full_name: AUTHOR_NAME, role: 'management'}, {onConflict: 'id'});
  return user;
}

async function newAuthorAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({email: AUTHOR_EMAIL, password: AUTHOR_PASSWORD});
  if (error) throw new Error(`mention author signInWithPassword failed: ${error.message}`);
  return sb;
}

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

function mintEntryId(prefix) {
  return `cl-${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

test('mention notification deep-links to /cattle/log#comment-<id> and scrolls the row into view', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(90_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  const author = await ensureMentionAuthor(supabaseAdmin);

  // Mention entry first (older), via the REAL RPC so the notification fan-out
  // and issue-state row are genuine.
  const entryId = mintEntryId('mnt');
  const body = 'Loading chute latch needs a look before Thursday';
  const authorSb = await newAuthorAuthedClient();
  const {error: rpcError} = await authorSb.rpc('submit_cattle_log_entry', {
    p_id: entryId,
    p_body: body,
    p_mentions: [adminId],
    p_attachments: [],
    p_is_issue: true,
    p_calf_notes: {},
  });
  expect(rpcError).toBeNull();

  // 15 NEWER filler entries above the mention so the deep-link scroll has
  // real work to do (the target starts below the fold at 1280x800).
  const fillerComments = [];
  const fillerIssues = [];
  for (let i = 0; i < 15; i++) {
    const id = `cl-mntfill-${String(i).padStart(2, '0')}`;
    fillerComments.push({
      id,
      entity_type: 'cattle.log',
      entity_id: 'cattle-log',
      author_profile_id: author.id,
      body: `Routine pasture walk note ${String(i).padStart(2, '0')}`,
      mentions: [],
      attachments: [],
    });
    fillerIssues.push({comment_id: id, is_issue: true, last_set_by: author.id});
  }
  const {error: fillErr} = await supabaseAdmin.from('comments').insert(fillerComments);
  expect(fillErr).toBeNull();
  const {error: fillIssueErr} = await supabaseAdmin.from('cattle_log_issue_state').insert(fillerIssues);
  expect(fillIssueErr).toBeNull();

  // The notification row exists for the admin recipient.
  const {data: notifRows, error: notifErr} = await supabaseAdmin
    .from('notifications')
    .select('id, type, comment_entity_type, comment_entity_id, comment_id, recipient_profile_id')
    .eq('comment_id', entryId);
  expect(notifErr).toBeNull();
  expect(notifRows).toHaveLength(1);
  expect(notifRows[0]).toMatchObject({
    type: 'comment_mention',
    comment_entity_type: 'cattle.log',
    comment_entity_id: 'cattle-log',
    recipient_profile_id: adminId,
  });

  // Admin (default storageState) opens the bell.
  await page.goto('/');
  await page.locator('[data-notifications-header-link="1"]').click();
  await expect(page.locator('[data-notifications-panel-loaded="1"]')).toBeVisible({timeout: 15_000});

  const notifRow = page
    .locator('[data-notifications-row]')
    .filter({hasText: `${AUTHOR_NAME} mentioned you in a comment on Cattle Log`});
  await expect(notifRow).toBeVisible({timeout: 10_000});
  await notifRow.click();

  // Deep link: /cattle/log#comment-<entryId>.
  await expect(page).toHaveURL(new RegExp(`/cattle/log#comment-${entryId}`), {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});

  const target = page.locator(`#comment-${entryId}`);
  await expect(target).toBeVisible({timeout: 10_000});
  await expect(target).toContainText(body);
  // The anchored row was scrolled into the viewport (15 newer rows above it).
  await expect(target).toBeInViewport({timeout: 10_000});
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toBeVisible();
});
