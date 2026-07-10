// Processing Calendar — browser TEST proof (processing-complete lane).
//
// Seeds planner sources + native processing rows via the service-role admin
// client (bypasses deny-all RLS), then drives the real /processing page as the
// authenticated admin. Covers:
//   1. load + grouping + drawer + gated completion (original proof, now with a
//      REAL planner source so the automatic freshness reconcile re-stamps the
//      seeded row instead of archiving it);
//   2. AUTOMATIC planner freshness — a new cattle batch seeded ONLY in the
//      planner source table appears on /processing on plain page load, no
//      admin maintenance action (WS1);
//   3. milestone lifecycle — create with assignee + initial status, explicit
//      date clear, delete;
//   4. template-driven Details fields — typed local edit persists; subtask
//      add + reorder; Apply template stays additive;
//   5. attachments — native upload appears; archive → hidden; admin
//      Show-archived → Restore.
// Shared TEST DB: run this file ALONE (resetDb truncates shared tables), and
// do NOT relaunch it back-to-back: an aborted invocation's TRUNCATE/reconcile
// RPCs keep executing server-side after the client disconnects and can land
// mid-way through the next invocation's seeds (records vanish, links wiped by
// the CASCADE). Give the previous run ~30s to drain before re-running.
import {test, expect} from './fixtures.js';
import {defaultProcessingTemplateSuite} from '../src/lib/processingFields.js';

const BATCH_ID = 'ptest-batch-1';
const SUB_ID = 'ptest-sub-1';
const MILE_ID = 'ptest-mile-1';
const SRC_ID = 'srctest-1';

async function adminProfileId(supabaseAdmin) {
  const {data: prof, error} = await supabaseAdmin.from('profiles').select('id').eq('role', 'admin').limit(1).single();
  expect(error, error && error.message).toBeFalsy();
  return prof.id;
}

// Force the next /processing load to run the automatic planner reconcile
// (ensure_processing_freshness debounces on this stamp). Use ONLY in tests
// that seed planner-backed rows: their first load performs the reconcile
// synchronously before the loaded-marker, so it can never trail into the next
// test's TRUNCATE (deadlock) or sweep the next test's seeds.
async function resetFreshnessStamp(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: null})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
}

// The opposite: pin the stamp FRESH so page loads in this test SKIP the
// reconcile entirely. For tests whose seeds are sweep-immune (milestones,
// asana_historical records) a reconcile is pure noise — and a stale stamp from
// an earlier file/run would otherwise fire one mid-test.
async function stampFreshnessNow(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: new Date().toISOString()})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
}

// Open /processing and wait for the given locator, reloading up to three times.
// ensure_processing_freshness legitimately BUSY-skips when another session's
// reconcile is mid-flight (an aborted previous page's RPC keeps running
// server-side) — the product contract is "fresh by the next load", so the test
// mirrors that instead of failing on the skip window.
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

// Seed a REAL cattle planner batch + its bridged processing row (same source
// key), so the on-load reconcile re-stamps the row (update branch) and the
// fixed id + any seeded subtasks survive.
async function seedCattleBatchWithProcessingRow(supabaseAdmin, adminId) {
  const {error: srcErr} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: SRC_ID,
      name: 'TEST Cattle Steers',
      planned_process_date: '2026-09-15',
      status: 'scheduled',
    },
    {onConflict: 'id'},
  );
  expect(srcErr, srcErr && srcErr.message).toBeFalsy();
  const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
    {
      id: BATCH_ID,
      record_type: 'planner_batch',
      program: 'cattle',
      title: 'TEST Cattle Steers',
      processing_date: '2026-09-15',
      status: 'planned',
      source_kind: 'cattle',
      source_id: SRC_ID,
      number_processed: 3,
      created_by: adminId,
    },
    {onConflict: 'id'},
  );
  expect(recErr, recErr && recErr.message).toBeFalsy();
}

test.describe('Processing Calendar', () => {
  test('loads, groups by program, opens the drawer with subtasks + a gated completion, admin controls visible', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);

    const {error: mileErr} = await supabaseAdmin.from('processing_records').upsert(
      {
        id: MILE_ID,
        record_type: 'milestone',
        program: 'pig',
        title: 'TEST Pig Milestone',
        processing_date: '2026-08-01',
        status: 'planned',
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(mileErr, mileErr && mileErr.message).toBeFalsy();

    const {error: subErr} = await supabaseAdmin.from('processing_subtasks').upsert(
      {
        id: SUB_ID,
        record_id: BATCH_ID,
        label: 'TEST cut list',
        done: false,
        completed_at: null,
        sort_order: 1,
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(subErr, subErr && subErr.message).toBeFalsy();

    await resetFreshnessStamp(supabaseAdmin);
    await gotoProcessingExpecting(page, '[data-processing-section="cattle"]');

    // Grouped by program — both seeded programs render a section.
    await expect(page.locator('[data-processing-section="cattle"]')).toBeVisible();
    await expect(page.locator('[data-processing-section="pig"]')).toBeVisible();

    // Both seeded rows are visible; admin sees the Add-milestone control, and
    // the maintenance panel holds Templates.
    const row = page.locator(`[data-processing-row="${BATCH_ID}"]`);
    await expect(row).toBeVisible();
    await expect(page.locator(`[data-processing-row="${MILE_ID}"]`)).toBeVisible();
    await expect(page.locator('[data-processing-add-milestone-btn]')).toBeVisible();
    await page.locator('[data-processing-admin-toggle]').click();
    await expect(page.locator('[data-processing-templates-btn]')).toBeVisible();
    await page.locator('[data-processing-admin-toggle]').click();

    // Row shows the read-only completion indicator + checklist meta.
    await expect(row.locator('[data-processing-row-check="open"]')).toHaveCount(1);
    await expect(row).toContainText('1-step checklist');

    // Open the drawer.
    await row.click();
    const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
    await expect(drawer).toBeVisible();

    // Subtask renders inside the drawer.
    await expect(page.locator(`[data-processing-subtask="${SUB_ID}"]`)).toBeVisible();

    // Completion is gated: processor missing + an open subtask ⇒ Mark complete
    // is present but disabled (the blocker list is what disables it).
    const markBtn = page.locator('[data-processing-mark-complete]');
    await expect(markBtn).toBeVisible();
    await expect(markBtn).toBeDisabled();
  });

  test('AUTOMATIC planner freshness: a new planner batch appears on plain page load (no admin action)', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    // Seed ONLY the planner source — no processing_records row exists for it.
    const {error: srcErr} = await supabaseAdmin.from('cattle_processing_batches').upsert(
      {
        id: 'srctest-fresh-1',
        name: 'TEST Fresh Steers',
        planned_process_date: '2026-10-20',
        status: 'scheduled',
      },
      {onConflict: 'id'},
    );
    expect(srcErr, srcErr && srcErr.message).toBeFalsy();
    await resetFreshnessStamp(supabaseAdmin);

    await gotoProcessingExpecting(page, '[data-processing-section="cattle"]');

    // The batch was bridged into Processing by the on-load reconcile.
    await expect(page.locator('[data-processing-section="cattle"]')).toBeVisible();
    await expect(page.getByText('TEST Fresh Steers')).toBeVisible();
  });

  test('milestone lifecycle: create with assignee + status, explicit date clear, delete', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await stampFreshnessNow(supabaseAdmin);
    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');

    await page.locator('[data-processing-add-milestone-btn]').click();
    await page.locator('[data-processing-milestone-program="sheep"]').click();
    await page.locator('[data-processing-milestone-name]').fill('TEST Lamb marker');
    await page.locator('[data-processing-milestone-date]').fill('2026-11-05');
    await page.locator('[data-processing-milestone-status="in_process"]').click();
    // Assignee dropdown is profile-backed; pick the first real profile if any.
    const assigneeSelect = page.locator('[data-processing-milestone-assignee]');
    const optionCount = await assigneeSelect.locator('option').count();
    if (optionCount > 1) await assigneeSelect.selectOption({index: 1});
    await page.locator('[data-processing-milestone-create]').click();

    // Creation opens the new milestone's drawer; it reads In Process.
    const drawer = page.locator('[data-processing-drawer]');
    await expect(drawer).toBeVisible();
    await expect(page.locator('[data-processing-milestone-status]')).toHaveValue('in_process');

    // Explicit date clear: empty the date input and blur.
    const dateInput = page.locator('[data-processing-milestone-date]');
    await dateInput.fill('');
    await dateInput.blur();
    await expect(dateInput).toHaveValue('');

    // Delete the milestone (confirm flow) — the drawer closes.
    await page.locator('[data-processing-milestone-delete]').click();
    await page.locator('[data-processing-milestone-delete-confirm]').click();
    await expect(drawer).toHaveCount(0);
  });

  test('template-driven Details: typed local field edit persists; subtasks add + reorder; Apply template additive', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);

    // Active cattle template: one local number field + one local date field +
    // a one-step checklist for the additive Apply.
    const {error: tplErr} = await supabaseAdmin.from('processing_templates').upsert(
      {
        id: 'ptest-tpl-1',
        program: 'cattle',
        version: 1,
        fields: [
          {id: 'condemned', name: 'Condemed', type: 'number'},
          {id: 'farmArrival', name: 'Farm Arrival Date', type: 'date'},
        ],
        checklist: [{label: 'TEST template step', assignee: null}],
        is_active: true,
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(tplErr, tplErr && tplErr.message).toBeFalsy();

    await resetFreshnessStamp(supabaseAdmin);
    await gotoProcessingExpecting(page, `[data-processing-row="${BATCH_ID}"]`);
    await page.locator(`[data-processing-row="${BATCH_ID}"]`).click();
    await expect(page.locator(`[data-processing-drawer="${BATCH_ID}"]`)).toBeVisible();

    // Details section renders the template fields; edit the number field.
    await expect(page.locator('[data-processing-details-section]')).toBeVisible();
    const condemned = page.locator('[data-processing-field-input="condemned"]');
    await condemned.fill('4');
    await condemned.blur();
    // runMutation persists then reloads the drawer — poll the DB for the
    // committed value (the input can briefly show the pre-commit draft).
    await expect
      .poll(
        async () => {
          const {data: recRow} = await supabaseAdmin
            .from('processing_records')
            .select('fields')
            .eq('id', BATCH_ID)
            .single();
          return recRow && recRow.fields ? recRow.fields.condemned : undefined;
        },
        {timeout: 10_000},
      )
      .toBe(4);
    await expect(page.locator('[data-processing-field-input="condemned"]')).toHaveValue('4');

    // Add two subtasks, then reorder with the arrows.
    const addInput = page.locator('[data-processing-add-subtask]');
    await addInput.fill('Step A');
    await addInput.press('Enter');
    await expect(page.locator('[data-processing-subtask]')).toHaveCount(1);
    await addInput.fill('Step B');
    await addInput.press('Enter');
    await expect(page.locator('[data-processing-subtask]')).toHaveCount(2);
    const firstSub = page.locator('[data-processing-subtask]').first();
    await expect(firstSub).toContainText('Step A');
    const secondId = await page.locator('[data-processing-subtask]').nth(1).getAttribute('data-processing-subtask');
    await page.locator(`[data-processing-subtask-up="${secondId}"]`).click();
    await expect(page.locator('[data-processing-subtask]').first()).toContainText('Step B');

    // Apply template adds ONLY the missing step (additive).
    await page.getByRole('button', {name: 'Apply template'}).click();
    await expect(page.locator('[data-processing-subtask]')).toHaveCount(3);
    await expect(page.getByText('TEST template step')).toBeVisible();
  });

  test('conversation fidelity (B-26-04 equivalent): imported media comments render author/timestamp/thumbnail; attachments index shares the bytes', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    const REC = 'ptest-b2604';
    const TASK = 'ptest-task-b2604';
    // 1x1 JPEG (valid image bytes for real thumbnails).
    const JPG = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    );

    // Seed the record + link. PROD B-26-04 is a planner_batch; here the record
    // is asana_historical so the on-load planner reconcile can't archive it
    // (no live ppp-v4 source exists on TEST) — the comments/attachments
    // behavior under test is identical for both record types.
    const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
      {
        id: REC,
        record_type: 'asana_historical',
        program: 'broiler',
        title: 'TEST B-26-04',
        processing_date: '2026-03-20',
        status: 'planned',
        match_status: 'unmatched',
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(recErr, recErr && recErr.message).toBeFalsy();
    const link = await supabaseAdmin.rpc('link_asana_to_processing', {
      p_row: {asana_gid: TASK, processing_record_id: REC, match_status: 'matched', match_method: 'manual_crosswalk'},
    });
    expect(link.error, link.error && link.error.message).toBeFalsy();

    // comments is a SHARED table resetDb intentionally does not truncate —
    // clear this test's imported gids from any earlier run so the insert paths
    // are exercised deterministically.
    await supabaseAdmin
      .from('comments')
      .delete()
      .in('asana_comment_gid', ['ptest-story-text', 'ptest-story-jpg-1', 'ptest-story-jpg-2']);

    // The existing Ronnie text comment (sync_comments shape).
    const textCmt = await supabaseAdmin.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: TASK,
        asana_comment_gid: 'ptest-story-text',
        body: 'Processor confirmed for Friday',
        original_author_name: 'Ronnie Jones',
        created_at: '2026-02-07T14:48:22Z',
      },
    });
    expect(textCmt.error, textCmt.error && textCmt.error.message).toBeFalsy();

    // Two Brian Naide file-only JPG posts: bytes once into the private bucket
    // at the stable Asana-gid paths, then the atomic comment-media RPC.
    for (const n of [1, 2]) {
      const gid = `ptest-att-jpg-${n}`;
      const storagePath = `${TASK}/${gid}-kill-sheet-${n}.jpg`;
      const up = await supabaseAdmin.storage
        .from('processing-attachments')
        .upload(storagePath, JPG, {contentType: 'image/jpeg', upsert: true});
      expect(up.error, up.error && up.error.message).toBeFalsy();
      const media = await supabaseAdmin.rpc('record_processing_comment_media', {
        p_row: {
          parent_asana_gid: TASK,
          asana_comment_gid: `ptest-story-jpg-${n}`,
          body: '',
          original_author_name: 'Brian Naide',
          created_at: `2026-07-08T15:0${n}:00Z`,
          mentions: [],
          attachments: [
            {
              asana_attachment_gid: gid,
              filename: `kill-sheet-${n}.jpg`,
              content_type: 'image/jpeg',
              size_bytes: JPG.length,
              storage_path: storagePath,
              original_created_at: `2026-07-08T15:0${n}:00Z`,
            },
          ],
        },
      });
      expect(media.error, media.error && media.error.message).toBeFalsy();
      expect(media.data.comment_action).toBe('inserted');
    }
    // Idempotency: re-running the first import changes nothing.
    const rerun = await supabaseAdmin.rpc('record_processing_comment_media', {
      p_row: {
        parent_asana_gid: TASK,
        asana_comment_gid: 'ptest-story-jpg-1',
        body: '',
        original_author_name: 'Brian Naide',
        created_at: '2026-07-08T15:01:00Z',
        mentions: [],
        attachments: [
          {
            asana_attachment_gid: 'ptest-att-jpg-1',
            filename: 'kill-sheet-1.jpg',
            content_type: 'image/jpeg',
            size_bytes: JPG.length,
            storage_path: `${TASK}/ptest-att-jpg-1-kill-sheet-1.jpg`,
            original_created_at: '2026-07-08T15:01:00Z',
          },
        ],
      },
    });
    expect(rerun.data.comment_action).toBe('reused');
    expect(rerun.data.attachments_inserted).toBe(0);

    try {
      await stampFreshnessNow(supabaseAdmin);
      // Direct evidence on flake: the row must exist (and be unarchived) in the
      // DB before we even navigate.
      const {data: preNav} = await supabaseAdmin
        .from('processing_records')
        .select('id, archived, processing_date, program')
        .eq('id', REC)
        .single();
      expect(preNav, 'seeded record must exist in DB pre-goto: ' + JSON.stringify(preNav)).toBeTruthy();
      expect(preNav.archived).toBe(false);
      await gotoProcessingExpecting(page, `[data-processing-row="${REC}"]`);
      await page.locator(`[data-processing-row="${REC}"]`).click();
      const drawer = page.locator(`[data-processing-drawer="${REC}"]`);
      await expect(drawer).toBeVisible();

      // Comments: the Ronnie text comment + BOTH Brian JPG posts, original
      // authors visible, image thumbnails signed + rendered full-size links.
      await expect(drawer.getByText('Processor confirmed for Friday')).toBeVisible();
      await expect(drawer.getByText('Ronnie Jones')).toBeVisible();
      await expect(drawer.getByText('Brian Naide')).toHaveCount(2);
      const thumbs = drawer.locator('[data-comment-attachment] img');
      await expect(thumbs).toHaveCount(2);
      // Signed full-size open: the anchor carries a real signed URL.
      const href = await drawer.locator('[data-comment-attachment]').first().getAttribute('href');
      expect(href).toMatch(/^https?:\/\/.+token=/);

      // Attachments index shows the SAME two files (same stored objects).
      await expect(drawer.locator('[data-processing-attachment]')).toHaveCount(2);
      const {data: attRows} = await supabaseAdmin
        .from('processing_attachments')
        .select('storage_path, comment_id, asana_story_gid')
        .eq('record_id', REC)
        .order('storage_path');
      expect(attRows.map((a) => a.storage_path)).toEqual([
        `${TASK}/ptest-att-jpg-1-kill-sheet-1.jpg`,
        `${TASK}/ptest-att-jpg-2-kill-sheet-2.jpg`,
      ]);
      expect(attRows.every((a) => a.comment_id && a.asana_story_gid)).toBe(true);
      const {data: mediaCmts} = await supabaseAdmin
        .from('comments')
        .select('attachments')
        .in('asana_comment_gid', ['ptest-story-jpg-1', 'ptest-story-jpg-2']);
      const commentPaths = mediaCmts.flatMap((c) => c.attachments.map((a) => a.path)).sort();
      expect(commentPaths).toEqual(attRows.map((a) => a.storage_path)); // same objects, zero duplicate bytes

      // No duplicates: exactly 3 comments total after the rerun.
      const {count} = await supabaseAdmin
        .from('comments')
        .select('id', {count: 'exact', head: true})
        .eq('entity_id', REC);
      expect(count).toBe(3);
    } finally {
      const {data: objs} = await supabaseAdmin.storage.from('processing-attachments').list(TASK);
      if (objs && objs.length) {
        await supabaseAdmin.storage.from('processing-attachments').remove(objs.map((o) => `${TASK}/${o.name}`));
      }
    }
  });

  test('template suite: all four programs render template Details; Processor is a true select with legacy visibility', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);

    // Seed the CANONICAL suite (same JSON migration 172 seeds) as the active
    // template for every program.
    const suite = defaultProcessingTemplateSuite();
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const {error} = await supabaseAdmin.from('processing_templates').upsert(
        {
          id: `ptpl-default-${program}`,
          program,
          version: 1,
          fields: suite[program].fields,
          checklist: suite[program].checklist,
          is_active: true,
          created_by: adminId,
        },
        {onConflict: 'id'},
      );
      expect(error, error && error.message).toBeFalsy();
    }

    // Known processor choices (restore the shared singleton afterwards).
    const {data: baseSettings} = await supabaseAdmin
      .from('processing_asana_sync_settings')
      .select('processor_options')
      .eq('id', 'singleton')
      .single();
    await supabaseAdmin
      .from('processing_asana_sync_settings')
      .update({processor_options: ['Atlanta Poultry Processing', 'Springer Mountain']})
      .eq('id', 'singleton');

    try {
      // One historical record per program; the broiler one carries a LEGACY
      // off-list processor that must remain visible in the select.
      const rows = ['broiler', 'cattle', 'pig', 'sheep'].map((program) => ({
        id: `ptest-suite-${program}`,
        record_type: 'asana_historical',
        program,
        title: `TEST Suite ${program}`,
        processing_date: '2026-04-01',
        status: 'planned',
        processor: program === 'broiler' ? 'Old Legacy Processors LLC' : null,
        match_status: 'unmatched',
        created_by: adminId,
      }));
      const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(rows, {onConflict: 'id'});
      expect(recErr, recErr && recErr.message).toBeFalsy();

      await resetFreshnessStamp(supabaseAdmin);
      await page.goto('/processing');
      await page.waitForSelector('[data-processing-loaded="1"]');

      // Every program's record opens with template-driven Details (Condemed is
      // a template field on all four programs).
      for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
        await page.locator(`[data-processing-row="ptest-suite-${program}"]`).click();
        const drawer = page.locator(`[data-processing-drawer="ptest-suite-${program}"]`);
        await expect(drawer).toBeVisible();
        await expect(drawer.locator('[data-processing-details-section]')).toBeVisible();
        await expect(drawer.locator('[data-processing-field-input="condemned"]')).toBeVisible();
        // Customer chips are broiler-only (no duplicate/ghost row elsewhere).
        if (program === 'broiler') {
          await expect(drawer.locator('[data-processing-customer-chip]').first()).toBeVisible();
        } else {
          await expect(drawer.locator('[data-processing-customer-chip]')).toHaveCount(0);
        }
        // Processor is a TRUE SELECT — arbitrary typing impossible by element type.
        const procSelect = drawer.locator('[data-processing-processor-select]');
        await expect(procSelect).toBeVisible();
        expect(await procSelect.evaluate((el) => el.tagName)).toBe('SELECT');
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
      }

      // Legacy visibility + configured save + clearing on the broiler record.
      await page.locator('[data-processing-row="ptest-suite-broiler"]').click();
      const drawer = page.locator('[data-processing-drawer="ptest-suite-broiler"]');
      const procSelect = drawer.locator('[data-processing-processor-select]');
      await expect(procSelect).toHaveValue('Old Legacy Processors LLC');
      await expect(procSelect.locator('option', {hasText: 'Old Legacy Processors LLC (legacy)'})).toHaveCount(1);
      // Pick a configured choice — persists server-side.
      await procSelect.selectOption('Springer Mountain');
      await expect
        .poll(async () => {
          const {data} = await supabaseAdmin
            .from('processing_records')
            .select('processor')
            .eq('id', 'ptest-suite-broiler')
            .single();
          return data.processor;
        })
        .toBe('Springer Mountain');
      // The legacy value was deliberately replaced — it leaves the choices.
      await expect(procSelect.locator('option', {hasText: '(legacy)'})).toHaveCount(0);
      // Clearing works ('—').
      await procSelect.selectOption('');
      await expect
        .poll(async () => {
          const {data} = await supabaseAdmin
            .from('processing_records')
            .select('processor')
            .eq('id', 'ptest-suite-broiler')
            .single();
          return data.processor;
        })
        .toBeNull();
    } finally {
      await supabaseAdmin
        .from('processing_asana_sync_settings')
        .update({processor_options: baseSettings.processor_options})
        .eq('id', 'singleton');
    }
  });

  test('attachments upload + archive/restore round-trip', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    // An Asana-historical record: archivable, and never swept by the reconcile.
    const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
      {
        id: 'ptest-hist-1',
        record_type: 'asana_historical',
        program: 'broiler',
        title: 'TEST Historical Broilers',
        processing_date: '2026-03-02',
        status: 'complete',
        completed_at: '2026-03-02T12:00:00Z',
        match_status: 'unmatched',
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(recErr, recErr && recErr.message).toBeFalsy();

    await stampFreshnessNow(supabaseAdmin);
    const {data: preNav} = await supabaseAdmin
      .from('processing_records')
      .select('id, archived')
      .eq('id', 'ptest-hist-1')
      .single();
    expect(preNav, 'seeded record must exist in DB pre-goto').toBeTruthy();
    expect(preNav.archived).toBe(false);
    await gotoProcessingExpecting(page, '[data-processing-row="ptest-hist-1"]');
    await page.locator('[data-processing-row="ptest-hist-1"]').click();
    const drawer = page.locator('[data-processing-drawer="ptest-hist-1"]');
    await expect(drawer).toBeVisible();

    // Native upload through the Add files picker (the drawer also mounts the
    // shared CommentsSection attach input — scope to the attachments one).
    const fileInput = drawer.locator('input[aria-label="Add attachment files"]');
    await fileInput.setInputFiles({name: 'kill-sheet.txt', mimeType: 'text/plain', buffer: Buffer.from('test bytes')});
    await expect(drawer.locator('[data-processing-attachment]')).toHaveCount(1);
    await expect(drawer.getByText('kill-sheet.txt')).toBeVisible();

    // Archive → row leaves the calendar.
    await page.locator('[data-processing-record-archive]').click();
    await page.locator('[data-processing-record-archive-confirm]').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('[data-processing-row="ptest-hist-1"]')).toHaveCount(0);

    // Admin maintenance: Show archived → open → Restore.
    await page.locator('[data-processing-admin-toggle]').click();
    await page.locator('[data-processing-show-archived]').check();
    await page.waitForSelector('[data-processing-loaded="1"]');
    const archivedRow = page.locator('[data-processing-row="ptest-hist-1"]');
    await expect(archivedRow).toBeVisible();
    await archivedRow.click();
    await page.locator('[data-processing-record-restore]').click();
    await expect(page.locator('[data-processing-record-restore]')).toHaveCount(0);
    const {data: restored} = await supabaseAdmin
      .from('processing_records')
      .select('archived')
      .eq('id', 'ptest-hist-1')
      .single();
    expect(restored.archived).toBe(false);

    // Cleanup the uploaded object (shared TEST bucket hygiene).
    const {data: objs} = await supabaseAdmin.storage.from('processing-attachments').list('native/ptest-hist-1');
    if (objs && objs.length) {
      await supabaseAdmin.storage
        .from('processing-attachments')
        .remove(objs.map((o) => `native/ptest-hist-1/${o.name}`));
    }
  });
});
