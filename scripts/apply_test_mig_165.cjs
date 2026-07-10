// Apply mig 165 (import history + mentions + user-mapped assignees) to TEST via
// exec_sql, then behaviorally verify (service-role importer RPCs, exactly as the
// Edge Function calls them):
//   1. record_processing_history_event: system story → activity_events row with
//      DETERMINISTIC id 'ae-asana-<gid>', ORIGINAL timestamp, NULL actor;
//      re-run → skipped (idempotent);
//   2. record_processing_comment: insert with profile-mapped mentions; re-offer
//      of the same gid → skipped; a mention re-offer for a mention-less stored
//      comment → mentions_backfilled (body/author/timestamp untouched);
//   3. upsert_processing_subtask_from_asana: imports assignee_profile_id; a
//      LOCAL reassignment (update_processing_subtask) survives a re-import;
//      done_locally_set still gates done (mig 157 rule preserved);
//   4. upsert_processing_from_asana: imports assignee_name/profile; a local
//      set_processing_assignee wins over every later import.
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

function die(msg) {
  throw new Error(msg);
}

const REC = 'mig165-hist-1';
const TASK_GID = 'mig165-task-9001';
const STORY_GID = 'mig165-story-1';
const CMT_GID_1 = 'mig165-cmt-1';
const CMT_GID_2 = 'mig165-cmt-2';
const SUB_GID = 'mig165-sub-1';
const REC2_GID = 'mig165-task-9002';

(async () => {
  console.log(`TEST url=${url}`);
  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const {data: me} = await authed.auth.getUser();
  const adminId = me.user.id;

  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '165_processing_import_history.sql'),
    'utf8',
  );
  console.log(`applying 165_processing_import_history.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2500));

  const cleanup = async () => {
    await service.from('comments').delete().in('asana_comment_gid', [CMT_GID_1, CMT_GID_2]);
    await service
      .from('activity_events')
      .delete()
      .eq('id', 'ae-asana-' + STORY_GID);
    await service.from('activity_events').delete().eq('entity_id', REC);
    await service.from('processing_asana_links').delete().in('asana_gid', [TASK_GID, REC2_GID]);
    await service.from('processing_records').delete().eq('id', REC);
    await service.from('processing_records').delete().eq('asana_gid', REC2_GID);
  };

  try {
    // Seed: one historical record + a link so importer parents resolve.
    const {error: seedErr} = await service.from('processing_records').insert({
      id: REC,
      record_type: 'asana_historical',
      program: 'cattle',
      title: 'MIG165 historical',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    });
    if (seedErr) die('seed record failed: ' + seedErr.message);
    const linkRes = await service.rpc('link_asana_to_processing', {
      p_row: {asana_gid: TASK_GID, processing_record_id: REC, match_status: 'historical', match_method: 'historical'},
    });
    if (linkRes.error) die('seed link failed: ' + linkRes.error.message);

    // ── 1. system story → immutable historical Activity ───────────────────────
    const h1 = await service.rpc('record_processing_history_event', {
      p_row: {
        parent_asana_gid: TASK_GID,
        asana_story_gid: STORY_GID,
        body: 'ronnie@mawaie.com marked this task complete',
        original_author_name: 'Ronnie Jones',
        created_at: '2025-02-03T14:30:00Z',
      },
    });
    if (h1.error) die('history event failed: ' + h1.error.message);
    if (h1.data.action !== 'inserted' || h1.data.id !== 'ae-asana-' + STORY_GID) {
      die('history insert wrong: ' + JSON.stringify(h1.data));
    }
    const {data: ae} = await service
      .from('activity_events')
      .select('entity_type, entity_id, actor_profile_id, event_type, created_at, payload')
      .eq('id', 'ae-asana-' + STORY_GID)
      .single();
    if (ae.entity_id !== REC || ae.entity_type !== 'processing.record') die('history parented wrong');
    if (ae.actor_profile_id !== null) die('history actor must stay NULL (named in payload, never impersonated)');
    if (ae.event_type !== 'imported.system') die('history event_type wrong: ' + ae.event_type);
    if (!String(ae.created_at).startsWith('2025-02-03'))
      die('history must keep the ORIGINAL timestamp: ' + ae.created_at);
    if (ae.payload.original_author_name !== 'Ronnie Jones') die('history payload author missing');
    const h2 = await service.rpc('record_processing_history_event', {
      p_row: {parent_asana_gid: TASK_GID, asana_story_gid: STORY_GID, body: 'x', created_at: '2025-02-03T14:30:00Z'},
    });
    if (h2.error || h2.data.action !== 'skipped') die('history re-run must skip: ' + JSON.stringify(h2.data));
    console.log('  [ok] system story → deterministic, original-timestamp, idempotent history event');

    // ── 2. comments: mentions + backfill ──────────────────────────────────────
    const c1 = await service.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: TASK_GID,
        asana_comment_gid: CMT_GID_1,
        body: 'Ping https://app.asana.com/0/profile/123 — please check',
        original_author_name: 'Isabel Hermann',
        created_at: '2025-02-04T08:00:00Z',
        mentions: [adminId, 'not-a-uuid', '00000000-0000-4000-8000-000000000000'],
      },
    });
    if (c1.error || c1.data.action !== 'inserted') die('comment insert failed: ' + JSON.stringify(c1));
    const {data: cmt1} = await service
      .from('comments')
      .select('mentions, original_author_name, created_at, author_profile_id')
      .eq('asana_comment_gid', CMT_GID_1)
      .single();
    if (!Array.isArray(cmt1.mentions) || cmt1.mentions.length !== 1 || cmt1.mentions[0] !== adminId) {
      die('mentions must keep only real profiles: ' + JSON.stringify(cmt1.mentions));
    }
    if (cmt1.author_profile_id !== null) die('imported comment author must stay NULL');
    const c1again = await service.rpc('record_processing_comment', {
      p_row: {parent_asana_gid: TASK_GID, asana_comment_gid: CMT_GID_1, body: 'x', mentions: [adminId]},
    });
    if (c1again.error || c1again.data.action !== 'skipped')
      die('comment re-offer must skip: ' + JSON.stringify(c1again.data));

    // Mention BACKFILL: import one without mentions, then re-offer with mentions.
    const c2 = await service.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: TASK_GID,
        asana_comment_gid: CMT_GID_2,
        body: 'Older comment imported before mention mapping',
        original_author_name: 'Brian Naide',
        created_at: '2025-02-05T08:00:00Z',
      },
    });
    if (c2.error || c2.data.action !== 'inserted') die('comment2 insert failed');
    const c2back = await service.rpc('record_processing_comment', {
      p_row: {parent_asana_gid: TASK_GID, asana_comment_gid: CMT_GID_2, body: 'ignored', mentions: [adminId]},
    });
    if (c2back.error || c2back.data.action !== 'mentions_backfilled') {
      die('expected mentions_backfilled: ' + JSON.stringify(c2back.data));
    }
    const {data: cmt2} = await service
      .from('comments')
      .select('mentions, body, created_at')
      .eq('asana_comment_gid', CMT_GID_2)
      .single();
    if (cmt2.mentions[0] !== adminId) die('backfill did not store mentions');
    if (cmt2.body !== 'Older comment imported before mention mapping') die('backfill must not touch the body');
    if (!String(cmt2.created_at).startsWith('2025-02-05')) die('backfill must not touch the timestamp');
    const c2again = await service.rpc('record_processing_comment', {
      p_row: {parent_asana_gid: TASK_GID, asana_comment_gid: CMT_GID_2, body: 'x', mentions: [adminId]},
    });
    if (c2again.error || c2again.data.action !== 'skipped') {
      die('post-backfill re-offer must skip (mentions already present): ' + JSON.stringify(c2again.data));
    }
    console.log('  [ok] comment mentions validated + one-shot backfill, immutable body/timestamps');

    // ── 3. subtask importer: local assignee + done ownership win ──────────────
    const s1 = await service.rpc('upsert_processing_subtask_from_asana', {
      p_row: {
        asana_gid: SUB_GID,
        parent_asana_gid: TASK_GID,
        label: 'Imported step',
        assignee: 'Ronnie Jones',
        assignee_profile_id: adminId,
        done: false,
        sort_order: 1,
      },
    });
    if (s1.error || s1.data.action !== 'inserted') die('subtask import failed: ' + JSON.stringify(s1));
    const subId = s1.data.id;
    let {data: subRow} = await service
      .from('processing_subtasks')
      .select('assignee, assignee_profile_id')
      .eq('id', subId)
      .single();
    if (subRow.assignee_profile_id !== adminId) die('imported subtask profile not mapped');

    // Local reassignment (clear) then re-import with an assignee → local wins.
    const clr = await authed.rpc('update_processing_subtask', {p_id: subId, p_clear_assignee: true});
    if (clr.error) die('local clear failed: ' + clr.error.message);
    // Local toggle → done ownership.
    const tog = await authed.rpc('set_processing_subtask_done', {p_id: subId, p_done: true});
    if (tog.error) die('local toggle failed: ' + tog.error.message);
    const s2 = await service.rpc('upsert_processing_subtask_from_asana', {
      p_row: {
        asana_gid: SUB_GID,
        parent_asana_gid: TASK_GID,
        label: 'Imported step',
        assignee: 'Someone Else',
        assignee_profile_id: adminId,
        done: false,
      },
    });
    if (s2.error) die('subtask re-import failed: ' + s2.error.message);
    ({data: subRow} = await service
      .from('processing_subtasks')
      .select('assignee, assignee_profile_id, done, done_locally_set')
      .eq('id', subId)
      .single());
    if (subRow.done !== true || subRow.done_locally_set !== true) die('local done must survive re-import');
    // After the local CLEAR, no profile assignment exists → Asana may state the
    // text name again, but never a profile the local user removed? The rule is
    // profile-assignment wins; a cleared subtask has no local profile so the
    // import may re-offer. Assert the import DID re-apply (documented behavior).
    if (subRow.assignee_profile_id !== adminId) die('cleared subtask should accept re-imported assignee');
    // Now a LOCAL profile reassignment must survive the next import.
    const reassign = await authed.rpc('update_processing_subtask', {p_id: subId, p_assignee_profile_id: adminId});
    if (reassign.error) die('local reassign failed: ' + reassign.error.message);
    const s3 = await service.rpc('upsert_processing_subtask_from_asana', {
      p_row: {asana_gid: SUB_GID, parent_asana_gid: TASK_GID, label: 'Imported step', assignee: 'Third Person'},
    });
    if (s3.error) die('subtask re-import 2 failed: ' + s3.error.message);
    ({data: subRow} = await service
      .from('processing_subtasks')
      .select('assignee, assignee_profile_id')
      .eq('id', subId)
      .single());
    if (subRow.assignee_profile_id !== adminId || subRow.assignee !== null) {
      die('local profile assignment must beat the import: ' + JSON.stringify(subRow));
    }
    console.log('  [ok] subtask importer maps profiles; local done + local profile assignment win');

    // ── 4. record importer: assignee_name + local assignment wins ─────────────
    const r1 = await service.rpc('upsert_processing_from_asana', {
      p_row: {
        asana_gid: REC2_GID,
        record_type: 'asana_historical',
        program: 'cattle',
        title: 'MIG165 record two',
        assignee_name: 'Brett Post',
      },
    });
    if (r1.error) die('record import failed: ' + r1.error.message);
    const rec2Id = r1.data.id;
    let {data: rec2} = await service
      .from('processing_records')
      .select('assignee_name, assignee_profile_id')
      .eq('id', rec2Id)
      .single();
    if (rec2.assignee_name !== 'Brett Post') die('imported assignee_name missing');
    const localAsg = await authed.rpc('set_processing_assignee', {p_id: rec2Id, p_profile_id: adminId});
    if (localAsg.error) die('local record assign failed: ' + localAsg.error.message);
    const r2 = await service.rpc('upsert_processing_from_asana', {
      p_row: {
        asana_gid: REC2_GID,
        record_type: 'asana_historical',
        program: 'cattle',
        title: 'MIG165 record two',
        assignee_name: 'Jessica Torres',
      },
    });
    if (r2.error) die('record re-import failed: ' + r2.error.message);
    ({data: rec2} = await service
      .from('processing_records')
      .select('assignee_name, assignee_profile_id')
      .eq('id', rec2Id)
      .single());
    if (rec2.assignee_profile_id !== adminId || rec2.assignee_name !== null) {
      die('local record assignment must beat the import: ' + JSON.stringify(rec2));
    }
    console.log('  [ok] record importer carries assignee_name; local assignment wins forever');
  } finally {
    await cleanup();
  }

  console.log('mig165 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
