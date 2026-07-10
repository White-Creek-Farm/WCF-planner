// Apply mig 166 (native processing-attachments upload boundary) to TEST via
// exec_sql, then behaviorally verify:
//   1. an OPERATIONAL authenticated user can upload BYTES under
//      native/<record id>/… (INSERT policy) and read them back via a signed URL
//      (mig 163 SELECT policy);
//   2. an upload OUTSIDE the native/ namespace is refused by RLS;
//   3. a LIGHT user cannot upload anywhere in the bucket; anon cannot upload;
//   4. add_processing_attachment registers the metadata row (caller provenance,
//      replay-idempotent) and refuses wrong-namespace paths, other records'
//      paths, oversize declarations, and missing filenames;
//   5. authenticated users cannot UPDATE/DELETE bucket objects (append-only).
// All uploaded objects, metadata rows, and the temp light user are cleaned up.
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
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

function die(msg) {
  throw new Error(msg);
}

const BUCKET = 'processing-attachments';
const REC = 'mig166-rec-1';
const ATT_ID = 'mig166-att-1';
const GOOD_PATH = `native/${REC}/${ATT_ID}-proof.txt`;
const BAD_PATH = `asana-namespace/${REC}/sneaky.txt`;
const LIGHT_EMAIL = 'mig166-light@example.test';

(async () => {
  console.log(`TEST url=${url}`);
  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const {data: me} = await authed.auth.getUser();
  const adminId = me.user.id;

  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '166_processing_attachments_upload.sql'),
    'utf8',
  );
  console.log(`applying 166_processing_attachments_upload.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2500));

  let lightUserId = null;
  const cleanup = async () => {
    await service.storage.from(BUCKET).remove([GOOD_PATH, BAD_PATH, `native/${REC}/light.txt`]);
    await service.from('processing_attachments').delete().eq('record_id', REC);
    await service.from('activity_events').delete().eq('entity_id', REC);
    await service.from('processing_records').delete().eq('id', REC);
    if (lightUserId) {
      await service.from('profiles').delete().eq('id', lightUserId);
      await service.auth.admin.deleteUser(lightUserId).catch(() => {});
    }
  };

  try {
    // Seed the parent record.
    const {error: seedErr} = await service.from('processing_records').insert({
      id: REC,
      record_type: 'asana_historical',
      program: 'pig',
      title: 'MIG166 record',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    });
    if (seedErr) die('seed record failed: ' + seedErr.message);

    // ── 1. operational upload into native/<record>/ + signed read ────────────
    const bytes = new Blob(['mig166 attachment proof'], {type: 'text/plain'});
    const up = await authed.storage.from(BUCKET).upload(GOOD_PATH, bytes, {upsert: false, contentType: 'text/plain'});
    if (up.error) die('operational native upload should succeed: ' + up.error.message);
    const {data: signed, error: signUrlErr} = await authed.storage.from(BUCKET).createSignedUrl(GOOD_PATH, 120);
    if (signUrlErr || !signed || !signed.signedUrl) die('signed URL should mint for operational reader');
    const fetched = await fetch(signed.signedUrl);
    if (!fetched.ok) die('signed URL fetch failed: ' + fetched.status);
    const text = await fetched.text();
    if (text !== 'mig166 attachment proof') die('signed URL returned wrong bytes');
    console.log('  [ok] operational upload under native/<record>/ + signed open/download');

    // ── 2. outside the native/ namespace → RLS refusal ────────────────────────
    const badUp = await authed.storage.from(BUCKET).upload(BAD_PATH, bytes, {upsert: false});
    if (!badUp.error) die('upload OUTSIDE native/ must be refused');
    console.log('  [ok] non-native namespace upload refused');

    // ── 3. light + anon cannot upload ─────────────────────────────────────────
    const created = await service.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: 'mig166-light-pass-1!',
      email_confirm: true,
    });
    if (created.error) die('light createUser failed: ' + created.error.message);
    lightUserId = created.data.user.id;
    await service.from('profiles').upsert({id: lightUserId, full_name: 'MIG166 Light', role: 'light'});
    const lightSb = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
    const {error: lSign} = await lightSb.auth.signInWithPassword({
      email: LIGHT_EMAIL,
      password: 'mig166-light-pass-1!',
    });
    if (lSign) die('light signIn failed: ' + lSign.message);
    const lightUp = await lightSb.storage.from(BUCKET).upload(`native/${REC}/light.txt`, bytes, {upsert: false});
    if (!lightUp.error) die('light upload must be refused');
    const anonUp = await anon.storage.from(BUCKET).upload(`native/${REC}/anon.txt`, bytes, {upsert: false});
    if (!anonUp.error) die('anon upload must be refused');
    // Light also has no read (mig 163 SELECT policy).
    const lightSigned = await lightSb.storage.from(BUCKET).createSignedUrl(GOOD_PATH, 120);
    if (!lightSigned.error) die('light signed URL must be refused');
    console.log('  [ok] light + anon uploads refused; light signed read refused');

    // ── 4. metadata registration RPC ─────────────────────────────────────────
    const reg = await authed.rpc('add_processing_attachment', {
      p_row: {
        id: ATT_ID,
        record_id: REC,
        filename: 'proof.txt',
        content_type: 'text/plain',
        size_bytes: 23,
        storage_path: GOOD_PATH,
      },
    });
    if (reg.error) die('add_processing_attachment failed: ' + reg.error.message);
    const {data: attRow} = await service
      .from('processing_attachments')
      .select('filename, size_bytes, storage_path, created_by, asana_attachment_gid')
      .eq('id', ATT_ID)
      .single();
    if (attRow.created_by !== adminId) die('native attachment must carry caller provenance');
    if (attRow.asana_attachment_gid !== null) die('native attachment must have NO asana gid');
    const replay = await authed.rpc('add_processing_attachment', {
      p_row: {id: ATT_ID, record_id: REC, filename: 'proof.txt', storage_path: GOOD_PATH},
    });
    if (replay.error || replay.data.replayed !== true) die('replay should no-op: ' + JSON.stringify(replay.data));
    const wrongNs = await authed.rpc('add_processing_attachment', {
      p_row: {id: 'mig166-att-2', record_id: REC, filename: 'x.txt', storage_path: BAD_PATH},
    });
    if (!wrongNs.error) die('non-native storage_path must be refused');
    const wrongRec = await authed.rpc('add_processing_attachment', {
      p_row: {id: 'mig166-att-3', record_id: REC, filename: 'x.txt', storage_path: 'native/other-record/x.txt'},
    });
    if (!wrongRec.error) die("another record's path must be refused");
    const oversize = await authed.rpc('add_processing_attachment', {
      p_row: {
        id: 'mig166-att-4',
        record_id: REC,
        filename: 'x.txt',
        storage_path: `native/${REC}/x.txt`,
        size_bytes: 99999999999,
      },
    });
    if (!oversize.error) die('oversize declaration must be refused');
    const noName = await authed.rpc('add_processing_attachment', {
      p_row: {id: 'mig166-att-5', record_id: REC, filename: '  ', storage_path: `native/${REC}/x.txt`},
    });
    if (!noName.error) die('missing filename must be refused');
    const lightReg = await lightSb.rpc('add_processing_attachment', {
      p_row: {id: 'mig166-att-6', record_id: REC, filename: 'x.txt', storage_path: `native/${REC}/x.txt`},
    });
    if (!lightReg.error) die('light must be refused on add_processing_attachment');
    console.log('  [ok] add_processing_attachment provenance/replay/namespace/size/name/role checks');

    // ── 5. append-only: no authenticated UPDATE/DELETE ────────────────────────
    const overwrite = await authed.storage.from(BUCKET).upload(GOOD_PATH, new Blob(['tampered']), {upsert: true});
    if (!overwrite.error) die('authenticated overwrite (upsert) must be refused — append-only bucket');
    const del = await authed.storage.from(BUCKET).remove([GOOD_PATH]);
    // storage.remove returns per-object results; RLS-denied delete surfaces as
    // error OR an empty deletion list with the object still present.
    const {data: still} = await service.storage.from(BUCKET).download(GOOD_PATH);
    if (!still) die('object must survive an authenticated delete attempt');
    if (!del.error) {
      const survived = await service.storage.from(BUCKET).download(GOOD_PATH);
      if (!survived.data) die('authenticated delete must not remove objects');
    }
    console.log('  [ok] bucket is append-only for authenticated users (no overwrite / delete)');
  } finally {
    await cleanup();
  }

  console.log('mig166 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
