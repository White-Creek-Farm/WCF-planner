// ============================================================================
// REQUIRES supabase-migrations 175-177 applied to TEST — run only after the
// gated apply; run this file ALONE.
// ============================================================================
// Processing Calendar — browser TEST proof (planner-integration lane).
//
// Seeds planner sources + native processing rows via the service-role admin
// client (bypasses deny-all RLS), then drives the real /processing page as the
// authenticated admin. Covers:
//   1. load + per-program sections + FIXED program column sets ('Count'
//      visible, 'Farm arrival' absent, broiler 'Hatch date', pig 'Trip');
//      direct Templates button, no Admin panel (UI-simplification survivals);
//   2. drawer — read-only Source details (live planner projection, WITHOUT
//      duplicate Processor/Customer rows) + source back-link; NO template-field
//      Details editor; subtask add; checklist toggle = dedicated NO-RELOAD path
//      (immediate check/uncheck, node-identity marks prove the drawer body and
//      schedule rows never unmount, narrow row count patch, silent
//      completion-blocker reconcile, RPC-failure rollback + inline error);
//      SERVER-gated completion: a future-dated record is blocked ('has not
//      begun') while a past-dated record with processor + positive count
//      completes only after its last open subtask is checked — and checking
//      that last subtask never auto-completes the record;
//      2b. checklist RACE (controlled RPC ordering): two toggles in flight,
//      the first succeeds while the second is held then fails — the schedule
//      row only ever shows CONFIRMED counts (the held toggle's optimism stays
//      drawer-local), the failed checkbox rolls back, and nothing reloads;
//   3. deep link — /processing?record=<id> opens that record's drawer;
//   4. milestone lifecycle — create with initial status, explicit date clear,
//      delete (attrs unchanged by this lane);
//   5. conversation fidelity (imported media comments — unchanged surface);
//   6. Customer + Processor TRUE selects over the mig-175 stable option
//      objects (inactive options withheld; legacy stored values surface);
//   7. Templates modal — CHECKLIST-ONLY checklist editing, preview pane, and
//      the Customer & processor choices editor which AUTOSAVES (no option
//      Save button; debounced rename, exactly-one-RPC add, deactivate/
//      reactivate, held-save queueing, surface-switch + close flush, failed
//      exit flush keeps the modal open, dropdowns update without reload);
//   8. attachments upload + archive hides the row from the schedule;
//   9. apply-template preview → confirm flow (additive, then up-to-date).
//
// Shared TEST DB: run this file ALONE (resetDb truncates shared tables), and
// do NOT relaunch it back-to-back: an aborted invocation's TRUNCATE/reconcile
// RPCs keep executing server-side after the client disconnects and can land
// mid-way through the next invocation's seeds (records vanish, links wiped by
// the CASCADE). Give the previous run ~30s to drain before re-running.
import {test, expect} from './fixtures.js';

const BATCH_ID = 'ptest-batch-1';
const SUB_ID = 'ptest-sub-1';
const MILE_ID = 'ptest-mile-1';
const SRC_ID = 'srctest-1';
const DONE_BATCH_ID = 'ptest-batch-done';
const DONE_SRC_ID = 'srctest-done';

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

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

// ── Shared-TEST-DB seeding resilience ────────────────────────────────────────
// A straggler reconcile/TRUNCATE from an earlier invocation or page load can
// keep executing server-side and transiently sweep rows THIS test just seeded
// (see the header note — the classic canary is a subtask insert FK-failing
// because its just-seeded record vanished). These helpers re-seed through that
// brief window; a real product failure still fails on every attempt.
// A swept record CASCADE-deletes its seeded subtasks, so the verifier checks
// the record AND every expected subtask, and the reseed callback must recreate
// the COMPLETE seed set (record + subtasks). Reseed callbacks tolerate
// transient upsert errors — this loop is the arbiter, and a real product
// failure still fails on every attempt.
async function ensureProcessingSeedStable(supabaseAdmin, recordId, subtaskIds, reseedAll) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const {data: rec} = await supabaseAdmin.from('processing_records').select('id').eq('id', recordId).maybeSingle();
    let ok = !!rec;
    if (ok && subtaskIds.length) {
      const {data: subs} = await supabaseAdmin.from('processing_subtasks').select('id').in('id', subtaskIds);
      ok = (subs || []).length === subtaskIds.length;
    }
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await reseedAll();
  }
  const {data: rec} = await supabaseAdmin.from('processing_records').select('id').eq('id', recordId).maybeSingle();
  expect(rec, `seeded processing record ${recordId} kept vanishing (shared-DB interference)`).toBeTruthy();
  if (subtaskIds.length) {
    const {data: subs} = await supabaseAdmin.from('processing_subtasks').select('id').in('id', subtaskIds);
    expect((subs || []).length, `seeded subtasks for ${recordId} kept vanishing`).toBe(subtaskIds.length);
  }
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
// fixed id + any seeded subtasks survive. cows_detail drives the live source
// count (completion gate: Count must be > 0).
async function seedCattleBatchWithProcessingRow(
  supabaseAdmin,
  adminId,
  {
    id = BATCH_ID,
    srcId = SRC_ID,
    name = 'TEST Cattle Steers',
    date = isoDaysFromNow(60),
    cowsDetail = [],
    processor = null,
  } = {},
) {
  const {error: srcErr} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: srcId,
      name,
      planned_process_date: date,
      status: 'scheduled',
      cows_detail: cowsDetail,
    },
    {onConflict: 'id'},
  );
  expect(srcErr, srcErr && srcErr.message).toBeFalsy();
  const {error: recErr} = await supabaseAdmin.from('processing_records').upsert(
    {
      id,
      record_type: 'planner_batch',
      program: 'cattle',
      title: name,
      processing_date: date,
      status: 'planned',
      source_kind: 'cattle',
      source_id: srcId,
      number_processed: cowsDetail.length,
      processor,
      created_by: adminId,
    },
    {onConflict: 'id'},
  );
  expect(recErr, recErr && recErr.message).toBeFalsy();
}

// Sweep-immune historical record (asana_historical is never enumerated or
// swept by the planner reconcile).
async function seedHistoricalRecord(supabaseAdmin, adminId, {id, program, title, date, extra = {}} = {}) {
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
      ...extra,
    },
    {onConflict: 'id'},
  );
  expect(error, error && error.message).toBeFalsy();
}

test.describe('Processing Calendar', () => {
  test('loads the FIXED per-program tables; direct Templates button, no Admin panel', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: 'ptest-hist-broiler',
      program: 'broiler',
      title: 'TEST Broiler Historical',
      date: '2026-03-02',
    });
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: 'ptest-hist-pig',
      program: 'pig',
      title: 'TEST Pig Historical',
      date: '2026-03-05',
    });
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: 'ptest-hist-sheep',
      program: 'sheep',
      title: 'TEST Sheep Historical',
      date: '2026-03-06',
    });

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

    const reseedTablesSeed = async () => {
      await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);
      await supabaseAdmin.from('processing_subtasks').upsert(
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
    };
    await reseedTablesSeed();
    await ensureProcessingSeedStable(supabaseAdmin, BATCH_ID, [SUB_ID], reseedTablesSeed);

    await resetFreshnessStamp(supabaseAdmin);
    await gotoProcessingExpecting(page, '[data-processing-section="cattle"]');

    // Grouped by program — every seeded program renders a section, in the
    // LOCKED order Broiler · Cattle · Sheep/Lamb · Pig.
    const cattleSection = page.locator('[data-processing-section="cattle"]');
    const pigSection = page.locator('[data-processing-section="pig"]');
    const broilerSection = page.locator('[data-processing-section="broiler"]');
    const sheepSection = page.locator('[data-processing-section="sheep"]');
    await expect(cattleSection).toBeVisible();
    await expect(pigSection).toBeVisible();
    await expect(broilerSection).toBeVisible();
    await expect(sheepSection).toBeVisible();
    expect(
      await page.$$eval('[data-processing-section]', (els) =>
        els.map((el) => el.getAttribute('data-processing-section')),
      ),
    ).toEqual(['broiler', 'cattle', 'sheep', 'pig']);

    // FIXED per-program headers: broiler carries Hatch date + Customer (no
    // Age); pig leads Batch then Trip; cattle carries Age; the count column is
    // labelled 'Count' in every section; 'Farm arrival' and 'Number' never
    // render anywhere.
    await expect(broilerSection.getByText('Hatch date', {exact: true})).toBeVisible();
    await expect(broilerSection.getByText('Customer', {exact: true})).toBeVisible();
    await expect(broilerSection.getByText('Age', {exact: true})).toHaveCount(0);
    await expect(pigSection.getByText('Trip', {exact: true})).toBeVisible();
    {
      // Pig column ORDER: Batch renders to the LEFT of Trip.
      const batchBox = await pigSection.getByText('Batch', {exact: true}).boundingBox();
      const tripBox = await pigSection.getByText('Trip', {exact: true}).boundingBox();
      expect(batchBox && tripBox && batchBox.x < tripBox.x).toBe(true);
    }
    await expect(cattleSection.getByText('Age', {exact: true})).toBeVisible();
    await expect(page.getByText('Count', {exact: true})).toHaveCount(4); // one per rendered section
    await expect(page.getByText('Farm arrival', {exact: true})).toHaveCount(0);
    await expect(page.getByText('Number', {exact: true})).toHaveCount(0);

    // Both cattle-batch row + milestone row render; admin sees Add-milestone
    // and the DIRECT Templates button — the old Admin toggle/panel and every
    // Asana import/maintenance control stay gone (UI-simplification lane).
    const row = page.locator(`[data-processing-row="${BATCH_ID}"]`);
    await expect(row).toBeVisible();
    await expect(page.locator(`[data-processing-row="${MILE_ID}"]`)).toBeVisible();
    await expect(page.locator('[data-processing-add-milestone-btn]')).toBeVisible();
    await expect(page.locator('[data-processing-templates-btn]')).toBeVisible();
    for (const gone of [
      '[data-processing-admin-toggle]',
      '[data-processing-admin-panel]',
      '[data-processing-asana-dry-run-btn]',
      '[data-processing-asana-sync-btn]',
      '[data-processing-destination-audit-btn]',
      '[data-processing-artifacts-dry-run-btn]',
      '[data-processing-sync-artifacts-btn]',
      '[data-processing-activity-dry-run-btn]',
      '[data-processing-sync-activity-btn]',
      '[data-processing-attachment-dry-run-btn]',
      '[data-processing-attachment-backfill-btn]',
      '[data-processing-reconciliation-btn]',
      '[data-processing-sync-status]',
      '[data-processing-dry-run-report]',
    ]) {
      await expect(page.locator(gone)).toHaveCount(0);
    }

    // Row shows the read-only completion indicator + checklist meta inside
    // the Batch cell (the only sanctioned subtask surface in the table).
    await expect(row.locator('[data-processing-row-check="open"]')).toHaveCount(1);
    await expect(row).toContainText('1-step checklist');
  });

  test('drawer: read-only Source details + server-gated completion (blocked future vs completable past)', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    // Future-dated batch, no processor, empty cows_detail → BLOCKED.
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId, {date: isoDaysFromNow(45)});
    // Past-dated batch with processor + 2 head → completable once its ONE
    // seeded open subtask is checked (proves the silent blocker reconcile
    // enables Mark complete without any reload).
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId, {
      id: DONE_BATCH_ID,
      srcId: DONE_SRC_ID,
      name: 'TEST Cattle Done',
      date: isoDaysFromNow(-10),
      cowsDetail: [
        {cattle_id: 'ptest-cow-1', hanging_weight: '250'},
        {cattle_id: 'ptest-cow-2', hanging_weight: '245'},
      ],
      processor: 'Atlanta Poultry Processing',
    });
    const reseedDoneSeed = async () => {
      await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId, {
        id: DONE_BATCH_ID,
        srcId: DONE_SRC_ID,
        name: 'TEST Cattle Done',
        date: isoDaysFromNow(-10),
        cowsDetail: [
          {cattle_id: 'ptest-cow-1', hanging_weight: '250'},
          {cattle_id: 'ptest-cow-2', hanging_weight: '245'},
        ],
        processor: 'Atlanta Poultry Processing',
      });
      await supabaseAdmin.from('processing_subtasks').upsert(
        {
          id: 'ptest-sub-done',
          record_id: DONE_BATCH_ID,
          label: 'TEST final step',
          done: false,
          completed_at: null,
          sort_order: 1,
          created_by: adminId,
        },
        {onConflict: 'id'},
      );
    };
    await reseedDoneSeed();
    await ensureProcessingSeedStable(supabaseAdmin, BATCH_ID, [], () =>
      seedCattleBatchWithProcessingRow(supabaseAdmin, adminId, {date: isoDaysFromNow(45)}),
    );
    await ensureProcessingSeedStable(supabaseAdmin, DONE_BATCH_ID, ['ptest-sub-done'], reseedDoneSeed);

    // Pin the stamp fresh: this test's assertions ride the LIVE projections
    // (source details, counts, completion blockers) and need no reconcile, so
    // skipping it removes reconcile stragglers that could sweep LATER tests.
    await stampFreshnessNow(supabaseAdmin);
    await gotoProcessingExpecting(page, `[data-processing-row="${BATCH_ID}"]`);

    // ── Blocked record ──
    await page.locator(`[data-processing-row="${BATCH_ID}"]`).click();
    const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
    await expect(drawer).toBeVisible();

    // Read-only Source details from the LIVE planner projection + back-link;
    // the retired template-field Details editor may not return. The
    // Processing-owned Processor/Customer values are editable above and are
    // never repeated as Source details rows.
    const sourceSection = drawer.locator('[data-processing-source-section="cattle"]');
    await expect(sourceSection).toBeVisible();
    await expect(drawer.locator('[data-processing-source-link="cattle"]')).toBeVisible();
    await expect(drawer.getByText('read-only here')).toBeVisible();
    await expect(drawer.locator('[data-processing-details-section]')).toHaveCount(0);
    await expect(drawer.locator('[data-processing-field-input]')).toHaveCount(0);
    await expect(sourceSection.getByText('Processor', {exact: true})).toHaveCount(0);
    await expect(sourceSection.getByText('Customer', {exact: true})).toHaveCount(0);
    await expect(drawer.locator('[data-processing-processor-select]')).toBeVisible();

    // Server-authoritative blockers: future date has not begun; no processor;
    // zero count. Mark complete stays disabled while ANY blocker exists.
    await expect(drawer.getByText(/has not begun/)).toBeVisible();
    await expect(drawer.getByText('Processor is required')).toBeVisible();
    await expect(drawer.getByText('Count must be greater than zero')).toBeVisible();
    const markBtn = drawer.locator('[data-processing-mark-complete]');
    await expect(markBtn).toBeVisible();
    await expect(markBtn).toBeDisabled();

    // Subtasks: add one (generic mutation path — a full reload is expected
    // here, so marks are planted only after the add settles).
    const addInput = drawer.locator('[data-processing-add-subtask]');
    await addInput.fill('TEST checklist step');
    await addInput.press('Enter');
    const newSub = drawer.locator('[data-processing-subtask]').filter({hasText: 'TEST checklist step'});
    await expect(newSub).toHaveCount(1);
    await expect(drawer.getByText('1 subtask(s) still open')).toBeVisible();
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('0/1');
    const scheduleRow = page.locator(`[data-processing-row="${BATCH_ID}"]`);
    await expect(scheduleRow).toContainText('1-step checklist · 0/1');

    // ── Checklist toggle: dedicated NO-RELOAD path ──
    // Plant node-identity marks: if the drawer flashed its loading state or
    // the schedule reloaded, these subtrees would unmount and the marks would
    // die with them.
    await newSub.evaluate((el) => {
      el.__wcfKeepAlive = 'drawer';
    });
    await scheduleRow.evaluate((el) => {
      el.__wcfKeepAlive = 'schedule';
    });

    // Check: flips immediately in place; the open-subtask blocker reconciles
    // away silently; drawer chip + schedule-row counts update — no reload.
    await newSub.locator('button[aria-label="Mark subtask done"]').click();
    await expect(newSub.locator('button[aria-label="Mark subtask not done"]')).toBeVisible();
    await expect(drawer.getByText('1 subtask(s) still open')).toHaveCount(0);
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('1/1');
    await expect(scheduleRow).toContainText('1-step checklist · 1/1');

    // Uncheck: immediately reverses; blocker + counts reconcile back.
    await newSub.locator('button[aria-label="Mark subtask not done"]').click();
    await expect(newSub.locator('button[aria-label="Mark subtask done"]')).toBeVisible();
    await expect(drawer.getByText('1 subtask(s) still open')).toBeVisible();
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('0/1');
    await expect(scheduleRow).toContainText('1-step checklist · 0/1');

    // The marked nodes survived both toggles: the drawer body never unmounted
    // (no visible loading state) and the schedule list never reloaded; the
    // page loaded-marker still reads loaded.
    expect(await newSub.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');
    expect(await scheduleRow.evaluate((el) => el.__wcfKeepAlive)).toBe('schedule');
    await expect(page.locator('main[data-surface="processing.calendar"]')).toHaveAttribute(
      'data-processing-loaded',
      '1',
    );

    // RPC failure: the optimistic patch rolls back to unchecked and the
    // existing inline error treatment shows — still no reload.
    await page.route('**/rest/v1/rpc/set_processing_subtask_done*', (route) => route.abort());
    await newSub.locator('button[aria-label="Mark subtask done"]').click();
    await expect(drawer.getByText(/Something went wrong\. Please retry\./)).toBeVisible();
    await expect(newSub.locator('button[aria-label="Mark subtask done"]')).toBeVisible();
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('0/1');
    await page.unroute('**/rest/v1/rpc/set_processing_subtask_done*');
    expect(await newSub.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');

    // Recovers after the failure: check it done again.
    await newSub.locator('button[aria-label="Mark subtask done"]').click();
    await expect(newSub.locator('button[aria-label="Mark subtask not done"]')).toBeVisible();
    await expect(drawer.getByText('1 subtask(s) still open')).toHaveCount(0);
    // Still blocked — the date/processor/count blockers are server-owned.
    await expect(markBtn).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // ── Completable record ──
    // Seeded with ONE open subtask: Mark complete starts blocked and must
    // become enabled purely from the checklist toggle's silent blocker
    // reconcile — and checking that last subtask never auto-completes the
    // record; completion stays this explicit gated action.
    await page.locator(`[data-processing-row="${DONE_BATCH_ID}"]`).click();
    const doneDrawer = page.locator(`[data-processing-drawer="${DONE_BATCH_ID}"]`);
    await expect(doneDrawer).toBeVisible();
    await expect(doneDrawer.getByText('1 subtask(s) still open')).toBeVisible();
    const doneBtn = doneDrawer.locator('[data-processing-mark-complete]');
    await expect(doneBtn).toBeDisabled();
    const finalStep = doneDrawer.locator('[data-processing-subtask]').filter({hasText: 'TEST final step'});
    await finalStep.locator('button[aria-label="Mark subtask done"]').click();
    await expect(finalStep.locator('button[aria-label="Mark subtask not done"]')).toBeVisible();
    await expect(doneDrawer.getByText('All requirements met.')).toBeVisible();
    await expect(doneBtn).toBeEnabled();
    await expect(doneDrawer.getByText('✓ Completed')).toHaveCount(0);
    await doneBtn.click();
    await expect(doneDrawer.getByText('✓ Completed')).toBeVisible();
    await expect(doneDrawer.locator('[data-processing-reopen]')).toBeVisible();
    await expect
      .poll(async () => {
        const {data} = await supabaseAdmin
          .from('processing_records')
          .select('completed_at, completed_by, status')
          .eq('id', DONE_BATCH_ID)
          .single();
        return data && data.completed_at != null && data.completed_by != null && data.status === 'complete';
      })
      .toBe(true);
  });

  test('checklist race: a failed neighbour toggle cannot strand schedule counts (controlled RPC ordering)', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    const reseedRaceSeed = async () => {
      await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);
      for (const [id, label, order] of [
        ['ptest-sub-race-a', 'RACE step A', 1],
        ['ptest-sub-race-b', 'RACE step B', 2],
      ]) {
        await supabaseAdmin.from('processing_subtasks').upsert(
          {
            id,
            record_id: BATCH_ID,
            label,
            done: false,
            completed_at: null,
            sort_order: order,
            created_by: adminId,
          },
          {onConflict: 'id'},
        );
      }
    };
    await reseedRaceSeed();
    await ensureProcessingSeedStable(supabaseAdmin, BATCH_ID, ['ptest-sub-race-a', 'ptest-sub-race-b'], reseedRaceSeed);

    // Pinned-fresh stamp: the race assertions ride live projections only.
    await stampFreshnessNow(supabaseAdmin);
    await gotoProcessingExpecting(page, `[data-processing-row="${BATCH_ID}"]`);
    const scheduleRow = page.locator(`[data-processing-row="${BATCH_ID}"]`);
    await expect(scheduleRow).toContainText('2-step checklist · 0/2');
    await scheduleRow.click();
    const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
    await expect(drawer).toBeVisible();
    const rowA = drawer.locator('[data-processing-subtask]').filter({hasText: 'RACE step A'});
    const rowB = drawer.locator('[data-processing-subtask]').filter({hasText: 'RACE step B'});
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('0/2');

    // Node-identity marks: any drawer/schedule reload would unmount these.
    await rowA.evaluate((el) => {
      el.__wcfKeepAlive = 'drawer';
    });
    await scheduleRow.evaluate((el) => {
      el.__wcfKeepAlive = 'schedule';
    });

    // Controlled RPC ordering: A's write passes through immediately; B's
    // write is HELD until released, then fails (aborted).
    let releaseB;
    const bHeld = new Promise((resolve) => {
      releaseB = resolve;
    });
    await page.route('**/rest/v1/rpc/set_processing_subtask_done*', async (route) => {
      if ((route.request().postData() || '').includes('ptest-sub-race-b')) {
        await bHeld;
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // Two different subtasks toggled while both writes are in flight.
    await rowA.locator('button[aria-label="Mark subtask done"]').click();
    await rowB.locator('button[aria-label="Mark subtask done"]').click();

    // Both flip optimistically in the drawer; the held B checkbox is the only
    // locked control.
    await expect(rowA.locator('button[aria-label="Mark subtask not done"]')).toBeVisible();
    await expect(rowB.locator('button[aria-label="Mark subtask not done"]')).toBeVisible();
    await expect(rowB.locator('button[aria-label="Mark subtask not done"]')).toBeDisabled();
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('2/2');

    // A confirms while B is still pending: the schedule row publishes ONLY
    // the confirmed write — B's unconfirmed optimism stays drawer-local. The
    // silently reconciled server blockers agree (exactly one open subtask).
    await expect(scheduleRow).toContainText('2-step checklist · 1/2');
    await expect(drawer.getByText('1 subtask(s) still open')).toBeVisible();

    // B now fails: its checkbox rolls back with the inline error; drawer and
    // schedule counts agree on the confirmed state; nothing reloaded.
    releaseB();
    await expect(drawer.getByText(/Something went wrong\. Please retry\./)).toBeVisible();
    await expect(rowB.locator('button[aria-label="Mark subtask done"]')).toBeVisible();
    await expect(drawer.locator('[data-processing-subtask-count]')).toHaveText('1/2');
    await expect(scheduleRow).toContainText('2-step checklist · 1/2');
    await expect(drawer.getByText('1 subtask(s) still open')).toBeVisible();
    expect(await rowA.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');
    expect(await scheduleRow.evaluate((el) => el.__wcfKeepAlive)).toBe('schedule');
    await page.unroute('**/rest/v1/rpc/set_processing_subtask_done*');

    // DB agrees with the published counts: A landed, B never did.
    const {data: raceRows} = await supabaseAdmin
      .from('processing_subtasks')
      .select('id, done')
      .in('id', ['ptest-sub-race-a', 'ptest-sub-race-b'])
      .order('id');
    expect(raceRows.map((r) => `${r.id}:${r.done}`)).toEqual(['ptest-sub-race-a:true', 'ptest-sub-race-b:false']);
  });

  test('deep link: /processing?record=<id> opens the drawer after the first load', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: 'ptest-deep-1',
      program: 'broiler',
      title: 'TEST Deep Link Broilers',
      date: '2026-03-10',
    });
    await stampFreshnessNow(supabaseAdmin);

    await page.goto('/processing?record=ptest-deep-1');
    await page.waitForSelector('[data-processing-deeplink-ready="1"]');
    await expect(page.locator('[data-processing-drawer="ptest-deep-1"]')).toBeVisible();
    // The open drawer stays mirrored into the ?record param.
    await expect(page).toHaveURL(/\/processing\?record=ptest-deep-1/);
    // Closing the drawer retires the param (replaceState, pathname intact).
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-processing-drawer="ptest-deep-1"]')).toHaveCount(0);
    await expect(page).toHaveURL(/\/processing$/);
  });

  test('milestone lifecycle: create with status (no parent assignee control), explicit date clear, delete', async ({
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
    // The parent Assignee control is retired; Customer is broiler-only so the
    // sheep form shows neither.
    await expect(page.locator('[data-processing-milestone-assignee]')).toHaveCount(0);
    await expect(page.locator('[data-processing-milestone-customer]')).toHaveCount(0);
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
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: REC,
      program: 'broiler',
      title: 'TEST B-26-04',
      date: '2026-03-20',
    });
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

  test('Customer + Processor are TRUE selects over stable option objects; inactive withheld; legacy values surface', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);

    // Known stable-object choices (mig 175 shape) incl. one INACTIVE processor
    // — restore the shared singleton after.
    const {data: baseSettings} = await supabaseAdmin
      .from('processing_asana_sync_settings')
      .select('processor_options, customer_options')
      .eq('id', 'singleton')
      .single();
    await supabaseAdmin
      .from('processing_asana_sync_settings')
      .update({
        processor_options: [
          {id: 'opt-ptest-p1', label: 'Atlanta Poultry Processing', active: true},
          {id: 'opt-ptest-p2', label: 'Springer Mountain', active: true},
          {id: 'opt-ptest-p3', label: 'Retired Processors Inc', active: false},
        ],
        customer_options: [
          {id: 'opt-ptest-c1', label: "Sonny's", active: true},
          {id: 'opt-ptest-c2', label: 'Fresh Farms Co', active: true},
        ],
      })
      .eq('id', 'singleton');

    try {
      // Broiler historical records: one with a LEGACY off-list processor +
      // LEGACY single off-list customer; one with an old MULTI-customer set.
      await seedHistoricalRecord(supabaseAdmin, adminId, {
        id: 'ptest-suite-broiler',
        program: 'broiler',
        title: 'TEST Suite broiler',
        date: '2026-04-01',
        extra: {processor: 'Old Legacy Processors LLC', customer: ['Old Partner LLC']},
      });
      await seedHistoricalRecord(supabaseAdmin, adminId, {
        id: 'ptest-suite-broiler-multi',
        program: 'broiler',
        title: 'TEST Suite broiler multi-customer',
        date: '2026-04-02',
        extra: {customer: ["Sonny's", 'Coastal Pastures - CONFIRMED']},
      });

      await stampFreshnessNow(supabaseAdmin);
      await gotoProcessingExpecting(page, '[data-processing-row="ptest-suite-broiler"]');

      // ── broiler record: processor + customer legacy/save/clear, DB-verified ──
      await page.locator('[data-processing-row="ptest-suite-broiler"]').click();
      const drawer = page.locator('[data-processing-drawer="ptest-suite-broiler"]');
      const procSelect = drawer.locator('[data-processing-processor-select]');
      await expect(procSelect).toBeVisible();
      expect(await procSelect.evaluate((el) => el.tagName)).toBe('SELECT');
      await expect(procSelect).toHaveValue('Old Legacy Processors LLC');
      await expect(procSelect.locator('option', {hasText: 'Old Legacy Processors LLC (legacy)'})).toHaveCount(1);
      // A deactivated option is NOT offered as a choice.
      await expect(procSelect.locator('option', {hasText: 'Retired Processors Inc'})).toHaveCount(0);
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

      // Customer: the stored off-list single value shows as (legacy) and is the
      // current selection; replacing it stores exactly [choice]; clearing → [].
      const custSelect = drawer.locator('[data-processing-customer-select]');
      await expect(custSelect).toBeVisible();
      expect(await custSelect.evaluate((el) => el.tagName)).toBe('SELECT');
      await expect(custSelect).toHaveValue('Old Partner LLC');
      await expect(custSelect.locator('option', {hasText: 'Old Partner LLC (legacy)'})).toHaveCount(1);
      await custSelect.selectOption('Fresh Farms Co');
      await expect
        .poll(async () => {
          const {data} = await supabaseAdmin
            .from('processing_records')
            .select('customer')
            .eq('id', 'ptest-suite-broiler')
            .single();
          return JSON.stringify(data.customer);
        })
        .toBe('["Fresh Farms Co"]');
      await expect(custSelect.locator('option', {hasText: '(legacy)'})).toHaveCount(0);
      await custSelect.selectOption('');
      await expect
        .poll(async () => {
          const {data} = await supabaseAdmin
            .from('processing_records')
            .select('customer')
            .eq('id', 'ptest-suite-broiler')
            .single();
          return JSON.stringify(data.customer);
        })
        .toBe('[]');
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);

      // ── old multi-customer record: ONE legacy-multiple option until replaced ──
      await page.locator('[data-processing-row="ptest-suite-broiler-multi"]').click();
      const multiDrawer = page.locator('[data-processing-drawer="ptest-suite-broiler-multi"]');
      const multiSelect = multiDrawer.locator('[data-processing-customer-select]');
      await expect(multiSelect.locator('option', {hasText: '(legacy — multiple)'})).toHaveCount(1);
      await expect(multiSelect.locator('option', {hasText: "Sonny's + Coastal Pastures - CONFIRMED"})).toHaveCount(1);
      // Deliberate replacement collapses the set to exactly one value.
      await multiSelect.selectOption("Sonny's");
      await expect
        .poll(async () => {
          const {data} = await supabaseAdmin
            .from('processing_records')
            .select('customer')
            .eq('id', 'ptest-suite-broiler-multi')
            .single();
          return JSON.stringify(data.customer);
        })
        .toBe(JSON.stringify(["Sonny's"]));
      await expect(multiSelect.locator('option', {hasText: '(legacy — multiple)'})).toHaveCount(0);
    } finally {
      await supabaseAdmin
        .from('processing_asana_sync_settings')
        .update({
          processor_options: baseSettings.processor_options,
          customer_options: baseSettings.customer_options,
        })
        .eq('id', 'singleton');
    }
  });

  test('Templates modal is CHECKLIST-ONLY; Customer & processor choices AUTOSAVE (debounce, flush, failed close)', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    // An active template so the modal loads an Active vN checklist (re-seedable
    // for the shared-DB resilience retry below).
    const seedTemplate = async () => {
      const {error: tplErr} = await supabaseAdmin.from('processing_templates').upsert(
        {
          id: 'ptest-tpl-modal',
          program: 'broiler',
          version: 1,
          fields: [],
          checklist: [{id: 'stp-ptest-modal-1', label: 'TEST modal step', assignee: null, assignee_profile_id: null}],
          is_active: true,
          created_by: adminId,
        },
        {onConflict: 'id'},
      );
      expect(tplErr, tplErr && tplErr.message).toBeFalsy();
    };
    await seedTemplate();

    // Stable-object choices so the options editor shows a persisted row with a
    // Deactivate control (restore the shared singleton after).
    const {data: baseSettings} = await supabaseAdmin
      .from('processing_asana_sync_settings')
      .select('processor_options, customer_options')
      .eq('id', 'singleton')
      .single();
    await supabaseAdmin
      .from('processing_asana_sync_settings')
      .update({
        processor_options: [{id: 'opt-ptest-mp1', label: 'Atlanta Poultry Processing', active: true}],
        customer_options: [{id: 'opt-ptest-mc1', label: "Sonny's", active: true}],
      })
      .eq('id', 'singleton');

    try {
      await stampFreshnessNow(supabaseAdmin);
      await page.goto('/processing');
      await page.waitForSelector('[data-processing-loaded="1"]');

      await page.locator('[data-processing-templates-btn]').click();
      const modal = page.locator('[data-processing-templates-modal]');
      await expect(modal).toBeVisible();

      // Shared-DB resilience: if a straggler sweep transiently ate the seeded
      // template (empty checklist), reseed and reopen ONCE. A real product
      // failure still fails the assertion below on the retry.
      const step0 = modal.locator('[data-processing-template-step="0"] input').first();
      const step0Loaded = await step0.waitFor({state: 'visible', timeout: 4000}).then(
        () => true,
        () => false,
      );
      if (!step0Loaded) {
        await modal.getByRole('button', {name: 'Close'}).last().click();
        await expect(modal).toHaveCount(0);
        await seedTemplate();
        await page.locator('[data-processing-templates-btn]').click();
        await expect(modal).toBeVisible();
      }

      // Checklist-only surface: the loaded step renders, steps can be added,
      // the reset is checklist-scoped, and there is NO Fields editor (type
      // pickers / color palette / field rows) and NO Asana import workflow.
      await expect(modal.getByText('checklist template')).toBeVisible();
      await expect(modal.locator('[data-processing-template-state]')).toHaveCount(0);
      await expect(modal.locator('[data-processing-template-surface="tasks"]')).toBeVisible();
      await expect(modal.locator('[data-processing-template-surface="fields"]')).toBeVisible();
      // React controls set the value PROPERTY (not the attribute) — assert via
      // toHaveValue on the first step row's label input.
      await expect(modal.locator('[data-processing-template-step="0"] input').first()).toHaveValue('TEST modal step');
      await expect(modal.locator('[data-processing-template-add-step]')).toBeVisible();
      await expect(modal.getByText('Reset checklist')).toHaveCount(0);
      await expect(modal.locator('[data-processing-color-palette]')).toHaveCount(0);
      await expect(modal.locator('[data-processing-template-import-btn]')).toHaveCount(0);
      await expect(modal.getByText('Add field')).toHaveCount(0);
      await expect(modal.getByText('Field type')).toHaveCount(0);

      // Draft preview pane (checklist as the drawer would list it).
      await modal.locator('[data-processing-template-preview-toggle]').click();
      await expect(modal.locator('[data-processing-template-preview="1"]')).toBeVisible();
      await expect(modal.locator('[data-processing-template-preview="1"]')).toContainText('TEST modal step');

      // ── Customer & processor choices: AUTOSAVE (UX lane — no Save button) ──
      // Count option-list RPCs at the route layer to prove debouncing and
      // flush behavior; the handler can also HOLD one request (in-flight
      // queueing proof) or FAIL one (failed-exit-flush proof).
      let optionRpcCount = 0;
      let holdNextSave = null;
      let failNextSave = false;
      await page.route('**/rest/v1/rpc/set_processing_option_list*', async (route) => {
        optionRpcCount += 1;
        if (failNextSave) {
          failNextSave = false;
          await route.abort();
          return;
        }
        if (holdNextSave) {
          const hold = holdNextSave;
          holdNextSave = null;
          await hold;
        }
        await route.continue();
      });
      await page.evaluate(() => {
        window.__wcfOptionsLaneMark = 'kept';
      });

      await modal.locator('[data-processing-template-surface="fields"]').click();
      await expect(page.locator('[data-processing-options-modal]')).toHaveCount(0);
      const options = modal.locator('[data-processing-template-fields-panel]');
      await expect(options).toBeVisible();
      await expect(options.locator('[data-processing-option-row="opt-ptest-mp1"]')).toBeVisible();
      await expect(options.locator('input[aria-label="Rename Atlanta Poultry Processing"]')).toBeVisible();
      await expect(options.locator('[data-processing-option-deactivate="opt-ptest-mp1"]')).toBeVisible();
      // 10. The option-list Save/Saved buttons are GONE (autosave)…
      await expect(options.locator('[data-processing-option-save]')).toHaveCount(0);
      await expect(options.getByRole('button', {name: /^(Save|Saved|Done)$/})).toHaveCount(0);
      const procStatus = options.locator('[data-processing-option-autosave="processor"]');

      // 1+2. Add 'Perdido' (Add button, never a Save click): the debounced
      // autosave issues EXACTLY ONE option-list RPC.
      await options.locator('[data-processing-option-add-input="processor"]').fill('Perdido');
      await options.locator('[data-processing-option-add="processor"]').click();
      await expect.poll(() => optionRpcCount).toBe(1);
      await expect(procStatus).toHaveText('Saved ✓');
      expect(optionRpcCount).toBe(1);

      // 3. The server-minted id reconciled into local state: the new row's
      // attribute is the opt-<uuid> id now, not the label; DB agrees.
      await expect(options.locator('input[aria-label="Rename Perdido"]')).toBeVisible();
      await expect(options.locator('[data-processing-option-row="Perdido"]')).toHaveCount(0);
      const {data: s3} = await supabaseAdmin
        .from('processing_asana_sync_settings')
        .select('processor_options')
        .eq('id', 'singleton')
        .single();
      expect(s3.processor_options.some((o) => o.label === 'Perdido' && /^opt-/.test(o.id || ''))).toBe(true);

      // 4. Rename typing is DEBOUNCED — several keystrokes, one RPC.
      const beforeRename = optionRpcCount;
      const atlantaInput = options.locator('input[aria-label="Rename Atlanta Poultry Processing"]');
      await atlantaInput.click();
      await atlantaInput.press('End');
      await atlantaInput.pressSequentially(' Co', {delay: 40});
      await expect.poll(() => optionRpcCount).toBe(beforeRename + 1);
      await expect(procStatus).toHaveText('Saved ✓');

      // 5. Deactivate autosaves; Reactivate autosaves.
      const beforeDeact = optionRpcCount;
      await options.locator('[data-processing-option-deactivate="opt-ptest-mp1"]').click();
      await expect.poll(() => optionRpcCount).toBe(beforeDeact + 1);
      await expect(options.getByRole('button', {name: /^Reactivate /})).toBeVisible();
      await options.locator('[data-processing-option-deactivate="opt-ptest-mp1"]').click();
      await expect.poll(() => optionRpcCount).toBe(beforeDeact + 2);
      await expect(procStatus).toHaveText('Saved ✓');

      // 8. An edit during an in-flight save persists the NEWEST list after it
      // (Enter-key creation path; the first save is HELD at the route).
      let releaseHold;
      holdNextSave = new Promise((resolve) => {
        releaseHold = resolve;
      });
      const beforeHold = optionRpcCount;
      const addInput = options.locator('[data-processing-option-add-input="processor"]');
      await addInput.fill('Palmetto');
      await addInput.press('Enter');
      await expect.poll(() => optionRpcCount).toBe(beforeHold + 1); // held in flight
      await options.locator('input[aria-label="Rename Palmetto"]').fill('Palmetto Processing');
      releaseHold();
      await expect.poll(() => optionRpcCount).toBe(beforeHold + 2); // newest list follows
      await expect(procStatus).toHaveText('Saved ✓');
      const {data: s8} = await supabaseAdmin
        .from('processing_asana_sync_settings')
        .select('processor_options')
        .eq('id', 'singleton')
        .single();
      expect(s8.processor_options.filter((o) => /^Palmetto/.test(o.label)).map((o) => o.label)).toEqual([
        'Palmetto Processing',
      ]);

      // 7. Switching Fields -> Tasks before the debounce expires FLUSHES the
      // pending save; the editor unmounts; Save template remains on Tasks.
      const beforeSwitch = optionRpcCount;
      await addInput.fill('Marianna');
      await options.locator('[data-processing-option-add="processor"]').click();
      await modal.locator('[data-processing-template-surface="tasks"]').click();
      await expect(modal.locator('[data-processing-template-fields-panel]')).toHaveCount(0);
      await expect.poll(() => optionRpcCount).toBe(beforeSwitch + 1);
      await expect(modal.locator('[data-processing-template-save]')).toBeVisible();

      // 9. A FAILED exit flush keeps the modal open, retains the edit, and
      // shows the inline error; closing again is the retry (6: the pending
      // debounce is flushed by Close — skip-duplicate keeps it to one RPC).
      await modal.locator('[data-processing-template-surface="fields"]').click();
      await expect(options.locator('input[aria-label="Rename Marianna"]')).toBeVisible();
      failNextSave = true;
      await options.locator('input[aria-label="Rename Marianna"]').fill('Marianna Beef');
      await modal.getByRole('button', {name: 'Close'}).last().click();
      await expect(options.locator('[data-inline-notice="error"]')).toBeVisible();
      await expect(modal).toBeVisible();
      await expect(options.locator('input[aria-label="Rename Marianna Beef"]')).toHaveValue('Marianna Beef');
      await expect(procStatus).toHaveText('Not saved');
      const beforeRetry = optionRpcCount;
      await modal.getByRole('button', {name: 'Close'}).last().click();
      await expect(modal).toHaveCount(0);
      await expect.poll(() => optionRpcCount).toBe(beforeRetry + 1);
      const {data: s9} = await supabaseAdmin
        .from('processing_asana_sync_settings')
        .select('processor_options')
        .eq('id', 'singleton')
        .single();
      expect(s9.processor_options.some((o) => o.label === 'Marianna Beef')).toBe(true);
      await page.unroute('**/rest/v1/rpc/set_processing_option_list*');

      // 3 (dropdowns). The new active choices are available in the milestone
      // Processor dropdown WITHOUT a page reload (the window mark survived).
      await page.locator('[data-processing-add-milestone-btn]').click();
      await expect(page.locator('[data-processing-milestone-processor] option', {hasText: 'Perdido'})).toHaveCount(1);
      await expect(
        page.locator('[data-processing-milestone-processor] option', {hasText: 'Marianna Beef'}),
      ).toHaveCount(1);
      expect(await page.evaluate(() => window.__wcfOptionsLaneMark)).toBe('kept');
    } finally {
      await supabaseAdmin
        .from('processing_asana_sync_settings')
        .update({
          processor_options: baseSettings.processor_options,
          customer_options: baseSettings.customer_options,
        })
        .eq('id', 'singleton');
    }
  });

  test('attachments upload + archive hides the row from the schedule', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    // An Asana-historical record: archivable, and never swept by the reconcile.
    await seedHistoricalRecord(supabaseAdmin, adminId, {
      id: 'ptest-hist-1',
      program: 'broiler',
      title: 'TEST Historical Broilers',
      date: '2026-03-02',
      extra: {status: 'complete', completed_at: '2026-03-02T12:00:00Z'},
    });

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

    await expect(page.locator('[data-processing-show-archived]')).toHaveCount(0);
    const {data: archived} = await supabaseAdmin
      .from('processing_records')
      .select('archived')
      .eq('id', 'ptest-hist-1')
      .single();
    expect(archived.archived).toBe(true);

    // Cleanup the uploaded object (shared TEST bucket hygiene).
    const {data: objs} = await supabaseAdmin.storage.from('processing-attachments').list('native/ptest-hist-1');
    if (objs && objs.length) {
      await supabaseAdmin.storage
        .from('processing-attachments')
        .remove(objs.map((o) => `native/ptest-hist-1/${o.name}`));
    }
  });

  test('apply-template: preview shows the additive diff behind Confirm; reapply reads up to date', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);
    await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId);
    // Active cattle template with ONE stable-id checklist step. The record
    // pre-exists (planner update branch), so no auto-seed ran — Apply is the
    // only path that can add the step.
    const {error: tplErr} = await supabaseAdmin.from('processing_templates').upsert(
      {
        id: 'ptest-tpl-apply',
        program: 'cattle',
        version: 1,
        fields: [],
        checklist: [{id: 'stp-ptest-apply-1', label: 'TEST template step', assignee: null, assignee_profile_id: null}],
        is_active: true,
        created_by: adminId,
      },
      {onConflict: 'id'},
    );
    expect(tplErr, tplErr && tplErr.message).toBeFalsy();

    await resetFreshnessStamp(supabaseAdmin);
    await gotoProcessingExpecting(page, `[data-processing-row="${BATCH_ID}"]`);
    await page.locator(`[data-processing-row="${BATCH_ID}"]`).click();
    const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('[data-processing-subtask]')).toHaveCount(0);

    // Preview first: the server's read-only diff renders behind Confirm.
    await drawer.locator('[data-processing-apply-template]').click();
    const preview = drawer.locator('[data-processing-apply-template-preview]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('1 addition');
    await expect(preview).toContainText('TEST template step');

    // Confirm applies additively and closes the preview.
    await drawer.locator('[data-processing-apply-template-confirm]').click();
    await expect(drawer.locator('[data-processing-apply-template-preview]')).toHaveCount(0);
    const applied = drawer.locator('[data-processing-subtask]').filter({hasText: 'TEST template step'});
    await expect(applied).toHaveCount(1);
    // The linked subtask carries the stable template step id server-side.
    await expect
      .poll(async () => {
        const {data} = await supabaseAdmin
          .from('processing_subtasks')
          .select('template_step_id')
          .eq('record_id', BATCH_ID);
        return (data || []).map((s) => s.template_step_id).join(',');
      })
      .toBe('stp-ptest-apply-1');

    // Idempotent: a second preview reads up to date (no confirm offered).
    await drawer.locator('[data-processing-apply-template]').click();
    await expect(drawer.getByText('Checklist is up to date.')).toBeVisible();
    await expect(drawer.locator('[data-processing-apply-template-confirm]')).toHaveCount(0);
  });

  test('quiet autosave: Processor + subtask Assignee save with NO drawer/schedule reload; failures roll back inline', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    const adminId = await adminProfileId(supabaseAdmin);

    // Two active processor + customer choices — restore the singleton after.
    const {data: baseSettings} = await supabaseAdmin
      .from('processing_asana_sync_settings')
      .select('processor_options, customer_options')
      .eq('id', 'singleton')
      .single();
    await supabaseAdmin
      .from('processing_asana_sync_settings')
      .update({
        processor_options: [
          {id: 'opt-ptest-qa1', label: 'Quiet Processor A', active: true},
          {id: 'opt-ptest-qa2', label: 'Quiet Processor B', active: true},
        ],
        customer_options: [
          {id: 'opt-ptest-qc1', label: 'Quiet Customer A', active: true},
          {id: 'opt-ptest-qc2', label: 'Quiet Customer B', active: true},
        ],
      })
      .eq('id', 'singleton');

    const seedAll = async () => {
      // Future-dated cattle batch, no processor -> 'Processor is required'
      // blocker; one open subtask for the Assignee select; a sweep-immune
      // broiler historical record for the (broiler-only) Customer select.
      await seedCattleBatchWithProcessingRow(supabaseAdmin, adminId, {});
      await supabaseAdmin.from('processing_subtasks').upsert(
        {
          id: SUB_ID,
          record_id: BATCH_ID,
          label: 'QA assignee step',
          done: false,
          sort_order: 1,
          created_by: adminId,
        },
        {onConflict: 'id'},
      );
      await seedHistoricalRecord(supabaseAdmin, adminId, {
        id: 'ptest-qa-broiler',
        program: 'broiler',
        title: 'QA Broiler Customer',
        date: isoDaysFromNow(2),
      });
    };
    try {
      await seedAll();
      await resetFreshnessStamp(supabaseAdmin);
      await ensureProcessingSeedStable(supabaseAdmin, BATCH_ID, [SUB_ID], seedAll);

      // Count the autosave RPCs (pass-through). A later route registration
      // (the failure-mode abort below) takes precedence, so aborted attempts
      // are never counted here.
      let processorCalls = 0;
      let subtaskCalls = 0;
      await page.route('**/rest/v1/rpc/set_processing_processor*', (route) => {
        processorCalls++;
        route.continue();
      });
      await page.route('**/rest/v1/rpc/update_processing_subtask*', (route) => {
        subtaskCalls++;
        route.continue();
      });

      await gotoProcessingExpecting(page, `[data-processing-row="${BATCH_ID}"]`);
      const scheduleRow = page.locator(`[data-processing-row="${BATCH_ID}"]`);
      await scheduleRow.click();
      const drawer = page.locator(`[data-processing-drawer="${BATCH_ID}"]`);
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText('Processor is required')).toBeVisible();
      const urlBefore = page.url();

      // Node-identity marks: a visible drawer reload or a schedule reload
      // would unmount these subtrees and the marks would die with them.
      const subtaskNode = drawer.locator(`[data-processing-subtask="${SUB_ID}"]`);
      await expect(subtaskNode).toBeVisible();
      await subtaskNode.evaluate((el) => {
        el.__wcfKeepAlive = 'drawer';
      });
      await scheduleRow.evaluate((el) => {
        el.__wcfKeepAlive = 'schedule';
      });
      // Scroll stability: scroll the drawer's scrollable ancestor to a
      // non-zero offset and remember the exact position.
      const scrollBefore = await subtaskNode.evaluate((el) => {
        let n = el.parentElement;
        while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement;
        if (!n) return -1;
        n.scrollTop = Math.max(1, Math.floor((n.scrollHeight - n.clientHeight) / 2));
        n.__wcfScrollProbe = true;
        return n.scrollTop;
      });

      // ── Processor: quiet save ──
      const processorSelect = drawer.locator('[data-processing-processor-select]');
      await processorSelect.selectOption('Quiet Processor A');
      await expect(processorSelect).toHaveValue('Quiet Processor A');
      // Silent reconcile clears the server-owned blocker without a reload.
      await expect(drawer.getByText('Processor is required')).toHaveCount(0);
      // Narrow row patch: the schedule shows the processor without a reload.
      await expect(scheduleRow).toContainText('Quiet Processor A');
      expect(processorCalls).toBe(1);
      expect(page.url()).toBe(urlBefore);
      await expect(drawer.getByText('Loading record…')).toHaveCount(0);
      expect(await subtaskNode.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');
      expect(await scheduleRow.evaluate((el) => el.__wcfKeepAlive)).toBe('schedule');
      if (scrollBefore > 0) {
        const scrollAfter = await subtaskNode.evaluate((el) => {
          let n = el.parentElement;
          while (n && !n.__wcfScrollProbe) n = n.parentElement;
          return n ? n.scrollTop : -2;
        });
        expect(scrollAfter).toBe(scrollBefore);
      }
      await expect(page.locator('main[data-surface="processing.calendar"]')).toHaveAttribute(
        'data-processing-loaded',
        '1',
      );

      // ── Processor: RPC failure rolls back; select re-enables; row untouched ──
      // Unroute by HANDLER so the pass-through counter route above survives.
      const abortProcessor = (route) => route.abort();
      await page.route('**/rest/v1/rpc/set_processing_processor*', abortProcessor);
      await processorSelect.selectOption('Quiet Processor B');
      await expect(drawer.getByText(/Something went wrong\. Please retry\./)).toBeVisible();
      await expect(processorSelect).toHaveValue('Quiet Processor A');
      await expect(processorSelect).toBeEnabled();
      await expect(scheduleRow).toContainText('Quiet Processor A');
      await page.unroute('**/rest/v1/rpc/set_processing_processor*', abortProcessor);
      expect(await subtaskNode.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');

      // ── Assignee: quiet assign; the silent reconcile keeps the selection ──
      const assigneeSelect = subtaskNode.locator('select[aria-label="Assignee"]');
      await assigneeSelect.selectOption(adminId);
      await expect(assigneeSelect).toHaveValue(adminId);
      await page.waitForTimeout(900); // give the silent reconcile a beat
      await expect(assigneeSelect).toHaveValue(adminId);
      expect(subtaskCalls).toBe(1);
      expect(await subtaskNode.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');

      // ── Assignee: quiet clear with the same stable behavior ──
      await assigneeSelect.selectOption('');
      await expect(assigneeSelect).toHaveValue('');
      await page.waitForTimeout(900);
      await expect(assigneeSelect).toHaveValue('');
      expect(subtaskCalls).toBe(2);

      // ── Assignee: RPC failure restores the exact prior assignment ──
      const abortSubtask = (route) => route.abort();
      await page.route('**/rest/v1/rpc/update_processing_subtask*', abortSubtask);
      await assigneeSelect.selectOption(adminId);
      await expect(drawer.getByText(/Something went wrong\. Please retry\./)).toBeVisible();
      await expect(assigneeSelect).toHaveValue('');
      await expect(assigneeSelect).toBeEnabled();
      await page.unroute('**/rest/v1/rpc/update_processing_subtask*', abortSubtask);
      expect(await subtaskNode.evaluate((el) => el.__wcfKeepAlive)).toBe('drawer');
      expect(await scheduleRow.evaluate((el) => el.__wcfKeepAlive)).toBe('schedule');
      expect(page.url()).toBe(urlBefore);

      // ── Search consistency (Processor): a second REAL quiet save, then the
      // active search matches the NEW value and drops the replaced one —
      // without list_processing_records or the schedule loading state. ──
      await processorSelect.selectOption('Quiet Processor B');
      await expect(processorSelect).toHaveValue('Quiet Processor B');
      await expect(scheduleRow).toContainText('Quiet Processor B');
      expect(processorCalls).toBe(2);
      await page.keyboard.press('Escape'); // close the cattle drawer
      await expect(page.locator(`[data-processing-drawer="${BATCH_ID}"]`)).toHaveCount(0);
      const searchInput = page.locator('[data-processing-search]');
      await searchInput.fill('Quiet Processor B');
      await expect(page.locator(`[data-processing-row="${BATCH_ID}"]`)).toBeVisible();
      await searchInput.fill('Quiet Processor A');
      await expect(page.locator(`[data-processing-row="${BATCH_ID}"]`)).toHaveCount(0);
      await searchInput.fill('');
      await expect(page.locator('main[data-surface="processing.calendar"]')).toHaveAttribute(
        'data-processing-loaded',
        '1',
      );

      // ── Customer (broiler-only): same quiet-autosave contract ──
      let customerCalls = 0;
      await page.route('**/rest/v1/rpc/set_processing_customer*', (route) => {
        customerCalls++;
        route.continue();
      });
      const broilerRow = page.locator('[data-processing-row="ptest-qa-broiler"]');
      await broilerRow.click();
      const broilerDrawer = page.locator('[data-processing-drawer="ptest-qa-broiler"]');
      await expect(broilerDrawer).toBeVisible();
      const customerSelect = broilerDrawer.locator('[data-processing-customer-select]');
      await expect(customerSelect).toBeVisible();
      const urlBroiler = page.url();
      await customerSelect.evaluate((el) => {
        el.__wcfKeepAlive = 'customer';
      });
      await broilerRow.evaluate((el) => {
        el.__wcfKeepAlive = 'broiler-row';
      });

      await customerSelect.selectOption('Quiet Customer A');
      await expect(customerSelect).toHaveValue('Quiet Customer A');
      await expect(broilerRow).toContainText('Quiet Customer A');
      expect(customerCalls).toBe(1);
      expect(page.url()).toBe(urlBroiler);
      await expect(broilerDrawer.getByText('Loading record…')).toHaveCount(0);
      expect(await customerSelect.evaluate((el) => el.__wcfKeepAlive)).toBe('customer');
      expect(await broilerRow.evaluate((el) => el.__wcfKeepAlive)).toBe('broiler-row');

      // Replace with the second value (still quiet), then prove search
      // consistency: new value matches, replaced value drops.
      await customerSelect.selectOption('Quiet Customer B');
      await expect(customerSelect).toHaveValue('Quiet Customer B');
      await expect(broilerRow).toContainText('Quiet Customer B');
      expect(customerCalls).toBe(2);
      expect(await customerSelect.evaluate((el) => el.__wcfKeepAlive)).toBe('customer');

      // ── Customer: RPC failure rolls back; select re-enables; row untouched ──
      const abortCustomer = (route) => route.abort();
      await page.route('**/rest/v1/rpc/set_processing_customer*', abortCustomer);
      await customerSelect.selectOption('Quiet Customer A');
      await expect(broilerDrawer.getByText(/Something went wrong\. Please retry\./)).toBeVisible();
      await expect(customerSelect).toHaveValue('Quiet Customer B');
      await expect(customerSelect).toBeEnabled();
      await expect(broilerRow).toContainText('Quiet Customer B');
      await page.unroute('**/rest/v1/rpc/set_processing_customer*', abortCustomer);
      expect(await customerSelect.evaluate((el) => el.__wcfKeepAlive)).toBe('customer');

      await page.keyboard.press('Escape');
      await expect(page.locator('[data-processing-drawer="ptest-qa-broiler"]')).toHaveCount(0);
      await searchInput.fill('Quiet Customer B');
      await expect(page.locator('[data-processing-row="ptest-qa-broiler"]')).toBeVisible();
      await searchInput.fill('Quiet Customer A');
      await expect(page.locator('[data-processing-row="ptest-qa-broiler"]')).toHaveCount(0);
      await searchInput.fill('');
      await expect(page.locator('main[data-surface="processing.calendar"]')).toHaveAttribute(
        'data-processing-loaded',
        '1',
      );
    } finally {
      await supabaseAdmin
        .from('processing_asana_sync_settings')
        .update({
          processor_options: baseSettings.processor_options,
          customer_options: baseSettings.customer_options,
        })
        .eq('id', 'singleton');
    }
  });
});
