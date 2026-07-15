// Apply mig 178 (legacy Pig liveWeights parser + canonical current-title
// contract) to TEST via exec_sql and prove BOTH repaired contracts through
// the REAL RPCs (authed admin client):
//
// PARSER (get_processing_record animals):
//   1. the PROD crash shape "315, 305, 280, 280, 275" returns five ordered
//      weights, weigh_in_id null on every entry;
//   2. space-separated "100 110 120" still works (backward compatibility);
//   3. mixed commas + spaces + tabs + newlines parse in source order;
//   4. decimal positive weights survive exactly (250.5, 260.25);
//   5. malformed / empty / zero / negative tokens are EXCLUDED without
//      crashing ('abc, 0, -5, , 315, 12lbs' -> [315]);
//   6. a fully malformed legacy string returns an EMPTY animals array and the
//      record still loads (UI shows "No live weights recorded");
//   7. linked weigh-ins remain AUTHORITATIVE over legacy liveWeights;
//   8. an unaffected non-Pig (cattle) Processing record still loads.
//
// CANONICAL TITLE (every fixture record is direct-inserted with a stored
// title of 'STALE …' so a canonical read is unmistakable):
//   9-12. for EACH program (broiler / cattle / sheep / pig), list_ and
//      get_processing_record return the CURRENT source name as title, and
//      after renaming ONLY the authoritative source (no record recreation,
//      no reconcile) they return the NEW name — pig as
//      'Pig Trip · <new batch name> · Trip <same ordinal>' — with unchanged
//      record ids;
//   13. reads never mutate the record: stored titles remain 'STALE …' and
//      processor/customer/status/subtasks stay untouched until reconcile;
//   14. list_my_processing_subtasks returns the renamed record's NEW title;
//   15. list search_text finds the NEW name;
//   16. milestone and historical/import-only titles remain the stored ones;
//   17. a planner record whose source is MISSING keeps its stored title;
//   18. reconcile runs twice: run 1 refreshes STORED titles to the current
//      names (the preserved reconcile behavior), run 2 changes nothing
//      (idempotent — no duplicate records, no template reseeding).
//
// Fixture records are inserted DIRECTLY (service role) with stamped ids so
// checks 9-17 need no reconcile. CHECK 18 then runs the REAL reconcile via
// exec_sql — NOTE reconcile touches the farm's real TEST planner rows too
// (restamps sync ids; sweeps planner rows whose sources are already gone).
// That is the migration's live behavior, not fixture damage, and it is not
// reverted. The missing-source fixture is deleted before reconcile because
// the sweep would legitimately remove it.
//
// PRECONDITIONS: TEST project only (hard PROD guard below); migrations 175
// through 177 ALREADY APPLIED to TEST. .env.test/.env.test.local (or the
// primary worktree's copies) provide URL/keys/admin credentials. exec_sql on
// TEST returns void and REJECTS BEGIN/COMMIT — SQL is never wrapped in
// explicit transactions and everything is verified behaviorally via
// PostgREST/RPC reads.
//
// EXECUTION IS GATED: applying a migration to TEST is a DB-apply action —
// run this file only with Ronnie's explicit approval in the current turn and
// only with exclusive TEST access (no concurrent CC lane using TEST).
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

const mig178 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '178_processing_legacy_liveweights.sql'),
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

// ── fixture identifiers ───────────────────────────────────────────────────────
// Group/batch ids are STAMPED so a shared-TEST collision is impossible; trip
// ids live INSIDE the stamped group object (their record source ids are
// '<stamped group>:<trip>'), so plain inner ids stay safe.
const S = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const G = 'g-mig178-' + S;
const BB = 'bb-mig178-' + S;
const CATTLE_ID = 'cpb-mig178-' + S;
const SHEEP_ID = 'spb-mig178-' + S;
const SESSION_ID = 'ws-mig178-' + S;
const WI = ['wi-mig178-a-' + S, 'wi-mig178-b-' + S];
const SUBTASK_ID = 'pst-mig178-' + S;
const DPAST = '2026-05-01';
const YEAR = Number(DPAST.slice(0, 4));

// Source names before/after the rename-only step.
const NAMES = {
  broiler: {old: 'B-M178-OLD', new: 'B-M178-NEW'},
  cattle: {old: 'MIG178 Cattle OLD', new: 'MIG178 Cattle NEW'},
  sheep: {old: 'S-M178-OLD', new: 'L-M178-NEW'}, // mirrors the PROD S-26-01 -> L-26-01 symptom
  pig: {old: 'Mig178Batch', new: 'Mig178Renamed'},
};

// Pig trips: parser cases (t1-t7, ordinals 1-7). t1 doubles as the pig title
// fixture (ordinal 1 must survive the rename).
const TRIPS = [
  {id: 't1', ord: 1, lw: '315, 305, 280, 280, 275', expect: [315, 305, 280, 280, 275], label: 'PROD comma+space shape'},
  {id: 't2', ord: 2, lw: '100 110 120', expect: [100, 110, 120], label: 'space-separated (backward compat)'},
  {id: 't3', ord: 3, lw: '90,\t95\n100,  105', expect: [90, 95, 100, 105], label: 'mixed commas/tabs/newlines/spaces'},
  {id: 't4', ord: 4, lw: '250.5, 260.25', expect: [250.5, 260.25], label: 'decimal positives'},
  {id: 't5', ord: 5, lw: 'abc, 0, -5, , 315, 12lbs', expect: [315], label: 'malformed/zero/negative excluded'},
  {id: 't6', ord: 6, lw: 'abc, xyz, --', expect: [], label: 'fully malformed -> empty animals, record loads'},
  {id: 't7', ord: 7, lw: '999, 888', expect: [200, 210], label: 'linked weigh-ins stay authoritative'},
];
const recId = (tripId) => `prc-mig178-${tripId}-${S}`;
const BROILER_REC = 'prc-mig178-broiler-' + S;
const CATTLE_REC = 'prc-mig178-cattle-' + S;
const SHEEP_REC = 'prc-mig178-sheep-' + S;
const MILESTONE_REC = 'prc-mig178-milestone-' + S;
const HIST_REC = 'prc-mig178-hist-' + S;
const MISSING_REC = 'prc-mig178-missing-' + S;
const ALL_REC_IDS = () =>
  TRIPS.map((t) => recId(t.id)).concat([BROILER_REC, CATTLE_REC, SHEEP_REC, MILESTONE_REC, HIST_REC, MISSING_REC]);

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
async function mutateStoreEntry(key, entryId, fn) {
  const {arr} = await readStore(key);
  const idx = arr.findIndex((x) => x && x.id === entryId);
  if (idx < 0) die(`fixture entry ${entryId} missing from ${key}`);
  arr[idx] = fn(arr[idx]);
  await writeStore(key, arr);
}
async function deleteFixtureRecords() {
  const ids = ALL_REC_IDS();
  await service.from('activity_events').delete().eq('entity_type', 'processing.record').in('entity_id', ids);
  await service.from('processing_subtasks').delete().in('record_id', ids);
  const {error} = await service.from('processing_records').delete().in('id', ids);
  if (error) die('delete fixture records: ' + error.message);
}
async function getRecord(id) {
  const {data, error} = await authed.rpc('get_processing_record', {p_id: id});
  return {data, error};
}
async function listRows(program) {
  const {data, error} = await authed.rpc('list_processing_records', {p_year: YEAR, p_program: program});
  if (error) die(`list_processing_records(${program}): ` + error.message);
  return Array.isArray(data) ? data : [];
}
function animalWeights(data) {
  const animals = (data && data.record && data.record.animals) || null;
  if (!Array.isArray(animals)) return null;
  return animals.map((a) => a && a.live_weight);
}
async function rawRecord(id, cols) {
  const {data, error} = await service
    .from('processing_records')
    .select(cols || 'id, title, status, processor, customer, source_kind, source_id, trip_ordinal')
    .eq('id', id)
    .maybeSingle();
  if (error) die(`raw record ${id}: ` + error.message);
  return data;
}
// One canonical-title check through BOTH read RPCs.
async function expectTitle(label, id, program, wantTitle) {
  const {data, error} = await getRecord(id);
  if (error) return bad(`${label} get RPC errored`, error.message);
  const got = data && data.record && data.record.title;
  if (got !== wantTitle) return bad(`${label} get title`, {got, want: wantTitle});
  const row = (await listRows(program)).find((r) => r.id === id);
  if (!row) return bad(`${label} list row missing`, id);
  if (row.title !== wantTitle) return bad(`${label} list title`, {got: row.title, want: wantTitle});
  ok(`${label}: list + get title = ${JSON.stringify(wantTitle)}`);
}

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 178_processing_legacy_liveweights.sql (${mig178.length} bytes) — stamp ${S}`);

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

  // ── snapshots + defensive pre-clean of leftovers from aborted prior runs ────
  // The restore baselines filter the lane prefixes out so an aborted prior
  // run's fixtures can never be re-planted; real TEST data never carries them.
  const feeders0 = await readStore('ppp-feeders-v1');
  const v40 = await readStore('ppp-v4');
  const feedersOriginal = {
    existed: feeders0.existed,
    arr: feeders0.arr.filter((g) => !g || !String(g.id || '').startsWith('g-mig178-')),
  };
  const v4Original = {
    existed: v40.existed,
    arr: v40.arr.filter((b) => !b || !String(b.id || '').startsWith('bb-mig178-')),
  };
  await service.from('processing_subtasks').delete().like('id', 'pst-mig178-%');
  await service.from('processing_records').delete().like('id', 'prc-mig178-%');
  await service.from('processing_records').delete().eq('source_kind', 'pig').like('source_id', 'g-mig178-%');
  await service.from('processing_records').delete().eq('source_kind', 'broiler').like('source_id', 'bb-mig178-%');
  await service.from('processing_records').delete().eq('source_kind', 'cattle').like('source_id', 'cpb-mig178-%');
  await service.from('processing_records').delete().eq('source_kind', 'sheep').like('source_id', 'spb-mig178-%');
  await service.from('weigh_ins').delete().like('id', 'wi-mig178-%');
  await service.from('weigh_in_sessions').delete().like('id', 'ws-mig178-%');
  await service.from('cattle_processing_batches').delete().like('id', 'cpb-mig178-%');
  await service.from('sheep_processing_batches').delete().like('id', 'spb-mig178-%');

  try {
    // ── seed the fixture ──────────────────────────────────────────────────────
    await writeStore('ppp-feeders-v1', [
      ...feedersOriginal.arr,
      {
        id: G,
        batchName: NAMES.pig.old,
        subBatches: [{id: 'sb1', name: 'SB One', giltCount: 30, boarCount: 0, status: 'active'}],
        plannedProcessingTrips: [],
        processingTrips: TRIPS.map((t) => ({
          id: t.id,
          date: DPAST,
          pigCount: 5,
          liveWeights: t.lw,
          hangingWeight: 0,
          notes: '',
        })),
        pigMortalities: [],
      },
    ]);
    await writeStore('ppp-v4', [
      ...v4Original.arr,
      {id: BB, name: NAMES.broiler.old, hatchDate: '2026-02-01', processingDate: DPAST, totalToProcessor: 25},
    ]);
    {
      const {error} = await service.from('cattle_processing_batches').insert({
        id: CATTLE_ID,
        name: NAMES.cattle.old,
        planned_process_date: DPAST,
        cows_detail: [],
      });
      if (error) die('seed cattle batch: ' + error.message);
    }
    {
      const {error} = await service.from('sheep_processing_batches').insert({
        id: SHEEP_ID,
        name: NAMES.sheep.old,
        planned_process_date: DPAST,
        sheep_detail: [],
      });
      if (error) die('seed sheep batch: ' + error.message);
    }
    {
      const {error} = await service
        .from('weigh_in_sessions')
        .insert({id: SESSION_ID, date: DPAST, species: 'pig', status: 'draft', team_member: 'mig178 proof'});
      if (error) die('seed weigh-in session: ' + error.message);
    }
    {
      const base = Date.parse('2026-05-01T12:00:00Z');
      const {error} = await service.from('weigh_ins').insert(
        [200, 210].map((w, i) => ({
          id: WI[i],
          session_id: SESSION_ID,
          weight: w,
          entered_at: new Date(base + i * 60_000).toISOString(), // deterministic order 200 210
          sent_to_trip_id: 't7',
          sent_to_group_id: G,
        })),
      );
      if (error) die('seed linked weigh_ins: ' + error.message);
    }
    {
      // Every planner-backed fixture record stores an obviously STALE title so
      // a canonical (live-derived) read is unmistakable.
      const base = {
        record_type: 'planner_batch',
        processing_date: DPAST,
        status: 'planned',
        match_status: 'native',
        created_by: adminId,
      };
      const rows = TRIPS.map((t) => ({
        ...base,
        id: recId(t.id),
        program: 'pig',
        title: `STALE pig ${t.id}`,
        source_kind: 'pig',
        source_id: `${G}:${t.id}`,
        source_phase: 'actual',
        trip_ordinal: t.ord,
      }));
      rows.push({
        ...base,
        id: BROILER_REC,
        program: 'broiler',
        title: 'STALE broiler',
        source_kind: 'broiler',
        source_id: BB,
      });
      rows.push({
        ...base,
        id: CATTLE_REC,
        program: 'cattle',
        title: 'STALE cattle',
        source_kind: 'cattle',
        source_id: CATTLE_ID,
      });
      rows.push({
        ...base,
        id: SHEEP_REC,
        program: 'sheep',
        title: 'STALE sheep',
        source_kind: 'sheep',
        source_id: SHEEP_ID,
      });
      rows.push({
        ...base,
        id: MISSING_REC,
        program: 'cattle',
        title: 'MIG178 Missing Source',
        source_kind: 'cattle',
        source_id: 'cpb-mig178-missing-' + S,
      });
      rows.push({
        id: MILESTONE_REC,
        record_type: 'milestone',
        program: 'broiler',
        title: 'MIG178 Milestone',
        processing_date: DPAST,
        status: 'planned',
        match_status: 'native',
        created_by: adminId,
      });
      rows.push({
        id: HIST_REC,
        record_type: 'asana_historical',
        program: 'broiler',
        title: 'MIG178 Historical',
        processing_date: DPAST,
        status: 'planned',
        match_status: 'unmatched',
        created_by: adminId,
      });
      const {error} = await service.from('processing_records').insert(rows);
      if (error) die('seed processing records: ' + error.message);
    }
    {
      // My-Tasks fixture: an open subtask on the cattle record, assigned to
      // the proof admin (list_my_processing_subtasks reads own assignments).
      const {error} = await service.from('processing_subtasks').insert({
        id: SUBTASK_ID,
        record_id: CATTLE_REC,
        label: 'MIG178 my-tasks probe',
        assignee_profile_id: adminId,
        done: false,
        sort_order: 1,
        created_by: adminId,
      });
      if (error) die('seed subtask: ' + error.message);
    }
    ok(
      `fixture seeded (pig group ${G}: 7 actual trips; broiler/cattle/sheep sources + STALE-titled records; milestone/historical/missing; subtask; 2 linked weigh-ins)`,
    );

    const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
    if (signErr) die('admin sign-in failed: ' + signErr.message);

    // ── pre-apply repro (informational only — a rerun after apply loads fine) ─
    {
      const {error} = await getRecord(recId('t1'));
      if (error && /invalid input syntax/.test(error.message || ''))
        console.log('  info pre-apply: t1 record read crashes with the numeric-cast defect (repro confirmed)');
      else if (error) console.log('  info pre-apply: t1 read errored differently: ' + error.message);
      else console.log('  info pre-apply: t1 already loads (mig 178 already applied to TEST — rerun)');
    }

    // ── APPLY 178 ─────────────────────────────────────────────────────────────
    await execSql(mig178, 'APPLY 178');
    await sleep(2500); // NOTIFY pgrst schema reload before RPC calls
    ok('migration 178 applied');

    // ── PARSER CHECKS 1-7: each pig trip through the real get RPC ────────────
    for (let i = 0; i < TRIPS.length; i++) {
      const t = TRIPS[i];
      const n = i + 1;
      const {data, error} = await getRecord(recId(t.id));
      if (error) {
        bad(`CHECK ${n} (${t.label}) get RPC errored`, error.message);
        continue;
      }
      const weights = animalWeights(data);
      if (!weights) {
        bad(`CHECK ${n} (${t.label}) missing animals array`, data && data.record && typeof data.record);
        continue;
      }
      if (canon(weights) !== canon(t.expect)) {
        bad(`CHECK ${n} (${t.label}) wrong weights`, {got: weights, want: t.expect});
        continue;
      }
      const animals = data.record.animals;
      if (t.id === 't7') {
        const idsOk = animals.length === 2 && animals[0].weigh_in_id === WI[0] && animals[1].weigh_in_id === WI[1];
        if (!idsOk) {
          bad(`CHECK ${n} (${t.label}) weigh_in_id linkage wrong`, animals);
          continue;
        }
      } else if (!animals.every((a) => a.weigh_in_id === null)) {
        bad(`CHECK ${n} (${t.label}) legacy entries must have null weigh_in_id`, animals);
        continue;
      }
      ok(`CHECK ${n} ${t.label}: ${JSON.stringify(t.lw)} -> [${weights.join(', ')}]`);
    }

    // ── CHECK 8: unaffected non-Pig (cattle) record still loads ───────────────
    {
      const {data, error} = await getRecord(CATTLE_REC);
      if (error) bad('CHECK 8 cattle get RPC errored', error.message);
      else if (!data || !data.record || !Array.isArray(data.record.animals))
        bad('CHECK 8 cattle record/animals shape wrong', data && typeof data);
      else ok('CHECK 8 non-Pig cattle record loads; animals = ' + JSON.stringify(data.record.animals));
    }

    // ── TITLE CHECKS 9-12: canonical now; rename ONLY the source; read again ──
    await expectTitle('CHECK 9a broiler canonical (stored title is STALE)', BROILER_REC, 'broiler', NAMES.broiler.old);
    await mutateStoreEntry('ppp-v4', BB, (b) => ({...b, name: NAMES.broiler.new}));
    await expectTitle('CHECK 9b broiler renamed source', BROILER_REC, 'broiler', NAMES.broiler.new);

    await expectTitle('CHECK 10a cattle canonical (stored title is STALE)', CATTLE_REC, 'cattle', NAMES.cattle.old);
    {
      const {error} = await service
        .from('cattle_processing_batches')
        .update({name: NAMES.cattle.new})
        .eq('id', CATTLE_ID);
      if (error) die('rename cattle batch: ' + error.message);
    }
    await expectTitle('CHECK 10b cattle renamed source', CATTLE_REC, 'cattle', NAMES.cattle.new);

    await expectTitle('CHECK 11a sheep canonical (stored title is STALE)', SHEEP_REC, 'sheep', NAMES.sheep.old);
    {
      const {error} = await service.from('sheep_processing_batches').update({name: NAMES.sheep.new}).eq('id', SHEEP_ID);
      if (error) die('rename sheep batch: ' + error.message);
    }
    await expectTitle(
      'CHECK 11b sheep renamed source (the PROD S-26-01 -> L-26-01 shape)',
      SHEEP_REC,
      'sheep',
      NAMES.sheep.new,
    );

    await expectTitle(
      'CHECK 12a pig canonical (ordinal 1)',
      recId('t1'),
      'pig',
      `Pig Trip · ${NAMES.pig.old} · Trip 1`,
    );
    await mutateStoreEntry('ppp-feeders-v1', G, (g) => ({...g, batchName: NAMES.pig.new}));
    await expectTitle(
      'CHECK 12b pig renamed batch (same ordinal)',
      recId('t1'),
      'pig',
      `Pig Trip · ${NAMES.pig.new} · Trip 1`,
    );

    // ── CHECK 13: reads never mutated the records (ids + stored fields) ───────
    {
      const probes = [
        {id: BROILER_REC, title: 'STALE broiler'},
        {id: CATTLE_REC, title: 'STALE cattle'},
        {id: SHEEP_REC, title: 'STALE sheep'},
        {id: recId('t1'), title: 'STALE pig t1'},
      ];
      const problems = [];
      for (const p of probes) {
        const row = await rawRecord(p.id);
        if (!row) problems.push(`${p.id} vanished`);
        else {
          if (row.title !== p.title) problems.push(`${p.id} stored title mutated to ${JSON.stringify(row.title)}`);
          if (row.status !== 'planned') problems.push(`${p.id} status ${row.status}`);
          if (row.processor !== null) problems.push(`${p.id} processor ${row.processor}`);
        }
      }
      const {data: subs} = await service.from('processing_subtasks').select('id').eq('record_id', CATTLE_REC);
      if ((subs || []).length !== 1) problems.push(`cattle record subtask count ${(subs || []).length} (want 1)`);
      if (problems.length) bad('CHECK 13 reads mutated records', problems.join('; '));
      else
        ok(
          'CHECK 13 canonical reads mutate nothing: stored titles still STALE, status/processor/subtasks untouched, same ids',
        );
    }

    // ── CHECK 14: My Processing Tasks returns the renamed record title ────────
    {
      const {data, error} = await authed.rpc('list_my_processing_subtasks');
      if (error) bad('CHECK 14 list_my_processing_subtasks errored', error.message);
      else {
        const row = (Array.isArray(data) ? data : []).find((r) => r.subtask_id === SUBTASK_ID);
        if (!row) bad('CHECK 14 fixture subtask missing from My Tasks', (data || []).length);
        else if (row.record_title !== NAMES.cattle.new)
          bad('CHECK 14 My Tasks record_title', {got: row.record_title, want: NAMES.cattle.new});
        else ok(`CHECK 14 My Tasks record_title = ${JSON.stringify(NAMES.cattle.new)}`);
      }
    }

    // ── CHECK 15: search_text finds the NEW name ──────────────────────────────
    {
      const row = (await listRows('cattle')).find((r) => r.id === CATTLE_REC);
      if (!row || typeof row.search_text !== 'string') bad('CHECK 15 cattle list row/search_text missing');
      else if (!row.search_text.includes(NAMES.cattle.new.toLowerCase()))
        bad('CHECK 15 search_text lacks the new name', row.search_text);
      else ok('CHECK 15 search_text contains the renamed source name');
    }

    // ── CHECK 16: milestone + historical titles stay stored ───────────────────
    {
      const m = await getRecord(MILESTONE_REC);
      const h = await getRecord(HIST_REC);
      const mTitle = m.data && m.data.record && m.data.record.title;
      const hTitle = h.data && h.data.record && h.data.record.title;
      if (m.error || h.error) bad('CHECK 16 get errored', (m.error || h.error).message);
      else if (mTitle !== 'MIG178 Milestone' || hTitle !== 'MIG178 Historical')
        bad('CHECK 16 stored titles', {milestone: mTitle, historical: hTitle});
      else ok('CHECK 16 milestone + historical/import-only titles remain the stored Processing titles');
    }

    // ── CHECK 17: missing source keeps the stored title ───────────────────────
    {
      const {data, error} = await getRecord(MISSING_REC);
      const title = data && data.record && data.record.title;
      if (error) bad('CHECK 17 get errored', error.message);
      else if (title !== 'MIG178 Missing Source') bad('CHECK 17 missing-source fallback', title);
      else ok('CHECK 17 missing-source planner record keeps its stored title');
      // The sweep would legitimately remove this source-less fixture — take it
      // out ourselves before the reconcile checks.
      await service.from('processing_records').delete().eq('id', MISSING_REC);
    }

    // ── CHECK 18: reconcile refreshes stored titles once, then is idempotent ──
    {
      await runReconcile('reconcile #1');
      const afterRun1 = [];
      for (const id of [BROILER_REC, CATTLE_REC, SHEEP_REC, recId('t1')]) {
        afterRun1.push(await rawRecord(id, '*'));
      }
      const titles1 = afterRun1.map((r) => r && r.title);
      const wantTitles = [NAMES.broiler.new, NAMES.cattle.new, NAMES.sheep.new, `Pig Trip · ${NAMES.pig.new} · Trip 1`];
      if (canon(titles1) !== canon(wantTitles))
        bad('CHECK 18a reconcile run 1 stored-title refresh', {got: titles1, want: wantTitles});
      else ok('CHECK 18a reconcile run 1 refreshed STORED titles to the current names (preserved behavior)');

      await runReconcile('reconcile #2');
      const VOLATILE = ['last_synced_at', 'sync_run_id', 'updated_at'];
      const strip = (r) => {
        const out = {...r};
        for (const k of VOLATILE) delete out[k];
        return out;
      };
      const afterRun2 = [];
      for (const id of [BROILER_REC, CATTLE_REC, SHEEP_REC, recId('t1')]) {
        afterRun2.push(await rawRecord(id, '*'));
      }
      const problems = [];
      if (canon(afterRun1.map(strip)) !== canon(afterRun2.map(strip)))
        problems.push('second reconcile changed fixture records');
      // No duplicate records per fixture source, no template reseeding.
      for (const [kind, sid] of [
        ['broiler', BB],
        ['cattle', CATTLE_ID],
        ['sheep', SHEEP_ID],
        ['pig', `${G}:t1`],
      ]) {
        const {data: rows} = await service
          .from('processing_records')
          .select('id')
          .eq('source_kind', kind)
          .eq('source_id', sid);
        if ((rows || []).length !== 1) problems.push(`${kind}/${sid} record count ${(rows || []).length}`);
      }
      const {data: subs} = await service.from('processing_subtasks').select('id').eq('record_id', CATTLE_REC);
      if ((subs || []).length !== 1)
        problems.push(`cattle subtask count ${(subs || []).length} after reconcile (reseeded?)`);
      if (problems.length) bad('CHECK 18b reconcile idempotence', problems.join('; '));
      else ok('CHECK 18b reconcile run 2 idempotent: no field drift, one record per source, no template reseeding');
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
    {
      const {error} = await service.from('sheep_processing_batches').delete().eq('id', SHEEP_ID);
      if (error) restoreErrors.push('delete sheep batch: ' + error.message);
    }
    // Verify the fixture restore.
    try {
      const feedersNow = await readStore('ppp-feeders-v1');
      const v4Now = await readStore('ppp-v4');
      if (feedersOriginal.existed && canon(feedersNow.arr) !== canon(feedersOriginal.arr))
        restoreErrors.push('ppp-feeders-v1 does not match pre-run value');
      if (v4Original.existed && canon(v4Now.arr) !== canon(v4Original.arr))
        restoreErrors.push('ppp-v4 does not match pre-run value');
      const ids = ALL_REC_IDS();
      const {data: still} = await service.from('processing_records').select('id').in('id', ids);
      if ((still || []).length) restoreErrors.push('fixture records still present: ' + JSON.stringify(still));
      const {data: stillSub} = await service.from('processing_subtasks').select('id').eq('id', SUBTASK_ID);
      if ((stillSub || []).length) restoreErrors.push('fixture subtask still present');
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
