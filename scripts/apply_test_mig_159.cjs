// Apply mig 159 (Processing reconciliation workbench RPCs) to TEST via exec_sql,
// then behaviorally verify:
//   1. resolve_processing_asana_link reassigns an import_exception link to a
//      planner_batch, REPARENTS its subtask/comment/attachment, and archives the
//      emptied placeholder.
//   2. triage_processing_asana_record reclassifies an import_exception to milestone.
//   3. supersede_processing_asana_duplicate blocks a duplicate link (provenance
//      kept), archives its orphaned placeholder, and leaves the canonical + its
//      planner_batch untouched.
//   4. list_processing_reconciliation returns the enriched shape (bucket + record
//      + candidates + duplicate_groups).
// Setup uses the service role (bypasses deny-all RLS); the RPCs are called as an
// authenticated admin (operational gate). Cleans up every synthetic row.
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
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const REC = {
  PB1: 'prc-mig159-pb1',
  EX1: 'prc-mig159-ex1',
  EX2: 'prc-mig159-ex2',
  EX3: 'prc-mig159-ex3',
  DUP_CANON: 'prc-mig159-dup-canon',
  DUP_EX: 'prc-mig159-dup-ex',
  DUP2A: 'prc-mig159-dup2a',
  DUP2B: 'prc-mig159-dup2b',
};
const LINK = {
  EX1: {id: 'pal-mig159-ex1', gid: 'ag-mig159-ex1'},
  EX2: {id: 'pal-mig159-ex2', gid: 'ag-mig159-ex2'},
  EX3: {id: 'pal-mig159-ex3', gid: 'ag-mig159-ex3'},
  DUPA: {id: 'pal-mig159-dupa', gid: 'ag-mig159-dupa'},
  DUPB: {id: 'pal-mig159-dupb', gid: 'ag-mig159-dupb'},
  DUP2A: {id: 'pal-mig159-dup2a', gid: 'ag-mig159-dup2a'},
  DUP2B: {id: 'pal-mig159-dup2b', gid: 'ag-mig159-dup2b'},
};
const SUB = 'pst-mig159';
const CMT = 'cmt-mig159';
const ATT = 'pat-mig159';

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function cleanup() {
  await service.from('processing_attachments').delete().in('id', [ATT]);
  await service.from('processing_subtasks').delete().in('id', [SUB]);
  await service.from('comments').delete().in('id', [CMT]);
  await service
    .from('processing_asana_links')
    .delete()
    .in(
      'id',
      Object.values(LINK).map((l) => l.id),
    );
  await service.from('processing_records').delete().in('id', Object.values(REC));
}

async function rec(id) {
  const {data, error} = await service.from('processing_records').select('*').eq('id', id).maybeSingle();
  if (error) die(`read record ${id}: ${error.message}`);
  return data;
}
async function link(gid) {
  const {data, error} = await service.from('processing_asana_links').select('*').eq('asana_gid', gid).maybeSingle();
  if (error) die(`read link ${gid}: ${error.message}`);
  return data;
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

  // ---- apply 159 ------------------------------------------------------------
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '159_processing_reconciliation_workbench.sql'),
    'utf8',
  );
  console.log(`applying 159_processing_reconciliation_workbench.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2500));

  // ---- seed records ---------------------------------------------------------
  const {error: recErr} = await service.from('processing_records').insert([
    {
      id: REC.PB1,
      record_type: 'planner_batch',
      program: 'broiler',
      title: 'WCF-B-26-90',
      source_kind: 'broiler',
      source_id: 'broiler:B-26-90',
      match_status: 'native',
      created_by: uid,
    },
    {
      id: REC.EX1,
      record_type: 'import_exception',
      program: 'broiler',
      title: 'WCF-B-26-91',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: REC.EX2,
      record_type: 'import_exception',
      program: 'broiler',
      title: 'add 240 whole birds?',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: REC.EX3,
      record_type: 'import_exception',
      program: 'broiler',
      title: '1400 birds/month thereafter',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: REC.DUP_CANON,
      record_type: 'planner_batch',
      program: 'cattle',
      title: 'WCF-C-26-90',
      source_kind: 'cattle',
      source_id: 'cattle:C-26-90',
      match_status: 'native',
      created_by: uid,
    },
    {
      id: REC.DUP_EX,
      record_type: 'import_exception',
      program: 'cattle',
      title: 'WCF-C-26-90 dup',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: REC.DUP2A,
      record_type: 'import_exception',
      program: 'broiler',
      title: 'WCF-B-26-95 a',
      match_status: 'unmatched',
      created_by: uid,
    },
    {
      id: REC.DUP2B,
      record_type: 'import_exception',
      program: 'broiler',
      title: 'WCF-B-26-95 b',
      match_status: 'unmatched',
      created_by: uid,
    },
  ]);
  if (recErr) die('record seed failed: ' + (recErr.message || recErr));

  const {error: linkErr} = await service.from('processing_asana_links').insert([
    {
      id: LINK.EX1.id,
      asana_gid: LINK.EX1.gid,
      processing_record_id: REC.EX1,
      program: 'broiler',
      asana_batch_code: 'WCF-B-26-91',
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
    {
      id: LINK.EX2.id,
      asana_gid: LINK.EX2.gid,
      processing_record_id: REC.EX2,
      program: 'broiler',
      asana_batch_code: null,
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
    {
      id: LINK.EX3.id,
      asana_gid: LINK.EX3.gid,
      processing_record_id: REC.EX3,
      program: 'broiler',
      asana_batch_code: null,
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
    {
      id: LINK.DUPA.id,
      asana_gid: LINK.DUPA.gid,
      processing_record_id: REC.DUP_CANON,
      program: 'cattle',
      asana_batch_code: 'WCF-C-26-90',
      match_status: 'matched',
      match_method: 'auto_exact',
      candidate_record_ids: [],
    },
    {
      id: LINK.DUPB.id,
      asana_gid: LINK.DUPB.gid,
      processing_record_id: REC.DUP_EX,
      program: 'cattle',
      asana_batch_code: 'WCF-C-26-90',
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
    {
      id: LINK.DUP2A.id,
      asana_gid: LINK.DUP2A.gid,
      processing_record_id: REC.DUP2A,
      program: 'broiler',
      asana_batch_code: 'WCF-B-26-95',
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
    {
      id: LINK.DUP2B.id,
      asana_gid: LINK.DUP2B.gid,
      processing_record_id: REC.DUP2B,
      program: 'broiler',
      asana_batch_code: 'WCF-B-26-95',
      match_status: 'needs_review',
      match_method: 'none',
      candidate_record_ids: [],
    },
  ]);
  if (linkErr) die('link seed failed: ' + (linkErr.message || linkErr));

  // Artifacts on the EX1 placeholder (to prove reparent).
  const {error: subErr} = await service
    .from('processing_subtasks')
    .insert([{id: SUB, record_id: REC.EX1, label: 'imported subtask', source: 'asana', created_by: uid}]);
  if (subErr) die('subtask seed failed: ' + (subErr.message || subErr));
  const {error: cmtErr} = await service.from('comments').insert([
    {
      id: CMT,
      entity_type: 'processing.record',
      entity_id: REC.EX1,
      author_profile_id: null,
      body: 'imported comment',
      mentions: [],
      attachments: [],
      source: 'asana',
      is_imported: true,
    },
  ]);
  if (cmtErr) die('comment seed failed: ' + (cmtErr.message || cmtErr));
  const {error: attErr} = await service
    .from('processing_attachments')
    .insert([{id: ATT, record_id: REC.EX1, filename: 'f.pdf', storage_path: 'processing/f.pdf', created_by: uid}]);
  if (attErr) die('attachment seed failed: ' + (attErr.message || attErr));

  // ---- 1. resolve reassigns + reparents + retires placeholder ---------------
  const {error: rErr} = await authed.rpc('resolve_processing_asana_link', {
    p_asana_gid: LINK.EX1.gid,
    p_record_id: REC.PB1,
  });
  if (rErr) die('resolve failed: ' + (rErr.message || rErr));

  const l1 = await link(LINK.EX1.gid);
  if (l1.processing_record_id !== REC.PB1) die(`resolve: link should point at PB1, got ${l1.processing_record_id}`);
  if (l1.match_status !== 'matched') die(`resolve: match_status should be matched, got ${l1.match_status}`);
  if (l1.match_method !== 'manual_crosswalk')
    die(`resolve: match_method should be manual_crosswalk, got ${l1.match_method}`);
  if ((await rec(REC.EX1)).archived !== true) die('resolve: emptied EX1 placeholder should be archived');
  const sub = (await service.from('processing_subtasks').select('record_id').eq('id', SUB).maybeSingle()).data;
  if (!sub || sub.record_id !== REC.PB1) die(`resolve: subtask should reparent to PB1, got ${sub && sub.record_id}`);
  const cmt = (await service.from('comments').select('entity_id').eq('id', CMT).maybeSingle()).data;
  if (!cmt || cmt.entity_id !== REC.PB1) die(`resolve: comment should reparent to PB1, got ${cmt && cmt.entity_id}`);
  const att = (await service.from('processing_attachments').select('record_id').eq('id', ATT).maybeSingle()).data;
  if (!att || att.record_id !== REC.PB1) die(`resolve: attachment should reparent to PB1, got ${att && att.record_id}`);
  console.log('  [ok] resolve reassigned link + reparented subtask/comment/attachment + archived placeholder');

  // ---- 2. triage import_exception -> milestone ------------------------------
  const {error: tErr} = await authed.rpc('triage_processing_asana_record', {
    p_record_id: REC.EX2,
    p_action: 'milestone',
  });
  if (tErr) die('triage failed: ' + (tErr.message || tErr));
  if ((await rec(REC.EX2)).record_type !== 'milestone') die('triage: EX2 should be record_type=milestone');
  if ((await link(LINK.EX2.gid)).match_status !== 'milestone') die('triage: EX2 link should be match_status=milestone');
  // never a planner_batch:
  const {error: tGuard} = await authed.rpc('triage_processing_asana_record', {
    p_record_id: REC.PB1,
    p_action: 'milestone',
  });
  if (!tGuard) die('triage: reclassifying a planner_batch should be rejected');
  console.log('  [ok] triage milestone works; a planner_batch is refused');

  // ---- 2b. triage dismiss must remove the row from the active exceptions queue
  const {error: dErr} = await authed.rpc('triage_processing_asana_record', {
    p_record_id: REC.EX3,
    p_action: 'dismiss',
  });
  if (dErr) die('triage dismiss failed: ' + (dErr.message || dErr));
  if ((await rec(REC.EX3)).archived !== true) die('dismiss: EX3 should be archived');

  // ---- 2c. a dismissed placeholder is not an active duplicate member --------
  {
    const {data: pre, error: preErr} = await authed.rpc('list_processing_reconciliation');
    if (preErr) die('dup2 pre-list failed: ' + (preErr.message || preErr));
    const g = (pre.duplicate_groups || []).find((x) => x.program === 'broiler' && x.code === 'WCF-B-26-95');
    if (!g) die('dup2: WCF-B-26-95 should be an active duplicate group before dismiss');
    if (Number(g.count) < 2) die(`dup2: WCF-B-26-95 should have 2 active members before dismiss, got ${g.count}`);
  }
  const {error: d2Err} = await authed.rpc('triage_processing_asana_record', {
    p_record_id: REC.DUP2A,
    p_action: 'dismiss',
  });
  if (d2Err) die('dup2 dismiss failed: ' + (d2Err.message || d2Err));
  {
    const {data: post, error: postErr} = await authed.rpc('list_processing_reconciliation');
    if (postErr) die('dup2 post-list failed: ' + (postErr.message || postErr));
    if ((post.duplicate_groups || []).find((x) => x.program === 'broiler' && x.code === 'WCF-B-26-95')) {
      die('dup2: WCF-B-26-95 must leave duplicate_groups after one member is dismissed');
    }
    const dLink = post.links.find((l) => l.asana_gid === LINK.DUP2A.gid);
    if (!dLink || dLink.bucket !== 'dismissed')
      die(`dup2: dismissed link should read bucket=dismissed, got ${dLink && dLink.bucket}`);
    const bLink = post.links.find((l) => l.asana_gid === LINK.DUP2B.gid);
    if (!bLink) die('dup2: DUP2B link missing from payload');
    if (bLink.duplicate_group)
      die(`dup2: sole remaining member should have no duplicate_group tag, got ${bLink.duplicate_group}`);
  }
  console.log('  [ok] dismissed archived placeholder is not an active duplicate member; group + tag cleared');

  // ---- 3. supersede a duplicate ---------------------------------------------
  const {error: sErr} = await authed.rpc('supersede_processing_asana_duplicate', {
    p_asana_gid: LINK.DUPB.gid,
    p_canonical_record_id: REC.DUP_CANON,
  });
  if (sErr) die('supersede failed: ' + (sErr.message || sErr));
  const dupb = await link(LINK.DUPB.gid);
  if (dupb.match_status !== 'duplicate_blocked')
    die(`supersede: DUPB should be duplicate_blocked, got ${dupb.match_status}`);
  if (dupb.processing_record_id !== null) die('supersede: DUPB should mirror nothing (record NULL)');
  if (!Array.isArray(dupb.candidate_record_ids) || dupb.candidate_record_ids[0] !== REC.DUP_CANON) {
    die('supersede: DUPB should note the canonical in candidate_record_ids');
  }
  if (!dupb.raw_asana_snapshot) die('supersede: DUPB provenance (raw_asana_snapshot) must be preserved');
  if ((await rec(REC.DUP_EX)).archived !== true) die('supersede: duplicate placeholder DUP_EX should be archived');
  if ((await rec(REC.DUP_CANON)).archived !== false) die('supersede: canonical planner_batch must NOT be archived');
  if ((await link(LINK.DUPA.gid)).processing_record_id !== REC.DUP_CANON)
    die('supersede: canonical link DUPA must be untouched');
  console.log('  [ok] supersede blocked the duplicate + archived its placeholder; canonical untouched');

  // ---- 4. enriched list_processing_reconciliation ---------------------------
  const {data: reconData, error: lErr} = await authed.rpc('list_processing_reconciliation');
  if (lErr) die('list_processing_reconciliation failed: ' + (lErr.message || lErr));
  if (!reconData || !Array.isArray(reconData.links)) die('list: expected links[]');
  if (!Array.isArray(reconData.duplicate_groups)) die('list: expected duplicate_groups[]');
  const anyLink = reconData.links.find((l) => l.asana_gid === LINK.DUPA.gid);
  if (!anyLink || !('bucket' in anyLink) || !('record' in anyLink) || !('candidates' in anyLink)) {
    die('list: links must be enriched with bucket + record + candidates');
  }
  console.log(
    `  [ok] list_processing_reconciliation enriched (${reconData.links.length} links, ${reconData.duplicate_groups.length} dup groups)`,
  );

  // Blocker 1: a dismissed placeholder must NOT stay in the active exceptions queue.
  const ex3Link = reconData.links.find((l) => l.asana_gid === LINK.EX3.gid);
  if (!ex3Link) die('list: EX3 link missing from payload');
  if (ex3Link.bucket === 'import_exception') die('dismiss: EX3 must NOT read as import_exception after dismiss');
  if (ex3Link.bucket !== 'dismissed') die(`dismiss: EX3 should read as dismissed, got ${ex3Link.bucket}`);
  if (Number(reconData.dismissed_count || 0) < 1) die('dismiss: dismissed_count should be >= 1');
  console.log('  [ok] dismissed placeholder left the active exceptions queue (bucket=dismissed)');

  // Blocker 2: after superseding the duplicate, the group must drop out of
  // duplicate_groups (only 1 active link left) while blocked provenance is counted.
  const stillDup = reconData.duplicate_groups.find((g) => g.program === 'cattle' && g.code === 'WCF-C-26-90');
  if (stillDup) die('duplicates: WCF-C-26-90 must NOT remain in duplicate_groups after blocking the duplicate');
  if (Number(reconData.duplicate_blocked_count || 0) < 1) die('duplicates: duplicate_blocked_count should be >= 1');
  console.log('  [ok] resolved duplicate group cleared from duplicate_groups; blocked provenance counted');

  // Blocker 2 (counts): active summary counts EXACTLY mirror the active buckets
  // (dismissed archived placeholders excluded from both).
  const activeExc = reconData.links.filter((l) => l.bucket === 'import_exception').length;
  if (Number(reconData.import_exception_count) !== activeExc) {
    die(
      `import_exception_count (${reconData.import_exception_count}) must mirror active import_exception buckets (${activeExc})`,
    );
  }
  const activeAmb = reconData.links.filter((l) => l.bucket === 'ambiguous').length;
  if (Number(reconData.needs_review_count) !== activeAmb) {
    die(`needs_review_count (${reconData.needs_review_count}) must mirror active ambiguous buckets (${activeAmb})`);
  }
  console.log('  [ok] summary counts mirror the active workbench queues (dismissed placeholders excluded)');

  await cleanup();
  console.log('mig159 verify: ALL CHECKS PASSED');
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
