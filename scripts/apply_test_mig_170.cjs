// Apply migration 170 to TEST and prove its effective authorization contract.
//
// Hard safety boundaries:
//   * WCF_TEST_DATABASE must be exactly 1.
//   * VITE_SUPABASE_URL must not contain the PROD project ref.
//   * exec_sql is used only after those guards pass.
//
// Behavioral proof:
//   * admin/management remain allowed regardless of program_access;
//   * farm_team is allowed only for null/empty or matching program access;
//   * light/equipment_tech/inactive/anon are denied;
//   * one real farm_team cattle detach is atomic and stamps the transfer and
//     Activity payload from the caller profile, ignoring spoofed p_team_member.

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

loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (process.env.WCF_TEST_DATABASE !== '1') {
  console.error('refusing: WCF_TEST_DATABASE must be 1');
  process.exit(2);
}
if (!url || !serviceKey || !anonKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing: URL matches PROD project ref');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const caller = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const STAMP = Date.now();
const EMAIL = 'detach170-proof@wcfplanner.test';
const PASSWORD = 'Detach170Proof!pw';
const PROFILE_NAME = 'Detach 170 Farm Team';
const SPOOFED_NAME = 'Spoofed Client Name';
const IDS = {
  batch: `detach170-batch-${STAMP}`,
  cattle: `detach170-cow-${STAMP}`,
  session: `detach170-session-${STAMP}`,
  weighIn: `detach170-weighin-${STAMP}`,
  tag: `D170-${STAMP}`,
};

let userId = null;

function fail(message, detail) {
  throw new Error(message + (detail ? `: ${detail}` : ''));
}

function ok(message) {
  console.log(`  ok  ${message}`);
}

async function findUserByEmail(email) {
  for (let page = 1; ; page += 1) {
    const {data, error} = await service.auth.admin.listUsers({page, perPage: 200});
    if (error) fail('listUsers failed', error.message);
    const found = (data.users || []).find((user) => (user.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (!data.users || data.users.length < 200) return null;
  }
}

async function ensureProofUser() {
  let user = await findUserByEmail(EMAIL);
  if (!user) {
    const {data, error} = await service.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) fail('create proof user failed', error.message);
    user = data.user;
  } else {
    const {error} = await service.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) fail('reset proof user password failed', error.message);
  }
  userId = user.id;
  await setProfile('farm_team', ['cattle']);
  const {error} = await caller.auth.signInWithPassword({email: EMAIL, password: PASSWORD});
  if (error) fail('proof user sign-in failed', error.message);
}

async function setProfile(role, programAccess) {
  const {error} = await service.from('profiles').upsert(
    {
      id: userId,
      email: EMAIL,
      full_name: PROFILE_NAME,
      role,
      program_access: programAccess,
    },
    {onConflict: 'id'},
  );
  if (error) fail(`profiles upsert failed for ${role}`, error.message);
}

function argsFor(program) {
  return program === 'cattle'
    ? {p_cattle_id: '', p_batch_id: '', p_team_member: SPOOFED_NAME}
    : {p_sheep_id: '', p_batch_id: '', p_team_member: SPOOFED_NAME};
}

function rpcFor(program) {
  return `detach_${program}_from_processing_batch`;
}

async function expectAllowed(program, label) {
  const {data, error} = await caller.rpc(rpcFor(program), argsFor(program));
  if (error) fail(`${label}: expected ${program} authorization`, error.message);
  if (!data || data.reason !== 'bad_args')
    fail(`${label}: expected bad_args after authorization`, JSON.stringify(data));
  ok(`${label}: ${program} authorization passes to argument validation`);
}

async function expectDenied(program, label, messagePattern) {
  const {data, error} = await caller.rpc(rpcFor(program), argsFor(program));
  if (!error) fail(`${label}: expected ${program} denial`, JSON.stringify(data));
  if (messagePattern && !messagePattern.test(error.message || '')) {
    fail(`${label}: unexpected ${program} denial`, error.message);
  }
  ok(`${label}: ${program} denied`);
}

async function cleanup() {
  // Domain cleanup is idempotent and scoped to unique proof ids.
  const errors = [];
  for (const [label, request] of [
    ['activity_events', service.from('activity_events').delete().eq('entity_id', IDS.batch)],
    ['cattle_transfers', service.from('cattle_transfers').delete().eq('cattle_id', IDS.cattle)],
    ['weigh_ins', service.from('weigh_ins').delete().eq('id', IDS.weighIn)],
    ['weigh_in_sessions', service.from('weigh_in_sessions').delete().eq('id', IDS.session)],
    ['cattle', service.from('cattle').delete().eq('id', IDS.cattle)],
    ['cattle_processing_batches', service.from('cattle_processing_batches').delete().eq('id', IDS.batch)],
  ]) {
    const result = await request;
    if (result.error) errors.push(`${label}: ${result.error.message}`);
  }
  const signOut = await caller.auth.signOut();
  if (signOut.error) errors.push(`signOut: ${signOut.error.message}`);
  if (userId) {
    const authDelete = await service.auth.admin.deleteUser(userId);
    if (authDelete.error) errors.push(`auth user: ${authDelete.error.message}`);
    const profileDelete = await service.from('profiles').delete().eq('id', userId);
    if (profileDelete.error) errors.push(`profile: ${profileDelete.error.message}`);
  }
  if (errors.length > 0) fail('proof cleanup failed', errors.join('; '));
}

async function proveRealFarmTeamDetach() {
  await setProfile('farm_team', ['cattle']);

  let result = await service.from('cattle_processing_batches').insert({
    id: IDS.batch,
    name: 'Detach 170 Proof Batch',
    planned_process_date: '2026-07-10',
    status: 'active',
    cows_detail: [{cattle_id: IDS.cattle, tag: IDS.tag, live_weight: 1000, hanging_weight: null}],
    total_live_weight: 1000,
    total_hanging_weight: null,
  });
  if (result.error) fail('seed proof batch failed', result.error.message);

  result = await service.from('cattle').insert({
    id: IDS.cattle,
    tag: IDS.tag,
    herd: 'processed',
    processing_batch_id: IDS.batch,
    old_tags: [],
  });
  if (result.error) fail('seed proof cattle failed', result.error.message);

  result = await service.from('weigh_in_sessions').insert({
    id: IDS.session,
    species: 'cattle',
    date: '2026-07-10',
    team_member: PROFILE_NAME,
    herd: 'finishers',
    status: 'draft',
    started_at: '2026-07-10T12:00:00Z',
  });
  if (result.error) fail('seed proof session failed', result.error.message);

  result = await service.from('weigh_ins').insert({
    id: IDS.weighIn,
    session_id: IDS.session,
    tag: IDS.tag,
    weight: 1000,
    new_tag_flag: false,
    send_to_processor: true,
    target_processing_batch_id: IDS.batch,
    prior_herd_or_flock: 'finishers',
    entered_at: '2026-07-10T12:01:00Z',
  });
  if (result.error) fail('seed proof weigh-in failed', result.error.message);

  const detached = await caller.rpc('detach_cattle_from_processing_batch', {
    p_cattle_id: IDS.cattle,
    p_batch_id: IDS.batch,
    p_team_member: SPOOFED_NAME,
  });
  if (detached.error) fail('farm_team real detach failed', detached.error.message);
  if (!detached.data?.ok) fail('farm_team real detach did not return ok', JSON.stringify(detached.data));

  const [cowResult, batchResult, weighInResult, transferResult, activityResult] = await Promise.all([
    service.from('cattle').select('herd,processing_batch_id').eq('id', IDS.cattle).single(),
    service.from('cattle_processing_batches').select('cows_detail').eq('id', IDS.batch).single(),
    service.from('weigh_ins').select('send_to_processor,target_processing_batch_id').eq('id', IDS.weighIn).single(),
    service
      .from('cattle_transfers')
      .select('team_member,reason,to_herd')
      .eq('cattle_id', IDS.cattle)
      .eq('reason', 'processing_batch_undo')
      .single(),
    service
      .from('activity_events')
      .select('actor_profile_id,payload')
      .eq('entity_type', 'cattle.processing')
      .eq('entity_id', IDS.batch)
      .single(),
  ]);
  for (const [label, query] of [
    ['cattle read', cowResult],
    ['batch read', batchResult],
    ['weigh-in read', weighInResult],
    ['transfer read', transferResult],
    ['activity read', activityResult],
  ]) {
    if (query.error) fail(label, query.error.message);
  }

  if (cowResult.data.herd !== 'finishers' || cowResult.data.processing_batch_id !== null) {
    fail('animal was not atomically restored', JSON.stringify(cowResult.data));
  }
  if ((batchResult.data.cows_detail || []).length !== 0) fail('batch detail was not cleared');
  if (weighInResult.data.send_to_processor !== false || weighInResult.data.target_processing_batch_id !== null) {
    fail('weigh-in flags were not cleared', JSON.stringify(weighInResult.data));
  }
  if (transferResult.data.team_member !== PROFILE_NAME || transferResult.data.team_member === SPOOFED_NAME) {
    fail('transfer attribution trusted client input', JSON.stringify(transferResult.data));
  }
  if (
    activityResult.data.actor_profile_id !== userId ||
    activityResult.data.payload?.team_member !== PROFILE_NAME ||
    activityResult.data.payload?.team_member === SPOOFED_NAME
  ) {
    fail('Activity attribution was not server-stamped', JSON.stringify(activityResult.data));
  }
  ok('real farm_team cattle detach is atomic and server-stamped');
}

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '170_processing_detach_farm_team.sql'),
    'utf8',
  );
  const {error: applyError} = await service.rpc('exec_sql', {sql: body});
  if (applyError) fail('migration 170 apply failed', applyError.message);
  await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));
  ok('migration 170 applied');

  const structuralProof = `
DO $proof$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'detach_cattle_from_processing_batch',
    'detach_sheep_from_processing_batch'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = v_name
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public']::text[]
    ) THEN
      RAISE EXCEPTION '% missing SECURITY DEFINER/search_path contract', v_name;
    END IF;
    IF has_function_privilege('anon', format('public.%I(text,text,text)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '% leaks EXECUTE to anon/PUBLIC', v_name;
    END IF;
    IF NOT has_function_privilege('authenticated', format('public.%I(text,text,text)', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '% missing authenticated EXECUTE', v_name;
    END IF;
    IF obj_description(format('public.%I(text,text,text)', v_name)::regprocedure, 'pg_proc') IS NULL THEN
      RAISE EXCEPTION '% missing API comment', v_name;
    END IF;
  END LOOP;
END
$proof$;`;
  const {error: structuralError} = await service.rpc('exec_sql', {sql: structuralProof});
  if (structuralError) fail('migration 170 structural proof failed', structuralError.message);
  ok('SECDEF/search_path/grants/API comments verified');

  await ensureProofUser();

  await setProfile('admin', ['pig']);
  await expectAllowed('cattle', 'admin with unrelated program_access');
  await expectAllowed('sheep', 'admin with unrelated program_access');

  await setProfile('management', ['pig']);
  await expectAllowed('cattle', 'management with unrelated program_access');
  await expectAllowed('sheep', 'management with unrelated program_access');

  await setProfile('farm_team', null);
  await expectAllowed('cattle', 'farm_team with null program_access');
  await expectAllowed('sheep', 'farm_team with null program_access');

  await setProfile('farm_team', []);
  await expectAllowed('cattle', 'farm_team with empty program_access');
  await expectAllowed('sheep', 'farm_team with empty program_access');

  await setProfile('farm_team', ['cattle']);
  await expectAllowed('cattle', 'farm_team with cattle access');
  await expectDenied('sheep', 'farm_team with cattle access', /sheep program access required/i);

  await setProfile('farm_team', ['sheep']);
  await expectAllowed('sheep', 'farm_team with sheep access');
  await expectDenied('cattle', 'farm_team with sheep access', /cattle program access required/i);

  await setProfile('farm_team', ['pig']);
  await expectDenied('cattle', 'farm_team with unrelated access', /cattle program access required/i);
  await expectDenied('sheep', 'farm_team with unrelated access', /sheep program access required/i);

  for (const role of ['light', 'equipment_tech', 'inactive']) {
    await setProfile(role, ['cattle', 'sheep']);
    await expectDenied('cattle', role, /caller role .* cannot detach/i);
    await expectDenied('sheep', role, /caller role .* cannot detach/i);
  }

  for (const program of ['cattle', 'sheep']) {
    const {data, error} = await anon.rpc(rpcFor(program), argsFor(program));
    if (!error) fail(`anon unexpectedly called ${program} detach`, JSON.stringify(data));
    ok(`anon: ${program} denied`);
  }

  await proveRealFarmTeamDetach();
  await cleanup();
  ok('proof rows and user cleaned up');
  console.log('ALL MIGRATION 170 CHECKS PASSED');
})().catch(async (error) => {
  console.error(error.message || error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('cleanup failed:', cleanupError.message || cleanupError);
  }
  process.exit(1);
});
