// Apply mig 139 (Pasture Map 'light' = farm_team-level access) to TEST via
// exec_sql. Hard PROD-ref guard. After apply, runs a light-user smoke that
// proves the widening worked (light can now call list_pasture_rest_report) and
// that management-only writes are STILL denied to light (create_land_area).
//
// Follows the apply_test_mig_132.cjs pattern: same loadDotEnv calls, same
// PROD_REF guard, same exec_sql apply + NOTIFY + 2500ms wait.
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

loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (!url || !serviceKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const admin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

// Idempotent light smoke user.
const LIGHT_EMAIL = 'light139smoke@wcfplanner.test';
const LIGHT_PASS = 'Light139Smoke!pw';
const LIGHT_NAME = 'Light 139 Smoke';

// Small valid square near the farm (lon,lat) for the create_land_area negative.
const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [-86.437, 30.8415],
      [-86.436, 30.8415],
      [-86.436, 30.842],
      [-86.437, 30.842],
      [-86.437, 30.8415],
    ],
  ],
};

(async () => {
  if (!anonKey) {
    console.error('missing TEST auth env (anon key)');
    process.exit(2);
  }
  console.log(`TEST url=${url}`);

  // 1) Apply (idempotent: pure CREATE OR REPLACE / REVOKE / GRANT; no BEGIN/COMMIT).
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '139_pasture_map_light_farm_team.sql'),
    'utf8',
  );
  console.log(`applying 139_pasture_map_light_farm_team.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // 2) Create-or-reuse the idempotent light smoke user via the service-role
  //    admin client. Tolerate an already-registered email by listing + finding.
  let lightId = null;
  const {data: created, error: createErr} = await admin.auth.admin.createUser({
    email: LIGHT_EMAIL,
    password: LIGHT_PASS,
    email_confirm: true,
  });
  if (createErr) {
    const msg = createErr.message || String(createErr);
    if (!/already.*registered|already been registered|already exists|email_exists/i.test(msg)) {
      console.error('createUser failed:', msg);
      process.exit(1);
    }
    // Find the existing user by paging the admin user list.
    let page = 1;
    while (lightId === null) {
      const {data: list, error: listErr} = await admin.auth.admin.listUsers({page, perPage: 200});
      if (listErr) {
        console.error('listUsers failed:', listErr.message || listErr);
        process.exit(1);
      }
      const found = (list.users || []).find((u) => (u.email || '').toLowerCase() === LIGHT_EMAIL);
      if (found) {
        lightId = found.id;
        break;
      }
      if (!list.users || list.users.length < 200) break;
      page += 1;
    }
    if (!lightId) {
      console.error('light smoke user already registered but not found in listUsers');
      process.exit(1);
    }
  } else {
    lightId = created.user.id;
  }
  console.log(`light smoke user id=${lightId}`);

  // Ensure the password is known (reset on the reused user) so sign-in works.
  await admin.auth.admin.updateUserById(lightId, {password: LIGHT_PASS, email_confirm: true});

  // 3) Upsert the public.profiles row so profile_role() returns 'light'.
  const {error: profErr} = await admin
    .from('profiles')
    .upsert({id: lightId, role: 'light', full_name: LIGHT_NAME}, {onConflict: 'id'});
  if (profErr) {
    console.error('profiles upsert failed:', profErr.message || profErr);
    process.exit(1);
  }

  // 4) Sign the light user in via the anon client.
  const {error: signErr} = await authed.auth.signInWithPassword({email: LIGHT_EMAIL, password: LIGHT_PASS});
  if (signErr) {
    console.error('light signIn failed:', signErr.message || signErr);
    process.exit(1);
  }

  // 5) POSITIVE: light can now read the pasture rest report (widening worked).
  const {data: restData, error: restErr} = await authed.rpc('list_pasture_rest_report');
  if (restErr) {
    const msg = restErr.message || String(restErr);
    if (/caller role light cannot/i.test(msg) || /role .*light.* cannot/i.test(msg)) {
      console.error('UNEXPECTED: light still denied on list_pasture_rest_report:', msg);
      process.exit(1);
    }
    console.error('UNEXPECTED error calling list_pasture_rest_report as light:', msg);
    process.exit(1);
  }
  if (!restData || typeof restData !== 'object' || !('areas' in restData)) {
    console.error('UNEXPECTED list_pasture_rest_report shape:', JSON.stringify(restData));
    process.exit(1);
  }
  console.log('positive: light called list_pasture_rest_report OK');

  // 6) NEGATIVE: light is STILL denied on create_land_area (mgmt/admin only).
  const negId = 'la-light139-neg-' + Date.now();
  const {data: createLaData, error: createLaErr} = await authed.rpc('create_land_area', {
    p_id: negId,
    p_name: 'Light 139 Neg',
    p_polygon_geojson: SQUARE,
    p_kind: 'paddock',
    p_source: 'drawn',
  });
  if (!createLaErr) {
    console.error('UNEXPECTED: light was allowed to create_land_area:', JSON.stringify(createLaData));
    process.exit(1);
  }
  const negMsg = createLaErr.message || String(createLaErr);
  if (!/cannot create land areas/i.test(negMsg)) {
    console.error('UNEXPECTED create_land_area failure (not the role-denied message):', negMsg);
    process.exit(1);
  }
  console.log('negative: light denied on create_land_area as expected:', negMsg);

  console.log('mig139 light smoke ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
