// Apply mig 141 (Pasture Map saved distance measurements) to TEST via exec_sql.
// Hard PROD-ref guard. Smokes the measurement RPCs as a real 'light' user so the
// farm_team-level gate + grants are proven before any client wiring or Playwright.
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

const LIGHT_EMAIL = 'light141smoke@wcfplanner.test';
const LIGHT_PASSWORD = 'Light141Smoke!';

if (!url || !serviceKey || !anonKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const admin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

async function ensureLightUser() {
  const existing = await admin.auth.admin.listUsers();
  let user = existing.data && existing.data.users ? existing.data.users.find((u) => u.email === LIGHT_EMAIL) : null;
  if (!user) {
    const created = await admin.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: LIGHT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error('create light user: ' + created.error.message);
    user = created.data.user;
  } else {
    await admin.auth.admin.updateUserById(user.id, {password: LIGHT_PASSWORD, email_confirm: true});
  }
  const {error} = await admin
    .from('profiles')
    .upsert({id: user.id, email: LIGHT_EMAIL, full_name: 'Light 141 Smoke', role: 'light'}, {onConflict: 'id'});
  if (error) throw new Error('upsert light profile: ' + error.message);
  return user;
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '141_pasture_map_measurements.sql'),
    'utf8',
  );
  console.log(`applying 141_pasture_map_measurements.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const user = await ensureLightUser();
  console.log('light smoke user id=' + user.id);
  const {error: signErr} = await authed.auth.signInWithPassword({email: LIGHT_EMAIL, password: LIGHT_PASSWORD});
  if (signErr) {
    console.error('signIn failed:', signErr.message || signErr);
    process.exit(1);
  }

  const MID = 'meas-smoke-141';
  const GEOM = {
    type: 'LineString',
    coordinates: [
      [-86.44, 30.84],
      [-86.435, 30.84],
    ],
  };
  const {error: createErr} = await authed.rpc('create_pasture_measurement', {
    p_id: MID,
    p_name: 'Smoke fence run',
    p_geometry: GEOM,
    p_distance_ft: 1500,
    p_line_color: '#2563eb',
  });
  if (createErr) {
    console.error('create_pasture_measurement failed:', createErr.message || createErr);
    process.exit(1);
  }

  const {data: list1, error: listErr} = await authed.rpc('list_pasture_measurements', {});
  if (listErr) {
    console.error('list_pasture_measurements failed:', listErr.message || listErr);
    process.exit(1);
  }
  const found = (list1.measurements || []).find((m) => m.id === MID);
  if (!found || found.name !== 'Smoke fence run' || found.geometry.type !== 'LineString') {
    console.error('measurement not found / wrong shape:', JSON.stringify(list1.measurements));
    process.exit(1);
  }

  const {data: del, error: delErr} = await authed.rpc('delete_pasture_measurement', {p_id: MID});
  if (delErr) {
    console.error('delete_pasture_measurement failed:', delErr.message || delErr);
    process.exit(1);
  }
  if (!del || del.deleted !== true) {
    console.error('unexpected delete response:', JSON.stringify(del));
    process.exit(1);
  }

  console.log('mig141 measurement smoke ok: light create -> list -> delete roundtrip');
})();
