// One-shot applier for migration 054 against the TEST Supabase project.
// Mirrors scripts/apply_test_offline_migrations.cjs: reads .env.test +
// .env.test.local, refuses to run unless WCF_TEST_DATABASE=1 and the URL
// does not match the PROD project ref, then drives the ALTER TABLE
// statements through public.exec_sql under service_role. Migration body
// is identical to supabase-migrations/054_cattle_processing_scheduled_status.sql.
//
// Usage: node scripts/apply_migration_054.cjs

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

  const statements = [
    `ALTER TABLE cattle_processing_batches DROP CONSTRAINT IF EXISTS cattle_processing_batches_status_check;`,
    `ALTER TABLE cattle_processing_batches ADD CONSTRAINT cattle_processing_batches_status_check CHECK (status IN ('active', 'complete', 'scheduled'));`,
  ];

  for (const stmt of statements) {
    console.log('Applying:', stmt.slice(0, 80) + (stmt.length > 80 ? '...' : ''));
    const {error} = await sb.rpc('exec_sql', {sql: stmt});
    if (error) {
      console.error('FAILED:', error.message || error);
      process.exit(2);
    }
  }

  // Verify the new CHECK is in place.
  const {data, error} = await sb.rpc('exec_sql', {
    sql: `SELECT 1 FROM pg_constraint WHERE conname = 'cattle_processing_batches_status_check' AND pg_get_constraintdef(oid) LIKE '%scheduled%' LIMIT 1;`,
  });
  // exec_sql is void-only; we can only confirm the lack of error here.
  if (error) {
    console.warn('Post-apply check rpc returned error (non-fatal):', error.message || error);
  } else {
    console.log('Post-apply rpc completed without error.', data ? 'data:' + JSON.stringify(data) : '');
  }
  console.log('Migration 054 applied to TEST.');
})();
