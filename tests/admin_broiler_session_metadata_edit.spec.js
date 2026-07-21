import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Admin broiler session metadata edit (WK + locked team_member)
// ============================================================================
// Drives /weigh-in-sessions/<id> (WeighInSessionPage) and /broiler/weighins
// (LivestockWeighInsView, now navigation-only) under the default
// authenticated storage state. Locks the metadata panel on the record page,
// broiler-only visibility, locked team_member preservation, and the
// side-effect on app_store.ppp-v4 (recompute OLD week / write NEW week)
// when a complete session's broiler_week changes.
//
// Helper contract (src/lib/broiler.js recomputeBroilerBatchWeekAvg) is
// exercised end-to-end here; unit-level cases live in src/lib/broiler.test.js.
// ============================================================================

async function readPppV4Batch(supabaseAdmin, batchName) {
  const {data} = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-v4').maybeSingle();
  if (!data || !Array.isArray(data.data)) return null;
  return data.data.find((b) => b && b.name === batchName) || null;
}

// =============================================================================
// T1 — Edit DRAFT session: WK 4→6 while locked team BMAN is preserved;
//      ppp-v4 untouched.
// =============================================================================
test('T1: edit draft session WK only; locked team_member preserved; ppp-v4 untouched', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, draftId} = adminBroilerSessionMetaScenario;
  await page.goto('/weigh-in-sessions/' + draftId);

  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});
  const lockedTeam = page.locator('[data-team-member-select-locked="1"]');
  await expect(lockedTeam).toContainText('BMAN');
  await expect(lockedTeam).toContainText('signed in');

  await page.getByTestId('broiler-meta-wk6').click();
  await page.getByTestId('broiler-meta-save').click();

  await expect(page.getByTestId('broiler-meta-save')).toHaveCount(0, {timeout: 10_000});

  const {data: rows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', draftId);
  expect(rows).toHaveLength(1);
  expect(rows[0].broiler_week).toBe(6);
  expect(rows[0].team_member).toBe('BMAN');
  expect(rows[0].status).toBe('draft');

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect(batch.week4Lbs).toBe(1.5);
  expect(batch.week6Lbs).toBeUndefined();
});

// =============================================================================
// T2 — COMPLETE session displays locked team_member and does not offer a
//      metadata save when nothing changed; ppp-v4 untouched.
// =============================================================================
test('T2: complete session locked team_member display; no dirty save; ppp-v4 untouched', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, completeId} = adminBroilerSessionMetaScenario;
  await page.goto('/weigh-in-sessions/' + completeId);

  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});
  const lockedTeam = page.locator('[data-team-member-select-locked="1"]');
  await expect(lockedTeam).toContainText('BMAN');
  await expect(lockedTeam).toContainText('signed in');
  await expect(page.locator('[data-testid="broiler-meta-team"]')).toHaveCount(0);
  await expect(page.getByTestId('broiler-meta-save')).toHaveCount(0);

  const {data: rows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', completeId);
  expect(rows[0].team_member).toBe('BMAN');
  expect(rows[0].broiler_week).toBe(4);

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect(batch.week4Lbs).toBe(1.5);
  expect(batch.week6Lbs).toBeUndefined();
});

// =============================================================================
// T3 — Edit COMPLETE session WK 4→6, no other complete wk4 session.
//      ppp-v4: week4Lbs DELETED, week6Lbs = session avg (1.5).
// =============================================================================
test('T3: edit complete session WK 4→6 (sole wk4) → wk4Lbs deleted, wk6Lbs set', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, completeId} = adminBroilerSessionMetaScenario;
  await page.goto('/weigh-in-sessions/' + completeId);

  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});

  await page.getByTestId('broiler-meta-wk6').click();
  await page.getByTestId('broiler-meta-save').click();
  await expect(page.getByTestId('broiler-meta-save')).toHaveCount(0, {timeout: 10_000});

  const {data: rows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', completeId);
  expect(rows[0].broiler_week).toBe(6);

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect('week4Lbs' in batch).toBe(false);
  expect(batch.week6Lbs).toBe(1.5);
});

// =============================================================================
// T4 — Two complete wk4 sessions: edit the LATER one to WK 6.
//      ppp-v4.week4Lbs = OTHER session's avg (excludeSessionId locked it
//      out so the moved session's stale value can't win).
//      ppp-v4.week6Lbs = changed session's avg.
// =============================================================================
test('T4: two complete wk4 sessions, move later one to WK6 → wk4Lbs from other, wk6Lbs from moved', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, completeId} = adminBroilerSessionMetaScenario;

  const otherId = 'sd-complete-other';
  const today = new Date().toISOString().slice(0, 10);
  const completedEarlier = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  let r = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: otherId,
      species: 'broiler',
      herd: null,
      status: 'complete',
      date: today,
      team_member: 'BMAN',
      batch_id: batchId,
      broiler_week: 4,
      started_at: completedEarlier,
      completed_at: completedEarlier,
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  expect(r.error).toBeNull();
  const otherEntries = [1.7, 1.7, 1.7].map((w, i) => ({
    id: `${otherId}-e${i}`,
    session_id: otherId,
    tag: i % 2 === 0 ? '2' : '3',
    weight: w,
    note: null,
    new_tag_flag: false,
    entered_at: completedEarlier,
    client_submission_id: null,
    sent_to_trip_id: null,
    sent_to_group_id: null,
    send_to_processor: false,
    target_processing_batch_id: null,
    transferred_to_breeding: false,
    transfer_breeder_id: null,
    feed_allocation_lbs: null,
    prior_herd_or_flock: null,
  }));
  r = await supabaseAdmin.from('weigh_ins').upsert(otherEntries, {onConflict: 'id'});
  expect(r.error).toBeNull();

  await page.goto('/weigh-in-sessions/' + completeId);
  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});

  await page.getByTestId('broiler-meta-wk6').click();
  await page.getByTestId('broiler-meta-save').click();
  await expect(page.getByTestId('broiler-meta-save')).toHaveCount(0, {timeout: 10_000});

  const {data: movedRows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', completeId);
  expect(movedRows[0].broiler_week).toBe(6);

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect(batch.week4Lbs).toBe(1.7);
  expect(batch.week6Lbs).toBe(1.5);
});

// =============================================================================
// T5 — Regression: weight-grid save path still preserves entries AND session
//      notes on the record page.
// =============================================================================
test('T5: weight-grid save still preserves entries and notes on record page', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {completeId} = adminBroilerSessionMetaScenario;

  const NOTE = 'admin-test-note do not lose';
  let r = await supabaseAdmin.from('weigh_in_sessions').update({notes: NOTE}).eq('id', completeId);
  expect(r.error).toBeNull();

  await page.goto('/weigh-in-sessions/' + completeId);

  await expect(page.locator('[data-broiler-grid="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Save Weights'}).click();
  await expect(page.getByRole('button', {name: 'Save Weights'})).toBeEnabled({timeout: 10_000});

  const {data: weighIns} = await supabaseAdmin.from('weigh_ins').select('weight').eq('session_id', completeId);
  expect(weighIns).toHaveLength(5);
  const weights = weighIns.map((row) => Number(row.weight)).sort();
  expect(weights).toEqual([1.3, 1.4, 1.5, 1.6, 1.7]);

  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('notes').eq('id', completeId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].notes).toBe(NOTE);
});

// =============================================================================
// T6 — Negative UI lock: pig sessions do NOT render the broiler metadata
// panel on /weigh-in-sessions/<id>.
// =============================================================================
test('T6: pig complete session does NOT show the broiler metadata panel', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  void adminBroilerSessionMetaScenario;

  let r = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'active_groups', data: ['P-26-01']}, {onConflict: 'key'});
  expect(r.error).toBeNull();
  const today = new Date().toISOString().slice(0, 10);
  const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const completedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  r = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: 'pig-sess-1',
      species: 'pig',
      herd: null,
      status: 'complete',
      date: today,
      team_member: 'BMAN',
      batch_id: 'P-26-01',
      broiler_week: null,
      started_at: startedAt,
      completed_at: completedAt,
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  expect(r.error).toBeNull();

  await page.goto('/weigh-in-sessions/pig-sess-1');
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-broiler-grid]')).toHaveCount(0);
});

// =============================================================================
// T7 — Legacy team_member preservation on the record page. Session has
//      team_member='RETIREE' from old data; locked display shows the saved
//      value and a WK-only save preserves team_member.
// =============================================================================
test('T7: legacy team_member preserved across a WK-only save', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId} = adminBroilerSessionMetaScenario;

  const today = new Date().toISOString().slice(0, 10);
  const completed = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const retiredId = 'sd-retired';
  let r = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: retiredId,
      species: 'broiler',
      herd: null,
      status: 'complete',
      date: today,
      team_member: 'RETIREE',
      batch_id: batchId,
      broiler_week: 4,
      started_at: completed,
      completed_at: completed,
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  expect(r.error).toBeNull();
  r = await supabaseAdmin.from('weigh_ins').upsert(
    [
      {
        id: `${retiredId}-e0`,
        session_id: retiredId,
        tag: '2',
        weight: 2.0,
        note: null,
        new_tag_flag: false,
        entered_at: completed,
        client_submission_id: null,
        sent_to_trip_id: null,
        sent_to_group_id: null,
        send_to_processor: false,
        target_processing_batch_id: null,
        transferred_to_breeding: false,
        transfer_breeder_id: null,
        feed_allocation_lbs: null,
        prior_herd_or_flock: null,
      },
      {
        id: `${retiredId}-e1`,
        session_id: retiredId,
        tag: '3',
        weight: 2.0,
        note: null,
        new_tag_flag: false,
        entered_at: completed,
        client_submission_id: null,
        sent_to_trip_id: null,
        sent_to_group_id: null,
        send_to_processor: false,
        target_processing_batch_id: null,
        transferred_to_breeding: false,
        transfer_breeder_id: null,
        feed_allocation_lbs: null,
        prior_herd_or_flock: null,
      },
    ],
    {onConflict: 'id'},
  );
  expect(r.error).toBeNull();

  await page.goto('/weigh-in-sessions/' + retiredId);
  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});

  const lockedTeam = page.locator('[data-team-member-select-locked="1"]');
  await expect(lockedTeam).toContainText('RETIREE');
  await expect(lockedTeam).toContainText('signed in');
  await expect(page.locator('[data-testid="broiler-meta-team"]')).toHaveCount(0);

  await page.getByTestId('broiler-meta-wk6').click();
  await page.getByTestId('broiler-meta-save').click();
  await expect(page.getByTestId('broiler-meta-save')).toHaveCount(0, {timeout: 10_000});

  const {data: rows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', retiredId);
  expect(rows[0].team_member).toBe('RETIREE');
  expect(rows[0].broiler_week).toBe(6);
});

// =============================================================================
// T8 — Reopen sole complete wk4 session: status flips to draft,
//      completed_at clears, and ppp-v4.week4Lbs is DELETED.
// =============================================================================
test('T8: reopen sole complete wk4 session → draft + completed_at null + week4Lbs deleted', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, completeId} = adminBroilerSessionMetaScenario;
  await page.goto('/weigh-in-sessions/' + completeId);

  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();
  await expect(page.getByRole('button', {name: 'Reopen Session'})).toHaveCount(0, {timeout: 10_000});

  const {data: rows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', completeId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('draft');
  expect(rows[0].completed_at).toBeNull();

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect('week4Lbs' in batch).toBe(false);
  expect(batch.week6Lbs).toBeUndefined();
});

// =============================================================================
// T9 — Reopen one of two complete wk4 sessions: ppp-v4.week4Lbs
//      RECOMPUTES from the OTHER complete wk4 session.
// =============================================================================
test('T9: reopen later complete wk4 session of two → wk4Lbs recomputes from the other', async ({
  page,
  supabaseAdmin,
  adminBroilerSessionMetaScenario,
}) => {
  const {batchId, completeId} = adminBroilerSessionMetaScenario;

  const otherId = 'sd-complete-other';
  const today = new Date().toISOString().slice(0, 10);
  const completedEarlier = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  let r = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: otherId,
      species: 'broiler',
      herd: null,
      status: 'complete',
      date: today,
      team_member: 'BMAN',
      batch_id: batchId,
      broiler_week: 4,
      started_at: completedEarlier,
      completed_at: completedEarlier,
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  expect(r.error).toBeNull();
  const otherEntries = [1.7, 1.7, 1.7].map((w, i) => ({
    id: `${otherId}-e${i}`,
    session_id: otherId,
    tag: i % 2 === 0 ? '2' : '3',
    weight: w,
    note: null,
    new_tag_flag: false,
    entered_at: completedEarlier,
    client_submission_id: null,
    sent_to_trip_id: null,
    sent_to_group_id: null,
    send_to_processor: false,
    target_processing_batch_id: null,
    transferred_to_breeding: false,
    transfer_breeder_id: null,
    feed_allocation_lbs: null,
    prior_herd_or_flock: null,
  }));
  r = await supabaseAdmin.from('weigh_ins').upsert(otherEntries, {onConflict: 'id'});
  expect(r.error).toBeNull();

  await page.goto('/weigh-in-sessions/' + completeId);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  await page.getByRole('button', {name: 'Reopen Session'}).click();
  await expect(page.getByRole('button', {name: 'Reopen Session'})).toHaveCount(0, {timeout: 10_000});

  const {data: reopenedRows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', completeId);
  expect(reopenedRows[0].status).toBe('draft');
  expect(reopenedRows[0].completed_at).toBeNull();

  const {data: otherRows} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', otherId);
  expect(otherRows[0].status).toBe('complete');

  const batch = await readPppV4Batch(supabaseAdmin, batchId);
  expect(batch.week4Lbs).toBe(1.7);
  expect(batch.week6Lbs).toBeUndefined();
});

// =============================================================================
// T10 — Broiler list tiles navigate to record page.
// =============================================================================
test('T10: broiler list tiles navigate to record page', async ({page, adminBroilerSessionMetaScenario}) => {
  const {draftId} = adminBroilerSessionMetaScenario;
  await page.goto('/broiler/weighins');
  await waitForAppReady(page);

  await page.locator('[data-weighin-session-tile="' + draftId + '"]').click();
  await expect(page).toHaveURL(/\/weigh-in-sessions\//);
  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 15_000});
});
