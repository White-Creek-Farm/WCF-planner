// ============================================================================
// Cattle Send-to-Processor scenario seeds — for tests/cattle_send_to_processor.spec.js
// ============================================================================
// Two named seed builders:
//
//   seedCattleSendToProcessor(supabaseAdmin)
//     Happy-path setup: 3 finisher cattle + 1 empty planned processing batch
//     + 1 draft cattle weigh-in session + 3 weigh-ins with send_to_processor=true.
//     The spec drives attach via the UI (Complete Session → modal → Send to
//     processor) and exercises the full §7 chain.
//     Used by Tests 1, 2, 8.
//
//   seedCattleMultiCowPreAttached(supabaseAdmin)
//     Pre-attaches all 3 finisher cattle to a planned batch with valid
//     prior_herd_or_flock stamps + matching cattle_transfers audit rows.
//     Used by Tests 4 (session-delete) + 5 (batch-delete) so the multi-row
//     detach loop is actually exercised — single-cow seeds would let those
//     loops "pass" with N=1, which doesn't catch a regression that breaks
//     iteration. Detach succeeds via the primary path (prior_herd_or_flock
//     column lookup); the audit-row fallback is covered separately by
//     seedCattlePreAttachedForFallback.
//     Used by Tests 4, 5.
//
//   seedCattlePreAttachedForFallback(supabaseAdmin, { mode })
//     Bypasses the UI attach so tests can control the fallback state directly.
//     Pre-seeds 1 cow already at herd='processed', with the weigh-in row
//     pointing at the batch but prior_herd_or_flock=null. The mode parameter
//     toggles the audit-row state to exercise the §7 detach fallback hierarchy:
//
//        mode='with_audit_row'  → cattle_transfers row with from_herd='finishers'.
//                                  Detach should fall back to the audit row and
//                                  revert the cow to 'finishers'.
//        mode='null_from_herd'  → cattle_transfers row exists but from_herd is
//                                  NULL. The atomic detach RPC must return
//                                  reason='no_prior_herd'.
//        mode='no_audit_row'    → no audit row at all. Detach blocks with
//                                  reason='no_prior_herd' and the UI surfaces
//                                  the alert.
//     Used by Tests 3, 4, 5, 6, 6b, 7.
//
// Both seeds drop a single test-admin profile row so the spec can advance past
// LoginScreen via the global storageState.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

// Throw on any Supabase write/read error so the test fails at arrange time
// with a precise message instead of later at a confusing UI assertion.
function must(result, label) {
  if (result?.error) {
    throw new Error(`cattleProcessorSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

const BATCH_ID = 'cpb-test-c2601';
const BATCH_NAME = 'C-26-01';
const SESSION_ID = 'wsess-cattle-test';

// Three finisher cattle for the happy-path multi-cow attach.
const COW_ROWS = [
  {id: 'cow-test-2001', tag: '2001', breed: 'Black Angus'},
  {id: 'cow-test-2002', tag: '2002', breed: 'Black Angus'},
  {id: 'cow-test-2003', tag: '2003', breed: 'Hereford'},
];
const ENTRY_WEIGHTS = {2001: 1100, 2002: 1150, 2003: 1080};

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('cattleProcessorSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`cattleProcessorSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(
      `cattleProcessorSeed: test admin user "${adminEmail}" missing from auth.users. ` +
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

export async function seedCattleSendToProcessor(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  // Empty planned processing batch — the existing-batch path the modal
  // selects in Test 1.
  must(
    await supabaseAdmin.from('cattle_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'active',
        cows_detail: [],
        total_live_weight: null,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'cattle_processing_batches insert',
  );

  // 3 finisher cattle.
  must(
    await supabaseAdmin.from('cattle').upsert(
      COW_ROWS.map((c) => ({
        id: c.id,
        tag: c.tag,
        breed: c.breed,
        herd: 'finishers',
        old_tags: [],
      })),
      {onConflict: 'id'},
    ),
    'cattle insert',
  );

  // Draft cattle weigh-in session, herd=finishers (the gate that lets the
  // Send-to-Processor modal fire on Complete).
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'cattle',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: 'finishers',
        status: 'draft',
        started_at: '2026-04-28T08:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert',
  );

  // 3 flagged weigh-ins. send_to_processor=true; target_processing_batch_id
  // is null until the modal-confirm path stamps it.
  const weighIns = COW_ROWS.map((c, i) => ({
    id: `wi-test-cattle-${c.tag}`,
    session_id: SESSION_ID,
    tag: c.tag,
    weight: ENTRY_WEIGHTS[c.tag],
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
    cows: COW_ROWS,
    entryIds: weighIns.map((w) => w.id),
    expected: {priorHerd: 'finishers'},
  };
}

export async function seedCattleMultiCowPreAttached(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  // Planned batch with all 3 cows in cows_detail.
  const cowsDetail = COW_ROWS.map((c) => ({
    cattle_id: c.id,
    tag: c.tag,
    live_weight: ENTRY_WEIGHTS[c.tag],
    hanging_weight: null,
  }));
  const totalLive = cowsDetail.reduce((s, r) => s + r.live_weight, 0);
  must(
    await supabaseAdmin.from('cattle_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'active',
        cows_detail: cowsDetail,
        total_live_weight: Math.round(totalLive * 10) / 10,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'cattle_processing_batches insert (multi-cow pre-attached)',
  );

  // 3 cattle, all already moved to herd='processed'.
  must(
    await supabaseAdmin.from('cattle').upsert(
      COW_ROWS.map((c) => ({
        id: c.id,
        tag: c.tag,
        breed: c.breed,
        herd: 'processed',
        processing_batch_id: BATCH_ID,
        old_tags: [],
      })),
      {onConflict: 'id'},
    ),
    'cattle insert (multi-cow pre-attached)',
  );

  // Complete cattle weigh-in session — Tests 4/5 don't need to reopen.
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'cattle',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: 'finishers',
        status: 'complete',
        started_at: '2026-04-28T08:00:00Z',
        completed_at: '2026-04-28T09:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert (multi-cow pre-attached)',
  );

  // 3 weigh-ins, all flagged + targeted at the batch + prior_herd_or_flock
  // stamped to 'finishers' (mirrors what attachEntriesToBatch would write
  // on a real attach). Detach reads this column FIRST per the §7 fallback
  // hierarchy, so the loop tests exercise the primary path.
  const weighIns = COW_ROWS.map((c, i) => ({
    id: `wi-test-cattle-${c.tag}`,
    session_id: SESSION_ID,
    tag: c.tag,
    weight: ENTRY_WEIGHTS[c.tag],
    note: null,
    new_tag_flag: false,
    send_to_processor: true,
    target_processing_batch_id: BATCH_ID,
    prior_herd_or_flock: 'finishers',
    entered_at: `2026-04-28T08:0${i}:00Z`,
  }));
  must(
    await supabaseAdmin.from('weigh_ins').upsert(weighIns, {onConflict: 'id'}),
    'weigh_ins insert (multi-cow pre-attached)',
  );

  // Matching audit rows (what attach would have written). Their from_herd
  // would be the secondary fallback if prior_herd_or_flock weren't set;
  // including them keeps the seed faithful to a real post-attach state.
  must(
    await supabaseAdmin.from('cattle_transfers').upsert(
      COW_ROWS.map((c) => ({
        id: `xfer-test-${c.tag}`,
        cattle_id: c.id,
        from_herd: 'finishers',
        to_herd: 'processed',
        reason: 'processing_batch',
        reference_id: BATCH_ID,
        team_member: adminEmail,
      })),
      {onConflict: 'id'},
    ),
    'cattle_transfers insert (multi-cow pre-attached)',
  );

  return {
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    sessionId: SESSION_ID,
    cows: COW_ROWS,
    entryIds: weighIns.map((w) => w.id),
    expected: {priorHerd: 'finishers'},
  };
}

export async function seedCattlePreAttachedForFallback(supabaseAdmin, {mode} = {}) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  const adminEmail = await ensureAdminProfile(supabaseAdmin);

  if (!['with_audit_row', 'null_from_herd', 'no_audit_row'].includes(mode)) {
    throw new Error(
      `seedCattlePreAttachedForFallback: mode must be one of with_audit_row | null_from_herd | no_audit_row (got ${mode}).`,
    );
  }

  const cow = COW_ROWS[0]; // tag 2001 — single cow keeps assertions simple.

  // Empty planned processing batch then mutate it after attach.
  must(
    await supabaseAdmin.from('cattle_processing_batches').upsert(
      {
        id: BATCH_ID,
        name: BATCH_NAME,
        planned_process_date: '2026-05-15',
        actual_process_date: null,
        processing_cost: null,
        notes: null,
        status: 'active',
        cows_detail: [{cattle_id: cow.id, tag: cow.tag, live_weight: 1100, hanging_weight: null}],
        total_live_weight: 1100,
        total_hanging_weight: null,
      },
      {onConflict: 'id'},
    ),
    'cattle_processing_batches insert (pre-attached)',
  );

  // Cow already attached: herd=processed, processing_batch_id set.
  must(
    await supabaseAdmin.from('cattle').upsert(
      {
        id: cow.id,
        tag: cow.tag,
        breed: cow.breed,
        herd: 'processed',
        processing_batch_id: BATCH_ID,
        old_tags: [],
      },
      {onConflict: 'id'},
    ),
    'cattle insert (pre-attached)',
  );

  // Complete session with the attached entry. Note this is status='complete'
  // so reaching the toggle-clear button on the entry requires reopening via
  // UI (the spec exercises that path explicitly when needed). Tests 3-5 hit
  // entry/session/batch delete which work against complete sessions.
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'cattle',
        date: '2026-04-28',
        team_member: adminEmail,
        herd: 'finishers',
        status: 'complete',
        started_at: '2026-04-28T08:00:00Z',
        completed_at: '2026-04-28T09:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert (pre-attached)',
  );

  const entryId = `wi-test-cattle-${cow.tag}`;
  must(
    await supabaseAdmin.from('weigh_ins').upsert(
      {
        id: entryId,
        session_id: SESSION_ID,
        tag: cow.tag,
        weight: 1100,
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

  // Audit-row variants. The detach helper reads from_herd off the most-recent
  // matching row (migration 170 fallback); 'no_audit_row' skips insertion
  // entirely so step 1b returns nothing and detach lands on
  // reason='no_prior_herd'.
  if (mode === 'with_audit_row' || mode === 'null_from_herd') {
    must(
      await supabaseAdmin.from('cattle_transfers').upsert(
        {
          id: `xfer-test-${cow.tag}`,
          cattle_id: cow.id,
          from_herd: mode === 'null_from_herd' ? null : 'finishers',
          to_herd: 'processed',
          reason: 'processing_batch',
          reference_id: BATCH_ID,
          team_member: adminEmail,
        },
        {onConflict: 'id'},
      ),
      `cattle_transfers insert (${mode})`,
    );
  }

  return {
    batchId: BATCH_ID,
    batchName: BATCH_NAME,
    sessionId: SESSION_ID,
    cowId: cow.id,
    cowTag: cow.tag,
    entryId,
    mode,
    expected: {
      priorHerd: mode === 'with_audit_row' ? 'finishers' : null,
      detachShouldBlock: mode !== 'with_audit_row',
    },
  };
}
