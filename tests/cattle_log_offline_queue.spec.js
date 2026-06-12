import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Log — offline create queue (happy path).
// ============================================================================
// Create-only offline support: an offline submit persists the entry in the
// shared IndexedDB queue (form_kind 'cattle_log', store 'submissions') and
// renders a QUEUED row at the top of the list; reconnecting replays the
// idempotent submit_cattle_log_entry RPC (p_id = csid) and the entry becomes
// a normal server row.
//
//   1  context.setOffline → submit queues (IDB row + queued UI row + zero DB
//      rows) → online → drains to a real entry.
//   2  ONLINE submit whose RPC fails transiently (route abort) auto-queues —
//      classifyCattleLogError('transient') — then drains on the next mount.
//
// Per-test IDB wipe: Playwright contexts share browser storage across tests
// in the same spec file, so stale queued rows would bleed forward otherwise.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

const DB_NAME = 'wcf-offline-queue';

async function wipeOfflineQueue(page) {
  // Clear stores through a normal connection instead of deleteDatabase: the
  // app holds an open IDB connection, so a deleteDatabase would sit pending
  // forever (onblocked) and every later open() — including this spec's queue
  // reads — would hang behind it.
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

async function clearCattleLogData(supabaseAdmin) {
  const {error} = await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  if (error) throw new Error('clear comments: ' + error.message);
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';

// --------------------------------------------------------------------------
// Test 1 — offline submit queues; reconnect syncs to a normal row
// --------------------------------------------------------------------------
test('offline submit queues locally; reconnect replays into a real entry', async ({
  page,
  context,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(90_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  await context.setOffline(true);
  await expect(page.getByText('You appear to be offline.', {exact: false})).toBeVisible({timeout: 10_000});

  const body = 'Water trough cracked in pen 3';
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  await page.locator('[data-cattle-log-submit="1"]').click();

  // Saved-on-device copy + queued row at the top of the list.
  await expect(page.getByText('when you reconnect', {exact: false})).toBeVisible({timeout: 10_000});
  const queuedRow = page.locator('[data-cattle-log-queued-row]');
  await expect(queuedRow).toBeVisible({timeout: 10_000});
  await expect(queuedRow).toContainText('QUEUED');
  await expect(queuedRow).toContainText(body);
  // Composer cleared so the operator can keep logging offline.
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveValue('');

  // IDB: one cattle_log submission, entry id minted client-side ('cl-…',
  // reused on replay as the idempotency key).
  const queue = await readCattleLogQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({form_kind: 'cattle_log', status: 'queued'});
  const csid = queue[0].csid;
  expect(csid.startsWith('cl-')).toBe(true);
  expect(csid.includes('--')).toBe(false);
  expect(queue[0].payload).toMatchObject({id: csid, body, isIssue: true});

  // Nothing server-side yet.
  const {data: preRows, error: preErr} = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('entity_type', 'cattle.log');
  expect(preErr).toBeNull();
  expect(preRows).toHaveLength(0);

  // Reconnect: the 'online' trigger replays the queue.
  await context.setOffline(false);
  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 20_000}).toBe(0);

  // Queued row replaced by the real server row (the page refreshes the list
  // when the queue drains).
  await expect(page.locator('[data-cattle-log-queued-row]')).toHaveCount(0, {timeout: 10_000});
  await expect(page.locator(`[data-cattle-log-row="${csid}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator(`[data-cattle-log-row="${csid}"]`)).toContainText(body);

  // Server row landed under the client-minted id with issue-state true.
  const {data: comments, error} = await supabaseAdmin
    .from('comments')
    .select('id, entity_type, entity_id, body')
    .eq('id', csid);
  expect(error).toBeNull();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({entity_type: 'cattle.log', entity_id: 'cattle-log', body});

  const {data: issueRow, error: issueErr} = await supabaseAdmin
    .from('cattle_log_issue_state')
    .select('is_issue')
    .eq('comment_id', csid)
    .single();
  expect(issueErr).toBeNull();
  expect(issueRow.is_issue).toBe(true);
});

// --------------------------------------------------------------------------
// Test 2 — online submit with transient RPC failure auto-queues
// --------------------------------------------------------------------------
test('online submit with a transient RPC failure queues instead of erroring, then drains on reload', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(90_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  // Abort only the submit RPC — page load + list RPC stay healthy, so this
  // exercises the classify('transient') → enqueue path, not navigator.onLine.
  await page.route('**/rest/v1/rpc/submit_cattle_log_entry**', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed');
    else await route.continue();
  });

  const body = 'Hay ring moved to the west field';
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  await page.locator('[data-cattle-log-submit="1"]').click();

  await expect(page.getByText('when you reconnect', {exact: false})).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-cattle-log-queued-row]')).toBeVisible({timeout: 10_000});

  const queue = await readCattleLogQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].status).toBe('queued');
  const csid = queue[0].csid;

  const {data: preRows} = await supabaseAdmin.from('comments').select('id').eq('entity_type', 'cattle.log');
  expect(preRows).toHaveLength(0);

  // Unblock; mount-time replay on reload drains the queue.
  await page.unroute('**/rest/v1/rpc/submit_cattle_log_entry**');
  await page.reload();
  await waitForLogLoaded(page);

  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 20_000}).toBe(0);
  await expect(page.locator(`[data-cattle-log-row="${csid}"]`)).toBeVisible({timeout: 15_000});

  const {data: comments, error} = await supabaseAdmin.from('comments').select('id, body').eq('id', csid);
  expect(error).toBeNull();
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toBe(body);
});
