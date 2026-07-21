import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Initiative C Phase 1D-B — WebformHub daily-report photo offline queue
// ============================================================================
// Drives /webforms/<broiler|pig|cattle|sheep> through the new hook-routed
// single-row photo paths. Layer + egg are NEGATIVE-locked: they must not
// touch the offline queue / daily-photos storage.
//
// Coverage matrix (10 tests):
//
//   1  broiler online happy + STARTER feed → row + 2 storage objects +
//        rapid-processor (starter_feed_check email) called
//   2  pig online happy → row + 2 storage objects
//   3  cattle online happy → row with source='daily_webform' + 2 storage objects
//   4  sheep online happy → row with source='daily_webform' + 2 storage objects
//   5  cattle offline → state='queued' + atomic IDB shape + recovery on reload
//   6  broiler email negative lock — STARTER offline → state='queued' AND
//        no rapid-processor request fired (Codex amendment 3)
//   7  storage 403 stuck — sheep submit hits 403 → state='stuck', stuck modal
//        opens with "Sheep · …" describeRow
//   8  aggregated modal dispatch — drive cattle 403 stuck + sheep 403 stuck
//        in same browser context; modal lists both; discard cattle row;
//        sheep row stays. (Codex amendment 2: real submit flows, NOT
//        service-role IDB pre-seed.)
//   9  negative lock — broiler photos + Add-Group rejected (existing copy
//        preserved; no IDB write; no storage upload)
//   10 negative lock — egg submit issues NO daily-photos requests AND no
//        IDB writes (egg permanently excluded from 1D-B)
//
// Runs authenticated (default admin storageState) — the WebformHub daily forms
// lock the submitter to the signed-in user, so /webforms/<slug> is
// login-required and an anonymous context lands on the LoginScreen. The
// offline-queue behavior under test is identical when authed; per-test fresh
// browser storage still wipes IDB. WebformHub mounts at /webforms.
//
// Daily-photos RLS (resolved): the daily-photos storage bucket previously
// lacked a `FOR INSERT TO authenticated` policy (migration 031 granted anon
// INSERT only), unlike every other private bucket the authenticated app writes
// to. Once these forms became login-required, authenticated photo uploads 403'd
// with "new row violates row-level security policy". Migration 099
// (`daily_photos_auth_insert FOR INSERT TO authenticated`) added the missing
// policy, so the authenticated photo webforms now upload correctly and the
// online-happy + recovery-replay tests (1-5) run.
// ============================================================================

const DB_NAME = 'wcf-offline-queue';
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tinyImageFile(name) {
  return {name, mimeType: 'image/png', buffer: Buffer.from(PNG_1x1_BASE64, 'base64')};
}

async function readQueue(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error('readQueue: never fired')), 5000);
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          clearTimeout(watchdog);
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
            resolve(all.result);
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        };
        req.onerror = () => {
          clearTimeout(watchdog);
          reject(req.error);
        };
        req.onblocked = () => {
          clearTimeout(watchdog);
          reject(new Error('onblocked'));
        };
      }),
    DB_NAME,
  );
}

async function readPhotoBlobs(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error('readPhotoBlobs: never fired')), 5000);
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          clearTimeout(watchdog);
          const db = req.result;
          if (!db.objectStoreNames.contains('photo_blobs')) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction('photo_blobs', 'readonly');
          const all = tx.objectStore('photo_blobs').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(
              all.result.map((r) => ({
                key: r.key,
                csid: r.csid,
                form_kind: r.form_kind,
                photo_key: r.photo_key,
              })),
            );
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        };
        req.onerror = () => {
          clearTimeout(watchdog);
          reject(req.error);
        };
        req.onblocked = () => {
          clearTimeout(watchdog);
          reject(new Error('onblocked'));
        };
      }),
    DB_NAME,
  );
}

async function gotoForm(page, slug) {
  await page.goto(`/webforms/${slug}`);
  await waitForAppReady(page);
}

// Submitter is now a locked auto-filled field (signed-in user), not a select.
// The forms' first <select> is therefore the program-specific group/herd/flock
// dropdown — wait for it to populate before the caller selects from it.
async function waitFirstSelectPopulated(page) {
  const firstSelect = page.locator('select').first();
  await expect.poll(async () => await firstSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  return firstSelect;
}

async function attachPhotos(page, n) {
  await page
    .locator('[data-daily-photo-capture="1"] [data-photo-input="1"]')
    .setInputFiles(Array.from({length: n}, (_, i) => tinyImageFile(`p${i + 1}.png`)));
}

// Form fillers — pick the bare minimum to satisfy required-field validation.
async function fillBroiler(page, {batch = 'B-26-01', feedType = 'STARTER', feedLbs = '100'} = {}) {
  await waitFirstSelectPopulated(page);
  await page.locator('select').first().selectOption(batch); // Broiler Group
  await page.locator('input[type="number"]').first().fill(feedLbs);
  // Feed-type toggle is a button group (Toggle component); scroll into view
  // since it sits below feed_lbs.
  const ftBtn = page.getByRole('button', {name: feedType, exact: true}).first();
  await ftBtn.scrollIntoViewIfNeeded();
  await ftBtn.click();
}

async function fillPig(page) {
  await waitFirstSelectPopulated(page);
  await page.locator('select').first().selectOption('P-26-01'); // Pig Group
  // # pigs, feed lbs, fence voltage are number inputs.
  const nums = page.locator('input[type="number"]');
  await nums.nth(0).fill('20');
  await nums.nth(1).fill('250');
  await nums.nth(2).fill('4.2');
}

async function fillCattle(page) {
  await waitFirstSelectPopulated(page);
  await page.locator('select').first().selectOption('mommas'); // Herd
  // Cattle/sheep feed picker is jsonb-driven; submit only requires date+herd
  // (submitter is locked to the signed-in user).
}

async function fillSheep(page) {
  await waitFirstSelectPopulated(page);
  await page.locator('select').first().selectOption('feeders'); // Flock
}

async function blockStorageUpload(page) {
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
}

async function unblockStorageUpload(page) {
  await page.unroute('**/storage/v1/object/daily-photos/**');
}

async function force403StorageUpload(page) {
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({statusCode: '403', error: 'Unauthorized', message: 'forbidden'}),
      });
    } else {
      await route.continue();
    }
  });
}

// --------------------------------------------------------------------------
// Test 1 — broiler online happy + email fires
// --------------------------------------------------------------------------
test('broiler online with photos + STARTER: row + 2 storage objects + rapid-processor called', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  let emailCalls = 0;
  page.on('request', (req) => {
    if (/\/functions\/v1\/rapid-processor/.test(req.url())) emailCalls += 1;
  });

  await gotoForm(page, 'broiler');
  await fillBroiler(page);
  await attachPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 20_000});

  const {data: rows} = await supabaseAdmin.from('poultry_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(rows[0].photos).toHaveLength(2);
  // Codex amendment 5: poultry_dailys.source is not set by the registry
  // (current direct-insert behavior preserved). The column may exist in the
  // table schema but the row's value is null/absent.
  expect(rows[0].source == null).toBe(true);
  const csid = rows[0].client_submission_id;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`poultry_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
  expect(emailCalls).toBeGreaterThanOrEqual(1);

  expect(await readQueue(page)).toEqual([]);
  expect(await readPhotoBlobs(page)).toEqual([]);
});

// --------------------------------------------------------------------------
// Test 2 — pig online happy
// --------------------------------------------------------------------------
test('pig online with photos: 1 row in pig_dailys + 2 storage objects', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  await gotoForm(page, 'pig');
  await fillPig(page);
  await attachPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 20_000});

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(rows[0].photos).toHaveLength(2);
  const csid = rows[0].client_submission_id;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
});

// --------------------------------------------------------------------------
// Test 3 — cattle online happy with source='daily_webform' lock
// --------------------------------------------------------------------------
test('cattle online with photos: source=daily_webform + 2 storage objects', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  await gotoForm(page, 'cattle');
  await fillCattle(page);
  await attachPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 20_000});

  const {data: rows} = await supabaseAdmin.from('cattle_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('daily_webform');
  expect(rows[0].herd).toBe('mommas');
  expect(rows[0].photos).toHaveLength(2);
  const csid = rows[0].client_submission_id;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`cattle_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
});

// --------------------------------------------------------------------------
// Test 4 — sheep online happy with source='daily_webform' lock
// --------------------------------------------------------------------------
test('sheep online with photos: source=daily_webform + 2 storage objects', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  await gotoForm(page, 'sheep');
  await fillSheep(page);
  await attachPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 20_000});

  const {data: rows} = await supabaseAdmin.from('sheep_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('daily_webform');
  expect(rows[0].flock).toBe('feeders');
  expect(rows[0].photos).toHaveLength(2);
  const csid = rows[0].client_submission_id;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`sheep_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
});

// --------------------------------------------------------------------------
// Test 5 — cattle offline → recovery
// --------------------------------------------------------------------------
test('cattle offline + recovery: queued → drains on reload', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  await gotoForm(page, 'cattle');
  await blockStorageUpload(page);
  await fillCattle(page);
  await attachPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('cattle_dailys');
  // Sanitized payload — no Blob refs.
  for (const p of queue[0].payload.photos || []) {
    expect('blob' in p).toBe(false);
  }
  const blobs = await readPhotoBlobs(page);
  expect(blobs).toHaveLength(2);
  expect(blobs.every((b) => b.form_kind === 'cattle_dailys')).toBe(true);

  await unblockStorageUpload(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);
  await expect.poll(async () => (await readPhotoBlobs(page)).length, {timeout: 15_000}).toBe(0);

  const {data: rows} = await supabaseAdmin.from('cattle_dailys').select('*').eq('client_submission_id', queue[0].csid);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('daily_webform');
});

// --------------------------------------------------------------------------
// Test 6 — broiler email negative lock (Codex amendment 3)
// --------------------------------------------------------------------------
test('broiler offline STARTER: state="queued" AND no rapid-processor request fired', async ({
  page,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  let emailCalls = 0;
  page.on('request', (req) => {
    if (/\/functions\/v1\/rapid-processor/.test(req.url())) emailCalls += 1;
  });

  await gotoForm(page, 'broiler');
  await blockStorageUpload(page);
  await fillBroiler(page); // STARTER + 100 lbs
  await attachPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  // Give any latent fire-and-forget a moment.
  await page.waitForTimeout(500);
  expect(emailCalls).toBe(0);
});

// --------------------------------------------------------------------------
// Test 7 — storage 403 stuck (sheep)
// --------------------------------------------------------------------------
test('sheep storage 403 → state="stuck" + stuck modal opens', async ({page, webformHubDailysPhotosOfflineScenario}) => {
  void webformHubDailysPhotosOfflineScenario;

  await gotoForm(page, 'sheep');
  await force403StorageUpload(page);
  await fillSheep(page);
  await attachPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Report$/}).click();

  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 15_000});

  // Stuck modal auto-opens. Anchor on the stuck row's data attribute.
  await expect(page.locator('[data-stuck-csid]').first()).toBeVisible({timeout: 5_000});
  // Describe row says Sheep.
  await expect(page.locator('[data-stuck-csid]').first()).toContainText(/Sheep/);
});

// --------------------------------------------------------------------------
// Test 8 — aggregated modal dispatch (Codex amendment 2)
// --------------------------------------------------------------------------
// Drive TWO real 403 submit flows in the same browser context — cattle + sheep.
// Modal lists both. Discard cattle; sheep row stays.
test('aggregated stuck modal dispatch: discard cattle leaves sheep stuck', async ({
  page,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  // Cattle stuck submit (real flow per Codex amendment 2 — no IDB pre-seed).
  await gotoForm(page, 'cattle');
  await force403StorageUpload(page);
  await fillCattle(page);
  await attachPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Report$/}).click();
  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 15_000});

  // Sheep stuck submit. Direct goto — same browser context, IDB persists.
  // After navigation, mount-time auto-open fires again (initialStuckShownRef
  // resets on unmount). Close it before driving the form.
  await gotoForm(page, 'sheep');
  await page.getByRole('button', {name: /^Close$/}).click();
  await fillSheep(page);
  await attachPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Report$/}).click();
  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 15_000});

  // Reload the hub — mount picks up both stuck rows from IDB and
  // initialStuckShownRef auto-opens the aggregated modal once.
  await page.reload();

  await expect.poll(async () => await page.locator('[data-stuck-csid]').count(), {timeout: 10_000}).toBe(2);

  const cattleRow = page
    .locator('[data-stuck-csid]')
    .filter({hasText: /Cattle/})
    .first();
  await expect(cattleRow).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await cattleRow.locator('[data-stuck-action="discard"]').click();

  await expect.poll(async () => await page.locator('[data-stuck-csid]').count(), {timeout: 5_000}).toBe(1);
  await expect(page.locator('[data-stuck-csid]').first()).toContainText(/Sheep/);
});

// --------------------------------------------------------------------------
// Test 9 — negative lock: broiler photos + Add-Group rejected
// --------------------------------------------------------------------------
test('broiler photos + Add-Group: rejected; no IDB write; no storage upload', async ({
  page,
  supabaseAdmin,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  let storageReqs = 0;
  page.on('request', (req) => {
    if (/\/storage\/v1\/object\/daily-photos\//.test(req.url())) storageReqs += 1;
  });

  await gotoForm(page, 'broiler');
  await fillBroiler(page);
  await attachPhotos(page, 1);

  // Add Another Group + pick a distinct batch so the multi-row branch arms.
  // Submitter is locked (no team select), so the primary batch is select 0 and
  // the added extra group's batch is select 1.
  await page.getByRole('button', {name: /Add Another Group/i}).click();
  const extraSelect = page.locator('select').nth(1);
  await extraSelect.selectOption({value: 'B-26-02'});

  await page.getByRole('button', {name: /^Submit Report$/}).click();

  // Existing rejection copy.
  await expect(page.getByText(/Photos can only be attached when submitting one group at a time/i)).toBeVisible({
    timeout: 5_000,
  });
  await page.waitForTimeout(300);
  expect(storageReqs).toBe(0);
  expect(await readQueue(page)).toEqual([]);
  expect(await readPhotoBlobs(page)).toEqual([]);
  const {data: rows} = await supabaseAdmin.from('poultry_dailys').select('id');
  expect(rows).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Test 10 — negative lock: egg path issues no daily-photos requests
// --------------------------------------------------------------------------
test('egg form: no DailyPhotoCapture mount; no daily-photos requests; no IDB writes', async ({
  page,
  webformHubDailysPhotosOfflineScenario,
}) => {
  void webformHubDailysPhotosOfflineScenario;

  let storageReqs = 0;
  page.on('request', (req) => {
    if (/\/storage\/v1\/object\/daily-photos\//.test(req.url())) storageReqs += 1;
  });

  await gotoForm(page, 'egg');
  // Submitter is locked to the signed-in user — no team dropdown to fill.

  // Egg form has NO photo capture (locks the permanent exclusion at the UI
  // boundary — egg_dailys has no photos column per mig 030).
  await expect(page.locator('[data-daily-photo-capture="1"]')).toHaveCount(0);

  // Loiter briefly to surface any latent storage request that might fire
  // during navigation/mount. None should.
  await page.waitForTimeout(500);

  expect(storageReqs).toBe(0);
  expect(await readQueue(page)).toEqual([]);
  expect(await readPhotoBlobs(page)).toEqual([]);
});
