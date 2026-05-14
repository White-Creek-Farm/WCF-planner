// Verify-only follow-up for migration 056 against TEST. The apply script
// already landed the SQL; this script seeds minimal layer_batches +
// layer_housings rows (TEST has none), runs the four probes that needed
// real rows, and tears the seed rows down afterward. Reads the same
// .env.test + .env.test.local as apply_migration_056.cjs.
//
// Probes the apply script couldn't drive without seed data:
//   - anon DELETE layer_batches
//   - anon UPDATE layer_housings.current_count on an active row
//   - anon UPDATE layer_housings.status (column-scoped block)
//   - anon UPDATE layer_housings on a retired row (policy filter)
//
// Usage: node scripts/verify_migration_056.cjs

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
  if (!url || !anonKey || !serviceKey) {
    console.error('Missing TEST env vars');
    process.exit(1);
  }
  if (process.env.WCF_TEST_DATABASE !== '1' || url.includes('pzfujbjtayhkdlxiblwe')) {
    console.error('Refusing — not TEST');
    process.exit(1);
  }

  const sbAdmin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const sbAnon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

  // ── Seed minimal rows (cleanup tracked for teardown). Use suffix
  // 'probe056' so the script can mop up its own rows even on partial run.
  const lbId = 'probe056-lb-' + Date.now();
  const lhActiveId = 'probe056-lh-active-' + Date.now();
  const lhRetiredId = 'probe056-lh-retired-' + Date.now();

  async function teardown() {
    await sbAdmin.from('layer_housings').delete().like('id', 'probe056-%');
    await sbAdmin.from('layer_batches').delete().like('id', 'probe056-%');
  }

  try {
    // Seed
    const lbIns = await sbAdmin.from('layer_batches').insert({id: lbId, name: 'L-PROBE-01', status: 'active'});
    if (lbIns.error) throw new Error('seed layer_batches: ' + lbIns.error.message);

    const lhActiveIns = await sbAdmin.from('layer_housings').insert({
      id: lhActiveId,
      batch_id: lbId,
      housing_name: 'Probe Housing Active',
      status: 'active',
      current_count: 100,
      current_count_date: '2026-05-14',
    });
    if (lhActiveIns.error) throw new Error('seed lh active: ' + lhActiveIns.error.message);

    const lhRetiredIns = await sbAdmin.from('layer_housings').insert({
      id: lhRetiredId,
      batch_id: lbId,
      housing_name: 'Probe Housing Retired',
      status: 'retired',
      current_count: 50,
      current_count_date: '2026-01-01',
    });
    if (lhRetiredIns.error) throw new Error('seed lh retired: ' + lhRetiredIns.error.message);

    const probes = [];
    function record(label, expected, actual, error) {
      probes.push({label, expected, actual, error: error ? error.message || String(error) : null});
    }

    // Probe A: anon DELETE layer_batches — expected blocked (no DELETE grant).
    {
      const r = await sbAnon.from('layer_batches').delete().eq('id', lbId);
      record('anon DELETE layer_batches', 'blocked', r.error ? 'blocked' : 'ok', r.error);
    }

    // Probe B: anon UPDATE layer_housings.current_count (active row) — expected ok.
    {
      const r = await sbAnon
        .from('layer_housings')
        .update({current_count: 101, current_count_date: '2026-05-15'})
        .eq('id', lhActiveId);
      let actualOk = !r.error;
      if (actualOk) {
        // Verify the value actually changed (anon UPDATE with row predicate
        // returning 0 rows still returns success — must read back).
        const {data} = await sbAdmin
          .from('layer_housings')
          .select('current_count, current_count_date')
          .eq('id', lhActiveId)
          .maybeSingle();
        actualOk = data && data.current_count === 101 && data.current_count_date === '2026-05-15';
      }
      record('anon UPDATE layer_housings.current_count (active row)', 'ok', actualOk ? 'ok' : 'blocked', r.error);
    }

    // Probe C: anon UPDATE layer_housings.status — expected blocked (column not granted).
    {
      const r = await sbAnon.from('layer_housings').update({status: 'retired'}).eq('id', lhActiveId);
      // Column-scoped GRANT misses → PostgREST surfaces a permission-denied error.
      let actualBlocked = !!r.error;
      if (!r.error) {
        // Defensive: re-read to confirm the column did not change.
        const {data} = await sbAdmin.from('layer_housings').select('status').eq('id', lhActiveId).maybeSingle();
        actualBlocked = data && data.status === 'active';
      }
      record(
        'anon UPDATE layer_housings.status (column-scoped block)',
        'blocked',
        actualBlocked ? 'blocked' : 'ok',
        r.error,
      );
    }

    // Probe D: anon UPDATE layer_housings on retired row — expected blocked (policy filter).
    {
      const r = await sbAnon
        .from('layer_housings')
        .update({current_count: 9999, current_count_date: '2026-12-31'})
        .eq('id', lhRetiredId);
      // RLS UPDATE filter returns 0 rows affected (no error). Confirm via read.
      let actualBlocked = !!r.error;
      if (!r.error) {
        const {data} = await sbAdmin
          .from('layer_housings')
          .select('current_count, current_count_date')
          .eq('id', lhRetiredId)
          .maybeSingle();
        actualBlocked = data && data.current_count === 50 && data.current_count_date === '2026-01-01';
      }
      record(
        'anon UPDATE layer_housings (retired row, policy block)',
        'blocked',
        actualBlocked ? 'blocked' : 'ok',
        r.error,
      );
    }

    // Probe E: anon DELETE layer_housings — expected blocked.
    {
      const r = await sbAnon.from('layer_housings').delete().eq('id', lhActiveId);
      record('anon DELETE layer_housings', 'blocked', r.error ? 'blocked' : 'ok', r.error);
    }

    console.log('Functional probes (with seed):');
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
      process.exitCode = 2;
    } else {
      console.log('\nAll seed-driven probes PASS.');
    }
  } finally {
    await teardown();
  }
})();
