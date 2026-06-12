import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Cattle Log — SCREENSHOT CAPTURE UTILITY (NOT a regression spec).
// ============================================================================
// Produces the 18 approval screenshots for the Cattle Log design review into
// cattle-log-shots/ at the repo root. Re-run on demand whenever the feature's
// look changes; the real behavioral coverage lives in the nine
// tests/cattle_log_*.spec.js suites.
//
//   Run alone (workers=1, shared TEST DB):
//     npx playwright test tests/cattle_log_screenshots.spec.js
//   (clear port 5173 first — reuseExistingServer is false by design)
//
// State strategy: a file-level beforeEach ALWAYS rebuilds the identical
// baseline before EVERY capture (resetDb + clear comments + upsert cows +
// re-submit the 7 log entries with mixed issue states, a #tag link, an
// @mention, and three authors: Test Admin / Simon / Morgan Hale). No capture
// depends on a previous capture having run, so the spec is idempotent and
// safely re-runnable — a worker restart after a failure can't strand later
// captures without their seed.
// ============================================================================

const SHOT_DIR = 'cattle-log-shots';
const DESKTOP = {width: 1366, height: 900};
const MOBILE = {width: 390, height: 844};

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';
const COMPOSER_FILE_INPUT = '[data-cattle-log-composer="1"] input[type="file"]';

const DB_NAME = 'wcf-offline-queue';

// Known-good 1x1 PNG that Chromium's createImageBitmap reliably decodes
// (same fixture as cattle_log_offline_attachments.spec.js).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tinyImageFile(name) {
  return {name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64')};
}

async function shot(page, name) {
  await page.screenshot({path: `${SHOT_DIR}/${name}.png`, fullPage: false});
}

// ── helpers copied from the passing cattle_log_*.spec.js suites ─────────────

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

// Authed (non-service-role) admin client so seeded entries run the real
// submit_cattle_log_entry path (role check, issue-state row, tag links,
// mirrors).
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

async function seedCow(supabaseAdmin, {id, tag, herd = 'finishers', sex = 'steer', oldTags = [], origin, breed}) {
  const {error} = await supabaseAdmin.from('cattle').upsert(
    {
      id,
      tag,
      herd,
      sex,
      old_tags: oldTags,
      origin: origin || null,
      breed: breed || null,
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error(`seedCow(${id}): ${error.message}`);
}

// Standing management profile for an author-variety row (same pattern as
// ensureManagementUser in cattle_log_issue_toggle.spec.js).
const MGMT_EMAIL = 'test-mgmt-cattle-log-shots@wcfplanner.test';
const MGMT_PASSWORD = 'CattleLogShotsMgmt123!';

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
    .upsert({id: user.id, email: MGMT_EMAIL, full_name: 'Morgan Hale', role: 'management'}, {onConflict: 'id'});
  return user;
}

// Real Light auth user (ensureLightUser pattern from
// cattle_log_light_access.spec.js).
const LIGHT_EMAIL = 'test-light-cattle-log-shots@wcfplanner.test';
const LIGHT_PASSWORD = 'LightCattleLogShots123!';

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

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

// IDB queue helpers (cattle_log_offline_queue.spec.js patterns). Clear stores
// through a normal connection — deleteDatabase would hang behind the app's
// open IDB connection.
async function wipeOfflineQueue(page) {
  await page.evaluate(
    async (dbName) =>
      new Promise((resolve) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          const names = Array.from(db.objectStoreNames);
          if (names.length === 0) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction(names, 'readwrite');
          for (const n of names) tx.objectStore(n).clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            resolve();
          };
        };
        req.onerror = () => resolve(); // DB may not exist yet — fine
      }),
    DB_NAME,
  );
}

async function readCattleLogQueue(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('submissions')) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction('submissions', 'readonly');
          const all = tx.objectStore('submissions').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.filter((r) => r.form_kind === 'cattle_log'));
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    DB_NAME,
  );
}

// Entry id of the #404 entry, refreshed by the beforeEach baseline below
// before EVERY capture (read by captures 11 and 14).
let tag404EntryId = null;

// ── Baseline seed — rebuilt from scratch before every capture ───────────────
// resetDb truncates cattle (tests/setup/reset.js whitelist), so tag #888 is
// guaranteed absent; clearCattleLogData wipes comments (tag links + issue
// state cascade off the hard delete). Cows carry origin 'WCF' / breed 'Wagyu'
// so the calf panel's Origin/Breed selects always have their expected options,
// and the AMB pair shares old-tag '9123' for the offline ambiguous capture (17).
async function seedBaseline({resetDb, supabaseAdmin}) {
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  const adminId = await seedAdminProfile(supabaseAdmin);
  const mgmtUser = await ensureManagementUser(supabaseAdmin);

  // Active cattle so #tags resolve and the calf panel's origin/breed selects
  // have options.
  await seedCow(supabaseAdmin, {
    id: 'cow-shot-404',
    tag: '404',
    herd: 'finishers',
    sex: 'steer',
    origin: 'WCF',
    breed: 'Wagyu',
  });
  await seedCow(supabaseAdmin, {
    id: 'cow-shot-712',
    tag: '712',
    herd: 'mommas',
    sex: 'cow',
    origin: 'WCF',
    breed: 'Wagyu',
  });
  await seedCow(supabaseAdmin, {
    id: 'cow-shot-500',
    tag: '500',
    herd: 'mommas',
    sex: 'cow',
    origin: 'WCF',
    breed: 'Wagyu',
  });
  await seedCow(supabaseAdmin, {
    id: 'cow-shot-amb-a',
    tag: 'AMB-A',
    herd: 'backgrounders',
    sex: 'steer',
    oldTags: [{tag: '9123', source: 'manual'}],
  });
  await seedCow(supabaseAdmin, {
    id: 'cow-shot-amb-b',
    tag: 'AMB-B',
    herd: 'backgrounders',
    sex: 'steer',
    oldTags: [{tag: '9123', source: 'manual'}],
  });

  // Standing seeded farm_team profile 'Simon' (scripts/apply_test_mig_052.cjs;
  // profiles is never truncated) — author + @mention target.
  const {data: simonRows} = await supabaseAdmin.from('profiles').select('id').ilike('full_name', 'Simon').limit(1);
  if (!simonRows || simonRows.length === 0) throw new Error('profile "Simon" not found in TEST DB');
  const simonId = simonRows[0].id;

  // ── Real-RPC entries (admin author; tag links + mirrors are server-made) ──
  const authed = await newAdminAuthedClient();
  await submitEntryViaRpc(authed, {
    id: mintEntryId('shot1'),
    body: 'Rotated the finishers to the east paddock — grass is holding up well',
    isIssue: false,
  });
  await submitEntryViaRpc(authed, {
    id: mintEntryId('shot2'),
    body: '@Simon please double-check the water pressure at the north trough before evening feed',
    mentions: [simonId],
    isIssue: true,
  });
  tag404EntryId = mintEntryId('shot3');
  await submitEntryViaRpc(authed, {
    id: tag404EntryId,
    body: 'Limping on the back left #404 after this morning’s move — keep her up front this week',
    isIssue: true,
  });
  await submitEntryViaRpc(authed, {
    id: mintEntryId('shot4'),
    body: '#712 swollen left eye, started treatment today — will recheck tomorrow',
    isIssue: true,
  });

  // ── Direct service-role inserts for author variety (Simon / Morgan).
  //    Display only cares about author_profile_id; same pattern as the
  //    author-search seed in cattle_log_basic.spec.js. ──
  const directRows = [
    {
      id: mintEntryId('shot5'),
      author: simonId,
      body: 'Gate latch on the working pens is bent — needs a new bolt before Saturday',
      isIssue: true,
      hoursAgo: 3,
    },
    {
      id: mintEntryId('shot6'),
      author: mgmtUser.id,
      body: 'Vet confirmed for Thursday preg checks on the mommas — have them penned by 8am',
      isIssue: true,
      hoursAgo: 8,
    },
    {
      id: mintEntryId('shot7'),
      author: simonId,
      body: 'Mineral feeders topped off in both pastures',
      isIssue: false,
      hoursAgo: 26,
    },
  ];
  for (const r of directRows) {
    const {error: insErr} = await supabaseAdmin.from('comments').insert({
      id: r.id,
      entity_type: 'cattle.log',
      entity_id: 'cattle-log',
      author_profile_id: r.author,
      body: r.body,
      mentions: [],
      attachments: [],
      created_at: new Date(Date.now() - r.hoursAgo * 3600 * 1000).toISOString(),
    });
    if (insErr) throw new Error(`seed direct entry: ${insErr.message}`);
    const {error: issErr} = await supabaseAdmin
      .from('cattle_log_issue_state')
      .insert({comment_id: r.id, is_issue: r.isIssue, last_set_by: adminId});
    if (issErr) throw new Error(`seed issue state: ${issErr.message}`);
  }
}

// ALWAYS runs fully before every capture (including the light-user describe)
// so each test gets the same deterministic state regardless of what ran — or
// failed — before it. The single timeout here covers seed + capture body for
// every test; no per-test setTimeout overrides.
test.beforeEach(async ({resetDb, supabaseAdmin}) => {
  test.setTimeout(240_000);
  await seedBaseline({resetDb, supabaseAdmin});
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 1 — admin desktop states (01, 02, 04, 05, 06, 07, 08, 11)
// ════════════════════════════════════════════════════════════════════════════
test('captures 01/02/04/05/06/07/08/11 — admin desktop: nav, hub tile, filters, search, composer', async ({page}) => {
  // ── 01: cattle subnav with the Log tab active ──
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  const subnav = page.locator('[data-header-subnav="1"]');
  await expect(subnav).toBeVisible({timeout: 10_000});
  const logTab = subnav.getByRole('button', {name: 'Log', exact: true});
  await expect(logTab).toHaveAttribute('data-subnav-active', '1');
  await expect(page.locator('[data-cattle-log-row]').first()).toBeVisible({timeout: 10_000});
  await shot(page, '01-cattle-nav-log-tab');

  // ── 04: default landing — Issues filter active, issue rows showing ──
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(5, {timeout: 10_000});
  // Scroll a touch so the list card fills the frame (distinguishes 04 from 01).
  await page.evaluate(() => window.scrollTo(0, 240));
  await shot(page, '04-issues-default-view');
  await page.evaluate(() => window.scrollTo(0, 0));

  // ── 05: All filter — issue + non-issue rows together ──
  await page.locator('[data-cattle-log-filter-all="1"]').click();
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(7, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]').filter({hasText: 'Mineral feeders topped off'})).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 240));
  await shot(page, '05-all-view');
  await page.evaluate(() => window.scrollTo(0, 0));

  // ── 11: enabled Issue checkboxes (admin) with one row hovered/focused ──
  const tag404Row = page.locator(`[data-cattle-log-row="${tag404EntryId}"]`);
  await tag404Row.hover();
  const toggle = page.locator(`[data-cattle-log-issue-toggle="${tag404EntryId}"]`);
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await page.evaluate(() => window.scrollTo(0, 240));
  await shot(page, '11-issue-toggle');
  await page.evaluate(() => window.scrollTo(0, 0));

  // ── 06: search — tag number without '#' filters server-side ──
  await page.locator('[data-cattle-log-filter-issues="1"]').click();
  await waitForLogLoaded(page);
  const search = page.locator('[data-cattle-log-search="1"]');
  await search.fill('404');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(1, {timeout: 10_000});
  await expect(page.locator('[data-cattle-log-row]')).toContainText('Limping on the back left');
  await shot(page, '06-search-results');
  await search.fill('');
  await expect(page.locator('[data-cattle-log-row]')).toHaveCount(5, {timeout: 10_000});

  // ── 07: composer with text typed, paper-airplane submit visible ──
  await page
    .locator(COMPOSER_TEXTAREA)
    .fill('Checked all the water lines after last night’s freeze — everything flowing again');
  await expect(page.locator('[data-cattle-log-submit="1"]')).toBeEnabled();
  await shot(page, '07-composer-paper-airplane');

  // ── 08: composer with two image attachments staged ──
  await page.locator(COMPOSER_FILE_INPUT).setInputFiles([tinyImageFile('trough.png'), tinyImageFile('fence.png')]);
  await expect(page.getByText('2 photos selected')).toBeVisible({timeout: 10_000});
  await shot(page, '08-composer-attachment');

  // ── 02: /dailys hub — the green Cattle Log tile ──
  await page.goto('/dailys');
  const tile = page.locator('[data-tile="cattle-log"]');
  await expect(tile).toBeVisible({timeout: 20_000});
  await tile.scrollIntoViewIfNeeded();
  await shot(page, '02-webforms-cattle-log-tile');
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 2 — calf-note panel + unresolved row (09, 10)
// ════════════════════════════════════════════════════════════════════════════
test('captures 09/10 — unmatched #888: calf panel, then submitted unresolved row', async ({page}) => {
  // beforeEach baseline: cattle truncated + re-upserted (WCF/Wagyu origins for
  // the panel selects), and #888 is guaranteed to match no active cow.
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);

  await page.locator(COMPOSER_TEXTAREA).fill('New calf #888 found with momma 500 this morning, up and nursing');
  await expect(page.getByText('#888 — no active cow (calf details below)')).toBeVisible({timeout: 15_000});
  const panel = page.locator('[data-cattle-log-calf-panel="888"]');
  await expect(panel).toBeVisible();

  // Partially fill: herd + DOB(est) + sex, leave Origin empty so the
  // "Complete calf details" block and the disabled submit are honest.
  await panel.locator('select').nth(0).selectOption('mommas');
  await panel.locator('input[type="date"]').fill('2026-06-10');
  await panel.locator('select').nth(1).selectOption('heifer');
  await panel.getByPlaceholder("Momma's tag").fill('500');

  // Issue checkbox forced + disabled while an unmatched tag exists.
  const issueBox = page.locator('[data-cattle-log-composer="1"]').getByRole('checkbox', {name: /^Issue/});
  await expect(issueBox).toBeChecked();
  await expect(issueBox).toBeDisabled();
  await expect(page.getByText('(required for unknown tags)')).toBeVisible();
  await expect(page.locator('[data-cattle-log-submit="1"]')).toBeDisabled();
  await shot(page, '09-calf-note-panel');

  // ── 10: complete + submit → unresolved-tag system note in the list ──
  await panel.locator('select').nth(2).selectOption('WCF');
  await panel.locator('select').nth(3).selectOption('Wagyu');
  await panel.getByPlaceholder('Anything else').fill('Born overnight');
  const submit = page.locator('[data-cattle-log-submit="1"]');
  await expect(submit).toBeEnabled({timeout: 10_000});
  await submit.click();
  await expect(page.getByText('Log entry submitted.')).toBeVisible({timeout: 10_000});

  const row = page.locator('[data-cattle-log-row]').filter({hasText: 'New calf'});
  await expect(row).toBeVisible({timeout: 10_000});
  const note = row.locator('[data-cattle-log-unresolved-note="1"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('#888');
  await row.scrollIntoViewIfNeeded();
  await shot(page, '10-unresolved-issue-row');
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 3 — cow record mirror with the From Cattle Log chip (14)
// ════════════════════════════════════════════════════════════════════════════
test('capture 14 — cow record page shows the mirrored comment with provenance', async ({page, supabaseAdmin}) => {
  // tag404EntryId is always fresh — the beforeEach baseline re-submitted the
  // #404 entry via the real RPC just before this test.
  const mirrorId = `clog-${tag404EntryId}--cow-shot-404`;

  // The mirror is created server-side by the submit RPC; confirm it landed.
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin.from('comments').select('id').eq('id', mirrorId);
        return data && data.length === 1;
      },
      {timeout: 10_000},
    )
    .toBe(true);

  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/herds/cow-shot-404');
  await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});
  const mirrorRow = page.locator(`[data-comment-id="${mirrorId}"]`);
  await expect(mirrorRow).toBeVisible({timeout: 10_000});
  await expect(mirrorRow).toContainText('From Cattle Log');
  await mirrorRow.scrollIntoViewIfNeeded();
  await shot(page, '14-cow-record-mirror');
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 4 — How to use modal, management view (13)
// ════════════════════════════════════════════════════════════════════════════
test('capture 13 — How to use modal as admin (manager issue-clearing section)', async ({page}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await page.locator('[data-cattle-log-howto="1"]').click();
  const modal = page.locator('[data-cattle-log-howto-modal="1"]');
  await expect(modal).toBeVisible({timeout: 10_000});
  const managerCallout = page.locator('[data-cattle-log-howto-manager="1"]');
  await expect(managerCallout).toBeVisible();
  await managerCallout.scrollIntoViewIfNeeded();
  await shot(page, '13-howto-management');
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 5 — real Light login: no cattle subnav (03) + normal how-to (12)
// ════════════════════════════════════════════════════════════════════════════
test.describe('light user captures', () => {
  // Fresh browser context — opt out of the global admin storageState so we
  // drive a genuine Light login (ensureLightUser pattern).
  test.use({storageState: {cookies: [], origins: []}});

  test('captures 03/12 — light: page without cattle subnav, how-to without manager section', async ({
    page,
    supabaseAdmin,
  }) => {
    await ensureLightUser(supabaseAdmin);
    await loginAsLight(page);

    await page.setViewportSize(DESKTOP);
    await page.goto('/cattle/log');
    await waitForLogLoaded(page);
    // Light must NOT get the cattle subnav strip.
    await expect(page.locator('[data-header-subnav="1"]')).toHaveCount(0);
    await expect(page.locator('[data-cattle-log-row]').first()).toBeVisible({timeout: 10_000});
    await shot(page, '03-light-no-cattle-nav');

    // ── 12: How to use without the manager callout ──
    await page.locator('[data-cattle-log-howto="1"]').click();
    const modal = page.locator('[data-cattle-log-howto-modal="1"]');
    await expect(modal).toBeVisible({timeout: 10_000});
    await expect(page.locator('[data-cattle-log-howto-manager="1"]')).toHaveCount(0);
    await modal.getByRole('button', {name: 'Got it'}).scrollIntoViewIfNeeded();
    await shot(page, '12-howto-normal-user');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 6 — mobile stacked layout (15)
// ════════════════════════════════════════════════════════════════════════════
test('capture 15 — mobile 390x844: stacked card rows + composer', async ({page}) => {
  await page.setViewportSize(MOBILE);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-row]').first()).toBeVisible({timeout: 10_000});
  // Full page so composer AND the stacked rows below it are both in frame.
  await page.screenshot({path: `${SHOT_DIR}/15-mobile-stacked.png`, fullPage: true});
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 7 — offline queued row (16)
// ════════════════════════════════════════════════════════════════════════════
test('capture 16 — offline submit renders a QUEUED row at the top of the list', async ({page, context}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  await context.setOffline(true);
  await expect(page.getByText('You appear to be offline.', {exact: false})).toBeVisible({timeout: 10_000});
  await page.locator(COMPOSER_TEXTAREA).fill('Water trough cracked in pen 3 — patched it for now, needs a new tank');
  await page.locator('[data-cattle-log-submit="1"]').click();
  const queuedRow = page.locator('[data-cattle-log-queued-row]');
  await expect(queuedRow).toBeVisible({timeout: 10_000});
  await expect(queuedRow).toContainText('QUEUED');
  await shot(page, '16-offline-queued-row');

  // Reconnect and let the queue drain so this entry becomes a real row and
  // the IDB queue is empty for the next captures.
  await context.setOffline(false);
  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 30_000}).toBe(0);
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 8 — offline needs-attention row with Retry/Discard (17)
// ════════════════════════════════════════════════════════════════════════════
test('capture 17 — ambiguous-tag replay flips the queued row to NEEDS ATTENTION', async ({page, context}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  // Offline submits skip the client preview gate; '9123' matches BOTH
  // AMB cows' old_tags on the server → CATTLE_LOG_AMBIGUOUS_TAG on replay.
  await context.setOffline(true);
  await page.locator(COMPOSER_TEXTAREA).fill('Check the swollen eye on #9123 before evening feed');
  await page.locator('[data-cattle-log-submit="1"]').click();
  await expect(page.locator('[data-cattle-log-queued-row]')).toBeVisible({timeout: 10_000});

  const queued = await readCattleLogQueue(page);
  if (queued.length !== 1) throw new Error(`expected 1 queued row, got ${queued.length}`);
  const csid = queued[0].csid;

  await context.setOffline(false);
  const attentionRow = page.locator(`[data-cattle-log-needs-attention-row="${csid}"]`);
  await expect(attentionRow).toBeVisible({timeout: 20_000});
  await expect(attentionRow).toContainText('NEEDS ATTENTION');
  // Field-facing copy — the row shows the QUEUE_ERROR_LABELS label + the
  // friendlyLogError message, never the raw 'ambiguous_tag' /
  // 'CATTLE_LOG_AMBIGUOUS_TAG:' classifier strings.
  await expect(attentionRow).toContainText('Tag matches multiple animals');
  await expect(attentionRow.locator(`[data-cattle-log-queue-retry="${csid}"]`)).toBeVisible();
  await expect(attentionRow.locator(`[data-cattle-log-queue-discard="${csid}"]`)).toBeVisible();
  await shot(page, '17-offline-needs-attention');

  // Discard (operator-resolved dead letter) so nothing bleeds forward.
  await page.locator(`[data-cattle-log-queue-discard="${csid}"]`).click();
  await expect(page.locator(`[data-cattle-log-needs-attention-row="${csid}"]`)).toHaveCount(0, {timeout: 10_000});
});

// ════════════════════════════════════════════════════════════════════════════
// Capture 9 — offline-queued entry that includes an attachment (18)
// ════════════════════════════════════════════════════════════════════════════
// NOTE: the queued-row UI shows only the QUEUED badge + body (no attachment
// indicator exists in the product). Closest honest state: the attachment is
// staged + queued (visible in the IDB payload, asserted below) and the body
// says a photo is attached. Reported in the capture manifest as a deviation.
test('capture 18 — offline-queued entry carrying an attachment', async ({page, context}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  await context.setOffline(true);
  await expect(page.getByText('You appear to be offline.', {exact: false})).toBeVisible({timeout: 10_000});
  await page.locator(COMPOSER_FILE_INPUT).setInputFiles([tinyImageFile('flank.png')]);
  await expect(page.getByText('1 photo selected')).toBeVisible({timeout: 10_000});
  await page.locator(COMPOSER_TEXTAREA).fill('Fresh scrape on the flank of #712 — photo attached');
  await page.locator('[data-cattle-log-submit="1"]').click();

  const queuedRow = page.locator('[data-cattle-log-queued-row]');
  await expect(queuedRow).toBeVisible({timeout: 10_000});
  await expect(queuedRow).toContainText('QUEUED');
  // Prove the queued payload really carries the attachment meta.
  const queue = await readCattleLogQueue(page);
  if (queue.length !== 1) throw new Error(`expected 1 queued row, got ${queue.length}`);
  const metas = (queue[0].payload && queue[0].payload.attachments) || [];
  if (metas.length !== 1) throw new Error('queued payload is missing the attachment meta');
  await shot(page, '18-offline-attachment-queued');
  // Stay offline — end of the run; nothing replays or uploads.
});
