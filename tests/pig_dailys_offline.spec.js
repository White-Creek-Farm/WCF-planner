import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Initiative C Phase 1C-B — PigDailys no-photo flat offline queue
// ============================================================================
// Drives /webform → useOfflineSubmit('pig_dailys') → IndexedDB queue →
// background sync against the pig_dailys table. Mirrors the Phase 1B
// canary spec's structure (offline_queue_canary.spec.js); the difference
// is the form (PigDailys) and the dual-path photo gate.
//
// Tests:
//   1 — online no-photo happy path: 1 row in pig_dailys, queue empty,
//        synced UI.
//   2 — offline no-photo: route-abort POST → "Saved on this device" copy;
//        IDB has 1 entry with form_kind='pig_dailys', record carries
//        client_submission_id but NO source/feed_type fields, photos:[].
//   3 — recovery: same setup as #2, then unblock + reload → mount-time
//        syncNow drains queue → 1 row in pig_dailys.
//   4 — photo-attached + POST aborted: photo upload to storage succeeds,
//        but the pig_dailys insert is blocked. Operator sees explicit
//        "photo submissions need a connection" copy. IDB queue stays
//        empty — photo offline support is the next phase, NOT 1C-B.
//   5 — 23505 replay = synced via the existing flat hook's anon-friendly
//        idempotency path: queue offline, pre-seed pig_dailys at the
//        queued csid via service role, unblock + reload → flat hook's
//        23505-on-csid → markSynced → queue empties without inserting a
//        duplicate row.
//
// Anon context per Phase 1B canary pattern. PigDailysWebform routes at
// /webform (singular) — the legacy path; do not confuse with /webforms.
// ============================================================================

// Runs authenticated (default admin storageState) — the webform submitter is
// now locked to the signed-in user, so anonymous access lands on the login
// screen. The offline-queue behavior under test is identical when authed.
const DB_NAME = 'wcf-offline-queue';

// 1×1 transparent PNG; smallest valid PNG that createImageBitmap will
// decode. compressImage in src/lib/photoCompress.js scales to JPEG.
const PNG_1x1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

async function readQueue(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => {
          reject(new Error('readQueue: indexedDB.open never fired within 5s'));
        }, 5000);
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
          reject(new Error('readQueue: onblocked'));
        };
      }),
    DB_NAME,
  );
}

async function fillFormAndSubmit(page) {
  await waitForAppReady(page);

  // Submitter is locked to the signed-in user (no team dropdown). Pig group is
  // the first combobox now.
  const groupSelect = page.getByRole('combobox').first();
  await expect.poll(async () => await groupSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await groupSelect.selectOption({label: 'P-26-01'});

  // # Pigs in group + Feed (lbs) — both `<input type="number">`.
  const numberInputs = page.locator('input[type="number"]');
  await numberInputs.nth(0).fill('20');
  await numberInputs.nth(1).fill('250');
  // Fence voltage — third number input.
  await numberInputs.nth(2).fill('4.2');

  // Submit.
  await page.getByRole('button', {name: /^Submit Daily Report$/}).click();
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
// Test 1 — online no-photo happy path
// --------------------------------------------------------------------------
test('online no-photo: synced copy + 1 row in pig_dailys + empty queue', async ({
  page,
  supabaseAdmin,
  pigDailysOfflineScenario,
}) => {
  void pigDailysOfflineScenario;

  await page.goto('/webform-pigs');
  await fillFormAndSubmit(page);

  await expect(page.getByText('Report submitted!')).toBeVisible({timeout: 15_000});

  const queue = await readQueue(page);
  expect(queue).toEqual([]);

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    batch_label: 'P-26-01',
    batch_id: 'p-26-01',
    team_member: 'Test Admin',
    pig_count: 20,
    feed_lbs: 250,
    fence_voltage: 4.2,
  });
  expect(rows[0].client_submission_id).toBeTruthy();
  expect(rows[0].photos).toEqual([]);
  // No source field — current PigDailys rows omit it.
  expect(rows[0].source).toBeNull();
});

// --------------------------------------------------------------------------
// Test 2 — offline no-photo: queued copy + IDB row + zero rows landed
// --------------------------------------------------------------------------
test('offline no-photo: queued copy + IDB has flat record + zero rows in pig_dailys', async ({
  page,
  supabaseAdmin,
  pigDailysOfflineScenario,
}) => {
  void pigDailysOfflineScenario;

  await page.goto('/webform-pigs');
  await blockPigDailysInsert(page);

  await fillFormAndSubmit(page);

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Saved on this device')).toBeVisible();

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({form_kind: 'pig_dailys'});
  // Record shape: csid baked in, no source field, no feed_type, photos empty.
  const rec = queue[0].record;
  expect(rec.client_submission_id).toBe(queue[0].csid);
  expect(rec.batch_label).toBe('P-26-01');
  expect(rec.batch_id).toBe('p-26-01');
  expect(rec.team_member).toBe('Test Admin');
  expect(rec.pig_count).toBe(20);
  expect(rec.feed_lbs).toBe(250);
  expect(rec.fence_voltage).toBe(4.2);
  expect(rec.photos).toEqual([]);
  expect('source' in rec).toBe(false);
  expect('feed_type' in rec).toBe(false);

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*');
  expect(rows).toHaveLength(0);

  await unblockPigDailysInsert(page);
});

// --------------------------------------------------------------------------
// Test 3 — recovery: queue drains on reload after network restored
// --------------------------------------------------------------------------
test('recovery: queued PigDailys submission replays on next mount + lands one row', async ({
  page,
  supabaseAdmin,
  pigDailysOfflineScenario,
}) => {
  void pigDailysOfflineScenario;

  await page.goto('/webform-pigs');
  await blockPigDailysInsert(page);

  await fillFormAndSubmit(page);
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedCsid = queueBefore[0].csid;

  await unblockPigDailysInsert(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('*').eq('client_submission_id', queuedCsid);
  expect(rows).toHaveLength(1);
  expect(rows[0].batch_label).toBe('P-26-01');
  expect(rows[0].team_member).toBe('Test Admin');
  expect(rows[0].photos).toEqual([]);
});

// --------------------------------------------------------------------------
// Test 4 — photo-attached online-only path (1C-B) RETIRED in Phase 1D-A
// --------------------------------------------------------------------------
// 1C-B locked photos as online-only with explicit "photos need a connection"
// copy. Phase 1D-A routes photo-attached PigDailys submissions through the
// hook's hasPhotos branch (queue-capable). The full Phase 1D-A photo
// behavior is locked by tests/offline_queue_pig_dailys_photos.spec.js
// (9 cases). This file now exclusively locks the empty-photos flat path
// (Tests 1, 2, 3, 5) — the path Codex review v2.1 correction 7 requires
// to keep working unchanged when pig_dailys.hasPhotos flips true.
//
// Removed: the photo-online-only assertion. Don't reintroduce.

// --------------------------------------------------------------------------
// Test 5 — 23505 replay = synced via the existing flat hook
// --------------------------------------------------------------------------
// When the operator submitted offline and the queued csid landed via some
// other path before the queue replay (admin script, second tab, etc.),
// the replay's INSERT raises 23505 on the *_client_submission_id_uq
// index. The flat hook (useOfflineSubmit) treats this as success and
// markSynced removes the queue row — locked by offline_queue_canary +
// offline_queue_dedup. This test re-locks it for the pig_dailys form.
test('23505 replay: pre-seeded row at queued csid → queue drains, no duplicate', async ({
  page,
  supabaseAdmin,
  pigDailysOfflineScenario,
}) => {
  void pigDailysOfflineScenario;

  await page.goto('/webform-pigs');
  await blockPigDailysInsert(page);

  await fillFormAndSubmit(page);
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedEntry = queueBefore[0];

  // Pre-seed pig_dailys at the SAME csid but a DIFFERENT id (simulates
  // the row landing through some other path — e.g. an admin or second-tab
  // submission that already used this csid). The unique index on
  // client_submission_id is what triggers the 23505 on replay; if we
  // pre-seeded with the SAME id we'd hit the PK constraint first and the
  // hook's isDuplicateCsidViolation regex (which keys on the
  // client_submission_id constraint name) would miss it.
  const preSeedRow = {...queuedEntry.record, id: queuedEntry.record.id + '-other-path'};
  const {error: seedErr} = await supabaseAdmin.from('pig_dailys').insert(preSeedRow);
  expect(seedErr).toBeNull();

  // Confirm exactly 1 row landed at this csid.
  {
    const {data: rows} = await supabaseAdmin
      .from('pig_dailys')
      .select('id')
      .eq('client_submission_id', queuedEntry.csid);
    expect(rows).toHaveLength(1);
  }

  // Restore network + reload. Mount-time syncNow's INSERT raises 23505
  // referencing the unique index; flat hook's isDuplicateCsidViolation
  // → markSynced → queue row deleted.
  await unblockPigDailysInsert(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // Still exactly 1 row — no duplicate from the replay.
  const {data: rows} = await supabaseAdmin.from('pig_dailys').select('id').eq('client_submission_id', queuedEntry.csid);
  expect(rows).toHaveLength(1);
});
