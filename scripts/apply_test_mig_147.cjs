// Apply mig 147 (delete_pasture_move RPC + parent-from-child overlap suppression
// in _land_area_summary) to TEST via exec_sql, then verify BEHAVIORALLY:
//   1. PostgREST schema reload after the new RPC.
//   2. anon is denied delete_pasture_move (REVOKE from anon).
//   3. admin (management/admin gate + GRANT authenticated) reaches it; a missing
//      id returns the idempotent replayed:true payload.
//   4. delete behavior: a real move event + its impacts are removed, and the
//      impacts cascade (verified via service-role SELECT, not exec_sql).
//   5. color fix: a PARENT pasture does NOT take occupied/resting FILL from its
//      own child paddock's moves (occupancy overlap + child departure suppressed);
//      the child still reads occupied -> resting.
// All synthetic rows are namespaced 'mig147-' and cleaned up at the end.
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
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const P = 'la-mig147-parent';
const C = 'la-mig147-child';
const M1 = 'pmv-mig147-m1';
const M2 = 'pmv-mig147-m2';
const GROUP_KEY = 'mig147-smoke';
const iso = (msOffset) => new Date(Date.now() + msOffset).toISOString();

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  // Deleting the move events cascades their impacts; then drop the areas.
  await admin.from('pasture_move_events').delete().in('id', [M1, M2]);
  await admin.from('land_areas').delete().in('id', [C, P]);
}

async function areasByIdFromList() {
  const {data, error} = await authed.rpc('list_land_areas', {p_include_deleted: false});
  if (error) die('list_land_areas failed: ' + (error.message || error));
  const map = {};
  for (const a of (data && data.land_areas) || []) map[a.id] = a;
  return map;
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '147_pasture_map_grazing_entry_delete_and_parent_overlap.sql'),
    'utf8',
  );
  console.log(`applying 147_...sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((r) => setTimeout(r, 2500));

  // Make sure we start clean (in case of a prior aborted run).
  await cleanup();

  // ---- 2. anon denial ----
  {
    const {error} = await anon.rpc('delete_pasture_move', {p_move_id: 'pmv-anon-denied'});
    if (!error) die('anon was allowed to call delete_pasture_move (expected denial)');
    console.log('  [ok] anon denied: ' + (error.message || error));
  }

  // ---- 3. admin gate + grant + idempotent missing-id ----
  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  {
    const {data, error} = await authed.rpc('delete_pasture_move', {p_move_id: 'pmv-mig147-missing'});
    if (error) die('admin delete on missing id errored (gate/grant?): ' + (error.message || error));
    if (!data || data.ok !== true || data.replayed !== true) {
      die('missing-id delete should return {ok:true, replayed:true}, got ' + JSON.stringify(data));
    }
    console.log('  [ok] admin reaches RPC; missing id -> replayed:true');
  }

  // ---- setup synthetic parent/child + a move INTO the child ----
  {
    const {error} = await admin.from('land_areas').insert([
      {id: P, kind: 'pasture', name: 'Mig147 Parent', status: 'active', baseline_no_history: false},
      {id: C, kind: 'paddock', parent_id: P, name: 'Mig147 Child', status: 'active', baseline_no_history: false},
    ]);
    if (error) die('synthetic land_areas insert failed: ' + (error.message || error));
  }
  {
    const {error} = await admin.from('pasture_move_events').insert([
      {
        id: M1,
        animal_type: 'cattle_herd',
        group_key: GROUP_KEY,
        group_label: 'Mig147 Smoke',
        to_land_area_id: C,
        moved_at: iso(-2 * 86400000),
        animal_count: 10,
      },
    ]);
    if (error) die('synthetic move M1 insert failed: ' + (error.message || error));
    const {error: impErr} = await admin.from('pasture_move_impacts').insert([
      {move_id: M1, land_area_id: C, impact_kind: 'destination', impacted_at: iso(-2 * 86400000)},
      {move_id: M1, land_area_id: P, impact_kind: 'overlap', impacted_at: iso(-2 * 86400000)},
    ]);
    if (impErr) die('synthetic impacts (M1) insert failed: ' + (impErr.message || impErr));
  }

  // ---- 5a. color fix (occupancy): child occupied, parent NOT colored ----
  {
    const m = await areasByIdFromList();
    if (!m[P] || !m[C]) die('synthetic areas not visible in list_land_areas');
    console.log(
      `  child rest_state=${m[C].rest_state} (occ_count=${m[C].current_occupancy_count}); ` +
        `parent rest_state=${m[P].rest_state} (occ_count=${m[P].current_occupancy_count})`,
    );
    if (m[C].rest_state !== 'occupied') die('child should be occupied, got ' + m[C].rest_state);
    if (m[P].rest_state === 'occupied' || m[P].rest_state === 'resting') {
      die('parent took child occupancy/rest FILL: ' + m[P].rest_state);
    }
    if (m[P].current_occupancy_count !== 0)
      die('parent occupancy_count should be 0, got ' + m[P].current_occupancy_count);
    console.log('  [ok] occupancy: child occupied, parent suppressed (' + m[P].rest_state + ')');
  }

  // ---- 4. OPEN-stay delete + cascade (delete M1 as admin; no later move) ----
  {
    const {data, error} = await authed.rpc('delete_pasture_move', {p_move_id: M1});
    if (error) die('delete_pasture_move(M1) errored: ' + (error.message || error));
    if (!data || data.ok !== true || data.replayed !== false) die('unexpected delete payload: ' + JSON.stringify(data));
    if (data.impacts_cleared !== 2) die('expected impacts_cleared=2, got ' + data.impacts_cleared);
    if (data.linked_departure_impacts_cleared !== 0) {
      die('open stay should clear 0 linked departures, got ' + data.linked_departure_impacts_cleared);
    }
    if (data.to_land_area_id !== C) die('payload to_land_area_id mismatch: ' + data.to_land_area_id);
    // Cascade proof via service-role SELECT (RLS-bypassing): impacts gone, event gone.
    const {data: impLeft} = await admin.from('pasture_move_impacts').select('move_id').eq('move_id', M1);
    if ((impLeft || []).length !== 0) die('impacts did NOT cascade: ' + JSON.stringify(impLeft));
    const {data: evLeft} = await admin.from('pasture_move_events').select('id').eq('id', M1);
    if ((evLeft || []).length !== 0) die('move event was not deleted');
    console.log('  [ok] open-stay delete removed the move + cascaded ' + data.impacts_cleared + ' impacts');
  }

  // ---- 5b. color fix (resting): clear child, parent stays baseline, child rests ----
  {
    // Re-seed the move into the child, then a CLEAR move out of the child.
    await admin.from('pasture_move_events').insert([
      {
        id: M1,
        animal_type: 'cattle_herd',
        group_key: GROUP_KEY,
        group_label: 'Mig147 Smoke',
        to_land_area_id: C,
        moved_at: iso(-2 * 86400000),
        animal_count: 10,
      },
      {
        id: M2,
        animal_type: 'cattle_herd',
        group_key: GROUP_KEY,
        group_label: 'Mig147 Smoke',
        from_land_area_id: C,
        to_land_area_id: null,
        moved_at: iso(-1 * 86400000),
        animal_count: 10,
      },
    ]);
    await admin.from('pasture_move_impacts').insert([
      {move_id: M1, land_area_id: C, impact_kind: 'destination', impacted_at: iso(-2 * 86400000)},
      {move_id: M1, land_area_id: P, impact_kind: 'overlap', impacted_at: iso(-2 * 86400000)},
      {move_id: M2, land_area_id: C, impact_kind: 'departure', impacted_at: iso(-1 * 86400000)},
      {move_id: M2, land_area_id: P, impact_kind: 'departure', impacted_at: iso(-1 * 86400000)},
    ]);
    const m = await areasByIdFromList();
    console.log(`  after clear: child rest_state=${m[C].rest_state}; parent rest_state=${m[P].rest_state}`);
    if (m[C].rest_state !== 'resting') die('child should be resting after clear, got ' + m[C].rest_state);
    if (m[P].rest_state === 'occupied' || m[P].rest_state === 'resting') {
      die('parent took child departure FILL: ' + m[P].rest_state);
    }
    console.log('  [ok] resting: child resting, parent suppressed (' + m[P].rest_state + ')');
  }

  // ---- 6. COMPLETED-stay delete: deleting M1 (the move-IN) also clears M2's
  //         linked departures, so the child stops reading "resting" and M2 (the
  //         real later move) survives. No Reports-vs-map drift. ----
  {
    const {data, error} = await authed.rpc('delete_pasture_move', {p_move_id: M1});
    if (error) die('completed-stay delete_pasture_move(M1) errored: ' + (error.message || error));
    if (!data || data.ok !== true) die('unexpected completed-stay delete payload: ' + JSON.stringify(data));
    if (data.impacts_cleared !== 2) die('expected impacts_cleared=2 (M1 dest+overlap), got ' + data.impacts_cleared);
    if (data.linked_departure_impacts_cleared !== 2) {
      die('expected 2 linked departures cleared (M2 on child+parent), got ' + data.linked_departure_impacts_cleared);
    }
    // M1 + its impacts are gone; M2 still exists; M2's departures were cleared.
    const {data: ev1} = await admin.from('pasture_move_events').select('id').eq('id', M1);
    if ((ev1 || []).length !== 0) die('M1 was not deleted');
    const {data: imp1} = await admin.from('pasture_move_impacts').select('move_id').eq('move_id', M1);
    if ((imp1 || []).length !== 0) die('M1 impacts did not cascade');
    const {data: ev2} = await admin.from('pasture_move_events').select('id').eq('id', M2);
    if ((ev2 || []).length !== 1) die('M2 (the later move) must be preserved');
    const {data: imp2} = await admin.from('pasture_move_impacts').select('move_id').eq('move_id', M2);
    if ((imp2 || []).length !== 0) die('M2 linked departures were NOT cleared: ' + JSON.stringify(imp2));
    // Child no longer reads resting (no orphaned departure); parent stays clean.
    const m = await areasByIdFromList();
    console.log(
      `  after completed-stay delete: child rest_state=${m[C].rest_state}; parent rest_state=${m[P].rest_state}`,
    );
    if (m[C].rest_state === 'resting' || m[C].rest_state === 'occupied') {
      die('child still colored after deleting the completed stay: ' + m[C].rest_state);
    }
    if (m[P].rest_state === 'resting' || m[P].rest_state === 'occupied') {
      die('parent colored after deleting the completed stay: ' + m[P].rest_state);
    }
    console.log(
      `  [ok] completed-stay delete: child=${m[C].rest_state}, parent=${m[P].rest_state}, M2 preserved, drift removed`,
    );
  }

  await cleanup();
  console.log(
    'mig147 verify: ALL CHECKS PASSED (anon-deny, admin-gate, open+completed-stay delete, cascade, parent color fix)',
  );
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
