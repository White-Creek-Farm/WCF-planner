// Real TEST Edge proof for the rapid-processor user_delete handler.
//
// Unlike tests/user_management_audit.spec.js (which mocks the Edge response in
// the browser), this script invokes the DEPLOYED TEST rapid-processor function
// over HTTP and proves the full admin-gate -> prepare -> Auth delete ->
// finalize/reconcile contract against the live TEST database.
//
// COORDINATION GATE: this script creates and deletes disposable TEST
// Auth/profile users and appends/removes TEST audit rows. Run it ONLY with
// exclusive TEST access confirmed (no concurrent CI, Playwright, or other
// agents' TEST proofs). It never resets shared TEST data.
//
// It never prints service-role keys, JWTs, passwords, or reset links.
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
const BLOCKER_TABLE = '_cc3_user_delete_edge_blocker';
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const password = `EdgeProof-${crypto.randomUUID()}!`;
const createdIds = [];
const deletedAuthIds = new Set();
const clients = [];
let blockerTableCreated = false;

function ok(label) {
  console.log(`  [ok] ${label}`);
}

function fail(message) {
  throw new Error(message);
}

async function createTempUser(label, role = 'farm_team') {
  const email = `edgeproof-${label}-${stamp}@example.invalid`.toLowerCase();
  const {data, error} = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {full_name: `Edge Proof ${label}`},
  });
  if (error || !data?.user?.id) fail(`createTempUser(${label}): ${error?.message || 'no user id'}`);
  const id = data.user.id;
  createdIds.push(id);
  const {error: profileError} = await service
    .from('profiles')
    .upsert({id, email, full_name: `Edge Proof ${label}`, role, program_access: null}, {onConflict: 'id'});
  if (profileError) fail(`profile seed(${label}): ${profileError.message}`);
  return {id, email, role};
}

async function signedInToken(email, signInPassword) {
  const client = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const {data, error} = await client.auth.signInWithPassword({email, password: signInPassword});
  if (error || !data?.session?.access_token) fail(`signIn(${email}): ${error?.message || 'no session'}`);
  clients.push(client);
  return data.session.access_token;
}

// Invokes the DEPLOYED function directly so real HTTP statuses are asserted.
// `accessToken` null = anonymous request (no Authorization header at all).
async function invokeUserDelete(accessToken, body) {
  const headers = {'Content-Type': 'application/json', apikey: anonKey};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({type: 'user_delete', data: body}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return {status: res.status, body: json, raw: text};
}

async function auditRowsForRequest(requestId) {
  const {data, error} = await service
    .from('user_management_audit')
    .select('event_type')
    .eq('request_id', requestId)
    .in('event_type', ['profile.deleted', 'profile.delete_failed']);
  if (error) fail(`audit terminal read: ${error.message}`);
  return data || [];
}

async function requestRowsForTarget(targetId) {
  const {data, error} = await service
    .from('user_management_audit')
    .select('id,event_type,actor_profile_id,target_email')
    .eq('target_profile_id', targetId)
    .order('created_at', {ascending: true});
  if (error) fail(`audit request read: ${error.message}`);
  return data || [];
}

async function cleanup() {
  const errors = [];
  if (blockerTableCreated) {
    const {error} = await service.rpc('exec_sql', {sql: `DROP TABLE IF EXISTS public.${BLOCKER_TABLE};`});
    if (error) errors.push(`drop blocker table: ${error.message}`);
    else blockerTableCreated = false;
  }
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
  for (const client of clients) {
    try {
      const {error} = await client.auth.signOut();
      if (error) errors.push(`temporary client sign-out: ${error.message}`);
    } catch (error) {
      errors.push(`temporary client sign-out: ${error.message || error}`);
    }
  }
  for (const id of createdIds) {
    if (deletedAuthIds.has(id)) continue;
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
  console.log(`TEST url=${url}`);
  console.log(`function=${FN_URL}`);

  // The real TEST admin session drives the Edge calls, exactly like UsersModal.
  const adminToken = await signedInToken(adminEmail, adminPassword);
  const {data: adminProfile, error: adminProfileError} = await service
    .from('profiles')
    .select('id,role')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminProfileError || adminProfile?.role !== 'admin') {
    fail(`test admin profile missing/not admin: ${adminProfileError?.message || JSON.stringify(adminProfile)}`);
  }

  const deleteTarget = await createTempUser('delete');
  const blockedTarget = await createTempUser('blocked');
  const recoveryTarget = await createTempUser('recovery');
  const nonAdminUser = await createTempUser('nonadmin');

  // 5) Denials first, while every disposable row still exists.
  const anonResult = await invokeUserDelete(null, {id: deleteTarget.id, email: deleteTarget.email});
  if (anonResult.status !== 401 || anonResult.body?.error !== 'unauthorized') {
    fail(`anon call not denied: ${anonResult.status} ${anonResult.raw}`);
  }
  ok('unauthenticated user_delete is denied with 401');

  const nonAdminToken = await signedInToken(nonAdminUser.email, password);
  const nonAdminResult = await invokeUserDelete(nonAdminToken, {id: deleteTarget.id, email: deleteTarget.email});
  if (nonAdminResult.status !== 403 || nonAdminResult.body?.error !== 'forbidden') {
    fail(`non-admin call not denied: ${nonAdminResult.status} ${nonAdminResult.raw}`);
  }
  const {data: stillThere} = await service.auth.admin.getUserById(deleteTarget.id);
  if (!stillThere?.user) fail('denied calls must not delete the target');
  ok('non-admin user_delete is denied with 403 and mutates nothing');

  // 2) Retained-FK refusal: a NO ACTION FK blocks the preflight with
  // deactivation guidance and leaves both Auth and profile intact.
  const blockerSql = `
    DROP TABLE IF EXISTS public.${BLOCKER_TABLE};
    CREATE TABLE public.${BLOCKER_TABLE} (
      profile_id uuid PRIMARY KEY REFERENCES public.profiles(id)
    );
    INSERT INTO public.${BLOCKER_TABLE}(profile_id) VALUES ('${blockedTarget.id}');
  `;
  blockerTableCreated = true;
  const {error: blockerError} = await service.rpc('exec_sql', {sql: blockerSql});
  if (blockerError) fail(`blocker table: ${blockerError.message}`);
  const blockedResult = await invokeUserDelete(adminToken, {id: blockedTarget.id, email: blockedTarget.email});
  if (blockedResult.status !== 409 || !/retained farm records/i.test(blockedResult.body?.error || '')) {
    fail(`retained-FK call not refused: ${blockedResult.status} ${blockedResult.raw}`);
  }
  if (!/deactivate/i.test(blockedResult.body?.error || '')) {
    fail(`retained-FK refusal lacks deactivation guidance: ${blockedResult.raw}`);
  }
  const [{data: blockedAuth}, {data: blockedProfile}] = await Promise.all([
    service.auth.admin.getUserById(blockedTarget.id),
    service.from('profiles').select('id,role').eq('id', blockedTarget.id).maybeSingle(),
  ]);
  if (!blockedAuth?.user || !blockedProfile?.id) fail('retained-FK refusal must leave auth and profile intact');
  const blockedTerminals = await requestRowsForTarget(blockedTarget.id);
  if (blockedTerminals.some((row) => ['profile.deleted', 'profile.delete_failed'].includes(row.event_type))) {
    fail(`retained-FK refusal wrote a terminal row: ${JSON.stringify(blockedTerminals)}`);
  }
  const {error: blockerDropError} = await service.rpc('exec_sql', {
    sql: `DROP TABLE IF EXISTS public.${BLOCKER_TABLE};`,
  });
  if (blockerDropError) fail(`drop blocker table: ${blockerDropError.message}`);
  blockerTableCreated = false;
  ok('retained-FK preflight refuses with deactivation guidance and intact account');

  // 1) Successful deletion of a disposable user with no retained FKs.
  const successResult = await invokeUserDelete(adminToken, {id: deleteTarget.id, email: deleteTarget.email});
  if (successResult.status !== 200 || successResult.body?.ok !== true) {
    fail(`successful delete failed: ${successResult.status} ${successResult.raw}`);
  }
  if (successResult.body.auditFinalized !== true) {
    fail(`successful delete did not finalize audit: ${successResult.raw}`);
  }
  deletedAuthIds.add(deleteTarget.id);
  const [{data: goneAuth}, {data: goneProfile}] = await Promise.all([
    service.auth.admin.getUserById(deleteTarget.id),
    service.from('profiles').select('id').eq('id', deleteTarget.id).maybeSingle(),
  ]);
  if (goneAuth?.user || goneProfile) fail('successful delete left auth or profile behind');
  ok('real Edge delete removed auth + cascaded profile');

  // 4) Correct requested and terminal audit rows: exactly one
  // profile.delete_requested by the calling admin and exactly one
  // profile.deleted terminal for that request.
  const deleteRows = await requestRowsForTarget(deleteTarget.id);
  const requested = deleteRows.filter((row) => row.event_type === 'profile.delete_requested');
  if (requested.length !== 1 || requested[0].actor_profile_id !== adminProfile.id) {
    fail(`wrong requested rows: ${JSON.stringify(deleteRows)}`);
  }
  if (requested[0].target_email !== deleteTarget.email) {
    fail(`requested row lost target snapshot: ${JSON.stringify(requested)}`);
  }
  const terminals = await auditRowsForRequest(requested[0].id);
  if (terminals.length !== 1 || terminals[0].event_type !== 'profile.deleted') {
    fail(`wrong terminal rows: ${JSON.stringify(terminals)}`);
  }
  ok('audit holds one requested row and exactly one deleted terminal');

  // 3a) Idempotent retry after success: the Edge reports alreadyDeleted and
  // appends no duplicate terminal evidence.
  const retryResult = await invokeUserDelete(adminToken, {id: deleteTarget.id, email: deleteTarget.email});
  if (retryResult.status !== 200 || retryResult.body?.alreadyDeleted !== true) {
    fail(`retry after success not idempotent: ${retryResult.status} ${retryResult.raw}`);
  }
  const retryTerminals = await auditRowsForRequest(requested[0].id);
  if (retryTerminals.length !== 1) fail(`retry duplicated terminals: ${JSON.stringify(retryTerminals)}`);
  ok('retry after success is idempotent with a single terminal per request');

  // 3b) Crash reconciliation: prepare committed, Auth delete landed
  // out-of-band (simulating an Edge crash before finalize), then the real
  // Edge retry reconciles to already-deleted without a second Auth delete.
  const recoveryToken = await signedInToken(adminEmail, adminPassword);
  const recoveryClient = clients[clients.length - 1];
  const {data: recoveryPrepare, error: recoveryPrepareError} = await recoveryClient.rpc('admin_prepare_user_delete', {
    p_profile_id: recoveryTarget.id,
    p_expected_email: recoveryTarget.email,
  });
  if (recoveryPrepareError || !recoveryPrepare?.request_id) {
    fail(`recovery prepare: ${recoveryPrepareError?.message || JSON.stringify(recoveryPrepare)}`);
  }
  const {error: outOfBandDelete} = await service.auth.admin.deleteUser(recoveryTarget.id);
  if (outOfBandDelete) fail(`recovery Auth delete: ${outOfBandDelete.message}`);
  deletedAuthIds.add(recoveryTarget.id);
  const recoveryResult = await invokeUserDelete(recoveryToken, {id: recoveryTarget.id, email: recoveryTarget.email});
  if (recoveryResult.status !== 200 || recoveryResult.body?.alreadyDeleted !== true) {
    fail(`crash reconciliation failed: ${recoveryResult.status} ${recoveryResult.raw}`);
  }
  const recoveryTerminals = await auditRowsForRequest(recoveryPrepare.request_id);
  if (recoveryTerminals.length !== 1 || recoveryTerminals[0].event_type !== 'profile.deleted') {
    fail(`crash reconciliation terminals wrong: ${JSON.stringify(recoveryTerminals)}`);
  }
  ok('interrupted delete reconciles to one authoritative terminal on Edge retry');

  console.log('user_delete Edge proof: ALL CHECKS PASSED');
})()
  .catch((error) => {
    console.error('FAIL:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error('CLEANUP FAIL:', error?.message || error);
      process.exitCode = 1;
    }
  });
