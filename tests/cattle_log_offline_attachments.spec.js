import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Log — offline attachments (blob persistence + replay uploads).
// ============================================================================
// Offline submits persist attachment Blobs in IndexedDB ('photo_blobs',
// keyed by the deterministic comment-photos path
// 'cattle.log/cattle-log/<entryId>/<index>-<sanitizedName>'). Replay uploads
// each blob (upsert:false, duplicate-object counts as success), persists
// uploadedPaths after EACH upload, then calls the idempotent RPC with the
// uploaded paths as p_attachments.
//
//   1  Offline submit with an image → reconnect → blob uploads, RPC lands,
//      entry renders with the attachment; storage object + comments
//      attachments path verified.
//   2  Partial-replay resume: replay with the RPC blocked uploads the blob
//      (uploadedPaths persisted) but stays queued (transient); the next
//      replay pass completes the RPC WITHOUT re-uploading (zero additional
//      storage POSTs — request-counter assertion).
//
// Simplification note (allowed by the lane brief): test 2 fails the replay
// AFTER the upload via an RPC route abort, rather than failing the upload
// itself — the upload-resume bookkeeping (uploadedPaths skip) is what's
// load-bearing and is asserted directly.
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;

const DB_NAME = 'wcf-offline-queue';

// Known-good 1x1 PNG that Chromium's createImageBitmap reliably decodes
// (compressImage re-encodes it to JPEG at queue time).
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tinyImageFile(name) {
  return {name, mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64')};
}

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

async function readPhotoBlobCount(page, csid) {
  return await page.evaluate(
    ({dbName, target}) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('photo_blobs')) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction('photo_blobs', 'readonly');
          const all = tx.objectStore('photo_blobs').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.filter((r) => r.csid === target && r.blob).length);
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    {dbName: DB_NAME, target: csid},
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
const COMPOSER_FILE_INPUT = '[data-cattle-log-composer="1"] input[type="file"]';

// Queue one image-carrying entry while offline; returns {csid, key}.
async function queueOfflineEntryWithImage(page, context, body) {
  await context.setOffline(true);
  await page.locator(COMPOSER_FILE_INPUT).setInputFiles([tinyImageFile('calf.png')]);
  await expect(page.getByText('1 photo selected')).toBeVisible({timeout: 10_000});
  await page.locator(COMPOSER_TEXTAREA).fill(body);
  await page.locator('[data-cattle-log-submit="1"]').click();
  await expect(page.locator('[data-cattle-log-queued-row]')).toBeVisible({timeout: 10_000});

  const queue = await readCattleLogQueue(page);
  expect(queue).toHaveLength(1);
  const row = queue[0];
  expect(row.status).toBe('queued');
  const csid = row.csid;
  const metas = row.payload && Array.isArray(row.payload.attachments) ? row.payload.attachments : [];
  expect(metas).toHaveLength(1);
  // Deterministic comment-photos path: cattle.log/cattle-log/<entryId>/<idx>-<name>.
  expect(metas[0].key).toMatch(new RegExp(`^cattle\\.log/cattle-log/${csid}/0-`));
  expect(metas[0].is_image).toBe(true);
  // The compressed blob is persisted alongside the row.
  expect(await readPhotoBlobCount(page, csid)).toBe(1);
  return {csid, key: metas[0].key};
}

// --------------------------------------------------------------------------
// Test 1 — offline image submit → replay uploads then RPC
// --------------------------------------------------------------------------
test('offline submit with an image replays: blob uploads to comment-photos, RPC lands the entry', async ({
  page,
  context,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(120_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  const body = 'New scrape on the flank, photo attached';
  const {csid, key} = await queueOfflineEntryWithImage(page, context, body);

  // Nothing server-side while offline.
  const {data: preRows} = await supabaseAdmin.from('comments').select('id').eq('entity_type', 'cattle.log');
  expect(preRows).toHaveLength(0);

  // Reconnect → upload + RPC + markSynced (blob cascade-deleted).
  await context.setOffline(false);
  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 30_000}).toBe(0);
  expect(await readPhotoBlobCount(page, csid)).toBe(0);

  // Entry renders with the attachment thumb.
  const row = page.locator(`[data-cattle-log-row="${csid}"]`);
  await expect(row).toBeVisible({timeout: 15_000});
  await expect(row).toContainText(body);
  await expect(row.locator('[data-cattle-log-attachment]')).toHaveCount(1);

  // Comments row carries the deterministic path; the storage object exists.
  const {data: comments, error} = await supabaseAdmin.from('comments').select('attachments').eq('id', csid).single();
  expect(error).toBeNull();
  expect(Array.isArray(comments.attachments)).toBe(true);
  expect(comments.attachments).toHaveLength(1);
  expect(comments.attachments[0].path).toBe(key);
  expect(comments.attachments[0].is_image).toBe(true);

  const prefix = key.slice(0, key.lastIndexOf('/'));
  const fileName = key.slice(key.lastIndexOf('/') + 1);
  const {data: objects, error: listErr} = await supabaseAdmin.storage.from('comment-photos').list(prefix);
  expect(listErr).toBeNull();
  expect((objects || []).map((o) => o.name)).toContain(fileName);
});

// --------------------------------------------------------------------------
// Test 2 — failed replay after upload, then retry WITHOUT duplicate upload
// --------------------------------------------------------------------------
test('replay interrupted after the upload resumes without re-uploading (uploadedPaths skip)', async ({
  page,
  context,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(120_000);
  await resetDb();
  await clearCattleLogData(supabaseAdmin);
  await seedAdminProfile(supabaseAdmin);

  await page.goto('/cattle/log');
  await waitForLogLoaded(page);
  await wipeOfflineQueue(page);

  const body = 'Bald patch behind the ear, see photo';
  const {csid, key} = await queueOfflineEntryWithImage(page, context, body);

  // Count storage writes to the comment-photos bucket from here on. The
  // listener survives reloads (page-scoped, not document-scoped).
  let uploadPosts = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/storage/v1/object/comment-photos/')) uploadPosts += 1;
  });

  // Phase 1: block ONLY the submit RPC, then reconnect. Replay uploads the
  // blob (uploadedPaths persisted after the upload), the RPC aborts →
  // transient → the row STAYS queued for the next pass.
  await page.route('**/rest/v1/rpc/submit_cattle_log_entry**', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed');
    else await route.continue();
  });
  await context.setOffline(false);

  await expect
    .poll(
      async () => {
        const rows = await readCattleLogQueue(page);
        if (rows.length !== 1) return null;
        return {
          status: rows[0].status,
          uploaded: Array.isArray(rows[0].uploadedPaths) ? rows[0].uploadedPaths : [],
        };
      },
      {timeout: 30_000},
    )
    .toEqual({status: 'queued', uploaded: [key]});
  expect(uploadPosts).toBe(1);

  // Nothing landed (the RPC never ran) but the object is already in storage.
  const {data: preRows} = await supabaseAdmin.from('comments').select('id').eq('entity_type', 'cattle.log');
  expect(preRows).toHaveLength(0);

  // Phase 2: unblock and remount — the resumed replay must SKIP the upload
  // (key already in uploadedPaths) and only run the RPC.
  await page.unroute('**/rest/v1/rpc/submit_cattle_log_entry**');
  await page.reload();
  await waitForLogLoaded(page);

  await expect.poll(async () => (await readCattleLogQueue(page)).length, {timeout: 30_000}).toBe(0);
  expect(uploadPosts).toBe(1); // no duplicate upload across the two passes

  // Entry landed with the single deterministic attachment.
  await expect(page.locator(`[data-cattle-log-row="${csid}"]`)).toBeVisible({timeout: 15_000});
  const {data: comment, error} = await supabaseAdmin.from('comments').select('attachments').eq('id', csid).single();
  expect(error).toBeNull();
  expect(comment.attachments).toHaveLength(1);
  expect(comment.attachments[0].path).toBe(key);

  const prefix = key.slice(0, key.lastIndexOf('/'));
  const {data: objects, error: listErr} = await supabaseAdmin.storage.from('comment-photos').list(prefix);
  expect(listErr).toBeNull();
  expect(objects || []).toHaveLength(1);
});
