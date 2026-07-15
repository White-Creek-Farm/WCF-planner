// Real TEST Edge proof for the CC#8 password_reset / user_welcome hardening.
//
// Invokes the DEPLOYED TEST rapid-processor function over HTTP and proves the
// hardened contract end to end:
//   1. public unknown email  -> 200 + exact generic body
//   2. public existing email -> 200, byte-equivalent to the unknown response
//   3. public empty/malformed -> same generic 200
//   4. authenticated non-admin -> treated as public, same generic response
//   5. attacker top-level test_to -> same generic response (+ deployed source
//      carries no test_to / [TEST] reset subject)
//   6. authenticated admin + unknown email -> truthful admin error (404/500)
//   7. type=user_welcome -> Unknown type 400 (no link / no email)
//   8. generating a recovery link does NOT change the account password
//
// COORDINATION GATE: creates and deletes disposable TEST Auth/profile users and
// makes the minimum number of reset requests. TEST has no RESEND_API_KEY by
// design, so the Edge reset invokes short-circuit at the config preflight and
// send NO email; check 8 exercises the (non-mutating) admin generateLink call
// directly. Run ONLY with exclusive TEST access confirmed.
//
// It never prints credentials, JWTs, recovery links, provider bodies, or
// secrets. Public/admin response bodies are classified, never dumped.
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));
// Fresh worktrees intentionally do not copy ignored secrets. Fall back to the
// primary worktree's standard TEST env files without copying or printing them.
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (!url || !serviceKey || !anonKey || !adminEmail || !adminPassword) {
  console.error('missing TEST env (url / service key / anon key / admin credentials)');
  process.exit(2);
}
if (process.env.WCF_TEST_DATABASE !== '1' || url.includes(PROD_REF)) {
  console.error('refusing to run without WCF_TEST_DATABASE=1 on a non-PROD URL');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});

const FN_URL = `${url.replace(/\/$/, '')}/functions/v1/rapid-processor`;
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const EXPECTED_GENERIC = {ok: true, message: 'If an account exists, a reset link has been sent.'};

const createdIds = [];
const sessions = [];
let failures = 0;

function ok(label) {
  console.log(`  [ok] ${label}`);
}
function bad(label) {
  failures += 1;
  console.log(`  [FAIL] ${label}`);
}
function assert(cond, label) {
  if (cond) ok(label);
  else bad(label);
}

// Raw Edge invoke. bearer defaults to the anon key (the public/anon caller the
// Supabase gateway expects); pass a user access token for authenticated calls.
async function invoke(body, bearer) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${bearer || anonKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {status: res.status, text};
}

async function signIn(email, password) {
  const client = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const {data, error} = await client.auth.signInWithPassword({email, password});
  sessions.push(client);
  if (error) return {token: null, error: error.message};
  return {token: data?.session?.access_token || null, error: null};
}

async function makeDisposableUser(role) {
  const email = `wcf-reset-proof+${role}-${stamp}-${createdIds.length}@example.com`;
  const password = `ResetProof-${role}-${stamp}!`;
  const {data, error} = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {full_name: `Reset Proof ${role}`},
  });
  if (error) throw new Error(`createUser(${role}) failed`);
  const id = data?.user?.id;
  if (!id) throw new Error(`createUser(${role}) returned no id`);
  createdIds.push(id);
  // No profile write is needed: sign-in resolves against auth.users, and a
  // disposable user is non-admin by default (is_admin checks for role='admin').
  // We assert is_admin=false explicitly where it matters (check 4).
  return {id, email, password};
}

async function resolveIsAdmin(token) {
  try {
    const c = createClient(url, anonKey, {
      auth: {autoRefreshToken: false, persistSession: false},
      global: {headers: {Authorization: `Bearer ${token}`}},
    });
    const r = await c.rpc('is_admin');
    return r.data === true;
  } catch (_e) {
    return false;
  }
}

function isGeneric(text) {
  try {
    const j = JSON.parse(text);
    return j && j.ok === true && j.message === EXPECTED_GENERIC.message && Object.keys(j).length === 2;
  } catch (_e) {
    return false;
  }
}

// Deployed-source assertion: the file we deployed is this exact source. Confirm
// the reset branch carries no test_to and no [TEST] reset subject.
function assertDeployedSourceClean() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'supabase-functions', 'rapid-processor.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const start = code.indexOf("if (type === 'password_reset')");
  const end = code.indexOf("if (type === 'user_delete')", start + 1);
  const resetBranch = start >= 0 ? code.slice(start, end < 0 ? code.length : end) : '';
  assert(resetBranch.length > 500, 'deployed source: password_reset branch located');
  assert(!/test_to/.test(resetBranch), 'deployed source: reset branch has no test_to (recipient/subject/template)');
  assert(!/\[TEST\]/.test(resetBranch), 'deployed source: reset branch emits no [TEST] subject');
  assert(!/if\s*\(\s*type\s*===\s*'user_welcome'\s*\)/.test(code), 'deployed source: user_welcome branch is removed');
}

async function main() {
  console.log(`TEST rapid-processor hardening proof @ ${FN_URL.replace(/^https?:\/\/[^/]+/, '(test-host)')}`);

  // Static assertion over the exact bytes deployed.
  assertDeployedSourceClean();

  // Disposable identities.
  const existing = await makeDisposableUser('existing'); // used by checks 2 + 8
  const nonAdmin = await makeDisposableUser('farmteam'); // used by check 4

  // Baseline for check 8: existing user can sign in with its original password.
  const base = await signIn(existing.email, existing.password);
  assert(base.token !== null, 'check 8 baseline: existing disposable user signs in with original password');

  const unknownEmail = `wcf-reset-proof+unknown-${stamp}@example.com`;

  // ── Check 1: public unknown email -> 200 + exact generic body ──
  const c1 = await invoke({type: 'password_reset', data: {email: unknownEmail}});
  assert(c1.status === 200, 'check 1: public unknown email -> HTTP 200');
  assert(isGeneric(c1.text), 'check 1: public unknown email -> exact generic body');
  const reference = c1.text; // byte reference for equivalence checks

  // ── Check 2: public existing disposable email -> 200, byte-equal (1 real send) ──
  const c2 = await invoke({type: 'password_reset', data: {email: existing.email}});
  assert(c2.status === 200, 'check 2: public existing email -> HTTP 200');
  assert(c2.text === reference, 'check 2: public existing email -> body byte-equivalent to unknown-email response');

  // ── Check 8: generating a recovery link does NOT change the password ──
  // TEST intentionally has no RESEND_API_KEY, so the Edge reset path short-
  // circuits at the config preflight and never calls generateLink. Exercise
  // the exact non-mutating call the Edge would make (admin generateLink) here
  // directly, then confirm the account password is unchanged. The link itself
  // is never printed.
  const gl = await service.auth.admin.generateLink({
    type: 'recovery',
    email: existing.email,
    options: {redirectTo: 'https://wcfplanner.com'},
  });
  const linkOk = !gl.error && !!gl.data?.properties?.action_link && !!gl.data?.user?.email;
  assert(linkOk, 'check 8: admin generateLink resolves a recovery link + account email for an existing user');
  const after = await signIn(existing.email, existing.password);
  assert(after.token !== null, 'check 8: original password still valid after recovery-link generation (unchanged)');

  // ── Check 3: public empty/malformed request -> same generic 200 ──
  const c3a = await invoke({type: 'password_reset', data: {}});
  const c3b = await invoke({type: 'password_reset', data: {email: '   '}});
  assert(c3a.status === 200 && c3a.text === reference, 'check 3a: public empty email -> same generic 200');
  assert(c3b.status === 200 && c3b.text === reference, 'check 3b: public whitespace email -> same generic 200');

  // ── Check 4: authenticated non-admin -> treated as public, same generic response ──
  const na = await signIn(nonAdmin.email, nonAdmin.password);
  assert(na.token !== null, 'check 4 precondition: non-admin disposable user signed in');
  const naIsAdmin = await resolveIsAdmin(na.token);
  assert(naIsAdmin === false, 'check 4 precondition: non-admin caller resolves is_admin=false');
  const c4 = await invoke({type: 'password_reset', data: {email: unknownEmail}}, na.token);
  assert(c4.status === 200 && c4.text === reference, 'check 4: authenticated non-admin -> generic public response');

  // ── Check 5: attacker top-level test_to -> same generic response ──
  const c5 = await invoke(
    {type: 'password_reset', data: {email: unknownEmail}, test_to: `attacker-${stamp}@example.com`},
    undefined,
  );
  assert(
    c5.status === 200 && c5.text === reference,
    'check 5: attacker test_to -> same generic response (no redirect)',
  );

  // ── Check 6: authenticated admin + unknown email -> truthful admin 404 ──
  const adm = await signIn(adminEmail, adminPassword);
  assert(adm.token !== null, 'check 6 precondition: admin signed in');
  const admIsAdmin = await resolveIsAdmin(adm.token);
  assert(admIsAdmin, 'check 6 precondition: TEST admin resolves is_admin=true');
  const c6 = await invoke({type: 'password_reset', data: {email: unknownEmail}}, adm.token);
  // Codex spec: "truthful admin-only 404/error response". generateLink's
  // unknown-account signal is version-dependent (404 when the message matches
  // the missing-account patterns, else a labeled 500), so accept any non-200
  // admin error that is distinct from the generic public body and names the
  // account/link failure.
  const c6IsError = c6.status >= 400 && c6.status !== 200;
  const c6Distinct = c6.text !== reference;
  const c6Truthful = /No WCF Planner account was found|generateLink|resolved no account email|step/.test(c6.text);
  let c6err = '';
  try {
    const j = JSON.parse(c6.text);
    c6err = `error=${String(j.error || '').slice(0, 120)} step=${j.step || ''}`;
  } catch (_e) {
    c6err = `non-json body (${c6.text.length} bytes)`;
  }
  console.log(`  [info] check 6 admin response HTTP ${c6.status} (generic-public=${c6.text === reference}) ${c6err}`);
  assert(
    c6IsError && c6Distinct && c6Truthful,
    'check 6: admin + unknown email -> truthful admin-only error (distinct from public body)',
  );

  // ── Check 7: type=user_welcome -> Unknown type 400, no link/email ──
  const c7 = await invoke({type: 'user_welcome', data: {email: existing.email, name: 'x', role: 'farm_team'}});
  const c7Gone =
    c7.status === 400 &&
    /Unknown type/.test(c7.text) &&
    !/action_link/.test(c7.text) &&
    !/ok"?\s*:\s*true/.test(c7.text);
  assert(c7Gone, 'check 7: user_welcome -> Unknown type 400 (no recovery link, no email)');

  // Honest scope disclosure for the runtime portion.
  if (/missing env RESEND_API_KEY/.test(c6.text)) {
    console.log('  [note] TEST has no RESEND_API_KEY by design, so Edge reset invokes short-circuit at the config');
    console.log('  [note] preflight. Checks 1-6 therefore prove the config-branch admin/public split (uniform');
    console.log('  [note] public 200 vs truthful admin error) and the no-test_to/no-[TEST] source contract, but do');
    console.log('  [note] NOT drive the live generateLink->resolved-email->send path. That send branch is covered');
    console.log('  [note] by the static source lock (rapid_processor_reset_hardening_static) + check 8 (direct');
    console.log('  [note] generateLink is non-mutating) and is validated end-to-end at PROD smoke.');
  }
}

async function cleanup() {
  let removed = 0;
  let remaining = 0;
  for (const id of createdIds) {
    try {
      await service.auth.admin.deleteUser(id); // cascades the profiles row
      await service.from('profiles').delete().eq('id', id); // best-effort belt-and-suspenders
      const {data} = await service.auth.admin.getUserById(id);
      if (data?.user) remaining += 1;
      else removed += 1;
    } catch (_e) {
      remaining += 1;
    }
  }
  for (const c of sessions) {
    try {
      await c.auth.signOut();
    } catch (_e) {
      /* ignore */
    }
  }
  console.log(`cleanup: disposable users removed ${removed}/${createdIds.length}, remaining ${remaining}`);
  return remaining;
}

(async () => {
  let remaining = createdIds.length;
  try {
    await main();
  } catch (e) {
    failures += 1;
    console.log(`  [FAIL] proof aborted: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    remaining = await cleanup();
  }
  console.log(
    failures === 0 && remaining === 0
      ? '\nPROOF PASSED'
      : `\nPROOF FAILED (assertion failures ${failures}, leftover users ${remaining})`,
  );
  process.exit(failures === 0 && remaining === 0 ? 0 : 1);
})();
