import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Log — offline submit with a server-side AMBIGUOUS tag.
// ============================================================================
// Offline submits skip the client preview gate entirely, so an entry whose
// tag matches MORE THAN ONE active cow on the server queues locally and only
// fails at replay: submit_cattle_log_entry raises CATTLE_LOG_AMBIGUOUS_TAG,
// classifyCattleLogError → 'ambiguous_tag', and the row flips to
// needs_attention (never silently dropped). Retry deterministically fails
// again; Discard removes the row.
//
// Ambiguity seed: NO active cow has current tag '9123', but TWO active cows
// carry a non-import old_tags entry '9123' — 2+ rows in the winning
// (old-tags) tier = ambiguous under the migration 110/112 matching rules.
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

// Two ACTIVE cows whose old_tags both carry '9123' with a non-import source.
// Current tags are non-digit so the current-tag tier can never win.
async function seedAmbiguousTagCows(supabaseAdmin) {
  for (const [id, tag] of [
    ['cow-amb-a', 'AMB-A'],
    ['cow-amb-b', 'AMB-B'],
  ]) {
    const {error} = await supabaseAdmin.from('cattle').upsert(
      {
        id,
        tag,
        herd: 'backgrounders',
        sex: 'steer',
        old_tags: [{tag: '9123', source: 'manual'}],
        deleted_at: null,
        deleted_by: null,
        processing_batch_id: null,
      },
      {onConflict: 'id'},
    );
    if (error) throw new Error(`seedAmbiguousTagCows(${id}): ${error.message}`);
  }
}

async function waitForLogLoaded(page) {
  await expect(page.locator('[data-cattle-log-loaded="1"]')).toBeVisible({timeout: 15_000});
}

const COMPOSER_TEXTAREA = '[data-cattle-log-composer="1"] [data-mention-textarea="1"]';

test('offline submit with a server-ambiguous tag goes needs-attention on replay; Retry re-fails; Discard clears', async ({
  page,
  context,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(120_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);
  await seedAmbiguousTagCows(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  // Offline: the calf-note/ambiguity preview gate does not apply.
  await context.setOffline(true);
  const body = 'Check the swollen eye on #9123 today';
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  await page.locator('[data-cattle-log-submit="1"]').click();

  await expect(page.getByText('when you reconnect', {exact: false})).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-cattle-log-queued-row]')).toBeVisible({timeout: 10_000});

  const queued = await readCattleLogQueue(page);
  expect(queued).toHaveLength(1);
  expect(queued[0].status).toBe('queued');
  const csid = queued[0].csid;

  // Reconnect → replay → server raises CATTLE_LOG_AMBIGUOUS_TAG → the row
  // flips to needs_attention (deterministic failure; never silently dropped).
  await context.setOffline(false);

  const attentionRow = page.locator(`[data-cattle-log-needs-attention-row="${csid}"]`);
  await expect(attentionRow).toBeVisible({timeout: 20_000});
  await expect(attentionRow).toContainText('NEEDS ATTENTION');
  // Field-facing copy (raw classifier class stays in IDB, asserted below).
  await expect(attentionRow).toContainText('Tag matches multiple animals');
  await expect(attentionRow).toContainText('9123');
  await expect(attentionRow).toContainText(body);

  await expect
    .poll(
      async () => {
        const rows = await readCattleLogQueue(page);
        return rows.length === 1 ? {status: rows[0].status, errorClass: rows[0].errorClass} : null;
      },
      {timeout: 10_000},
    )
    .toEqual({status: 'needs_attention', errorClass: 'ambiguous_tag'});

  // Nothing landed server-side.
  const {data: dbRows, error: dbErr} = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('entity_type', 'cattle.log');
  expect(dbErr).toBeNull();
  expect(dbRows).toHaveLength(0);

  // Retry replays immediately and deterministically fails again — the row
  // returns to needs_attention rather than wedging in queued/syncing.
  await attentionRow.locator(`[data-cattle-log-queue-retry="${csid}"]`).click();
  await expect
    .poll(
      async () => {
        const rows = await readCattleLogQueue(page);
        return rows.length === 1 ? rows[0].status : null;
      },
      {timeout: 20_000},
    )
    .toBe('needs_attention');
  await expect(page.locator(`[data-cattle-log-needs-attention-row="${csid}"]`)).toBeVisible({timeout: 10_000});

  const {data: stillEmpty} = await supabaseAdmin.from('comments').select('id').eq('entity_type', 'cattle.log');
  expect(stillEmpty).toHaveLength(0);

  // Discard removes the row + queue record (operator-resolved dead letter).
  await page.locator(`[data-cattle-log-queue-discard="${csid}"]`).click();
  await expect(page.locator(`[data-cattle-log-needs-attention-row="${csid}"]`)).toHaveCount(0, {timeout: 10_000});
  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 10_000}).toBe(0);

  // Still nothing server-side after a reload (the discard was final).
  await page.reload();
  await waitForLogLoaded(page);
  await expect(page.locator('[data-cattle-log-needs-attention-row]')).toHaveCount(0);
  const {data: finalRows} = await supabaseAdmin.from('comments').select('id').eq('entity_type', 'cattle.log');
  expect(finalRows).toHaveLength(0);
});
