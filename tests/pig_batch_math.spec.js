import {test, expect} from './fixtures.js';

// ============================================================================
// Pig batch math regression spec — Phase A4
// ============================================================================
// Drives /weigh-in-sessions/<id> (WeighInSessionPage) under the default
// authenticated storage state. Locks the §7 pig Send-to-Trip contract:
//   1. processingTrips[].subAttributions stamped with the §7 schema
//   2. Parent ledger current count = started − processed − transferred − mortality
//   3. lbs/pig denominator = finishers (started − transferred − mortality)
//
// Migrated 2026-05-27 to drive the record page directly.
// ============================================================================

test('Send-to-Trip stamps subAttributions, persists trip, ledger shows correct current + lbs/pig', async ({
  page,
  p2601Scenario,
  supabaseAdmin,
}) => {
  const {batchName, subAName, subAId, sessionId, expected} = p2601Scenario;

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

  {
    const {data} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
    const feeders = data.data;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    feeders[0].plannedProcessingTrips = [
      {id: 'pt-mathseed-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 5, order: 0},
    ];
    await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: feeders}, {onConflict: 'key'});
  }

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  const checkboxes = page.locator('[data-weighin-entries="1"] input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(5, {timeout: 5_000});
  for (let i = 0; i < 5; i++) {
    await checkboxes.nth(i).check();
  }

  await page.getByRole('button', {name: /Send 5 to Trip/}).click();

  const modal = page.locator('[data-pig-send-modal="1"]');
  await expect(modal).toBeVisible({timeout: 5_000});
  await expect(modal.locator('[data-pig-send-summary="1"]')).toContainText(/fulfill the planned trip exactly/);

  await modal.locator('[data-pig-send-confirm="1"]').click();
  await expect(modal).toHaveCount(0, {timeout: 10_000});

  // --- DB assertions: trip persisted with correct shape ---
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
  expect(batch.fcrCached).toBeUndefined();

  // --- UI assertions: /pig/batches ledger math ---
  await page.goto('/pig/batches/p2601-test');

  // Current count: 20 started − 5 trip − 2 transferred − 1 mortality = 12
  await expect(page.getByText(new RegExp(`Current:\\s*${expected.postTripCurrent}\\b`))).toBeVisible({timeout: 15_000});

  // lbs/pig: 19000 adjusted feed ÷ 17 finishers = 1118
  await expect(page.getByText(new RegExp(`\\b${expected.preTripLbsPerPig} lbs/pig\\b`))).toBeVisible();
});
