import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Initiative C Phase 1D-A — PigDailys photo offline queue
// ============================================================================
// Drives /webform-pigs through the hook's hasPhotos branch:
//   - online happy path: upload + insert; no IDB rows
//   - offline / storage 5xx-ish: queue (atomic submission + photo_blobs)
//   - storage 401/403 / row schema-after-upload: stuck (not throw)
//   - replay: photo_blobs uploaded with upsert:false; row insert; markSynced.
//     (Originally specified upsert:true; mig 031 grants anon INSERT only,
//     so the upsert path 403s even on fresh paths. upsert:false is
//     semantically equivalent for replay because pre-existing paths return
//     409 which the storage classifier treats as success-continue.)
//   - 409 on photo upload during replay: success-continue (Codex 9 / 5b)
//   - discard from stuck modal: cascade-cleans both stores
//
// WebformHub is NOT touched in 1D-A. The /webform-pigs route is the
// standalone PigDailysWebform, which uses useOfflineSubmit('pig_dailys')
// for both photo and no-photo paths after this build.
//
// Runs authenticated (default admin storageState) — the webform submitter is
// now locked to the signed-in user, so /webform-pigs is login-required and an
// anonymous context lands on the LoginScreen. The photo offline-queue behavior
// under test is identical when authed; the submitter is the admin profile's
// full_name ('Test Admin') instead of a roster pick. Per-test fresh browser
// storage wipes IDB, so no explicit wipeOfflineQueue step is needed.
//
// Daily-photos RLS (resolved): the daily-photos storage bucket previously
// lacked a `FOR INSERT TO authenticated` policy (migration 031 granted anon
// INSERT only), unlike every other private bucket the authenticated app writes
// to. Once these webforms became login-required, authenticated photo uploads
// 403'd with "new row violates row-level security policy". Migration 099
// (`daily_photos_auth_insert FOR INSERT TO authenticated`) added the missing
// policy, so the authenticated photo webforms now upload correctly and the
// upload-dependent tests (online happy path + queue replays that re-upload)
// run.
// ============================================================================

const DB_NAME = 'wcf-offline-queue';

// 1×1 transparent PNG (8-bit RGBA — required so createImageBitmap inside
// compressImage can actually decode it; the 1-bit version commonly used in
// pure-string-shape tests fails to decode in headless Chromium).
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
          const store = tx.objectStore('submissions');
          const all = store.getAll();
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
          const store = tx.objectStore('photo_blobs');
          const all = store.getAll();
          all.onsuccess = () => {
            db.close();
            // Strip the Blob from the result so JSON serialization across
            // page.evaluate doesn't choke. We only need the metadata for
            // assertions.
            resolve(
              all.result.map((r) => ({
                key: r.key,
                csid: r.csid,
                form_kind: r.form_kind,
                photo_key: r.photo_key,
                mime: r.mime,
                size_bytes: r.size_bytes,
                name: r.name,
                captured_at: r.captured_at,
                hasBlob: !!r.blob,
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

async function fillPigForm(page) {
  await waitForAppReady(page);

  // Submitter is locked to the signed-in user (no team dropdown), so the pig
  // group is the first combobox now.
  const groupSelect = page.getByRole('combobox').first();
  await expect.poll(async () => await groupSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await groupSelect.selectOption({label: 'P-26-01'});

  const numberInputs = page.locator('input[type="number"]');
  await numberInputs.nth(0).fill('20');
  await numberInputs.nth(1).fill('250');
  await numberInputs.nth(2).fill('4.2');
}

async function attachNPhotos(page, n) {
  await page.setInputFiles(
    '[data-photo-input="1"]',
    Array.from({length: n}, (_, i) => ({
      name: `p${i + 1}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_1x1_BASE64, 'base64'),
    })),
  );
}

async function blockStorageUpload(page) {
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PUT') {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
}

async function unblockStorageUpload(page) {
  await page.unroute('**/storage/v1/object/daily-photos/**');
}

async function blockPigDailysInsert(page) {
  await page.route('**/rest/v1/pig_dailys**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PATCH') {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
}

async function unblockPigDailysInsert(page) {
  await page.unroute('**/rest/v1/pig_dailys**');
}

// --------------------------------------------------------------------------
// Test 1 — Online happy path with photos
// --------------------------------------------------------------------------
test('online with photos: 1 row + 2 storage objects + IDB queue/photo_blobs both empty', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();

  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 20_000});

  expect(await readQueue(page)).toEqual([]);
  expect(await readPhotoBlobs(page)).toEqual([]);

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(Array.isArray(rows[0].photos)).toBe(true);
  expect(rows[0].photos).toHaveLength(2);
  for (const p of rows[0].photos) {
    expect(typeof p.path).toBe('string');
    expect(p.path).toMatch(/^pig_dailys\/.+\/photo-\d+\.jpg$/);
  }

  // Service-role list of the bucket directory for this csid: 2 objects.
  const csid = rows[0].client_submission_id;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
});

// --------------------------------------------------------------------------
// Test 2 — Offline with photos: queued copy + atomic IDB write
// --------------------------------------------------------------------------
test('offline with photos: queued state + atomic submissions+photo_blobs + sanitized payload', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await blockStorageUpload(page);
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Saved on this device')).toBeVisible();

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  const entry = queue[0];
  expect(entry.form_kind).toBe('pig_dailys');
  expect(entry.status).toBe('queued');
  // Sanitized payload: photos is an array of metadata only (no Blob refs).
  expect(Array.isArray(entry.payload.photos)).toBe(true);
  expect(entry.payload.photos).toHaveLength(2);
  for (const p of entry.payload.photos) {
    expect(typeof p.path).toBe('string');
    expect('blob' in p).toBe(false);
  }
  // Record's photos jsonb mirrors the metadata.
  expect(entry.record.photos).toHaveLength(2);

  const blobs = await readPhotoBlobs(page);
  expect(blobs).toHaveLength(2);
  expect(blobs.every((b) => b.csid === entry.csid)).toBe(true);
  expect(blobs.every((b) => b.hasBlob === true)).toBe(true);
  expect(blobs.map((b) => b.photo_key).sort()).toEqual(['photo-1', 'photo-2']);

  // Nothing in DB or storage yet.
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id');
  expect(rows).toHaveLength(0);
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${entry.csid}`);
  expect((listed || []).length).toBe(0);

  await unblockStorageUpload(page);
});

// --------------------------------------------------------------------------
// Test 3 — Recovery on reload
// --------------------------------------------------------------------------
test('recovery: queued+photos drains on reload + lands 1 row + 2 storage objects', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await blockStorageUpload(page);
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const csid = queueBefore[0].csid;

  await unblockStorageUpload(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);
  await expect.poll(async () => (await readPhotoBlobs(page)).length, {timeout: 15_000}).toBe(0);

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*').eq('client_submission_id', csid);
  expect(rows).toHaveLength(1);
  expect(rows[0].photos).toHaveLength(2);
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
});

// --------------------------------------------------------------------------
// Test 4 — Idempotent replay: pre-seeded row at queued csid
// --------------------------------------------------------------------------
test('idempotent replay: pre-seeded pig_dailys row at queued csid → 23505=synced, no duplicates', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await blockStorageUpload(page);
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  const csid = queueBefore[0].csid;

  // Pre-seed pig_dailys at the same csid via service role (with a different
  // id). Replay's INSERT will hit the unique-csid constraint and the hook's
  // 23505 path → markSynced → photo_blobs cascade-cleared.
  const preSeed = {
    id: 'pre-seed-id-' + Math.random().toString(36).slice(2, 10),
    client_submission_id: csid,
    submitted_at: new Date().toISOString(),
    date: '2026-04-30',
    team_member: 'BMAN',
    batch_id: 'p-26-01',
    batch_label: 'P-26-01',
    pig_count: 99,
    feed_lbs: 99,
    photos: [],
  };
  const ins = await supabaseAdmin.from('pig_dailys').insert(preSeed);
  expect(ins.error).toBeNull();

  await unblockStorageUpload(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);
  await expect.poll(async () => (await readPhotoBlobs(page)).length, {timeout: 15_000}).toBe(0);

  // No duplicate row.
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id, pig_count').eq('client_submission_id', csid);
  expect(rows).toHaveLength(1);
  expect(rows[0].pig_count).toBe(99); // pre-seed wins
});

// --------------------------------------------------------------------------
// Test 5 — Preseed-replay idempotent (Codex correction 9, with RLS reality)
// --------------------------------------------------------------------------
// Service role pre-seeds photo-1 in the bucket. Anon UPDATE on daily-photos
// is NOT permitted (mig 031 only grants anon INSERT) — so the queue worker
// uses upsert:false, and a re-upload of an already-existing path returns
// 409 Duplicate which the classifier treats as 'success-continue'. End
// result: replay drains, photo-2 uploads fresh, row inserts, no duplicates.
// The preseed bytes for photo-1 are NOT overwritten (operator-bytes
// contract: same csid → same content, so this is functionally fine).
test('preseed-replay idempotent: 409 on photo-1 = success-continue + photo-2 + row insert', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await blockStorageUpload(page);
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  const csid = queueBefore[0].csid;
  const photo1Path = `pig_dailys/${csid}/photo-1.jpg`;

  // Pre-seed photo-1 in the bucket via service role (service role bypasses RLS).
  const seedBytes = Buffer.from('seed-bytes-photo-1');
  const seed = await supabaseAdmin.storage
    .from('daily-photos')
    .upload(photo1Path, seedBytes, {upsert: true, contentType: 'image/jpeg'});
  expect(seed.error).toBeNull();

  await unblockStorageUpload(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // Both objects in bucket; row landed.
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${csid}`);
  expect((listed || []).length).toBe(2);
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id').eq('client_submission_id', csid);
  expect(rows).toHaveLength(1);
});

// --------------------------------------------------------------------------
// Test 5b — Forced 409 via route mock (Codex correction 9 alt)
// --------------------------------------------------------------------------
// The fix per Codex review: force 409 ONLY on the replay's first upload,
// after the row has already been queued via the normal route.abort path.
// 409 is treated as success-continue, replay proceeds to photo-2, then
// inserts the row.
test('forced 409 on replay first upload → classifier treats as success-continue', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  await blockStorageUpload(page);
  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const csid = queueBefore[0].csid;
  const photo1Path = `pig_dailys/${csid}/photo-1.jpg`;

  // Replace the abort with a replay-only 409 mock for photo-1; let
  // photo-2 + row insert run normally.
  await unblockStorageUpload(page);
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    if (route.request().url().includes(encodeURIComponent(photo1Path)) || route.request().url().includes(photo1Path)) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: '409',
          error: 'Duplicate',
          message: 'The resource already exists',
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // photo-1 was 409'd — bucket may or may not actually contain it depending
  // on whether earlier paths landed bytes (they didn't; we 409'd everything
  // through). photo-2 should be there for sure.
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id').eq('client_submission_id', csid);
  expect(rows).toHaveLength(1);
});

// --------------------------------------------------------------------------
// Test 6 — Storage 403 → state="stuck" immediately
// --------------------------------------------------------------------------
test('storage 403 → state="stuck" + photo_blobs preserved + auto-open stuck modal', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  // Mock storage upload to return 403.
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PUT') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({statusCode: '403', error: 'Unauthorized', message: 'forbidden'}),
      });
      return;
    }
    await route.continue();
  });

  await fillPigForm(page);
  await attachNPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();

  // Stuck state, NOT queued.
  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-submit-state="queued"]')).toHaveCount(0);

  // photo_blobs preserved.
  const blobs = await readPhotoBlobs(page);
  expect(blobs).toHaveLength(1);
  // submissions row marked failed at MAX_RETRIES.
  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].status).toBe('failed');

  // No DB row.
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id');
  expect(rows).toHaveLength(0);

  await page.unroute('**/storage/v1/object/daily-photos/**');
});

// --------------------------------------------------------------------------
// Test 7 — Schema error after photos uploaded → state="stuck" (NOT throw)
// --------------------------------------------------------------------------
test('row schema after photos uploaded → state="stuck"; photos in bucket; photo_blobs preserved', async ({
  page,
  supabaseAdmin,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  // Photos succeed; pig_dailys insert returns 400/PGRST204.
  await page.route('**/rest/v1/pig_dailys**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PATCH') {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({code: 'PGRST204', message: 'schema cache stale'}),
      });
      return;
    }
    await route.continue();
  });

  await fillPigForm(page);
  await attachNPhotos(page, 1);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();

  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 20_000});

  // photo_blobs preserved.
  const blobs = await readPhotoBlobs(page);
  expect(blobs).toHaveLength(1);
  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].status).toBe('failed');

  // Photo IS in bucket (orphan accepted; admin/janitor cleanup deferred).
  const csid = queue[0].csid;
  const {data: listed} = await supabaseAdmin.storage.from('daily-photos').list(`pig_dailys/${csid}`);
  expect((listed || []).length).toBe(1);

  await page.unroute('**/rest/v1/pig_dailys**');
});

// --------------------------------------------------------------------------
// Test 8 — Discard from stuck modal cleans both stores
// --------------------------------------------------------------------------
test('discard from stuck modal: submissions + photo_blobs both cleared by csid', async ({
  page,
  pigDailysPhotosOfflineScenario,
}) => {
  void pigDailysPhotosOfflineScenario;

  await page.goto('/webform-pigs');
  // Use the 403 route to land in stuck state quickly.
  await page.route('**/storage/v1/object/daily-photos/**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PUT') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({statusCode: '403', error: 'Unauthorized', message: 'forbidden'}),
      });
      return;
    }
    await route.continue();
  });

  await fillPigForm(page);
  await attachNPhotos(page, 2);
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();

  await expect(page.locator('[data-submit-state="stuck"]')).toBeVisible({timeout: 15_000});

  // Stuck modal auto-opens when stuckRows.length > 0 transitions on mount
  // (initialStuckShownRef pattern). Just click Discard inside the open modal.
  await expect(page.locator('[data-stuck-csid]').first()).toBeVisible({timeout: 5000});
  // Auto-accept the window.confirm() that StuckSubmissionsModal might fire.
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-stuck-action="discard"]').first().click();

  // Both stores cleared.
  await expect.poll(async () => (await readQueue(page)).length, {timeout: 5000}).toBe(0);
  await expect.poll(async () => (await readPhotoBlobs(page)).length, {timeout: 5000}).toBe(0);

  await page.unroute('**/storage/v1/object/daily-photos/**');
});
