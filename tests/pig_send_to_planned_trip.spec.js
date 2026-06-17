import {test, expect} from './fixtures.js';

// ============================================================================
// Pig send-to-planned-trip integration spec — pig planned trips lane
// ============================================================================
// Drives the new planned-trip-driven Send-to-Trip flow through the real
// /pig/weighins UI. Each test seeds a focused planned-trip chain on top
// of the p2601Scenario fixture (which provides the source weigh-in
// session with 5 gilt entries on sub A) and asserts the resulting
// processingTrips + plannedProcessingTrips + weigh_ins state, or the
// inline-error block when the helper refuses.
//
// Pure-helper unit tests in src/lib/pigForecast.test.js cover the
// reconciliation math deterministically; this spec covers the end-to-end
// UI → modal → reconcile → app_store + weigh_ins write path that the
// helper alone cannot prove.
// ============================================================================

async function readFeeders(supabaseAdmin) {
  const r = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
  return r.data?.data || [];
}

async function seedPlannedTrips(supabaseAdmin, subAId, plannedTrips) {
  const feeders = await readFeeders(supabaseAdmin);
  feeders[0].plannedProcessingTrips = plannedTrips;
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: feeders}, {onConflict: 'key'});
}

async function openSessionAndSelectAll(page, {status = /draft/i} = {}) {
  await page.goto('/pig/weighins');
  const sessionRow = page
    .locator('tr[data-weighin-session-tile]')
    .filter({hasText: /p-26-01/i})
    .filter({hasText: status})
    .first();
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  await sessionRow.click();
  const selectAllBtn = page.getByText(/Select all unsent \(5\)/);
  await expect(selectAllBtn).toBeVisible({timeout: 5_000});
  await selectAllBtn.click();
  await page.getByText(/→ Send 5 to Processor/).click();
}

async function setRoleOverride(page, role) {
  await page.addInitScript((r) => {
    if (r) window.localStorage.setItem('wcf-test-role-override', r);
    else window.localStorage.removeItem('wcf-test-role-override');
  }, role);
}

test.describe('pig planned trips — Send-to-Trip integration', () => {
  test('under-pull with no later trip leaves a residual planned trip and creates the actual processing trip', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {subAId} = p2601Scenario;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // Single planned trip with plannedCount=8. Send count=5 (under-pull).
    // No NEXT trip → expect residual on the same trip with plannedCount=3.
    await seedPlannedTrips(supabaseAdmin, subAId, [
      {id: 'pt-resi-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 8, order: 0},
    ]);

    await openSessionAndSelectAll(page);
    const modal = page.locator('[data-pig-send-modal="1"]');
    await expect(modal).toBeVisible({timeout: 5_000});
    // Residual-aware copy: under-pull with no next trip should NOT say
    // "push forward" — that would mislead the operator. The helper
    // surfaces remainderStayedOnTarget=true and the modal renders the
    // "stay on this planned trip" wording.
    const summary = modal.locator('[data-pig-send-summary="1"]');
    await expect(summary).toContainText(/stay on this planned trip for a later send/i);
    await expect(summary).not.toContainText(/push forward/i);
    await modal.locator('[data-pig-send-confirm="1"]').click();
    await expect(modal).toHaveCount(0, {timeout: 10_000});

    const feeders = await readFeeders(supabaseAdmin);
    const batch = feeders[0];
    expect(batch.processingTrips).toHaveLength(1);
    expect(batch.processingTrips[0].pigCount).toBe(5);
    // Planned trip remains with plannedCount = 8 - 5 = 3 (residual; no
    // next trip existed to absorb the remainder).
    const residual = batch.plannedProcessingTrips.find((t) => t.id === 'pt-resi-1');
    expect(residual).toBeDefined();
    expect(residual.plannedCount).toBe(3);
  });

  test('completed pig weigh-in still exposes the send-to-processor action bar', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {subAId, sessionId, entryIds} = p2601Scenario;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await seedPlannedTrips(supabaseAdmin, subAId, [
      {id: 'pt-complete-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 5, order: 0},
    ]);
    await supabaseAdmin
      .from('weigh_in_sessions')
      .update({status: 'complete', completed_at: new Date().toISOString()})
      .eq('id', sessionId);

    await openSessionAndSelectAll(page, {status: /complete/i});
    const modal = page.locator('[data-pig-send-modal="1"]');
    await expect(modal).toBeVisible({timeout: 5_000});
    await expect(modal.locator('[data-pig-send-summary="1"]')).toContainText(/fulfill the planned trip exactly/);
    await modal.locator('[data-pig-send-confirm="1"]').click();
    await expect(modal).toHaveCount(0, {timeout: 10_000});

    const feeders = await readFeeders(supabaseAdmin);
    const batch = feeders[0];
    expect(batch.processingTrips).toHaveLength(1);
    expect(batch.processingTrips[0].pigCount).toBe(5);
    expect(batch.plannedProcessingTrips.find((t) => t.id === 'pt-complete-1')).toBeUndefined();

    const {data: stamped} = await supabaseAdmin
      .from('weigh_ins')
      .select('id, sent_to_trip_id, sent_to_group_id')
      .in('id', entryIds);
    for (const row of stamped) {
      expect(row.sent_to_trip_id).toBe(batch.processingTrips[0].id);
      expect(row.sent_to_group_id).toBe(batch.id);
    }
  });

  test('over-pull cascades through later planned trips and stamps weigh_ins', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {subAId, entryIds} = p2601Scenario;
    const d1 = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const d2 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    // chain: target=3, next=4 → total 7. Send=5 → consume target (3),
    // pull 2 from next → next.plannedCount = 4 - 2 = 2.
    await seedPlannedTrips(supabaseAdmin, subAId, [
      {id: 'pt-cas-1', date: d1, sex: 'gilt', subBatchId: subAId, plannedCount: 3, order: 0},
      {id: 'pt-cas-2', date: d2, sex: 'gilt', subBatchId: subAId, plannedCount: 4, order: 1},
    ]);

    await openSessionAndSelectAll(page);
    const modal = page.locator('[data-pig-send-modal="1"]');
    await expect(modal.locator('[data-pig-send-summary="1"]')).toContainText(/extra will be pulled from later/i);
    await modal.locator('[data-pig-send-confirm="1"]').click();
    await expect(modal).toHaveCount(0, {timeout: 10_000});

    const feeders = await readFeeders(supabaseAdmin);
    const batch = feeders[0];
    expect(batch.plannedProcessingTrips.find((t) => t.id === 'pt-cas-1')).toBeUndefined();
    const survivor = batch.plannedProcessingTrips.find((t) => t.id === 'pt-cas-2');
    expect(survivor).toBeDefined();
    expect(survivor.plannedCount).toBe(2);
    // Actual processing trip created with all 5 pigs.
    expect(batch.processingTrips).toHaveLength(1);
    expect(batch.processingTrips[0].pigCount).toBe(5);

    // weigh_ins stamping: every selected entry gets sent_to_trip_id +
    // sent_to_group_id pointing at the new actual trip + its group.
    const {data: stamped} = await supabaseAdmin
      .from('weigh_ins')
      .select('id, sent_to_trip_id, sent_to_group_id')
      .in('id', entryIds);
    for (const row of stamped) {
      expect(row.sent_to_trip_id).toBe(batch.processingTrips[0].id);
      expect(row.sent_to_group_id).toBe(batch.id);
    }
  });

  test('over-pull beyond the chain shows inline error and writes nothing', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {subAId, entryIds} = p2601Scenario;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // chain total = 3, send=5. Helper refuses; modal shows inline error;
    // Confirm button stays disabled.
    await seedPlannedTrips(supabaseAdmin, subAId, [
      {id: 'pt-over-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 3, order: 0},
    ]);

    await openSessionAndSelectAll(page);
    const modal = page.locator('[data-pig-send-modal="1"]');
    await expect(modal.locator('[data-pig-send-error="1"]')).toContainText(/exceed the total planned count/i);
    await expect(modal.locator('[data-pig-send-confirm="1"]')).toBeDisabled();
    await modal.locator('[data-pig-send-cancel="1"]').click();
    await expect(modal).toHaveCount(0, {timeout: 10_000});

    // No actual trip persisted; planned chain unchanged.
    const feeders = await readFeeders(supabaseAdmin);
    expect(feeders[0].processingTrips).toEqual([]);
    expect(feeders[0].plannedProcessingTrips.find((t) => t.id === 'pt-over-1').plannedCount).toBe(3);
    // weigh_ins not stamped.
    const {data: stamped} = await supabaseAdmin.from('weigh_ins').select('id, sent_to_trip_id').in('id', entryIds);
    for (const row of stamped) {
      expect(row.sent_to_trip_id).toBeNull();
    }
  });

  test('no planned trip in chain shows inline error and writes nothing', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {entryIds} = p2601Scenario;
    // Default fixture leaves plannedProcessingTrips empty. Don't seed any.
    await openSessionAndSelectAll(page);
    const modal = page.locator('[data-pig-send-modal="1"]');
    await expect(modal.locator('[data-pig-send-error="1"]')).toContainText(/No planned trip exists/i);
    await expect(modal.locator('[data-pig-send-confirm="1"]')).toBeDisabled();
    await modal.locator('[data-pig-send-cancel="1"]').click();
    await expect(modal).toHaveCount(0, {timeout: 10_000});

    const feeders = await readFeeders(supabaseAdmin);
    expect(feeders[0].processingTrips).toEqual([]);
    const {data: stamped} = await supabaseAdmin.from('weigh_ins').select('id, sent_to_trip_id').in('id', entryIds);
    for (const row of stamped) {
      expect(row.sent_to_trip_id).toBeNull();
    }
  });

  test('farm_team cannot see/use the send-to-planned-trip mutation controls', async ({
    page,
    p2601Scenario,
    supabaseAdmin,
  }) => {
    const {subAId} = p2601Scenario;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // Seed a valid planned trip — even with the chain present, the
    // farm_team viewer must not see the action bar / checkboxes / send
    // trigger. Use the DEV-only role override so the page still has the
    // admin storage-state visibility needed to inspect the seeded session.
    await seedPlannedTrips(supabaseAdmin, subAId, [
      {id: 'pt-ft-1', date: tomorrow, sex: 'gilt', subBatchId: subAId, plannedCount: 5, order: 0},
    ]);

    await setRoleOverride(page, 'farm_team');
    await page.goto('/pig/weighins');
    const sessionRow = page
      .locator('tr[data-weighin-session-tile]')
      .filter({hasText: /p-26-01/i})
      .filter({hasText: /draft/i})
      .first();
    // farm_team can still see the session row.
    await expect(sessionRow).toBeVisible({timeout: 15_000});
    await sessionRow.click();
    // Send-to-Trip action bar must NOT render for farm_team.
    await expect(page.locator('[data-pig-send-bar="1"]')).toHaveCount(0);
    // Per-row select checkboxes must NOT render for farm_team.
    await expect(page.locator('[data-pig-send-select="1"]')).toHaveCount(0);
    // Sanity: the static "Select all unsent" affordance is gone.
    await expect(page.getByText(/Select all unsent/)).toHaveCount(0);
  });
});
