// ============================================================================
// REQUIRES supabase-migrations 191 (rename_processing_attachment) applied to the
// leased TEST project, on top of 156/163/166/185. Run this file ALONE (resetDb
// truncates shared processing tables); give a prior run ~30s to drain.
//
// GATING NOTE (CC#5 lane): this spec is the remaining BROWSER-PROOF gate. It has
// NOT been executed yet — it runs against TEST D through CC#6's focused-project
// runner once that runner is merged to main and this branch is rebased onto it.
// It touches NO shared fixture/config/reset/CI file.
// ============================================================================
// Processing attachment thumbnails + rename — browser TEST proof.
//
// Seeds a processing record as the service-role admin, then drives the real
// /processing drawer as the authenticated admin. Covers:
//   • existing native upload (picker) still works — used to seed a real JPEG
//     image row and a non-image text row;
//   • an IMAGE attachment renders an actual picture thumbnail (non-zero natural
//     dimensions) while a non-image keeps the document-glyph fallback;
//   • the thumbnail is clickable and opens a signed URL (private bucket);
//   • inline RENAME (operational role): edit → Save → the new filename is
//     server-authoritative after a drawer reload; storage_path is unchanged and
//     exactly one Storage object remains (metadata-only);
//   • a linked processing comment's attachment metadata name updates for the
//     exact bucket + storage_path;
//   • Activity records the rename with old + new filename;
//   • an unauthorized (anon) caller cannot invoke the RPC.
import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

const BUCKET = 'processing-attachments';
// A valid 1x1 JPEG so the browser can actually decode a thumbnail.
const JPG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

async function adminProfileId(supabaseAdmin) {
  const {data, error} = await supabaseAdmin.from('profiles').select('id').eq('role', 'admin').limit(1).single();
  expect(error, error && error.message).toBeFalsy();
  return data.id;
}

async function stampFreshnessNow(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: new Date().toISOString()})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
}

async function seedHistoricalRecord(supabaseAdmin, adminId, {id, program, title, date}) {
  const {error} = await supabaseAdmin.from('processing_records').upsert(
    {
      id,
      record_type: 'asana_historical',
      program,
      title,
      processing_date: date,
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    },
    {onConflict: 'id'},
  );
  expect(error, error && error.message).toBeFalsy();
}

async function gotoProcessingExpecting(page, selector) {
  await page.goto('/processing');
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForSelector('[data-processing-loaded="1"]');
    if ((await page.locator(selector).count()) > 0) return;
    await page.waitForTimeout(1500);
    await page.reload();
  }
  await expect(page.locator(selector).first()).toBeVisible();
}

test.describe('Processing attachment thumbnails + rename', () => {
  test('image thumbnail renders, is signed-clickable, and rename is metadata-only', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    const REC = 'ptest-att-thumb';
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: REC,
      program: 'broiler',
      title: 'TEST Attachment Thumbnails',
      date: '2026-03-10',
    });
    await stampFreshnessNow(supabaseAdmin);

    try {
      await gotoProcessingExpecting(page, `[data-processing-row="${REC}"]`);
      await page.locator(`[data-processing-row="${REC}"]`).click();
      const drawer = page.locator(`[data-processing-drawer="${REC}"]`);
      await expect(drawer).toBeVisible();

      // Seed via the REAL upload path (proves upload still works): one JPEG
      // image + one text document.
      const fileInput = drawer.locator('input[aria-label="Add attachment files"]');
      await fileInput.setInputFiles([
        {name: 'kill-sheet.jpg', mimeType: 'image/jpeg', buffer: JPG_1X1},
        {name: 'invoice.txt', mimeType: 'text/plain', buffer: Buffer.from('doc bytes')},
      ]);
      await expect(drawer.locator('[data-processing-attachment]')).toHaveCount(2);

      const {data: rows} = await supabaseAdmin
        .from('processing_attachments')
        .select('id, filename, storage_path, content_type')
        .eq('record_id', REC);
      const imgRow = rows.find((r) => r.content_type === 'image/jpeg');
      const docRow = rows.find((r) => r.filename === 'invoice.txt');
      expect(imgRow, 'image row seeded').toBeTruthy();
      expect(docRow, 'doc row seeded').toBeTruthy();

      const imgTile = drawer.locator(`[data-processing-attachment="${imgRow.id}"]`);
      const docTile = drawer.locator(`[data-processing-attachment="${docRow.id}"]`);

      // 1) IMAGE tile shows an actual decoded thumbnail (non-zero natural size).
      // Scroll the tile in so the lazy thumbnail intersects the viewport + loads.
      await imgTile.scrollIntoViewIfNeeded();
      const thumbImg = imgTile.locator('[data-processing-attachment-thumb="image"] img');
      await expect(thumbImg).toBeVisible();
      await expect.poll(async () => thumbImg.evaluate((el) => el.naturalWidth), {timeout: 15000}).toBeGreaterThan(0);

      // Non-image keeps the document glyph fallback (no <img> byte fetch).
      await expect(docTile.locator('[data-processing-attachment-thumb="icon"]')).toBeVisible();
      await expect(docTile.locator('[data-processing-attachment-thumb="image"]')).toHaveCount(0);

      // 2) Thumbnail is clickable and opens a SIGNED URL for the private object.
      const popupPromise = page.waitForEvent('popup');
      await imgTile.locator('[data-processing-attachment-open-thumb]').click();
      const popup = await popupPromise;
      expect(popup.url()).toContain(BUCKET);
      expect(popup.url()).toContain('token=');
      await popup.close();

      // Seed a linked processing comment whose attachment metadata points at the
      // exact bucket + storage_path (proves comment-name coherence on rename).
      const CMT = 'cmt-ptest-rename';
      await supabaseAdmin.from('comments').delete().eq('id', CMT);
      const {error: cmtErr} = await supabaseAdmin.from('comments').insert({
        id: CMT,
        entity_type: 'processing.record',
        entity_id: REC,
        author_profile_id: adminId,
        body: 'kill sheet attached',
        attachments: [
          {bucket: BUCKET, path: imgRow.storage_path, name: 'kill-sheet.jpg', mime: 'image/jpeg', is_image: true},
        ],
      });
      expect(cmtErr, cmtErr && cmtErr.message).toBeFalsy();

      // 3) RENAME through the UI: edit → Enter to save.
      await imgTile.locator('[data-processing-attachment-rename]').click();
      const input = imgTile.locator('[data-processing-attachment-rename-input]');
      await expect(input).toBeVisible();
      await input.fill('Kill Sheet — March 2026.jpg');
      await input.press('Enter');

      // 4) After the drawer reloads, the new filename is shown (server truth).
      await expect(drawer.getByText('Kill Sheet — March 2026.jpg')).toBeVisible();
      await expect(drawer.getByText('kill-sheet.jpg')).toHaveCount(0);

      // Close + reopen the drawer to prove the name survives a full reload.
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await page.locator(`[data-processing-row="${REC}"]`).click();
      await expect(drawer.getByText('Kill Sheet — March 2026.jpg')).toBeVisible();

      // DB truth: filename changed, storage_path UNCHANGED, one object remains.
      const {data: after} = await supabaseAdmin
        .from('processing_attachments')
        .select('filename, storage_path')
        .eq('id', imgRow.id)
        .single();
      expect(after.filename).toBe('Kill Sheet — March 2026.jpg');
      expect(after.storage_path).toBe(imgRow.storage_path);

      const {data: objs} = await supabaseAdmin.storage.from(BUCKET).list(`native/${REC}`);
      const keys = (objs || []).map((o) => `native/${REC}/${o.name}`);
      expect(keys).toContain(imgRow.storage_path); // same object, not moved/copied
      expect(keys.length).toBe(2); // image + doc only; rename created no new object

      // 5) Linked comment attachment name updated for the exact bucket+path.
      const {data: cmt} = await supabaseAdmin.from('comments').select('attachments').eq('id', CMT).single();
      const entry = (cmt.attachments || []).find((e) => e.path === imgRow.storage_path);
      expect(entry.name).toBe('Kill Sheet — March 2026.jpg');

      // 6) Activity records the rename with old + new filename.
      const {data: acts} = await supabaseAdmin
        .from('activity_events')
        .select('event_type, payload')
        .eq('entity_type', 'processing.record')
        .eq('entity_id', REC);
      const renameAct = (acts || []).find((a) => a.payload && a.payload.action === 'rename_attachment');
      expect(renameAct, 'rename Activity emitted').toBeTruthy();
      expect(renameAct.payload.old_filename).toBe('kill-sheet.jpg');
      expect(renameAct.payload.new_filename).toBe('Kill Sheet — March 2026.jpg');
      expect(renameAct.payload.attachment_id).toBe(imgRow.id);

      // 7) An unauthorized (anon) caller cannot invoke the RPC.
      const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
      expect(anonKey, 'anon key available for the negative check').toBeTruthy();
      const anon = createClient(process.env.VITE_SUPABASE_URL, anonKey);
      const denied = await anon.rpc('rename_processing_attachment', {p_id: imgRow.id, p_filename: 'hacked.jpg'});
      expect(denied.error, 'anon must be denied').toBeTruthy();
      const {data: stillNamed} = await supabaseAdmin
        .from('processing_attachments')
        .select('filename')
        .eq('id', imgRow.id)
        .single();
      expect(stillNamed.filename).toBe('Kill Sheet — March 2026.jpg'); // unchanged by the denied call
    } finally {
      const {data: leftovers} = await supabaseAdmin.storage.from(BUCKET).list(`native/${REC}`);
      if (leftovers && leftovers.length) {
        await supabaseAdmin.storage.from(BUCKET).remove(leftovers.map((o) => `native/${REC}/${o.name}`));
      }
      await supabaseAdmin.from('comments').delete().eq('id', 'cmt-ptest-rename');
    }
  });
});
