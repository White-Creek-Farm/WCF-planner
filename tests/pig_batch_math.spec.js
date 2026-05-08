import {test, expect} from './fixtures.js';

// ============================================================================
// Pig batch math regression spec — Phase A4
// ============================================================================
// Codex-scoped to ONE happy-path Send-to-Trip test that proves the three
// pieces this code path actually exercises:
//   1. processingTrips[].subAttributions stamped with the §7 schema
//      ([{subId, subBatchName, sex, count}]) — derived in
//      LivestockWeighInsView.sendEntriesToTrip via pigSlug match against
//      sub.name.
//   2. Parent ledger current count = started − processed − transferred − mortality
//      (NOT just latest_daily.pig_count and NOT mutating started counts).
//   3. lbs/pig denominator = finishers (started − transferred − mortality), the
//      regression lock for the 1644 vs 1186 P-26-01A bug from 2026-04-27 PM.
//
// FCR cache (the fourth assertion Codex asked for) was DEFERRED. Send-to-Trip
// does not write parent.fcrCached — that contract lives in PigBatchesView's
// persistTrip (Edit Trip / Save Trip flow). A separate spec driving Edit Trip
// will exercise the fcrCached add + delete contract end-to-end. Mis-scoped
// during planning; flagged in commit message.
//
// Edge cases (multi-sub Send-to-Trip, FCR add/clear, trip edit recalc,
// mortality limit math) deferred per Codex's "narrow first pass" guidance.
// ============================================================================

test('Send-to-Trip stamps subAttributions, ledger current = 12, lbs/pig honors finishers (FCR deferred)', async ({
  page,
  p2601Scenario,
  supabaseAdmin,
}) => {
  const {batchName, subAName, subAId, expected} = p2601Scenario;

  // --- Pre-flight: confirm the seed actually landed how we think.
  // If the seed changes shape silently, the test should fail with a clear
  // arrange-time error, not a confusing UI assertion failure later.
  {
    const {data} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
    const feeders = data?.data || [];
    expect(feeders).toHaveLength(1);
    const batch = feeders[0];
    expect(batch.batchName).toBe(batchName);
    expect(batch.processingTrips).toEqual([]);
    expect(batch.fcrCached).toBeUndefined();
    expect(batch.subBatches).toHaveLength(2);
  }

  // Pig planned trips lane: the new Send-to-Trip flow requires a planned
  // trip in the (subBatchId, sex) chain. Inject a 5-pig planned trip for
  // sub A (gilts) so the send is an EXACT match → consumes the planned
  // trip, no remainder math. Keeps this regression test focused on
  // subAttributions stamping + ledger arithmetic, not the reconciliation
  // branches (which have their own focused spec).
  {
    const {data} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
    const feeders = data.data;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    feeders[0].plannedProcessingTrips = [
      {id: 'pt-mathseed-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 5, order: 0},
    ];
    await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: feeders}, {onConflict: 'key'});
  }

  // --- ACT: drive Send-to-Trip via UI ---------------------------------------
  await page.goto('/pig/weighins');

  // Expand the seeded session row. The row's visible text is the session's
  // batch_id slug ('p-26-01a' — pigSlug('P-26-01A'), no dash before the 'a'
  // because uppercase letters are alphanumeric in /[^a-z0-9]+/g) plus a
  // DRAFT status pill — match both for specificity.
  const sessionRow = page
    .locator('.hoverable-tile')
    .filter({hasText: /p-26-01/i})
    .filter({hasText: /draft/i})
    .first();
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  await sessionRow.click();

  // "Select all unsent (5)" — proves the expansion landed AND selects all
  // entries in one click (avoiding the per-entry checkbox selector problem
  // which would otherwise need a data-testid).
  const selectAllBtn = page.getByText(/Select all unsent \(5\)/);
  await expect(selectAllBtn).toBeVisible({timeout: 5_000});
  await selectAllBtn.click();

  // Click "→ Send 5 to Trip" — opens PigSendToTripModal.
  await page.getByText(/→ Send 5 to Trip/).click();

  // New planned-trip-driven modal: data-pig-send-modal="1". The modal
  // pre-resolves the source sub via pigSlug + the target planned trip
  // and shows a reconciliation summary. Send count == planned count so
  // the summary should call out exact-fulfillment.
  const modal = page.locator('[data-pig-send-modal="1"]');
  await expect(modal).toBeVisible({timeout: 5_000});
  await expect(modal.locator('[data-pig-send-summary="1"]')).toContainText(/fulfill the planned trip exactly/);

  // Confirm.
  await modal.locator('[data-pig-send-confirm="1"]').click();

  // Wait for the modal to close.
  await expect(modal).toHaveCount(0, {timeout: 10_000});

  // --- ASSERT 1: DB ppp-feeders-v1 has trip with proper subAttributions.
  // Poll until the trip appears — modal close and persistence are async,
  // and decoupling them is a real risk if the persist contract changes.
  // Once one trip exists, we read once more to assert exact subAttributions
  // shape (so the failure message shows the diff, not "trip never arrived").
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
        return r.data?.data?.[0]?.processingTrips?.length ?? 0;
      },
      {timeout: 10_000, message: 'Send-to-Trip did not persist a trip'},
    )
    .toBe(1);

  const {data: postFeed} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
  const batch = postFeed.data[0];

  const trip = batch.processingTrips[0];
  expect(trip.pigCount).toBe(5);
  expect(trip.subAttributions).toEqual([{subId: subAId, subBatchName: subAName, sex: 'Gilts', count: 5}]);

  // FCR cache assertion deferred — see header comment. Send-to-Trip writes
  // the trip but does not run computePigBatchFCR. fcrCached remains
  // undefined for this flow; it populates only via Edit Trip → Save in
  // PigBatchesView.persistTrip. A future spec covers that contract.
  expect(batch.fcrCached).toBeUndefined();

  // --- ASSERT 3 + 4: UI on /pig/batches reflects ledger math --------------
  await page.goto('/pig/batches');

  // Current count: 20 started − 5 trip − 2 transferred − 1 mortality = 12.
  // Header shows "Current: <strong>12</strong>".
  await expect(page.getByText(new RegExp(`Current:\\s*${expected.postTripCurrent}\\b`))).toBeVisible({timeout: 15_000});

  // lbs/pig: 19000 adjusted feed ÷ 17 finishers = 1117.6 → rounds to 1118.
  // The bug regression: this MUST NOT be 950 (19000/20) or 1000 (20000/20).
  // The page shows BOTH parent ("1118 lbs/pig") AND sub-A inline ("1286 lbs/pig"
  // = 9000/7) — assert the parent value specifically.
  await expect(page.getByText(new RegExp(`\\b${expected.preTripLbsPerPig} lbs/pig\\b`))).toBeVisible();
});
