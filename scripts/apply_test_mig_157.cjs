// Apply mig 157 (Processing reconciler + Asana link table) to TEST via exec_sql,
// then behaviorally verify. Hard PROD-ref guard. Checks:
//   1. reconcile_planner_to_processing() runs end-to-end on real TEST data
//      (exercises the cattle/sheep + app_store broiler/pig jsonb loops).
//   2. upsert_processing_from_planner idempotency (insert -> update, one row).
//   3. link_asana_to_processing: first-attach seeds processor; a 2nd link does NOT re-seed.
//   4. record_processing_comment: imported comment carries original_author_name (list_comments COALESCE).
//   5. subtask local check-off (done_locally_set) survives an Asana re-import (local wins).
//   6. upsert_processing_from_asana refuses record_type='planner_batch'.
//   7. resolve_processing_asana_link crosswalk + list_processing_reconciliation buckets.
//   8. delete_comment guard: imported comments are read-only.
// Cleans up everything it creates (incl. all planner_batch rows the reconcile minted).
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
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const STAMP = Date.now();
const CAT_ID = 'srccat-157-' + STAMP;
const GID1 = 'agid1-157-' + STAMP;
const GID2 = 'agid2-157-' + STAMP;
const GIDNR = 'agidnr-157-' + STAMP;
let recId = null,
  subId = null;
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '157_processing_reconciler.sql'),
    'utf8',
  );
  console.log(`applying 157_processing_reconciler.sql (${body.length} bytes)`);
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

  // ── 1. reconcile runs end-to-end on real TEST data (exercises all 4 loops) ──
  {
    const {data, error} = await admin.rpc('reconcile_planner_to_processing');
    if (error) bad('reconcile_planner_to_processing threw', error.message);
    else if (data && data.ok && ['cattle', 'sheep', 'broiler', 'pig'].every((k) => k in data))
      ok('reconcile ran: ' + JSON.stringify(data));
    else bad('reconcile unexpected', data);
  }

  // ── 2. upsert_processing_from_planner idempotency (synthetic cattle) ──
  {
    const row = (extra) => ({
      p_row: {
        source_kind: 'cattle',
        source_id: CAT_ID,
        program: 'cattle',
        title: 'Verify-157 cattle',
        processing_date: '2026-09-01',
        status: 'complete',
        number_processed: 3,
        ...extra,
      },
    });
    const {data: ins, error: e1} = await service.rpc('upsert_processing_from_planner', row());
    if (e1) bad('upsert_processing_from_planner insert', e1.message);
    else if (ins && ins.action === 'inserted') {
      recId = ins.id;
      ok('planner upsert insert -> ' + recId);
    } else bad('planner upsert insert unexpected', ins);
    const {data: upd} = await service.rpc('upsert_processing_from_planner', row({number_processed: 4}));
    upd && upd.action === 'updated' && upd.id === recId
      ? ok('planner upsert re-run -> updated (idempotent, same id)')
      : bad('planner upsert not idempotent', upd);
  }

  // ── 3. link first-attach seeds processor; 2nd link does not re-seed ──
  {
    await service.rpc('link_asana_to_processing', {
      p_row: {
        asana_gid: GID1,
        processing_record_id: recId,
        program: 'cattle',
        asana_batch_code: 'WCF-C-26-01',
        match_status: 'matched',
        match_method: 'auto_exact',
        seed_processor: 'Atlanta Poultry Processing',
        drift: {number_processed: {asana: 5, planner: 4}},
      },
    });
    let {data: rec} = await admin.rpc('get_processing_record', {p_id: recId});
    rec && rec.record && rec.record.processor === 'Atlanta Poultry Processing'
      ? ok('first attach seeded processor')
      : bad('first-attach seed failed', rec && rec.record && rec.record.processor);
    // 2nd link with a different seed must NOT overwrite.
    await service.rpc('link_asana_to_processing', {
      p_row: {asana_gid: GID2, processing_record_id: recId, seed_processor: 'Other Processor', match_status: 'matched'},
    });
    ({data: rec} = await admin.rpc('get_processing_record', {p_id: recId}));
    rec.record.processor === 'Atlanta Poultry Processing'
      ? ok('2nd link did NOT re-seed processor (seed only on first attach)')
      : bad('2nd link wrongly re-seeded', rec.record.processor);
  }

  // ── 4. imported comment carries original author (many Asana -> one record) ──
  {
    await service.rpc('record_processing_comment', {
      p_row: {
        parent_asana_gid: GID1,
        asana_comment_gid: 'acg-157-' + STAMP,
        body: 'Imported from Asana',
        original_author_name: 'Jessica Torres',
        created_at: '2026-01-02T00:00:00Z',
      },
    });
    const {data: cs, error} = await admin.rpc('list_comments', {
      p_entity_type: 'processing.record',
      p_entity_id: recId,
      p_limit: 10,
    });
    if (error) bad('list_comments', error.message);
    else if (Array.isArray(cs) && cs.some((c) => c.author_display_name === 'Jessica Torres' && c.is_imported === true))
      ok('imported comment shows original author (Jessica Torres) + is_imported');
    else bad('imported comment author/flag wrong', cs);
    // idempotent re-import
    const {data: dup} = await service.rpc('record_processing_comment', {
      p_row: {parent_asana_gid: GID1, asana_comment_gid: 'acg-157-' + STAMP, body: 'again'},
    });
    dup && dup.action === 'skipped' ? ok('comment re-import skipped (idempotent)') : bad('comment not idempotent', dup);
  }

  // ── 5. local check-off survives an Asana re-import (Planner wins) ──
  {
    const {data: sub} = await service.rpc('upsert_processing_subtask_from_asana', {
      p_row: {asana_gid: 'ast-157-' + STAMP, parent_asana_gid: GID1, label: 'imported step', done: false},
    });
    subId = sub && sub.id;
    subId ? ok('imported subtask created') : bad('subtask import failed', sub);
    await admin.rpc('set_processing_subtask_done', {p_id: subId, p_done: true}); // local check-off
    await service.rpc('upsert_processing_subtask_from_asana', {
      p_row: {asana_gid: 'ast-157-' + STAMP, parent_asana_gid: GID1, done: false}, // Asana says unchecked
    });
    const {data: rec} = await admin.rpc('get_processing_record', {p_id: recId});
    const st = (rec.subtasks || []).find((s) => s.id === subId);
    st && st.done === true
      ? ok('local check-off survived Asana re-import (done stays true)')
      : bad('Asana reverted a local check-off', st);
  }

  // ── 6. Asana pass refuses planner_batch ──
  {
    const {error} = await service.rpc('upsert_processing_from_asana', {
      p_row: {asana_gid: 'xrefuse-' + STAMP, record_type: 'planner_batch', program: 'cattle', title: 'x'},
    });
    error ? ok('upsert_processing_from_asana refuses planner_batch') : bad('planner_batch was allowed from Asana');
  }

  // ── 7. crosswalk + reconciliation report ──
  {
    await service.rpc('link_asana_to_processing', {
      p_row: {asana_gid: GIDNR, processing_record_id: null, program: 'cattle', match_status: 'needs_review'},
    });
    const {data: res, error} = await admin.rpc('resolve_processing_asana_link', {
      p_asana_gid: GIDNR,
      p_record_id: recId,
    });
    error
      ? bad('resolve_processing_asana_link', error.message)
      : ok('manual crosswalk resolved -> ' + JSON.stringify(res));
    const {data: rep, error: rErr} = await admin.rpc('list_processing_reconciliation');
    if (rErr) bad('list_processing_reconciliation', rErr.message);
    else if (rep && typeof rep.matched_count === 'number' && rep.matched_count >= 3)
      ok('reconciliation report buckets present (matched_count=' + rep.matched_count + ')');
    else bad('reconciliation report unexpected', rep);
  }

  // ── 8. delete_comment guard: imported comments read-only ──
  {
    const {data: cs} = await admin.rpc('list_comments', {
      p_entity_type: 'processing.record',
      p_entity_id: recId,
      p_limit: 10,
    });
    const imported = (cs || []).find((c) => c.is_imported === true);
    if (!imported) bad('no imported comment to test delete guard');
    else {
      const {error} = await admin.rpc('delete_comment', {p_comment_id: imported.id});
      error ? ok('admin cannot delete an imported comment (read-only)') : bad('imported comment was deletable');
    }
  }

  await admin.auth.signOut();

  // ── cleanup: remove everything this run created + reconcile's planner rows ──
  await service.rpc('exec_sql', {
    sql: `DELETE FROM public.comments WHERE entity_type='processing.record' AND entity_id='${recId}';
          DELETE FROM public.processing_asana_links WHERE asana_gid IN ('${GID1}','${GID2}','${GIDNR}');
          DELETE FROM public.processing_records WHERE record_type='planner_batch';`,
  });
  ok('cleanup: verify rows + reconcile planner rows removed');

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('apply/verify threw:', e.message || e);
  process.exit(1);
});
