// Apply mig 161 (archive_processing_record soft-delete) to TEST via exec_sql, then
// verify: an Asana-owned record archives (archived=true) with its link preserved,
// restore works, and a planner_batch is refused. Cleans up synthetic rows.
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
  console.error('missing TEST env');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const EX = 'prc-mig161-ex';
const PB = 'prc-mig161-pb';
const LINK = {id: 'pal-mig161', gid: 'ag-mig161'};
function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}
async function cleanup() {
  await service.from('processing_asana_links').delete().eq('id', LINK.id);
  await service.from('processing_records').delete().in('id', [EX, PB]);
}
(async () => {
  console.log(`TEST url=${url}`);
  const {data: signIn, error: signErr} = await authed.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const uid = signIn.user.id;
  await cleanup();
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '161_processing_archive_record.sql'),
    'utf8',
  );
  console.log(`applying 161_processing_archive_record.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2000));

  const {error: recErr} = await service.from('processing_records').insert([
    {
      id: EX,
      record_type: 'import_exception',
      program: 'broiler',
      title: 'mig161 exception',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: PB,
      record_type: 'planner_batch',
      program: 'cattle',
      title: 'mig161 planner',
      source_kind: 'cattle',
      source_id: 'cattle:mig161',
      match_status: 'native',
      created_by: uid,
    },
  ]);
  if (recErr) die('record seed failed: ' + (recErr.message || recErr));
  const {error: linkErr} = await service.from('processing_asana_links').insert([
    {
      id: LINK.id,
      asana_gid: LINK.gid,
      processing_record_id: EX,
      program: 'broiler',
      match_status: 'historical',
      match_method: 'historical',
      candidate_record_ids: [],
    },
  ]);
  if (linkErr) die('link seed failed: ' + (linkErr.message || linkErr));

  // Archive the asana-owned record.
  const {error: aErr} = await authed.rpc('archive_processing_record', {p_id: EX, p_archived: true});
  if (aErr) die('archive failed: ' + (aErr.message || aErr));
  const ex = (await service.from('processing_records').select('archived').eq('id', EX).maybeSingle()).data;
  if (!ex || ex.archived !== true) die('archive: record should be archived');
  const link = (
    await service.from('processing_asana_links').select('processing_record_id').eq('id', LINK.id).maybeSingle()
  ).data;
  if (!link || link.processing_record_id !== EX) die('archive: Asana link/provenance must be preserved');
  console.log('  [ok] Asana-owned record archived; link preserved');

  // Restore.
  const {error: rErr} = await authed.rpc('archive_processing_record', {p_id: EX, p_archived: false});
  if (rErr) die('restore failed: ' + (rErr.message || rErr));
  const ex2 = (await service.from('processing_records').select('archived').eq('id', EX).maybeSingle()).data;
  if (!ex2 || ex2.archived !== false) die('restore: record should be un-archived');
  console.log('  [ok] restore (un-archive) works');

  // Planner_batch refused.
  const {error: pbErr} = await authed.rpc('archive_processing_record', {p_id: PB, p_archived: true});
  if (!pbErr) die('planner_batch archive should be refused');
  console.log('  [ok] planner_batch archive refused');

  await cleanup();
  console.log('mig161 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (e) => {
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
