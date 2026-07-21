import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Initiative C Phase 1B canary — offline submission queue end-to-end
// ============================================================================
// Drives the FuelSupplyWebform → useOfflineSubmit → IndexedDB queue →
// background sync path the same way an operator on a flaky cellular
// connection would experience it.
//
// This spec runs authenticated (default admin storageState). The fuel-supply
// webform submitter is now locked to the signed-in user, so /fueling/supply is
// login-required — an anonymous context lands on the LoginScreen. The
// offline-queue behavior under test is identical when authed; the submitter is
// the admin profile's full_name ('Test Admin') instead of a roster pick.
//
// Test 1 — happy online path: submit succeeds, copy reads "synced", IDB
//          queue empty, fuel_supplies has 1 row.
// Test 2 — blocked offline path: POST /rest/v1/fuel_supplies aborts,
//          form shows "📡 Saved on this device" copy, IDB has 1 queued row,
//          fuel_supplies still empty.
// Test 3 — recovery: same blocked submit then unblock + reload (mount-time
//          syncNow fires), IDB clears, fuel_supplies has the queued row.
//
// Per-test IDB wipe via wipeOfflineQueue(page) — Playwright contexts share
// browser storage across tests in the same spec by default, so without
// the wipe a stale queued row from Test 2 would carry into Test 3 and
// confuse the recovery assertion.
// ============================================================================

// Runs under the default admin storageState (no anon override) — the form is
// login-required now. Each test still wipes IDB via wipeOfflineQueue(page).

const DB_NAME = 'wcf-offline-queue';

async function wipeOfflineQueue(page) {
  await page.evaluate(
    async (dbName) =>
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve(); // best-effort
        req.onblocked = () => resolve();
      }),
    DB_NAME,
  );
}

async function readQueue(page) {
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
        req.onerror = () => reject(req.error);
      }),
    DB_NAME,
  );
}

async function fillFormAndSubmit(page) {
  await expect(page.getByText('Fuel Supply Log')).toBeVisible({timeout: 15_000});
  await waitForAppReady(page);

  // Fill required fields. Today's ISO date is the default; the dropdowns
  // default to 'cell' destination + 'diesel' fuel type. The submitter is now a
  // locked auto-filled field (signed-in user), so only Gallons needs touching.
  await page.locator('input[type="number"]').fill('25.5');

  await page.locator('[data-submit-button="1"]').click();
}

// Block all POST/PATCH writes to fuel_supplies to simulate offline at the
// upsert. Form load + team_members read still succeed.
async function blockFuelSuppliesUpsert(page) {
  await page.route('**/rest/v1/fuel_supplies**', async (route) => {
    const m = route.request().method();
    if (m === 'POST' || m === 'PATCH') {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
}

async function unblockFuelSuppliesUpsert(page) {
  await page.unroute('**/rest/v1/fuel_supplies**');
}

// --------------------------------------------------------------------------
// Test 1 — happy online path
// --------------------------------------------------------------------------
test('online happy path: synced copy + 1 row in fuel_supplies + empty queue', async ({
  page,
  supabaseAdmin,
  fuelSupplyOfflineScenario,
}) => {
  void fuelSupplyOfflineScenario;

  await page.goto('/fueling/supply');
  await wipeOfflineQueue(page);

  await fillFormAndSubmit(page);

  await expect(page.locator('[data-submit-state="synced"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-submit-state="synced"]')).toContainText('Supply logged');

  const queue = await readQueue(page);
  expect(queue).toEqual([]);

  const {data, error} = await supabaseAdmin.from('fuel_supplies').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({
    gallons: 25.5,
    team_member: 'Test Admin',
    fuel_type: 'diesel',
    destination: 'cell',
    source: 'webform',
  });
  expect(data[0].client_submission_id).toBeTruthy();
});

// --------------------------------------------------------------------------
// Test 2 — blocked upsert: queued copy + 1 IDB row + 0 prod rows
// --------------------------------------------------------------------------
test('blocked upsert: queued copy + 1 IDB row + zero rows in fuel_supplies', async ({
  page,
  supabaseAdmin,
  fuelSupplyOfflineScenario,
}) => {
  void fuelSupplyOfflineScenario;

  await page.goto('/fueling/supply');
  await wipeOfflineQueue(page);
  await blockFuelSuppliesUpsert(page);

  await fillFormAndSubmit(page);

  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-submit-state="queued"]')).toContainText('Saved on this device');

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({form_kind: 'fuel_supply'});
  expect(queue[0].record).toMatchObject({
    gallons: 25.5,
    team_member: 'Test Admin',
    destination: 'cell',
    fuel_type: 'diesel',
    source: 'webform',
  });
  // id + client_submission_id baked in at enqueue (stable across replays).
  expect(queue[0].csid).toBeTruthy();
  expect(queue[0].record.client_submission_id).toBe(queue[0].csid);
  expect(queue[0].record.id).toBeTruthy();

  const {data, error} = await supabaseAdmin.from('fuel_supplies').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(0);

  await unblockFuelSuppliesUpsert(page);
});

// --------------------------------------------------------------------------
// Test 3 — recovery: queue replays after network restored
// --------------------------------------------------------------------------
test('recovery: queued submission replays on next mount + lands one row', async ({
  page,
  supabaseAdmin,
  fuelSupplyOfflineScenario,
}) => {
  void fuelSupplyOfflineScenario;

  await page.goto('/fueling/supply');
  await wipeOfflineQueue(page);
  await blockFuelSuppliesUpsert(page);

  await fillFormAndSubmit(page);
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 10_000});

  const queueBefore = await readQueue(page);
  expect(queueBefore).toHaveLength(1);
  const queuedCsid = queueBefore[0].csid;

  // Network restored — operator returns to the form (or any other page that
  // mounts the hook); mount-time syncNow drains the queue.
  await unblockFuelSuppliesUpsert(page);
  await page.reload();

  // Wait for the queue to drain.
  await expect.poll(async () => (await readQueue(page)).length, {timeout: 10_000}).toBe(0);

  const {data, error} = await supabaseAdmin.from('fuel_supplies').select('*').eq('client_submission_id', queuedCsid);
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data[0].gallons).toBe(25.5);
  expect(data[0].team_member).toBe('Test Admin');
});
