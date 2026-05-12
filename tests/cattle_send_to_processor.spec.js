import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Send-to-Processor spec — Phase A5
// ============================================================================
// Codex-reviewed scope: lock the §7 cattle Send-to-Processor contract
// (PROJECT.md §7 entries: weigh_ins.prior_herd_or_flock semantics, detach
// fallback hierarchy, cattle_transfers append-only, batch membership rule).
//
// Active tests, structured around the §7 entries each one protects:
//
//   toggle-clear detach    — full UI round-trip (attach via UI,
//                            reopen, toggle off) — the clearest
//                            regression for the four detach paths
//   entry-delete detach    — stub _wcfConfirmDelete post-mount
//   session-delete detach  — stub _wcfConfirmDelete post-mount
//   fallback to audit row  — prior_herd_or_flock null →
//                            cattle_transfers.from_herd resolves
//   null from_herd guard   — audit row exists but from_herd=null →
//                            truthy guard at cattleProcessingBatch.js:177
//                            forces no_prior_herd
//   no audit row block     — neither path resolves → blocked
//   no manual bypass       — /cattle/batches has no manual cow
//                            attach UI (negative assertion)
//
// Happy-path attach is covered by tests/cattle_forecast.spec.js
// ('forecast → send: active batch saved with exact virtual batch name').
// Multi-row detach loop is covered by the session-delete test below
// (same cattleProcessingBatch detach helper, three-cow scenario).
// Pre-attached + fallback seeds keep setup noise focused on detach
// behavior under test.
// ============================================================================

const HERD_LABEL = 'Finishers';

function uniqueRow(page, tag) {
  // The entry rendered in CattleWeighInsView is a div containing a span with
  // the tag (`#NNNN`) and a button-row with Edit + Delete (+ ✓ Processor on
  // finishers). The tag span and the buttons live in SIBLING flex rows
  // inside the entry box, so we need a filter that requires BOTH descendants
  // — `.first()` returns the outermost ancestor (matches every entry's
  // buttons; strict-mode trips on >1 entry), `.last()` returns the inner
  // tag-only row (no buttons inside). Anchoring on the always-present Edit
  // button forces the match to the entry box (or its flex-column child).
  return page
    .locator('div')
    .filter({has: page.locator('span', {hasText: new RegExp(`^#${tag}$`)})})
    .filter({has: page.getByRole('button', {name: 'Edit', exact: true})})
    .last();
}

async function installConfirmDeleteStub(page) {
  // main.jsx assigns window._wcfConfirmDelete in a useEffect after first
  // render (line ~1509). Wait for it to land, then overwrite. Codex's race
  // concern with addInitScript is precisely that the init-script stub gets
  // overwritten by main.jsx; post-mount evaluate avoids the race entirely.
  await page.waitForFunction(() => typeof window._wcfConfirmDelete === 'function');
  await page.evaluate(() => {
    window._wcfConfirmDelete = (_msg, fn) => fn();
  });
}

// --------------------------------------------------------------------------
// Test 2 — toggle-clear detach (full UI round-trip: attach → reopen → toggle)
// --------------------------------------------------------------------------
// REWRITTEN 2026-05-04 for the Cattle Forecast lane (mig 043). Old setup
// drove a retired modal-with-batch-picker; the operator toggle-clear flow
// itself stays — admin can still reopen a complete session and unflag an
// attached entry to detach. The rewrite drives the new forecast-backed
// send modal first to create the active batch, then reopens and toggle-
// clears one entry.
test('toggle-clear: reopen + clear flag detaches via prior_herd_or_flock', async ({
  page,
  cattleSendToProcessorScenario,
  supabaseAdmin,
}) => {
  const {sessionId} = cattleSendToProcessorScenario;

  // Drop the seed's pre-created C-26-01 batch so the new send flow creates
  // its own active batch. The seed cattle live in 'finishers' regardless.
  await supabaseAdmin.from('cattle_processing_batches').delete().neq('id', '__never_match__');
  await supabaseAdmin
    .from('cattle')
    .update({processing_batch_id: null})
    .in('id', ['cow-test-2001', 'cow-test-2002', 'cow-test-2003']);

  // Seed weights are 1080-1150 lb — below the default 1200 display window.
  // Widen the window to 1000-1500 just for this test so all 3 cows land
  // in next.allowedTagSet and the gate accepts the 3-cow send.
  await supabaseAdmin
    .from('cattle_forecast_settings')
    .upsert({id: 'global', display_weight_min: 1000, display_weight_max: 1500}, {onConflict: 'id'});

  // Step 1: drive the new send modal (no batch picker; auto-creates active).
  await page.goto('/cattle/weighins');
  const sessionRow = page.locator('.hoverable-tile').filter({hasText: HERD_LABEL}).filter({hasText: /draft/i});
  await sessionRow.click();
  await page.getByRole('button', {name: /Complete Session/}).click();
  await expect(page.locator('[data-cattle-send-modal]')).toBeVisible({timeout: 5_000});
  // Confirm should be enabled — all 3 tags in allowed set.
  const confirm = page.locator('[data-send-modal-confirm]');
  await expect(confirm).toBeEnabled({timeout: 5_000});
  await confirm.click();
  await expect(page.locator('[data-cattle-send-modal]')).toHaveCount(0, {timeout: 10_000});

  // Step 2: locate the new active batch and capture its id.
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

  // Step 3: reopen the (now-complete) session so the toggle button re-renders.
  // The completion flow preserves expandedSession state, so the panel is
  // still open — DON'T re-click the row, that would COLLAPSE it.
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  // Step 4: clear the flag on tag #2002. The button label is '✓ Processor'
  // because send_to_processor stays true after reopen — that's the very
  // state toggle-clear was built to handle.
  const entry2002 = uniqueRow(page, '2002');
  const toggle = entry2002.getByRole('button', {name: '✓ Processor'});
  await expect(toggle).toBeVisible({timeout: 5_000});
  await toggle.click();

  // --- Assertions: cow 2002 detached, others untouched. ---
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

  // batch.cows_detail dropped tag 2002.
  const batchR = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('cows_detail')
    .eq('id', newBatchId)
    .single();
  const detailTags = (batchR.data.cows_detail || []).map((r) => r.tag);
  expect(detailTags).toEqual(expect.arrayContaining(['2001', '2003']));
  expect(detailTags).not.toContain('2002');

  // weigh_ins for tag 2002 fully cleared (both flags per
  // cattleProcessingBatch.js detach helper).
  const wi = await supabaseAdmin
    .from('weigh_ins')
    .select('send_to_processor, target_processing_batch_id')
    .eq('id', 'wi-test-cattle-2002')
    .single();
  expect(wi.data.send_to_processor).toBe(false);
  expect(wi.data.target_processing_batch_id).toBeNull();

  // Append-only audit row written.
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
  const {batchId, cowId, entryId} = await cattlePreAttachedScenario('with_audit_row');

  await page.goto('/cattle/weighins');
  await installConfirmDeleteStub(page);

  // Reopen the seeded complete session to expose the per-entry Delete button.
  // (Delete buttons render on both draft + complete, but reopening keeps the
  // row layout consistent with the toggle-clear test path.)
  const sessionRow = page.locator('.hoverable-tile').filter({hasText: HERD_LABEL});
  await sessionRow.click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: 'Delete', exact: true}).click();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('id').eq('id', entryId).maybeSingle();
        return r.data;
      },
      {timeout: 10_000, message: 'weigh_in entry was not deleted'},
    )
    .toBeNull();

  // Cow reverted via the audit-row fallback (mode='with_audit_row').
  const cowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
  expect(cowR.data.herd).toBe('finishers');
  expect(cowR.data.processing_batch_id).toBeNull();

  // Batch.cows_detail dropped the cow.
  const batchR = await supabaseAdmin.from('cattle_processing_batches').select('cows_detail').eq('id', batchId).single();
  expect(batchR.data.cows_detail).toEqual([]);

  // Undo audit row written.
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

  await page.goto('/cattle/weighins');
  await installConfirmDeleteStub(page);

  const sessionRow = page.locator('.hoverable-tile').filter({hasText: HERD_LABEL});
  await sessionRow.click();

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

  // All 3 entries deleted (FK cascade on weigh_ins.session_id).
  const wiR = await supabaseAdmin.from('weigh_ins').select('id').in('id', entryIds);
  expect(wiR.data).toEqual([]);

  // ALL 3 cows reverted — exercises the loop, not just N=1.
  for (const cow of cows) {
    const r = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cow.id).single();
    expect(r.data.herd).toBe('finishers');
    expect(r.data.processing_batch_id).toBeNull();
  }

  // Batch.cows_detail emptied.
  const batchR = await supabaseAdmin.from('cattle_processing_batches').select('cows_detail').eq('id', batchId).single();
  expect(batchR.data.cows_detail).toEqual([]);

  // 3 undo audit rows — one per cow.
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
  const {cowId} = await cattlePreAttachedScenario('with_audit_row');

  await page.goto('/cattle/weighins');

  // Reopen session to surface the toggle button.
  const sessionRow = page
    .locator('.hoverable-tile')
    .filter({hasText: HERD_LABEL})
    .filter({hasText: /complete/i});
  await sessionRow.click();
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  // Cow reverted to 'finishers' — sourced from cattle_transfers.from_herd
  // because weigh_ins.prior_herd_or_flock is null.
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
test('fallback null-from-herd: truthy guard at cattleProcessingBatch.js:177 blocks detach', async ({
  page,
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cowId, entryId} = await cattlePreAttachedScenario('null_from_herd');

  // Capture window.alert before the action.
  const dialogMessages = [];
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto('/cattle/weighins');

  const sessionRow = page
    .locator('.hoverable-tile')
    .filter({hasText: HERD_LABEL})
    .filter({hasText: /complete/i});
  await sessionRow.click();
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  // Wait for the alert to fire.
  await expect.poll(() => dialogMessages.length, {timeout: 10_000}).toBeGreaterThan(0);

  // Codex's contains-match guidance — exact text is implementation detail.
  expect(dialogMessages.join(' ')).toContain('no prior herd recorded');
  expect(dialogMessages.join(' ')).toContain('Herds tab');

  // Cow STILL at processed (toggle aborted before clearing flag —
  // CattleWeighInsView.jsx:141-144).
  const cowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', cowId).single();
  expect(cowR.data.herd).toBe('processed');
  expect(cowR.data.processing_batch_id).toBe(batchId);

  // Flag still set (toggle aborted, no DB write).
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
  const {batchId, cowId, entryId} = await cattlePreAttachedScenario('no_audit_row');

  const dialogMessages = [];
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto('/cattle/weighins');

  const sessionRow = page
    .locator('.hoverable-tile')
    .filter({hasText: HERD_LABEL})
    .filter({hasText: /complete/i});
  await sessionRow.click();
  await page.getByRole('button', {name: 'Reopen Session'}).click();

  const entry = uniqueRow(page, '2001');
  await entry.getByRole('button', {name: '✓ Processor'}).click();

  await expect.poll(() => dialogMessages.length, {timeout: 10_000}).toBeGreaterThan(0);
  expect(dialogMessages.join(' ')).toContain('no prior herd recorded');

  // State unchanged — same assertions as Test 7.
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
  // The Cattle Forecast lane (mig 043) retired manual batch creation; real
  // batches only land via Send-to-Processor at /cattle/weighins. The +
  // New Batch button is gone entirely.
  await page.goto('/cattle/batches');
  await expect(page.locator('[data-cattle-batches-root]')).toBeVisible({timeout: 15_000});

  // Positive-absence assertions — no creation surface, no manual attach.
  await expect(page.getByRole('button', {name: '+ New Batch'})).toHaveCount(0);
  expect(await page.getByText(/Add cow from finishers/i).count()).toBe(0);
  expect(await page.getByText(/from the Herds tab/i).count()).toBe(0);
});
