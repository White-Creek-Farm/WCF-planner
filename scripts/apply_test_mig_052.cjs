// Applier for mig 052 (Tasks v2 task_system_rules + Simon/Mak seed).
//
// TEST DB workflow: ensures Simon and Mak profiles exist (with stable
// deterministic UUIDs) BEFORE running the migration, then applies the
// migration. The migration's seed will succeed because both names
// resolve to exactly one eligible profile.
//
// PROD workflow: admin ensures Simon and Mak exist as eligible profiles
// (role != 'inactive', unique full_name match) by hand BEFORE running the
// PROD migration. The migration's fail-closed seed is the safety net.
//
// Idempotent: profile creation uses upsert by id, mig itself uses
// CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING.

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

async function ensureTestProfile(sb, {fullName, email}) {
  // Check if a profile already exists by full_name (case-insensitive,
  // eligible). If so, leave it alone — admin may have set up the row by
  // hand already.
  const {data: existing} = await sb
    .from('profiles')
    .select('id, full_name, role')
    .ilike('full_name', fullName)
    .neq('role', 'inactive');
  if (existing && existing.length === 1) {
    process.stdout.write(`profile "${fullName}" already exists (${existing[0].id})\n`);
    return existing[0].id;
  }
  if (existing && existing.length > 1) {
    throw new Error(
      `apply_test_mig_052: ambiguous profile match for "${fullName}" (${existing.length} eligible matches)`,
    );
  }

  // Create auth user → triggers profile row via the auth handler. Then
  // upsert the profile to set our deterministic UUID + full_name + role.
  // For TEST, we go direct via service role.
  const {data: created, error: createErr} = await sb.auth.admin.createUser({
    email,
    password: 'apply_test_mig_052_placeholder_password',
    email_confirm: true,
    user_metadata: {full_name: fullName},
  });
  if (createErr && !/already.*registered/i.test(createErr.message || '')) {
    throw createErr;
  }
  let resolvedId = created && created.user ? created.user.id : null;

  // If the user already existed, look it up by email to recover the id.
  if (!resolvedId) {
    const {data: list, error: listErr} = await sb.auth.admin.listUsers();
    if (listErr) throw listErr;
    const found = (list && list.users ? list.users : []).find(
      (u) => (u.email || '').toLowerCase() === email.toLowerCase(),
    );
    if (!found) {
      throw new Error(`apply_test_mig_052: cannot resolve auth user for "${fullName}" (${email})`);
    }
    resolvedId = found.id;
  }

  // Upsert the profile row.
  const {error: profErr} = await sb.from('profiles').upsert(
    {
      id: resolvedId,
      email,
      full_name: fullName,
      role: 'farm_team',
    },
    {onConflict: 'id'},
  );
  if (profErr) throw profErr;
  process.stdout.write(`ensured profile "${fullName}" (${resolvedId})\n`);
  return resolvedId;
}

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

  // Pre-create Simon and Mak profiles so the seed inside mig 052 resolves.
  await ensureTestProfile(sb, {fullName: 'Simon', email: 'simon.tasks@wcfplanner.test'});
  await ensureTestProfile(sb, {fullName: 'Mak', email: 'mak.tasks@wcfplanner.test'});

  const file = '052_tasks_v2_system_rules.sql';
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
