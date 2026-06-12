import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Log — Light + farm_team access (/cattle/log).
// ============================================================================
// A REAL Light auth user (not the admin storageState, not the DEV role
// override) logs in through the normal LoginScreen, so the list/submit RPC
// role checks actually run as 'light':
//
//   1  /dailys hub shows the 'Cattle Log' tile to Light; clicking it lands on
//      /cattle/log; the cattle subnav does NOT render for Light; Light can
//      submit an entry (server-side role proof).
//   2  Direct URL /cattle/log works for Light (no fail-closed portal bounce —
//      'cattlelog' is in LIGHT_ALLOWED_VIEWS).
//   3  farm_team (seeded 'Simon') sees the full cattle subnav including the
//      new 'Log' tab on /cattle/log.
// ============================================================================

// Fresh browser context — opt out of the global admin storageState so we
// drive genuine Light / farm_team logins.
test.use({storageState: {cookies: [], origins: []}});

const LIGHT_EMAIL = 'test-light-cattle-log@wcfplanner.test';
const LIGHT_PASSWORD = 'LightCattleLog123!';

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
    // Keep the password deterministic across re-runs.
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password: LIGHT_PASSWORD});
  }
  await supabaseAdmin
    .from('profiles')
    .upsert({id: user.id, email: LIGHT_EMAIL, full_name: 'Light Field User', role: 'light'}, {onConflict: 'id'});
  return user;
}

async function loginAsLight(page) {
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill(LIGHT_EMAIL);
  await page.getByPlaceholder('••••••••').fill(LIGHT_PASSWORD);
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

// Standing farm_team account seeded by scripts/apply_test_mig_052.cjs
// (profiles is never truncated). Same login dance as the tasks specs.
async function signInAsSimon(page) {
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
  await page.getByPlaceholder('your@email.com').first().fill('simon.tasks@wcfplanner.test');
  await page.getByPlaceholder('••••••••').fill('apply_test_mig_052_placeholder_password');
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';

// --------------------------------------------------------------------------
// Test 1 — Light: /dailys tile → /cattle/log; no cattle subnav; submit works
// --------------------------------------------------------------------------
test('light: Cattle Log tile on /dailys opens the log; no cattle subnav; light can submit', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await ensureLightUser(supabaseAdmin);
  await loginAsLight(page);

  // Contained Light portal renders on home.
  await expect(page.locator('[data-light-portal="1"]')).toBeVisible({timeout: 15_000});

  // The hub tile is visible to ALL roles including Light and navigates to
  // /cattle/log (navigation only — not a sub-form).
  await page.goto('/dailys');
  const tile = page.getByText('Cattle Log', {exact: true});
  await expect(tile).toBeVisible({timeout: 15_000});
  await tile.click();
  await expect(page).toHaveURL(/\/cattle\/log/, {timeout: 10_000});
  await waitForLogLoaded(page);

  // Light must NOT get the full cattle tab set — the cattle subnav is hidden
  // entirely for the light role.
  await expect(page.locator('[data-header-subnav="1"]')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Herds', exact: true})).toHaveCount(0);

  // Server-side role proof: 'light' is in the submit RPC's allowed set.
  const body = 'Salt block low in the mommas pasture';
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  await page.locator('[data-cattle-log-submit="1"]').click();
  await expect(page.getByText('Log entry submitted.')).toBeVisible({timeout: 10_000});
  const row = page.locator('[data-cattle-log-row]').filter({hasText: body});
  await expect(row).toBeVisible({timeout: 10_000});
  await expect(row).toContainText('Light Field User');

  // Light cannot toggle the issue state after submit (visual disabled state;
  // the deeper toggle coverage lives in cattle_log_issue_toggle.spec.js).
  await expect(row.locator('[data-cattle-log-issue-toggle]')).toBeDisabled();

  const {data: comments, error} = await supabaseAdmin
    .from('comments')
    .select('id, entity_type, entity_id')
    .eq('entity_type', 'cattle.log');
  expect(error).toBeNull();
  expect(comments).toHaveLength(1);
  expect(comments[0].entity_id).toBe('cattle-log');
});

// --------------------------------------------------------------------------
// Test 2 — Light: direct URL works (allowlisted view, no portal bounce)
// --------------------------------------------------------------------------
test('light: direct /cattle/log URL loads the log (no fail-closed bounce)', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await ensureLightUser(supabaseAdmin);
  await loginAsLight(page);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await expect(page).toHaveURL(/\/cattle\/log/);
  // Still no cattle subnav on direct entry.
  await expect(page.locator('[data-header-subnav="1"]')).toHaveCount(0);
  // The composer is available (view + add access).
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 3 — farm_team: full cattle subnav including the Log tab
// --------------------------------------------------------------------------
test('farm_team: cattle subnav renders with the Log tab active on /cattle/log', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await signInAsSimon(page);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  const subnav = page.locator('[data-header-subnav="1"]');
  await expect(subnav).toBeVisible({timeout: 10_000});
  const logTab = subnav.getByRole('button', {name: 'Log', exact: true});
  await expect(logTab).toBeVisible();
  await expect(logTab).toHaveAttribute('data-subnav-active', '1');
  // The rest of the cattle tab set stays available for farm_team.
  await expect(subnav.getByRole('button', {name: 'Herds', exact: true})).toBeVisible();
});
