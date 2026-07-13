// Apply mig 176 (processing lifecycle + reconcile + transactional pig planner
// mutations) to TEST via exec_sql and prove the gated contract:
//   1. reconcile projects EVERY persisted planned pig trip into a planner
//      record: source_phase='planned', stored status 'planned', deterministic
//      'Pig Trip · <batch> · Trip <n>' titles (ordinals 1, 2);
//   2. a broiler batch keyed by immutable id (stamped 'bb-mig176-<stamp>', so a
//      shared-TEST collision is impossible) with a PAST processingDate
//      reads effective_status='in_process' via the authed list RPC and
//      live_count from the live store (50);
//   3. completion blockers on a future-dated planned pig record include
//      'Processing Date has not begun' and 'Processor is required';
//   4. pig_send_to_trip PROMOTES the planned trip id into processingTrips
//      unchanged (same id 'pt-a'), stamps the weigh-ins, keeps the SAME
//      Processing record (flipped to source_phase='actual'), and pushes the
//      under-send remainder onto the next planned trip (pt-b: 2+5=7);
//   5. pig_undo_send returns one pig to the plan (pt-a pigCount 2, stamp
//      cleared, pt-b back to 8);
//   6. undoing the last pig REVERTS the actual trip to a planned trip with the
//      SAME id (pt-a, plannedCount 1) and the record flips back to
//      source_phase='planned' under the same record id;
//   7. source-removal sweep: an UNWORKED record whose source vanished is
//      DELETED; a WORKED one (processor set) is ARCHIVED + stamped
//      source_removed_at; re-adding the source un-archives the SAME record and
//      clears the stamp;
//   8. America/Chicago boundary: a record dated today reads 'in_process',
//      dated tomorrow reads 'planned';
//   9. reconcile is idempotent: a second run leaves the fixture pig/broiler
//      planner records unchanged (ignoring last_synced_at/sync_run_id/
//      updated_at);
//  10. role gate: the anon (unauthenticated) client cannot call
//      pig_send_to_trip.
//
// PRECONDITIONS: TEST project only (hard PROD guard below); migration 175
// ALREADY APPLIED to TEST (this file assumes 175's columns/backfills exist);
// .env.test/.env.test.local (or the primary worktree's copies) provide
// URL/keys/admin credentials. exec_sql on TEST returns void and REJECTS
// BEGIN/COMMIT — SQL is never wrapped in explicit transactions and everything
// is verified behaviorally via PostgREST/RPC reads. NOTE reconcile touches the
// farm's REAL planner rows too (restamps sync ids; sweeps rows whose sources
// are already gone) — that is the migration's live behavior, not fixture
// damage, and it is not reverted.
//
// EXECUTION IS GATED: applying a migration to TEST is a DB-apply action —
// run this file only with Ronnie's explicit approval in the current turn.
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !serviceKey || !anonKey || !adminEmail || !adminPassword) {
  console.error('missing TEST env (url / service key / anon key / admin credentials)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

function requireSupabase() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'),
    path.join(__dirname, '..', '..', 'WCF-planner', 'node_modules', '@supabase', 'supabase-js'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      /* try next */
    }
  }
  return require('@supabase/supabase-js');
}
const {createClient} = requireSupabase();
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  throw new Error(msg);
}
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

let failures = 0;
const ok = (l) => console.log('  ok   ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};

const mig176 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '176_processing_lifecycle_reconcile.sql'),
  'utf8',
);

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) die(`exec_sql ${label} failed: ` + (error.message || error));
}
async function runReconcile(label) {
  // exec_sql runs as service role (auth.uid() NULL -> role gate skipped);
  // return value is discarded (exec_sql returns void), reads verify behavior.
  await execSql('SELECT public.reconcile_planner_to_processing();', label);
}

// ── farm-timezone dates ───────────────────────────────────────────────────────
function chicagoToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── fixture identifiers ───────────────────────────────────────────────────────
// Group/batch ids are STAMPED so a shared-TEST collision is impossible: the
// restore path filters the fixture ids out of the store baselines, so a fixed
// id like 'g-test'/'bb1' could clobber a real row with that id. Sub-batch and
// trip ids live INSIDE the stamped group object (and their processing_records
// source ids are '<stamped group>:<trip>'), so plain inner ids stay safe.
const S = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const G = 'g-mig176-' + S;
const SB = 'sb1';
const PTA = 'pt-a';
const PTB = 'pt-b';
const BB = 'bb-mig176-' + S;
const CATTLE_ID = 'cpb-mig176-' + S;
const SESSION_ID = 'ws-mig176-' + S;
const WI = ['wi-mig176-a-' + S, 'wi-mig176-b-' + S, 'wi-mig176-c-' + S];
const REC_TODAY = 'prc-mig176-today-' + S;
const REC_TOMORROW = 'prc-mig176-tomorrow-' + S;
const TODAY = chicagoToday();
const D10 = addDays(TODAY, 10);
const D24 = addDays(TODAY, 24);
const D14 = addDays(TODAY, 14);
const DPAST = addDays(TODAY, -30);
const DHATCH = addDays(TODAY, -70);
const TOMORROW = addDays(TODAY, 1);

async function readStore(key) {
  const {data, error} = await service.from('app_store').select('data').eq('key', key).maybeSingle();
  if (error) die(`read app_store ${key}: ` + error.message);
  if (!data) return {existed: false, arr: []};
  return {existed: true, arr: Array.isArray(data.data) ? data.data : []};
}
async function writeStore(key, arr) {
  const {error} = await service.from('app_store').upsert({key, data: arr}, {onConflict: 'key'});
  if (error) die(`write app_store ${key}: ` + error.message);
}
async function readGroup() {
  const {arr} = await readStore('ppp-feeders-v1');
  return arr.find((g) => g && g.id === G) || null;
}
// Read-modify-write one field set on the fixture group (RPCs also write the
// store, so always re-read before mutating).
async function mutateGroup(fn) {
  const {arr} = await readStore('ppp-feeders-v1');
  const idx = arr.findIndex((g) => g && g.id === G);
  if (idx < 0) die('fixture group missing from ppp-feeders-v1');
  arr[idx] = fn(arr[idx]);
  await writeStore('ppp-feeders-v1', arr);
}
async function recBySource(kind, sid, cols) {
  const {data, error} = await service
    .from('processing_records')
    .select(cols || 'id, record_type, status, source_phase, trip_ordinal, title, archived, source_removed_at, lineage')
    .eq('source_kind', kind)
    .eq('source_id', sid)
    .maybeSingle();
  if (error) die(`recBySource ${kind}/${sid}: ` + error.message);
  return data;
}
async function readWeighIns() {
  const {data, error} = await service
    .from('weigh_ins')
    .select('id, weight, sent_to_trip_id, sent_to_group_id')
    .in('id', WI)
    .order('entered_at');
  if (error) die('read weigh_ins: ' + error.message);
  return data || [];
}
const VOLATILE = ['last_synced_at', 'sync_run_id', 'updated_at'];
function stripVolatile(row) {
  const out = {...row};
  for (const k of VOLATILE) delete out[k];
  return out;
}
async function fixtureRecordsCanon() {
  const {data: pig, error: e1} = await service
    .from('processing_records')
    .select('*')
    .eq('source_kind', 'pig')
    .like('source_id', G + ':%')
    .order('id');
  const {data: broiler, error: e2} = await service
    .from('processing_records')
    .select('*')
    .eq('source_kind', 'broiler')
    .eq('source_id', BB)
    .order('id');
  if (e1 || e2) die('fixture records read: ' + (e1 || e2).message);
  return canon([...(pig || []), ...(broiler || [])].map(stripVolatile));
}
async function collectFixtureRecordIds() {
  const {data: pig} = await service
    .from('processing_records')
    .select('id')
    .eq('source_kind', 'pig')
    .like('source_id', G + ':%');
  const {data: broiler} = await service
    .from('processing_records')
    .select('id')
    .eq('source_kind', 'broiler')
    .eq('source_id', BB);
  const {data: cattle} = await service
    .from('processing_records')
    .select('id')
    .eq('source_kind', 'cattle')
    .eq('source_id', CATTLE_ID);
  return [...(pig || []), ...(broiler || []), ...(cattle || [])].map((r) => r.id).concat([REC_TODAY, REC_TOMORROW]);
}
async function deleteFixtureRecords() {
  const ids = await collectFixtureRecordIds();
  if (!ids.length) return;
  await service.from('activity_events').delete().eq('entity_type', 'processing.record').in('entity_id', ids);
  const {error} = await service.from('processing_records').delete().in('id', ids);
  if (error) die('delete fixture records: ' + error.message);
}

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 176_processing_lifecycle_reconcile.sql (${mig176.length} bytes) — stamp ${S}`);
  console.log(`Chicago today=${TODAY} (boundary checks are date-sensitive around midnight America/Chicago)`);

  const {data: adminProfile, error: apErr} = await service
    .from('profiles')
    .select('id, role')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (apErr || !adminProfile || adminProfile.role !== 'admin') {
    console.error('test admin profile missing/not admin: ' + (apErr ? apErr.message : JSON.stringify(adminProfile)));
    process.exit(2);
  }
  const adminId = adminProfile.id;

  // ── snapshots + defensive pre-clean of leftovers from aborted prior runs ───
  // Fixture ids are stamped per run, so the pre-clean/restore filters match on
  // the lane PREFIX: that sweeps any aborted prior run's entries out of the
  // baselines while real TEST data (which can never carry these prefixes) is
  // untouched. The restore baseline never re-plants fixture entries.
  const feeders0 = await readStore('ppp-feeders-v1');
  const v40 = await readStore('ppp-v4');
  const feedersOriginal = {
    existed: feeders0.existed,
    arr: feeders0.arr.filter((g) => !g || !String(g.id || '').startsWith('g-mig176-')),
  };
  const v4Original = {
    existed: v40.existed,
    arr: v40.arr.filter((b) => !b || !String(b.id || '').startsWith('bb-mig176-')),
  };
  await deleteFixtureRecords();
  // Aborted prior runs used different stamps: sweep their planner rows too.
  await service.from('processing_records').delete().eq('source_kind', 'pig').like('source_id', 'g-mig176-%');
  await service.from('processing_records').delete().eq('source_kind', 'broiler').like('source_id', 'bb-mig176-%');
  await service.from('weigh_ins').delete().like('id', 'wi-mig176-%');
  await service.from('weigh_in_sessions').delete().like('id', 'ws-mig176-%');
  await service.from('cattle_processing_batches').delete().like('id', 'cpb-mig176-%');

  try {
    // ── seed the fixture ───────────────────────────────────────────────────────
    await writeStore('ppp-feeders-v1', [
      ...feedersOriginal.arr,
      {
        id: G,
        batchName: 'TestBatch',
        subBatches: [{id: SB, name: 'SB One', giltCount: 10, boarCount: 0, status: 'active'}],
        plannedProcessingTrips: [
          {id: PTA, date: D10, sex: 'gilt', subBatchId: SB, plannedCount: 8, order: 0},
          {id: PTB, date: D24, sex: 'gilt', subBatchId: SB, plannedCount: 2, order: 1},
        ],
        processingTrips: [],
        pigMortalities: [],
      },
    ]);
    await writeStore('ppp-v4', [
      ...v4Original.arr,
      {id: BB, name: 'B-TEST-1', hatchDate: DHATCH, processingDate: DPAST, totalToProcessor: 50},
    ]);
    {
      const {error} = await service.from('cattle_processing_batches').insert({
        id: CATTLE_ID,
        name: 'MIG176 Cattle ' + S,
        planned_process_date: D14,
        cows_detail: [],
      });
      if (error) die('seed cattle batch: ' + error.message);
    }
    {
      const {error} = await service
        .from('weigh_in_sessions')
        .insert({id: SESSION_ID, date: TODAY, species: 'pig', status: 'draft', team_member: 'mig176 proof'});
      if (error) die('seed weigh-in session: ' + error.message);
    }
    {
      const base = Date.now() - 5 * 60_000;
      const {error} = await service.from('weigh_ins').insert(
        [100, 110, 120].map((w, i) => ({
          id: WI[i],
          session_id: SESSION_ID,
          weight: w,
          entered_at: new Date(base + i * 60_000).toISOString(), // deterministic send order 100 110 120
        })),
      );
      if (error) die('seed weigh_ins: ' + error.message);
    }
    ok(`fixture seeded (pig group ${G}, broiler ${BB}, cattle batch, draft pig session + 3 weigh-ins)`);

    // ── APPLY 176 ─────────────────────────────────────────────────────────────
    await execSql(mig176, 'APPLY 176');
    await sleep(2500); // NOTIFY pgrst schema reload before RPC calls
    ok('migration 176 applied');

    const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
    if (signErr) die('admin sign-in failed: ' + signErr.message);

    // ── reconcile #1 ──────────────────────────────────────────────────────────
    await runReconcile('reconcile #1');

    // ── CHECK 1: planned pig trips project planned records with ordinal titles ─
    let idA = null;
    let idB = null;
    {
      const a = await recBySource('pig', `${G}:${PTA}`);
      const b = await recBySource('pig', `${G}:${PTB}`);
      idA = a && a.id;
      idB = b && b.id;
      const okA =
        a &&
        a.record_type === 'planner_batch' &&
        a.source_phase === 'planned' &&
        a.status === 'planned' &&
        a.trip_ordinal === 1 &&
        a.title === 'Pig Trip · TestBatch · Trip 1';
      const okB =
        b &&
        b.record_type === 'planner_batch' &&
        b.source_phase === 'planned' &&
        b.status === 'planned' &&
        b.trip_ordinal === 2 &&
        b.title === 'Pig Trip · TestBatch · Trip 2';
      if (!okA || !okB) bad('CHECK 1 planned pig trip records', {a, b});
      else
        ok("CHECK 1 pt-a/pt-b -> ONE planner record each, source_phase='planned', 'Trip 1'/'Trip 2', status 'planned'");
      const cattleRec = await recBySource('cattle', CATTLE_ID, 'id, record_type');
      if (!cattleRec || cattleRec.record_type !== 'planner_batch')
        bad('CHECK 1 (aux) cattle fixture batch was not projected', cattleRec);
      else ok('CHECK 1 (aux) cattle fixture batch projected to a planner record');
    }

    // ── CHECK 2: broiler fixture effective in_process + live_count via list RPC ─
    {
      const {data: rows, error} = await authed.rpc('list_processing_records', {
        p_year: Number(DPAST.slice(0, 4)),
        p_program: 'broiler',
      });
      if (error) bad('CHECK 2 list RPC errored', error.message);
      else {
        const row = (rows || []).find((r) => r.source_kind === 'broiler' && r.source_id === BB);
        if (!row) bad('CHECK 2 broiler fixture record missing from list', (rows || []).length);
        else if (row.effective_status !== 'in_process' || row.live_count !== 50)
          bad('CHECK 2 broiler fixture wrong effective_status/live_count', row);
        else if (!row.source || row.source.matched !== true || row.source.batch_name !== 'B-TEST-1')
          bad('CHECK 2 broiler fixture live source projection wrong', row.source);
        else
          ok(
            "CHECK 2 broiler fixture keyed by id: effective_status='in_process' (past date), live_count=50, live projection matched",
          );
      }
    }

    // ── CHECK 3: completion blockers on the future planned pig record ─────────
    {
      const {data, error} = await authed.rpc('get_processing_record', {p_id: idA});
      const blockers = (data && data.completion_blockers) || [];
      if (error) bad('CHECK 3 get RPC errored', error.message);
      else if (!blockers.includes('Processing Date has not begun') || !blockers.includes('Processor is required'))
        bad('CHECK 3 blockers missing expected entries', blockers);
      else ok("CHECK 3 blockers include 'Processing Date has not begun' + 'Processor is required'");
    }

    // ── role gate: anon cannot call pig_send_to_trip ──────────────────────────
    {
      const {error} = await anon.rpc('pig_send_to_trip', {
        p_group_id: G,
        p_sub_batch_id: SB,
        p_sex: 'gilt',
        p_weigh_in_ids: WI,
      });
      if (!error) bad('ROLE GATE anon pig_send_to_trip unexpectedly succeeded');
      else ok('ROLE GATE anon client cannot call pig_send_to_trip (' + String(error.message).slice(0, 60) + ')');
    }

    // ── CHECK 4: send 3 weigh-ins — promotion + under-send remainder ─────────
    {
      const {data, error} = await authed.rpc('pig_send_to_trip', {
        p_group_id: G,
        p_sub_batch_id: SB,
        p_sex: 'gilt',
        p_weigh_in_ids: WI,
      });
      if (error) bad('CHECK 4 pig_send_to_trip errored', error.message);
      else {
        const group = await readGroup();
        const actuals = (group && group.processingTrips) || [];
        const planned = (group && group.plannedProcessingTrips) || [];
        const actual = actuals.find((t) => t && t.id === PTA);
        const plannedA = planned.find((t) => t && t.id === PTA);
        const plannedB = planned.find((t) => t && t.id === PTB);
        const wis = await readWeighIns();
        const rec = await recBySource('pig', `${G}:${PTA}`);
        const problems = [];
        if (!actual) problems.push('actual trip pt-a missing (promotion lost the id)');
        else {
          if (actual.pigCount !== 3) problems.push('pigCount ' + actual.pigCount);
          if (actual.liveWeights !== '100 110 120') problems.push('liveWeights ' + JSON.stringify(actual.liveWeights));
        }
        if (actuals.length !== 1) problems.push('expected exactly 1 actual trip, got ' + actuals.length);
        if (plannedA) problems.push('pt-a still in plannedProcessingTrips');
        if (!plannedB || plannedB.plannedCount !== 7)
          problems.push('pt-b plannedCount ' + JSON.stringify(plannedB && plannedB.plannedCount) + ' (want 2+5=7)');
        if (!wis.every((w) => w.sent_to_trip_id === PTA && w.sent_to_group_id === G))
          problems.push('weigh-ins not all stamped with the promoted trip/group ids');
        if (!rec || rec.id !== idA) problems.push('record id changed across promotion');
        else if (rec.source_phase !== 'actual') problems.push('record source_phase ' + rec.source_phase);
        else if (!(rec.lineage || []).some((e) => e && e.event === 'promoted'))
          problems.push("lineage missing 'promoted' entry");
        if (data && data.trip_id !== PTA) problems.push('RPC returned trip_id ' + (data && data.trip_id));
        if (problems.length) bad('CHECK 4 send/promotion', problems.join('; '));
        else
          ok(
            "CHECK 4 pt-a PROMOTED (same id): pigCount 3, weights '100 110 120', same record id now 'actual', remainder 5 -> pt-b=7",
          );
      }
    }

    // ── CHECK 5: undo one — count back to plan, stamp cleared ────────────────
    {
      const {error} = await authed.rpc('pig_undo_send', {p_weigh_in_id: WI[2]});
      if (error) bad('CHECK 5 pig_undo_send errored', error.message);
      else {
        const group = await readGroup();
        const actual = ((group && group.processingTrips) || []).find((t) => t && t.id === PTA);
        const plannedB = ((group && group.plannedProcessingTrips) || []).find((t) => t && t.id === PTB);
        const wis = await readWeighIns();
        const undone = wis.find((w) => w.id === WI[2]);
        const problems = [];
        if (!actual || actual.pigCount !== 2)
          problems.push('pt-a pigCount ' + JSON.stringify(actual && actual.pigCount));
        else if (actual.liveWeights !== '100 110') problems.push('liveWeights ' + JSON.stringify(actual.liveWeights));
        if (!plannedB || plannedB.plannedCount !== 8)
          problems.push('pt-b plannedCount ' + JSON.stringify(plannedB && plannedB.plannedCount));
        if (!undone || undone.sent_to_trip_id !== null || undone.sent_to_group_id !== null)
          problems.push('undone weigh-in stamp not cleared');
        if (problems.length) bad('CHECK 5 undo one', problems.join('; '));
        else ok('CHECK 5 undo: pt-a pigCount=2, weigh-in stamp cleared, pt-b plannedCount=8');
      }
    }

    // ── CHECK 6: undo the rest — emptied actual reverts to planned, SAME id ──
    let savedPlannedA = null; // exact planned pt-a object, re-used in CHECK 7
    {
      const u2 = await authed.rpc('pig_undo_send', {p_weigh_in_id: WI[1]});
      if (u2.error) bad('CHECK 6 second undo errored', u2.error.message);
      const mid = await readGroup();
      const midActual = ((mid && mid.processingTrips) || []).find((t) => t && t.id === PTA);
      const midB = ((mid && mid.plannedProcessingTrips) || []).find((t) => t && t.id === PTB);
      if (!midActual || midActual.pigCount !== 1 || !midB || midB.plannedCount !== 9)
        bad('CHECK 6 intermediate state after second undo', {midActual, midB});
      const u3 = await authed.rpc('pig_undo_send', {p_weigh_in_id: WI[0]});
      if (u3.error) bad('CHECK 6 last undo errored', u3.error.message);
      else {
        const group = await readGroup();
        const actuals = (group && group.processingTrips) || [];
        const planned = (group && group.plannedProcessingTrips) || [];
        const plannedA = planned.find((t) => t && t.id === PTA);
        const plannedB = planned.find((t) => t && t.id === PTB);
        const rec = await recBySource('pig', `${G}:${PTA}`);
        savedPlannedA = plannedA || null;
        const problems = [];
        if (actuals.some((t) => t && t.id === PTA)) problems.push('pt-a still in processingTrips');
        if (!plannedA || plannedA.plannedCount !== 1)
          problems.push('re-created planned pt-a wrong: ' + JSON.stringify(plannedA));
        if (!plannedB || plannedB.plannedCount !== 9)
          problems.push('pt-b plannedCount ' + JSON.stringify(plannedB && plannedB.plannedCount));
        if (!rec || rec.id !== idA) problems.push('record id changed across un-promotion');
        else if (rec.source_phase !== 'planned') problems.push('record source_phase ' + rec.source_phase);
        if (problems.length) bad('CHECK 6 last undo', problems.join('; '));
        else
          ok(
            "CHECK 6 emptied actual pt-a re-created as planned trip with SAME id (plannedCount 1); record flips back to 'planned' (same id)",
          );
      }
    }

    // ── CHECK 7: source-removal sweep (unworked delete / worked archive) ─────
    {
      // 7a. remove pt-b (unworked) -> its record is DELETED.
      await mutateGroup((g) => ({
        ...g,
        plannedProcessingTrips: (g.plannedProcessingTrips || []).filter((t) => t && t.id !== PTB),
      }));
      await runReconcile('reconcile (pt-b removed)');
      const goneB = await recBySource('pig', `${G}:${PTB}`, 'id');
      if (goneB) bad('CHECK 7a unworked pt-b record not deleted', goneB);
      else ok('CHECK 7a source-removed UNWORKED pt-b record was DELETED');

      // 7b. work pt-a (processor), remove it -> ARCHIVED + source_removed_at.
      {
        const {error} = await service.from('processing_records').update({processor: 'MIG176 Processor'}).eq('id', idA);
        if (error) die('set processor on pt-a record: ' + error.message);
      }
      await mutateGroup((g) => ({
        ...g,
        plannedProcessingTrips: (g.plannedProcessingTrips || []).filter((t) => t && t.id !== PTA),
      }));
      await runReconcile('reconcile (pt-a removed)');
      const dormant = await recBySource('pig', `${G}:${PTA}`);
      if (!dormant || dormant.id !== idA || dormant.archived !== true || !dormant.source_removed_at)
        bad('CHECK 7b worked pt-a record not archived+stamped', dormant);
      else ok('CHECK 7b source-removed WORKED pt-a record ARCHIVED with source_removed_at set');

      // 7c. re-add pt-a -> SAME record un-archives, stamp cleared.
      if (!savedPlannedA) savedPlannedA = {id: PTA, date: D10, sex: 'gilt', subBatchId: SB, plannedCount: 1, order: 2};
      await mutateGroup((g) => ({
        ...g,
        plannedProcessingTrips: [...(g.plannedProcessingTrips || []), savedPlannedA],
      }));
      await runReconcile('reconcile (pt-a restored)');
      const restored = await recBySource('pig', `${G}:${PTA}`);
      if (
        !restored ||
        restored.id !== idA ||
        restored.archived !== false ||
        restored.source_removed_at !== null ||
        !(restored.lineage || []).some((e) => e && e.event === 'restored')
      )
        bad('CHECK 7c restored pt-a record wrong', restored);
      else
        ok(
          'CHECK 7c re-added source un-archived the SAME record, cleared source_removed_at, appended restored lineage',
        );
    }

    // ── CHECK 8: America/Chicago effective-status boundary ───────────────────
    {
      const {error: insErr} = await service.from('processing_records').insert([
        {
          id: REC_TODAY,
          record_type: 'asana_historical',
          program: 'broiler',
          title: 'MIG176 boundary today',
          processing_date: TODAY,
          status: 'planned',
          match_status: 'unmatched',
          created_by: adminId,
        },
        {
          id: REC_TOMORROW,
          record_type: 'asana_historical',
          program: 'broiler',
          title: 'MIG176 boundary tomorrow',
          processing_date: TOMORROW,
          status: 'planned',
          match_status: 'unmatched',
          created_by: adminId,
        },
      ]);
      if (insErr) bad('CHECK 8 seed boundary records', insErr.message);
      else {
        const t1 = await authed.rpc('get_processing_record', {p_id: REC_TODAY});
        const t2 = await authed.rpc('get_processing_record', {p_id: REC_TOMORROW});
        const e1 = t1.data && t1.data.record && t1.data.record.effective_status;
        const e2 = t2.data && t2.data.record && t2.data.record.effective_status;
        if (t1.error || t2.error) bad('CHECK 8 get RPC errored', (t1.error || t2.error).message);
        else if (e1 !== 'in_process' || e2 !== 'planned')
          bad('CHECK 8 boundary statuses wrong', {today: e1, tomorrow: e2});
        else ok("CHECK 8 Chicago boundary: today -> 'in_process', tomorrow -> 'planned'");
      }
    }

    // ── CHECK 9: reconcile idempotence on fixture records ────────────────────
    {
      await runReconcile('reconcile (idempotence run 1)');
      const before = await fixtureRecordsCanon();
      await runReconcile('reconcile (idempotence run 2)');
      const after = await fixtureRecordsCanon();
      if (before !== after) bad('CHECK 9 second reconcile changed fixture planner records');
      else ok('CHECK 9 reconcile idempotent (fixture pig/broiler records unchanged, volatile sync fields ignored)');
    }
  } catch (e) {
    bad('unexpected failure', e.message || e);
  } finally {
    // ── restore the EXACT pre-run fixture state ───────────────────────────────
    const restoreErrors = [];
    try {
      await authed.auth.signOut();
    } catch (e) {
      restoreErrors.push('sign-out: ' + (e.message || e));
    }
    try {
      await deleteFixtureRecords();
    } catch (e) {
      restoreErrors.push('delete fixture records: ' + (e.message || e));
    }
    try {
      if (feedersOriginal.existed) await writeStore('ppp-feeders-v1', feedersOriginal.arr);
      else await service.from('app_store').delete().eq('key', 'ppp-feeders-v1');
    } catch (e) {
      restoreErrors.push('restore ppp-feeders-v1: ' + (e.message || e));
    }
    try {
      if (v4Original.existed) await writeStore('ppp-v4', v4Original.arr);
      else await service.from('app_store').delete().eq('key', 'ppp-v4');
    } catch (e) {
      restoreErrors.push('restore ppp-v4: ' + (e.message || e));
    }
    {
      const {error} = await service.from('weigh_ins').delete().in('id', WI);
      if (error) restoreErrors.push('delete weigh_ins: ' + error.message);
    }
    {
      const {error} = await service.from('weigh_in_sessions').delete().eq('id', SESSION_ID);
      if (error) restoreErrors.push('delete weigh-in session: ' + error.message);
    }
    {
      const {error} = await service.from('cattle_processing_batches').delete().eq('id', CATTLE_ID);
      if (error) restoreErrors.push('delete cattle batch: ' + error.message);
    }
    // Verify the fixture restore.
    try {
      const feedersNow = await readStore('ppp-feeders-v1');
      const v4Now = await readStore('ppp-v4');
      if (feedersOriginal.existed && canon(feedersNow.arr) !== canon(feedersOriginal.arr))
        restoreErrors.push('ppp-feeders-v1 does not match pre-run value');
      if (v4Original.existed && canon(v4Now.arr) !== canon(v4Original.arr))
        restoreErrors.push('ppp-v4 does not match pre-run value');
      const leftovers = await collectFixtureRecordIds();
      const {data: still} = await service
        .from('processing_records')
        .select('id')
        .in('id', leftovers.length ? leftovers : ['-none-']);
      if ((still || []).length) restoreErrors.push('fixture records still present: ' + JSON.stringify(still));
    } catch (e) {
      restoreErrors.push('restore verification: ' + (e.message || e));
    }
    if (restoreErrors.length) {
      failures++;
      console.error('RESTORE PROBLEMS:\n- ' + restoreErrors.join('\n- '));
      console.error('pre-run ppp-feeders-v1 for manual recovery: ' + JSON.stringify(feedersOriginal));
      console.error('pre-run ppp-v4 for manual recovery: ' + JSON.stringify(v4Original));
    } else {
      console.log('restore ok — fixtures removed, stores back to the pre-run baseline');
    }
  }

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
