// Apply migration 171 to TEST and prove the audited user-management boundary.
//
// IMPORTANT: this script creates isolated temporary Auth/profile users and
// always removes them. It never resets shared TEST data. Run this file alone;
// browser specs and other migration proof scripts share the same TEST project.
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
// Fresh Codex worktrees intentionally do not copy ignored secrets. Fall back to
// the primary worktree's standard TEST env files without copying or printing
// their values.
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
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const password = `Mig171-${crypto.randomUUID()}!`;
const createdIds = [];
const deletedAuthIds = new Set();
const clients = [];
let proofTableCreated = false;

function ok(label) {
  console.log(`  [ok] ${label}`);
}

function fail(message) {
  throw new Error(message);
}

async function expectError(promise, pattern, label) {
  const result = await promise;
  if (!result?.error) fail(`${label}: expected an error`);
  const text = `${result.error.message || ''} ${result.error.details || ''}`;
  if (pattern && !pattern.test(text)) fail(`${label}: wrong error: ${text}`);
  ok(label);
  return result.error;
}

async function createTempUser(label, role = 'farm_team') {
  const email = `mig171-${label}-${stamp}@example.invalid`.toLowerCase();
  const {data, error} = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {full_name: `Mig 171 ${label}`},
  });
  if (error || !data?.user?.id) fail(`createTempUser(${label}): ${error?.message || 'no user id'}`);
  const id = data.user.id;
  createdIds.push(id);
  const {error: profileError} = await service.from('profiles').upsert(
    {
      id,
      email,
      full_name: `Mig 171 ${label}`,
      role,
      program_access: null,
    },
    {onConflict: 'id'},
  );
  if (profileError) fail(`profile seed(${label}): ${profileError.message}`);
  return {id, email, role};
}

async function signedIn(user) {
  const client = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
  const {error} = await client.auth.signInWithPassword({email: user.email, password});
  if (error) fail(`signIn(${user.email}): ${error.message}`);
  clients.push(client);
  return client;
}

async function cleanup() {
  const errors = [];
  if (proofTableCreated) {
    const {error} = await service.rpc('exec_sql', {sql: 'DROP TABLE IF EXISTS public._mig171_profile_blocker;'});
    if (error) errors.push(`drop proof table: ${error.message}`);
    else proofTableCreated = false;
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
  try {
    const {error} = await admin.auth.signOut();
    if (error) errors.push(`admin sign-out: ${error.message}`);
  } catch (error) {
    errors.push(`admin sign-out: ${error.message || error}`);
  }
  // Audit evidence is removed above before Auth cascades profiles.
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
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '171_audited_user_management.sql'),
    'utf8',
  );
  const {error: applyError} = await service.rpc('exec_sql', {sql: migration});
  if (applyError) fail(`migration apply failed: ${applyError.message}`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  ok('migration 171 applied and schema cache reloaded');

  const {error: adminSignInError} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (adminSignInError) fail(`admin sign-in: ${adminSignInError.message}`);
  const {data: adminProfile, error: adminProfileError} = await service
    .from('profiles')
    .select('id,email,full_name,role')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (adminProfileError || !adminProfile?.id || adminProfile.role !== 'admin') {
    fail(`test admin profile missing/not admin: ${adminProfileError?.message || JSON.stringify(adminProfile)}`);
  }

  const target = await createTempUser('target');
  const blocked = await createTempUser('blocked');
  const nonAdminUser = await createTempUser('nonadmin');
  const deleteTarget = await createTempUser('delete');
  const directDeleteTarget = await createTempUser('direct-profile-delete');
  const recoveryTarget = await createTempUser('recover-missing-terminal');
  const ambiguousTarget = await createTempUser('recover-ambiguous-error');
  const adminA = await createTempUser('admin-a', 'admin');
  const adminB = await createTempUser('admin-b', 'admin');
  const adminC = await createTempUser('admin-c', 'admin');
  const nonAdmin = await signedIn(nonAdminUser);
  const adminAClient = await signedIn(adminA);
  const adminBClient = await signedIn(adminB);

  // Authenticated browser writes are revoked even for admins; RPCs own writes.
  await expectError(
    admin.from('profiles').update({full_name: 'BYPASS'}).eq('id', target.id),
    /permission denied/i,
    'direct authenticated profiles UPDATE is denied',
  );

  // Name mutation + audit.
  const {data: nameResult, error: nameError} = await admin.rpc('admin_set_user_name', {
    p_profile_id: target.id,
    p_full_name: '  Audited Name  ',
  });
  if (nameError || nameResult?.full_name !== 'Audited Name') fail(`name RPC: ${nameError?.message}`);
  const {data: namedProfile} = await service.from('profiles').select('full_name').eq('id', target.id).single();
  if (namedProfile?.full_name !== 'Audited Name') fail('name RPC did not persist trimmed name');
  ok('admin name edit persisted through RPC');

  const {data: nameAudit} = await service
    .from('user_management_audit')
    .select('event_type,changes,actor_profile_id')
    .eq('target_profile_id', target.id)
    .eq('event_type', 'profile.name_changed')
    .maybeSingle();
  if (nameAudit?.actor_profile_id !== adminProfile.id || nameAudit?.changes?.full_name?.to !== 'Audited Name') {
    fail(`name audit missing/wrong: ${JSON.stringify(nameAudit)}`);
  }
  ok('name edit and immutable actor/change audit landed together');

  // Invalid writes fail atomically: no profile change and no audit row.
  const {count: beforeInvalidAudit} = await service
    .from('user_management_audit')
    .select('id', {count: 'exact', head: true})
    .eq('target_profile_id', target.id);
  await expectError(
    admin.rpc('admin_set_user_role', {p_profile_id: target.id, p_role: 'super_admin'}),
    /invalid role/i,
    'invalid role is refused',
  );
  const {data: afterInvalidRole} = await service.from('profiles').select('role').eq('id', target.id).single();
  const {count: afterInvalidAudit} = await service
    .from('user_management_audit')
    .select('id', {count: 'exact', head: true})
    .eq('target_profile_id', target.id);
  if (afterInvalidRole?.role !== 'farm_team' || beforeInvalidAudit !== afterInvalidAudit) {
    fail('invalid role changed profile or appended audit');
  }
  ok('failed validation is atomic (no mutation and no audit)');

  // Canonical role transitions, including deactivation/reactivation.
  for (const role of ['equipment_tech', 'inactive', 'farm_team']) {
    const {data, error} = await admin.rpc('admin_set_user_role', {p_profile_id: target.id, p_role: role});
    if (error || data?.role !== role) fail(`role ${role}: ${error?.message || JSON.stringify(data)}`);
  }
  const {data: roleEvents} = await service
    .from('user_management_audit')
    .select('event_type')
    .eq('target_profile_id', target.id)
    .in('event_type', ['profile.role_changed', 'profile.deactivated', 'profile.reactivated']);
  const eventTypes = new Set((roleEvents || []).map((row) => row.event_type));
  for (const event of ['profile.role_changed', 'profile.deactivated', 'profile.reactivated']) {
    if (!eventTypes.has(event)) fail(`missing role event ${event}`);
  }
  ok('equipment-tech, deactivate, and reactivate transitions are audited');

  // Program validation + canonical ordering/dedup + null/full-access semantics.
  const {data: accessResult, error: accessError} = await admin.rpc('admin_set_user_program_access', {
    p_profile_id: target.id,
    p_program_access: ['equipment', 'broiler', 'broiler'],
  });
  if (accessError || JSON.stringify(accessResult?.program_access) !== JSON.stringify(['broiler', 'equipment'])) {
    fail(`program normalization: ${accessError?.message || JSON.stringify(accessResult)}`);
  }
  await expectError(
    admin.rpc('admin_set_user_program_access', {
      p_profile_id: target.id,
      p_program_access: ['broiler', 'finance'],
    }),
    /invalid program/i,
    'unknown program key is refused',
  );
  const {data: fullAccess, error: fullAccessError} = await admin.rpc('admin_set_user_program_access', {
    p_profile_id: target.id,
    p_program_access: [],
  });
  if (fullAccessError || fullAccess?.program_access !== null) fail(`empty/full access: ${fullAccessError?.message}`);
  ok('program access validates keys and preserves null/empty = full access');

  // Non-admin and self-lockout checks.
  await expectError(
    nonAdmin.rpc('admin_set_user_name', {p_profile_id: target.id, p_full_name: 'Denied'}),
    /admin role required/i,
    'non-admin mutation is denied',
  );
  await expectError(
    admin.rpc('admin_set_user_role', {p_profile_id: adminProfile.id, p_role: 'management'}),
    /cannot change your own role/i,
    'self/last-admin lockout: admin cannot change own role',
  );
  await expectError(
    admin.rpc('admin_prepare_user_delete', {
      p_profile_id: adminProfile.id,
      p_expected_email: adminProfile.email,
    }),
    /cannot delete your own account/i,
    'self/last-admin lockout: admin cannot delete own account',
  );

  // Catalog-based retained-record preflight. Temporary proof FK is dropped in
  // finally even if an assertion fails.
  const proofSql = `
    DROP TABLE IF EXISTS public._mig171_profile_blocker;
    CREATE TABLE public._mig171_profile_blocker (
      profile_id uuid PRIMARY KEY REFERENCES public.profiles(id)
    );
    INSERT INTO public._mig171_profile_blocker(profile_id) VALUES ('${blocked.id}');
  `;
  proofTableCreated = true;
  const {error: proofTableError} = await service.rpc('exec_sql', {sql: proofSql});
  if (proofTableError) fail(`proof blocker table: ${proofTableError.message}`);
  await expectError(
    admin.rpc('admin_prepare_user_delete', {p_profile_id: blocked.id, p_expected_email: blocked.email}),
    /retained farm records/i,
    'delete preflight refuses a retained profile before Auth mutation',
  );
  const {data: blockedAuth} = await service.auth.admin.getUserById(blocked.id);
  if (!blockedAuth?.user) fail('blocked preflight removed Auth user');
  const {error: proofDropError} = await service.rpc('exec_sql', {
    sql: 'DROP TABLE IF EXISTS public._mig171_profile_blocker;',
  });
  if (proofDropError) fail(`drop proof blocker table: ${proofDropError.message}`);
  proofTableCreated = false;

  // Cross-admin race: once A prepares B's deletion, B cannot prepare A's
  // deletion and A cannot be demoted while responsible for finalization.
  const {data: crossRequest, error: crossError} = await adminAClient.rpc('admin_prepare_user_delete', {
    p_profile_id: adminB.id,
    p_expected_email: adminB.email,
  });
  if (crossError || !crossRequest?.request_id) fail(`cross prepare: ${crossError?.message}`);
  await expectError(
    adminBClient.rpc('admin_prepare_user_delete', {p_profile_id: adminC.id, p_expected_email: adminC.email}),
    /your account deletion is already in progress/i,
    'pending delete target cannot initiate a third-admin deletion',
  );
  await expectError(
    adminBClient.rpc('admin_prepare_user_delete', {p_profile_id: adminA.id, p_expected_email: adminA.email}),
    /deletion is already in progress/i,
    'reciprocal admin delete preparation is refused',
  );
  await expectError(
    admin.rpc('admin_set_user_role', {p_profile_id: adminA.id, p_role: 'management'}),
    /deletion is already in progress/i,
    'admin with an outgoing delete cannot be demoted mid-flight',
  );
  const {error: crossFinalizeError} = await adminAClient.rpc('admin_finalize_user_delete', {
    p_request_id: crossRequest.request_id,
    p_succeeded: false,
    p_error_message: 'migration proof cancellation',
  });
  if (crossFinalizeError) fail(`cross finalize: ${crossFinalizeError.message}`);
  ok('durable pending marker closes reciprocal-admin deletion race');

  // Crash recovery: recent pending refuses a race. Stale pending is terminally
  // closed in one RPC; a separate fresh preflight cannot roll that recovery
  // back if new validation fails.
  const {data: firstPrepare, error: firstPrepareError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: target.id,
    p_expected_email: target.email,
  });
  if (firstPrepareError || !firstPrepare?.request_id) fail(`first prepare: ${firstPrepareError?.message}`);
  await expectError(
    admin.rpc('admin_prepare_user_delete', {p_profile_id: target.id, p_expected_email: target.email}),
    /wait five minutes/i,
    'recent pending delete is not raced',
  );
  const {error: ageError} = await service
    .from('user_management_audit')
    .update({created_at: new Date(Date.now() - 6 * 60_000).toISOString()})
    .eq('id', firstPrepare.request_id);
  if (ageError) fail(`age pending request: ${ageError.message}`);
  const {data: recovered, error: recoverError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: target.id,
    p_expected_email: target.email,
  });
  if (recoverError || recovered?.retry_required !== true || recovered.recovered_stale_request !== true) {
    fail(`stale recovery: ${recoverError?.message || JSON.stringify(recovered)}`);
  }
  const {data: staleTerminal} = await service
    .from('user_management_audit')
    .select('event_type,error_message')
    .eq('request_id', firstPrepare.request_id)
    .maybeSingle();
  if (staleTerminal?.event_type !== 'profile.delete_failed') fail('stale request was not terminally failed');
  const {data: freshAfterRecovery, error: freshAfterRecoveryError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: target.id,
    p_expected_email: target.email,
  });
  if (freshAfterRecoveryError || !freshAfterRecovery?.request_id) {
    fail(`fresh prepare after stale recovery: ${freshAfterRecoveryError?.message}`);
  }
  const {error: recoverFinalizeError} = await admin.rpc('admin_finalize_user_delete', {
    p_request_id: freshAfterRecovery.request_id,
    p_succeeded: false,
    p_error_message: 'migration proof cancellation',
  });
  if (recoverFinalizeError) fail(`recovered finalize: ${recoverFinalizeError.message}`);
  ok('stale preflight crash is recoverable and retry-idempotent');

  // A privileged direct child delete must not impersonate the Auth-owned
  // parent cascade. PostgreSQL exposes the still-present auth.users parent to
  // the profiles AFTER DELETE trigger, which raises and rolls back the child
  // delete. No false profile.deleted terminal may be written.
  const {data: directPrepare, error: directPrepareError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: directDeleteTarget.id,
    p_expected_email: directDeleteTarget.email,
  });
  if (directPrepareError || !directPrepare?.request_id) {
    fail(`direct child delete prepare: ${directPrepareError?.message}`);
  }
  await expectError(
    service.from('profiles').delete().eq('id', directDeleteTarget.id),
    /must originate from auth\.users cascade/i,
    'privileged direct profiles DELETE is rolled back while Auth row remains',
  );
  const [{data: directProfile}, {data: directAuth}, {data: directTerminals, error: directTerminalError}] =
    await Promise.all([
      service.from('profiles').select('id').eq('id', directDeleteTarget.id).maybeSingle(),
      service.auth.admin.getUserById(directDeleteTarget.id),
      service
        .from('user_management_audit')
        .select('event_type')
        .eq('request_id', directPrepare.request_id)
        .in('event_type', ['profile.deleted', 'profile.delete_failed']),
    ]);
  if (!directProfile || !directAuth?.user || directTerminalError || (directTerminals || []).length !== 0) {
    fail(
      `direct child delete rollback proof failed: ${JSON.stringify({
        directProfile,
        directAuthUser: directAuth?.user?.id,
        directTerminals,
        directTerminalError: directTerminalError?.message,
      })}`,
    );
  }
  const {error: directFinalizeError} = await admin.rpc('admin_finalize_user_delete', {
    p_request_id: directPrepare.request_id,
    p_succeeded: false,
    p_error_message: 'migration proof direct child delete rejected',
  });
  if (directFinalizeError) fail(`direct child delete finalize: ${directFinalizeError.message}`);
  ok('direct profile delete cannot terminalize or bypass the Auth-owned cascade');

  // Trigger atomicity / Edge-crash proof: Auth delete cascades profiles and
  // writes profile.deleted BEFORE any explicit finalize call. Finalize is then
  // an idempotent noop confirmation.
  const {data: recoveryPrepare, error: recoveryPrepareError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: recoveryTarget.id,
    p_expected_email: recoveryTarget.email,
  });
  if (recoveryPrepareError || !recoveryPrepare?.request_id) {
    fail(`trigger recovery prepare: ${recoveryPrepareError?.message}`);
  }
  const {error: recoveryAuthDeleteError} = await service.auth.admin.deleteUser(recoveryTarget.id);
  if (recoveryAuthDeleteError) fail(`trigger recovery Auth delete: ${recoveryAuthDeleteError.message}`);
  deletedAuthIds.add(recoveryTarget.id);
  const {data: triggerTerminal} = await service
    .from('user_management_audit')
    .select('event_type,changes,target_email')
    .eq('request_id', recoveryPrepare.request_id)
    .maybeSingle();
  if (
    triggerTerminal?.event_type !== 'profile.deleted' ||
    triggerTerminal?.changes?.completed_by !== 'profiles_delete_trigger'
  ) {
    fail(`Auth cascade terminal missing before finalize: ${JSON.stringify(triggerTerminal)}`);
  }
  const {data: recoveryFinalize, error: recoveryFinalizeError} = await admin.rpc('admin_finalize_user_delete', {
    p_request_id: recoveryPrepare.request_id,
    p_succeeded: true,
    p_error_message: null,
  });
  if (recoveryFinalizeError || recoveryFinalize?.noop !== true) {
    fail(
      `trigger recovery finalize was not noop: ${recoveryFinalizeError?.message || JSON.stringify(recoveryFinalize)}`,
    );
  }
  ok('Auth cascade and delete audit are atomic before Edge finalization');

  // Ambiguous Auth error proof: the database state/trigger terminal is
  // authoritative. Reporting p_succeeded=false after a committed Auth delete
  // returns the existing profile.deleted result, never a false failure event.
  const {data: ambiguousPrepare, error: ambiguousPrepareError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: ambiguousTarget.id,
    p_expected_email: ambiguousTarget.email,
  });
  if (ambiguousPrepareError || !ambiguousPrepare?.request_id) {
    fail(`ambiguous recovery prepare: ${ambiguousPrepareError?.message}`);
  }
  const {error: ambiguousAuthDeleteError} = await service.auth.admin.deleteUser(ambiguousTarget.id);
  if (ambiguousAuthDeleteError) fail(`ambiguous recovery Auth delete: ${ambiguousAuthDeleteError.message}`);
  deletedAuthIds.add(ambiguousTarget.id);
  const {data: ambiguousFinalize, error: ambiguousFinalizeError} = await admin.rpc('admin_finalize_user_delete', {
    p_request_id: ambiguousPrepare.request_id,
    p_succeeded: false,
    p_error_message: 'simulated transport error after remote commit',
  });
  if (ambiguousFinalizeError || ambiguousFinalize?.event_type !== 'profile.deleted') {
    fail(`ambiguous recovery finalize: ${ambiguousFinalizeError?.message || JSON.stringify(ambiguousFinalize)}`);
  }
  const {data: ambiguousTerminals} = await service
    .from('user_management_audit')
    .select('event_type')
    .eq('request_id', ambiguousPrepare.request_id);
  if ((ambiguousTerminals || []).length !== 1 || ambiguousTerminals[0].event_type !== 'profile.deleted') {
    fail(`ambiguous recovery wrote wrong terminals: ${JSON.stringify(ambiguousTerminals)}`);
  }
  ok('ambiguous Auth error cannot create a false delete_failed terminal');

  // Successful hard delete: Auth owns profiles cascade and audit survives.
  const {data: deletePrepare, error: deletePrepareError} = await admin.rpc('admin_prepare_user_delete', {
    p_profile_id: deleteTarget.id,
    p_expected_email: deleteTarget.email,
  });
  if (deletePrepareError || !deletePrepare?.request_id) fail(`delete prepare: ${deletePrepareError?.message}`);
  const {error: authDeleteError} = await service.auth.admin.deleteUser(deleteTarget.id);
  if (authDeleteError) fail(`Auth delete: ${authDeleteError.message}`);
  deletedAuthIds.add(deleteTarget.id);
  const {data: preFinalizeAudit} = await service
    .from('user_management_audit')
    .select('event_type,changes')
    .eq('request_id', deletePrepare.request_id)
    .maybeSingle();
  if (
    preFinalizeAudit?.event_type !== 'profile.deleted' ||
    preFinalizeAudit?.changes?.completed_by !== 'profiles_delete_trigger'
  ) {
    fail(`successful delete missing atomic trigger audit: ${JSON.stringify(preFinalizeAudit)}`);
  }
  const {data: deleteFinalize, error: deleteFinalizeError} = await admin.rpc('admin_finalize_user_delete', {
    p_request_id: deletePrepare.request_id,
    p_succeeded: true,
    p_error_message: null,
  });
  if (deleteFinalizeError || deleteFinalize?.noop !== true) {
    fail(`delete finalize: ${deleteFinalizeError?.message || JSON.stringify(deleteFinalize)}`);
  }
  const {data: deletedProfile} = await service.from('profiles').select('id').eq('id', deleteTarget.id).maybeSingle();
  const {data: deleteAudit} = await service
    .from('user_management_audit')
    .select('event_type,target_email')
    .eq('request_id', deletePrepare.request_id)
    .maybeSingle();
  if (
    deletedProfile ||
    deleteAudit?.event_type !== 'profile.deleted' ||
    deleteAudit.target_email !== deleteTarget.email
  ) {
    fail(`delete cascade/audit proof failed: ${JSON.stringify({deletedProfile, deleteAudit})}`);
  }
  ok('Auth delete cascades profile exactly once and immutable audit survives');

  console.log('mig171 verify: ALL CHECKS PASSED');
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
