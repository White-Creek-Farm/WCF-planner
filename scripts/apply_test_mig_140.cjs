// Apply mig 140 (Pasture Map shared persisted rotations) to TEST via exec_sql.
// Hard PROD-ref guard. Smokes the rotation RPCs as a real 'light' user so the
// farm_team-level gate + PostgREST cache/grants are proven before any client
// wiring or Playwright.
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

const LIGHT_EMAIL = 'light140smoke@wcfplanner.test';
const LIGHT_PASSWORD = 'Light140Smoke!';

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
    .upsert({id: user.id, email: LIGHT_EMAIL, full_name: 'Light 140 Smoke', role: 'light'}, {onConflict: 'id'});
  if (error) throw new Error('upsert light profile: ' + error.message);
  return user;
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '140_pasture_map_rotations.sql'),
    'utf8',
  );
  console.log(`applying 140_pasture_map_rotations.sql (${body.length} bytes)`);
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

  // upsert: light builds a rotation whose stop order is deliberately NOT sorted, to
  // prove jsonb_agg(... ORDER BY elem.ord) preserves the manual path order.
  const KEY = 'mommas-smoke-140';
  const ORDER = ['rot-smoke-z', 'rot-smoke-a', 'rot-smoke-m', 'rot-smoke-b'];
  const {data: up, error: upErr} = await authed.rpc('upsert_pasture_rotation', {
    p_animal_type: 'cattle_herd',
    p_group_key: KEY,
    p_area_ids: ORDER,
  });
  if (upErr) {
    console.error('upsert_pasture_rotation failed:', upErr.message || upErr);
    process.exit(1);
  }
  if (!up || JSON.stringify(up.area_ids) !== JSON.stringify(ORDER)) {
    console.error(
      'upsert did not preserve order. expected',
      JSON.stringify(ORDER),
      'got',
      JSON.stringify(up && up.area_ids),
    );
    process.exit(1);
  }

  // list: the rotation is visible AND its stop order round-trips EXACTLY.
  const {data: list1, error: listErr} = await authed.rpc('list_pasture_rotations', {});
  if (listErr) {
    console.error('list_pasture_rotations failed:', listErr.message || listErr);
    process.exit(1);
  }
  const found = (list1.rotations || []).find((r) => r.group_key === KEY && r.animal_type === 'cattle_herd');
  if (!found || JSON.stringify(found.area_ids) !== JSON.stringify(ORDER)) {
    console.error(
      'list read-back lost order. expected',
      JSON.stringify(ORDER),
      'got',
      JSON.stringify(found && found.area_ids),
    );
    process.exit(1);
  }

  // clear: the row is removed.
  const {error: clrErr} = await authed.rpc('clear_pasture_rotation', {
    p_animal_type: 'cattle_herd',
    p_group_key: KEY,
  });
  if (clrErr) {
    console.error('clear_pasture_rotation failed:', clrErr.message || clrErr);
    process.exit(1);
  }
  const {data: list2} = await authed.rpc('list_pasture_rotations', {});
  if ((list2.rotations || []).some((r) => r.group_key === KEY)) {
    console.error('rotation still present after clear:', JSON.stringify(list2.rotations));
    process.exit(1);
  }

  console.log('mig140 rotation smoke ok: light upsert -> list -> clear roundtrip (manual order preserved)');
})();
