// Applier for migration 048 (equipment_service_materials + equipment_material_clears
// + approved seed) against the test Supabase project. Mirrors
// apply_test_mig_047.cjs:
// reads .env.test + .env.test.local, validates we're not pointed at prod,
// strips outer BEGIN/COMMIT (exec_sql cannot EXECUTE transaction
// boundaries from inside its function body), runs the migration via
// exec_sql.
//
// Idempotent — every CREATE uses IF NOT EXISTS; the seed uses ON CONFLICT
// DO NOTHING. Re-running is a no-op.
//
// Usage: node scripts/apply_test_mig_048.cjs

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

  const file = '048_equipment_service_materials.sql';
  const sqlPath = path.resolve(__dirname, '..', 'supabase-migrations', file);
  let sql = fs.readFileSync(sqlPath, 'utf8');
  // exec_sql runs SQL inside a function body; PostgreSQL refuses EXECUTE of
  // top-level BEGIN/COMMIT in that context. Strip ONLY the outer transaction
  // markers (require the trailing semicolon — `BEGIN` without a semicolon
  // appears inside plpgsql function bodies). The RPC call itself is the
  // transaction boundary.
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
