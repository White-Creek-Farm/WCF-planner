import {test, expect} from './fixtures.js';
import {waitForWeighInListLoaded, waitForWeighInSessionLoaded} from './helpers/weighInReady.js';

// ============================================================================
// Weigh-in session record page hardening spec
// ============================================================================
// Focused Playwright coverage for /weigh-in-sessions/<id> across all species:
// list-to-record navigation, save/reload persistence, and Comments hash scroll.
//
// Uses lightweight inline seeds (supabaseAdmin inserts per test) rather than
// dedicated seed files. Each test resets the DB and seeds its own minimal data.
//
// Each navigation waits on a real readiness marker (see helpers/weighInReady.js)
// before asserting, so the spec does not race a cold Vite compile + the app's
// farm-data load against per-assertion timeouts.
// ============================================================================

async function seedSession(
  supabaseAdmin,
  {id, species, herd, batchId, status = 'draft', broilerWeek, teamMember, date},
) {
  const today = date || new Date().toISOString().slice(0, 10);
  const startedAt = date ? `${date}T08:00:00.000Z` : new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = {
    id,
    species,
    herd: herd || null,
    batch_id: batchId || null,
    date: today,
    team_member: teamMember || 'BMAN',
    status,
    started_at: startedAt,
    // Resets so a stale worker row can't keep a prior completion/notes/week
    // (the conditionals below override completed_at / broiler_week when set).
    completed_at: null,
    notes: null,
    client_submission_id: null,
    broiler_week: null,
  };
  if (status === 'complete') row.completed_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  if (broilerWeek) row.broiler_week = broilerWeek;
  const r = await supabaseAdmin.from('weigh_in_sessions').upsert(row, {onConflict: 'id'});
  if (r.error) throw new Error('seedSession: ' + r.error.message);
  return row;
}

async function seedEntry(supabaseAdmin, {id, sessionId, tag, weight, note}) {
  const row = {
    id,
    session_id: sessionId,
    tag: tag || null,
    weight,
    note: note || null,
    new_tag_flag: false,
    entered_at: new Date().toISOString(),
    // Resets so a stale worker row can't keep prior trip/breeding/processor flags.
    client_submission_id: null,
    sent_to_trip_id: null,
    sent_to_group_id: null,
    send_to_processor: false,
    target_processing_batch_id: null,
    transferred_to_breeding: false,
    transfer_breeder_id: null,
    feed_allocation_lbs: null,
    prior_herd_or_flock: null,
  };
  const r = await supabaseAdmin.from('weigh_ins').upsert(row, {onConflict: 'id'});
  if (r.error) throw new Error('seedEntry: ' + r.error.message);
  return row;
}

// ============================================================================
// List-to-record navigation
// ============================================================================

test('cattle list tile navigates to /weigh-in-sessions/<id>', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const sess = await seedSession(supabaseAdmin, {id: 'nav-cattle-1', species: 'cattle', herd: 'finishers'});
  await seedEntry(supabaseAdmin, {id: 'nav-cattle-e1', sessionId: sess.id, tag: '100', weight: 500});

  await page.goto('/cattle/weighins');
  await waitForWeighInListLoaded(page);
  await expect(page.locator(`[data-weighin-session-tile="${sess.id}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-weighin-session-tile="${sess.id}"]`).click();

  await expect(page).toHaveURL(/\/weigh-in-sessions\/nav-cattle-1/);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});
});

test('sheep list tile navigates to /weigh-in-sessions/<id>', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const sess = await seedSession(supabaseAdmin, {id: 'nav-sheep-1', species: 'sheep', herd: 'feeders'});
  await seedEntry(supabaseAdmin, {id: 'nav-sheep-e1', sessionId: sess.id, tag: '200', weight: 80});

  await page.goto('/sheep/weighins');
  await waitForWeighInListLoaded(page);
  await expect(page.locator(`[data-weighin-session-tile="${sess.id}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-weighin-session-tile="${sess.id}"]`).click();

  await expect(page).toHaveURL(/\/weigh-in-sessions\/nav-sheep-1/);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});
});

test('pig list tile navigates to /weigh-in-sessions/<id>', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('webform_config').upsert({key: 'active_groups', data: ['P-TEST-01']}, {onConflict: 'key'});
  const sess = await seedSession(supabaseAdmin, {id: 'nav-pig-1', species: 'pig', batchId: 'P-TEST-01'});
  await seedEntry(supabaseAdmin, {id: 'nav-pig-e1', sessionId: sess.id, weight: 250});

  await page.goto('/pig/weighins');
  await waitForWeighInListLoaded(page);
  await expect(page.locator(`[data-weighin-session-tile="${sess.id}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-weighin-session-tile="${sess.id}"]`).click();

  await expect(page).toHaveURL(/\/weigh-in-sessions\/nav-pig-1/);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 10_000});
});

test('broiler list tile navigates to /weigh-in-sessions/<id>', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('webform_config').upsert({key: 'broiler_groups', data: ['B-TEST-01']}, {onConflict: 'key'});
  await supabaseAdmin
    .from('app_store')
    .upsert(
      {key: 'ppp-v4', data: [{name: 'B-TEST-01', schooner: '1', breed: 'CC', status: 'active'}]},
      {onConflict: 'key'},
    );
  const sess = await seedSession(supabaseAdmin, {
    id: 'nav-broiler-1',
    species: 'broiler',
    batchId: 'B-TEST-01',
    broilerWeek: 4,
  });

  await page.goto('/broiler/weighins');
  await waitForWeighInListLoaded(page);
  await expect(page.locator(`[data-weighin-session-tile="${sess.id}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-weighin-session-tile="${sess.id}"]`).click();

  await expect(page).toHaveURL(/\/weigh-in-sessions\/nav-broiler-1/);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-testid="broiler-meta-panel"]')).toBeVisible({timeout: 10_000});
});

// ============================================================================
// Autosave/reload persistence
// ============================================================================

test('cattle: edit weight + note, autosave, reload, persist', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const priorSess = await seedSession(supabaseAdmin, {
    id: 'save-cattle-prior-1',
    species: 'cattle',
    herd: 'finishers',
    status: 'complete',
    date: '2026-05-06',
  });
  const sess = await seedSession(supabaseAdmin, {
    id: 'save-cattle-1',
    species: 'cattle',
    herd: 'finishers',
    date: '2026-06-02',
  });
  await seedEntry(supabaseAdmin, {id: 'save-cattle-prior-e1', sessionId: priorSess.id, tag: '100', weight: 480});
  await seedEntry(supabaseAdmin, {id: 'save-cattle-e1', sessionId: sess.id, tag: '100', weight: 500, note: 'orig'});
  await supabaseAdmin.from('cattle').upsert(
    {
      id: 'cow-save-100',
      tag: '100',
      herd: 'finishers',
      sex: 'steer',
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );

  await page.goto('/weigh-in-sessions/' + sess.id);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  const entry = page.locator('[data-entry-tag="100"]');
  await expect(entry.getByRole('button', {name: 'Save'})).toHaveCount(0);
  await expect(entry.getByText('Revert', {exact: true})).toHaveCount(0);
  await expect(page.locator('[data-entry-days="save-cattle-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-cattle-e1"]')).toContainText('+/- +20 lb');

  const weightInput = entry.locator('input[type="number"]');
  const noteInput = entry.locator('input[placeholder="Note"]');
  await weightInput.fill('555');
  await noteInput.fill('updated');
  await noteInput.blur();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('weight, note').eq('id', 'save-cattle-e1').single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({weight: 555, note: 'updated'});
  await expect(page.locator('[data-entry-autosave="save-cattle-e1"]')).toContainText('Saved');
  await expect(page.locator('[data-entry-days="save-cattle-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-cattle-e1"]')).toContainText('+/- +75 lb');

  await page.reload();
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  const reEntry = page.locator('[data-entry-tag="100"]');
  await expect(reEntry.locator('input[type="number"]')).toHaveValue('555');
  await expect(reEntry.locator('input[placeholder="Note"]')).toHaveValue('updated');
  await expect(page.locator('[data-entry-days="save-cattle-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-cattle-e1"]')).toContainText('+/- +75 lb');
});

test('sheep: edit weight + note, autosave, reload, persist', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const priorSess = await seedSession(supabaseAdmin, {
    id: 'save-sheep-prior-1',
    species: 'sheep',
    herd: 'feeders',
    status: 'complete',
    date: '2026-05-06',
  });
  const sess = await seedSession(supabaseAdmin, {
    id: 'save-sheep-1',
    species: 'sheep',
    herd: 'feeders',
    date: '2026-06-02',
  });
  await seedEntry(supabaseAdmin, {id: 'save-sheep-prior-e1', sessionId: priorSess.id, tag: '200', weight: 75});
  await seedEntry(supabaseAdmin, {id: 'save-sheep-e1', sessionId: sess.id, tag: '200', weight: 80, note: 'orig'});
  await supabaseAdmin
    .from('sheep')
    .upsert(
      {id: 'sheep-save-200', tag: '200', flock: 'feeders', old_tags: [], processing_batch_id: null},
      {onConflict: 'id'},
    );

  await page.goto('/weigh-in-sessions/' + sess.id);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  const entry = page.locator('[data-entry-tag="200"]');
  await expect(entry.getByRole('button', {name: 'Save'})).toHaveCount(0);
  await expect(entry.getByText('Revert', {exact: true})).toHaveCount(0);
  await expect(page.locator('[data-entry-days="save-sheep-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-sheep-e1"]')).toContainText('+/- +5 lb');

  const weightInput = entry.locator('input[type="number"]');
  const noteInput = entry.locator('input[placeholder="Note"]');
  await weightInput.fill('85');
  await noteInput.fill('updated');
  await noteInput.blur();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('weight, note').eq('id', 'save-sheep-e1').single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({weight: 85, note: 'updated'});
  await expect(page.locator('[data-entry-autosave="save-sheep-e1"]')).toContainText('Saved');
  await expect(page.locator('[data-entry-days="save-sheep-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-sheep-e1"]')).toContainText('+/- +10 lb');

  await page.reload();
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  const reEntry = page.locator('[data-entry-tag="200"]');
  await expect(reEntry.locator('input[type="number"]')).toHaveValue('85');
  await expect(reEntry.locator('input[placeholder="Note"]')).toHaveValue('updated');
  await expect(page.locator('[data-entry-days="save-sheep-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-entry-delta="save-sheep-e1"]')).toContainText('+/- +10 lb');
});

test('pig: edit weight + note, autosave, reload, persist', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await supabaseAdmin.from('webform_config').upsert({key: 'active_groups', data: ['P-TEST-01']}, {onConflict: 'key'});
  const priorSess = await seedSession(supabaseAdmin, {
    id: 'save-pig-prior-1',
    species: 'pig',
    batchId: 'P-TEST-01',
    date: '2026-05-06',
  });
  const sess = await seedSession(supabaseAdmin, {
    id: 'save-pig-1',
    species: 'pig',
    batchId: 'P-TEST-01',
    date: '2026-06-02',
  });
  await seedEntry(supabaseAdmin, {id: 'save-pig-prior-e1', sessionId: priorSess.id, weight: 240});
  await seedEntry(supabaseAdmin, {id: 'save-pig-e1', sessionId: sess.id, weight: 250, note: 'orig'});

  await page.goto('/weigh-in-sessions/' + sess.id);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  // Pig entries don't have tags, find by the entries section
  const entriesSection = page.locator('[data-weighin-entries="1"]');
  await expect(entriesSection.getByRole('button', {name: 'Save'})).toHaveCount(0);
  await expect(entriesSection.getByText('Revert', {exact: true})).toHaveCount(0);
  await expect(page.locator('[data-pig-entry-days="save-pig-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-pig-entry-delta="save-pig-e1"]')).toContainText('+/- +10 lb');

  const weightInput = entriesSection.locator('input[type="number"]').first();
  const noteInput = entriesSection.locator('input[placeholder="Note"]').first();
  await weightInput.fill('260');
  await noteInput.fill('updated');
  await noteInput.blur();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('weight, note').eq('id', 'save-pig-e1').single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({weight: 260, note: 'updated'});
  await expect(page.locator('[data-pig-entry-autosave="save-pig-e1"]')).toContainText('Saved');
  await expect(page.locator('[data-pig-entry-days="save-pig-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-pig-entry-delta="save-pig-e1"]')).toContainText('+/- +20 lb');

  await page.reload();
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-weighin-entries="1"] input[type="number"]').first()).toHaveValue('260');
  await expect(page.locator('[data-weighin-entries="1"] input[placeholder="Note"]').first()).toHaveValue('updated');
  await expect(page.locator('[data-pig-entry-days="save-pig-e1"]')).toContainText('Days 27');
  await expect(page.locator('[data-pig-entry-delta="save-pig-e1"]')).toContainText('+/- +20 lb');
});

test('pig: rapid weight-then-note edits serialize their PATCHes; a stale payload can never revert the note', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  // Regression (Final Playwright closure lane): filling the note right after
  // the weight fires the weight-blur flush first, so an entry PATCH carrying
  // the OLD note is in flight when the note flush fires. The old engine issued
  // both PATCHes concurrently — whichever landed last won, and in CI the stale
  // {weight, note: 'orig'} landed after {weight, note: 'updated'}, silently
  // reverting the note while the UI showed Saved. The engine must keep at most
  // one entry save in flight and queue later saves behind it.
  await resetDb();
  await supabaseAdmin.from('webform_config').upsert({key: 'active_groups', data: ['P-TEST-01']}, {onConflict: 'key'});
  const sess = await seedSession(supabaseAdmin, {id: 'ser-pig-1', species: 'pig', batchId: 'P-TEST-01'});
  await seedEntry(supabaseAdmin, {id: 'ser-pig-e1', sessionId: sess.id, weight: 250, note: 'orig'});

  // Track entry-PATCH concurrency and HOLD the first PATCH open long enough
  // that the note flush fires while it is still in flight.
  const isEntryPatch = (req) => req.method() === 'PATCH' && /\/rest\/v1\/weigh_ins/.test(req.url());
  let inFlight = 0;
  let maxInFlight = 0;
  let patchCount = 0;
  page.on('request', (req) => {
    if (!isEntryPatch(req)) return;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
  });
  const settle = (req) => {
    if (isEntryPatch(req)) inFlight -= 1;
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  let releaseFirst;
  const firstHold = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/rest/v1/weigh_ins*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    patchCount += 1;
    if (patchCount === 1) await firstHold;
    await route.continue();
  });

  await page.goto('/weigh-in-sessions/' + sess.id);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  const entriesSection = page.locator('[data-weighin-entries="1"]');
  const weightInput = entriesSection.locator('input[type="number"]').first();
  const noteInput = entriesSection.locator('input[placeholder="Note"]').first();

  await weightInput.fill('260');
  // Focusing the note blurs the weight → the first flush PATCH goes out (held).
  await noteInput.fill('updated');
  await noteInput.blur();

  // While the first PATCH is held, the note save must WAIT — even past the
  // debounce window. The old engine had already issued a second PATCH here.
  await page.waitForTimeout(1200);
  expect(patchCount, 'second PATCH must queue behind the held first PATCH').toBe(1);

  releaseFirst();

  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('weigh_ins').select('weight, note').eq('id', 'ser-pig-e1').single();
        return r.data;
      },
      {timeout: 10_000},
    )
    .toEqual({weight: 260, note: 'updated'});
  expect(maxInFlight, 'entry PATCHes must never overlap').toBe(1);
  await expect(page.locator('[data-pig-entry-autosave="ser-pig-e1"]')).toContainText('Saved');

  // Reload: both fields persisted.
  await page.reload();
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-weighin-entries="1"] input[type="number"]').first()).toHaveValue('260');
  await expect(page.locator('[data-weighin-entries="1"] input[placeholder="Note"]').first()).toHaveValue('updated');
});

// ============================================================================
// Comments hash scroll
// ============================================================================
// Uses cattle as the representative species. CommentsSection is shared across
// all species on the record page, so one species is sufficient.

test('comment hash scroll: navigate to #comment-<id> scrolls target into view', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  // Also clear stale comments from prior runs (comments table is not in the reset truncate list)
  await supabaseAdmin.from('comments').delete().neq('id', '__never__');
  const sess = await seedSession(supabaseAdmin, {id: 'hash-cattle-1', species: 'cattle', herd: 'finishers'});
  await seedEntry(supabaseAdmin, {id: 'hash-cattle-e1', sessionId: sess.id, tag: '100', weight: 500});
  await supabaseAdmin.from('cattle').upsert(
    {
      id: 'cow-hash-100',
      tag: '100',
      herd: 'finishers',
      sex: 'steer',
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );

  await page.goto('/weigh-in-sessions/' + sess.id);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});

  const commentInput = page.locator('textarea[placeholder*="Add a comment"]');
  await commentInput.fill('Hash scroll test comment');
  await page.getByRole('button', {name: 'Post'}).click();

  const commentEl = page.locator('[data-comment-id]').first();
  await expect(commentEl).toBeVisible({timeout: 10_000});
  await expect(commentEl).toContainText('Hash scroll test comment', {timeout: 5_000});
  // Posted timestamp is visible without hover: absolute farm time + fresh age
  // (clock skew between runner and DB may shift 'just now' to 'Xm ago').
  await expect(commentEl.locator('[data-comment-posted-at="1"]')).toHaveText(
    /\d{2}\/\d{2}\/\d{2} \d{1,2}:\d{2} (AM|PM) · (just now|\d+m ago)/,
  );
  const rawId = await commentEl.getAttribute('data-comment-id');
  const commentId = 'comment-' + rawId;

  await page.goto('/');
  await page.goto('/weigh-in-sessions/' + sess.id + '#' + commentId);
  await waitForWeighInSessionLoaded(page);
  await expect(page.locator('[data-record-title="1"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('#' + commentId)).toBeVisible({timeout: 10_000});
});
