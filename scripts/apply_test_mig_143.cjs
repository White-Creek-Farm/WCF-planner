// Apply mig 143 (Pasture Map reset-area-grazing-history RPC) to TEST via exec_sql.
// Hard PROD-ref guard. Smokes the new RPC as the admin user: a missing id must
// raise the not-found PM_VALIDATION (proving the function exists, the management/
// admin gate passes for admin, and the grant to authenticated works) before any
// Playwright run.
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

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '143_pasture_map_reset_area_history.sql'),
    'utf8',
  );
  console.log(`applying 143_pasture_map_reset_area_history.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) {
    console.error('admin signIn failed:', signErr.message || signErr);
    process.exit(1);
  }

  const {error: rpcErr} = await authed.rpc('delete_land_area_grazing_history', {p_id: 'no-such-area-143-smoke'});
  if (!rpcErr) {
    console.error('expected a not-found error for a missing area, got success');
    process.exit(1);
  }
  const msg = rpcErr.message || String(rpcErr);
  if (!/not found/i.test(msg)) {
    console.error('unexpected error (function/gate may be wrong):', msg);
    process.exit(1);
  }
  console.log('mig143 reset-history smoke ok: admin call on missing id -> "' + msg + '"');
})();
