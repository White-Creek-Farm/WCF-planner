// Apply mig 109 (drop the dead daily_photos_anon_insert storage policy) to TEST
// via exec_sql. Single BEGIN/COMMIT-free DROP POLICY IF EXISTS. Hard PROD-ref
// guard. After apply, smokes that the anon INSERT policy is GONE and that both
// live policies remain: daily_photos_auth_insert (099 upload path) and
// daily_photos_auth_select (031 signed-URL read). exec_sql returns void, so
// every guard RAISEs to surface a wrong state.
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
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !key) {
  console.error('missing TEST env');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}
const file = path.join(__dirname, '..', 'supabase-migrations', '109_drop_daily_photos_anon_insert.sql');
const body = fs.readFileSync(file, 'utf8');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 109 body (${body.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');

  const smokes = [
    {
      label: 'daily_photos_anon_insert policy is GONE on storage.objects',
      sql: `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='storage' AND tablename='objects'
                          AND policyname='daily_photos_anon_insert')
        THEN RAISE EXCEPTION 'daily_photos_anon_insert still present after drop'; END IF;
      END $$;`,
    },
    {
      label: 'daily_photos_auth_insert (099 upload path) still present',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname='storage' AND tablename='objects'
                              AND policyname='daily_photos_auth_insert')
        THEN RAISE EXCEPTION 'daily_photos_auth_insert missing — live upload path broken'; END IF;
      END $$;`,
    },
    {
      label: 'daily_photos_auth_select (031 read path) still present',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname='storage' AND tablename='objects'
                              AND policyname='daily_photos_auth_select')
        THEN RAISE EXCEPTION 'daily_photos_auth_select missing — signed-URL read path broken'; END IF;
      END $$;`,
    },
  ];

  let allOk = true;
  for (const s of smokes) {
    const {error: e2} = await sb.rpc('exec_sql', {sql: s.sql});
    if (e2) allOk = false;
    console.log(`  smoke ${s.label}: ${e2 ? 'ERROR ' + (e2.message || e2) : 'OK'}`);
  }
  console.log(allOk ? 'done OK' : 'done WITH ERRORS');
  if (!allOk) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
