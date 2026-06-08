import {test, expect} from './fixtures.js';

// ============================================================================
// Lane H — EquipmentFueling parent-aware RPC offline queue
// ============================================================================
// Drives /equipment/<slug> → useOfflineRpcSubmit('equipment_fueling') →
// IndexedDB queue → background sync against the submit_equipment_fueling RPC
// (mig 047). Mirrors offline_queue_multi_form.spec.js (AddFeed) but the
// fueling RPC is single-parent (no children) and also bumps
// equipment.current_<unit> via GREATEST in the same transaction.
//
// Tests:
//   1 — online happy path: submit → "Fueling saved"; queue empty; 1
//        equipment_fuelings row lands; equipment.current_hours bumps.
//   2 — offline path: route-abort RPC → "Saved on this device" copy; IDB has
//        1 entry with form_kind='equipment_fueling',
//        record.rpc='submit_equipment_fueling', parent_in carries the queued
//        csid + equipment_id; zero rows land.
//   3 — recovery: same as #2 then unblock + reload → mount-time syncNow
//        drains queue; 1 row lands at the queued csid; parent reading bumps.
//   4 — idempotent replay: pre-seed DB at the queued csid via service-role
//        RPC; queue replay returns idempotent_replay:true; no duplicate row.
//
// Runs authenticated (default admin storageState) — the fueling webform
// submitter is locked to the signed-in user, so the form is login-required.
// The RPC queue behavior under test is identical when authed.
// ============================================================================

const DB_NAME = 'wcf-offline-queue';
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = `ef-offline-${RUN_ID}`;
const EQ_ID = `eq-ef-offline-${RUN_ID}`;

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

// Seed one active hours-tracked piece with no checklists so the form has no
// every-fillup / service-interval gates — just gallons + reading + submit.
async function seedPiece(supabaseAdmin) {
  const row = {
    id: EQ_ID,
    name: 'Offline Test Tractor',
    slug: SLUG,
    category: 'tractors',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 200,
    current_km: null,
    fuel_type: 'diesel',
    takes_def: false,
    every_fillup_items: [],
    service_intervals: [],
    attachment_checklists: [],
    manuals: [],
    documents: [],
  };
  const {error} = await supabaseAdmin.from('equipment').upsert(row, {onConflict: 'id'});
  if (error) throw new Error(`seedPiece: ${error.message}`);
  return row;
}

// Drive the single-piece fueling form: gallons (number input #0) + reading
// (number input #1), then Save. The piece tracks hours and takes no DEF, so
// those are the only two number inputs on the page.
async function fillFuelingAndSubmit(page, {gallons = '12', reading = '250'} = {}) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.getByText('Offline Test Tractor')).toBeVisible({timeout: 15_000});

  const gallonsInput = page.locator('input[type="number"]').first();
  await expect(gallonsInput).toBeVisible({timeout: 10_000});
  await gallonsInput.fill(gallons);
  await page.locator('input[type="number"]').nth(1).fill(reading);

  await page.getByRole('button', {name: 'Save Fueling'}).click();
}

async function blockFuelingRpc(page) {
  await page.route('**/rest/v1/rpc/submit_equipment_fueling**', async (route) => {
    await route.abort('failed');
  });
}

async function unblockFuelingRpc(page) {
  await page.unroute('**/rest/v1/rpc/submit_equipment_fueling**');
}

// --------------------------------------------------------------------------
// Test 1 — online happy path
// --------------------------------------------------------------------------
test('online happy path: synced copy + 1 row lands + parent reading bumps + empty queue', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedPiece(supabaseAdmin);

  await page.goto(`/equipment/${SLUG}`);
  await fillFuelingAndSubmit(page, {gallons: '12', reading: '250'});

  await expect(page.getByText('Fueling saved')).toBeVisible({timeout: 15_000});

  const queue = await readQueue(page);
  expect(queue).toEqual([]);

  const {data: rows} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('id, equipment_id, hours_reading, km_reading, gallons, source')
    .eq('equipment_id', EQ_ID);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].hours_reading)).toBe(250);
  expect(rows[0].km_reading).toBeNull();
  expect(Number(rows[0].gallons)).toBe(12);

  const {data: parent} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', EQ_ID).maybeSingle();
  expect(Number(parent.current_hours)).toBe(250);
});

// --------------------------------------------------------------------------
// Test 2 — offline path: queued copy + 1 IDB row + zero rows landed
// --------------------------------------------------------------------------
test('offline path: queued copy + IDB has rpc record + zero rows + no parent bump', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedPiece(supabaseAdmin);

  await page.goto(`/equipment/${SLUG}`);
  await blockFuelingRpc(page);

  await fillFuelingAndSubmit(page, {gallons: '15', reading: '300'});

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Saved on this device')).toBeVisible();

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('equipment_fueling');
  expect(queue[0].record.rpc).toBe('submit_equipment_fueling');
  expect(queue[0].record.args.parent_in.client_submission_id).toBe(queue[0].csid);
  expect(queue[0].record.args.parent_in.equipment_id).toBe(EQ_ID);
  expect(Number(queue[0].record.args.parent_in.hours_reading)).toBe(300);
  // Single-parent RPC — no children payload.
  expect('children_in' in queue[0].record.args).toBe(false);

  // Nothing landed; parent reading untouched.
  const {data: rows} = await supabaseAdmin.from('equipment_fuelings').select('id').eq('equipment_id', EQ_ID);
  expect(rows).toHaveLength(0);
  const {data: parent} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', EQ_ID).maybeSingle();
  expect(Number(parent.current_hours)).toBe(200);

  await unblockFuelingRpc(page);
});

// --------------------------------------------------------------------------
// Test 3 — recovery: queue drains on reload after network restored
// --------------------------------------------------------------------------
test('recovery: queued fueling replays on next mount + lands 1 row + bumps reading', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedPiece(supabaseAdmin);

  await page.goto(`/equipment/${SLUG}`);
  await blockFuelingRpc(page);

  await fillFuelingAndSubmit(page, {gallons: '18', reading: '275'});
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedCsid = queueBefore[0].csid;

  // Network restored — operator reloads, mount-time syncNow drains the queue.
  await unblockFuelingRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  const {data: rows} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('id, client_submission_id, hours_reading')
    .eq('client_submission_id', queuedCsid);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].hours_reading)).toBe(275);

  const {data: parent} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', EQ_ID).maybeSingle();
  expect(Number(parent.current_hours)).toBe(275);
});

// --------------------------------------------------------------------------
// Test 4 — idempotent replay: pre-seeded row at the queued csid
// --------------------------------------------------------------------------
// The fueling landed through another path between the queue's failed attempt
// and the recovery replay. The replay's RPC call must return
// idempotent_replay:true and the queue must clear without a duplicate row.
test('idempotent replay: pre-seeded row at queued csid → no duplicate', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedPiece(supabaseAdmin);

  await page.goto(`/equipment/${SLUG}`);
  await blockFuelingRpc(page);

  await fillFuelingAndSubmit(page, {gallons: '10', reading: '260'});
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedEntry = queueBefore[0];
  const queuedCsid = queuedEntry.csid;
  const queuedId = queuedEntry.record.args.parent_in.id;

  // Pre-seed DB with the exact queued args via a service-role RPC call.
  const {error: rpcErr} = await supabaseAdmin.rpc('submit_equipment_fueling', queuedEntry.record.args);
  expect(rpcErr).toBeNull();

  {
    const {data: rows} = await supabaseAdmin
      .from('equipment_fuelings')
      .select('id')
      .eq('client_submission_id', queuedCsid);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(queuedId);
  }

  // Restore network + reload — queue replay calls RPC with the same csid →
  // idempotent_replay:true → markSynced (queue row deleted).
  await unblockFuelingRpc(page);
  await page.reload();

  await expect.poll(async () => (await readQueue(page)).length, {timeout: 15_000}).toBe(0);

  // Still exactly 1 row. No duplicate from the replay.
  const {data: rows} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('id')
    .eq('client_submission_id', queuedCsid);
  expect(rows).toHaveLength(1);
});
