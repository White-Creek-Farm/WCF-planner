// ============================================================================
// REQUIRES supabase-migrations 175-177 applied to TEST — run only after the
// gated apply; run this file ALONE.
// ============================================================================
// Pig planned-to-actual lifecycle — browser TEST proof (planner-integration
// lane, mig 176 transactional pig RPCs + reconcile).
//
// One end-to-end arc on the p2601Scenario fixture (feeder group P-26-01 with a
// draft weigh-in session of 5 gilt entries):
//   1. a seeded PLANNED trip projects onto /processing via the on-load
//      reconcile: 'Trip 1', Planned badge, 'Auto-planned' soft signal;
//   2. Send-to-Trip from the weigh-in session PROMOTES the planned trip id
//      into processingTrips — the SAME Processing record flips to In Process
//      with the actual count (record identity survives promotion);
//   3. undoing one entry decrements the actual trip and returns the pig to
//      the plan (a NEW planned trip → a NEW 'Trip 2' Planned record), and the
//      drawer's live Count follows;
//   4. the native pig batch page renders the trip anchor + its quiet
//      'Processing' deep link, and honors the ?trip= focus param.
//
// Shared TEST DB: the fixture resets shared tables — run this file ALONE.
import {test, expect} from './fixtures.js';
import {waitForPigFeedersLoaded} from './helpers/pigReady.js';

const PLANNED_TRIP_ID = 'pt-life-1';

async function readFeeders(supabaseAdmin) {
  const r = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
  return r.data?.data || [];
}

async function seedPlannedTrips(supabaseAdmin, plannedTrips) {
  const feeders = await readFeeders(supabaseAdmin);
  feeders[0].plannedProcessingTrips = plannedTrips;
  const {error} = await supabaseAdmin
    .from('app_store')
    .upsert({key: 'ppp-feeders-v1', data: feeders}, {onConflict: 'key'});
  expect(error, error && error.message).toBeFalsy();
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

// Pin the stamp FRESH so subsequent /processing loads SKIP the reconcile (the
// pig RPCs already re-synced the group's records inside their transaction).
async function stampFreshnessNow(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('processing_asana_sync_settings')
    .update({last_planner_reconcile_at: new Date().toISOString()})
    .eq('id', 'singleton');
  expect(error, error && error.message).toBeFalsy();
}

// Open /processing and wait for the given locator, reloading up to three times
// (ensure_processing_freshness legitimately BUSY-skips when another session's
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

// Open the seeded P-26-01 draft session on /pig/weighins and select all 5
// unsent entries. Selection is the per-row leftmost checkbox
// (data-pig-send-select, PROJECT.md pig weigh-in contract) and the send bar
// appears once any entry is selected. (The old "Select all unsent" button no
// longer exists; tests/pig_send_to_planned_trip.spec.js now drives the same
// per-row checkbox + send-bar contract.)
async function openSessionAndSelectAll(page) {
  await page.goto('/pig/weighins');
  const sessionRow = page
    .locator('tr[data-weighin-session-tile]')
    .filter({hasText: /p-26-01/i})
    .filter({hasText: /draft/i})
    .first();
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  await sessionRow.click();
  const checkboxes = page.locator('[data-pig-send-select="1"]');
  await expect(checkboxes).toHaveCount(5, {timeout: 10_000});
  for (let i = 0; i < 5; i++) {
    await checkboxes.nth(i).check();
  }
  const sendBar = page.locator('[data-pig-send-bar="1"]');
  await expect(sendBar).toContainText('Send 5 to Trip');
  await sendBar.click();
}

test('pig planned trip → /processing record → Send-to-Trip promotion → undo, one record identity throughout', async ({
  page,
  p2601Scenario,
  supabaseAdmin,
}) => {
  test.setTimeout(180_000);
  const {batchId, subAId, entryIds} = p2601Scenario;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const SOURCE_ID = `${batchId}:${PLANNED_TRIP_ID}`;

  // ── 1. Planned trip appears on /processing via the on-load reconcile ──
  await seedPlannedTrips(supabaseAdmin, [
    {id: PLANNED_TRIP_ID, date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 5, order: 0},
  ]);
  await resetFreshnessStamp(supabaseAdmin);
  await gotoProcessingExpecting(page, '[data-processing-section="pig"]');

  const {data: plannedRec, error: recErr} = await supabaseAdmin
    .from('processing_records')
    .select('id, source_phase, trip_ordinal, status')
    .eq('source_kind', 'pig')
    .eq('source_id', SOURCE_ID)
    .single();
  expect(recErr, recErr && recErr.message).toBeFalsy();
  expect(plannedRec.source_phase).toBe('planned');
  expect(plannedRec.trip_ordinal).toBe(1);
  const recordId = plannedRec.id;

  const row = page.locator(`[data-processing-row="${recordId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Trip 1');
  await expect(row).toContainText('Planned');
  // Soft pig plan signal (secondary text, never a Badge): unlocked → Auto-planned.
  await expect(page.locator(`[data-processing-pig-signal="${recordId}"]`)).toContainText('Auto-planned');

  // ── 2. Send-to-Trip in the weigh-in session promotes the SAME record ──
  await openSessionAndSelectAll(page);
  const modal = page.locator('[data-pig-send-modal="1"]');
  await expect(modal).toBeVisible({timeout: 5_000});
  await expect(modal.locator('[data-pig-send-summary="1"]')).toContainText(/fulfill the planned trip exactly/i);
  await modal.locator('[data-pig-send-confirm="1"]').click();
  await expect(modal).toHaveCount(0, {timeout: 10_000});

  // Server truth: the planned trip id was PROMOTED into processingTrips
  // unchanged; every entry is stamped to it.
  const feedersAfterSend = await readFeeders(supabaseAdmin);
  const groupAfterSend = feedersAfterSend[0];
  expect(groupAfterSend.processingTrips).toHaveLength(1);
  expect(groupAfterSend.processingTrips[0].id).toBe(PLANNED_TRIP_ID);
  expect(groupAfterSend.processingTrips[0].pigCount).toBe(5);
  expect(groupAfterSend.plannedProcessingTrips.find((t) => t.id === PLANNED_TRIP_ID)).toBeUndefined();
  const {data: stamped} = await supabaseAdmin
    .from('weigh_ins')
    .select('id, sent_to_trip_id, sent_to_group_id')
    .in('id', entryIds);
  for (const w of stamped) {
    expect(w.sent_to_trip_id).toBe(PLANNED_TRIP_ID);
    expect(w.sent_to_group_id).toBe(batchId);
  }

  // The Processing record kept its identity and flipped to the actual phase.
  const {data: actualRec} = await supabaseAdmin
    .from('processing_records')
    .select('id, source_phase')
    .eq('source_kind', 'pig')
    .eq('source_id', SOURCE_ID)
    .single();
  expect(actualRec.id).toBe(recordId);
  expect(actualRec.source_phase).toBe('actual');

  // UI: same row id now reads In Process with the actual count; the planned
  // soft signal is gone (actual trips carry no plan signal).
  await stampFreshnessNow(supabaseAdmin);
  await gotoProcessingExpecting(page, `[data-processing-row="${recordId}"]`);
  await expect(page.locator(`[data-processing-row="${recordId}"]`)).toContainText('In Process');
  await expect(page.locator(`[data-processing-pig-signal="${recordId}"]`)).toHaveCount(0);
  await page.locator(`[data-processing-row="${recordId}"]`).click();
  const drawer = page.locator(`[data-processing-drawer="${recordId}"]`);
  await expect(drawer).toBeVisible();
  const pigSource = drawer.locator('[data-processing-source-section="pig"]');
  await expect(pigSource).toBeVisible();
  await expect(pigSource).toContainText('Trip 1');
  await expect(pigSource).toContainText(/Count\s*5/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // ── 3. Undo one entry: actual count decrements; the pig returns to plan ──
  await page.goto('/pig/weighins');
  const sessionRow = page
    .locator('tr[data-weighin-session-tile]')
    .filter({hasText: /p-26-01/i})
    .first();
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  await sessionRow.click();
  await expect(page.getByText('Sent to trip').first()).toBeVisible({timeout: 15_000});
  await page.getByRole('button', {name: 'Undo send'}).first().click();

  await expect
    .poll(
      async () => {
        const feeders = await readFeeders(supabaseAdmin);
        const trip = (feeders[0].processingTrips || []).find((t) => t.id === PLANNED_TRIP_ID);
        return trip ? trip.pigCount : null;
      },
      {timeout: 15_000},
    )
    .toBe(4);
  const {data: unstamped} = await supabaseAdmin
    .from('weigh_ins')
    .select('id, sent_to_trip_id')
    .in('id', entryIds)
    .is('sent_to_trip_id', null);
  expect(unstamped).toHaveLength(1);

  // The returned pig lands on a NEW planned trip → a NEW Trip 2 Planned record
  // (same group namespace, ordinal never reused).
  const feedersAfterUndo = await readFeeders(supabaseAdmin);
  const newPlanned = (feedersAfterUndo[0].plannedProcessingTrips || []).find((t) => t.subBatchId === subAId);
  expect(newPlanned).toBeDefined();
  expect(newPlanned.plannedCount).toBe(1);
  const {data: trip2Rec} = await supabaseAdmin
    .from('processing_records')
    .select('id, source_phase, trip_ordinal')
    .eq('source_kind', 'pig')
    .eq('source_id', `${batchId}:${newPlanned.id}`)
    .single();
  expect(trip2Rec.source_phase).toBe('planned');
  expect(trip2Rec.trip_ordinal).toBe(2);

  // UI: the drawer's live Count follows the undo (4), and Trip 2 renders.
  await stampFreshnessNow(supabaseAdmin);
  await gotoProcessingExpecting(page, `[data-processing-row="${trip2Rec.id}"]`);
  await expect(page.locator(`[data-processing-row="${trip2Rec.id}"]`)).toContainText('Trip 2');
  await page.locator(`[data-processing-row="${recordId}"]`).click();
  const drawerAfterUndo = page.locator(`[data-processing-drawer="${recordId}"]`);
  await expect(drawerAfterUndo).toBeVisible();
  await expect(drawerAfterUndo.locator('[data-processing-source-section="pig"]')).toContainText(/Count\s*4/);
  await page.keyboard.press('Escape');

  // ── 4. Native pig batch page: trip anchor + quiet Processing link + focus ──
  await page.goto(`/pig/batches/${batchId}?trip=${PLANNED_TRIP_ID}`);
  await waitForPigFeedersLoaded(page);
  await expect(page.locator(`[data-pig-trip="${PLANNED_TRIP_ID}"]`).first()).toBeVisible({timeout: 15_000});
  await expect(page.locator(`[data-pig-trip-processing-link="${PLANNED_TRIP_ID}"]`).first()).toBeVisible();
});
