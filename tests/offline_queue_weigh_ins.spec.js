import {test, expect} from './fixtures.js';

// ============================================================================
// Initiative C Phase 1C-D — WeighIns RPC offline queue (pig + broiler fresh)
// ============================================================================
// Drives /weighins → useOfflineRpcSubmit('weigh_in_session_batch') →
// IndexedDB queue → background sync against the submit_weigh_in_session_batch
// RPC (mig 035). Mirrors offline_queue_multi_form.spec.js (the AddFeed RPC
// canary) but with the WeighIns fresh-session state machine:
//
//   - startNewSession for pig/broiler does NOT INSERT (no weigh_in_sessions
//     row until RPC fires).
//   - Pig: per-entry "Add Entry" → local-only push. "Save Draft" → RPC.
//   - Broiler: per-cell grid fill. "Save Weights" → RPC.
//   - On state='synced': sessionIsFresh flips false, session.id ←
//     parent_in.id, entry IDs swap to record.args.entries_in[i].id, operator
//     stays on session screen so existing online Complete path still works.
//   - On state='queued': terminal "Saved on this device" screen.
//
// Hard scope (per Codex):
//   - Pig + broiler ONLY. Cattle/sheep paths must NOT issue an RPC call
//     (Test 8 negative lock).
//   - Completion stays online-direct via finalizeSession (out of scope here).
//   - 23505 from this RPC is a stuck/schema bug, not success.
//   - Children carry NO client_submission_id (parent owns dedup).
// ============================================================================

// Anon context — operators arrive at /weighins unauthenticated. Per-test
// fresh storageState wipes IDB between tests automatically.

const FALLBACK_SUBMITTER_NAME =
  process.env.VITE_TEST_ADMIN_FULL_NAME || process.env.VITE_TEST_ADMIN_EMAIL?.split('@')[0] || 'Signed-in user';

const DB_NAME = 'wcf-offline-queue';

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
          reject(new Error('readQueue: indexedDB.open returned onblocked'));
        };
      }),
    DB_NAME,
  );
}

async function blockWeighInsRpc(page) {
  await page.route('**/rest/v1/rpc/submit_weigh_in_session_batch**', async (route) => {
    await route.abort('failed');
  });
}

async function unblockWeighInsRpc(page) {
  await page.unroute('**/rest/v1/rpc/submit_weigh_in_session_batch**');
}

async function getLockedSubmitterName(page) {
  const raw = await page.locator('[data-locked-submitter="1"]').locator('span').nth(1).textContent();
  return raw?.trim() || FALLBACK_SUBMITTER_NAME;
}

// Drive the species picker → select stage → start-session for pig with the
// canonical seeded batch.
async function pigStartFreshSession(page) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await page.getByText('Pig', {exact: true}).click();
  const lockedSubmitter = await getLockedSubmitterName(page);
  // Pick batch + Start.
  await page.getByLabel('Pig Batch *').selectOption({label: 'P-26-01'});
  await page.getByRole('button', {name: 'Start Session'}).click();
  // Confirm we're on session screen — the pig fresh-collection caption is
  // a unique marker for this state.
  await expect(page.getByText('Saving on this device')).toBeVisible({timeout: 10_000});
  return lockedSubmitter;
}

async function pigAddEntry(page, weight) {
  await page.locator('input[type="number"]').first().fill(String(weight));
  await page.getByRole('button', {name: /Add Entry/}).click();
}

async function broilerStartFreshSession(page) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await page.getByText('Broiler', {exact: true}).click();
  const lockedSubmitter = await getLockedSubmitterName(page);
  await page.getByRole('combobox').first().selectOption('B-26-01');
  // Week 4 is the default selected; tap explicitly to be safe.
  await page.getByRole('button', {name: 'Week 4'}).click();
  // The batch options and the schooner mirror load on separate reads.
  // startNewSession refuses to start until the mirror resolved, so wait for
  // the select stage's readiness marker instead of racing that fetch (route
  // interception latency made CI lose the race deterministically).
  await expect(page.locator('[data-weighins-broiler-meta-loaded="1"]')).toHaveCount(1, {timeout: 10_000});
  await page.getByRole('button', {name: 'Start Session'}).click();
  // Grid header is the marker for session stage in broiler.
  await expect(page.getByText('Bird weights (lbs)')).toBeVisible({timeout: 10_000});
  return lockedSubmitter;
}

// Fill the broiler grid: 4 cells in 2 schooner columns (2 cells each).
// Inputs are rendered column-major: A row 1..15 then B row 1..15. So
// columnA[0]=index 0, columnA[1]=index 1, columnB[0]=index 15, columnB[1]=16.
async function broilerFill4Cells(page) {
  const inputs = page.locator('input[type="number"]');
  await inputs.nth(0).fill('1.4'); // schooner A row 1
  await inputs.nth(1).fill('1.5'); // schooner A row 2
  await inputs.nth(15).fill('1.6'); // schooner B row 1
  await inputs.nth(16).fill('1.7'); // schooner B row 2
}

// --------------------------------------------------------------------------
// Test 1 — Pig online happy path: synced flips fresh→DB-backed in place
// --------------------------------------------------------------------------
test('pig online: synced → fresh→DB-backed conversion + Save Draft hidden + post-synced direct add', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  const lockedSubmitter = await pigStartFreshSession(page);

  // Add 3 entries to local state.
  await pigAddEntry(page, 240);
  await pigAddEntry(page, 245);
  await pigAddEntry(page, 250);

  // Save Draft fires the RPC.
  await page.getByRole('button', {name: /Save Draft \(3 entries\)/}).click();

  // Synced marker visible (data-submit-state='synced' is hidden but
  // present in DOM); Save Draft is gone; Complete is enabled.
  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});
  await expect(page.getByRole('button', {name: /Save Draft/})).toHaveCount(0);
  await expect(page.getByRole('button', {name: /Complete Weigh-In/})).toBeVisible();

  // DB landed: 1 session, 3 entries, all child csids null, parent csid set.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('species', 'pig');
  expect(sessions).toHaveLength(1);
  expect(sessions[0].status).toBe('draft');
  expect(sessions[0].batch_id).toBe('P-26-01');
  expect(sessions[0].broiler_week).toBeNull();
  expect(sessions[0].team_member).toBe(lockedSubmitter);
  expect(sessions[0].client_submission_id).toBeTruthy();
  const sessionId = sessions[0].id;

  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('*').eq('session_id', sessionId);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
  expect(rows.map((r) => Number(r.weight)).sort((a, b) => a - b)).toEqual([240, 245, 250]);

  // Now in DB-backed mode — the per-entry button label flipped to "Save Entry".
  // Add a 4th entry through the direct-DB path to confirm that path still works.
  await page.locator('input[type="number"]').first().fill('255');
  await page.getByRole('button', {name: /Save Entry/}).click();

  // Wait for the 4th row to land via direct INSERT.
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin.from('weigh_ins').select('id').eq('session_id', sessionId);
        return (data || []).length;
      },
      {timeout: 10_000},
    )
    .toBe(4);

  const {data: allRows} = await supabaseAdmin.from('weigh_ins').select('*').eq('session_id', sessionId);
  expect(allRows.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 2 — Pig offline path: queued terminal screen + IDB rpc record
// --------------------------------------------------------------------------
test('pig offline: queued copy + IDB has rpc record + zero rows in DB', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  await blockWeighInsRpc(page);
  const lockedSubmitter = await pigStartFreshSession(page);

  await pigAddEntry(page, 240);
  await pigAddEntry(page, 245);
  await pigAddEntry(page, 250);

  await page.getByRole('button', {name: /Save Draft \(3 entries\)/}).click();

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Saved on this device')).toBeVisible();

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('weigh_in_session_batch');
  expect(queue[0].record.rpc).toBe('submit_weigh_in_session_batch');
  expect(queue[0].record.args.parent_in.species).toBe('pig');
  expect(queue[0].record.args.parent_in.status).toBe('draft');
  expect(queue[0].record.args.parent_in.batch_id).toBe('P-26-01');
  expect(queue[0].record.args.parent_in.team_member).toBe(lockedSubmitter);
  expect(queue[0].record.args.parent_in.client_submission_id).toBe(queue[0].csid);
  expect(queue[0].record.args.entries_in).toHaveLength(3);
  // Child csid stays absent on every queued entry — parent owns dedup.
  for (const child of queue[0].record.args.entries_in) {
    expect('client_submission_id' in child).toBe(false);
    expect(child.id.startsWith(queue[0].record.args.parent_in.id)).toBe(true);
  }

  // No rows landed in DB.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('id');
  expect(sessions).toHaveLength(0);
  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id');
  expect(rows).toHaveLength(0);

  await unblockWeighInsRpc(page);
});

// --------------------------------------------------------------------------
// Test 3 — Recovery: queue drains on reload after network restored
// --------------------------------------------------------------------------
test('pig recovery: queued submission replays on reload + lands 1 session + 3 entries', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  await blockWeighInsRpc(page);
  const lockedSubmitter = await pigStartFreshSession(page);

  await pigAddEntry(page, 240);
  await pigAddEntry(page, 245);
  await pigAddEntry(page, 250);
  await page.getByRole('button', {name: /Save Draft/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const before = await readQueue(page);
  expect(before).toHaveLength(1);
  const queuedCsid = before[0].csid;

  await unblockWeighInsRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // team_member must be in the select list — asserting on a column the
  // query never fetched compares against undefined and can never pass.
  const {data: sessions} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id, client_submission_id, species, status, team_member')
    .eq('client_submission_id', queuedCsid);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].species).toBe('pig');
  expect(sessions[0].status).toBe('draft');
  expect(sessions[0].team_member).toBe(lockedSubmitter);

  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('*').eq('session_id', sessions[0].id);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 4 — Idempotent replay: pre-seed parent at queued csid → no duplicates
// --------------------------------------------------------------------------
test('pig idempotent replay: pre-seeded parent at queued csid → queue drains without duplicates', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  await blockWeighInsRpc(page);
  const lockedSubmitter = await pigStartFreshSession(page);

  await pigAddEntry(page, 240);
  await pigAddEntry(page, 245);
  await page.getByRole('button', {name: /Save Draft/}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const before = await readQueue(page);
  expect(before).toHaveLength(1);
  const queued = before[0];

  // Pre-seed via service-role RPC at the same csid — simulates the parent
  // landing through another path between the failed attempt and the replay.
  const {error: rpcErr} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', queued.record.args);
  expect(rpcErr).toBeNull();

  // Confirm exactly 1 session + 2 entries pre-replay.
  {
    const {data: sessions} = await supabaseAdmin
      .from('weigh_in_sessions')
      .select('id, team_member')
      .eq('client_submission_id', queued.csid);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].team_member).toBe(lockedSubmitter);
    const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id').eq('session_id', sessions[0].id);
    expect(rows).toHaveLength(2);
  }

  // Now restore network + reload — replay calls RPC, RPC returns
  // idempotent_replay:true, queue drains.
  await unblockWeighInsRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // Still exactly 1 session + 2 entries.
  const {data: sessions} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id, team_member')
    .eq('client_submission_id', queued.csid);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].team_member).toBe(lockedSubmitter);
  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id').eq('session_id', sessions[0].id);
  expect(rows).toHaveLength(2);
});

// --------------------------------------------------------------------------
// Test 5 — Schema-class throw is inline error, not queued (Codex #4 P0001 lock)
// --------------------------------------------------------------------------
// Drives a payload that the RPC will reject with RAISE EXCEPTION (P0001):
// pig with a missing batch_id is fine, but a missing team_member triggers
// the "team_member required" RAISE. We can't strip team_member through the
// UI (the dropdown gates Start Session), so we drive the RPC failure via
// a service-role pre-seed of an INVALID parent at the same csid... no, that
// would hit the idempotent path. Cleaner: stub fetch to return a P0001
// envelope when the form submits, and assert the form surfaces it inline
// without queuing.
test('pig schema-throw: P0001 from RPC surfaces inline + does NOT queue (Codex #4 lock)', async ({
  page,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');

  // Intercept the RPC POST and return a P0001 error envelope. Mirrors what
  // PostgREST surfaces when mig 035's RAISE EXCEPTION fires (e.g., missing
  // team_member). The hook MUST classify this as schema and throw inline,
  // not enqueue.
  await page.route('**/rest/v1/rpc/submit_weigh_in_session_batch**', async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'P0001',
        message: 'submit_weigh_in_session_batch: team_member required',
        details: null,
        hint: null,
      }),
    });
  });

  const lockedSubmitter = await pigStartFreshSession(page);
  expect(lockedSubmitter).toBeTruthy();
  await pigAddEntry(page, 240);
  await page.getByRole('button', {name: /Save Draft/}).click();

  // Inline error banner shows the message; queue stays empty; terminal
  // queued screen never appears.
  await expect(page.getByText(/Could not save:.*team_member required/i)).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-submit-state="queued"]')).toHaveCount(0);

  const queue = await readQueue(page);
  expect(queue).toEqual([]);
});

// --------------------------------------------------------------------------
// Test 6 — Broiler online happy path: synced stays on grid, Complete enabled
// --------------------------------------------------------------------------
test('broiler online: synced stays on grid + Complete becomes enabled (Codex #2)', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  const lockedSubmitter = await broilerStartFreshSession(page);

  await broilerFill4Cells(page);

  await page.getByRole('button', {name: 'Save Weights'}).click();

  // Synced marker present; operator stays on the grid (not on the queued
  // terminal screen). Complete button is now enabled (DB-backed branch).
  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});
  await expect(page.locator('[data-submit-state="queued"]')).toHaveCount(0);
  await expect(page.getByText('Bird weights (lbs)')).toBeVisible(); // grid still showing
  await expect(page.getByRole('button', {name: /Complete Weigh-In/})).toBeVisible();

  // DB landed.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('species', 'broiler');
  expect(sessions).toHaveLength(1);
  expect(sessions[0].status).toBe('draft');
  expect(sessions[0].broiler_week).toBe(4);
  expect(sessions[0].batch_id).toBe('B-26-01');
  expect(sessions[0].team_member).toBe(lockedSubmitter);

  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('*').eq('session_id', sessions[0].id);
  expect(rows).toHaveLength(4);
  // Schooner labels preserved in tag column.
  const tagCounts = rows.reduce((acc, r) => {
    acc[r.tag] = (acc[r.tag] || 0) + 1;
    return acc;
  }, {});
  expect(tagCounts).toEqual({A: 2, B: 2});
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 7 — Broiler offline path: queued terminal screen + broiler_week=4
// --------------------------------------------------------------------------
test('broiler offline: queued IDB record carries broiler_week=4 + schooner labels in entries', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  await blockWeighInsRpc(page);
  const lockedSubmitter = await broilerStartFreshSession(page);

  await broilerFill4Cells(page);
  await page.getByRole('button', {name: 'Save Weights'}).click();

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Saved on this device')).toBeVisible();

  // Broiler queued terminal screen must hide "New Weigh-In" and keep "Back to Forms".
  // Mirrors the online done-screen contract locked by broiler_weigh_in_schooners T6.
  await expect(page.getByRole('button', {name: 'New Weigh-In'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Back to Forms'})).toBeVisible();

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('weigh_in_session_batch');
  expect(queue[0].record.args.parent_in.species).toBe('broiler');
  expect(queue[0].record.args.parent_in.broiler_week).toBe(4);
  expect(queue[0].record.args.parent_in.batch_id).toBe('B-26-01');
  expect(queue[0].record.args.parent_in.team_member).toBe(lockedSubmitter);
  expect(queue[0].record.args.entries_in).toHaveLength(4);
  expect(queue[0].record.args.entries_in.map((e) => e.tag).sort()).toEqual(['A', 'A', 'B', 'B']);
  for (const child of queue[0].record.args.entries_in) {
    expect('client_submission_id' in child).toBe(false);
  }

  // No rows in DB.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('id');
  expect(sessions).toHaveLength(0);

  await unblockWeighInsRpc(page);
});

// --------------------------------------------------------------------------
// Test 8 — Negative scope lock: cattle + sheep paths issue NO RPC call
// --------------------------------------------------------------------------
// Picks Cattle (and then Sheep), verifies that no
// submit_weigh_in_session_batch RPC was issued. Locks "no cattle/sheep
// runtime change" from the Codex hard-scope list.
test('negative lock: cattle + sheep selection issues no submit_weigh_in_session_batch RPC', async ({
  page,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  let rpcCallCount = 0;
  page.on('request', (req) => {
    if (/\/rest\/v1\/rpc\/submit_weigh_in_session_batch/.test(req.url())) {
      rpcCallCount += 1;
    }
  });

  await page.goto('/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Cattle: pick species, land on select stage, back out to species picker.
  await page.getByText('Cattle', {exact: true}).click();
  await expect(page.getByText('Start a new session')).toBeVisible({timeout: 10_000});

  // Sheep: navigate back, then pick sheep.
  await page.goto('/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await page.getByText('Sheep', {exact: true}).click();
  await expect(page.getByText('Start a new session')).toBeVisible({timeout: 10_000});

  // Give any latent fetch a beat to surface — none should fire.
  await page.waitForTimeout(500);
  expect(rpcCallCount).toBe(0);
});

// --------------------------------------------------------------------------
// Test 9 — Pig fresh local edit + delete BEFORE Save Draft (Codex review v3 #1)
// --------------------------------------------------------------------------
// Operator on a fresh pig session must be able to fix a fat-fingered entry
// and remove a wrong entry without network — both flow into local entries[]
// only. The RPC then submits the FINAL state, with the deleted entry absent
// and the edited one carrying the corrected weight. No DB writes happen
// before Save Draft for any of those local mutations.
test('pig fresh: local edit + delete pre-Save-Draft → only final state lands in DB', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  // Lock that no PATCH/DELETE on weigh_ins fires before the RPC. If the
  // pre-fix code path ran (calling sb.from('weigh_ins').update/.delete),
  // those would surface here. Locks Codex review v3 #1.
  let weighInsMutationCount = 0;
  page.on('request', (req) => {
    if (/\/rest\/v1\/weigh_ins(\?|$)/.test(req.url())) {
      const m = req.method();
      if (m === 'PATCH' || m === 'DELETE') weighInsMutationCount += 1;
    }
  });

  await page.goto('/weighins');
  const lockedSubmitter = await pigStartFreshSession(page);

  await pigAddEntry(page, 240); // keep
  await pigAddEntry(page, 999); // will be edited to 245
  await pigAddEntry(page, 250); // keep
  await pigAddEntry(page, 555); // will be deleted

  // Target rows by weight content rather than display position. The pig
  // "Recent entries" panel renders weight-descending (78d881e), so nth()
  // targeting would break on any future sort tweak. Each row contains
  // exactly one "<weight> lb" span; scoping the Edit/Delete lookup to that
  // row's parent div keeps the test robust.
  await page
    .getByText('999 lb', {exact: true})
    .locator('xpath=parent::div')
    .getByRole('button', {name: /^Edit$/})
    .click();

  // While in edit mode there are exactly 2 number inputs on screen:
  // index 0 = the always-on Add-Entry weight input at the top of the form;
  // index 1 = the edit row's weight input (currently shows 999).
  await page.locator('input[type="number"]').nth(1).fill('245');
  // The inline edit row renders a "Save" button; the bottom button is
  // labeled "Save Draft (N entries)" so an exact match disambiguates.
  await page.getByRole('button', {name: 'Save', exact: true}).click();

  // After the edit lands in local state, the 555 row's weight badge still
  // says "555 lb". Public webform routes destructive deletes through the
  // local typed DeleteModal (App-scoped _wcfConfirmDelete is not mounted on
  // anon webforms); type "delete" + Enter to confirm.
  await page
    .getByText('555 lb', {exact: true})
    .locator('xpath=parent::div')
    .getByRole('button', {name: /^Delete$/})
    .click();
  await expect(page.getByText('Are you sure?')).toBeVisible({timeout: 5_000});
  await page.getByPlaceholder('delete').fill('delete');
  await page.keyboard.press('Enter');

  // Now Save Draft. Final entries[] should be [240, 245, 250].
  await page.getByRole('button', {name: /Save Draft \(3 entries\)/}).click();
  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

  // Zero direct PATCH/DELETE on weigh_ins fired before Save Draft.
  expect(weighInsMutationCount).toBe(0);

  // DB state matches the final local state.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('id').eq('species', 'pig');
  expect(sessions).toHaveLength(1);
  // Team member comes from auth-derived locked submitter (no editable selector).
  const {data: liveSession} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('team_member')
    .eq('id', sessions[0].id)
    .single();
  expect(liveSession.team_member).toBe(lockedSubmitter);
  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('weight').eq('session_id', sessions[0].id);
  const weights = rows.map((r) => Number(r.weight)).sort((a, b) => a - b);
  expect(weights).toEqual([240, 245, 250]);
});

// --------------------------------------------------------------------------
// Test 10 — Synced fresh broiler completion (Codex review v3 #3)
// --------------------------------------------------------------------------
// Locks the fresh→DB-backed conversion through the actual completion path:
// after Save Weights (synced), tapping Complete must transition the session
// to status='complete' WITHOUT firing a second submit_weigh_in_session_batch
// RPC. Completion stays online-direct via finalizeSession.
test('broiler synced → Complete: status=complete + no second RPC fired', async ({
  page,
  supabaseAdmin,
  weighInsOfflineScenario,
}) => {
  void weighInsOfflineScenario;

  let rpcCallCount = 0;
  page.on('request', (req) => {
    if (/\/rest\/v1\/rpc\/submit_weigh_in_session_batch/.test(req.url())) {
      rpcCallCount += 1;
    }
  });

  await page.goto('/weighins');
  const lockedSubmitter = await broilerStartFreshSession(page);
  await broilerFill4Cells(page);
  await page.getByRole('button', {name: 'Save Weights'}).click();
  await expect(page.locator('[data-submit-state="synced"]')).toHaveCount(1, {timeout: 15_000});

  expect(rpcCallCount).toBe(1); // one RPC call for the fresh save

  // weigh_in_sessions has no created_at column (001_cattle_module.sql);
  // started_at is the session timestamp. Ordering by created_at made
  // PostgREST 42703 the whole response and sessions came back null.
  const {data: sessions} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id, team_member')
    .eq('species', 'broiler')
    .order('started_at', {ascending: false});
  expect(sessions).toBeTruthy();
  expect(sessions.length).toBeGreaterThan(0);
  expect(sessions[0].team_member).toBe(lockedSubmitter);

  // Now Complete — must use the existing online direct path.
  await page.getByRole('button', {name: /Complete Weigh-In/}).click();

  // Wait for status transition.
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin.from('weigh_in_sessions').select('status').eq('species', 'broiler').single();
        return data ? data.status : null;
      },
      {timeout: 15_000},
    )
    .toBe('complete');

  // No second RPC was fired by Complete — finalizeSession uses direct UPDATE.
  expect(rpcCallCount).toBe(1);
});

// --------------------------------------------------------------------------
// Test 11 — Stuck modal renders on species picker (Codex review v3 #2)
// --------------------------------------------------------------------------
// A stuck weigh_in_session_batch row in IDB on first /weighins load must
// surface immediately on the species picker — not only after the operator
// reaches the session screen.
test('stuck modal renders on species picker (not only on session screen)', async ({page, weighInsOfflineScenario}) => {
  void weighInsOfflineScenario;
  const stuckSubmitter = FALLBACK_SUBMITTER_NAME;

  await page.goto('/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Pre-seed an IDB stuck row before mount completes hook init. Use
  // page.evaluate to write directly into the queue's submissions store
  // with status='failed' + retry_count >= MAX_RETRIES (3).
  await page.evaluate(async (submitterName) => {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('wcf-offline-queue', 1);
      open.onupgradeneeded = () => {
        // Mirror src/lib/offlineQueue.js getDb() v1 EXACTLY (both stores, all
        // indexes). Since /weighins became login-gated, this evaluate can win
        // the DB-creation race against the app's deferred getDb(); an
        // index-less store created here is then frozen at v1 forever and
        // listStuck's getAllFromIndex('by_form_kind_status') throws, so the
        // stuck modal can never render.
        const db = open.result;
        if (!db.objectStoreNames.contains('submissions')) {
          const s = db.createObjectStore('submissions', {keyPath: 'csid'});
          s.createIndex('by_form_kind', 'form_kind', {unique: false});
          s.createIndex('by_status', 'status', {unique: false});
          s.createIndex('by_form_kind_status', ['form_kind', 'status'], {unique: false});
        }
        if (!db.objectStoreNames.contains('photo_blobs')) {
          const p = db.createObjectStore('photo_blobs', {keyPath: 'key'});
          p.createIndex('by_csid', 'csid', {unique: false});
          p.createIndex('by_form_kind', 'form_kind', {unique: false});
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('submissions', 'readwrite');
        const store = tx.objectStore('submissions');
        store.put({
          csid: 'stuck-csid-test',
          form_kind: 'weigh_in_session_batch',
          status: 'failed',
          retry_count: 3,
          created_at: Date.now() - 60_000,
          last_attempt_at: Date.now() - 30_000,
          last_error: 'simulated stuck',
          payload: {},
          record: {
            rpc: 'submit_weigh_in_session_batch',
            args: {
              parent_in: {
                id: 'WS-stuck',
                client_submission_id: 'stuck-csid-test',
                species: 'pig',
                status: 'draft',
                date: '2026-04-30',
                team_member: submitterName,
                batch_id: 'P-26-01',
              },
              entries_in: [{id: 'WS-stuck-c0', weight: 240, tag: null, note: null, new_tag_flag: false}],
            },
          },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
      open.onerror = () => reject(open.error);
    });
  }, stuckSubmitter);

  // Reload — fresh hook mount sees the stuck row and auto-opens the modal.
  // Operator is still on the species picker stage at this point.
  await page.reload();
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Modal renders even though we never advanced past the species picker.
  // Anchor on the row's data-stuck-csid hook.
  await expect(page.locator('[data-stuck-csid="stuck-csid-test"]')).toBeVisible({timeout: 15_000});
  // Species picker is still the active stage — its instruction copy is the
  // unique marker.
  await expect(page.getByText(/Pick what you[’']re weighing/)).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 12 — Pig recent-entries list shows ALL entries (no slice cap)
// --------------------------------------------------------------------------
// Hotfix 2026-05-06: the pig session UI used to render `entries.slice(-10)`
// with header "Recent entries (latest 10)". As soon as #11 landed locally,
// #1 dropped off the visible list and the operator lost the early entries
// mid-weigh. Fix renders all entries with a live count header.
//
// Lock: add 12 entries; the header must report the live count, and BOTH
// #1 and #12 must be visible.
test('pig recent-entries list shows all entries (no slice cap)', async ({page, weighInsOfflineScenario}) => {
  void weighInsOfflineScenario;

  await page.goto('/weighins');
  await pigStartFreshSession(page);

  // Add 12 entries; weights are arbitrary, just need 12 distinct entries.
  for (let i = 0; i < 12; i++) {
    await pigAddEntry(page, 240 + i);
  }

  // Header reports live count (was hard-coded "latest 10").
  await expect(page.getByText('Recent entries (12)')).toBeVisible();
  await expect(page.getByText(/Recent entries \(latest 10\)/)).toHaveCount(0);

  // First entry must still be visible (was dropped by slice(-10) once #11 landed).
  // Use exact text match so #1 doesn't false-match #10/#11/#12.
  await expect(page.getByText('#1', {exact: true})).toBeVisible();
  // Last entry must be visible.
  await expect(page.getByText('#12', {exact: true})).toBeVisible();
});
