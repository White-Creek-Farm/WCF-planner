// Apply mig 148 (group record weight snapshots + planned-move cleanup) to TEST
// via exec_sql, then verify the new record_pasture_move signature and history
// report fields behaviorally. Hard PROD-ref guard.
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

const AREA_ID = 'la-mig148-area';
const MOVE_ID = 'pmv-mig148-move';
const GROUP_KEY = 'mig148-smoke';

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  await admin.from('pasture_move_events').delete().eq('id', MOVE_ID);
  await admin.from('land_areas').delete().eq('id', AREA_ID);
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'supabase-migrations',
      '148_pasture_map_group_records_weight_and_planned_move_cleanup.sql',
    ),
    'utf8',
  );
  console.log(`applying 148_pasture_map_group_records_weight_and_planned_move_cleanup.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await cleanup();

  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));

  const {error: areaErr} = await admin.from('land_areas').insert({
    id: AREA_ID,
    kind: 'paddock',
    name: 'Mig148 Weight Paddock',
    status: 'active',
    review_status: 'reviewed',
    geometry_status: 'none',
    baseline_no_history: true,
    manual_acres: 10,
    source: 'drawn',
  });
  if (areaErr) die('synthetic land_area insert failed: ' + (areaErr.message || areaErr));

  const {data: move, error: moveErr} = await authed.rpc('record_pasture_move', {
    p_move_id: MOVE_ID,
    p_animal_type: 'cattle_herd',
    p_group_key: GROUP_KEY,
    p_group_label: 'Mig148 Smoke',
    p_to_land_area_id: AREA_ID,
    p_moved_at: new Date().toISOString(),
    p_animal_count: 5,
    p_total_weight_lbs: 2500,
    p_notes: null,
  });
  if (moveErr) die('record_pasture_move new signature failed: ' + (moveErr.message || moveErr));
  if (!move || move.total_weight_lbs !== 2500) die('move summary missing total_weight_lbs: ' + JSON.stringify(move));
  console.log('  [ok] record_pasture_move accepts total_weight_lbs');

  const {data: history, error: histErr} = await authed.rpc('list_pasture_history_report', {
    p_land_area_id: AREA_ID,
    p_animal_type: 'cattle_herd',
    p_group_key: GROUP_KEY,
    p_limit: 10,
  });
  if (histErr) die('list_pasture_history_report failed: ' + (histErr.message || histErr));
  const row = history && (history.history || []).find((r) => r.id === MOVE_ID);
  if (!row) die('history row missing: ' + JSON.stringify(history));
  if (row.total_weight_lbs !== 2500) die('history missing total_weight_lbs: ' + JSON.stringify(row));
  if (Number(row.to_land_area_acres) !== 10) die('history missing to_land_area_acres=10: ' + JSON.stringify(row));
  console.log('  [ok] history report returns total_weight_lbs + destination acres');

  const {error: plannedErr} = await admin.rpc('exec_sql', {
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.pasture_planned_moves') IS NOT NULL THEN
          RAISE EXCEPTION 'pasture_planned_moves still exists after mig 148';
        END IF;
      END $$;
    `,
  });
  if (plannedErr) die('planned table regclass check failed: ' + (plannedErr.message || plannedErr));
  console.log('  [ok] pasture_planned_moves table retired');

  await cleanup();
  console.log('mig148 verify: ALL CHECKS PASSED (weight snapshot, history metrics, planned cleanup)');
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
