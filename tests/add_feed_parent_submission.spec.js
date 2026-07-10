import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Add Feed parent-submission RPC contract — mig 034
// ============================================================================
// Locks the contract Codex approved for the offline-queue precursor:
//
//   * submit_add_feed_batch(parent_in jsonb, children_in jsonb) is
//     SECURITY DEFINER + EXECUTE granted to anon + authenticated.
//   * Atomic: parent + children in one transaction, all-or-none.
//   * Race-safe idempotency: ON CONFLICT DO NOTHING RETURNING +
//     fallback SELECT. No 23505 ever surfaces to the caller. Replay
//     returns {idempotent_replay: true, parent_id, child_count} without
//     re-inserting children.
//   * broiler routes to poultry_dailys inside the RPC (app-facing
//     program key is broiler; table name has been poultry_dailys since
//     the early days).
//   * pig children OMIT the feed_type column (pig_dailys has no such
//     column). Locked by Test 3.
//   * Children link via daily_submission_id; their own client_submission_id
//     stays NULL. Critical for multi-child broiler/layer/pig submissions
//     because each child table's mig 030 unique index on
//     client_submission_id would 23505 on insert #2 if the parent's csid
//     bled through. Locked by Test 7.
//   * source = 'add_feed_webform' on every child row so the existing
//     dailys-list filter chip still sees them. Locked by Test 8.
//   * Historical rows are never rewritten — no test asserts that
//     directly (every test uses fresh seed) but the column-default
//     (null daily_submission_id on legacy rows) is preserved by the
//     migration (ADD COLUMN IF NOT EXISTS, no UPDATE).
// ============================================================================

const TODAY = '2026-04-29';

function makeChild(overrides = {}) {
  return {
    id: `cd-${Math.random().toString(36).slice(2, 10)}`,
    submitted_at: new Date().toISOString(),
    date: TODAY,
    team_member: 'BMAN',
    source: 'add_feed_webform',
    ...overrides,
  };
}

function makeParent(program, csid, overrides = {}) {
  return {
    id: `ds-${Math.random().toString(36).slice(2, 10)}`,
    client_submission_id: csid,
    submitted_at: new Date().toISOString(),
    program,
    source: 'add_feed_webform',
    team_member: 'BMAN',
    date: TODAY,
    payload: {note: 'test seed'},
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Test 1 — Cattle single child happy path
// --------------------------------------------------------------------------
test('cattle: 1 parent + 1 cattle_dailys child written atomically', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('cattle', 'csid-cattle-1');
  const child = makeChild({
    herd: 'mommas',
    feeds: [{feed_name: 'Alfalfa Pellets', qty: 50, lbs_as_fed: 50}],
    minerals: [],
    mortality_count: 0,
  });

  const {data, error} = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [child],
  });
  expect(error).toBeNull();
  expect(data).toEqual({
    parent_id: parent.id,
    child_count: 1,
    idempotent_replay: false,
  });

  // Parent landed.
  const {data: p} = await supabaseAdmin.from('daily_submissions').select('*').eq('id', parent.id).maybeSingle();
  expect(p.client_submission_id).toBe('csid-cattle-1');
  expect(p.program).toBe('cattle');
  expect(p.form_kind).toBe('add_feed');
  expect(p.source).toBe('add_feed_webform');

  // Child landed with linkage + correct shape.
  const {data: c} = await supabaseAdmin
    .from('cattle_dailys')
    .select('id, daily_submission_id, herd, feeds, source, client_submission_id')
    .eq('id', child.id)
    .maybeSingle();
  expect(c.daily_submission_id).toBe(parent.id);
  expect(c.herd).toBe('mommas');
  expect(c.source).toBe('add_feed_webform');
  // Child csid is NULL — parent owns idempotency.
  expect(c.client_submission_id).toBeNull();
  expect(Array.isArray(c.feeds)).toBe(true);
  expect(c.feeds[0].feed_name).toBe('Alfalfa Pellets');
});

// --------------------------------------------------------------------------
// Test 2 — Broiler 3-batch happy path (multi-row, broiler→poultry_dailys)
// --------------------------------------------------------------------------
test('broiler: 1 parent + 3 poultry_dailys children written atomically', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('broiler', 'csid-broiler-1');
  const children = ['B-26-01', 'B-26-02', 'B-26-03'].map((label, i) =>
    makeChild({
      batch_label: label,
      feed_lbs: 100 + i * 10,
      feed_type: 'STARTER',
    }),
  );

  const {data, error} = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: children,
  });
  expect(error).toBeNull();
  expect(data.child_count).toBe(3);
  expect(data.idempotent_replay).toBe(false);

  // All 3 children land in poultry_dailys (broiler → poultry routing).
  const {data: rows} = await supabaseAdmin
    .from('poultry_dailys')
    .select('id, batch_label, feed_lbs, feed_type, daily_submission_id, client_submission_id, source')
    .eq('daily_submission_id', parent.id);
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.batch_label).sort()).toEqual(['B-26-01', 'B-26-02', 'B-26-03']);
  expect(rows.every((r) => r.feed_type === 'STARTER')).toBe(true);
  expect(rows.every((r) => r.source === 'add_feed_webform')).toBe(true);
  // Critical: every child row has NULL client_submission_id.
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 3 — Pig children omit feed_type (pig_dailys has no such column)
// --------------------------------------------------------------------------
test('pig: child row does not write feed_type (column does not exist on pig_dailys)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-pig-1');
  const child = makeChild({
    batch_label: 'P-26-01',
    batch_id: 'p-26-01',
    feed_lbs: 250,
    // Caller could send feed_type by mistake — RPC must ignore it.
    feed_type: 'STARTER',
  });

  const {error} = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [child],
  });
  expect(error).toBeNull();

  const {data: c} = await supabaseAdmin.from('pig_dailys').select('*').eq('id', child.id).maybeSingle();
  expect(c).not.toBeNull();
  expect(c.batch_label).toBe('P-26-01');
  expect(c.feed_lbs).toBe(250);
  expect(c.daily_submission_id).toBe(parent.id);
  // pig_dailys has no feed_type column at all — selecting * never returns it.
  expect('feed_type' in c).toBe(false);
});

// --------------------------------------------------------------------------
// Test 4 — Idempotent replay returns same parent_id, no error
// --------------------------------------------------------------------------
test('idempotent: replay with same csid returns idempotent_replay:true, no 23505', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const csid = 'csid-replay-1';
  const parent = makeParent('cattle', csid);
  const child = makeChild({herd: 'mommas', feeds: [], minerals: [], mortality_count: 0});

  // First call: fresh insert.
  const r1 = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [child],
  });
  expect(r1.error).toBeNull();
  expect(r1.data.idempotent_replay).toBe(false);
  expect(r1.data.child_count).toBe(1);

  // Second call: same csid, different parent.id and child.id (operator
  // retried with regenerated row ids). RPC must short-circuit on csid
  // match and return the original parent_id + 1 child seen.
  const replayParent = makeParent('cattle', csid, {id: 'ds-replay-2'});
  const replayChild = makeChild({
    id: 'cd-replay-2',
    herd: 'mommas',
    feeds: [],
    minerals: [],
    mortality_count: 0,
  });
  const r2 = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: replayParent,
    children_in: [replayChild],
  });
  expect(r2.error).toBeNull();
  expect(r2.data.idempotent_replay).toBe(true);
  expect(r2.data.parent_id).toBe(parent.id); // first call's id wins
  expect(r2.data.child_count).toBe(1); // counted from existing children, not 2

  // DB state: 1 parent, 1 child. Replay child id was never inserted.
  const {data: parents} = await supabaseAdmin.from('daily_submissions').select('id').eq('client_submission_id', csid);
  expect(parents).toHaveLength(1);
  expect(parents[0].id).toBe(parent.id);

  const {data: children} = await supabaseAdmin.from('cattle_dailys').select('id').eq('daily_submission_id', parent.id);
  expect(children).toHaveLength(1);
  expect(children[0].id).toBe(child.id); // first call's child, not replay
});

// --------------------------------------------------------------------------
// Test 5 — Atomic rollback on bad child
// --------------------------------------------------------------------------
test('atomicity: bad child rolls back parent + every prior child', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('broiler', 'csid-rollback-1');
  // Two valid + one bad (invalid date format → cast failure inside RPC).
  const goodA = makeChild({batch_label: 'B-26-01', feed_lbs: 100, feed_type: 'STARTER'});
  const goodB = makeChild({batch_label: 'B-26-02', feed_lbs: 110, feed_type: 'STARTER'});
  const bad = makeChild({batch_label: 'B-26-03', feed_lbs: 120, feed_type: 'STARTER', date: 'not-a-date'});

  const {data, error} = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [goodA, goodB, bad],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();

  // Parent did NOT land.
  const {data: p} = await supabaseAdmin
    .from('daily_submissions')
    .select('id')
    .eq('client_submission_id', 'csid-rollback-1')
    .maybeSingle();
  expect(p).toBeNull();

  // Neither did the prior good children.
  const {data: rows} = await supabaseAdmin.from('poultry_dailys').select('id').in('id', [goodA.id, goodB.id]);
  expect(rows).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Test 6 — Anon EXECUTE grant works without broadening table-level RLS
// --------------------------------------------------------------------------
test('anon: EXECUTE grant lets anon call the RPC without table-level RLS broadening', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  // Build a fresh anon client (no auth, no service role).
  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent('sheep', 'csid-anon-1');
  const child = makeChild({flock: 'feeders', feeds: [], minerals: [], mortality_count: 0});

  const {data, error} = await anonClient.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [child],
  });
  expect(error).toBeNull();
  expect(data.idempotent_replay).toBe(false);

  // Anon CANNOT SELECT from daily_submissions directly (no anon SELECT
  // policy). Locks the §7 RLS contract — anon reaches the parent table
  // ONLY through the SECURITY DEFINER RPC.
  const directRead = await anonClient.from('daily_submissions').select('*').eq('id', parent.id);
  // Either RLS denies (error or empty), but the row must NOT come back to anon.
  expect(directRead.data == null || directRead.data.length === 0).toBe(true);

  // Service-role read confirms the row is actually in the DB — the anon
  // empty/error result is RLS, not "row missing".
  const adminRead = await supabaseAdmin.from('daily_submissions').select('*').eq('id', parent.id).maybeSingle();
  expect(adminRead.data).not.toBeNull();
  expect(adminRead.data.program).toBe('sheep');
});

// --------------------------------------------------------------------------
// Test 7 — Multi-child rows have NULL client_submission_id
// --------------------------------------------------------------------------
// Critical regression: if the RPC ever started writing the parent's csid
// to children, the mig 030 unique index on each child table's
// client_submission_id would 23505 on insert #2 of any multi-child
// submission. This test seeds 4 layer batches (largest reasonable
// multi-row case) and verifies every child has NULL csid.
test('child csid: every multi-child row has client_submission_id=NULL', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('layer', 'csid-multi-csid-1');
  const children = ['L-1', 'L-2', 'L-3', 'L-4'].map((label) =>
    makeChild({
      batch_label: label,
      batch_id: label.toLowerCase(),
      feed_lbs: 80,
      feed_type: 'LAYER',
    }),
  );

  const {error} = await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: children,
  });
  expect(error).toBeNull();

  const {data: rows} = await supabaseAdmin
    .from('layer_dailys')
    .select('id, client_submission_id, daily_submission_id')
    .eq('daily_submission_id', parent.id);
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
  expect(rows.every((r) => r.daily_submission_id === parent.id)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 8 — source='add_feed_webform' lets existing list filters find children
// --------------------------------------------------------------------------
test('source filter: existing dailys-list filter chip still sees RPC-written children', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-source-1');
  const child = makeChild({batch_label: 'P-26-01', batch_id: 'p-26-01', feed_lbs: 200});

  await supabaseAdmin.rpc('submit_add_feed_batch', {
    parent_in: parent,
    children_in: [child],
  });

  // The existing AddFeed list view filters by source === 'add_feed_webform'.
  // RPC-written rows must show up under that filter unchanged.
  const {data: rows} = await supabaseAdmin
    .from('pig_dailys')
    .select('id, source, daily_submission_id')
    .eq('source', 'add_feed_webform')
    .eq('daily_submission_id', parent.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(child.id);
});

// --------------------------------------------------------------------------
// Test 9 — UI-driven: AddFeedWebform constructs the correct payload
// --------------------------------------------------------------------------
// Drives /addfeed through the actual login-required form for a
// 2-batch broiler submission. Locks the .insert() → .rpc() cutover from
// the form side: that AddFeedWebform.jsx assembles parent_in / children_in
// correctly, that the RPC is reached via the .rpc() call, and that the
// existing success UI still appears. RPC-level contracts (Tests 1–8) prove
// the function does the right thing once invoked; this test proves the
// browser invocation itself is wired correctly.
test('UI: /addfeed broiler 2-batch submit creates 1 parent + 2 poultry_dailys via RPC', async ({
  supabaseAdmin,
  page,
  addFeedOfflineScenario,
}) => {
  void addFeedOfflineScenario;

  await page.goto('/addfeed');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Pick Broiler program.
  await page.getByRole('button', {name: 'Broiler'}).click();

  // First batch group. The submitter is locked to the signed-in user, so the
  // first batch select is now combobox index 0.
  await expect(page.locator('[data-locked-submitter="1"]')).toContainText('signed in');
  const firstBatchSelect = page.getByRole('combobox').first();
  await expect.poll(async () => await firstBatchSelect.locator('option').count(), {timeout: 10_000}).toBeGreaterThan(1);
  await firstBatchSelect.selectOption('B-26-01');
  await page.getByRole('button', {name: 'STARTER'}).first().click();
  await page.locator('input[type="number"]').first().fill('100');

  // Add second group. Its batch select is the next combobox.
  await page.getByRole('button', {name: '+ Add Another Group'}).click();
  const secondBatchSelect = page.getByRole('combobox').nth(1);
  await expect(secondBatchSelect).toBeVisible({timeout: 10_000});
  await secondBatchSelect.selectOption('B-26-02');
  await page.getByRole('button', {name: 'STARTER'}).nth(1).click();
  await page.locator('input[type="number"]').nth(1).fill('150');

  // Submit. Button label includes the entry count.
  await page.getByRole('button', {name: /Log 2 Feed Entries/}).click();

  // Existing success UI must appear.
  await expect(page.getByText('Feed logged!')).toBeVisible({timeout: 15_000});

  // DB-side contract assertions.
  const {data: parents} = await supabaseAdmin
    .from('daily_submissions')
    .select('id, form_kind, program, source, team_member, payload');
  expect(parents).toHaveLength(1);
  expect(parents[0].form_kind).toBe('add_feed');
  expect(parents[0].program).toBe('broiler');
  expect(parents[0].source).toBe('add_feed_webform');
  const parentId = parents[0].id;

  const {data: children} = await supabaseAdmin
    .from('poultry_dailys')
    .select('id, batch_label, feed_lbs, feed_type, source, daily_submission_id, client_submission_id')
    .eq('daily_submission_id', parentId);
  expect(children).toHaveLength(2);
  expect(children.map((r) => r.batch_label).sort()).toEqual(['B-26-01', 'B-26-02']);
  expect(children.map((r) => Number(r.feed_lbs)).sort((a, b) => a - b)).toEqual([100, 150]);
  expect(children.every((r) => r.feed_type === 'STARTER')).toBe(true);
  expect(children.every((r) => r.source === 'add_feed_webform')).toBe(true);
  // Critical: child csid must be NULL — parent owns idempotency.
  expect(children.every((r) => r.client_submission_id === null)).toBe(true);
});
