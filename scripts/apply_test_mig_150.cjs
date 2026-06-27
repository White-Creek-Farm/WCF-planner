// Apply mig 150 (pasture open-line edit) to TEST via exec_sql, then verify the
// new update_land_area_track RPC behaviorally through the authenticated client:
//   (1) HAPPY PATH: a saved Track / Line (outline_candidate) reshapes in place —
//       raw_geometry changes to the new LineString, while kind / geometry_status
//       stay 'outline_candidate' and NO acreage is computed (draft geometry only).
//   (2) NEGATIVE (wrong geometry): passing a Polygon to update_land_area_track is
//       rejected with PM_VALIDATION (line-only).
//   (3) NEGATIVE (wrong target): calling update_land_area_track on a real closed
//       polygon area is rejected ("not an editable Track / Line") — a polygon can
//       never be reshaped into a line here.
// Role gating (management/admin only) is covered by the static guard + the SQL
// role check; this script runs as admin. Hard PROD-ref guard. Cleans up all rows.
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

const TRACK = 'la-mig150-track';
const POLY = 'la-mig150-poly';

const LINE_A = {
  type: 'LineString',
  coordinates: [
    [-86.437, 30.8417],
    [-86.435, 30.8419],
  ],
};
const LINE_B = {
  type: 'LineString',
  coordinates: [
    [-86.437, 30.8417],
    [-86.4358, 30.8424],
    [-86.434, 30.8418],
  ],
};
const POLYGON = {
  type: 'Polygon',
  coordinates: [
    [
      [-86.437, 30.8417],
      [-86.435, 30.8417],
      [-86.435, 30.8424],
      [-86.437, 30.8424],
      [-86.437, 30.8417],
    ],
  ],
};

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  await admin.from('land_area_geometry_versions').delete().in('land_area_id', [TRACK, POLY]);
  await admin.from('land_areas').delete().in('id', [TRACK, POLY]);
}

async function summaryOf(areaId) {
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

  // ---- Apply migration 150 ---------------------------------------------------
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '150_pasture_map_open_line_edit.sql'),
    'utf8',
  );
  console.log(`applying 150_pasture_map_open_line_edit.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // ---- Seed a saved Track / Line and a real polygon area (both via RPCs) ------
  const {error: tErr} = await authed.rpc('create_land_area_track', {
    p_id: TRACK,
    p_name: 'Mig150 Track',
    p_line_geojson: LINE_A,
    p_source: 'drawn',
  });
  if (tErr) die('create_land_area_track failed: ' + (tErr.message || tErr));

  const {error: pErr} = await authed.rpc('create_land_area', {
    p_id: POLY,
    p_name: 'Mig150 Polygon',
    p_polygon_geojson: POLYGON,
    p_kind: 'paddock',
    p_source: 'drawn',
  });
  if (pErr) die('create_land_area (polygon) failed: ' + (pErr.message || pErr));

  const before = await summaryOf(TRACK);
  const beforePts = before.raw_geometry && before.raw_geometry.coordinates ? before.raw_geometry.coordinates.length : 0;
  console.log(
    `  [seed] track raw_geometry = ${before.raw_geometry && before.raw_geometry.type} (${beforePts} pts), kind=${before.kind}, geometry_status=${before.geometry_status}`,
  );
  if (before.raw_geometry.type !== 'LineString' || beforePts !== 2)
    die('seed track did not store the 2-point LineString');

  // ---- (1) HAPPY PATH: reshape the track in place -----------------------------
  const {error: upErr} = await authed.rpc('update_land_area_track', {p_id: TRACK, p_line_geojson: LINE_B});
  if (upErr) die('update_land_area_track (happy path) failed: ' + (upErr.message || upErr));
  const after = await summaryOf(TRACK);
  const afterPts = after.raw_geometry && after.raw_geometry.coordinates ? after.raw_geometry.coordinates.length : 0;
  console.log(
    `  [post] track raw_geometry = ${after.raw_geometry && after.raw_geometry.type} (${afterPts} pts), kind=${after.kind}, geometry_status=${after.geometry_status}, effective_acres=${after.effective_acres}`,
  );
  if (after.raw_geometry.type !== 'LineString' || afterPts !== 3)
    die('edited track did not persist the new 3-point LineString');
  if (after.kind !== 'outline_candidate' || after.geometry_status !== 'outline_candidate')
    die('edit must NOT change kind/geometry_status of a Track / Line');
  if (after.effective_acres != null || after.computed_acres != null)
    die('a Track / Line edit must not compute acreage');
  if (after.current_version) die('a Track / Line edit must not write a polygon geometry version');
  console.log('  [ok] saved Track / Line reshapes in place; no acreage, no version, status preserved');

  // ---- (2) NEGATIVE: Polygon geometry rejected --------------------------------
  const {error: polyGeomErr} = await authed.rpc('update_land_area_track', {p_id: TRACK, p_line_geojson: POLYGON});
  if (!polyGeomErr) die('update_land_area_track must REJECT a Polygon geometry');
  if (!/must be a line/i.test(polyGeomErr.message || ''))
    die('unexpected polygon-geometry error: ' + polyGeomErr.message);
  console.log(`  [ok] polygon geometry rejected: ${polyGeomErr.message}`);

  // ---- (3) NEGATIVE: cannot reshape a real polygon area into a line -----------
  const {error: wrongTargetErr} = await authed.rpc('update_land_area_track', {p_id: POLY, p_line_geojson: LINE_B});
  if (!wrongTargetErr) die('update_land_area_track must REJECT a real polygon area target');
  if (!/not an editable Track \/ Line/i.test(wrongTargetErr.message || ''))
    die('unexpected wrong-target error: ' + wrongTargetErr.message);
  console.log(`  [ok] polygon area target rejected: ${wrongTargetErr.message}`);

  await cleanup();
  console.log('mig150 verify: ALL CHECKS PASSED (reshape in place, polygon geom rejected, polygon target rejected)');
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
