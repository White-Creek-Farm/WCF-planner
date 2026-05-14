// One-shot applier for migration 056 against the TEST Supabase project.
// Mirrors scripts/apply_migration_055.cjs: reads .env.test + .env.test.local,
// refuses to run unless WCF_TEST_DATABASE=1 and the URL does not match the
// PROD project ref, strips the outer BEGIN/COMMIT (exec_sql cannot EXECUTE
// transaction boundaries from inside its function body), and runs the
// migration in a single exec_sql call.
//
// Post-apply: runs functional probes as anon and service_role to verify
// the policy matrix matches the intent:
//   - anon SELECT layer_batches → ok
//   - anon INSERT layer_batches → blocked
//   - anon DELETE layer_batches → blocked
//   - anon UPDATE layer_housings.current_count on active row → ok
//   - anon UPDATE layer_housings.status → blocked (column-scoped grant)
//   - anon UPDATE layer_housings on retired row → blocked (policy filter)
//   - authenticated admin CRUD → ok (probed via service_role for parity)
//
// Usage: node scripts/apply_migration_056.cjs

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
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !anonKey) {
    console.error('Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY');
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

  const sbAdmin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const sbAnon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

  // ── Pre-apply: snapshot which backup tables exist on TEST so the
  // report shows exactly what the to_regclass guard skipped vs touched.
  const BACKUPS = [
    '_backup_app_store',
    '_backup_app_store_apr11_brooderin',
    '_backup_app_store_apr11_brooderin_v3',
    '_backup_app_store_apr11_feedcost',
    '_backup_egg_dailys',
    '_backup_layer_batches',
    '_backup_layer_batches_apr11_2026',
    '_backup_layer_batches_apr11_feedcost',
    '_backup_layer_batches_apr11_l2601',
    '_backup_layer_batches_apr11_phase2',
    '_backup_layer_dailys',
    '_backup_layer_dailys_apr11_batchid',
    '_backup_layer_dailys_apr11_batchid_v2',
    '_backup_layer_dailys_apr11_podio_insert',
    '_backup_layer_housings',
    '_backup_layer_housings_apr11_l2601',
    '_backup_layer_housings_apr11pm',
    '_backup_webform_config',
  ];
  const backupPresence = {};
  for (const t of BACKUPS) {
    // exec_sql can run a SELECT and we observe via DO RAISE NOTICE? No —
    // exec_sql returns no rowset. Use a tiny INSERT/SELECT trick via the
    // existence-check pattern: try SELECT 1 with limit 0 via PostgREST
    // (works only if PostgREST exposes the table). Backup tables ARE in
    // public, so they should be queryable by service_role today.
    const {error} = await sbAdmin.from(t).select('*').limit(0);
    backupPresence[t] = !error;
  }

  // ── Apply the migration.
  const file = '056_rls_layer_tables_and_backups.sql';
  const sqlPath = path.resolve(__dirname, '..', 'supabase-migrations', file);
  let sql = fs.readFileSync(sqlPath, 'utf8');
  // Strip outer BEGIN/COMMIT (anchored to start-of-line) — must not touch
  // plpgsql BEGIN/END inside the DO $$ … $$ block.
  sql = sql.replace(/^\s*BEGIN\s*;\s*$/gim, '').replace(/^\s*COMMIT\s*;\s*$/gim, '');

  process.stdout.write(`applying ${file} ... `);
  const {error: applyErr} = await sbAdmin.rpc('exec_sql', {sql});
  if (applyErr) {
    console.error('FAILED');
    console.error(applyErr);
    process.exit(1);
  }
  console.log('OK');

  // ── Functional probes. Each probe records {label, expected, actual}.
  const probes = [];
  function record(label, expected, actual, error) {
    probes.push({label, expected, actual, error: error ? error.message || String(error) : null});
  }

  // Snapshot a layer_batches row + a layer_housings row to drive UPDATE
  // probes. Use service_role so RLS doesn't filter.
  const {data: lbRows} = await sbAdmin.from('layer_batches').select('id, name, status').limit(1);
  const {data: lhActiveRows} = await sbAdmin
    .from('layer_housings')
    .select('id, housing_name, status, current_count, current_count_date')
    .eq('status', 'active')
    .limit(1);
  const {data: lhRetiredRows} = await sbAdmin
    .from('layer_housings')
    .select('id, housing_name, status')
    .eq('status', 'retired')
    .limit(1);

  // Probe 1: anon SELECT layer_batches — expected ok.
  {
    const r = await sbAnon.from('layer_batches').select('id').limit(1);
    record('anon SELECT layer_batches', 'ok', r.error ? 'blocked' : 'ok', r.error);
  }

  // Probe 2: anon INSERT layer_batches — expected blocked.
  {
    const r = await sbAnon.from('layer_batches').insert({id: 'probe-' + Date.now(), name: 'PROBE'});
    record('anon INSERT layer_batches', 'blocked', r.error ? 'blocked' : 'ok', r.error);
  }

  // Probe 3: anon DELETE layer_batches — expected blocked.
  if (lbRows && lbRows[0]) {
    const r = await sbAnon.from('layer_batches').delete().eq('id', lbRows[0].id);
    record('anon DELETE layer_batches', 'blocked', r.error ? 'blocked' : 'ok', r.error);
  } else {
    record('anon DELETE layer_batches', 'blocked', 'no_row_to_probe', null);
  }

  // Probe 4: anon SELECT layer_housings — expected ok.
  {
    const r = await sbAnon.from('layer_housings').select('id').limit(1);
    record('anon SELECT layer_housings', 'ok', r.error ? 'blocked' : 'ok', r.error);
  }

  // Probe 5: anon INSERT layer_housings — expected blocked.
  {
    const r = await sbAnon.from('layer_housings').insert({id: 'probe-' + Date.now(), housing_name: 'PROBE'});
    record('anon INSERT layer_housings', 'blocked', r.error ? 'blocked' : 'ok', r.error);
  }

  // Probe 6: anon UPDATE layer_housings.current_count on active row — expected ok.
  if (lhActiveRows && lhActiveRows[0]) {
    const target = lhActiveRows[0];
    const newCount = (target.current_count || 0) + 0; // round-trip same value to avoid drift
    const r = await sbAnon
      .from('layer_housings')
      .update({current_count: newCount, current_count_date: target.current_count_date})
      .eq('id', target.id);
    record('anon UPDATE layer_housings.current_count (active row)', 'ok', r.error ? 'blocked' : 'ok', r.error);
  } else {
    record(
      'anon UPDATE layer_housings.current_count (active row)',
      'ok',
      'no_active_row_to_probe',
      new Error('No status=active row in test layer_housings; cannot validate column-scoped UPDATE path'),
    );
  }

  // Probe 7: anon UPDATE layer_housings.status — expected blocked (column not granted).
  if (lhActiveRows && lhActiveRows[0]) {
    const r = await sbAnon.from('layer_housings').update({status: 'active'}).eq('id', lhActiveRows[0].id);
    record('anon UPDATE layer_housings.status (column-scoped block)', 'blocked', r.error ? 'blocked' : 'ok', r.error);
  } else {
    record('anon UPDATE layer_housings.status (column-scoped block)', 'blocked', 'no_row_to_probe', null);
  }

  // Probe 8: anon UPDATE layer_housings on retired row — expected blocked (policy filter).
  if (lhRetiredRows && lhRetiredRows[0]) {
    const r = await sbAnon
      .from('layer_housings')
      .update({current_count: 0, current_count_date: '2026-01-01'})
      .eq('id', lhRetiredRows[0].id);
    // RLS UPDATE block typically returns 0 rows (silently) when the row
    // predicate fails, not a hard error. Treat "no error but affected rows
    // 0" as blocked. The .update returns no count by default; we can read
    // back the row to verify the value didn't change.
    if (r.error) {
      record('anon UPDATE layer_housings (retired row, policy block)', 'blocked', 'blocked', r.error);
    } else {
      // Re-read and check the value stayed put.
      const {data: after} = await sbAdmin
        .from('layer_housings')
        .select('current_count, current_count_date')
        .eq('id', lhRetiredRows[0].id)
        .maybeSingle();
      const actualBlock = !after || (after.current_count !== 0 && after.current_count_date !== '2026-01-01');
      record('anon UPDATE layer_housings (retired row, policy block)', 'blocked', actualBlock ? 'blocked' : 'ok', null);
    }
  } else {
    record('anon UPDATE layer_housings (retired row, policy block)', 'blocked', 'no_retired_row_to_probe', null);
  }

  // Probe 9: service_role / authenticated parity check via service_role
  // (service_role bypasses RLS so this confirms baseline writes still work).
  if (lbRows && lbRows[0]) {
    const r = await sbAdmin.from('layer_batches').update({name: lbRows[0].name}).eq('id', lbRows[0].id);
    record('service_role UPDATE layer_batches', 'ok', r.error ? 'blocked' : 'ok', r.error);
  }

  // ── Report.
  console.log('\nBackup table presence on TEST:');
  for (const [t, present] of Object.entries(backupPresence)) {
    console.log(`  ${present ? 'present' : 'MISSING'}  ${t}`);
  }

  console.log('\nFunctional probes:');
  let failures = 0;
  for (const p of probes) {
    const passed = p.actual === p.expected;
    if (!passed) failures += 1;
    console.log(
      `  ${passed ? 'PASS' : 'FAIL'}  ${p.label}  expected=${p.expected} actual=${p.actual}${
        p.error ? '  err=' + p.error : ''
      }`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} probe(s) failed. NOT moving to PROD.`);
    process.exit(2);
  }

  console.log('\nMigration 056 applied to TEST and functional probes pass.');
})();
