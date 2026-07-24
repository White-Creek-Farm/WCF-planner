// Apply migration 191 to TEST D and prove the attachment-rename RPC contract
// through the repository's established service-role exec_sql channel.
//
// TEST-D-ONLY. Hard-refuses PROD and every non-D target: the URL must contain
// the TEST D project ref (any other ref — PROD, test-a/b/c, test-main — is
// refused before a single statement runs). The migration is CREATE OR REPLACE +
// REVOKE/GRANT + NOTIFY, so re-running is idempotent. Disposable rows/users are
// fully cleaned up in finally. Touches no shared CI workflow.
//
// Proof matrix (rename_processing_attachment, mig 191):
//   1. exec_sql applies the EXACT migration verbatim (multi-statement + NOTIFY).
//   2. anon is DENIED (REVOKE from anon + PostgREST exposure).
//   3. an authenticated OPERATIONAL (admin) caller renames successfully — which
//      proves the definition, the authenticated EXECUTE grant, the pinned
//      search_path, and the operational gate all resolve (filename changes
//      server-side while storage_path does not).
//   4. the linked processing comment's attachment metadata name updates for the
//      exact bucket + storage_path (coherence).
//   5. truthful Activity records old + new filename.
//   6. an invalid name (path separator) is rejected (PROCESSING_VALIDATION).
//   7. an unchanged name is an idempotent no-op (no duplicate Activity).
//   8. a pending-delete attachment fails closed.

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

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
const TEST_D_REF = 'ycwnlcgdwaimmxbjbyry';
if (process.env.WCF_TEST_DATABASE !== '1') {
  console.error('refusing: WCF_TEST_DATABASE must be 1');
  process.exit(2);
}
if (!url || !serviceKey || !anonKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_ANON_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing: URL matches the PROD project ref');
  process.exit(2);
}
if (!url.includes(TEST_D_REF)) {
  console.error('refusing: this proof is TEST D only (URL must be the TEST D project)');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const REC = `ptest-mig191-${stamp}`;
const ATT = `pat-mig191-${stamp}`;
const CMT = `cmt-mig191-${stamp}`;
const STORAGE_PATH = `native/${REC}/${ATT}-kill-sheet.jpg`;
const OLD = 'kill-sheet.jpg';
const NEW = `Kill Sheet ${stamp}.jpg`;
const adminUser = {
  email: `mig191-admin-${stamp}@wcfplanner.test`,
  password: 'Mig191!AdminProof',
  id: null,
  role: 'admin',
};

let checks = 0;
function must(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  checks += 1;
  console.log(`ok ${checks}. ${label}`);
}

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) throw new Error(`${label}: ${error.message || String(error)}`);
}

async function makeUser(u) {
  const created = await service.auth.admin.createUser({email: u.email, password: u.password, email_confirm: true});
  if (created.error) throw new Error(`createUser ${u.role}: ${created.error.message}`);
  u.id = created.data.user.id;
  const prof = await service
    .from('profiles')
    .upsert({id: u.id, email: u.email, full_name: `Mig191 ${u.role}`, role: u.role});
  if (prof.error) throw new Error(`profile ${u.role}: ${prof.error.message}`);
}

async function signIn(client, u) {
  const {error} = await client.auth.signInWithPassword({email: u.email, password: u.password});
  if (error) throw new Error(`signIn ${u.role}: ${error.message}`);
}

// Retry while PostgREST is still reloading its schema cache after the NOTIFY.
async function rpcReady(client, name, params, {tries = 20, delayMs = 1000} = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await client.rpc(name, params);
    const msg = (last.error && (last.error.message || '')) || '';
    if (last.error && /schema cache|Could not find the function|PGRST202|does not exist/i.test(msg)) {
      await sleep(delayMs);
      continue;
    }
    return last;
  }
  return last;
}

async function renameActivityRows() {
  const {data} = await service.from('activity_events').select('payload').eq('entity_id', REC);
  return (data || []).filter((a) => a.payload && a.payload.action === 'rename_attachment');
}

async function cleanup() {
  try {
    await service.from('processing_records').delete().eq('id', REC); // CASCADE removes the attachment
  } catch (_e) {
    /* best effort */
  }
  try {
    await service.from('comments').delete().eq('id', CMT);
  } catch (_e) {
    /* best effort */
  }
  try {
    await service.from('activity_events').delete().eq('entity_id', REC);
  } catch (_e) {
    /* best effort */
  }
  if (adminUser.id) {
    try {
      await service.from('profiles').delete().eq('id', adminUser.id);
    } catch (_e) {
      /* best effort */
    }
    try {
      await service.auth.admin.deleteUser(adminUser.id);
    } catch (_e) {
      /* best effort */
    }
  }
  try {
    await admin.auth.signOut();
  } catch (_e) {
    /* best effort */
  }
}

(async () => {
  try {
    // 1. exec_sql applies the exact migration verbatim (idempotent).
    const migSql = fs.readFileSync(
      path.join(__dirname, '..', 'supabase-migrations', '191_processing_attachment_rename.sql'),
      'utf8',
    );
    await execSql(migSql, 'apply mig 191 via exec_sql');
    must(true, 'exec_sql applied migration 191 verbatim (multi-statement + NOTIFY)');

    // Seed disposable admin + record + native attachment + linked comment.
    await makeUser(adminUser);
    const recRes = await service.from('processing_records').upsert({
      id: REC,
      record_type: 'asana_historical',
      program: 'broiler',
      title: 'TEST mig191 rename',
      processing_date: '2026-03-15',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminUser.id,
    });
    if (recRes.error) throw new Error(`seed record: ${recRes.error.message}`);
    const attRes = await service.from('processing_attachments').insert({
      id: ATT,
      record_id: REC,
      filename: OLD,
      content_type: 'image/jpeg',
      size_bytes: 123,
      storage_path: STORAGE_PATH,
      created_by: adminUser.id,
    });
    if (attRes.error) throw new Error(`seed attachment: ${attRes.error.message}`);
    const cmtRes = await service.from('comments').insert({
      id: CMT,
      entity_type: 'processing.record',
      entity_id: REC,
      author_profile_id: adminUser.id,
      body: 'kill sheet attached',
      attachments: [
        {bucket: 'processing-attachments', path: STORAGE_PATH, name: OLD, mime: 'image/jpeg', is_image: true},
      ],
    });
    if (cmtRes.error) throw new Error(`seed comment: ${cmtRes.error.message}`);
    must(true, 'seeded disposable admin + record + attachment + linked comment');

    await signIn(admin, adminUser);

    // 2. anon is denied (REVOKE + exposure).
    const anonRes = await anon.rpc('rename_processing_attachment', {p_id: ATT, p_filename: 'hacked.jpg'});
    must(
      anonRes.error &&
        (anonRes.error.code === '42501' || /permission denied|not authorized|PGRST/i.test(anonRes.error.message || '')),
      `anon is denied (${anonRes.error && (anonRes.error.code || anonRes.error.message)})`,
    );

    // 3. authenticated operational rename succeeds — proves definition + grant +
    //    search_path + operational gate.
    const okRes = await rpcReady(admin, 'rename_processing_attachment', {p_id: ATT, p_filename: NEW});
    must(!okRes.error, `operational rename succeeds (${okRes.error && okRes.error.message})`);
    must(
      okRes.data && okRes.data.status === 'renamed' && okRes.data.new_filename === NEW,
      'rename returns status=renamed + new_filename',
    );
    const row = await service.from('processing_attachments').select('filename, storage_path').eq('id', ATT).single();
    must(row.data.filename === NEW, 'filename changed server-side');
    must(row.data.storage_path === STORAGE_PATH, 'storage_path UNCHANGED (metadata-only)');

    // 4. linked comment attachment name coherence.
    const cmt = await service.from('comments').select('attachments').eq('id', CMT).single();
    const entry = (cmt.data.attachments || []).find((e) => e.path === STORAGE_PATH);
    must(entry && entry.name === NEW, 'linked comment attachment name updated for the exact bucket+path');

    // 5. truthful Activity (old + new).
    const ren = await renameActivityRows();
    must(ren.length === 1, 'exactly one rename_attachment Activity row');
    must(
      ren[0].payload.old_filename === OLD && ren[0].payload.new_filename === NEW,
      'Activity carries old + new filename',
    );
    must(ren[0].payload.attachment_id === ATT, 'Activity carries attachment_id');

    // 6. validation: path separator rejected.
    const badRes = await admin.rpc('rename_processing_attachment', {p_id: ATT, p_filename: 'a/b.jpg'});
    must(
      badRes.error && /PROCESSING_VALIDATION/.test(badRes.error.message || ''),
      'path-separator name rejected (PROCESSING_VALIDATION)',
    );

    // 7. unchanged name is an idempotent no-op (no duplicate Activity).
    const sameRes = await admin.rpc('rename_processing_attachment', {p_id: ATT, p_filename: NEW});
    must(!sameRes.error && sameRes.data && sameRes.data.status === 'unchanged', 'unchanged name -> status=unchanged');
    const ren2 = await renameActivityRows();
    must(ren2.length === 1, 'unchanged replay emitted NO duplicate Activity');

    // 8. pending-delete attachment fails closed.
    await service
      .from('processing_attachments')
      .update({delete_requested_at: new Date().toISOString(), delete_requested_by: adminUser.id})
      .eq('id', ATT);
    const pendRes = await admin.rpc('rename_processing_attachment', {p_id: ATT, p_filename: 'later.jpg'});
    must(
      pendRes.error && /PROCESSING_VALIDATION/.test(pendRes.error.message || ''),
      'pending-delete attachment fails closed',
    );
    await service
      .from('processing_attachments')
      .update({delete_requested_at: null, delete_requested_by: null})
      .eq('id', ATT);

    console.log(
      `\nALL ${checks} CHECKS PASSED — migration 191 applied via exec_sql + RPC contract verified on TEST D.`,
    );
  } catch (e) {
    console.error('PROOF FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
