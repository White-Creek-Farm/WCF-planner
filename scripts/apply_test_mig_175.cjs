// Apply mig 175 (processing planner foundation) to TEST via exec_sql and prove
// the gated contract:
//   1. broiler identity rekey: a planner row keyed by a ppp-v4 batch NAME is
//      rekeyed to the immutable batch id; the record id and its subtasks
//      survive; no row remains keyed by the old name;
//   2. an existing pig planner row (composite groupId:tripId source_id, no
//      source_phase) backfills source_phase='actual' and trip_ordinal=1;
//   3. every ACTIVE template checklist step gains a stable, non-blank, unique
//      'stp-*' id (in place; inactive history untouched);
//   4. a subtask whose label CASE-INSENSITIVELY matches an active-template
//      step label is backfilled with that step's new template_step_id;
//   5. legacy plain-string processor/customer option lists convert to
//      [{id,label,active:true}] objects preserving order and labels;
//   6. the new caller-scoped list_my_processing_subtasks() RPC is live for the
//      authed admin and surfaces an open subtask assigned to them;
//   7. FAIL CLOSED: a broiler planner row whose source_id resolves to NO batch
//      makes a (re)apply raise and roll back atomically — nothing changes;
//   8. reapplication on migrated data is a byte-for-byte no-op (idempotent).
//
// PRECONDITIONS: TEST project only (hard PROD guard below); migrations through
// 174 already applied; .env.test/.env.test.local (or the primary worktree's
// copies) provide URL/keys/admin credentials. exec_sql on TEST returns void
// and REJECTS BEGIN/COMMIT — this script never wraps SQL in transactions and
// verifies everything behaviorally via PostgREST/RPC reads afterward.
//
// EXECUTION IS GATED: applying a migration to TEST is a DB-apply action —
// run this file only with Ronnie's explicit approval in the current turn.
//
// Restore strategy (finally): every seeded fixture (records + subtasks,
// ppp-v4 additions, settings option lists, the seeded broiler template) is
// restored to its EXACT pre-run value, then the idempotent migration is
// re-applied ONCE more so the farm's REAL data (the real active broiler
// template's step ids, the real option lists, real subtask links) ends in the
// migrated state a clean single apply would have produced. NOTE the migration
// intentionally mutates real TEST rows (rekey, phase/ordinal backfill, step-id
// minting); those effects are the point of the apply and are not reverted.
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
// Fresh worktrees intentionally do not copy ignored secrets: fall back to the
// primary worktree's standard TEST env files without copying/printing them.
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
// Canonical (key-sorted) stringify — Postgres jsonb reorders object keys.
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

const mig175 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '175_processing_planner_foundation.sql'),
  'utf8',
);

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) die(`exec_sql ${label} failed: ` + (error.message || error));
}
async function execSqlExpectError(sql, label, needle) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (!error) die(`exec_sql ${label}: expected a raise, got success`);
  const msg = String(error.message || error);
  if (!msg.includes(needle)) die(`exec_sql ${label}: wrong error: ${msg}`);
  return msg;
}

// ── fixture identifiers ───────────────────────────────────────────────────────
const S = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const BATCH1 = {
  id: 'bb-mig175-one-' + S,
  name: 'MIG175-B1-' + S,
  hatchDate: '2026-05-01',
  processingDate: '2026-07-01',
  totalToProcessor: 40,
};
const BATCH2 = {
  id: 'bb-mig175-two-' + S,
  name: 'MIG175-B2-' + S,
  hatchDate: '2026-05-15',
  processingDate: '2026-07-20',
  totalToProcessor: 55,
};
const REC_BROILER = 'prc-mig175-broiler-' + S;
const REC_PIG = 'prc-mig175-pig-' + S;
const REC_BAD = 'prc-mig175-bad-' + S;
// Stamped group id (spec sketch used 'g1:t1'; a stamped id proves the same
// backfill without colliding with real TEST pig groups on the shared DB).
const PIG_SOURCE = `mig175g-${S}:t1`;
const TPL_ID = 'ptpl-mig175-' + S;
const STEP1_LABEL = 'Mig175 Step One ' + S;
const STEP2_LABEL = 'Mig175 Step Two ' + S;
const SUB_MATCH = 'pst-mig175-match-' + S;
const PROC_OPTS = ['Mig175 Processor A', 'Mig175 Processor B'];
const CUST_OPTS = ['Mig175 Customer A', 'Mig175 Customer B', 'Mig175 Customer C'];
const MY_RECORD_IDS = [REC_BROILER, REC_PIG, REC_BAD];

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
async function readSettings() {
  const {data, error} = await service
    .from('processing_asana_sync_settings')
    .select('processor_options, customer_options')
    .eq('id', 'singleton')
    .maybeSingle();
  if (error) die('read settings singleton: ' + error.message);
  return data; // null when missing
}
function optionLabels(list) {
  return (Array.isArray(list) ? list : []).map((o) => (typeof o === 'string' ? o : o && o.label));
}

// Snapshot for the fail-closed and idempotence comparisons: all planner rows,
// the fixture rows + their subtasks, the whole template table, the settings
// option lists, and exact global row counts.
async function snapshotState() {
  const [{data: planner, error: e1}, {data: mine, error: e2}, {data: subs, error: e3}, {data: tpls, error: e4}] =
    await Promise.all([
      service.from('processing_records').select('*').eq('record_type', 'planner_batch').order('id'),
      service.from('processing_records').select('*').in('id', MY_RECORD_IDS).order('id'),
      service.from('processing_subtasks').select('*').in('record_id', MY_RECORD_IDS).order('id'),
      service.from('processing_templates').select('*').order('program').order('version'),
    ]);
  if (e1 || e2 || e3 || e4) die('snapshot read failed: ' + (e1 || e2 || e3 || e4).message);
  const settings = await readSettings();
  const {count: recCount} = await service.from('processing_records').select('id', {count: 'exact', head: true});
  const {count: subCount} = await service.from('processing_subtasks').select('id', {count: 'exact', head: true});
  return canon({planner, mine, subs, tpls, settings, recCount, subCount});
}

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 175_processing_planner_foundation.sql (${mig175.length} bytes) — stamp ${S}`);

  // ── admin profile (created_by for direct seeds) ────────────────────────────
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

  // ── pre-run snapshots for the finally restore ──────────────────────────────
  const v4 = await readStore('ppp-v4');
  const settingsBefore = await readSettings();
  if (!settingsBefore) {
    console.error('processing_asana_sync_settings singleton missing on TEST (mig 156 not applied?)');
    process.exit(2);
  }
  const {data: broilerTpls, error: btErr} = await service
    .from('processing_templates')
    .select('id, version, is_active')
    .eq('program', 'broiler')
    .order('version');
  if (btErr) {
    console.error('read broiler templates failed: ' + btErr.message);
    process.exit(2);
  }
  const originalActiveBroiler = (broilerTpls || []).find((t) => t.is_active) || null;
  const nextBroilerVersion = (broilerTpls || []).reduce((m, t) => Math.max(m, t.version), 0) + 1;

  let appliedOnce = false;
  try {
    // ── seed the fixture FIRST (backfills need data to work on) ──────────────
    await writeStore('ppp-v4', [...v4.arr, BATCH1, BATCH2]);
    {
      const {error} = await service.from('processing_records').insert([
        {
          id: REC_BROILER,
          record_type: 'planner_batch',
          program: 'broiler',
          title: 'MIG175 broiler fixture',
          processing_date: BATCH1.processingDate,
          status: 'planned',
          number_processed: BATCH1.totalToProcessor,
          source_kind: 'broiler',
          source_id: BATCH1.name, // rekey target: keyed by NAME today
          match_status: 'native',
          created_by: adminId,
        },
        {
          id: REC_PIG,
          record_type: 'planner_batch',
          program: 'pig',
          title: 'MIG175 pig fixture',
          processing_date: '2026-06-15',
          status: 'planned',
          number_processed: 6,
          source_kind: 'pig',
          source_id: PIG_SOURCE, // no source_phase / trip_ordinal yet
          match_status: 'native',
          created_by: adminId,
        },
      ]);
      if (error) die('seed records failed: ' + error.message);
    }
    if (originalActiveBroiler) {
      const {error} = await service
        .from('processing_templates')
        .update({is_active: false})
        .eq('id', originalActiveBroiler.id);
      if (error) die('deactivate current broiler template failed: ' + error.message);
    }
    {
      const {error} = await service.from('processing_templates').insert({
        id: TPL_ID,
        program: 'broiler',
        version: nextBroilerVersion,
        fields: [],
        // Deliberately NO step ids: the migration must mint them in place.
        checklist: [
          {label: STEP1_LABEL, assignee: null, assignee_profile_id: null},
          {label: STEP2_LABEL, assignee: 'Somebody Imported', assignee_profile_id: null},
        ],
        is_active: true,
        created_by: adminId,
      });
      if (error) die('seed template failed: ' + error.message);
    }
    {
      // Label matches step 1 case-insensitively (uppercased on purpose).
      const {error} = await service.from('processing_subtasks').insert({
        id: SUB_MATCH,
        record_id: REC_BROILER,
        label: STEP1_LABEL.toUpperCase(),
        sort_order: 1,
        created_by: adminId,
      });
      if (error) die('seed subtask failed: ' + error.message);
    }
    {
      // Legacy plain-string option lists (the conversion input).
      const {error} = await service
        .from('processing_asana_sync_settings')
        .update({processor_options: PROC_OPTS, customer_options: CUST_OPTS})
        .eq('id', 'singleton');
      if (error) die('seed settings options failed: ' + error.message);
    }
    ok('fixture seeded (2 batches, broiler+pig planner rows, id-less template, label-match subtask, string options)');

    // ── APPLY 175 ─────────────────────────────────────────────────────────────
    await execSql(mig175, 'APPLY 175');
    appliedOnce = true;
    await sleep(2500); // NOTIFY pgrst schema reload before RPC calls
    ok('migration 175 applied');

    // ── CHECK 1: broiler rekey name -> batch id, record id unchanged ─────────
    {
      const {data: rec, error} = await service
        .from('processing_records')
        .select('id, source_id, title')
        .eq('id', REC_BROILER)
        .maybeSingle();
      if (error || !rec) bad('CHECK 1 broiler row read', error ? error.message : 'row missing');
      else if (rec.source_id !== BATCH1.id) bad('CHECK 1 rekey wrong source_id', rec);
      else {
        const {data: stale} = await service
          .from('processing_records')
          .select('id')
          .eq('source_kind', 'broiler')
          .eq('source_id', BATCH1.name);
        const {data: sub} = await service.from('processing_subtasks').select('id').eq('id', SUB_MATCH).maybeSingle();
        if ((stale || []).length !== 0) bad('CHECK 1 a row is still keyed by the old batch name', stale);
        else if (!sub) bad('CHECK 1 subtask lost during rekey');
        else ok('CHECK 1 broiler source_id rekeyed name -> batch id; record id + subtask survive');
      }
    }

    // ── CHECK 2: pig backfill source_phase='actual', trip_ordinal=1 ──────────
    {
      const {data: rec, error} = await service
        .from('processing_records')
        .select('id, source_phase, trip_ordinal')
        .eq('id', REC_PIG)
        .maybeSingle();
      if (error || !rec) bad('CHECK 2 pig row read', error ? error.message : 'row missing');
      else if (rec.source_phase !== 'actual' || rec.trip_ordinal !== 1) bad('CHECK 2 pig backfill wrong', rec);
      else ok("CHECK 2 pig row backfilled source_phase='actual', trip_ordinal=1");
    }

    // ── CHECK 3: every ACTIVE template step has a non-blank unique id ────────
    {
      const {data: actives, error} = await service
        .from('processing_templates')
        .select('id, program, checklist')
        .eq('is_active', true);
      if (error) bad('CHECK 3 active templates read', error.message);
      else {
        let problem = null;
        for (const t of actives || []) {
          const ids = (Array.isArray(t.checklist) ? t.checklist : []).map((s) => String((s && s.id) || '').trim());
          if (ids.some((i) => i === '')) problem = `${t.program}/${t.id}: blank step id`;
          else if (new Set(ids).size !== ids.length) problem = `${t.program}/${t.id}: duplicate step ids`;
          if (problem) break;
        }
        if (problem) bad('CHECK 3 active checklist step ids', problem);
        else ok(`CHECK 3 all ${(actives || []).length} active templates carry non-blank unique step ids`);
      }
    }

    // ── CHECK 4: label-matched subtask gained the step's template_step_id ────
    let step1Id = null;
    {
      const {data: tpl, error} = await service
        .from('processing_templates')
        .select('checklist')
        .eq('id', TPL_ID)
        .maybeSingle();
      if (error || !tpl) bad('CHECK 4 seeded template read', error ? error.message : 'missing');
      else {
        const step1 = (tpl.checklist || []).find(
          (s) =>
            String((s && s.label) || '')
              .trim()
              .toLowerCase() === STEP1_LABEL.toLowerCase(),
        );
        step1Id = step1 && step1.id;
        const {data: sub} = await service
          .from('processing_subtasks')
          .select('template_step_id')
          .eq('id', SUB_MATCH)
          .maybeSingle();
        if (!step1Id) bad('CHECK 4 step 1 id not minted', tpl.checklist);
        else if (!sub || sub.template_step_id !== step1Id)
          bad('CHECK 4 subtask not linked to the matching step', {expected: step1Id, got: sub});
        else ok('CHECK 4 case-insensitive label match backfilled template_step_id = ' + step1Id);
      }
    }

    // ── CHECK 5: option lists converted to {id,label,active:true} objects ────
    {
      const settings = await readSettings();
      const verify = (list, seed, kind) => {
        if (!Array.isArray(list) || list.length !== seed.length) return `${kind}: wrong length`;
        const ids = [];
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (!o || typeof o !== 'object') return `${kind}[${i}]: not an object`;
          if (o.label !== seed[i]) return `${kind}[${i}]: label/order changed (${o.label})`;
          if (o.active !== true) return `${kind}[${i}]: active !== true`;
          if (!String(o.id || '').trim()) return `${kind}[${i}]: blank id`;
          ids.push(o.id);
        }
        if (new Set(ids).size !== ids.length) return `${kind}: duplicate ids`;
        return null;
      };
      const p = verify(settings && settings.processor_options, PROC_OPTS, 'processor_options');
      const c = verify(settings && settings.customer_options, CUST_OPTS, 'customer_options');
      if (p || c) bad('CHECK 5 option conversion', p || c);
      else ok('CHECK 5 processor/customer options converted to {id,label,active:true}, order + labels preserved');
    }

    // ── CHECK 6: list_my_processing_subtasks live for the authed admin ───────
    {
      const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
      if (signErr) die('admin sign-in failed: ' + signErr.message);
      const first = await authed.rpc('list_my_processing_subtasks');
      if (first.error) bad('CHECK 6 RPC errored', first.error.message);
      else if (!Array.isArray(first.data)) bad('CHECK 6 RPC did not return an array', first.data);
      else {
        // Assign the fixture subtask to the admin: it must now appear.
        const {error: asgErr} = await service
          .from('processing_subtasks')
          .update({assignee_profile_id: adminId})
          .eq('id', SUB_MATCH);
        if (asgErr) bad('CHECK 6 assign fixture subtask', asgErr.message);
        else {
          const second = await authed.rpc('list_my_processing_subtasks');
          const mine = (second.data || []).find((r) => r.subtask_id === SUB_MATCH);
          if (second.error) bad('CHECK 6 second RPC errored', second.error.message);
          else if (!mine || mine.record_id !== REC_BROILER)
            bad('CHECK 6 assigned open subtask not surfaced', second.data);
          else ok(`CHECK 6 list_my_processing_subtasks live (returned array; surfaces the assigned fixture subtask)`);
        }
      }
    }

    // ── CHECK 7: fail-closed rekey (atomic no-op on refusal) ─────────────────
    {
      const {error: insErr} = await service.from('processing_records').insert({
        id: REC_BAD,
        record_type: 'planner_batch',
        program: 'broiler',
        title: 'MIG175 unresolvable fixture',
        status: 'planned',
        source_kind: 'broiler',
        source_id: 'MIG175-NO-SUCH-BATCH-' + S, // matches no ppp-v4 batch name or id
        match_status: 'native',
        created_by: adminId,
      });
      if (insErr) die('seed bad rekey row failed: ' + insErr.message);
      const before = await snapshotState();
      await execSqlExpectError(mig175, 'REAPPLY 175 (must refuse)', 'rekey failed closed');
      const after = await snapshotState();
      if (before !== after) bad('CHECK 7 refused apply still mutated state (atomicity broken)');
      else ok('CHECK 7 unresolvable broiler source_id fails closed; refused apply changed nothing');
      const {error: delErr} = await service.from('processing_records').delete().eq('id', REC_BAD);
      if (delErr) die('remove bad rekey row failed: ' + delErr.message);
    }

    // ── CHECK 8: idempotent reapplication ─────────────────────────────────────
    {
      const before = await snapshotState();
      await execSql(mig175, 'REAPPLY 175 (idempotence)');
      const after = await snapshotState();
      if (before !== after) bad('CHECK 8 reapplication changed records/template/settings state');
      else ok('CHECK 8 reapplication is a byte-for-byte no-op');
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
    {
      const {error} = await service.from('processing_records').delete().in('id', MY_RECORD_IDS);
      if (error) restoreErrors.push('delete seeded records: ' + error.message);
    }
    if (v4.existed) {
      try {
        await writeStore('ppp-v4', v4.arr);
      } catch (e) {
        restoreErrors.push('restore ppp-v4: ' + (e.message || e));
      }
    } else {
      const {error} = await service.from('app_store').delete().eq('key', 'ppp-v4');
      if (error) restoreErrors.push('delete seeded ppp-v4: ' + error.message);
    }
    {
      const {error} = await service
        .from('processing_asana_sync_settings')
        .update({
          processor_options: settingsBefore.processor_options,
          customer_options: settingsBefore.customer_options,
        })
        .eq('id', 'singleton');
      if (error) restoreErrors.push('restore settings options: ' + error.message);
    }
    {
      const {error} = await service.from('processing_templates').delete().eq('id', TPL_ID);
      if (error) restoreErrors.push('delete seeded template: ' + error.message);
    }
    if (originalActiveBroiler) {
      const {error} = await service
        .from('processing_templates')
        .update({is_active: true})
        .eq('id', originalActiveBroiler.id);
      if (error) restoreErrors.push('reactivate original broiler template: ' + error.message);
    }
    // Re-apply the idempotent migration once more so the REAL restored data
    // (real active broiler template step ids, real option lists, real subtask
    // links) ends in the migrated state a clean single apply would produce.
    if (appliedOnce) {
      const {error} = await service.rpc('exec_sql', {sql: mig175});
      if (error) restoreErrors.push('final re-apply of 175 on restored real data: ' + error.message);
    }
    // Verify the fixture restore.
    try {
      const v4Now = await readStore('ppp-v4');
      if (v4.existed && canon(v4Now.arr) !== canon(v4.arr)) restoreErrors.push('ppp-v4 does not match pre-run value');
      if (!v4.existed && v4Now.existed) restoreErrors.push('ppp-v4 key should have been removed');
      const {data: leftovers} = await service.from('processing_records').select('id').in('id', MY_RECORD_IDS);
      if ((leftovers || []).length) restoreErrors.push('seeded records still present: ' + JSON.stringify(leftovers));
      const {data: tplLeft} = await service.from('processing_templates').select('id').eq('id', TPL_ID).maybeSingle();
      if (tplLeft) restoreErrors.push('seeded template still present');
      if (originalActiveBroiler) {
        const {data: act} = await service
          .from('processing_templates')
          .select('is_active')
          .eq('id', originalActiveBroiler.id)
          .maybeSingle();
        if (!act || act.is_active !== true) restoreErrors.push('original broiler template not active again');
      }
      const settingsNow = await readSettings();
      if (
        canon(optionLabels(settingsNow && settingsNow.processor_options)) !==
          canon(optionLabels(settingsBefore.processor_options)) ||
        canon(optionLabels(settingsNow && settingsNow.customer_options)) !==
          canon(optionLabels(settingsBefore.customer_options))
      ) {
        restoreErrors.push('settings option labels do not match pre-run values');
      }
    } catch (e) {
      restoreErrors.push('restore verification: ' + (e.message || e));
    }
    if (restoreErrors.length) {
      failures++;
      console.error('RESTORE PROBLEMS:\n- ' + restoreErrors.join('\n- '));
      console.error('pre-run ppp-v4 for manual recovery: ' + JSON.stringify(v4));
      console.error('pre-run settings options for manual recovery: ' + JSON.stringify(settingsBefore));
    } else {
      console.log('restore ok — fixtures back to the pre-run baseline; real data left in migrated state');
    }
  }

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
