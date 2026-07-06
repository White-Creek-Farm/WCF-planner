// Apply mig 155 (Pasture Map same-move departure-overlap rest fix) to TEST via
// exec_sql, then behaviorally verify the FP4D2 bug pattern:
//   move 1: group moves INTO area A
//   move 2: group moves FROM area A INTO area B, and the same move also writes
//           an overlap impact back onto A because B intersects A
//
// Before mig 155, A reads occupied/current_occupants=[overlap]/rest_days=0.
// After mig 155, A reads resting/current_occupants=[]/rest_days>=2, while B is
// still occupied. Hard PROD-ref guard. Cleans up every synthetic row.
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
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const AREA_A = 'la-mig155-departed-overlap-a';
const AREA_B = 'la-mig155-current-b';
const MOVE_1 = 'pmv-mig155-into-a';
const MOVE_2 = 'pmv-mig155-a-to-b-overlap-a';
const GROUP = 'mig155-group';

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  await service.from('pasture_move_events').delete().in('id', [MOVE_1, MOVE_2]);
  await service.from('land_areas').delete().in('id', [AREA_A, AREA_B]);
}

async function listArea(areaId) {
  const {data, error} = await authed.rpc('list_land_areas', {p_include_deleted: false});
  if (error) die('list_land_areas failed: ' + (error.message || error));
  const row = (data && data.land_areas ? data.land_areas : []).find((a) => a.id === areaId);
  if (!row) die('area not found in list_land_areas: ' + areaId);
  return row;
}

(async () => {
  console.log(`TEST url=${url}`);

  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));

  await cleanup();

  const movedInAt = new Date(Date.now() - 5 * 86400_000).toISOString();
  const movedOutAt = new Date(Date.now() - (2 * 86400_000 + 2 * 3600_000)).toISOString();

  const {error: areaErr} = await service.from('land_areas').insert([
    {
      id: AREA_A,
      kind: 'paddock',
      name: 'Mig155 Departed Overlap A',
      permanence: 'permanent',
      status: 'active',
      review_status: 'reviewed',
      geometry_status: 'none',
      baseline_no_history: false,
      manual_acres: 4,
      source: 'drawn',
    },
    {
      id: AREA_B,
      kind: 'paddock',
      name: 'Mig155 Current B',
      permanence: 'permanent',
      status: 'active',
      review_status: 'reviewed',
      geometry_status: 'none',
      baseline_no_history: false,
      manual_acres: 5,
      source: 'drawn',
    },
  ]);
  if (areaErr) die('land_area insert failed: ' + (areaErr.message || areaErr));

  const {error: moveErr} = await service.from('pasture_move_events').insert([
    {
      id: MOVE_1,
      animal_type: 'cattle_herd',
      group_key: GROUP,
      group_label: 'Mig155 Group',
      from_land_area_id: null,
      to_land_area_id: AREA_A,
      moved_at: movedInAt,
      animal_count: 11,
    },
    {
      id: MOVE_2,
      animal_type: 'cattle_herd',
      group_key: GROUP,
      group_label: 'Mig155 Group',
      from_land_area_id: AREA_A,
      to_land_area_id: AREA_B,
      moved_at: movedOutAt,
      animal_count: 11,
    },
  ]);
  if (moveErr) die('move insert failed: ' + (moveErr.message || moveErr));

  const {error: impactErr} = await service.from('pasture_move_impacts').insert([
    {move_id: MOVE_1, land_area_id: AREA_A, impact_kind: 'destination', impacted_at: movedInAt},
    {move_id: MOVE_2, land_area_id: AREA_A, impact_kind: 'departure', impacted_at: movedOutAt},
    {move_id: MOVE_2, land_area_id: AREA_A, impact_kind: 'overlap', impacted_at: movedOutAt},
    {move_id: MOVE_2, land_area_id: AREA_B, impact_kind: 'destination', impacted_at: movedOutAt},
  ]);
  if (impactErr) die('impact insert failed: ' + (impactErr.message || impactErr));

  const before = await listArea(AREA_A);
  console.log(
    `  [pre-155] area A rest_state=${before.rest_state}, rest_days=${before.rest_days}, current_occupancy_count=${before.current_occupancy_count}`,
  );

  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '155_pasture_map_departure_overlap_rest.sql'),
    'utf8',
  );
  console.log(`applying 155_pasture_map_departure_overlap_rest.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const afterA = await listArea(AREA_A);
  const afterB = await listArea(AREA_B);
  console.log(
    `  [post-155] area A rest_state=${afterA.rest_state}, rest_days=${afterA.rest_days}, current_occupancy_count=${afterA.current_occupancy_count}`,
  );
  console.log(
    `  [post-155] area B rest_state=${afterB.rest_state}, current_occupancy_count=${afterB.current_occupancy_count}`,
  );

  if (afterA.rest_state !== 'resting') die(`area A should read resting, got ${afterA.rest_state}`);
  if (Number(afterA.rest_days) < 2) die(`area A should have at least 2 rest days, got ${afterA.rest_days}`);
  if (Number(afterA.current_occupancy_count || 0) !== 0) {
    die(`area A should have no current occupants, got ${afterA.current_occupancy_count}`);
  }
  if (Array.isArray(afterA.current_occupants) && afterA.current_occupants.length > 0) {
    die(`area A current_occupants should be empty, got ${JSON.stringify(afterA.current_occupants)}`);
  }
  if (afterB.rest_state !== 'occupied') die(`area B should stay occupied, got ${afterB.rest_state}`);
  if (Number(afterB.current_occupancy_count || 0) !== 1) {
    die(`area B should have one current occupant, got ${afterB.current_occupancy_count}`);
  }

  console.log('  [ok] same-move departure overlap no longer blocks rest on the departed area');
  console.log('  [ok] real destination area remains occupied');

  await cleanup();
  console.log('mig155 verify: ALL CHECKS PASSED');
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
