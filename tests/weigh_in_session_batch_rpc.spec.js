import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Phase 1C-C — submit_weigh_in_session_batch RPC contract (mig 035)
// ============================================================================
// DB-only build. Locks the contract Codex approved for the WeighIns
// session-aware offline precursor:
//
//   * SECURITY DEFINER + SET search_path = public + EXECUTE granted to
//     anon + authenticated.
//   * v1 species allowlist: pig | broiler. cattle / sheep rejected.
//   * v1 status allowlist: draft only. complete rejected.
//   * Required fields: client_submission_id, id, date, team_member,
//     entries_in (non-empty array). broiler species also requires
//     broiler_week ∈ {4, 6}. pig species ignores broiler_week.
//   * Race-safe idempotency via INSERT … ON CONFLICT DO NOTHING
//     RETURNING + fallback SELECT. No 23505 ever surfaces to the caller.
//   * Children written with NULL client_submission_id (parent owns
//     dedup). Mig 030's unique index on weigh_ins.client_submission_id
//     would 23505 on entry #2 if the parent's csid bled through —
//     locked by Test 4.
//   * Atomic: any RAISE rolls back parent + every prior child.
//   * No side-effect column writes (transfer flags, processor flags,
//     prior_herd_or_flock, sent_to_trip_id) — those are runtime
//     concerns deferred to a future phase.
//   * No new RLS policies — anon SELECT on weigh_in_sessions /
//     weigh_ins remains as defined by mig 001 (existing policy, not
//     broadened by this build).
// ============================================================================

const TODAY = '2026-04-29';

function makeEntry(overrides = {}) {
  return {
    id: `wi-${Math.random().toString(36).slice(2, 10)}`,
    weight: 250,
    note: null,
    new_tag_flag: false,
    ...overrides,
  };
}

function makeParent(species, csid, overrides = {}) {
  return {
    id: `ws-${Math.random().toString(36).slice(2, 10)}`,
    client_submission_id: csid,
    date: TODAY,
    team_member: 'BMAN',
    species,
    status: 'draft',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Test 1 — Pig draft session + 5 entries
// --------------------------------------------------------------------------
test('pig: 1 weigh_in_sessions + 5 weigh_ins linked atomically', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-pig-batch-1', {batch_id: 'P-26-01'});
  const entries = [
    makeEntry({tag: '101', weight: 240}),
    makeEntry({tag: '102', weight: 245}),
    makeEntry({tag: '103', weight: 250}),
    makeEntry({tag: '104', weight: 255}),
    makeEntry({tag: '105', weight: 260}),
  ];

  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: entries,
  });
  expect(error).toBeNull();
  expect(data).toEqual({
    session_id: parent.id,
    entry_count: 5,
    idempotent_replay: false,
  });

  const {data: session} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', parent.id).maybeSingle();
  expect(session.client_submission_id).toBe('csid-pig-batch-1');
  expect(session.species).toBe('pig');
  expect(session.status).toBe('draft');
  expect(session.batch_id).toBe('P-26-01');
  // pig species ignores broiler_week — value stays NULL.
  expect(session.broiler_week).toBeNull();

  const {data: rows} = await supabaseAdmin
    .from('weigh_ins')
    .select('id, session_id, tag, weight, client_submission_id')
    .eq('session_id', parent.id);
  expect(rows).toHaveLength(5);
  expect(rows.map((r) => r.tag).sort()).toEqual(['101', '102', '103', '104', '105']);
  expect(rows.map((r) => Number(r.weight)).sort((a, b) => a - b)).toEqual([240, 245, 250, 255, 260]);
});

// --------------------------------------------------------------------------
// Test 2 — Broiler draft session + entries with broiler_week=4
// --------------------------------------------------------------------------
test('broiler: 1 session + N entries with broiler_week populated', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('broiler', 'csid-broiler-1', {batch_id: 'B-26-01', broiler_week: 4});
  const entries = [makeEntry({weight: 1.4}), makeEntry({weight: 1.5}), makeEntry({weight: 1.6})];

  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: entries,
  });
  expect(error).toBeNull();
  expect(data.entry_count).toBe(3);
  expect(data.idempotent_replay).toBe(false);

  const {data: session} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', parent.id).maybeSingle();
  expect(session.species).toBe('broiler');
  expect(session.status).toBe('draft');
  expect(session.broiler_week).toBe(4);
});

// --------------------------------------------------------------------------
// Test 3 — Idempotent replay returns same session_id, no duplicates
// --------------------------------------------------------------------------
test('idempotent: replay with same csid returns idempotent_replay:true, no duplicate entries', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const csid = 'csid-replay-1';
  const parent = makeParent('pig', csid, {batch_id: 'P-26-01'});
  const entries = [makeEntry({tag: '201', weight: 250}), makeEntry({tag: '202', weight: 252})];

  // First call: fresh insert.
  const r1 = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: entries,
  });
  expect(r1.error).toBeNull();
  expect(r1.data.idempotent_replay).toBe(false);
  expect(r1.data.entry_count).toBe(2);

  // Second call: same csid, different parent.id and entry ids.
  const replayParent = makeParent('pig', csid, {id: 'ws-replay-2', batch_id: 'P-26-01'});
  const replayEntries = [
    makeEntry({id: 'wi-replay-1', tag: '201', weight: 999}),
    makeEntry({id: 'wi-replay-2', tag: '202', weight: 999}),
  ];
  const r2 = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: replayParent,
    entries_in: replayEntries,
  });
  expect(r2.error).toBeNull();
  expect(r2.data.idempotent_replay).toBe(true);
  expect(r2.data.session_id).toBe(parent.id); // first call's id wins
  expect(r2.data.entry_count).toBe(2); // counted from existing entries

  // DB state: 1 session, 2 entries. Replay's entry ids never inserted.
  const {data: sessions} = await supabaseAdmin.from('weigh_in_sessions').select('id').eq('client_submission_id', csid);
  expect(sessions).toHaveLength(1);

  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id, weight').eq('session_id', parent.id);
  expect(rows).toHaveLength(2);
  // Original weights preserved (240/245-style would have failed; this case
  // uses 250/252 — verify replay's 999 weights never landed).
  expect(rows.every((r) => Number(r.weight) !== 999)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 4 — Child csid stays NULL on every entry (parent owns dedup)
// --------------------------------------------------------------------------
// Critical regression: writing the parent's csid to children would 23505
// the unique index on weigh_ins.client_submission_id (mig 030) on entry
// #2 of any multi-entry session.
test('child csid: every weigh_ins row has client_submission_id=NULL', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-multi-csid-1', {batch_id: 'P-26-01'});
  const entries = [makeEntry({tag: '301'}), makeEntry({tag: '302'}), makeEntry({tag: '303'}), makeEntry({tag: '304'})];

  const {error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: entries,
  });
  expect(error).toBeNull();

  const {data: rows} = await supabaseAdmin
    .from('weigh_ins')
    .select('id, client_submission_id, session_id')
    .eq('session_id', parent.id);
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.client_submission_id === null)).toBe(true);
  expect(rows.every((r) => r.session_id === parent.id)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 5 — Atomic rollback on bad child
// --------------------------------------------------------------------------
test('atomicity: bad child rolls back session + every prior child', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-rollback-1', {batch_id: 'P-26-01'});
  const goodA = makeEntry({tag: '401', weight: 240});
  const goodB = makeEntry({tag: '402', weight: 245});
  // Cast failure inside the RPC — `weight: 'not-a-number'`::numeric raises.
  const bad = makeEntry({tag: '403', weight: 'not-a-number'});

  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [goodA, goodB, bad],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();

  // Session did NOT land.
  const {data: session} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id')
    .eq('client_submission_id', 'csid-rollback-1')
    .maybeSingle();
  expect(session).toBeNull();

  // Neither did the prior good entries.
  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id').in('id', [goodA.id, goodB.id]);
  expect(rows).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Test 6 — Anon EXECUTE works; anon table SELECT stays dropped (mig 138)
// --------------------------------------------------------------------------
// Mig 001 originally gave weigh_in_sessions anon SELECT; migration 138's
// Tier-1 anon write-boundary hardening deliberately dropped every
// weigh_in_sessions anon policy (weigh_in_sessions_anon_select included).
// The durable contract is now: the SECDEF RPC stays anon-EXECUTE callable,
// while direct anon table reads fail closed.
test('anon: EXECUTE grant lets anon call the RPC; anon table SELECT stays dropped (mig 138)', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent('broiler', 'csid-anon-1', {batch_id: 'B-26-99', broiler_week: 6});
  const entries = [makeEntry({weight: 2.0}), makeEntry({weight: 2.1})];

  const {data, error} = await anonClient.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: entries,
  });
  expect(error).toBeNull();
  expect(data.idempotent_replay).toBe(false);
  expect(data.entry_count).toBe(2);

  // Direct anon SELECT is fail-closed since migration 138 dropped the
  // legacy weigh_in_sessions_anon_select policy: no error, no row.
  const {data: anonRead, error: anonReadError} = await anonClient
    .from('weigh_in_sessions')
    .select('*')
    .eq('id', parent.id)
    .maybeSingle();
  expect(anonReadError).toBeNull();
  expect(anonRead).toBeNull();

  // Service-role read confirms the row really landed (sanity).
  const {data: adminRead} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', parent.id).maybeSingle();
  expect(adminRead.broiler_week).toBe(6);
  expect(adminRead.species).toBe('broiler');
});

// --------------------------------------------------------------------------
// Test 7 — v1 species allowlist: cattle and sheep rejected
// --------------------------------------------------------------------------
test('species allowlist: cattle is rejected with explicit message', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('cattle', 'csid-cattle-reject');
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/v1 species allowlist/i.test(String(error.message))).toBe(true);

  const {data: session} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id')
    .eq('client_submission_id', 'csid-cattle-reject')
    .maybeSingle();
  expect(session).toBeNull();
});

test('species allowlist: sheep is rejected with explicit message', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('sheep', 'csid-sheep-reject');
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/v1 species allowlist/i.test(String(error.message))).toBe(true);
});

// --------------------------------------------------------------------------
// Test 8 — v1 status allowlist: complete rejected
// --------------------------------------------------------------------------
test('status allowlist: status=complete rejected (completion stays online-only)', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-status-reject', {batch_id: 'P-26-01', status: 'complete'});
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/v1 status must be draft/i.test(String(error.message))).toBe(true);
});

// --------------------------------------------------------------------------
// Test 9 — Zero-entry rejection (Codex amendment #4)
// --------------------------------------------------------------------------
// Avoids accidental offline submits creating empty draft sessions on
// prod replay. Both empty array and null/missing entries_in must reject
// before any insert runs.
test('zero entries: empty array is rejected and no session lands', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-zero-1', {batch_id: 'P-26-01'});

  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/at least one entry required/i.test(String(error.message))).toBe(true);

  const {data: session} = await supabaseAdmin
    .from('weigh_in_sessions')
    .select('id')
    .eq('client_submission_id', 'csid-zero-1')
    .maybeSingle();
  expect(session).toBeNull();

  const {data: rows} = await supabaseAdmin.from('weigh_ins').select('id');
  expect(rows).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Test 10 — broiler_week validation (Codex amendment #5)
// --------------------------------------------------------------------------
// species=broiler MUST have broiler_week in {4, 6}. Generic table CHECK
// failure replaced with an explicit RAISE before insert.
test('broiler_week: missing for species=broiler is rejected with clear message', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('broiler', 'csid-bw-missing', {batch_id: 'B-26-01'});
  // Deliberately omit broiler_week.
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/broiler_week required for species=broiler/i.test(String(error.message))).toBe(true);
});

test('broiler_week: invalid value (e.g. 5) is rejected with clear message', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('broiler', 'csid-bw-bad', {batch_id: 'B-26-01', broiler_week: 5});
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/broiler_week must be 4 or 6/i.test(String(error.message))).toBe(true);
});

test('broiler_week: pig species ignores broiler_week (coerced to NULL)', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-pig-ignores-bw', {batch_id: 'P-26-01', broiler_week: 4});
  const {error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).toBeNull();

  const {data: session} = await supabaseAdmin.from('weigh_in_sessions').select('*').eq('id', parent.id).maybeSingle();
  expect(session.species).toBe('pig');
  expect(session.broiler_week).toBeNull();
});

// --------------------------------------------------------------------------
// Test 11 — Required field validation (Codex amendment #6)
// --------------------------------------------------------------------------
test('validation: missing date is rejected with clear message before insert', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-no-date', {batch_id: 'P-26-01'});
  delete parent.date;
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/date required/i.test(String(error.message))).toBe(true);
});

test('validation: missing team_member is rejected with clear message before insert', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const parent = makeParent('pig', 'csid-no-tm', {batch_id: 'P-26-01'});
  delete parent.team_member;
  const {data, error} = await supabaseAdmin.rpc('submit_weigh_in_session_batch', {
    parent_in: parent,
    entries_in: [makeEntry()],
  });
  expect(error).not.toBeNull();
  expect(data).toBeNull();
  expect(/team_member required/i.test(String(error.message))).toBe(true);
});
