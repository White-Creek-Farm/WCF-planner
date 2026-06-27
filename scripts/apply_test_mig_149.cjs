// Apply mig 149 (pasture rest/history reconciliation) to TEST via exec_sql, then
// verify _land_area_summary behaviorally through the authenticated list_land_areas
// RPC. Two checks:
//   (1) ORPHAN impacts (move event with to/from = NULL, the 143-reset / area
//       hard-delete signature) must NOT make an area read "resting": before the
//       migration the synthetic orphan reads 'resting' (bug), after it reads
//       'baseline' (fixed).
//   (2) POSITIVE CONTROL: a real completed stay (group moved in, then out) leaves
//       a departure with a non-null from and must STILL read 'resting' (no
//       over-suppression).
// Hard PROD-ref guard. Cleans up all synthetic rows.
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

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (!url || !serviceKey || !anonKey || !adminEmail || !adminPassword) {
  console.error('missing TEST env (url / service key / anon key / admin email+password)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const admin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const ORPHAN_AREA = 'la-mig149-orphan';
const ORPHAN_MOVE = 'pmv-mig149-orphan';
const ORPHAN_GROUP = 'mig149-orphan';
const REAL_B = 'la-mig149-realb';
const REAL_C = 'la-mig149-realc';
const REAL_GROUP = 'mig149-real';
const REAL_MOVE_1 = 'pmv-mig149-real-1';
const REAL_MOVE_2 = 'pmv-mig149-real-2';

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  await admin.from('pasture_move_impacts').delete().eq('move_id', ORPHAN_MOVE);
  await admin.from('pasture_move_events').delete().in('id', [ORPHAN_MOVE, REAL_MOVE_1, REAL_MOVE_2]);
  await admin.from('land_areas').delete().in('id', [ORPHAN_AREA, REAL_B, REAL_C]);
}

async function restStateOf(areaId) {
  const {data, error} = await authed.rpc('list_land_areas', {p_include_deleted: false});
  if (error) die('list_land_areas failed: ' + (error.message || error));
  const row = (data && data.land_areas ? data.land_areas : []).find((a) => a.id === areaId);
  if (!row) die('area not found in list_land_areas: ' + areaId);
  return row.rest_state;
}

(async () => {
  console.log(`TEST url=${url}`);

  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));

  await cleanup();

  // ---- Build the synthetic ORPHAN scenario (move with to/from = NULL) --------
  const nowIso = new Date().toISOString();
  const {error: areaErr} = await admin.from('land_areas').insert({
    id: ORPHAN_AREA,
    kind: 'paddock',
    name: 'Mig149 Orphan Paddock',
    status: 'active',
    review_status: 'reviewed',
    geometry_status: 'none',
    baseline_no_history: false, // flipped false, like FP3/FP3A1
    manual_acres: 10,
    source: 'drawn',
  });
  if (areaErr) die('orphan land_area insert failed: ' + (areaErr.message || areaErr));

  const {error: moveErr} = await admin.from('pasture_move_events').insert({
    id: ORPHAN_MOVE,
    animal_type: 'sheep_flock',
    group_key: ORPHAN_GROUP,
    group_label: 'Mig149 Orphan',
    from_land_area_id: null, // detached (143-reset / FK SET NULL signature)
    to_land_area_id: null,
    moved_at: nowIso,
    animal_count: 12,
  });
  if (moveErr) die('orphan move insert failed: ' + (moveErr.message || moveErr));

  const {error: impErr} = await admin.from('pasture_move_impacts').insert([
    {move_id: ORPHAN_MOVE, land_area_id: ORPHAN_AREA, impact_kind: 'departure', impacted_at: nowIso},
    {move_id: ORPHAN_MOVE, land_area_id: ORPHAN_AREA, impact_kind: 'overlap', impacted_at: nowIso},
  ]);
  if (impErr) die('orphan impacts insert failed: ' + (impErr.message || impErr));

  // ---- BEFORE: current TEST function (mig 147) should read 'resting' (the bug) -
  const beforeState = await restStateOf(ORPHAN_AREA);
  console.log(`  [pre-149] orphan area rest_state = ${beforeState} (expected 'resting' = bug reproduced)`);

  // ---- Apply migration 149 ---------------------------------------------------
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '149_pasture_map_rest_history_reconciliation.sql'),
    'utf8',
  );
  console.log(`applying 149_pasture_map_rest_history_reconciliation.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // ---- AFTER: orphan area must read 'baseline' (orphan impacts now inert) -----
  const afterState = await restStateOf(ORPHAN_AREA);
  console.log(`  [post-149] orphan area rest_state = ${afterState}`);
  if (afterState !== 'baseline') {
    die(`orphan area should read 'baseline' after mig 149, got '${afterState}'`);
  }
  console.log('  [ok] orphan (NULL-link) impacts no longer produce phantom resting state');

  // ---- POSITIVE CONTROL: a real completed stay must STILL read 'resting' ------
  for (const [id, name] of [
    [REAL_B, 'Mig149 Real B'],
    [REAL_C, 'Mig149 Real C'],
  ]) {
    const {error} = await admin.from('land_areas').insert({
      id,
      kind: 'paddock',
      name,
      status: 'active',
      review_status: 'reviewed',
      geometry_status: 'none',
      baseline_no_history: true,
      manual_acres: 8,
      source: 'drawn',
    });
    if (error) die(`real control area ${id} insert failed: ` + (error.message || error));
  }
  const t1 = new Date(Date.now() - 60000).toISOString();
  const t2 = new Date().toISOString();
  const {error: rm1} = await authed.rpc('record_pasture_move', {
    p_move_id: REAL_MOVE_1,
    p_animal_type: 'cattle_herd',
    p_group_key: REAL_GROUP,
    p_group_label: 'Mig149 Real',
    p_to_land_area_id: REAL_B,
    p_moved_at: t1,
    p_animal_count: 5,
    p_total_weight_lbs: null,
    p_notes: null,
  });
  if (rm1) die('control move 1 (->B) failed: ' + (rm1.message || rm1));
  const {error: rm2} = await authed.rpc('record_pasture_move', {
    p_move_id: REAL_MOVE_2,
    p_animal_type: 'cattle_herd',
    p_group_key: REAL_GROUP,
    p_group_label: 'Mig149 Real',
    p_to_land_area_id: REAL_C,
    p_moved_at: t2,
    p_animal_count: 5,
    p_total_weight_lbs: null,
    p_notes: null,
  });
  if (rm2) die('control move 2 (->C) failed: ' + (rm2.message || rm2));

  const realBState = await restStateOf(REAL_B);
  console.log(`  [post-149] real completed-stay area B rest_state = ${realBState}`);
  if (realBState !== 'resting') {
    die(`real departure (from non-null) should still read 'resting', got '${realBState}'`);
  }
  console.log('  [ok] legitimate completed-stay departures still read resting (no over-suppression)');

  await cleanup();
  console.log('mig149 verify: ALL CHECKS PASSED (orphan->baseline, real departure->resting)');
  process.exit(0);
})().catch(async (e) => {
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
