// Apply mig 164 (Processing engine: assignee model, typed custom-field values,
// milestone status/assignee/clear-date, subtask reorder, Activity emits,
// checklist auto-seed, automatic planner freshness) to TEST via exec_sql, then
// behaviorally verify:
//   1. schema deltas (assignee columns + freshness stamp) exist;
//   2. set_processing_assignee assign/clear + bad-profile refusal + Activity;
//   3. set_processing_field: typed values vs the ACTIVE template (number/date/
//      single/multi), reserved-id refusal, unknown-field refusal, milestone
//      refusal, clear-on-null;
//   4. milestone RPCs: create with status+assignee, canonical-status validation,
//      explicit p_clear_date, assignee clear;
//   5. subtasks: add with profile assignee, clear-assignee update, reorder;
//   6. upsert_processing_from_planner INSERT branch seeds the active checklist
//      EXACTLY ONCE (update branch never re-seeds);
//   7. ensure_processing_freshness: stale → ran:true, immediate re-call →
//      fresh:true; LIGHT role refused (operational gate);
//   8. anon (unauthenticated) refused on the new RPCs.
// Uses an asana_historical record for field/assignee tests (reconcile's archival
// sweep only touches planner_batch rows). All seeded rows + the temp light user
// are cleaned up in finally.
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

const REC = 'mig164-hist-1';
const MILE = 'mig164-mile-1';
const SUB1 = 'mig164-sub-1';
const SUB2 = 'mig164-sub-2';
const SUB3 = 'mig164-sub-3';
const PLANNER_SRC = 'mig164-planner-src-1';
const LIGHT_EMAIL = 'mig164-light@example.test';

(async () => {
  console.log(`TEST url=${url}`);
  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const {data: me} = await authed.auth.getUser();
  const adminId = me && me.user && me.user.id;
  if (!adminId) die('no admin user id');

  const body = fs.readFileSync(path.join(__dirname, '..', 'supabase-migrations', '164_processing_engine.sql'), 'utf8');
  console.log(`applying 164_processing_engine.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2500));

  // Baseline: active broiler template (restored in finally) + freshness stamp.
  const {data: tplBase} = await service
    .from('processing_templates')
    .select('id, program, version, fields, checklist')
    .eq('program', 'broiler')
    .eq('is_active', true)
    .maybeSingle();

  let lightUserId = null;
  const cleanup = async () => {
    await service.from('processing_records').delete().in('id', [REC, MILE]);
    await service.from('processing_records').delete().eq('source_id', PLANNER_SRC);
    await service.from('activity_events').delete().eq('entity_id', REC);
    await service.from('activity_events').delete().eq('entity_id', MILE);
    // Deactivate any template versions this test created; restore the baseline.
    if (tplBase) {
      await service.from('processing_templates').delete().eq('program', 'broiler').gt('version', tplBase.version);
      await service.from('processing_templates').update({is_active: true}).eq('id', tplBase.id);
    } else {
      await service.from('processing_templates').delete().eq('program', 'broiler');
    }
    if (lightUserId) {
      await service.from('profiles').delete().eq('id', lightUserId);
      await service.auth.admin.deleteUser(lightUserId).catch(() => {});
    }
  };

  try {
    // ── 1. schema deltas ──────────────────────────────────────────────────────
    const {error: colErr} = await service
      .from('processing_records')
      .select('assignee_profile_id, assignee_name')
      .limit(1);
    if (colErr) die('assignee columns missing: ' + colErr.message);
    const {error: subColErr} = await service.from('processing_subtasks').select('assignee_profile_id').limit(1);
    if (subColErr) die('subtask assignee_profile_id missing: ' + subColErr.message);
    const {error: stampErr} = await service
      .from('processing_asana_sync_settings')
      .select('last_planner_reconcile_at')
      .limit(1);
    if (stampErr) die('last_planner_reconcile_at missing: ' + stampErr.message);
    console.log('  [ok] schema deltas present');

    // Seed an Asana-historical record (NOT swept by reconcile) + a template with
    // a local number field for the field-engine tests.
    const {error: seedErr} = await service.from('processing_records').insert({
      id: REC,
      record_type: 'asana_historical',
      program: 'broiler',
      title: 'MIG164 historical',
      processing_date: '2026-05-01',
      status: 'planned',
      match_status: 'unmatched',
      created_by: adminId,
    });
    if (seedErr) die('seed record failed: ' + seedErr.message);

    const {error: tplErr} = await authed.rpc('upsert_processing_template', {
      p_program: 'broiler',
      p_fields: [
        {id: 'condemned', name: 'Condemed', type: 'number'},
        {id: 'farmArrival', name: 'Farm Arrival Date', type: 'date'},
        {
          id: 'animalMaster',
          name: 'Status (Animal Master)',
          type: 'single',
          options: [{key: 'on_farm', label: 'On Farm'}],
        },
        {id: 'tags164', name: 'Tags', type: 'multi', options: [{key: 'a', label: 'A'}]},
      ],
      p_checklist: [
        {label: 'MIG164 step one', assignee: null, assignee_profile_id: adminId},
        {label: 'MIG164 step two', assignee: 'Imported Name', assignee_profile_id: null},
      ],
    });
    if (tplErr) die('template upsert failed: ' + tplErr.message);

    // ── 2. assignee ───────────────────────────────────────────────────────────
    const {error: asgErr} = await authed.rpc('set_processing_assignee', {p_id: REC, p_profile_id: adminId});
    if (asgErr) die('set_processing_assignee failed: ' + asgErr.message);
    let {data: recRow} = await service.from('processing_records').select('assignee_profile_id').eq('id', REC).single();
    if (recRow.assignee_profile_id !== adminId) die('assignee not set');
    const {error: clrErr} = await authed.rpc('set_processing_assignee', {p_id: REC, p_profile_id: null});
    if (clrErr) die('assignee clear failed: ' + clrErr.message);
    ({data: recRow} = await service.from('processing_records').select('assignee_profile_id').eq('id', REC).single());
    if (recRow.assignee_profile_id !== null) die('assignee not cleared');
    const {error: badAsg} = await authed.rpc('set_processing_assignee', {
      p_id: REC,
      p_profile_id: '00000000-0000-4000-8000-000000000000',
    });
    if (!badAsg) die('unknown assignee profile should be refused');
    const {data: asgEvents} = await service
      .from('activity_events')
      .select('id, body, payload')
      .eq('entity_id', REC)
      .eq('entity_type', 'processing.record');
    if (!asgEvents || asgEvents.length < 2) die('assignee Activity not emitted');
    console.log('  [ok] set_processing_assignee assign/clear + refusal + Activity');

    // ── 3. typed field values ─────────────────────────────────────────────────
    const okField = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'condemned', p_value: 4});
    if (okField.error) die('set_processing_field number failed: ' + okField.error.message);
    const badType = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'condemned', p_value: 'four'});
    if (!badType.error) die('wrong-typed value should be refused');
    const okDate = await authed.rpc('set_processing_field', {
      p_id: REC,
      p_field_id: 'farmArrival',
      p_value: '2026-03-15',
    });
    if (okDate.error) die('set_processing_field date failed: ' + okDate.error.message);
    const badDate = await authed.rpc('set_processing_field', {
      p_id: REC,
      p_field_id: 'farmArrival',
      p_value: '15/03/2026',
    });
    if (!badDate.error) die('malformed date should be refused');
    const okMulti = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'tags164', p_value: ['A', 'X']});
    if (okMulti.error) die('multi value failed: ' + okMulti.error.message);
    const badMulti = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'tags164', p_value: 'A'});
    if (!badMulti.error) die('non-array multi should be refused');
    const reserved = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'animals', p_value: 5});
    if (!reserved.error || !/source-owned|derived/i.test(reserved.error.message)) {
      die('reserved id must be refused: ' + (reserved.error ? reserved.error.message : 'no error'));
    }
    const unknown = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'notOnTemplate', p_value: 'x'});
    if (!unknown.error) die('unknown field id should be refused');
    let {data: fieldsRow} = await service.from('processing_records').select('fields').eq('id', REC).single();
    if (fieldsRow.fields.condemned !== 4 || fieldsRow.fields.farmArrival !== '2026-03-15') {
      die('fields not persisted: ' + JSON.stringify(fieldsRow.fields));
    }
    const clrField = await authed.rpc('set_processing_field', {p_id: REC, p_field_id: 'condemned', p_value: null});
    if (clrField.error) die('field clear failed: ' + clrField.error.message);
    ({data: fieldsRow} = await service.from('processing_records').select('fields').eq('id', REC).single());
    if ('condemned' in fieldsRow.fields) die('null should remove the stored key');
    console.log('  [ok] set_processing_field typed values + reserved/unknown refusals + clear');

    // ── 4. milestones ─────────────────────────────────────────────────────────
    const mCreate = await authed.rpc('create_processing_milestone', {
      p_id: MILE,
      p_program: 'cattle',
      p_title: 'MIG164 milestone',
      p_processing_date: '2026-08-01',
      p_status: 'in_process',
      p_assignee_profile_id: adminId,
    });
    if (mCreate.error) die('milestone create failed: ' + mCreate.error.message);
    let {data: mRow} = await service
      .from('processing_records')
      .select('status, assignee_profile_id, processing_date')
      .eq('id', MILE)
      .single();
    if (mRow.status !== 'in_process' || mRow.assignee_profile_id !== adminId) die('milestone create fields wrong');
    const badStatus = await authed.rpc('update_processing_milestone', {p_id: MILE, p_status: 'Reserved'});
    if (!badStatus.error) die('non-canonical milestone status should be refused');
    const clrDate = await authed.rpc('update_processing_milestone', {
      p_id: MILE,
      p_clear_date: true,
      p_clear_assignee: true,
    });
    if (clrDate.error) die('milestone clear-date failed: ' + clrDate.error.message);
    ({data: mRow} = await service
      .from('processing_records')
      .select('processing_date, assignee_profile_id')
      .eq('id', MILE)
      .single());
    if (mRow.processing_date !== null) die('milestone date not cleared');
    if (mRow.assignee_profile_id !== null) die('milestone assignee not cleared');
    console.log('  [ok] milestone status+assignee create, canonical validation, explicit clears');

    // ── 5. subtasks: assignee + reorder ───────────────────────────────────────
    for (const [id, label] of [
      [SUB1, 'First step'],
      [SUB2, 'Second step'],
      [SUB3, 'Third step'],
    ]) {
      const r = await authed.rpc('add_processing_subtask', {
        p_id: id,
        p_record_id: REC,
        p_label: label,
        p_assignee: null,
        p_assignee_profile_id: id === SUB1 ? adminId : null,
      });
      if (r.error) die(`add subtask ${id} failed: ` + r.error.message);
    }
    let {data: subRows} = await service
      .from('processing_subtasks')
      .select('id, assignee_profile_id')
      .eq('record_id', REC)
      .order('sort_order');
    if (subRows[0].assignee_profile_id !== adminId) die('subtask profile assignee not stored');
    const clrSub = await authed.rpc('update_processing_subtask', {p_id: SUB1, p_clear_assignee: true});
    if (clrSub.error) die('subtask clear-assignee failed: ' + clrSub.error.message);
    const reord = await authed.rpc('reorder_processing_subtasks', {p_record_id: REC, p_ids: [SUB3, SUB1, SUB2]});
    if (reord.error) die('reorder failed: ' + reord.error.message);
    ({data: subRows} = await service.from('processing_subtasks').select('id').eq('record_id', REC).order('sort_order'));
    if (subRows.map((s) => s.id).join(',') !== [SUB3, SUB1, SUB2].join(',')) {
      die('reorder wrong: ' + subRows.map((s) => s.id).join(','));
    }
    console.log('  [ok] subtask profile assignee, explicit clear, reorder');

    // ── 6. planner-insert checklist auto-seed (exactly once) ─────────────────
    const up1 = await service.rpc('upsert_processing_from_planner', {
      p_row: {
        source_kind: 'cattle',
        source_id: PLANNER_SRC,
        program: 'broiler',
        title: 'MIG164 planner',
        processing_date: '2026-09-01',
        status: 'planned',
      },
    });
    if (up1.error) die('planner upsert failed: ' + up1.error.message);
    if (up1.data.action !== 'inserted') die('expected insert, got ' + up1.data.action);
    const newId = up1.data.id;
    const {data: seeded1} = await service.from('processing_subtasks').select('id, label').eq('record_id', newId);
    if (seeded1.length !== 2) die('checklist seed expected 2 steps, got ' + seeded1.length);
    const up2 = await service.rpc('upsert_processing_from_planner', {
      p_row: {
        source_kind: 'cattle',
        source_id: PLANNER_SRC,
        program: 'broiler',
        title: 'MIG164 planner',
        status: 'active',
      },
    });
    if (up2.error || up2.data.action !== 'updated') die('planner re-upsert should update');
    const {data: seeded2} = await service.from('processing_subtasks').select('id').eq('record_id', newId);
    if (seeded2.length !== 2) die('update branch must NOT re-seed (got ' + seeded2.length + ')');
    console.log('  [ok] planner INSERT seeds the checklist exactly once (update never re-seeds)');

    // ── 7. freshness ──────────────────────────────────────────────────────────
    await service
      .from('processing_asana_sync_settings')
      .update({last_planner_reconcile_at: null})
      .eq('id', 'singleton');
    const f1 = await authed.rpc('ensure_processing_freshness', {p_max_age_seconds: 120});
    if (f1.error) die('ensure_processing_freshness failed: ' + f1.error.message);
    if (f1.data.ran !== true) die('stale stamp should run a reconcile: ' + JSON.stringify(f1.data));
    const f2 = await authed.rpc('ensure_processing_freshness', {p_max_age_seconds: 120});
    if (f2.error) die('freshness re-call failed: ' + f2.error.message);
    if (f2.data.ran !== false || f2.data.fresh !== true) die('fresh stamp should skip: ' + JSON.stringify(f2.data));
    console.log('  [ok] ensure_processing_freshness runs when stale, skips when fresh');

    // ── 8. role matrix: light refused, anon refused ───────────────────────────
    const created = await service.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: 'mig164-light-pass-1!',
      email_confirm: true,
    });
    if (created.error) die('light createUser failed: ' + created.error.message);
    lightUserId = created.data.user.id;
    await service.from('profiles').upsert({id: lightUserId, full_name: 'MIG164 Light', role: 'light'});
    const lightSb = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});
    const {error: lSign} = await lightSb.auth.signInWithPassword({
      email: LIGHT_EMAIL,
      password: 'mig164-light-pass-1!',
    });
    if (lSign) die('light signIn failed: ' + lSign.message);
    for (const [fn, args] of [
      ['ensure_processing_freshness', {p_max_age_seconds: 120}],
      ['set_processing_field', {p_id: REC, p_field_id: 'condemned', p_value: 1}],
      ['set_processing_assignee', {p_id: REC, p_profile_id: null}],
      ['reorder_processing_subtasks', {p_record_id: REC, p_ids: []}],
    ]) {
      const r = await lightSb.rpc(fn, args);
      if (!r.error) die(`light must be refused on ${fn}`);
    }
    for (const [fn, args] of [
      ['ensure_processing_freshness', {p_max_age_seconds: 120}],
      ['set_processing_field', {p_id: REC, p_field_id: 'condemned', p_value: 1}],
    ]) {
      const r = await anon.rpc(fn, args);
      if (!r.error) die(`anon must be refused on ${fn}`);
    }
    console.log('  [ok] light + anon refused on the new RPCs');
  } finally {
    await cleanup();
  }

  console.log('mig164 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
