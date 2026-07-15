// Apply migration 179 to TEST and prove the processing lifecycle lock-order
// hardening with real concurrent database sessions.
//
// Hard safety boundaries (same as apply_test_mig_170.cjs):
//   * WCF_TEST_DATABASE must be exactly 1.
//   * VITE_SUPABASE_URL must not contain the PROD project ref.
//   * exec_sql is used only after those guards pass, and only against TEST.
//
// Concurrency proof design. exec_sql runs its whole SQL string inside one
// Postgres transaction on its own pooled connection, so two overlapping
// exec_sql / PostgREST calls are two independent database sessions. A "holder"
// session takes locks in the canonical detach order (batch -> animal) with a
// pg_sleep window; the function under test races it as a real authenticated
// PostgREST RPC call so the client-visible return shape is also proven.
// Bounded lock/statement timeouts inside every holder make a deadlock or
// indefinite wait fail clearly instead of hanging.
//
// Phases:
//   A  Sensitivity: with the OLD migration-100 functions restored, the
//      deterministic collision MUST deadlock (40P01) for cattle and sheep,
//      proving both that the defect is real and that this harness detects
//      deadlocks. A2 proves the old stale-status defect: a real attach that
//      activates the batch during the race does not stop the old unschedule
//      from deleting the now-active batch, leaving a dangling
//      cattle.processing_batch_id.
//   B  Apply migration 179 + structural proof (SECDEF, search_path, grants,
//      comments).
//   C  Hardened deterministic collision: the same scenarios serialize with no
//      deadlock and a valid terminal state; repeat calls stay idempotent
//      (second unschedule/delete returns no_batch).
//   D  Hardened stale-status: unschedule racing a real attach returns
//      not_scheduled and the active batch + membership survive intact.
//   E  Real-RPC soak: attach vs unschedule (cattle) and detach vs delete
//      (sheep) fired truly concurrently, multiple rounds; every terminal state
//      must be one of the two valid serializations with no deadlock, no
//      dangling processing_batch_id, and no lost/duplicated mutation.
//
// Cleanup always runs (also on failure). If Phase A restored the old
// functions and a later phase failed, cleanup best-effort re-applies 179 so
// TEST is never left regressed by a broken run.

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (process.env.WCF_TEST_DATABASE !== '1') {
  console.error('refusing: WCF_TEST_DATABASE must be 1');
  process.exit(2);
}
if (!url || !serviceKey || !anonKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing: URL matches PROD project ref');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const caller = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const caller2 = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const STAMP = Date.now();
const EMAIL = 'lockorder179-proof@wcfplanner.test';
const PASSWORD = 'LockOrder179Proof!pw';
const PROFILE_NAME = 'Lock Order 179 Admin';

let userId = null;
let migration179Applied = false;
let migration100Restored = false;

// Registry of every seeded row id so cleanup is exact and idempotent.
const seeded = {
  cattleBatches: new Set(),
  sheepBatches: new Set(),
  cattle: new Set(),
  sheep: new Set(),
  sessions: new Set(),
  weighIns: new Set(),
};

function fail(message, detail) {
  throw new Error(message + (detail ? `: ${detail}` : ''));
}

function ok(message) {
  console.log(`  ok  ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${label}: exceeded ${ms}ms watchdog (possible undetected lock wait)`);
    }),
  ]);
}

async function execSql(sql) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) return {ok: false, message: error.message || String(error)};
  return {ok: true, message: null};
}

async function mustExecSql(sql, label) {
  const r = await execSql(sql);
  if (!r.ok) fail(label, r.message);
}

async function applyMigrationFile(name, label) {
  const body = fs.readFileSync(path.join(__dirname, '..', 'supabase-migrations', name), 'utf8');
  await mustExecSql(body, label);
  await execSql("NOTIFY pgrst, 'reload schema';", 'schema reload');
  await sleep(2500);
}

async function findUserByEmail(email) {
  for (let page = 1; ; page += 1) {
    const {data, error} = await service.auth.admin.listUsers({page, perPage: 200});
    if (error) fail('listUsers failed', error.message);
    const found = (data.users || []).find((user) => (user.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (!data.users || data.users.length < 200) return null;
  }
}

async function ensureProofUser() {
  let user = await findUserByEmail(EMAIL);
  if (!user) {
    const {data, error} = await service.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) fail('create proof user failed', error.message);
    user = data.user;
  } else {
    const {error} = await service.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) fail('reset proof user password failed', error.message);
  }
  userId = user.id;
  const {error: profileError} = await service
    .from('profiles')
    .upsert(
      {id: userId, email: EMAIL, full_name: PROFILE_NAME, role: 'admin', program_access: null},
      {onConflict: 'id'},
    );
  if (profileError) fail('profiles upsert failed', profileError.message);
  for (const [label, client] of [
    ['caller', caller],
    ['caller2', caller2],
  ]) {
    const {error} = await client.auth.signInWithPassword({email: EMAIL, password: PASSWORD});
    if (error) fail(`${label} sign-in failed`, error.message);
  }
}

// SQL fragment: impersonate the proof admin inside a holder transaction so
// SECDEF RPCs invoked there resolve auth.uid()/profile_role() like a real
// authenticated call.
function claimsSql() {
  return `PERFORM set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true);`;
}

// lock_timeout is read at each lock wait, so setting it inside the DO block
// bounds every FOR UPDATE below. (statement_timeout would not rearm for the
// already-running DO statement; the JS-side watchdog covers total runtime.)
function timeoutsSql() {
  return "PERFORM set_config('lock_timeout', '8s', true);";
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedCattleBatch(id, {status = 'scheduled', cowsDetail = []} = {}) {
  seeded.cattleBatches.add(id);
  const {error} = await service.from('cattle_processing_batches').insert({
    id,
    name: `Lock179 ${id}`,
    planned_process_date: '2026-07-20',
    status,
    cows_detail: cowsDetail,
    total_live_weight: null,
    total_hanging_weight: null,
  });
  if (error) fail(`seed cattle batch ${id} failed`, error.message);
}

async function seedSheepBatch(id, {status = 'planned', sheepDetail = []} = {}) {
  seeded.sheepBatches.add(id);
  const {error} = await service.from('sheep_processing_batches').insert({
    id,
    name: `Lock179 ${id}`,
    planned_process_date: '2026-07-20',
    status,
    sheep_detail: sheepDetail,
    total_live_weight: null,
    total_hanging_weight: null,
  });
  if (error) fail(`seed sheep batch ${id} failed`, error.message);
}

async function seedCow(id, {tag, herd = 'finishers', batchId = null} = {}) {
  seeded.cattle.add(id);
  const {error} = await service.from('cattle').insert({
    id,
    tag,
    herd,
    processing_batch_id: batchId,
    old_tags: [],
  });
  if (error) fail(`seed cow ${id} failed`, error.message);
}

async function seedSheep(id, {tag, flock = 'ewes', batchId = null} = {}) {
  seeded.sheep.add(id);
  const {error} = await service.from('sheep').insert({
    id,
    tag,
    flock,
    processing_batch_id: batchId,
    old_tags: [],
  });
  if (error) fail(`seed sheep ${id} failed`, error.message);
}

async function seedSession(id, species) {
  seeded.sessions.add(id);
  const {error} = await service.from('weigh_in_sessions').insert({
    id,
    species,
    date: '2026-07-20',
    team_member: PROFILE_NAME,
    herd: species === 'cattle' ? 'finishers' : 'ewes',
    status: 'draft',
    started_at: '2026-07-20T12:00:00Z',
  });
  if (error) fail(`seed session ${id} failed`, error.message);
}

async function seedWeighIn(id, {sessionId, tag, weight = 1000, batchId = null, prior = null} = {}) {
  seeded.weighIns.add(id);
  const {error} = await service.from('weigh_ins').insert({
    id,
    session_id: sessionId,
    tag,
    weight,
    new_tag_flag: false,
    send_to_processor: batchId != null,
    target_processing_batch_id: batchId,
    prior_herd_or_flock: prior,
    entered_at: '2026-07-20T12:01:00Z',
  });
  if (error) fail(`seed weigh-in ${id} failed`, error.message);
}

async function readSingle(table, columns, id) {
  const {data, error} = await service.from(table).select(columns).eq('id', id).maybeSingle();
  if (error) fail(`read ${table} ${id} failed`, error.message);
  return data; // null when the row does not exist
}

// ── Holder transactions (detach-order lock holders) ─────────────────────────

// Canonical detach order: batch FOR UPDATE, sleep, then animal FOR UPDATE.
// Mirrors migration 170's first and last lock while holding a window open so
// the racing lifecycle RPC must interleave.
function detachOrderHolderSql({batchTable, animalTable, batchId, animalId, sleepSeconds}) {
  return `
DO $holder$
BEGIN
  ${timeoutsSql()}
  PERFORM 1 FROM public.${batchTable} WHERE id = '${batchId}' FOR UPDATE;
  PERFORM pg_sleep(${sleepSeconds});
  PERFORM 1 FROM public.${animalTable} WHERE id = '${animalId}' FOR UPDATE;
END
$holder$;`;
}

// Attach-order holder that performs a REAL attach mid-window: locks session
// then batch (migration-096 order), sleeps, then runs the real attach RPC in
// the same transaction (re-locking rows it already holds is a no-op).
function attachHolderSql({sessionId, batchId, entryId, sleepSeconds}) {
  return `
DO $holder$
DECLARE
  v_result jsonb;
BEGIN
  ${timeoutsSql()}
  ${claimsSql()}
  PERFORM 1 FROM public.weigh_in_sessions WHERE id = '${sessionId}' FOR UPDATE;
  PERFORM 1 FROM public.cattle_processing_batches WHERE id = '${batchId}' FOR UPDATE;
  PERFORM pg_sleep(${sleepSeconds});
  v_result := public.attach_cattle_to_processing_batch(
    '${sessionId}', ARRAY['${entryId}']::text[], '${batchId}', NULL, NULL, NULL);
  IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'holder attach failed: %', v_result::text;
  END IF;
END
$holder$;`;
}

async function raceHolderVsRpc({holderSql, holderLabel, rpcName, rpcArgs, rpcDelayMs, rpcClient = caller}) {
  const holderPromise = execSql(holderSql, holderLabel);
  await sleep(rpcDelayMs);
  const rpcPromise = rpcClient.rpc(rpcName, rpcArgs).then(({data, error}) => ({
    data,
    message: error ? error.message || String(error) : null,
  }));
  const [holder, rpc] = await withTimeout(
    Promise.all([holderPromise, rpcPromise]),
    30000,
    `${holderLabel} vs ${rpcName}`,
  );
  return {holder, rpc};
}

function isDeadlockMessage(message) {
  return /deadlock detected/i.test(message || '');
}

// ── Phase A: sensitivity — the OLD functions must deadlock ──────────────────

async function proveOldCodeDeadlocks() {
  await applyMigrationFile('100_processing_batch_lifecycle_rpcs.sql', 'restore migration 100 (old functions)');
  migration100Restored = true;
  ok('old migration-100 functions restored on TEST for the sensitivity check');

  const cases = [
    {
      label: 'cattle old unschedule vs detach-order holder',
      batchTable: 'cattle_processing_batches',
      animalTable: 'cattle',
      batchId: `lock179-a-cb-${STAMP}`,
      animalId: `lock179-a-cow-${STAMP}`,
      rpcName: 'unschedule_cattle_processing_batch',
      seed: async (c) => {
        await seedCattleBatch(c.batchId);
        await seedCow(c.animalId, {tag: `A1-${STAMP}`, herd: 'processed', batchId: c.batchId});
      },
    },
    {
      label: 'sheep old delete vs detach-order holder',
      batchTable: 'sheep_processing_batches',
      animalTable: 'sheep',
      batchId: `lock179-a-sb-${STAMP}`,
      animalId: `lock179-a-sh-${STAMP}`,
      rpcName: 'delete_sheep_processing_batch',
      seed: async (c) => {
        await seedSheepBatch(c.batchId);
        await seedSheep(c.animalId, {tag: `A2-${STAMP}`, flock: 'processed', batchId: c.batchId});
      },
    },
  ];

  for (const c of cases) {
    await c.seed(c);
    const {holder, rpc} = await raceHolderVsRpc({
      holderSql: detachOrderHolderSql({
        batchTable: c.batchTable,
        animalTable: c.animalTable,
        batchId: c.batchId,
        animalId: c.animalId,
        sleepSeconds: 2.2,
      }),
      holderLabel: `${c.label} holder`,
      rpcName: c.rpcName,
      rpcArgs: {p_batch_id: c.batchId, p_team_member: null},
      rpcDelayMs: 700,
    });
    const holderDeadlocked = !holder.ok && isDeadlockMessage(holder.message);
    const rpcDeadlocked = rpc.message != null && isDeadlockMessage(rpc.message);
    if (!holderDeadlocked && !rpcDeadlocked) {
      fail(
        `${c.label}: expected a 40P01 deadlock with the OLD functions`,
        `holder=${holder.message || 'ok'} rpc=${rpc.message || JSON.stringify(rpc.data)}`,
      );
    }
    ok(`${c.label}: deadlock reproduced and detected (${holderDeadlocked ? 'holder' : 'rpc'} side aborted)`);
    // Clear whatever the surviving side left behind for a clean next phase.
    await service.from(c.animalTable).update({processing_batch_id: null}).eq('id', c.animalId);
    await service.from(c.batchTable).delete().eq('id', c.batchId);
  }
}

async function proveOldCodeStaleDelete() {
  // Which corrupt state the OLD code leaves depends on sub-statement timing:
  // if the stale unschedule's defensive unlink ran before the attach committed
  // it leaves a dangling cattle.processing_batch_id; if it ran after, the cow
  // is unlinked but stranded in herd='processed' with no batch. In BOTH
  // interleaves the essential defect is the same: the unschedule passed its
  // pre-lock 'scheduled' check on a stale snapshot, then deleted a batch that
  // a committed attach had just activated, and the attached weigh-in is left
  // pointing at the deleted batch. Assert the essential invariants and log the
  // flavor. Retry with fresh ids if the race is missed entirely (unschedule
  // arriving after the attach commit returns not_scheduled even on old code).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const batchId = `lock179-a2-cb-${attempt}-${STAMP}`;
    const cowId = `lock179-a2-cow-${attempt}-${STAMP}`;
    const sessionId = `lock179-a2-ses-${attempt}-${STAMP}`;
    const weighInId = `lock179-a2-wi-${attempt}-${STAMP}`;
    const tag = `A3-${attempt}-${STAMP}`;
    await seedCattleBatch(batchId);
    await seedCow(cowId, {tag, herd: 'finishers'});
    await seedSession(sessionId, 'cattle');
    await seedWeighIn(weighInId, {sessionId, tag});

    const {holder, rpc} = await raceHolderVsRpc({
      holderSql: attachHolderSql({sessionId, batchId, entryId: weighInId, sleepSeconds: 2.2}),
      holderLabel: 'real attach holder (old code)',
      rpcName: 'unschedule_cattle_processing_batch',
      rpcArgs: {p_batch_id: batchId, p_team_member: null},
      rpcDelayMs: 700,
    });
    if (!holder.ok) fail('old-code stale-delete: attach holder failed', holder.message);
    if (rpc.message != null) fail('old-code stale-delete: unschedule errored unexpectedly', rpc.message);

    const repair = async () => {
      await service.from('cattle').update({processing_batch_id: null, herd: 'finishers'}).eq('id', cowId);
      await service
        .from('weigh_ins')
        .update({target_processing_batch_id: null, send_to_processor: false})
        .eq('id', weighInId);
      await service.from('cattle_processing_batches').delete().eq('id', batchId);
    };

    if (rpc.data?.ok !== true) {
      // Race missed: the unschedule arrived after the attach commit and even
      // the old code refused. Repair and retry with fresh ids.
      console.log(`  ..  old-code stale-delete attempt ${attempt} missed the window (${rpc.data?.reason}); retrying`);
      await repair();
      continue;
    }

    const batch = await readSingle('cattle_processing_batches', 'id,status', batchId);
    const cow = await readSingle('cattle', 'processing_batch_id,herd', cowId);
    const weighIn = await readSingle('weigh_ins', 'target_processing_batch_id', weighInId);
    if (batch !== null) {
      fail('old-code stale-delete: expected the just-activated batch to be deleted', JSON.stringify(batch));
    }
    if (cow?.herd !== 'processed') {
      fail(
        'old-code stale-delete: expected the committed attach to have moved the cow to processed',
        JSON.stringify(cow),
      );
    }
    const dangling = cow?.processing_batch_id === batchId;
    const strandedWeighIn = weighIn?.target_processing_batch_id === batchId;
    if (!dangling && !strandedWeighIn) {
      fail(
        'old-code stale-delete: expected an inconsistent terminal state (dangling link or stranded weigh-in)',
        JSON.stringify({cow, weighIn}),
      );
    }
    ok(
      'old-code stale-delete reproduced: stale unschedule deleted the just-activated batch ' +
        `(${dangling ? 'dangling cattle.processing_batch_id' : 'cow stranded in processed'}` +
        `${strandedWeighIn ? ', weigh-in points at deleted batch' : ''})`,
    );
    await repair();
    return;
  }
  fail('old-code stale-delete: race window missed on every attempt');
}

// ── Phase B: apply migration 179 + structural proof ─────────────────────────

async function applyMigration179() {
  await applyMigrationFile('179_processing_lifecycle_lock_order.sql', 'migration 179 apply');
  migration179Applied = true;
  ok('migration 179 applied');

  const structuralProof = `
DO $proof$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'unschedule_cattle_processing_batch',
    'delete_sheep_processing_batch'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public']::text[]
    ) THEN
      RAISE EXCEPTION '% missing SECURITY DEFINER/search_path contract', v_name;
    END IF;
    IF has_function_privilege('anon', format('public.%I(text,text)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '% leaks EXECUTE to anon/PUBLIC', v_name;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%I(text,text)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '% missing authenticated EXECUTE', v_name;
    END IF;
    IF obj_description(format('public.%I(text,text)', v_name)::regprocedure, 'pg_proc') IS NULL THEN
      RAISE EXCEPTION '% missing API comment', v_name;
    END IF;
  END LOOP;
END
$proof$;`;
  await mustExecSql(structuralProof, 'migration 179 structural proof');
  ok('SECDEF/search_path/grants/API comments verified');
}

// ── Phase C: hardened deterministic collision ────────────────────────────────

async function proveHardenedNoDeadlock() {
  const cases = [
    {
      label: 'cattle hardened unschedule vs detach-order holder',
      batchTable: 'cattle_processing_batches',
      animalTable: 'cattle',
      batchId: `lock179-c-cb-${STAMP}`,
      animalId: `lock179-c-cow-${STAMP}`,
      rpcName: 'unschedule_cattle_processing_batch',
      okReason: 'unscheduled',
      unlinkedKey: 'cattle_unlinked',
      seed: async (c) => {
        await seedCattleBatch(c.batchId);
        await seedCow(c.animalId, {tag: `C1-${STAMP}`, herd: 'processed', batchId: c.batchId});
      },
    },
    {
      label: 'sheep hardened delete vs detach-order holder',
      batchTable: 'sheep_processing_batches',
      animalTable: 'sheep',
      batchId: `lock179-c-sb-${STAMP}`,
      animalId: `lock179-c-sh-${STAMP}`,
      rpcName: 'delete_sheep_processing_batch',
      okReason: 'deleted',
      unlinkedKey: 'sheep_unlinked',
      seed: async (c) => {
        await seedSheepBatch(c.batchId);
        await seedSheep(c.animalId, {tag: `C2-${STAMP}`, flock: 'processed', batchId: c.batchId});
      },
    },
  ];

  for (const c of cases) {
    await c.seed(c);
    const {holder, rpc} = await raceHolderVsRpc({
      holderSql: detachOrderHolderSql({
        batchTable: c.batchTable,
        animalTable: c.animalTable,
        batchId: c.batchId,
        animalId: c.animalId,
        sleepSeconds: 2.2,
      }),
      holderLabel: `${c.label} holder`,
      rpcName: c.rpcName,
      rpcArgs: {p_batch_id: c.batchId, p_team_member: null},
      rpcDelayMs: 700,
    });
    if (!holder.ok) fail(`${c.label}: holder failed`, holder.message);
    if (rpc.message != null) fail(`${c.label}: hardened RPC errored`, rpc.message);
    if (rpc.data?.ok !== true || rpc.data?.reason !== c.okReason || rpc.data?.[c.unlinkedKey] !== 1) {
      fail(`${c.label}: unexpected RPC result`, JSON.stringify(rpc.data));
    }
    const batch = await readSingle(c.batchTable, 'id', c.batchId);
    const animal = await readSingle(c.animalTable, 'processing_batch_id', c.animalId);
    if (batch !== null) fail(`${c.label}: batch row must be deleted`, JSON.stringify(batch));
    if (animal?.processing_batch_id !== null) {
      fail(`${c.label}: animal link must be cleared`, JSON.stringify(animal));
    }
    const {data: events, error: eventsError} = await service
      .from('activity_events')
      .select('id,event_type')
      .eq('entity_id', c.batchId)
      .eq('event_type', 'record.deleted');
    if (eventsError) fail(`${c.label}: activity read failed`, eventsError.message);
    if ((events || []).length !== 1)
      fail(`${c.label}: expected exactly one record.deleted event`, JSON.stringify(events));
    ok(`${c.label}: serialized cleanly, no deadlock, valid terminal state, audited once`);

    // Idempotent retry: the batch is gone, so a repeat call must be a clean
    // no_batch business result, not an error or a duplicate mutation.
    const retry = await caller.rpc(c.rpcName, {p_batch_id: c.batchId, p_team_member: null});
    if (retry.error) fail(`${c.label}: retry errored`, retry.error.message);
    if (retry.data?.ok !== false || retry.data?.reason !== 'no_batch') {
      fail(`${c.label}: retry must return no_batch`, JSON.stringify(retry.data));
    }
    ok(`${c.label}: repeat call returns no_batch (idempotent retry contract preserved)`);
  }
}

// ── Phase D: hardened stale-status refusal ──────────────────────────────────

async function proveHardenedStaleStatusRefusal() {
  const batchId = `lock179-d-cb-${STAMP}`;
  const cowId = `lock179-d-cow-${STAMP}`;
  const sessionId = `lock179-d-ses-${STAMP}`;
  const weighInId = `lock179-d-wi-${STAMP}`;
  const tag = `D1-${STAMP}`;
  await seedCattleBatch(batchId);
  await seedCow(cowId, {tag, herd: 'finishers'});
  await seedSession(sessionId, 'cattle');
  await seedWeighIn(weighInId, {sessionId, tag});

  const {holder, rpc} = await raceHolderVsRpc({
    holderSql: attachHolderSql({sessionId, batchId, entryId: weighInId, sleepSeconds: 2.2}),
    holderLabel: 'real attach holder (hardened)',
    rpcName: 'unschedule_cattle_processing_batch',
    rpcArgs: {p_batch_id: batchId, p_team_member: null},
    rpcDelayMs: 700,
  });
  if (!holder.ok) fail('hardened stale-status: attach holder failed', holder.message);
  if (rpc.message != null) fail('hardened stale-status: unschedule errored', rpc.message);
  if (rpc.data?.ok !== false || rpc.data?.reason !== 'not_scheduled' || rpc.data?.status !== 'active') {
    fail('hardened stale-status: expected not_scheduled with status=active', JSON.stringify(rpc.data));
  }
  const batch = await readSingle('cattle_processing_batches', 'id,status,cows_detail', batchId);
  const cow = await readSingle('cattle', 'processing_batch_id,herd', cowId);
  const weighIn = await readSingle('weigh_ins', 'target_processing_batch_id,send_to_processor', weighInId);
  if (batch?.status !== 'active') fail('hardened stale-status: batch must survive as active', JSON.stringify(batch));
  const detail = batch.cows_detail || [];
  if (detail.length !== 1 || detail[0].cattle_id !== cowId) {
    fail('hardened stale-status: batch membership must show the attached cow', JSON.stringify(detail));
  }
  if (cow?.processing_batch_id !== batchId || cow?.herd !== 'processed') {
    fail('hardened stale-status: cow must remain attached', JSON.stringify(cow));
  }
  if (weighIn?.target_processing_batch_id !== batchId) {
    fail('hardened stale-status: weigh-in must stay linked', JSON.stringify(weighIn));
  }
  ok(
    'hardened stale-status: unschedule waited for the lock, revalidated, refused (not_scheduled); attach state intact',
  );
}

// ── Phase E: real-RPC soak races ─────────────────────────────────────────────

async function soakCattleAttachVsUnschedule(round) {
  const batchId = `lock179-e-cb-${round}-${STAMP}`;
  const cowId = `lock179-e-cow-${round}-${STAMP}`;
  const sessionId = `lock179-e-ses-${round}-${STAMP}`;
  const weighInId = `lock179-e-wi-${round}-${STAMP}`;
  const tag = `E${round}-${STAMP}`;
  await seedCattleBatch(batchId);
  await seedCow(cowId, {tag, herd: 'finishers'});
  await seedSession(sessionId, 'cattle');
  await seedWeighIn(weighInId, {sessionId, tag});

  const [attach, unschedule] = await withTimeout(
    Promise.all([
      caller
        .rpc('attach_cattle_to_processing_batch', {
          p_session_id: sessionId,
          p_entry_ids: [weighInId],
          p_target_batch_id: batchId,
          p_batch_name: null,
          p_processing_date: null,
          p_team_member: null,
        })
        .then(({data, error}) => ({data, message: error ? error.message || String(error) : null})),
      caller2
        .rpc('unschedule_cattle_processing_batch', {p_batch_id: batchId, p_team_member: null})
        .then(({data, error}) => ({data, message: error ? error.message || String(error) : null})),
    ]),
    30000,
    `soak cattle round ${round}`,
  );

  for (const [label, r] of [
    ['attach', attach],
    ['unschedule', unschedule],
  ]) {
    if (isDeadlockMessage(r.message)) fail(`soak cattle round ${round}: ${label} deadlocked`, r.message);
    if (/timeout/i.test(r.message || '')) fail(`soak cattle round ${round}: ${label} timed out`, r.message);
  }

  const batch = await readSingle('cattle_processing_batches', 'id,status,cows_detail', batchId);
  const cow = await readSingle('cattle', 'processing_batch_id,herd', cowId);
  const weighIn = await readSingle('weigh_ins', 'target_processing_batch_id', weighInId);

  let outcome;
  if (batch === null) {
    // Unschedule won. Attach must have failed cleanly (batch not found /
    // must-be-scheduled-or-active) and nothing may dangle.
    if (attach.message == null && attach.data?.ok === true) {
      fail(`soak cattle round ${round}: batch gone but attach also reported success`, JSON.stringify(attach.data));
    }
    if (unschedule.message != null || unschedule.data?.ok !== true) {
      fail(`soak cattle round ${round}: batch gone but unschedule did not report success`, JSON.stringify(unschedule));
    }
    if (cow?.processing_batch_id !== null) {
      fail(`soak cattle round ${round}: dangling cattle.processing_batch_id after unschedule win`, JSON.stringify(cow));
    }
    if (weighIn?.target_processing_batch_id != null) {
      fail(`soak cattle round ${round}: weigh-in points at deleted batch`, JSON.stringify(weighIn));
    }
    outcome = 'unschedule-first';
  } else {
    // Attach won. Batch must be active with exactly the cow attached, and the
    // late unschedule must have refused with not_scheduled.
    if (attach.message != null || attach.data?.ok !== true) {
      fail(`soak cattle round ${round}: batch survives but attach failed`, JSON.stringify(attach));
    }
    if (unschedule.message != null || unschedule.data?.ok !== false || unschedule.data?.reason !== 'not_scheduled') {
      fail(`soak cattle round ${round}: expected not_scheduled from the losing unschedule`, JSON.stringify(unschedule));
    }
    const detail = batch.cows_detail || [];
    if (batch.status !== 'active' || detail.length !== 1 || detail[0].cattle_id !== cowId) {
      fail(`soak cattle round ${round}: stale batch membership`, JSON.stringify(batch));
    }
    if (cow?.processing_batch_id !== batchId || weighIn?.target_processing_batch_id !== batchId) {
      fail(`soak cattle round ${round}: attach-side links incomplete`, JSON.stringify({cow, weighIn}));
    }
    outcome = 'attach-first';
  }
  ok(`soak cattle round ${round}: no deadlock, valid ${outcome} terminal state`);
}

async function soakSheepDetachVsDelete(round) {
  const batchId = `lock179-e-sb-${round}-${STAMP}`;
  const sheepId = `lock179-e-sh-${round}-${STAMP}`;
  const sessionId = `lock179-e-sses-${round}-${STAMP}`;
  const weighInId = `lock179-e-swi-${round}-${STAMP}`;
  const tag = `ES${round}-${STAMP}`;
  await seedSheepBatch(batchId, {
    sheepDetail: [{sheep_id: sheepId, tag, live_weight: 120, hanging_weight: null}],
  });
  await seedSheep(sheepId, {tag, flock: 'processed', batchId});
  await seedSession(sessionId, 'sheep');
  await seedWeighIn(weighInId, {sessionId, tag, weight: 120, batchId, prior: 'ewes'});

  const [detach, del] = await withTimeout(
    Promise.all([
      caller
        .rpc('detach_sheep_from_processing_batch', {p_sheep_id: sheepId, p_batch_id: batchId, p_team_member: null})
        .then(({data, error}) => ({data, message: error ? error.message || String(error) : null})),
      caller2
        .rpc('delete_sheep_processing_batch', {p_batch_id: batchId, p_team_member: null})
        .then(({data, error}) => ({data, message: error ? error.message || String(error) : null})),
    ]),
    30000,
    `soak sheep round ${round}`,
  );

  for (const [label, r] of [
    ['detach', detach],
    ['delete', del],
  ]) {
    if (isDeadlockMessage(r.message)) fail(`soak sheep round ${round}: ${label} deadlocked`, r.message);
    if (r.message != null) fail(`soak sheep round ${round}: ${label} errored`, r.message);
  }
  if (del.data?.ok !== true || del.data?.reason !== 'deleted') {
    fail(`soak sheep round ${round}: delete must succeed`, JSON.stringify(del.data));
  }

  const batch = await readSingle('sheep_processing_batches', 'id', batchId);
  const sheep = await readSingle('sheep', 'processing_batch_id,flock', sheepId);
  if (batch !== null) fail(`soak sheep round ${round}: batch must be deleted`, JSON.stringify(batch));
  if (sheep?.processing_batch_id !== null) {
    fail(`soak sheep round ${round}: dangling sheep.processing_batch_id`, JSON.stringify(sheep));
  }

  const detachReason = detach.data?.reason;
  if (detach.data?.ok === true && detachReason === 'detached') {
    // Detach won the race: the sheep must be fully restored and the delete
    // then removed the emptied batch.
    if (sheep?.flock !== 'ewes') {
      fail(`soak sheep round ${round}: detached sheep not restored to prior flock`, JSON.stringify(sheep));
    }
    const {data: transfers, error: trError} = await service
      .from('sheep_transfers')
      .select('id,reason')
      .eq('sheep_id', sheepId)
      .eq('reason', 'processing_batch_undo');
    if (trError) fail(`soak sheep round ${round}: transfer read failed`, trError.message);
    if ((transfers || []).length !== 1) {
      fail(`soak sheep round ${round}: expected exactly one undo transfer`, JSON.stringify(transfers));
    }
    ok(`soak sheep round ${round}: no deadlock, detach-first terminal state (restored + single undo transfer)`);
  } else if (detach.data?.ok === false && ['no_batch', 'not_in_batch'].includes(detachReason)) {
    // Delete won: the straggler clear unlinked the sheep (flock intentionally
    // stays 'processed' — migration-100 semantics preserved) and the late
    // detach refused on revalidation instead of restoring a stale list.
    if (sheep?.flock !== 'processed') {
      fail(`soak sheep round ${round}: delete-first flock semantics changed`, JSON.stringify(sheep));
    }
    ok(`soak sheep round ${round}: no deadlock, delete-first terminal state (stale detach refused: ${detachReason})`);
  } else {
    fail(`soak sheep round ${round}: unexpected detach result`, JSON.stringify(detach.data));
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  const errors = [];
  const batchIds = [...seeded.cattleBatches, ...seeded.sheepBatches];
  const steps = [
    ['activity_events', 'entity_id', batchIds],
    ['cattle_transfers', 'cattle_id', [...seeded.cattle]],
    ['sheep_transfers', 'sheep_id', [...seeded.sheep]],
    ['weigh_ins', 'id', [...seeded.weighIns]],
    ['weigh_in_sessions', 'id', [...seeded.sessions]],
    ['cattle', 'id', [...seeded.cattle]],
    ['sheep', 'id', [...seeded.sheep]],
    ['cattle_processing_batches', 'id', [...seeded.cattleBatches]],
    ['sheep_processing_batches', 'id', [...seeded.sheepBatches]],
  ];
  for (const [table, column, ids] of steps) {
    if (ids.length === 0) continue;
    const result = await service.from(table).delete().in(column, ids);
    if (result.error) errors.push(`${table}: ${result.error.message}`);
  }
  for (const client of [caller, caller2]) {
    const signOut = await client.auth.signOut();
    if (signOut.error) errors.push(`signOut: ${signOut.error.message}`);
  }
  if (userId) {
    const authDelete = await service.auth.admin.deleteUser(userId);
    if (authDelete.error) errors.push(`auth user: ${authDelete.error.message}`);
    const profileDelete = await service.from('profiles').delete().eq('id', userId);
    if (profileDelete.error) errors.push(`profile: ${profileDelete.error.message}`);
  }
  // Never leave TEST regressed to the migration-100 functions by a failed run.
  if (migration100Restored && !migration179Applied) {
    try {
      await applyMigrationFile('179_processing_lifecycle_lock_order.sql', 'cleanup re-apply of migration 179');
      console.log('  ..  cleanup re-applied migration 179 after a mid-run failure');
    } catch (reapplyError) {
      errors.push(`re-apply 179: ${reapplyError.message}`);
    }
  }
  if (errors.length > 0) fail('proof cleanup issues', errors.join('; '));
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`TEST url=${url}`);
  await ensureProofUser();
  ok('proof admin user ready (both racing clients signed in)');

  console.log('Phase A: sensitivity — old migration-100 functions must deadlock');
  await proveOldCodeDeadlocks();
  await proveOldCodeStaleDelete();

  console.log('Phase B: apply migration 179');
  await applyMigration179();

  console.log('Phase C: hardened deterministic collision');
  await proveHardenedNoDeadlock();

  console.log('Phase D: hardened stale-status refusal');
  await proveHardenedStaleStatusRefusal();

  console.log('Phase E: real-RPC soak races');
  for (let round = 1; round <= 4; round += 1) {
    await soakCattleAttachVsUnschedule(round);
  }
  for (let round = 1; round <= 4; round += 1) {
    await soakSheepDetachVsDelete(round);
  }

  await cleanup();
  ok('proof rows and user cleaned up');
  console.log('ALL MIGRATION 179 CHECKS PASSED');
})().catch(async (error) => {
  console.error(error.message || error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('cleanup failed:', cleanupError.message || cleanupError);
  }
  process.exit(1);
});
