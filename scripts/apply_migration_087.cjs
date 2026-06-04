// One-off: apply migration 087 (profiles.role 'light') to the TEST Supabase
// project via the exec_sql SECDEF RPC. Reads env from .env.test +
// .env.test.local. Mirrors scripts/apply_migration_test.cjs.
//
// Usage:
//   node scripts/apply_migration_087.cjs

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

const file = path.join(__dirname, '..', 'supabase-migrations', '087_profiles_role_light.sql');
const sql = fs.readFileSync(file, 'utf8');

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(2);
}
// Hard guard: refuse to run against the PROD URL.
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (url.includes(PROD_REF)) {
  console.error('refusing to run apply_migration_087 against PROD URL');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

(async () => {
  console.log(`TEST DB url=${url}`);
  console.log(`applying ${path.basename(file)} (${sql.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql});
  if (error) {
    console.error('exec_sql failed:', error.message || error);
    process.exit(1);
  }
  console.log('applied OK');

  // Post-apply verification: the constraint definition must now include 'light'
  // and still include every prior role value (strict superset, no regression).
  const checks = [
    {
      label: 'profiles_role_check definition',
      sql: `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='profiles_role_check' AND conrelid='public.profiles'::regclass;`,
    },
  ];
  for (const c of checks) {
    const {data, error: e2} = await sb.rpc('exec_sql', {sql: `SELECT json_agg(t) FROM (${c.sql}) t;`});
    if (e2) {
      console.log(`  ${c.label}: ERROR ${e2.message}`);
    } else {
      console.log(`  ${c.label}:`, JSON.stringify(data));
    }
  }
  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
