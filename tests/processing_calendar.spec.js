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
// Shared TEST DB: run this file ALONE (resetDb truncates shared tables).
import {test, expect} from './fixtures.js';

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
// (ensure_processing_freshness debounces on this stamp).
async function resetFreshnessStamp(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: null})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
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
    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');

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

    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');

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
    await resetFreshnessStamp(supabaseAdmin);
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
    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');
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

    await resetFreshnessStamp(supabaseAdmin);
    await page.goto('/processing');
    await page.waitForSelector('[data-processing-loaded="1"]');
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
