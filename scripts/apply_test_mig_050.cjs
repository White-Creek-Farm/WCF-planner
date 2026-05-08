// Applier for mig 050 (Tasks v2 task_instances columns + FK adjustment).
// Mirrors apply_test_mig_049.cjs.
//
// Idempotent — every change uses ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT
// IF EXISTS / CREATE INDEX IF NOT EXISTS. Re-runnable.
//
// Usage: node scripts/apply_test_mig_050.cjs

const fs = require('fs');
const path = require('path');

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env.test'));
loadEnvFile(path.resolve(__dirname, '..', '.env.test.local'));

const {createClient} = require('@supabase/supabase-js');

(async () => {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (process.env.WCF_TEST_DATABASE !== '1') {
    console.error('Refusing — WCF_TEST_DATABASE must be 1');
    process.exit(1);
  }
  if (url.includes('pzfujbjtayhkdlxiblwe')) {
    console.error('Refusing — URL matches PROD project ref');
    process.exit(1);
  }

  const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

  const file = '050_tasks_v2_instance_columns.sql';
  const sqlPath = path.resolve(__dirname, '..', 'supabase-migrations', file);
  let sql = fs.readFileSync(sqlPath, 'utf8');
  sql = sql.replace(/^\s*BEGIN\s*;\s*$/gim, '').replace(/^\s*COMMIT\s*;\s*$/gim, '');
  process.stdout.write(`applying ${file} ... `);
  const {error} = await sb.rpc('exec_sql', {sql});
  if (error) {
    console.error('FAILED');
    console.error(error);
    process.exit(1);
  }
  console.log('OK');
  console.log('done.');
})();
