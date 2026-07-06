// Apply mig 155 (Processing Calendar domain) to TEST via exec_sql, then
// behaviorally verify the core RPCs. Hard PROD-ref guard. Behavioral checks
// (never exec_sql SELECT for verification):
//   1. milestone create/get/list + milestone completion gate (date only).
//   2. importer idempotency: upsert_processing_from_asana twice on one gid ->
//      insert then update, exactly one row.
//   3. completion gate on a planner_batch: blocked by processor/number/subtasks,
//      unblock step by step, then complete succeeds; reopen clears it.
//   4. subtask gating: an open subtask blocks completion; completing it unblocks.
//   5. comments on entity_type='processing.record' (post + list) — proves the
//      _activity_can_read branch + shared comments reuse.
// Env is loaded from the MAIN worktree (the fresh lane worktree has no
// gitignored .env.test.local).
const fs = require('fs');
const path = require('path');

const MAIN = 'C:/Users/Ronni/WCF-planner';

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
loadDotEnv(path.join(MAIN, '.env.test'));
loadDotEnv(path.join(MAIN, '.env.test.local'));

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

const {createClient} = require(path.join(MAIN, 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const STAMP = Date.now();
const MILESTONE_ID = 'pmile-155-' + STAMP;
const BATCH_GID = 'gid-155-' + STAMP;
let batchId = null;
let subId = null;
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '155_processing_calendar.sql'),
    'utf8',
  );
  console.log(`applying 155_processing_calendar.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((r) => setTimeout(r, 2500));
  ok('migration applied');

  const {error: signInErr} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signInErr) {
    bad('admin sign-in', signInErr.message);
    process.exit(1);
  }

  // ── 1. milestone create/get/list + milestone completion gate ──
  {
    const {data, error} = await admin.rpc('create_processing_milestone', {
      p_id: MILESTONE_ID,
      p_program: 'cattle',
      p_title: 'Verify-155 milestone',
      p_processing_date: '2026-09-01',
    });
    if (error) bad('create_processing_milestone', error.message);
    else ok('create_processing_milestone -> ' + JSON.stringify(data));

    const {data: rec, error: gErr} = await admin.rpc('get_processing_record', {p_id: MILESTONE_ID});
    if (gErr) bad('get_processing_record(milestone)', gErr.message);
    else if (
      rec &&
      rec.record &&
      rec.record.record_type === 'milestone' &&
      Array.isArray(rec.completion_blockers) &&
      rec.completion_blockers.length === 0
    )
      ok('milestone get: record_type=milestone, no completion blockers (date present)');
    else bad('milestone get unexpected', rec);

    const {data: list, error: lErr} = await admin.rpc('list_processing_records', {p_year: 2026});
    if (lErr) bad('list_processing_records(2026)', lErr.message);
    else if (Array.isArray(list) && list.some((r) => r.id === MILESTONE_ID))
      ok('list_processing_records(2026) includes the milestone');
    else bad('list did not include milestone', Array.isArray(list) ? list.length + ' rows' : list);
  }

  // ── 2. importer idempotency ──
  {
    const asRow = (extra) => ({
      p_row: {
        asana_gid: BATCH_GID,
        record_type: 'planner_batch',
        program: 'cattle',
        title: 'Verify-155 batch',
        processing_date: '2026-09-15',
        status: 'planned',
        source_kind: 'cattle',
        source_id: 'src-155-' + STAMP,
        ...extra,
      },
    });
    const {data: ins, error: iErr} = await service.rpc('upsert_processing_from_asana', asRow());
    if (iErr) bad('upsert_processing_from_asana insert', iErr.message);
    else if (ins && ins.action === 'inserted') {
      batchId = ins.id;
      ok('importer insert -> ' + JSON.stringify(ins));
    } else bad('importer insert unexpected', ins);

    const {data: upd, error: uErr} = await service.rpc('upsert_processing_from_asana', asRow({number_processed: 3}));
    if (uErr) bad('upsert_processing_from_asana re-run', uErr.message);
    else if (upd && upd.action === 'updated' && upd.id === batchId)
      ok('importer re-run -> updated (idempotent, same id)');
    else bad('importer re-run not idempotent', upd);

    // Idempotency proof: the re-run merged fields onto the SAME row (admin read;
    // get_processing_record requires an operational authed caller, not service).
    const {data: chk, error: cErr} = await admin.rpc('get_processing_record', {p_id: batchId});
    if (cErr) bad('get_processing_record(batch)', cErr.message);
    else if (chk && chk.record && chk.record.asana_gid === BATCH_GID && chk.record.number_processed === 3)
      ok('importer merged fields (number_processed=3) on the single row');
    else
      bad(
        'importer row state unexpected',
        chk && chk.record && {gid: chk.record.asana_gid, n: chk.record.number_processed},
      );
  }

  // ── 3 + 4. completion gate + subtask gating on the planner_batch ──
  {
    // number_processed=3 is set; processor is still missing -> blocked.
    let {data: rec} = await admin.rpc('get_processing_record', {p_id: batchId});
    const hasBlocker = (rec, needle) =>
      Array.isArray(rec.completion_blockers) && rec.completion_blockers.some((b) => b.includes(needle));
    hasBlocker(rec, 'Processor')
      ? ok('gate: Processor missing blocks completion')
      : bad('expected Processor blocker', rec.completion_blockers);

    const {error: mErr} = await admin.rpc('mark_processing_complete', {p_id: batchId});
    mErr
      ? ok('mark_processing_complete blocked while requirements unmet')
      : bad('completion was allowed despite blockers');

    await admin.rpc('set_processing_processor', {p_id: batchId, p_processor: 'Atlanta Poultry Processing'});
    ({data: rec} = await admin.rpc('get_processing_record', {p_id: batchId}));
    !rec.completion_blockers || rec.completion_blockers.length === 0
      ? ok('gate clears once processor + date + number_processed present')
      : bad('unexpected residual blockers', rec.completion_blockers);

    // Add an open subtask -> completion blocked again.
    subId = 'psub-155-' + STAMP;
    await admin.rpc('add_processing_subtask', {p_id: subId, p_record_id: batchId, p_label: 'verify subtask'});
    ({data: rec} = await admin.rpc('get_processing_record', {p_id: batchId}));
    hasBlocker(rec, 'subtask')
      ? ok('gate: an open subtask blocks completion')
      : bad('expected subtask blocker', rec.completion_blockers);

    const {error: m2} = await admin.rpc('mark_processing_complete', {p_id: batchId});
    m2 ? ok('mark_processing_complete blocked by open subtask') : bad('completion allowed with open subtask');

    // Complete the subtask -> completion now allowed. (Subtask completion does
    // NOT auto-complete the record; a separate mark is still required.)
    await admin.rpc('set_processing_subtask_done', {p_id: subId, p_done: true});
    ({data: rec} = await admin.rpc('get_processing_record', {p_id: batchId}));
    rec.record.status !== 'complete'
      ? ok('completing the subtask did NOT auto-complete the record')
      : bad('subtask auto-completed the record');

    const {data: done, error: m3} = await admin.rpc('mark_processing_complete', {p_id: batchId});
    if (m3) bad('mark_processing_complete failed after unblock', m3.message);
    else if (done && done.status === 'complete') ok('mark_processing_complete succeeds once all requirements met');
    else bad('completion unexpected', done);

    const {data: reop} = await admin.rpc('reopen_processing_record', {p_id: batchId});
    reop && reop.status === 'planned'
      ? ok('reopen_processing_record clears completion')
      : bad('reopen unexpected', reop);
  }

  // ── 5. comments on processing.record (activity branch + comments reuse) ──
  {
    const {error: pErr} = await admin.rpc('post_comment', {
      p_entity_type: 'processing.record',
      p_entity_id: batchId,
      p_body: 'Verify-155 comment',
      p_entity_label: 'Verify-155 batch',
      p_mentions: [],
      p_attachments: [],
    });
    if (pErr) bad('post_comment on processing.record (activity branch missing?)', pErr.message);
    else ok('post_comment on processing.record succeeded (activity read branch live)');

    const {data: cs, error: lcErr} = await admin.rpc('list_comments', {
      p_entity_type: 'processing.record',
      p_entity_id: batchId,
      p_limit: 10,
    });
    if (lcErr) bad('list_comments on processing.record', lcErr.message);
    else if (Array.isArray(cs) && cs.some((c) => c.body === 'Verify-155 comment'))
      ok('list_comments returns the processing.record comment');
    else bad('list_comments did not return the comment', Array.isArray(cs) ? cs.length + ' rows' : cs);
  }

  await admin.auth.signOut();

  // ── cleanup ──
  await service.rpc('exec_sql', {
    sql: `DELETE FROM public.comments WHERE entity_type = 'processing.record' AND entity_id = '${batchId}';
          DELETE FROM public.processing_records WHERE id IN ('${MILESTONE_ID}', '${batchId}');`,
  });
  ok('cleanup: verify processing rows + comments removed');

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('apply/verify threw:', e.message || e);
  process.exit(1);
});
