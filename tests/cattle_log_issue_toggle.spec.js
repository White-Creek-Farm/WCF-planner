import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle Log — per-row Issue toggle (/cattle/log).
// ============================================================================
// set_cattle_log_issue is management/admin only and works in BOTH directions
// (clear and re-check). The checkbox renders for everyone but is disabled
// (visual state only) for light/farm_team.
//
//   1  Admin clears the flag (row leaves the default Issues filter, DB row
//      flips false) then re-checks it from the All filter (DB true again,
//      row back under Issues).
//   2  A real management login can toggle (server accepts the role).
//   3  farm_team (seeded 'Simon') sees the checkbox disabled.
//   4  light (DEV role override) sees the checkbox disabled.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

const MGMT_EMAIL = 'test-mgmt-cattle-log-toggle@wcfplanner.test';
const MGMT_PASSWORD = 'CattleLogToggleMgmt123!';

const LIGHT_EMAIL = 'test-light-cattle-log-toggle@wcfplanner.test';
const LIGHT_PASSWORD = 'CattleLogToggleLight123!';

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

async function ensureManagementUser(supabaseAdmin) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === MGMT_EMAIL);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: MGMT_EMAIL,
      password: MGMT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create mgmt user: ${created.error.message}`);
    user = created.data?.user;
  } else {
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password: MGMT_PASSWORD});
  }
  await supabaseAdmin
    .from('profiles')
    .upsert({id: user.id, email: MGMT_EMAIL, full_name: 'Mgmt Toggle User', role: 'management'}, {onConflict: 'id'});
  return user;
}

async function ensureLightUser(supabaseAdmin) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === LIGHT_EMAIL);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: LIGHT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create light user: ${created.error.message}`);
    user = created.data?.user;
  } else {
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password: LIGHT_PASSWORD});
  }
  await supabaseAdmin
    .from('profiles')
    .upsert({id: user.id, email: LIGHT_EMAIL, full_name: 'Light Toggle User', role: 'light'}, {onConflict: 'id'});
  return user;
}

async function signInViaLoginScreen(page, email, password) {
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

// DEV role override (whitelisted in main.jsx): admin session renders as the
// given role — used for the light disabled-state check.
async function setRoleOverride(page, role) {
  await page.addInitScript((r) => {
    if (r) window.localStorage.setItem('wcf-test-role-override', r);
    else window.localStorage.removeItem('wcf-test-role-override');
  }, role);
}

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

function mintEntryId(prefix) {
  return `cl-${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function seedEntry(authedSb, {id, body, isIssue = true}) {
  const {error} = await authedSb.rpc('submit_cattle_log_entry', {
    p_id: id,
    p_body: body,
    p_mentions: [],
    p_attachments: [],
    p_is_issue: isIssue,
    p_calf_notes: {},
  });
  if (error) throw new Error(`submit_cattle_log_entry(${id}): ${error.message}`);
}

async function readIssueState(supabaseAdmin, id) {
  const {data, error} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .select('is_issue, last_set_by, last_set_at')
    .eq('comment_id', id)
    .single();
  if (error) throw new Error(`read issue state(${id}): ${error.message}`);
  return data;
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

// --------------------------------------------------------------------------
// Test 1 — admin clears then re-checks (both directions)
// --------------------------------------------------------------------------
test('admin: uncheck clears the issue (row leaves Issues), re-check from All restores it', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  const entryId = mintEntryId('tgl1');
  const authed = await newAdminAuthedClient();
  await seedEntry(authed, {id: entryId, body: 'Loose wire on the east fence'});

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const toggle = page.locator(`[data-cattle-log-issue-toggle="${entryId}"]`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();

  // Clear: saves immediately; under the default Issues filter the row drops
  // out once the RPC confirms.
  await toggle.click();
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toHaveCount(0, {timeout: 10_000});
  await expect.poll(async () => (await readIssueState(supabaseAdmin, entryId)).is_issue, {timeout: 10_000}).toBe(false);

  // Re-check from All (both directions allowed: clear AND re-check).
  await page.locator('[data-cattle-log-filter-all="1"]').click();
  await waitForLogLoaded(page);
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toBeVisible({timeout: 10_000});
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect.poll(async () => (await readIssueState(supabaseAdmin, entryId)).is_issue, {timeout: 10_000}).toBe(true);

  // Back under Issues.
  await page.locator('[data-cattle-log-filter-issues="1"]').click();
  await waitForLogLoaded(page);
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toBeVisible({timeout: 10_000});
  await expect(toggle).toBeChecked();

  // Audit stamps on the state row.
  const state = await readIssueState(supabaseAdmin, entryId);
  expect(state.last_set_by).toBeTruthy();
  expect(state.last_set_at).toBeTruthy();
});

// --------------------------------------------------------------------------
// Test 2 — management can toggle (server-side role proof)
// --------------------------------------------------------------------------
test('management: toggle is enabled and the clear persists server-side', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  const mgmtUser = await ensureManagementUser(supabaseAdmin);

  const entryId = mintEntryId('tgl2');
  const authed = await newAdminAuthedClient();
  await seedEntry(authed, {id: entryId, body: 'Mineral tub empty in backgrounders'});

  await signInViaLoginScreen(page, MGMT_EMAIL, MGMT_PASSWORD);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const toggle = page.locator(`[data-cattle-log-issue-toggle="${entryId}"]`);
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.locator(`[data-cattle-log-row="${entryId}"]`)).toHaveCount(0, {timeout: 10_000});

  const state = await readIssueState(supabaseAdmin, entryId);
  expect(state.is_issue).toBe(false);
  expect(state.last_set_by).toBe(mgmtUser.id);
});

// --------------------------------------------------------------------------
// Test 3 — farm_team sees a disabled checkbox
// --------------------------------------------------------------------------
test('farm_team: issue checkbox renders disabled (visual state only)', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  const entryId = mintEntryId('tgl3');
  const authed = await newAdminAuthedClient();
  await seedEntry(authed, {id: entryId, body: 'Calf creep feeder gate sticking'});

  // Standing seeded farm_team account (scripts/apply_test_mig_052.cjs).
  await signInViaLoginScreen(page, 'simon.tasks@wcfplanner.test', 'apply_test_mig_052_placeholder_password');
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const toggle = page.locator(`[data-cattle-log-issue-toggle="${entryId}"]`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();

  // Server state untouched.
  const state = await readIssueState(supabaseAdmin, entryId);
  expect(state.is_issue).toBe(true);
});

// --------------------------------------------------------------------------
// Test 4 — light sees a disabled checkbox (DEV role override rendering)
// --------------------------------------------------------------------------
test('light: issue checkbox renders disabled', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  const entryId = mintEntryId('tgl4');
  const authed = await newAdminAuthedClient();
  await seedEntry(authed, {id: entryId, body: 'Water tank float valve stuck open'});

  await setRoleOverride(page, 'light');
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const toggle = page.locator(`[data-cattle-log-issue-toggle="${entryId}"]`);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
});

// --------------------------------------------------------------------------
// Test 5 — server-side negative proof: farm_team and light are REJECTED
// --------------------------------------------------------------------------
// Tests 3/4 prove the checkbox renders disabled; this proves the server gate
// itself: authed (non-service-role) farm_team and light clients calling
// set_cattle_log_issue directly must be refused, and the state row must stay
// untouched.
test('server rejects set_cattle_log_issue for farm_team and light (role-gate proof)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  await ensureLightUser(supabaseAdmin);

  const entryId = mintEntryId('tgl5');
  const authed = await newAdminAuthedClient();
  await seedEntry(authed, {id: entryId, body: 'Server-side toggle role-gate proof'});

  // farm_team: standing seeded 'Simon' account (scripts/apply_test_mig_052.cjs).
  const simon = newAnonClient();
  const {error: simonAuthErr} = await simon.auth.signInWithPassword({
    email: 'simon.tasks@wcfplanner.test',
    password: 'apply_test_mig_052_placeholder_password',
  });
  expect(simonAuthErr).toBeNull();
  const simonAttempt = await simon.rpc('set_cattle_log_issue', {p_id: entryId, p_is_issue: false});
  expect(simonAttempt.error, 'farm_team must be rejected').toBeTruthy();
  expect(simonAttempt.error.message).toContain('cannot toggle issue state');

  // light: dedicated auth user for this spec.
  const light = newAnonClient();
  const {error: lightAuthErr} = await light.auth.signInWithPassword({
    email: LIGHT_EMAIL,
    password: LIGHT_PASSWORD,
  });
  expect(lightAuthErr).toBeNull();
  const lightAttempt = await light.rpc('set_cattle_log_issue', {p_id: entryId, p_is_issue: false});
  expect(lightAttempt.error, 'light must be rejected').toBeTruthy();
  expect(lightAttempt.error.message).toContain('cannot toggle issue state');

  // Server state untouched by either attempt.
  const state = await readIssueState(supabaseAdmin, entryId);
  expect(state.is_issue).toBe(true);
});
