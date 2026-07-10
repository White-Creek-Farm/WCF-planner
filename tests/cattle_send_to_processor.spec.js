import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Send-to-Processor spec — Phase A5
// ============================================================================
// Drives /weigh-in-sessions/<id> (WeighInSessionPage) under the default
// authenticated storage state. Locks the §7 cattle Send-to-Processor contract
// (PROJECT.md §7 entries: weigh_ins.prior_herd_or_flock semantics, detach
// fallback hierarchy, cattle_transfers append-only, batch membership rule).
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
// Test 2 — toggle-clear detach (full UI round-trip: attach → reopen → toggle)
// --------------------------------------------------------------------------
test('toggle-clear: reopen + clear flag detaches via prior_herd_or_flock', async ({
  page,
  cattleSendToProcessorScenario,
  supabaseAdmin,
}) => {
  const {sessionId} = cattleSendToProcessorScenario;

  await supabaseAdmin.from('cattle_processing_batches').delete().neq('id', '__never_match__');
  await supabaseAdmin
    .from('cattle')
    .update({processing_batch_id: null})
    .in('id', ['cow-test-2001', 'cow-test-2002', 'cow-test-2003']);

  await supabaseAdmin
    .from('cattle_forecast_settings')
    .upsert({id: 'global', display_weight_min: 1000, display_weight_max: 1500}, {onConflict: 'id'});

  // Navigate directly to the record page
  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: /Complete Session/}).click();
  await expect(page.locator('[data-cattle-send-modal]')).toBeVisible({timeout: 5_000});
  const confirm = page.locator('[data-send-modal-confirm]');
  await expect(confirm).toBeEnabled({timeout: 5_000});
  await confirm.click();
  await expect(page.locator('[data-cattle-send-modal]')).toHaveCount(0, {timeout: 10_000});

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('cattle_processing_batches')
          .select('id, cows_detail')
          .eq('status', 'active');
        return (r.data || [])[0]?.cows_detail?.length || 0;
      },
      {timeout: 10_000, message: 'attach did not land 3 cows on the new active batch'},
    )
    .toBe(3);
  const batchRow = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('id, name')
    .eq('status', 'active')
    .single();
  const newBatchId = batchRow.data.id;

  // Reopen the now-complete session from the record page
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  // Clear the flag on tag #2002
  const entry2002 = uniqueRow(page, '2002');
  const toggle = entry2002.getByRole('button', {name: '✓ Processor'});
  await expect(toggle).toBeVisible({timeout: 5_000});
  await toggle.click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('cattle')
          .select('herd, processing_batch_id')
          .eq('id', 'cow-test-2002')
          .single();
        return r.data;
      },
      {timeout: 10_000, message: 'cow 2002 was not detached'},
    )
    .toEqual({herd: 'finishers', processing_batch_id: null});

  for (const cowId of ['cow-test-2001', 'cow-test-2003']) {
    const r = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
    expect(r.data.herd).toBe('processed');
    expect(r.data.processing_batch_id).toBe(newBatchId);
  }

  const batchR = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('cows_detail')
    .eq('id', newBatchId)
    .single();
  const detailTags = (batchR.data.cows_detail || []).map((r) => r.tag);
  expect(detailTags).toEqual(expect.arrayContaining(['2001', '2003']));
  expect(detailTags).not.toContain('2002');

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', 'wi-test-cattle-2002')
    .single();
  expect(wi.data.send_to_processor).toBe(false);
  expect(wi.data.target_processing_batch_id).toBeNull();

  const undo = await supabaseAdmin
    .from('cattle_transfers')
    .select('from_herd, to_herd, reason, reference_id')
    .eq('cattle_id', 'cow-test-2002')
    .eq('reason', 'processing_batch_undo');
  expect(undo.data).toHaveLength(1);
  expect(undo.data[0].from_herd).toBe('processed');
  expect(undo.data[0].to_herd).toBe('finishers');
  expect(undo.data[0].reference_id).toBe(newBatchId);
});

// --------------------------------------------------------------------------
// Test 3 — entry-delete detach
// --------------------------------------------------------------------------
test('entry-delete: detaches cow then deletes weigh_in row', async ({
  page,
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cowId, entryId, sessionId} = await cattlePreAttachedScenario('with_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await installConfirmDeleteStub(page);

  const entry = uniqueRow(page, '2001');
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

  const cowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
  expect(cowR.data.herd).toBe('finishers');
  expect(cowR.data.processing_batch_id).toBeNull();

  const batchR = await supabaseAdmin.from('cattle_processing_batches').select('cows_detail').eq('id', batchId).single();
  expect(batchR.data.cows_detail).toEqual([]);

  const undo = await supabaseAdmin
    .from('cattle_transfers')
    .select('reason')
    .eq('cattle_id', cowId)
    .eq('reason', 'processing_batch_undo');
  expect(undo.data).toHaveLength(1);
});

// --------------------------------------------------------------------------
// Test 4 — session-delete detach
// --------------------------------------------------------------------------
test('session-delete: detaches all 3 attached cows then deletes session+entries', async ({
  page,
  cattleMultiCowPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sessionId, cows, entryIds} = cattleMultiCowPreAttachedScenario;

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

  for (const cow of cows) {
    const r = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cow.id).single();
    expect(r.data.herd).toBe('finishers');
    expect(r.data.processing_batch_id).toBeNull();
  }

  const batchR = await supabaseAdmin.from('cattle_processing_batches').select('cows_detail').eq('id', batchId).single();
  expect(batchR.data.cows_detail).toEqual([]);

  const undo = await supabaseAdmin
    .from('cattle_transfers')
    .select('cattle_id, reason')
    .eq('reason', 'processing_batch_undo')
    .in(
      'cattle_id',
      cows.map((c) => c.id),
    );
  expect(undo.data).toHaveLength(3);
});

// --------------------------------------------------------------------------
// Test 6 — fallback hierarchy via cattle_transfers audit row
// --------------------------------------------------------------------------
test('fallback: detach reads from_herd off cattle_transfers when prior_herd_or_flock is null', async ({
  page,
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {cowId, sessionId} = await cattlePreAttachedScenario('with_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  // Record page loads the complete session; reopen it
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({herd: 'finishers', processing_batch_id: null});
});

// --------------------------------------------------------------------------
// Test 7 — null from_herd: truthy guard forces no_prior_herd
// --------------------------------------------------------------------------
test('fallback null-from-herd: atomic RPC blocks detach when the audit from_herd is null', async ({
  page,
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cowId, entryId, sessionId} = await cattlePreAttachedScenario('null_from_herd');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  // Record page uses InlineNotice instead of window.alert for detach errors
  await expect(page.getByText(/no prior herd/i)).toBeVisible({timeout: 10_000});

  const cowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
  expect(cowR.data.herd).toBe('processed');
  expect(cowR.data.processing_batch_id).toBe(batchId);

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', entryId)
    .single();
  expect(wi.data.send_to_processor).toBe(true);
  expect(wi.data.target_processing_batch_id).toBe(batchId);
});

// --------------------------------------------------------------------------
// Test 8 — no audit row at all: detach blocked, state unchanged
// --------------------------------------------------------------------------
test('no_prior_herd: missing audit row + null prior_herd_or_flock blocks detach', async ({
  page,
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cowId, entryId, sessionId} = await cattlePreAttachedScenario('no_audit_row');

  await page.goto('/weigh-in-sessions/' + sessionId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  await expect(page.getByText(/no prior herd/i)).toBeVisible({timeout: 10_000});

  const cowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
  expect(cowR.data.herd).toBe('processed');
  expect(cowR.data.processing_batch_id).toBe(batchId);

  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', entryId)
    .single();
  expect(wi.data.send_to_processor).toBe(true);
  expect(wi.data.target_processing_batch_id).toBe(batchId);
});

// --------------------------------------------------------------------------
// Test 9 — no manual batch-membership bypass (negative assertion)
// --------------------------------------------------------------------------
test('no manual bypass: /cattle/batches has no + New Batch and no manual cow-attach UI', async ({
  page,
  cattleSendToProcessorScenario,
}) => {
  await page.goto('/cattle/batches');
  await expect(page.locator('[data-cattle-batches-root]')).toBeVisible({timeout: 15_000});

  await expect(page.getByRole('button', {name: '+ New Batch'})).toHaveCount(0);
  expect(await page.getByText(/Add cow from finishers/i).count()).toBe(0);
  expect(await page.getByText(/from the Herds tab/i).count()).toBe(0);
});
