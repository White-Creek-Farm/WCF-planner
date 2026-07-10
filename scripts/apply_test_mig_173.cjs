// Apply mig 173 (conversation fidelity: attachment provenance +
// record_processing_comment_media) to TEST via exec_sql, then verify:
//   1. provenance columns exist;
//   2. a file-only post inserts an imported comment (empty body, ORIGINAL
//      author + timestamp, pinned-bucket attachments metadata) plus linked
//      processing_attachments rows — ATOMICALLY;
//   3. rerun is idempotent: comment reused, zero duplicate rows;
//   4. a text comment imported earlier (sync_comments path) is ENRICHED with
//      media without touching body/author/timestamp;
//   5. an attachment_backfill-style pre-existing attachment row is ENRICHED
//      with its conversational provenance (no duplicate row, path kept);
//   6. local/native comments + locally uploaded attachments stay untouched;
//   7. service_role-only grants (admin + anon refused);
//   8. validation refusals (no attachments; unlinked parent).
// All seeded rows are cleaned up in finally.
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

const REC = 'mig173-rec-1';
const TASK_GID = 'mig173-task-1';
const FOREIGN_REC = 'mig173-rec-foreign';
const FOREIGN_TASK_GID = 'mig173-task-foreign';
const STORY_MEDIA = 'mig173-story-media';
const STORY_TEXT = 'mig173-story-text';
const ATT1 = 'mig173-att-1';
const ATT2 = 'mig173-att-2';
const ATT_PRE = 'mig173-att-pre';
const NATIVE_CMT = 'cmt-mig173-native';

const mediaRow = (storyGid, atts) => ({
  parent_asana_gid: TASK_GID,
  asana_comment_gid: storyGid,
  body: '',
  original_author_name: 'Brian Naide',
  created_at: '2026-07-08T15:01:00Z',
  mentions: [],
  attachments: atts,
});
const meta = (gid, filename) => ({
  asana_attachment_gid: gid,
  filename,
  content_type: 'image/jpeg',
  size_bytes: 240001,
  storage_path: `${TASK_GID}/${gid}-${filename}`,
  original_created_at: '2026-07-08T15:01:00Z',
});

(async () => {
  console.log(`TEST url=${url}`);
  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const {data: me} = await authed.auth.getUser();
  const adminId = me.user.id;

  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '173_processing_comment_media.sql'),
    'utf8',
  );
  console.log(`applying 173_processing_comment_media.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  // Generous settle: right after CREATE OR REPLACE, pooled connections can
  // briefly resolve the previous function body (observed on TEST).
  await new Promise((r) => setTimeout(r, 5000));

  const cleanup = async () => {
    await service.from('processing_attachments').delete().in('record_id', [REC, FOREIGN_REC]);
    await service.from('comments').delete().in('entity_id', [REC, FOREIGN_REC]);
    await service.from('activity_events').delete().in('entity_id', [REC, FOREIGN_REC]);
    await service.from('processing_asana_links').delete().in('asana_gid', [TASK_GID, FOREIGN_TASK_GID]);
    await service.from('processing_records').delete().in('id', [REC, FOREIGN_REC]);
  };

  try {
    // ── schema ────────────────────────────────────────────────────────────────
    const {error: colErr} = await service
      .from('processing_attachments')
      .select('asana_story_gid, original_author_name, comment_id')
      .limit(1);
    if (colErr) die('provenance columns missing: ' + colErr.message);
    console.log('  [ok] provenance columns present');

    // Seed parent + link + local/native rows that must stay untouched.
    await service.from('processing_records').insert({
      id: REC,
      record_type: 'asana_historical',
      program: 'broiler',
      title: 'MIG173 record',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    });
    const link = await service.rpc('link_asana_to_processing', {
      p_row: {asana_gid: TASK_GID, processing_record_id: REC, match_status: 'historical', match_method: 'historical'},
    });
    if (link.error) die('seed link failed: ' + link.error.message);
    await service.from('processing_records').insert({
      id: FOREIGN_REC,
      record_type: 'asana_historical',
      program: 'broiler',
      title: 'MIG173 foreign record',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    });
    const foreignLink = await service.rpc('link_asana_to_processing', {
      p_row: {
        asana_gid: FOREIGN_TASK_GID,
        processing_record_id: FOREIGN_REC,
        match_status: 'historical',
        match_method: 'historical',
      },
    });
    if (foreignLink.error) die('seed foreign link failed: ' + foreignLink.error.message);
    const nc = await service.from('comments').insert({
      id: NATIVE_CMT,
      entity_type: 'processing.record',
      entity_id: REC,
      author_profile_id: adminId,
      body: 'native local comment',
      mentions: [],
      attachments: [{path: 'processing.record/x/native.jpg', name: 'native.jpg', is_image: true}],
      source: 'native',
      is_imported: false,
    });
    if (nc.error) die('native comment seed failed: ' + nc.error.message);
    const na = await service.from('processing_attachments').insert({
      id: 'pat-mig173-native',
      record_id: REC,
      filename: 'native-upload.pdf',
      storage_path: `native/${REC}/pat-mig173-native-native-upload.pdf`,
      created_by: adminId,
    });
    if (na.error) die('native attachment seed failed: ' + na.error.message);

    // ── 2. file-only post → atomic comment + attachment rows ────────────────
    const r1 = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow(STORY_MEDIA, [meta(ATT1, 'kill-1.jpg'), meta(ATT2, 'kill-2.jpg')]),
    });
    if (r1.error) die('comment media insert failed: ' + r1.error.message);
    if (r1.data.comment_action !== 'inserted' || r1.data.attachments_inserted !== 2) {
      die('insert result wrong: ' + JSON.stringify(r1.data));
    }
    const {data: cmt} = await service
      .from('comments')
      .select('id, body, original_author_name, created_at, attachments, source, is_imported, author_profile_id')
      .eq('asana_comment_gid', STORY_MEDIA)
      .single();
    if (cmt.body !== '' || cmt.original_author_name !== 'Brian Naide') die('comment identity wrong');
    if (!String(cmt.created_at).startsWith('2026-07-08')) die('original timestamp lost: ' + cmt.created_at);
    if (cmt.author_profile_id !== null || cmt.source !== 'asana' || cmt.is_imported !== true) die('import flags wrong');
    if (cmt.attachments.length !== 2) die('attachments metadata missing');
    const attMeta = cmt.attachments[0];
    if (attMeta.bucket !== 'processing-attachments' || attMeta.is_image !== true || !attMeta.path.includes(ATT1)) {
      die('attachment metadata shape wrong: ' + JSON.stringify(attMeta));
    }
    const {data: attRows} = await service
      .from('processing_attachments')
      .select('asana_attachment_gid, asana_story_gid, comment_id, original_author_name')
      .eq('record_id', REC)
      .in('asana_attachment_gid', [ATT1, ATT2]);
    if (attRows.length !== 2) die('attachment rows missing');
    for (const a of attRows) {
      if (a.asana_story_gid !== STORY_MEDIA || a.comment_id !== cmt.id || a.original_author_name !== 'Brian Naide') {
        die('attachment provenance wrong: ' + JSON.stringify(a));
      }
    }
    console.log('  [ok] file-only post → imported comment (author/timestamp/media) + linked attachment rows');

    // ── 3. rerun idempotent ──────────────────────────────────────────────────
    const r2 = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow(STORY_MEDIA, [meta(ATT1, 'kill-1.jpg'), meta(ATT2, 'kill-2.jpg')]),
    });
    if (r2.error) die('rerun failed: ' + r2.error.message);
    if (r2.data.comment_action !== 'reused' || r2.data.attachments_inserted !== 0) {
      die('rerun must reuse: ' + JSON.stringify(r2.data));
    }
    const {count: cmtCount} = await service
      .from('comments')
      .select('id', {count: 'exact', head: true})
      .eq('asana_comment_gid', STORY_MEDIA);
    if (cmtCount !== 1) die('duplicate comment on rerun');
    const {count: attCount} = await service
      .from('processing_attachments')
      .select('id', {count: 'exact', head: true})
      .eq('record_id', REC);
    if (attCount !== 3) die('duplicate attachment rows on rerun (expected 3 incl. native)');
    console.log('  [ok] rerun idempotent: zero duplicate comments/rows');

    // ── 4. text comment enrichment (sync_comments-imported earlier) ─────────
    const t1 = await service.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: TASK_GID,
        asana_comment_gid: STORY_TEXT,
        body: 'text first',
        original_author_name: 'Isabel Hermann',
        created_at: '2026-07-01T08:00:00Z',
      },
    });
    if (t1.error || t1.data.action !== 'inserted') die('text comment seed failed');
    const e1 = await service.rpc('record_processing_comment_media', {
      p_row: {
        ...mediaRow(STORY_TEXT, [meta('mig173-att-3', 'late.jpg')]),
        body: 'DIFFERENT BODY MUST NOT APPLY',
        original_author_name: 'Wrong Author',
        created_at: '2030-01-01T00:00:00Z',
      },
    });
    if (e1.error || e1.data.comment_action !== 'enriched') die('enrich failed: ' + JSON.stringify(e1.data));
    const {data: enriched} = await service
      .from('comments')
      .select('body, original_author_name, created_at, attachments')
      .eq('asana_comment_gid', STORY_TEXT)
      .single();
    if (enriched.body !== 'text first' || enriched.original_author_name !== 'Isabel Hermann') {
      die('enrichment must not touch body/author');
    }
    if (!String(enriched.created_at).startsWith('2026-07-01')) die('enrichment must not touch timestamp');
    if (enriched.attachments.length !== 1) die('enrichment attachments missing');
    console.log('  [ok] earlier text comment enriched with media; body/author/timestamp immutable');

    // ── 5. attachment_backfill-compat enrichment ─────────────────────────────
    const pre = await service.rpc('record_processing_attachment', {
      p_row: {
        parent_asana_gid: TASK_GID,
        asana_attachment_gid: ATT_PRE,
        filename: 'pre.jpg',
        storage_path: `${TASK_GID}/${ATT_PRE}-pre.jpg`,
      },
    });
    if (pre.error) die('backfill-style seed failed: ' + pre.error.message);
    const e2 = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow('mig173-story-pre', [meta(ATT_PRE, 'pre.jpg')]),
    });
    if (e2.error) die('backfill enrich failed: ' + e2.error.message);
    if (e2.data.attachments_inserted !== 0 || e2.data.attachments_enriched !== 1) {
      die('backfill row must be enriched, not duplicated: ' + JSON.stringify(e2.data));
    }
    const {data: preRow} = await service
      .from('processing_attachments')
      .select('comment_id, asana_story_gid, storage_path')
      .eq('asana_attachment_gid', ATT_PRE)
      .single();
    if (!preRow.comment_id || preRow.asana_story_gid !== 'mig173-story-pre') die('provenance not backfilled');
    if (preRow.storage_path !== `${TASK_GID}/${ATT_PRE}-pre.jpg`) die('storage path must be preserved');
    // Author-only enrichment must not be skipped once comment/story provenance
    // is already present.
    await service
      .from('processing_attachments')
      .update({original_author_name: null})
      .eq('asana_attachment_gid', ATT_PRE);
    const e3 = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow('mig173-story-pre', [meta(ATT_PRE, 'pre.jpg')]),
    });
    if (e3.error || e3.data.attachments_enriched !== 1) {
      die('author-only provenance enrichment failed: ' + JSON.stringify(e3.data || e3.error));
    }
    const {data: authorFilled} = await service
      .from('processing_attachments')
      .select('original_author_name')
      .eq('asana_attachment_gid', ATT_PRE)
      .single();
    if (authorFilled.original_author_name !== 'Brian Naide') die('missing attachment author was not enriched');
    console.log('  [ok] pre-existing backfill row enriched in place (no duplicate, path kept)');

    // ── 6. local/native rows untouched ───────────────────────────────────────
    const {data: nativeCmt} = await service
      .from('comments')
      .select('body, attachments, author_profile_id')
      .eq('id', NATIVE_CMT)
      .single();
    if (nativeCmt.body !== 'native local comment' || nativeCmt.attachments[0].name !== 'native.jpg') {
      die('native comment was touched');
    }
    const {data: nativeAtt} = await service
      .from('processing_attachments')
      .select('comment_id, asana_attachment_gid')
      .eq('id', 'pat-mig173-native')
      .single();
    if (nativeAtt.comment_id !== null || nativeAtt.asana_attachment_gid !== null) die('native attachment was touched');
    console.log('  [ok] native comment + locally uploaded attachment untouched');

    // ── 7. grants ─────────────────────────────────────────────────────────────
    const adminCall = await authed.rpc('record_processing_comment_media', {p_row: mediaRow('x', [meta('y', 'z.jpg')])});
    if (!adminCall.error) die('authenticated admin must be refused (service_role only)');
    const anonCall = await anon.rpc('record_processing_comment_media', {p_row: mediaRow('x', [meta('y', 'z.jpg')])});
    if (!anonCall.error) die('anon must be refused');
    console.log('  [ok] service_role-only grants (admin + anon refused)');

    // ── 8. validation refusals ───────────────────────────────────────────────
    const noAtts = await service.rpc('record_processing_comment_media', {
      p_row: {...mediaRow('mig173-story-empty', []), attachments: []},
    });
    if (!noAtts.error) die('empty attachments must be refused');
    const badParent = await service.rpc('record_processing_comment_media', {
      p_row: {...mediaRow('mig173-story-x', [meta('mig173-att-x', 'x.jpg')]), parent_asana_gid: 'not-linked-gid'},
    });
    if (!badParent.error) die('unlinked parent must be refused');
    const foreignComment = await service.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: FOREIGN_TASK_GID,
        asana_comment_gid: 'mig173-story-cross-record',
        body: 'belongs elsewhere',
        original_author_name: 'Elsewhere',
        created_at: '2026-07-01T00:00:00Z',
      },
    });
    if (foreignComment.error) die('foreign comment seed failed: ' + foreignComment.error.message);
    const crossComment = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow('mig173-story-cross-record', [meta('mig173-att-cross-comment', 'cross.jpg')]),
    });
    if (!crossComment.error) die('cross-record comment gid reuse must be refused');

    const foreignAtt = await service.from('processing_attachments').insert({
      id: 'pat-mig173-foreign',
      record_id: FOREIGN_REC,
      filename: 'foreign.jpg',
      storage_path: `${FOREIGN_TASK_GID}/mig173-att-cross-record-foreign.jpg`,
      asana_attachment_gid: 'mig173-att-cross-record',
      created_by: adminId,
    });
    if (foreignAtt.error) die('foreign attachment seed failed: ' + foreignAtt.error.message);
    const crossAtt = await service.rpc('record_processing_comment_media', {
      p_row: mediaRow('mig173-story-cross-att', [meta('mig173-att-cross-record', 'foreign.jpg')]),
    });
    if (!crossAtt.error) die('cross-record attachment gid reuse must be refused');
    const {count: rolledBackComment} = await service
      .from('comments')
      .select('id', {count: 'exact', head: true})
      .eq('asana_comment_gid', 'mig173-story-cross-att');
    if (rolledBackComment !== 0) die('attachment conflict must roll back the new comment atomically');
    console.log('  [ok] validation refusals (no media, unlinked parent, cross-record gid conflicts)');
  } finally {
    await cleanup();
  }

  console.log('mig173 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
