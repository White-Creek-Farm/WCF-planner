import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Initiative C Phase 1C-A — AddFeed parent-aware RPC offline queue
// ============================================================================
// Drives /addfeed → useOfflineRpcSubmit('add_feed_batch') → IndexedDB queue →
// background sync against the submit_add_feed_batch RPC (mig 034). Mirrors
// the Phase 1B canary spec's structure (offline_queue_canary.spec.js) but
// the submit path is sb.rpc(), not sb.from().insert(), and the queued
// record shape is {rpc, args} not a flat row.
//
// Tests:
//   1 — online happy path: 2-batch broiler submit → 1 daily_submissions
//        + 2 poultry_dailys; queue stays empty; child csid IS NULL.
//   2 — offline path: route-abort RPC → "Saved on this device" copy;
//        IDB has 1 entry with form_kind='add_feed_batch',
//        record.rpc='submit_add_feed_batch', and 2 children_in.
//   3 — recovery: same as #2 then unblock + reload → mount-time syncNow
//        drains queue; 1 parent + 2 children land; child csid IS NULL.
//   4 — idempotent replay: pre-seed DB at queued csid; queue replay calls
//        RPC which returns idempotent_replay:true; no duplicates land.
//
// Runs authenticated (default admin storageState) — the /addfeed webform
// submitter is locked to the signed-in user, so the form is login-required and
// an anonymous context lands on the LoginScreen. The RPC queue behavior under
// test is identical when authed.
// ============================================================================

// Default admin storageState (no anon override). Each test still gets fresh
// browser storage per Playwright, including IndexedDB — no wipe step needed,
// and an explicit `indexedDB.deleteDatabase()` call between mount and read
// races with the hook's openDB and can leave the DB unreachable. Letting
// the context boundary do the wipe is reliable.

const DB_NAME = 'wcf-offline-queue';

async function readQueue(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => {
          reject(new Error('readQueue: indexedDB.open never fired onsuccess/onerror/onblocked within 5s'));
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
          reject(new Error('readQueue: indexedDB.open returned onblocked'));
        };
      }),
    DB_NAME,
  );
}

// Drive the public /addfeed UI through a 2-batch broiler submission.
// Mirrors the existing Test 9 in add_feed_parent_submission.spec.js.
async function fillBroilerTwoBatchAndSubmit(page) {
  await waitForAppReady(page);

  await page.getByRole('button', {name: 'Broiler'}).click();

  // First batch group. The submitter is now a locked auto-filled field (not a
  // combobox), so the first batch select is combobox index 0.
  const firstBatchSelect = page.getByRole('combobox').first();
  await expect.poll(async () => await firstBatchSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await firstBatchSelect.selectOption('B-26-01');
  await page.getByRole('button', {name: 'STARTER'}).first().click();
  await page.locator('input[type="number"]').first().fill('100');

  // Add second group. Its batch select is the next combobox (index 1).
  await page.getByRole('button', {name: '+ Add Another Group'}).click();
  const secondBatchSelect = page.getByRole('combobox').nth(1);
  await expect(secondBatchSelect).toBeVisible({timeout: 10_000});
  await secondBatchSelect.selectOption('B-26-02');
  await page.getByRole('button', {name: 'STARTER'}).nth(1).click();
  await page.locator('input[type="number"]').nth(1).fill('150');

  // Submit. Button label includes the entry count.
  await page.getByRole('button', {name: /Log 2 Feed Entries/}).click();
}

// Block all RPC calls to submit_add_feed_batch — simulates offline at the
// queue boundary. Form load + webform_config reads still succeed.
async function blockAddFeedRpc(page) {
  await page.route('**/rest/v1/rpc/submit_add_feed_batch**', async (route) => {
    await route.abort('failed');
  });
}

async function unblockAddFeedRpc(page) {
  await page.unroute('**/rest/v1/rpc/submit_add_feed_batch**');
}

// --------------------------------------------------------------------------
// Test 1 — online happy path
// --------------------------------------------------------------------------
test('online happy path: synced copy + 1 parent + 2 children + empty queue', async ({
  page,
  supabaseAdmin,
  addFeedOfflineScenario,
}) => {
  void addFeedOfflineScenario;

  await page.goto('/addfeed');
  await fillBroilerTwoBatchAndSubmit(page);

  await expect(page.getByText('Feed logged!')).toBeVisible({timeout: 15_000});

  const queue = await readQueue(page);
  expect(queue).toEqual([]);

  const {data: parents} = await supabaseAdmin.from('daily_submissions').select('id, program, form_kind');
  expect(parents).toHaveLength(1);
  expect(parents[0].program).toBe('broiler');
  expect(parents[0].form_kind).toBe('add_feed');

  const {data: children} = await supabaseAdmin
    .from('poultry_dailys')
    .select('id, batch_label, feed_lbs, daily_submission_id, client_submission_id')
    .eq('daily_submission_id', parents[0].id);
  expect(children).toHaveLength(2);
  expect(children.map((r) => r.batch_label).sort()).toEqual(['B-26-01', 'B-26-02']);
  expect(children.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 2 — offline path: queued copy + 1 IDB row + zero rows landed
// --------------------------------------------------------------------------
test('offline path: queued copy + IDB has rpc record + zero parent/child rows', async ({
  page,
  supabaseAdmin,
  addFeedOfflineScenario,
}) => {
  void addFeedOfflineScenario;

  await page.goto('/addfeed');
  await blockAddFeedRpc(page);

  await fillBroilerTwoBatchAndSubmit(page);

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-submit-state="queued"]')).toContainText('queued');
  await expect(page.getByText('Saved on this device')).toBeVisible();

  // IDB queue row carries the RPC request shape.
  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('add_feed_batch');
  expect(queue[0].record.rpc).toBe('submit_add_feed_batch');
  expect(queue[0].record.args.parent_in.client_submission_id).toBe(queue[0].csid);
  expect(queue[0].record.args.parent_in.program).toBe('broiler');
  expect(queue[0].record.args.children_in).toHaveLength(2);
  // Child csid stays NULL on every queued child (parent owns dedup).
  expect(queue[0].record.args.children_in.every((c) => !('client_submission_id' in c))).toBe(true);
  // Children link to the same parentId.
  expect(queue[0].record.args.children_in.every((c) => c.id.startsWith(queue[0].record.args.parent_in.id))).toBe(true);

  // No prod rows landed.
  const {data: parents} = await supabaseAdmin.from('daily_submissions').select('id');
  expect(parents).toHaveLength(0);
  const {data: children} = await supabaseAdmin.from('poultry_dailys').select('id');
  expect(children).toHaveLength(0);

  await unblockAddFeedRpc(page);
});

// --------------------------------------------------------------------------
// Test 3 — recovery: queue drains on reload after network restored
// --------------------------------------------------------------------------
test('recovery: queued submission replays on next mount + lands 1 parent + 2 children', async ({
  page,
  supabaseAdmin,
  addFeedOfflineScenario,
}) => {
  void addFeedOfflineScenario;

  await page.goto('/addfeed');
  await blockAddFeedRpc(page);

  await fillBroilerTwoBatchAndSubmit(page);
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedCsid = queueBefore[0].csid;

  // Network restored — operator returns to the form, mount-time syncNow
  // drains the queue.
  await unblockAddFeedRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  const {data: parents} = await supabaseAdmin
    .from('daily_submissions')
    .select('id, client_submission_id')
    .eq('client_submission_id', queuedCsid);
  expect(parents).toHaveLength(1);

  const {data: children} = await supabaseAdmin
    .from('poultry_dailys')
    .select('id, batch_label, client_submission_id, daily_submission_id')
    .eq('daily_submission_id', parents[0].id);
  expect(children).toHaveLength(2);
  expect(children.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 4 — idempotent replay: pre-seeded parent at the queued csid
// --------------------------------------------------------------------------
// Operator submitted offline; queue stored the RPC request. Before the
// queue had a chance to drain, the same csid landed via another path
// (admin script, second tab, etc.). The queue replay's RPC call must
// return idempotent_replay:true and the queue must clear without
// inserting duplicate rows.
test('idempotent replay: pre-seeded parent at queued csid → no duplicates', async ({
  page,
  supabaseAdmin,
  addFeedOfflineScenario,
}) => {
  void addFeedOfflineScenario;

  await page.goto('/addfeed');
  await blockAddFeedRpc(page);

  await fillBroilerTwoBatchAndSubmit(page);
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedEntry = queueBefore[0];
  const queuedCsid = queuedEntry.csid;
  const queuedParentId = queuedEntry.record.args.parent_in.id;

  // Pre-seed DB with the same csid via a service-role RPC call. This
  // simulates the parent landing through some other path between the
  // queue's failed attempts and the recovery replay.
  const {error: rpcErr} = await supabaseAdmin.rpc('submit_add_feed_batch', queuedEntry.record.args);
  expect(rpcErr).toBeNull();

  // Confirm exactly 1 parent + 2 children landed.
  {
    const {data: parents} = await supabaseAdmin
      .from('daily_submissions')
      .select('id')
      .eq('client_submission_id', queuedCsid);
    expect(parents).toHaveLength(1);
    expect(parents[0].id).toBe(queuedParentId);
    const {data: children} = await supabaseAdmin
      .from('poultry_dailys')
      .select('id')
      .eq('daily_submission_id', queuedParentId);
    expect(children).toHaveLength(2);
  }

  // Now restore network + reload — queue replay calls RPC with the same
  // csid → idempotent_replay:true → markSynced (queue row deleted).
  await unblockAddFeedRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // Still exactly 1 parent + 2 children. No duplicates from the replay.
  {
    const {data: parents} = await supabaseAdmin
      .from('daily_submissions')
      .select('id')
      .eq('client_submission_id', queuedCsid);
    expect(parents).toHaveLength(1);
    const {data: children} = await supabaseAdmin
      .from('poultry_dailys')
      .select('id')
      .eq('daily_submission_id', queuedParentId);
    expect(children).toHaveLength(2);
  }
});
