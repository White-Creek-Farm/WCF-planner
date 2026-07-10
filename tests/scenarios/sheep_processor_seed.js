// ============================================================================
// Sheep Send-to-Processor scenario seeds — for tests/sheep_send_to_processor.spec.js
// ============================================================================
// Three named seed builders mirroring the cattle scenarios but for sheep.
// Sheep gate is intentionally looser than cattle's (any draft session, any
// flock per §7), so the happy-path seed is parameterized on flock to let
// the looser-gate test (Test 9) reuse the same shape with flock='rams'.
//
//   seedSheepSendToProcessor(supabaseAdmin, { flock = 'feeders' } = {})
//     Happy-path setup: 3 sheep in `flock` + 1 empty planned processing
//     batch + 1 draft sheep weigh-in session (herd=flock) + 3 weigh-ins
//     with send_to_processor=true. The spec drives attach via the UI.
//     Used by Tests 1, 2 (flock='feeders'), 9 (flock='rams'), 10
//     (flock='feeders', no attach).
//
//   seedSheepBatchPreAttached(supabaseAdmin)
//     Pre-attaches all 3 sheep to a planned batch with valid
//     prior_herd_or_flock stamps + matching sheep_transfers audit rows.
//     Used by Tests 4 (session-delete) + 5 (batch-delete) so the multi-row
//     detach loop is actually exercised — single-sheep seeds would let
//     those loops "pass" with N=1.
//     Used by Tests 4, 5.
//
//   seedSheepPreAttachedForFallback(supabaseAdmin, { mode })
//     Bypasses the UI attach so tests can control the fallback state.
//     1 sheep already at flock='processed', weigh-in pointing at the batch
//     but prior_herd_or_flock=null. Mode toggles audit-row state:
//        mode='with_audit_row'   → from_flock='feeders' → fallback succeeds
//        mode='null_from_flock'  → from_flock=null → atomic RPC forces block
//        mode='no_audit_row'     → no audit row → blocked with no_prior_flock
//     Used by Tests 3, 6, 7, 8.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`sheepProcessorSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

const BATCH_ID = 'spb-test-s2601';
const BATCH_NAME = 'S-26-01';
const SESSION_ID = 'wsess-sheep-test';

// Three sheep — tag 3001/3002/3003 keeps numeric collisions out of the
// way of cattle (2001/2002/2003) and pig (1001/1002 + 2000-series weigh-in
// tags) test seeds, in case anyone ever cross-loads scenarios.
const SHEEP_ROWS = [
  {id: 'sheep-test-3001', tag: '3001', breed: 'Katahdin'},
  {id: 'sheep-test-3002', tag: '3002', breed: 'Katahdin'},
  {id: 'sheep-test-3003', tag: '3003', breed: 'Dorper'},
];
const ENTRY_WEIGHTS = {3001: 90, 3002: 95, 3003: 85};

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('sheepProcessorSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`sheepProcessorSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(
      `sheepProcessorSeed: test admin user "${adminEmail}" missing from auth.users. ` +
        'Re-create via Supabase Auth dashboard.',
    );
  }
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
  return adminEmail;
}

export async function seedSheepSendToProcessor(supabaseAdmin, {flock = 'feeders'} = {}) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  must(
    await supabaseAdmin.from('sheep_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'planned',
        sheep_detail: [],
        total_live_weight: null,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'sheep_processing_batches insert',
  );

  // 3 sheep in the requested flock. flock='feeders' is the typical
  // happy-path; flock='rams' is the looser-gate regression check.
  must(
    await supabaseAdmin.from('sheep').upsert(
      SHEEP_ROWS.map((s) => ({
        id: s.id,
        tag: s.tag,
        breed: s.breed,
        flock,
        old_tags: [],
      })),
      {onConflict: 'id'},
    ),
    'sheep insert',
  );

  // Draft session, herd matches the flock under test.
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'sheep',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: flock,
        status: 'draft',
        started_at: '2026-04-28T08:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert',
  );

  const weighIns = SHEEP_ROWS.map((s, i) => ({
    id: `wi-test-sheep-${s.tag}`,
    session_id: SESSION_ID,
    tag: s.tag,
    weight: ENTRY_WEIGHTS[s.tag],
    note: null,
    new_tag_flag: false,
    send_to_processor: true,
    target_processing_batch_id: null,
    prior_herd_or_flock: null,
    entered_at: `2026-04-28T08:0${i}:00Z`,
  }));
  must(await supabaseAdmin.from('weigh_ins').upsert(weighIns, {onConflict: 'id'}), 'weigh_ins insert');

  return {
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    sessionId: SESSION_ID,
    sheep: SHEEP_ROWS,
    entryIds: weighIns.map((w) => w.id),
    flock,
    expected: {priorFlock: flock},
  };
}

export async function seedSheepBatchPreAttached(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  const sheepDetail = SHEEP_ROWS.map((s) => ({
    sheep_id: s.id,
    tag: s.tag,
    live_weight: ENTRY_WEIGHTS[s.tag],
    hanging_weight: null,
  }));
  const totalLive = sheepDetail.reduce((s, r) => s + r.live_weight, 0);
  must(
    await supabaseAdmin.from('sheep_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'planned',
        sheep_detail: sheepDetail,
        total_live_weight: Math.round(totalLive * 10) / 10,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'sheep_processing_batches insert (multi-sheep pre-attached)',
  );

  must(
    await supabaseAdmin.from('sheep').upsert(
      SHEEP_ROWS.map((s) => ({
        id: s.id,
        tag: s.tag,
        breed: s.breed,
        flock: 'processed',
        processing_batch_id: BATCH_ID,
        old_tags: [],
      })),
      {onConflict: 'id'},
    ),
    'sheep insert (multi-sheep pre-attached)',
  );

  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'sheep',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: 'feeders',
        status: 'complete',
        started_at: '2026-04-28T08:00:00Z',
        completed_at: '2026-04-28T09:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert (multi-sheep pre-attached)',
  );

  // 3 weigh-ins with prior_herd_or_flock='feeders' stamped — detach reads
  // this column FIRST per the §7 fallback hierarchy, so the loop tests
  // exercise the primary path, not the fallback.
  const weighIns = SHEEP_ROWS.map((s, i) => ({
    id: `wi-test-sheep-${s.tag}`,
    session_id: SESSION_ID,
    tag: s.tag,
    weight: ENTRY_WEIGHTS[s.tag],
    note: null,
    new_tag_flag: false,
    send_to_processor: true,
    target_processing_batch_id: BATCH_ID,
    prior_herd_or_flock: 'feeders',
    entered_at: `2026-04-28T08:0${i}:00Z`,
  }));
  must(
    await supabaseAdmin.from('weigh_ins').upsert(weighIns, {onConflict: 'id'}),
    'weigh_ins insert (multi-sheep pre-attached)',
  );

  // Matching audit rows — what attach would have written. Including them
  // keeps the seed faithful to a real post-attach state.
  must(
    await supabaseAdmin.from('sheep_transfers').upsert(
      SHEEP_ROWS.map((s) => ({
        id: `xfer-test-${s.tag}`,
        sheep_id: s.id,
        from_flock: 'feeders',
        to_flock: 'processed',
        reason: 'processing_batch',
        reference_id: BATCH_ID,
        team_member: adminEmail,
      })),
      {onConflict: 'id'},
    ),
    'sheep_transfers insert (multi-sheep pre-attached)',
  );

  return {
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    sessionId: SESSION_ID,
    sheep: SHEEP_ROWS,
    entryIds: weighIns.map((w) => w.id),
    expected: {priorFlock: 'feeders'},
  };
}

export async function seedSheepPreAttachedForFallback(supabaseAdmin, {mode} = {}) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  if (!['with_audit_row', 'null_from_flock', 'no_audit_row'].includes(mode)) {
    throw new Error(
      `seedSheepPreAttachedForFallback: mode must be one of with_audit_row | null_from_flock | no_audit_row (got ${mode}).`,
    );
  }

  const sheep = SHEEP_ROWS[0];

  must(
    await supabaseAdmin.from('sheep_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'planned',
        sheep_detail: [{sheep_id: sheep.id, tag: sheep.tag, live_weight: 90, hanging_weight: null}],
        total_live_weight: 90,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'sheep_processing_batches insert (pre-attached)',
  );

  must(
    await supabaseAdmin.from('sheep').upsert(
      {
        id: sheep.id,
        tag: sheep.tag,
        breed: sheep.breed,
        flock: 'processed',
        processing_batch_id: BATCH_ID,
        old_tags: [],
      },
      {onConflict: 'id'},
    ),
    'sheep insert (pre-attached)',
  );

  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'sheep',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: 'feeders',
        status: 'complete',
        started_at: '2026-04-28T08:00:00Z',
        completed_at: '2026-04-28T09:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert (pre-attached)',
  );

  const entryId = `wi-test-sheep-${sheep.tag}`;
  must(
    await supabaseAdmin.from('weigh_ins').upsert(
      {
        id: entryId,
        session_id: SESSION_ID,
        tag: sheep.tag,
        weight: 90,
        note: null,
        new_tag_flag: false,
        send_to_processor: true,
        target_processing_batch_id: BATCH_ID,
        // prior_herd_or_flock left null — that's the gap the fallback exercises.
        prior_herd_or_flock: null,
        entered_at: '2026-04-28T08:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_ins insert (pre-attached)',
  );

  if (mode === 'with_audit_row' || mode === 'null_from_flock') {
    must(
      await supabaseAdmin.from('sheep_transfers').upsert(
        {
          id: `xfer-test-${sheep.tag}`,
          sheep_id: sheep.id,
          from_flock: mode === 'null_from_flock' ? null : 'feeders',
          to_flock: 'processed',
          reason: 'processing_batch',
          reference_id: BATCH_ID,
          team_member: adminEmail,
        },
        {onConflict: 'id'},
      ),
      `sheep_transfers insert (${mode})`,
    );
  }

  return {
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    sessionId: SESSION_ID,
    sheepId: sheep.id,
    sheepTag: sheep.tag,
    entryId,
    mode,
    expected: {
      priorFlock: mode === 'with_audit_row' ? 'feeders' : null,
      detachShouldBlock: mode !== 'with_audit_row',
    },
  };
}
