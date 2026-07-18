import {test, expect} from './fixtures.js';

// ============================================================================
// REQUIRES supabase-migrations/188_processing_carcass_yield_source_totals.sql
// applied to TEST — run only after the gated apply; run this file ALONE
// (shared TEST DB; fixtures reset tables).
// ============================================================================
// Processing Source details — carcass yield (cattle / sheep / actual pig
// trip) + the pig standalone Sex row removal.
//
// The drawer's compact yield block (Total live weight / Hanging weight /
// Carcass yield) sits below the Count/Weight/Age summary rows and above the
// animal roster, computed by the ONE shared summarizeCarcassYield helper
// over canonical source facts:
//   cattle/sheep — mig 188's server-side detail-JSON totals (the same
//     per-row values the batch pages sum);
//   pig — the exact actual trip's canonical per-pig live weights + its
//     planner-owned hangingWeight (mig 188).
// Planned/projected data never yields a percentage — every side fails
// closed to "Not recorded".
//
// Tests:
//   1 — cattle batch: totals + 60.0% match the batch page's own yield.
//   2 — sheep batch: totals + 52.0% from sheep_detail.
//   3 — pig ACTUAL trip: 800 lb / 555 lb / 69.4% (tripYield parity); the
//       planned trip's block is all Not recorded; the standalone Sex
//       FieldRow is gone while the roster keeps Pig | Sex | Live weight
//       with canonical Gilt values.
// ============================================================================

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seedKey = (value) => `${value}-${RUN_ID}`;

// Run the planner→Processing reconcile NOW (service-role grant), so the
// seeded batches/trips have their records before we ever load the page —
// deterministic, no dependence on the page-load freshness debounce.
async function reconcileNow(supabaseAdmin) {
  const r = await supabaseAdmin.rpc('reconcile_planner_to_processing');
  expect(r.error, r.error && r.error.message).toBeFalsy();
}

// Open /processing and wait for the given locator, reloading up to three
// times (ensure_processing_freshness legitimately BUSY-skips when another
// reconcile is mid-flight; the contract is "fresh by the next load").
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

async function findRecordId(supabaseAdmin, sourceKind, sourceId) {
  let id = null;
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('processing_records')
          .select('id')
          .eq('source_kind', sourceKind)
          .eq('source_id', sourceId)
          .maybeSingle();
        id = r.data?.id || null;
        return id;
      },
      {timeout: 20_000, message: `reconcile never produced the ${sourceKind} record for ${sourceId}`},
    )
    .not.toBeNull();
  return id;
}

async function openDrawer(page, recordId) {
  const row = page.locator(`[data-processing-row="${recordId}"]`);
  await expect(row).toBeVisible({timeout: 15_000});
  await row.click();
  const drawer = page.locator(`[data-processing-drawer="${recordId}"]`);
  await expect(drawer).toBeVisible({timeout: 10_000});
  return drawer;
}

// Assert the three yield rows inside the block carry the expected values.
async function expectYieldBlock(block, {live, hang, pct}) {
  await expect(block).toBeVisible({timeout: 10_000});
  await expect(block).toContainText('Total live weight');
  await expect(block).toContainText('Hanging weight');
  await expect(block).toContainText('Carcass yield');
  await expect(block).toContainText(live);
  await expect(block).toContainText(hang);
  await expect(block).toContainText(pct);
}

// --------------------------------------------------------------------------
// Test 1 — cattle: drawer totals + yield match the batch page exactly
// --------------------------------------------------------------------------
test('cattle batch: Source details show detail totals + 60.0% yield matching the batch page', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(90_000);
  const batchId = 'b-carcass-cattle-1';
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-94',
      status: 'complete',
      actual_process_date: '2026-05-04',
      planned_process_date: '2026-05-04',
      cows_detail: [
        {cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: 660},
        {cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: 870},
      ],
      total_live_weight: 2550,
      total_hanging_weight: 1530,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle')
    .update({herd: 'processed', processing_batch_id: batchId})
    .in('id', ['F1', 'F-AT-MAX']);

  // The batch page's own yield for these rows: 1530/2550 = 60%.
  await page.goto('/cattle/batches/' + batchId);
  await expect(page.locator('[data-cattle-batch-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  await expect(page.getByText('60% yield').first()).toBeVisible();

  await reconcileNow(supabaseAdmin);
  const recordId = await findRecordId(supabaseAdmin, 'cattle', batchId);
  await gotoProcessingExpecting(page, `[data-processing-row="${recordId}"]`);
  const drawer = await openDrawer(page, recordId);

  const block = drawer.locator('[data-processing-carcass-yield="cattle"]');
  await expectYieldBlock(block, {live: '2,550 lb', hang: '1,530 lb', pct: '60.0%'});
  // Actual animals table renders below the block; the projected roster
  // never mounts on an actual batch.
  await expect(drawer.locator('[data-processing-animals-table]')).toBeVisible();
  await expect(drawer.locator('[data-processing-projected-roster]')).toHaveCount(0);

  // MALFORMED-DATA proof: a batch carrying a partial-numeric live weight
  // ('120junk') + malformed hanging ('abc') still loads (the guarded casts
  // never throw) and the junk row contributes NOTHING to the totals.
  const badId = 'b-carcass-cattle-bad';
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: badId,
      name: 'C-26-93',
      status: 'complete',
      actual_process_date: '2026-05-03',
      planned_process_date: '2026-05-03',
      cows_detail: [
        {cattle_id: 'F-HIDE', tag: '1003', live_weight: 1100, hanging_weight: 660},
        {cattle_id: 'F3', tag: '1004', live_weight: '120junk', hanging_weight: 'abc'},
      ],
      total_live_weight: null,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('cattle').update({herd: 'processed', processing_batch_id: badId}).in('id', ['F-HIDE', 'F3']);
  await reconcileNow(supabaseAdmin);
  const badRecordId = await findRecordId(supabaseAdmin, 'cattle', badId);
  await gotoProcessingExpecting(page, `[data-processing-row="${badRecordId}"]`);
  const badDrawer = await openDrawer(page, badRecordId);
  const badBlock = badDrawer.locator('[data-processing-carcass-yield="cattle"]');
  await expectYieldBlock(badBlock, {live: '1,100 lb', hang: '660 lb', pct: '60.0%'});
});

// --------------------------------------------------------------------------
// Test 2 — sheep: detail totals + 52.0% yield
// --------------------------------------------------------------------------
test('sheep batch: valid totals sum; a malformed hanging weight is excluded without throwing', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  test.setTimeout(90_000);
  await resetDb();
  const batchId = seedKey('sb-carcass-sheep');
  await supabaseAdmin.from('sheep').upsert(
    [
      {id: seedKey('SH-CY-1'), tag: 'S901', breed: 'Katahdin', flock: 'processed', old_tags: []},
      {id: seedKey('SH-CY-2'), tag: 'S902', breed: 'Katahdin', flock: 'processed', old_tags: []},
    ],
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('sheep_processing_batches').upsert(
    {
      id: batchId,
      name: 'S-26-90',
      status: 'complete',
      actual_process_date: '2026-05-04',
      planned_process_date: '2026-05-04',
      sheep_detail: [
        {sheep_id: seedKey('SH-CY-1'), tag: 'S901', live_weight: 120, hanging_weight: 60},
        // Malformed hanging weight — must be EXCLUDED (never parseFloat'd
        // to 70, never a throw); live 130 stays valid.
        {sheep_id: seedKey('SH-CY-2'), tag: 'S902', live_weight: 130, hanging_weight: '70junk'},
      ],
      total_live_weight: 250,
      total_hanging_weight: 130,
    },
    {onConflict: 'id'},
  );

  await reconcileNow(supabaseAdmin);
  const recordId = await findRecordId(supabaseAdmin, 'sheep', batchId);
  await page.goto('/processing');
  await gotoProcessingExpecting(page, `[data-processing-row="${recordId}"]`);
  const drawer = await openDrawer(page, recordId);

  const block = drawer.locator('[data-processing-carcass-yield="sheep"]');
  // Live: 120 + 130 = 250 (both valid). Hanging: 60 only ('70junk'
  // excluded by the guarded cast). 60 / 250 = 24.0%.
  await expectYieldBlock(block, {live: '250 lb', hang: '60 lb', pct: '24.0%'});
});

// --------------------------------------------------------------------------
// Test 3 — pig: actual trip yield (tripYield parity), planned fails closed,
// standalone Sex row removed while the roster keeps its Sex column
// --------------------------------------------------------------------------
test('pig: actual trip shows 69.4% tripYield-parity block; planned trip all Not recorded; Sex is roster-only', async ({
  page,
  p2601Scenario,
  supabaseAdmin,
}) => {
  test.setTimeout(120_000);
  // Seed one ACTUAL and one PLANNED trip on the fixture's feeder group.
  const r = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
  const feeders = r.data?.data || [];
  expect(feeders.length).toBeGreaterThan(0);
  const groupId = feeders[0].id;
  feeders[0].processingTrips = [
    {
      id: 'trip-cy-actual',
      date: '2026-05-10',
      pigCount: '2',
      liveWeights: '400 400',
      hangingWeight: 555,
      notes: '',
      subAttributions: [{subId: 'sb-cy', subBatchName: 'CY Gilts', sex: 'Gilts', count: 2}],
    },
    // Malformed legacy hangingWeight — the record must still load; the
    // hanging/yield rows fail closed while live weights render.
    {
      id: 'trip-cy-bad',
      date: '2026-05-12',
      pigCount: '2',
      liveWeights: '400 400',
      hangingWeight: '555junk',
      notes: '',
      subAttributions: [{subId: 'sb-cy', subBatchName: 'CY Gilts', sex: 'Gilts', count: 2}],
    },
  ];
  feeders[0].plannedProcessingTrips = [
    {id: 'trip-cy-planned', date: '2026-09-15', sex: 'gilt', subBatchId: 'sb-cy', plannedCount: 3, order: 1},
  ];
  const up = await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: feeders}, {onConflict: 'key'});
  expect(up.error, up.error && up.error.message).toBeFalsy();

  await reconcileNow(supabaseAdmin);
  const actualId = await findRecordId(supabaseAdmin, 'pig', `${groupId}:trip-cy-actual`);
  const plannedId = await findRecordId(supabaseAdmin, 'pig', `${groupId}:trip-cy-planned`);

  await gotoProcessingExpecting(page, `[data-processing-row="${actualId}"]`);
  const drawer = await openDrawer(page, actualId);
  const sourceSection = drawer.locator('[data-processing-source-section="pig"]');
  await expect(sourceSection).toBeVisible({timeout: 10_000});

  // Actual-trip yield: 400+400 live, 555 hanging → 69.4% (tripYield parity).
  const block = sourceSection.locator('[data-processing-carcass-yield="pig"]');
  await expectYieldBlock(block, {live: '800 lb', hang: '555 lb', pct: '69.4%'});

  // The standalone Sex FieldRow between Trip and Processing date is GONE:
  // the only exact-'Sex' label left in Source details is the roster header.
  const sexLabels = sourceSection.locator('span').filter({hasText: /^Sex$/});
  await expect(sexLabels).toHaveCount(1);
  // Roster stays Pig | Sex | Live weight with the canonical Gilt value.
  const roster = sourceSection.locator('[data-processing-animals-table]');
  await expect(roster).toBeVisible();
  await expect(roster).toContainText('Pig 1');
  await expect(roster).toContainText('Gilt');
  await expect(roster).toContainText('400 lb');

  // Planned trip: no actual carcass data — all three rows fail closed.
  await page.goto('/processing');
  await page.waitForSelector('[data-processing-loaded="1"]');
  const plannedDrawer = await openDrawer(page, plannedId);
  const plannedBlock = plannedDrawer.locator('[data-processing-carcass-yield="pig"]');
  await expect(plannedBlock).toBeVisible({timeout: 10_000});
  await expect(plannedBlock.getByText('Not recorded')).toHaveCount(3);
  await expect(plannedBlock).not.toContainText('%');
  await expect(plannedBlock).not.toContainText('0.0');

  // Malformed legacy hangingWeight ('555junk'): the record still loads
  // (guarded cast — get/list never throw), live total renders from the
  // canonical rows, hanging + yield fail closed.
  const badId = await findRecordId(supabaseAdmin, 'pig', `${groupId}:trip-cy-bad`);
  await page.goto('/processing');
  await page.waitForSelector('[data-processing-loaded="1"]');
  const badDrawer = await openDrawer(page, badId);
  const badBlock = badDrawer.locator('[data-processing-carcass-yield="pig"]');
  await expect(badBlock).toBeVisible({timeout: 10_000});
  await expect(badBlock).toContainText('800 lb');
  await expect(badBlock.getByText('Not recorded')).toHaveCount(2);
  await expect(badBlock).not.toContainText('%');
});
