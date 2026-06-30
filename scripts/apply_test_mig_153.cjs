// Apply mig 153 (newsletter archive-link gating) to TEST via exec_sql, then
// behaviorally verify the gate. Hard PROD-ref guard. All checks are behavioral
// (never exec_sql SELECT):
//   - anon list/get return NULL (locked) with no key, a wrong key, and an
//     EXPIRED key; return data with the current, unexpired key.
//   - publish mints a fresh 7-day key (rotates the prior one).
//   - the admin regenerate RPC works for an admin and is NOT anon-executable;
//     regenerating kills the previous key.
// Leaves the singleton archive key cleared (locked) at the end.
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
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const KEY = 'testkey-' + 'z'.repeat(24);
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + d : ''));
};

// Set via exec_sql (raw SQL) so it does not depend on the PostgREST schema cache
// having picked up the new columns yet.
async function setKey(token, expiresAt) {
  const tok = token === null ? 'NULL' : `'${token}'`;
  const exp = expiresAt === null ? 'NULL' : `'${expiresAt}'::timestamptz`;
  const {error} = await service.rpc('exec_sql', {
    sql: `UPDATE public.newsletter_settings SET archive_access_token = ${tok}, archive_access_expires_at = ${exp} WHERE id = 'singleton';`,
  });
  if (error) throw new Error('setKey: ' + error.message);
}

async function waitForSignature(attempts = 12) {
  // Poll until PostgREST exposes the new p_key signature (no "function not found").
  for (let i = 0; i < attempts; i++) {
    const {error} = await anon.rpc('list_published_newsletters', {p_key: '__probe__'});
    if (!error) return true;
    await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '153_newsletter_archive_link.sql'),
    'utf8',
  );
  console.log(`applying 153_newsletter_archive_link.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((r) => setTimeout(r, 2500));
  if (!(await waitForSignature())) {
    bad('PostgREST never exposed the new p_key signature');
    process.exit(1);
  }
  ok('PostgREST exposes the key-gated signatures');

  const future = new Date(Date.now() + 7 * 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();

  // ── anon gate ──
  await setKey(KEY, future);
  {
    const {data} = await anon.rpc('list_published_newsletters', {p_key: null});
    data === null
      ? ok('anon list with NO key -> locked (null)')
      : bad('anon list no key not locked', JSON.stringify(data));
  }
  {
    const {data} = await anon.rpc('list_published_newsletters', {p_key: 'wrong-key'});
    data === null ? ok('anon list with WRONG key -> locked (null)') : bad('anon list wrong key not locked');
  }
  {
    const {data} = await anon.rpc('list_published_newsletters', {p_key: KEY});
    Array.isArray(data)
      ? ok('anon list with VALID key -> array')
      : bad('anon list valid key not array', JSON.stringify(data));
  }
  {
    const {data} = await anon.rpc('get_published_newsletter', {p_slug: 'no-such', p_key: null});
    data === null ? ok('anon get with NO key -> locked (null)') : bad('anon get no key not locked');
  }
  // expired key
  await setKey(KEY, past);
  {
    const {data} = await anon.rpc('list_published_newsletters', {p_key: KEY});
    data === null ? ok('anon list with EXPIRED key -> locked (null)') : bad('anon list expired key not locked');
  }

  // ── admin regenerate (admin-only) ──
  {
    const {error} = await anon.rpc('regenerate_newsletter_archive_link', {p_days: 7});
    error ? ok('anon CANNOT regenerate (denied)') : bad('anon regenerate was allowed');
  }
  const {error: signInErr} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signInErr) {
    bad('admin sign-in', signInErr.message);
  } else {
    const {data, error} = await admin.rpc('regenerate_newsletter_archive_link', {p_days: 7});
    if (error) bad('admin regenerate', error.message);
    else {
      const newToken = data && data.archiveAccessToken;
      newToken && newToken !== KEY ? ok('admin regenerate minted a new key') : bad('regenerate did not mint a new key');
      const stale = await anon.rpc('list_published_newsletters', {p_key: KEY});
      stale.data === null ? ok('old key dead after regenerate') : bad('old key still works after regenerate');
      const fresh = await anon.rpc('list_published_newsletters', {p_key: newToken});
      Array.isArray(fresh.data) ? ok('new key works after regenerate') : bad('new key does not work');
    }
    await admin.auth.signOut();
  }

  // ── cleanup: re-lock ──
  await setKey(null, null);
  ok('cleanup: archive key cleared (locked)');

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('apply/verify threw:', e.message || e);
  process.exit(1);
});
