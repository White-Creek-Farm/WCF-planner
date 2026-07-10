import {test, expect} from './fixtures.js';

// ============================================================================
// Sheep Send-to-Processor spec — Phase A6
// ============================================================================
// Drives /weigh-in-sessions/<id> (WeighInSessionPage) under the default
// authenticated storage state. Mirror of A5 cattle spec for sheep, with one
// behavioral difference locked: the §7 sheep gate is intentionally LOOSER
// than cattle (any draft session, any flock, vs cattle's finishers-only).
//
// Migrated 2026-05-27 to drive the record page directly instead of the
// retired inline list-view expansion.
// ============================================================================

function uniqueRow(page, tag) {
  return page.locator(`[data-entry-tag="${tag}"]`);
}

async function installConfirmDeleteStub(page) {
  await page.waitForFunction(() => typeof window._wcfConfirmDelete === 'function');
  await page.evaluate(() => {
    window._wcfConfirmDelete = (_msg, fn) => fn();
  });
}

// --------------------------------------------------------------------------
// Test 1 — happy-path attach via UI (feeders flock)
// --------------------------------------------------------------------------
test('attach: complete session + modal stamps prior_herd_or_flock and writes audit', async ({
  page,
  sheepSendToProcessorScenario,
  supabaseAdmin,
}) => {
  const {batchId, sessionId, sheep} = await sheepSendToProcessorScenario({flock: 'feeders'});

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: /Complete Session/}).click();

  const modalTitle = page.getByText(/Send 3 sheep to processor/);
  await expect(modalTitle).toBeVisible({timeout: 5_000});

  const select = page
    .locator('select')
    .filter({has: page.locator(`option[value="${batchId}"]`)})
    .first();
  await select.selectOption(batchId);

  await page.getByRole('button', {name: 'Send to processor'}).click();
  await expect(modalTitle).toHaveCount(0, {timeout: 10_000});

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('sheep_processing_batches')
          .select('sheep_detail')
          .eq('id', batchId)
          .single();
        return (r.data?.sheep_detail || []).length;
      },
      {timeout: 10_000, message: 'sheep_detail did not populate after attach'},
    )
    .toBe(3);

  const batchAfter = await supabaseAdmin
    .from('sheep_processing_batches')
    .select('sheep_detail')
    .eq('id', batchId)
    .single();
  const detailByTag = Object.fromEntries((batchAfter.data.sheep_detail || []).map((r) => [r.tag, r]));
  expect(detailByTag).toEqual({
    3001: {sheep_id: 'sheep-test-3001', tag: '3001', live_weight: 90, hanging_weight: null},
    3002: {sheep_id: 'sheep-test-3002', tag: '3002', live_weight: 95, hanging_weight: null},
    3003: {sheep_id: 'sheep-test-3003', tag: '3003', live_weight: 85, hanging_weight: null},
  });

  for (const s of sheep) {
    const r = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', s.id).single();
    expect(r.data.flock).toBe('processed');
    expect(r.data.processing_batch_id).toBe(batchId);
  }

  const wis = await supabaseAdmin
    .from('weigh_ins')
    .select('id, tag, prior_herd_or_flock, target_processing_batch_id')
    .eq('session_id', sessionId);
  expect(wis.error).toBeNull();
  expect(wis.data).toHaveLength(3);
  for (const w of wis.data) {
    expect(w.prior_herd_or_flock).toBe('feeders');
    expect(w.prior_herd_or_flock).not.toBe('processed');
    expect(w.target_processing_batch_id).toBe(batchId);
  }

  const xfers = await supabaseAdmin
    .from('sheep_transfers')
    .select('sheep_id, from_flock, to_flock, reason, reference_id')
    .eq('reference_id', batchId)
    .eq('reason', 'processing_batch');
  expect(xfers.error).toBeNull();
  expect(xfers.data).toHaveLength(3);
  for (const x of xfers.data) {
    expect(x.from_flock).toBe('feeders');
    expect(x.to_flock).toBe('processed');
  }

  const sess = await supabaseAdmin.from('weigh_in_sessions').select('status').eq('id', sessionId).single();
  expect(sess.data.status).toBe('complete');
});

// --------------------------------------------------------------------------
// Test 2 — toggle-clear detach (full UI round-trip)
// --------------------------------------------------------------------------
test('toggle-clear: reopen + clear flag detaches via prior_herd_or_flock', async ({
  page,
  sheepSendToProcessorScenario,
  supabaseAdmin,
}) => {
  const {batchId, sessionId} = await sheepSendToProcessorScenario({flock: 'feeders'});

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  // Step 1: attach via UI
  await page.getByRole('button', {name: /Complete Session/}).click();
  await expect(page.getByText(/Send 3 sheep to processor/)).toBeVisible({timeout: 5_000});
  const select = page
    .locator('select')
    .filter({has: page.locator(`option[value="${batchId}"]`)})
    .first();
  await select.selectOption(batchId);
  await page.getByRole('button', {name: 'Send to processor'}).click();
  await expect(page.getByText(/Send 3 sheep to processor/)).toHaveCount(0, {timeout: 10_000});

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('sheep_processing_batches')
          .select('sheep_detail')
          .eq('id', batchId)
          .single();
        return (r.data?.sheep_detail || []).length;
      },
      {timeout: 10_000},
    )
    .toBe(3);

  // Step 2: Reopen session from the record page
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  // Step 3: clear the flag on tag #3002
  const entry3002 = uniqueRow(page, '3002');
  const toggle = entry3002.getByRole('button', {name: '✓ Processor'});
  await expect(toggle).toBeVisible({timeout: 5_000});
  await toggle.click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('sheep')
          .select('flock, processing_batch_id')
          .eq('id', 'sheep-test-3002')
          .single();
        return r.data;
      },
      {timeout: 10_000, message: 'sheep 3002 was not detached'},
    )
    .toEqual({flock: 'feeders', processing_batch_id: null});

  for (const sheepId of ['sheep-test-3001', 'sheep-test-3003']) {
    const r = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', sheepId).single();
    expect(r.data.flock).toBe('processed');
    expect(r.data.processing_batch_id).toBe(batchId);
  }

  const batchR = await supabaseAdmin.from('sheep_processing_batches').select('sheep_detail').eq('id', batchId).single();
  const detailTags = (batchR.data.sheep_detail || []).map((r) => r.tag);
  expect(detailTags).toEqual(expect.arrayContaining(['3001', '3003']));
  expect(detailTags).not.toContain('3002');

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', 'wi-test-sheep-3002')
    .single();
  expect(wi.data.send_to_processor).toBe(false);
  expect(wi.data.target_processing_batch_id).toBeNull();

  const undo = await supabaseAdmin
    .from('sheep_transfers')
    .select('from_flock, to_flock, reason, reference_id')
    .eq('sheep_id', 'sheep-test-3002')
    .eq('reason', 'processing_batch_undo');
  expect(undo.data).toHaveLength(1);
  expect(undo.data[0].from_flock).toBe('processed');
  expect(undo.data[0].to_flock).toBe('feeders');
  expect(undo.data[0].reference_id).toBe(batchId);
});

// --------------------------------------------------------------------------
// Test 3 — entry-delete detach
// --------------------------------------------------------------------------
test('entry-delete: detaches sheep then deletes weigh_in row', async ({
  page,
  sheepPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheepId, entryId, sessionId} = await sheepPreAttachedScenario('with_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await installConfirmDeleteStub(page);

  const entry = uniqueRow(page, '3001');
  await entry.getByRole('button', {name: 'Delete'}).click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('id').eq('id', entryId).maybeSingle();
        return r.data;
      },
      {timeout: 10_000, message: 'weigh_in entry was not deleted'},
    )
    .toBeNull();

  const sheepR = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', sheepId).single();
  expect(sheepR.data.flock).toBe('feeders');
  expect(sheepR.data.processing_batch_id).toBeNull();

  const batchR = await supabaseAdmin.from('sheep_processing_batches').select('sheep_detail').eq('id', batchId).single();
  expect(batchR.data.sheep_detail).toEqual([]);

  const undo = await supabaseAdmin
    .from('sheep_transfers')
    .select('reason')
    .eq('sheep_id', sheepId)
    .eq('reason', 'processing_batch_undo');
  expect(undo.data).toHaveLength(1);
});

// --------------------------------------------------------------------------
// Test 4 — session-delete detach (3-sheep loop)
// --------------------------------------------------------------------------
test('session-delete: detaches all 3 attached sheep then deletes session+entries', async ({
  page,
  sheepBatchPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sessionId, sheep, entryIds} = sheepBatchPreAttachedScenario;

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await installConfirmDeleteStub(page);

  await page.getByRole('button', {name: 'Delete Session'}).click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_in_sessions').select('id').eq('id', sessionId).maybeSingle();
        return r.data;
      },
      {timeout: 10_000, message: 'session was not deleted'},
    )
    .toBeNull();

  const wiR = await supabaseAdmin.from('weigh_ins').select('id').in('id', entryIds);
  expect(wiR.data).toEqual([]);

  for (const s of sheep) {
    const r = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', s.id).single();
    expect(r.data.flock).toBe('feeders');
    expect(r.data.processing_batch_id).toBeNull();
  }

  const batchR = await supabaseAdmin.from('sheep_processing_batches').select('sheep_detail').eq('id', batchId).single();
  expect(batchR.data.sheep_detail).toEqual([]);

  const undo = await supabaseAdmin
    .from('sheep_transfers')
    .select('sheep_id, reason')
    .eq('reason', 'processing_batch_undo')
    .in(
      'sheep_id',
      sheep.map((s) => s.id),
    );
  expect(undo.data).toHaveLength(3);
});

// --------------------------------------------------------------------------
// Test 5 — batch-delete detach (3-sheep loop, drives DeleteModal UI)
// --------------------------------------------------------------------------
test('batch-delete: real DeleteModal flow detaches all 3 sheep and removes batch', async ({
  page,
  sheepBatchPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheep} = sheepBatchPreAttachedScenario;

  await page.goto('/sheep/batches/' + batchId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Delete batch'}).click();

  await expect(page.getByText('Are you sure?')).toBeVisible({timeout: 5_000});
  const input = page.getByPlaceholder('delete');
  await input.fill('delete');
  await page.keyboard.press('Enter');

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('sheep_processing_batches').select('id').eq('id', batchId).maybeSingle();
        return r.data;
      },
      {timeout: 10_000, message: 'batch was not deleted'},
    )
    .toBeNull();

  for (const s of sheep) {
    const r = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', s.id).single();
    expect(r.data.flock).toBe('feeders');
    expect(r.data.processing_batch_id).toBeNull();
  }

  const undo = await supabaseAdmin
    .from('sheep_transfers')
    .select('sheep_id, reason')
    .eq('reason', 'processing_batch_undo')
    .in(
      'sheep_id',
      sheep.map((s) => s.id),
    );
  expect(undo.data).toHaveLength(3);
});

// --------------------------------------------------------------------------
// Test 6 — fallback hierarchy via sheep_transfers audit row
// --------------------------------------------------------------------------
test('fallback: detach reads from_flock off sheep_transfers when prior_herd_or_flock is null', async ({
  page,
  sheepPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {sheepId, sessionId} = await sheepPreAttachedScenario('with_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '3001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', sheepId).single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({flock: 'feeders', processing_batch_id: null});
});

// --------------------------------------------------------------------------
// Test 7 — null from_flock truthy guard blocks
// --------------------------------------------------------------------------
test('fallback null-from-flock: atomic RPC blocks detach when the audit from_flock is null', async ({
  page,
  sheepPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheepId, entryId, sessionId} = await sheepPreAttachedScenario('null_from_flock');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '3001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  // Record page surfaces detach errors via InlineNotice
  await expect(page.getByText(/no prior flock/i)).toBeVisible({timeout: 10_000});

  const sheepR = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', sheepId).single();
  expect(sheepR.data.flock).toBe('processed');
  expect(sheepR.data.processing_batch_id).toBe(batchId);

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', entryId)
    .single();
  expect(wi.data.send_to_processor).toBe(true);
  expect(wi.data.target_processing_batch_id).toBe(batchId);
});

// --------------------------------------------------------------------------
// Test 8 — no audit row at all blocks
// --------------------------------------------------------------------------
test('no_prior_flock: missing audit row + null prior_herd_or_flock blocks detach', async ({
  page,
  sheepPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheepId, entryId, sessionId} = await sheepPreAttachedScenario('no_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '3001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  await expect(page.getByText(/no prior flock/i)).toBeVisible({timeout: 10_000});

  const sheepR = await supabaseAdmin.from('sheep').select('flock, processing_batch_id').eq('id', sheepId).single();
  expect(sheepR.data.flock).toBe('processed');
  expect(sheepR.data.processing_batch_id).toBe(batchId);

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', entryId)
    .single();
  expect(wi.data.send_to_processor).toBe(true);
  expect(wi.data.target_processing_batch_id).toBe(batchId);
});

// --------------------------------------------------------------------------
// Test 9 — looser gate: rams flock CAN attach (UNIQUE TO SHEEP)
// --------------------------------------------------------------------------
test('looser gate: rams-flock entry attaches to processing batch (cattle would refuse)', async ({
  page,
  sheepSendToProcessorScenario,
  supabaseAdmin,
}) => {
  const {batchId, sessionId, sheep} = await sheepSendToProcessorScenario({flock: 'rams'});

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: /Complete Session/}).click();

  const modalTitle = page.getByText(/Send 3 sheep to processor/);
  await expect(modalTitle).toBeVisible({timeout: 5_000});

  const select = page
    .locator('select')
    .filter({has: page.locator(`option[value="${batchId}"]`)})
    .first();
  await select.selectOption(batchId);
  await page.getByRole('button', {name: 'Send to processor'}).click();
  await expect(modalTitle).toHaveCount(0, {timeout: 10_000});

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('sheep_processing_batches')
          .select('sheep_detail')
          .eq('id', batchId)
          .single();
        return (r.data?.sheep_detail || []).length;
      },
      {timeout: 10_000, message: 'rams sheep did not attach'},
    )
    .toBe(3);

  for (const s of sheep) {
    const r = await supabaseAdmin.from('sheep').select('flock').eq('id', s.id).single();
    expect(r.data.flock).toBe('processed');
  }

  const wis = await supabaseAdmin.from('weigh_ins').select('prior_herd_or_flock').eq('session_id', sessionId);
  for (const w of wis.data) {
    expect(w.prior_herd_or_flock).toBe('rams');
    expect(w.prior_herd_or_flock).not.toBe('feeders');
    expect(w.prior_herd_or_flock).not.toBe('processed');
  }

  const xfers = await supabaseAdmin
    .from('sheep_transfers')
    .select('from_flock, to_flock, reason')
    .eq('reference_id', batchId)
    .eq('reason', 'processing_batch');
  expect(xfers.data).toHaveLength(3);
  for (const x of xfers.data) {
    expect(x.from_flock).toBe('rams');
    expect(x.to_flock).toBe('processed');
  }
});

// --------------------------------------------------------------------------
// Test 10 — no manual batch-membership bypass (negative assertion)
// --------------------------------------------------------------------------
test('no manual bypass: /sheep/batches has no manual sheep-attach UI', async ({page, sheepSendToProcessorScenario}) => {
  const {batchName} = await sheepSendToProcessorScenario({flock: 'feeders'});

  await page.goto('/sheep/batches');

  await page.getByRole('button', {name: '+ New Batch'}).click();
  await expect(page.getByText(/New Processing Batch/)).toBeVisible({timeout: 5_000});
  await expect(page.getByText(/sheep weigh-in entry/i)).toBeVisible();

  expect(await page.getByText(/Add sheep from feeders/i).count()).toBe(0);
  expect(await page.getByText(/feeders weigh-in entry/i).count()).toBe(0);

  await page.getByRole('button', {name: 'Cancel'}).click();

  const tile = page.locator('.hoverable-tile').filter({hasText: batchName});
  await tile.click();
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});
  await expect(
    page.getByText(/Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry/i).first(),
  ).toBeVisible({timeout: 5_000});
});

// --------------------------------------------------------------------------
// Test 11 — list-to-record nav + record-page hanging weight save
// --------------------------------------------------------------------------
test('record page: list tile opens record page and saves hanging weight', async ({
  page,
  sheepBatchPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, batchName, sheep} = sheepBatchPreAttachedScenario;

  await page.goto('/sheep/batches');

  const tile = page.locator('.hoverable-tile').filter({hasText: batchName});
  await tile.click();

  await expect(page).toHaveURL(new RegExp('/sheep/batches/' + batchId + '$'));
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});

  const targetSheep = sheep[0];
  const input = page.locator(`[data-batch-sheep-hanging-weight="${targetSheep.id}"]`);
  await expect(input).toBeVisible({timeout: 5_000});
  await input.fill('72.5');
  await input.blur();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('sheep_processing_batches')
          .select('sheep_detail, total_hanging_weight')
          .eq('id', batchId)
          .single();
        const row = (r.data?.sheep_detail || []).find((x) => x.sheep_id === targetSheep.id);
        return {hanging: row?.hanging_weight, total: r.data?.total_hanging_weight};
      },
      {timeout: 10_000, message: 'hanging weight did not persist'},
    )
    .toEqual({hanging: 72.5, total: 72.5});
});
