// Apply migration 183 to TEST and behaviorally prove the user-management
// audit expansion: profile.created via admin_create_user_profile, the
// reset request/terminal evidence RPCs, and the password_reset_throttle
// gate limits + role boundaries.
//
// COORDINATION GATE: creates and deletes disposable TEST Auth/profile users,
// audit rows, and throttle rows. Run ONLY with exclusive TEST access
// confirmed. It never resets shared TEST data and never prints secrets.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const password = `Mig183Proof-${crypto.randomUUID()}!`;
const createdIds = [];
const usedKeys = [];
const sessions = [];
let failures = 0;

function ok(label) {
  console.log(`  [ok] ${label}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? `: ${detail}` : ''}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label);
  else bad(label, detail);
}
// Opaque 64-hex throttle key (valid email_key: length within the 32-128 CHECK).
// The gate treats email_key as opaque; the Edge computes the real HMAC. A
// deterministic value here lets the blocked-growth count assertions re-derive
// the same key.
function keyFor(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) throw new Error(`${label}: ${error.message || String(error)}`);
}

async function makeAuthOnlyUser(label) {
  const email = `mig183-${label}-${stamp}@example.invalid`.toLowerCase();
  const {data, error} = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {full_name: `Mig183 ${label}`},
  });
  if (error || !data?.user?.id) throw new Error(`createUser(${label}): ${error?.message || 'no id'}`);
  createdIds.push(data.user.id);
  return {id: data.user.id, email};
}

async function makeProfiledUser(label, role) {
  const user = await makeAuthOnlyUser(label);
  const {error} = await service
    .from('profiles')
    .upsert(
      {id: user.id, email: user.email, full_name: `Mig183 ${label}`, role, program_access: null},
      {onConflict: 'id'},
    );
  if (error) throw new Error(`profile seed(${label}): ${error.message}`);
  return user;
}

async function signedInClient(email, signInPassword) {
  const client = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const {error} = await client.auth.signInWithPassword({email, password: signInPassword});
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  sessions.push(client);
  return client;
}

async function auditRows(targetId) {
  const {data, error} = await service
    .from('user_management_audit')
    .select('id,event_type,actor_profile_id,error_message,changes,request_id')
    .eq('target_profile_id', targetId)
    .order('created_at', {ascending: true});
  if (error) throw new Error(`audit read: ${error.message}`);
  return data || [];
}

async function main() {
  console.log('TARGET: TEST database (mig 183 apply + behavioral proof)');

  // ── Apply ──
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '183_user_management_audit_expansion.sql'),
    'utf8',
  );
  if (/^\s*(?:BEGIN|COMMIT);\s*$/im.test(sql)) throw new Error('migration must not own its transaction');
  await execSql(sql, 'apply 183');
  ok('migration 183 applied to TEST via exec_sql');

  // PostgREST reloads its schema cache asynchronously after the migration's
  // NOTIFY, so the very first RPC calls can race it. Probe with a call that
  // must fail for a NON-cache reason (service role has no auth.uid, so the
  // admin gate refuses) until the new function resolves.
  {
    const deadline = Date.now() + 30000;
    for (;;) {
      const probe = await service.rpc('admin_create_user_profile', {
        p_profile_id: null,
        p_email: null,
        p_full_name: null,
        p_role: null,
        p_invite_method: null,
      });
      if (!/schema cache/i.test(probe.error?.message || '')) break;
      if (Date.now() > deadline)
        throw new Error('admin_create_user_profile never appeared in the PostgREST schema cache');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // The single-arg gate replaced a dropped 2-arg signature; PostgREST reloads
    // the two independently, so wait for the new gate too. A too-short key
    // returns invalid_key without inserting a row, so this probe is side-effect
    // free.
    for (;;) {
      const probe = await service.rpc('_password_reset_gate', {p_email_key: 'warm'});
      if (!/schema cache/i.test(probe.error?.message || '')) break;
      if (Date.now() > deadline)
        throw new Error('_password_reset_gate(p_email_key) never appeared in the PostgREST schema cache');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    ok('PostgREST schema cache exposes the new RPCs');
  }

  // Reconcile the prior TEST definition: 183 was previously applied with the
  // (email_hash, ip) throttle shape and a 2-arg gate. Prove the re-apply
  // converged the database behaviorally — the retired 2-arg signature no longer
  // resolves, and the new single-arg gate does.
  {
    const oldSig = await service.rpc('_password_reset_gate', {p_email_hash: keyFor('recon'), p_ip: null});
    assert(
      /schema cache|does not exist|function/i.test(oldSig.error?.message || ''),
      'reconcile: prior 2-arg gate signature (email_hash, ip) no longer resolves',
      oldSig.error?.message || 'unexpectedly succeeded',
    );
    const newSig = await service.rpc('_password_reset_gate', {p_email_key: keyFor('recon2')});
    assert(
      !newSig.error && typeof newSig.data?.allowed === 'boolean',
      'reconcile: new single-arg gate resolves',
      newSig.error?.message,
    );
    usedKeys.push(keyFor('recon2'));
  }

  const adminClient = await signedInClient(adminEmail, adminPassword);
  const {data: adminProfile, error: adminProfileError} = await service
    .from('profiles')
    .select('id,role')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminProfileError || adminProfile?.role !== 'admin') {
    throw new Error(
      `test admin profile missing/not admin: ${adminProfileError?.message || JSON.stringify(adminProfile)}`,
    );
  }

  const nonAdmin = await makeProfiledUser('nonadmin', 'farm_team');
  const nonAdminClient = await signedInClient(nonAdmin.email, password);

  // ── 1. admin_create_user_profile ──
  const created = await makeAuthOnlyUser('created');
  const c1 = await adminClient.rpc('admin_create_user_profile', {
    p_profile_id: created.id,
    p_email: created.email,
    p_full_name: 'Mig183 Created',
    p_role: 'farm_team',
    p_invite_method: 'manual_password',
  });
  assert(!c1.error && c1.data?.ok === true, 'create: fresh profile row created', c1.error?.message);
  const {data: profileRow} = await service.from('profiles').select('id,role,email').eq('id', created.id).maybeSingle();
  assert(profileRow?.role === 'farm_team', 'create: profile row present with requested role');
  let rows = await auditRows(created.id);
  assert(
    rows.length === 1 &&
      rows[0].event_type === 'profile.created' &&
      rows[0].actor_profile_id === adminProfile.id &&
      rows[0].changes?.invite_method === 'manual_password',
    'create: one profile.created row with real admin actor + invite method',
    JSON.stringify(rows),
  );

  // INSERT-ONLY: a second create for an id that already has a profile must be
  // refused unchanged (no update, no second profile.created row) so it cannot
  // masquerade as creation of, or a mutation to, an established account.
  const c2 = await adminClient.rpc('admin_create_user_profile', {
    p_profile_id: created.id,
    p_email: created.email,
    p_full_name: 'Mig183 Renamed',
    p_role: 'admin',
    p_invite_method: 'welcome_email',
  });
  assert(
    /already exists/i.test(c2.error?.message || ''),
    'create: existing profile refused (insert-only)',
    c2.error?.message,
  );
  const {data: unchangedRow} = await service
    .from('profiles')
    .select('role,full_name')
    .eq('id', created.id)
    .maybeSingle();
  assert(
    unchangedRow?.role === 'farm_team' && unchangedRow?.full_name === 'Mig183 Created',
    'create: refused retry left the established row unchanged',
    JSON.stringify(unchangedRow),
  );
  rows = await auditRows(created.id);
  assert(
    rows.filter((r) => r.event_type === 'profile.created').length === 1,
    'create: no duplicate profile.created row from the refused retry',
  );

  const cMismatch = await adminClient.rpc('admin_create_user_profile', {
    p_profile_id: created.id,
    p_email: `other-${created.email}`,
    p_full_name: 'x',
    p_role: 'farm_team',
    p_invite_method: 'manual_password',
  });
  assert(/email mismatch/i.test(cMismatch.error?.message || ''), 'create: auth/profile email mismatch refused');

  const cMissing = await adminClient.rpc('admin_create_user_profile', {
    p_profile_id: crypto.randomUUID(),
    p_email: 'ghost@example.invalid',
    p_full_name: 'x',
    p_role: 'farm_team',
    p_invite_method: 'manual_password',
  });
  assert(/auth account not found/i.test(cMissing.error?.message || ''), 'create: fabricated profile id refused');

  const cRole = await adminClient.rpc('admin_create_user_profile', {
    p_profile_id: created.id,
    p_email: created.email,
    p_full_name: 'x',
    p_role: 'inactive',
    p_invite_method: 'manual_password',
  });
  assert(/invalid assignable role/i.test(cRole.error?.message || ''), 'create: inactive cannot be minted');

  const cNonAdmin = await nonAdminClient.rpc('admin_create_user_profile', {
    p_profile_id: created.id,
    p_email: created.email,
    p_full_name: 'x',
    p_role: 'farm_team',
    p_invite_method: 'manual_password',
  });
  assert(/admin role required/i.test(cNonAdmin.error?.message || ''), 'create: non-admin caller refused');

  // ── 2. Reset request/terminal evidence ──
  const r1 = await adminClient.rpc('admin_log_reset_request', {p_profile_id: created.id});
  assert(!r1.error && r1.data?.request_id, 'reset: request row written', r1.error?.message);
  const requestId = r1.data.request_id;

  const o1 = await adminClient.rpc('admin_log_reset_outcome', {
    p_request_id: requestId,
    p_succeeded: false,
    p_error_message: 'proof: provider failure',
  });
  assert(
    !o1.error && o1.data?.event_type === 'profile.reset_send_failed',
    'reset: failure terminal written',
    o1.error?.message,
  );

  const o1Retry = await adminClient.rpc('admin_log_reset_outcome', {
    p_request_id: requestId,
    p_succeeded: false,
    p_error_message: 'proof: retry',
  });
  assert(!o1Retry.error && o1Retry.data?.noop === true, 'reset: identical outcome retry is a noop');

  const o1Flip = await adminClient.rpc('admin_log_reset_outcome', {
    p_request_id: requestId,
    p_succeeded: true,
  });
  assert(/different outcome/i.test(o1Flip.error?.message || ''), 'reset: contradictory outcome refused');

  const r2 = await adminClient.rpc('admin_log_reset_request', {p_profile_id: created.id});
  const o2 = await adminClient.rpc('admin_log_reset_outcome', {p_request_id: r2.data?.request_id, p_succeeded: true});
  assert(
    !o2.error && o2.data?.event_type === 'profile.reset_send_succeeded',
    'reset: success terminal written',
    o2.error?.message,
  );

  const oUnknown = await adminClient.rpc('admin_log_reset_outcome', {
    p_request_id: crypto.randomUUID(),
    p_succeeded: true,
  });
  assert(/request not found/i.test(oUnknown.error?.message || ''), 'reset: unknown request refused');

  const rNonAdmin = await nonAdminClient.rpc('admin_log_reset_request', {p_profile_id: created.id});
  assert(/admin role required/i.test(rNonAdmin.error?.message || ''), 'reset: non-admin request logging refused');

  rows = await auditRows(created.id);
  const resetEvents = rows.filter((r) => r.event_type.startsWith('profile.reset_'));
  assert(
    resetEvents.filter((r) => r.event_type === 'profile.reset_requested').length === 2 &&
      resetEvents.filter((r) => r.event_type === 'profile.reset_send_failed').length === 1 &&
      resetEvents.filter((r) => r.event_type === 'profile.reset_send_succeeded').length === 1,
    'reset: ledger holds two requests with exactly one terminal each',
    JSON.stringify(resetEvents),
  );

  // ── 3. Throttle gate ──
  // Email sliding window: 3 allowed per hour, 4th blocked.
  const emailKey = keyFor(`mig183-throttle-${stamp}@example.invalid`);
  usedKeys.push(emailKey);
  const gateResults = [];
  for (let i = 0; i < 4; i += 1) {
    const g = await service.rpc('_password_reset_gate', {p_email_key: emailKey});
    if (g.error) throw new Error(`gate call ${i + 1}: ${g.error.message}`);
    gateResults.push(g.data);
  }
  assert(
    gateResults.slice(0, 3).every((g) => g?.allowed === true) &&
      gateResults[3]?.allowed === false &&
      gateResults[3]?.reason === 'email_hourly',
    'throttle: 3 allowed per email-hour, 4th blocked',
    JSON.stringify(gateResults),
  );

  // Bounded growth: only allowed reset attempts are stored, so the 3 allowed
  // produced exactly 3 rows and repeated blocked calls add none.
  async function keyRowCount(key) {
    const {data, error} = await service.from('password_reset_throttle').select('id').eq('email_key', key);
    if (error) throw new Error(`throttle row count: ${error.message}`);
    return (data || []).length;
  }
  const afterBlocked = await keyRowCount(emailKey);
  await service.rpc('_password_reset_gate', {p_email_key: emailKey});
  await service.rpc('_password_reset_gate', {p_email_key: emailKey});
  const afterMoreBlocked = await keyRowCount(emailKey);
  assert(
    afterBlocked === 3 && afterMoreBlocked === 3,
    'throttle: blocked calls insert nothing (row count stays at the 3 allowed attempts)',
    `after=${afterBlocked} afterMore=${afterMoreBlocked}`,
  );

  // Global daily ceiling: seed 100 allowed rows across distinct keys, then a
  // fresh key is blocked global_daily and records no row.
  const seedKeys = Array.from({length: 100}, (_v, i) => keyFor(`mig183-global-${stamp}-${i}`));
  usedKeys.push(...seedKeys);
  const seedRows = seedKeys.map((k) => ({email_key: k}));
  const {error: seedError} = await service.from('password_reset_throttle').insert(seedRows);
  if (seedError) throw new Error(`global seed insert: ${seedError.message}`);
  const globalKey = keyFor(`mig183-global-fresh-${stamp}`);
  usedKeys.push(globalKey);
  const gGlobal = await service.rpc('_password_reset_gate', {p_email_key: globalKey});
  assert(
    !gGlobal.error && gGlobal.data?.allowed === false && gGlobal.data?.reason === 'global_daily',
    'throttle: 100/day global ceiling blocks a fresh key',
    JSON.stringify(gGlobal.data),
  );
  assert((await keyRowCount(globalKey)) === 0, 'throttle: globally-blocked request records no row');

  // Malformed key fails closed.
  const gInvalid = await service.rpc('_password_reset_gate', {p_email_key: 'short'});
  assert(
    !gInvalid.error && gInvalid.data?.allowed === false && gInvalid.data?.reason === 'invalid_key',
    'throttle: malformed key fails closed',
  );

  // Gate is service-role only.
  const anonClient = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const gAnon = await anonClient.rpc('_password_reset_gate', {p_email_key: emailKey});
  assert(!!gAnon.error, 'throttle: anon caller cannot execute the gate');
  const gAuthed = await nonAdminClient.rpc('_password_reset_gate', {p_email_key: emailKey});
  assert(!!gAuthed.error, 'throttle: authenticated browser caller cannot execute the gate');
}

async function cleanup() {
  const errors = [];
  if (createdIds.length > 0) {
    const {error: targetAuditError} = await service
      .from('user_management_audit')
      .delete()
      .in('target_profile_id', createdIds);
    if (targetAuditError) errors.push(`delete target audit rows: ${targetAuditError.message}`);
    const {error: actorAuditError} = await service
      .from('user_management_audit')
      .delete()
      .in('actor_profile_id', createdIds);
    if (actorAuditError) errors.push(`delete actor audit rows: ${actorAuditError.message}`);
  }
  if (usedKeys.length > 0) {
    const {error: throttleError} = await service.from('password_reset_throttle').delete().in('email_key', usedKeys);
    if (throttleError) errors.push(`delete throttle rows: ${throttleError.message}`);
  }
  for (const client of sessions) {
    try {
      await client.auth.signOut();
    } catch (_e) {
      /* ignore */
    }
  }
  for (const id of createdIds) {
    try {
      const {error} = await service.auth.admin.deleteUser(id);
      if (error) errors.push(`delete temp auth ${id}: ${error.message}`);
    } catch (error) {
      errors.push(`delete temp auth ${id}: ${error.message || error}`);
    }
  }
  if (errors.length) throw new Error(`cleanup failed:\n- ${errors.join('\n- ')}`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    failures += 1;
    console.log(`  [FAIL] proof aborted: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      await cleanup();
      console.log('cleanup: complete');
    } catch (e) {
      failures += 1;
      console.log(`  [FAIL] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(failures === 0 ? '\nPROOF PASSED' : `\nPROOF FAILED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
})();
