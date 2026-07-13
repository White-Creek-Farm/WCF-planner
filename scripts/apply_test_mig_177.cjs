// Apply mig 177 (processing workflow integration + controlled correction) to
// TEST via exec_sql and prove the gated contract:
//   1. every stored processing_subtasks.due_on/start_on is cleared;
//   2. the reissued Asana subtask importer IGNORES due_on/start_on on both the
//      insert and the update branch (imports can never restore scheduling);
//   3. templates: upsert_processing_template mints/keeps stable step ids;
//      preview_latest_template reports EXACTLY the new step as an addition;
//      apply_current_template adds exactly it; a second apply is a no-op; the
//      completed linked subtask is never touched (still done, label unchanged);
//   4. deleting a template-linked subtask tombstones its step id in
//      record.removed_template_steps and re-apply does NOT resurrect it;
//   5. notifications: assigning a subtask to a DIFFERENT operational profile
//      inserts exactly one 'processing_subtask_assigned' notification;
//      replaying the same assignment inserts none; self-assignment inserts
//      none; assigning to a light-role profile FAILS (assignment scope);
//   6. correct_processing_imported_assignee fails closed on an unknown email
//      ('resolves to 0 profiles') and, with the admin test user's email +
//      'Case Test Person', silently links the name-only subtask (assignee
//      cleared, assignee_profile_id set) inserting ZERO notifications;
//   7. the widened notifications type CHECK still rejects an invalid type on
//      direct insert.
//
// PRECONDITIONS: TEST project only (hard PROD guard below); migrations 175 AND
// 176 ALREADY APPLIED to TEST (175 columns/step ids + 176 lifecycle RPCs are
// assumed). .env.test/.env.test.local (or the primary worktree's copies)
// provide URL/keys/admin credentials. exec_sql on TEST returns void and
// REJECTS BEGIN/COMMIT — no explicit transactions; behavior is verified via
// PostgREST/RPC reads. NOTE the migration's due-date clear runs against the
// farm's REAL subtasks too — that is the migration's purpose and is not
// reverted.
//
// EXECUTION IS GATED: applying a migration to TEST is a DB-apply action —
// run this file only with Ronnie's explicit approval in the current turn.
//
// Restore strategy (finally): temp Auth users, seeded record/subtasks/links,
// notifications, and every template version created during the run are
// removed; the pre-run ACTIVE broiler template is reactivated.
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
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !serviceKey || !anonKey || !adminEmail || !adminPassword) {
  console.error('missing TEST env (url / service key / anon key / admin credentials)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

function requireSupabase() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'),
    path.join(__dirname, '..', '..', 'WCF-planner', 'node_modules', '@supabase', 'supabase-js'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      /* try next */
    }
  }
  return require('@supabase/supabase-js');
}
const {createClient} = requireSupabase();
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  throw new Error(msg);
}

let failures = 0;
const ok = (l) => console.log('  ok   ' + l);
const skipped = (l) => console.log('  SKIPPED ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};

const mig177 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '177_processing_workflow_integration.sql'),
  'utf8',
);

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) die(`exec_sql ${label} failed: ` + (error.message || error));
}

// ── fixture identifiers ───────────────────────────────────────────────────────
const S = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const REC = 'prc-mig177-' + S;
const TPL_ID = 'ptpl-mig177-' + S;
const STEP1 = {id: 'stp-mig177-one-' + S, label: 'Mig177 Step One ' + S};
const STEP2 = {id: 'stp-mig177-two-' + S, label: 'Mig177 Step Two ' + S};
const STEP3_LABEL = 'Mig177 Step Three ' + S;
const SUB_DONE = 'pst-mig177-done-' + S;
const SUB_STEP2 = 'pst-mig177-open-' + S;
const SUB_MANUAL = 'pst-mig177-manual-' + S;
const SUB_CASE = 'pst-mig177-case-' + S;
const LINK_ID = 'pal-mig177-' + S;
const TASK_GID = 'mig177-task-' + S;
const SUB_GID = 'mig177-sub-' + S;
const CASE_NAME = 'Case Test Person';
const TEMP_PASSWORD = `Mig177-${S}-Xy7!`;
const createdTemplateIds = [TPL_ID];
const tempAuthIds = [];

async function notifCount(recipientId) {
  const {count, error} = await service
    .from('notifications')
    .select('id', {count: 'exact', head: true})
    .eq('recipient_profile_id', recipientId)
    .eq('type', 'processing_subtask_assigned');
  if (error) die('notification count: ' + error.message);
  return count || 0;
}
async function createTempUser(label, role) {
  const email = `mig177-${label}-${S}@example.invalid`.toLowerCase();
  const {data, error} = await service.auth.admin.createUser({
    email,
    password: TEMP_PASSWORD,
    email_confirm: true,
    user_metadata: {full_name: `Mig177 ${label}`},
  });
  if (error || !data || !data.user || !data.user.id) {
    return {failed: (error && error.message) || 'no user id'};
  }
  const id = data.user.id;
  tempAuthIds.push(id);
  const {error: pErr} = await service
    .from('profiles')
    .upsert({id, email, full_name: `Mig177 ${label}`, role, program_access: null}, {onConflict: 'id'});
  if (pErr) return {failed: pErr.message};
  return {id, email, role};
}
async function readSubtask(id, cols) {
  const {data, error} = await service
    .from('processing_subtasks')
    .select(cols || 'id, label, done, completed_at, assignee, assignee_profile_id, template_step_id, due_on, start_on')
    .eq('id', id)
    .maybeSingle();
  if (error) die('read subtask ' + id + ': ' + error.message);
  return data;
}
async function subtasksOfRecord() {
  const {data, error} = await service
    .from('processing_subtasks')
    .select('id, label, done, template_step_id')
    .eq('record_id', REC)
    .order('id');
  if (error) die('read record subtasks: ' + error.message);
  return data || [];
}

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 177_processing_workflow_integration.sql (${mig177.length} bytes) — stamp ${S}`);

  const {data: adminProfile, error: apErr} = await service
    .from('profiles')
    .select('id, role')
    .ilike('email', adminEmail)
    .maybeSingle();
  if (apErr || !adminProfile || adminProfile.role !== 'admin') {
    console.error('test admin profile missing/not admin: ' + (apErr ? apErr.message : JSON.stringify(adminProfile)));
    process.exit(2);
  }
  const adminId = adminProfile.id;

  // ── defensive pre-clean of leftovers from aborted prior runs ───────────────
  await service.from('processing_asana_links').delete().like('asana_gid', 'mig177-task-%');
  {
    const {data: leftoverRecs} = await service.from('processing_records').select('id').like('id', 'prc-mig177-%');
    const ids = (leftoverRecs || []).map((r) => r.id);
    if (ids.length) {
      await service.from('activity_events').delete().eq('entity_type', 'processing.record').in('entity_id', ids);
      await service.from('processing_records').delete().in('id', ids);
    }
  }
  await service.from('processing_subtasks').delete().like('id', 'pst-mig177-%');
  // Leftover mig177 templates from aborted runs (never the real ones). If an
  // aborted run left ITS template active, the real template stays inactive and
  // the no-active-template warning below flags it for manual reactivation.
  await service.from('processing_templates').delete().like('id', 'ptpl-mig177-%');

  // ── template snapshot for restore ──────────────────────────────────────────
  const {data: broilerTpls, error: btErr} = await service
    .from('processing_templates')
    .select('id, version, is_active')
    .eq('program', 'broiler')
    .order('version');
  if (btErr) {
    console.error('read broiler templates failed: ' + btErr.message);
    process.exit(2);
  }
  const originalActiveBroiler = (broilerTpls || []).find((t) => t.is_active) || null;
  if (!originalActiveBroiler) {
    console.warn(
      '  WARN no active broiler template found pre-run (aborted prior run?) — nothing to reactivate in finally',
    );
  }
  const nextBroilerVersion = (broilerTpls || []).reduce((m, t) => Math.max(m, t.version), 0) + 1;

  try {
    // ── seed FIRST (the due-date clear must find data to clear) ──────────────
    if (originalActiveBroiler) {
      const {error} = await service
        .from('processing_templates')
        .update({is_active: false})
        .eq('id', originalActiveBroiler.id);
      if (error) die('deactivate current broiler template: ' + error.message);
    }
    {
      const {error} = await service.from('processing_templates').insert({
        id: TPL_ID,
        program: 'broiler',
        version: nextBroilerVersion,
        fields: [],
        checklist: [
          {id: STEP1.id, label: STEP1.label, assignee: null, assignee_profile_id: null},
          {id: STEP2.id, label: STEP2.label, assignee: null, assignee_profile_id: adminId},
        ],
        is_active: true,
        created_by: adminId,
      });
      if (error) die('seed template: ' + error.message);
    }
    {
      const {error} = await service.from('processing_records').insert({
        id: REC,
        record_type: 'asana_historical', // planner-decoupled workflow host
        program: 'broiler',
        title: 'MIG177 workflow fixture',
        processing_date: '2026-06-01',
        status: 'planned',
        match_status: 'unmatched',
        created_by: adminId,
      });
      if (error) die('seed record: ' + error.message);
    }
    {
      const {error} = await service.from('processing_subtasks').insert([
        {
          id: SUB_DONE,
          record_id: REC,
          label: STEP1.label,
          template_step_id: STEP1.id,
          done: true,
          completed_at: new Date().toISOString(),
          done_locally_set: true,
          sort_order: 1,
          created_by: adminId,
        },
        // NOTE: PostgREST bulk inserts use the UNION of keys across rows and
        // send null for a row's missing keys — column DEFAULTs do not apply —
        // so the NOT NULL booleans are set explicitly on every row.
        {
          id: SUB_STEP2,
          record_id: REC,
          label: STEP2.label,
          template_step_id: STEP2.id,
          assignee_profile_id: adminId,
          due_on: '2026-08-01', // must be cleared by the migration
          start_on: '2026-07-20',
          done: false,
          done_locally_set: false,
          sort_order: 2,
          created_by: adminId,
        },
        {
          id: SUB_MANUAL,
          record_id: REC,
          label: 'Mig177 manual step ' + S,
          done: false,
          done_locally_set: false,
          sort_order: 3,
          created_by: adminId,
        },
        {
          id: SUB_CASE,
          record_id: REC,
          label: 'Mig177 imported step ' + S,
          assignee: CASE_NAME,
          assignee_profile_id: null,
          done: false,
          done_locally_set: false,
          sort_order: 4,
          created_by: adminId,
        },
      ]);
      if (error) die('seed subtasks: ' + error.message);
    }
    ok('fixture seeded (active 2-step template, historical record, done/open-linked + manual + name-only subtasks)');

    // ── APPLY 177 ─────────────────────────────────────────────────────────────
    await execSql(mig177, 'APPLY 177');
    await sleep(2500); // NOTIFY pgrst schema reload before RPC calls
    ok('migration 177 applied');

    const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
    if (signErr) die('admin sign-in failed: ' + signErr.message);

    // ── CHECK 1: due_on/start_on cleared everywhere ───────────────────────────
    {
      const mine = await readSubtask(SUB_STEP2);
      const {count, error} = await service
        .from('processing_subtasks')
        .select('id', {count: 'exact', head: true})
        .or('due_on.not.is.null,start_on.not.is.null');
      if (error) bad('CHECK 1 scheduling count query', error.message);
      else if (!mine || mine.due_on !== null || mine.start_on !== null)
        bad('CHECK 1 seeded due/start not cleared', mine);
      else if ((count || 0) !== 0) bad('CHECK 1 subtasks still carry due_on/start_on', count);
      else ok('CHECK 1 due_on/start_on are NULL on ALL processing_subtasks');
    }

    // ── CHECK 2: Asana subtask importer ignores due/start on both branches ───
    {
      const {error: linkErr} = await service.from('processing_asana_links').insert({
        id: LINK_ID,
        asana_gid: TASK_GID,
        processing_record_id: REC,
        match_status: 'historical',
        match_method: 'historical',
      });
      if (linkErr) bad('CHECK 2 seed asana link', linkErr.message);
      else {
        const ins = await service.rpc('upsert_processing_subtask_from_asana', {
          p_row: {
            asana_gid: SUB_GID,
            parent_asana_gid: TASK_GID,
            label: 'Mig177 imported with dates',
            due_on: '2026-09-01',
            start_on: '2026-08-15',
            sort_order: 9,
          },
        });
        if (ins.error || !ins.data || ins.data.action !== 'inserted')
          bad('CHECK 2 importer insert', (ins.error && ins.error.message) || ins.data);
        else {
          const importedId = ins.data.id;
          const afterInsert = await readSubtask(importedId, 'id, due_on, start_on');
          const upd = await service.rpc('upsert_processing_subtask_from_asana', {
            p_row: {
              asana_gid: SUB_GID,
              parent_asana_gid: TASK_GID,
              label: 'Mig177 imported with dates',
              due_on: '2026-09-01',
              start_on: '2026-08-15',
            },
          });
          const afterUpdate = await readSubtask(importedId, 'id, due_on, start_on');
          if (
            !afterInsert ||
            afterInsert.due_on !== null ||
            afterInsert.start_on !== null ||
            upd.error ||
            !upd.data ||
            upd.data.action !== 'updated' ||
            !afterUpdate ||
            afterUpdate.due_on !== null ||
            afterUpdate.start_on !== null
          )
            bad('CHECK 2 importer restored scheduling', {
              afterInsert,
              upd: upd.error ? upd.error.message : upd.data,
              afterUpdate,
            });
          else ok('CHECK 2 importer ignores due_on/start_on on INSERT and UPDATE (never restored)');
        }
      }
    }

    // ── CHECK 3: template preview + idempotent merge-by-step-id ──────────────
    let step3Id = null;
    {
      const failsBefore = failures;
      // Baseline: both template steps are linked on the record -> up to date.
      const base = await authed.rpc('preview_latest_template', {p_record_id: REC});
      if (base.error || !base.data || base.data.up_to_date !== true)
        bad('CHECK 3 baseline preview not up_to_date', (base.error && base.error.message) || base.data);

      const up = await authed.rpc('upsert_processing_template', {
        p_program: 'broiler',
        p_fields: null,
        p_checklist: [
          {id: STEP1.id, label: STEP1.label, assignee: null, assignee_profile_id: null},
          {id: STEP2.id, label: STEP2.label, assignee: null, assignee_profile_id: adminId},
          {label: STEP3_LABEL}, // NEW step, id minted by the RPC
        ],
      });
      if (up.error || !up.data || !up.data.id) {
        bad('CHECK 3 upsert_processing_template', (up.error && up.error.message) || up.data);
      } else {
        createdTemplateIds.push(up.data.id);
        const {data: newTpl} = await service
          .from('processing_templates')
          .select('checklist')
          .eq('id', up.data.id)
          .maybeSingle();
        const step3 = ((newTpl && newTpl.checklist) || []).find((s) => s && s.label === STEP3_LABEL);
        step3Id = step3 && step3.id;
        const kept1 = ((newTpl && newTpl.checklist) || []).find((s) => s && s.id === STEP1.id);
        const kept2 = ((newTpl && newTpl.checklist) || []).find((s) => s && s.id === STEP2.id);
        if (!step3Id || !kept1 || !kept2)
          bad('CHECK 3 new version step ids wrong (existing ids must survive, new step minted)', newTpl);

        const prev = await authed.rpc('preview_latest_template', {p_record_id: REC});
        const additions = (prev.data && prev.data.additions) || [];
        if (
          prev.error ||
          additions.length !== 1 ||
          additions[0].step_id !== step3Id ||
          ((prev.data && prev.data.renames) || []).length !== 0 ||
          ((prev.data && prev.data.assignment_changes) || []).length !== 0
        )
          bad(
            'CHECK 3 preview must show exactly the new step as an addition',
            (prev.error && prev.error.message) || prev.data,
          );

        const subsBefore = await subtasksOfRecord();
        const ap1 = await authed.rpc('apply_current_template', {p_record_id: REC});
        const subsAfter1 = await subtasksOfRecord();
        const addedRows = subsAfter1.filter((s) => !subsBefore.some((b) => b.id === s.id));
        if (
          ap1.error ||
          !ap1.data ||
          ap1.data.added !== 1 ||
          ap1.data.renamed !== 0 ||
          ap1.data.reassigned !== 0 ||
          ap1.data.adopted !== 0 ||
          addedRows.length !== 1 ||
          addedRows[0].template_step_id !== step3Id ||
          addedRows[0].label !== STEP3_LABEL
        )
          bad('CHECK 3 first apply must add exactly the new step', {
            rpc: (ap1.error && ap1.error.message) || ap1.data,
            addedRows,
          });

        const ap2 = await authed.rpc('apply_current_template', {p_record_id: REC});
        const subsAfter2 = await subtasksOfRecord();
        if (
          ap2.error ||
          !ap2.data ||
          ap2.data.added !== 0 ||
          ap2.data.renamed !== 0 ||
          ap2.data.reassigned !== 0 ||
          ap2.data.adopted !== 0 ||
          subsAfter2.length !== subsAfter1.length
        )
          bad('CHECK 3 second apply must be a no-op', (ap2.error && ap2.error.message) || ap2.data);

        const done = await readSubtask(SUB_DONE);
        if (!done || done.done !== true || done.label !== STEP1.label)
          bad('CHECK 3 completed linked subtask was touched', done);

        const prev2 = await authed.rpc('preview_latest_template', {p_record_id: REC});
        if (prev2.error || !prev2.data || prev2.data.up_to_date !== true)
          bad('CHECK 3 post-apply preview not up_to_date', (prev2.error && prev2.error.message) || prev2.data);
      }
      if (failures === failsBefore)
        ok('CHECK 3 preview shows only the new step; apply adds exactly it; re-apply no-op; done step untouched');
    }

    // ── CHECK 4: deleted template step is tombstoned, never re-added ─────────
    {
      const del = await authed.rpc('delete_processing_subtask', {p_id: SUB_STEP2});
      if (del.error) bad('CHECK 4 delete_processing_subtask', del.error.message);
      else {
        const {data: rec} = await service
          .from('processing_records')
          .select('removed_template_steps')
          .eq('id', REC)
          .maybeSingle();
        const tombstones = (rec && rec.removed_template_steps) || [];
        const ap = await authed.rpc('apply_current_template', {p_record_id: REC});
        const subs = await subtasksOfRecord();
        const resurrected = subs.some((s) => s.template_step_id === STEP2.id);
        if (!tombstones.includes(STEP2.id)) bad('CHECK 4 removed_template_steps missing the step id', tombstones);
        else if (ap.error || (ap.data && ap.data.added !== 0) || resurrected)
          bad('CHECK 4 re-apply resurrected the removed step', {
            rpc: (ap.error && ap.error.message) || ap.data,
            resurrected,
          });
        else ok('CHECK 4 deleted linked step tombstoned in removed_template_steps; re-apply does not re-add it');
      }
    }

    // ── CHECK 5: assignment notifications (idempotent, self-silent, gated) ───
    {
      const tempOp = await createTempUser('op', 'farm_team');
      const tempLight = await createTempUser('light', 'light');
      if (tempOp.failed) {
        skipped(
          'CHECK 5 operational-assignment notification checks (temp farm_team user creation failed: ' +
            tempOp.failed +
            ')',
        );
      } else {
        const before = await notifCount(tempOp.id);
        const a1 = await authed.rpc('update_processing_subtask', {
          p_id: SUB_MANUAL,
          p_assignee_profile_id: tempOp.id,
        });
        const afterFirst = await notifCount(tempOp.id);
        if (a1.error || afterFirst - before !== 1)
          bad('CHECK 5 first assignment must insert exactly one notification', {
            rpc: a1.error && a1.error.message,
            delta: afterFirst - before,
          });
        else {
          const {data: note} = await service
            .from('notifications')
            .select('type, actor_profile_id, activity_event_id')
            .eq('recipient_profile_id', tempOp.id)
            .eq('type', 'processing_subtask_assigned')
            .order('created_at', {ascending: false})
            .limit(1)
            .maybeSingle();
          if (!note || note.actor_profile_id !== adminId || !note.activity_event_id)
            bad('CHECK 5 notification row shape (actor + activity deep-link)', note);
          else
            ok(
              "CHECK 5a real reassignment inserted exactly one 'processing_subtask_assigned' (actor + activity link stamped)",
            );
        }
        const a2 = await authed.rpc('update_processing_subtask', {
          p_id: SUB_MANUAL,
          p_assignee_profile_id: tempOp.id,
        });
        const afterReplay = await notifCount(tempOp.id);
        if (a2.error || afterReplay !== afterFirst)
          bad('CHECK 5b replayed same assignment must insert none', {
            rpc: a2.error && a2.error.message,
            afterReplay,
            afterFirst,
          });
        else ok('CHECK 5b no-op reassignment suppressed (no duplicate notification)');

        const selfBefore = await notifCount(adminId);
        const a3 = await authed.rpc('update_processing_subtask', {
          p_id: SUB_MANUAL,
          p_assignee_profile_id: adminId,
        });
        const selfAfter = await notifCount(adminId);
        if (a3.error || selfAfter !== selfBefore)
          bad('CHECK 5c self-assignment must insert none', {rpc: a3.error && a3.error.message, selfBefore, selfAfter});
        else ok('CHECK 5c self-assignment inserted no notification');
      }
      if (tempLight.failed) {
        skipped('CHECK 5d light-role assignment gate (temp light user creation failed: ' + tempLight.failed + ')');
      } else {
        const {error} = await authed.rpc('update_processing_subtask', {
          p_id: SUB_MANUAL,
          p_assignee_profile_id: tempLight.id,
        });
        if (!error || !/PROCESSING_VALIDATION|Processing access/i.test(error.message || ''))
          bad('CHECK 5d light-role assignee must be refused', error && error.message);
        else ok('CHECK 5d assigning to a light-role profile fails (' + String(error.message).slice(0, 70) + ')');
      }
    }

    // ── CHECK 6: fail-closed silent imported-assignee correction ─────────────
    {
      const unknown = await service.rpc('correct_processing_imported_assignee', {
        p_display_name: CASE_NAME,
        p_email: `mig177-nobody-${S}@example.invalid`,
      });
      if (!unknown.error || !/resolves to 0 profiles/.test(unknown.error.message || ''))
        bad("CHECK 6a unknown email must raise 'resolves to 0 profiles'", unknown.error && unknown.error.message);
      else ok('CHECK 6a unknown email fails closed (resolves to 0 profiles)');

      const notifBefore = await notifCount(adminId);
      const fix = await service.rpc('correct_processing_imported_assignee', {
        p_display_name: CASE_NAME,
        p_email: adminEmail,
      });
      const notifAfter = await notifCount(adminId);
      const caseRow = await readSubtask(SUB_CASE);
      if (fix.error) bad('CHECK 6b correction errored', fix.error.message);
      else if (!fix.data || !(fix.data.subtasks_corrected >= 1)) bad('CHECK 6b subtasks_corrected < 1', fix.data);
      else if (!caseRow || caseRow.assignee !== null || caseRow.assignee_profile_id !== adminId)
        bad('CHECK 6b name-only subtask not linked to the profile', caseRow);
      else if (notifAfter !== notifBefore)
        bad('CHECK 6b correction must be silent (notifications inserted)', {notifBefore, notifAfter});
      else ok('CHECK 6b correction linked the name-only subtask (assignee NULL, profile set) with ZERO notifications');
    }

    // ── CHECK 7: widened type CHECK still rejects invalid types ──────────────
    {
      const {error} = await service.from('notifications').insert({
        id: 'ntf-mig177-bad-' + S,
        recipient_profile_id: adminId,
        type: 'mig177_bogus_type',
        title: 'must never land',
      });
      if (!error || !/check|constraint/i.test(error.message || ''))
        bad('CHECK 7 invalid notification type must be rejected', error && error.message);
      else ok('CHECK 7 direct insert of an invalid notification type still fails the CHECK constraint');
    }
  } catch (e) {
    bad('unexpected failure', e.message || e);
  } finally {
    // ── restore the EXACT pre-run state ───────────────────────────────────────
    const restoreErrors = [];
    try {
      await authed.auth.signOut();
    } catch (e) {
      restoreErrors.push('sign-out: ' + (e.message || e));
    }
    if (tempAuthIds.length) {
      const {error} = await service.from('notifications').delete().in('recipient_profile_id', tempAuthIds);
      if (error) restoreErrors.push('delete temp notifications: ' + error.message);
    }
    for (const id of tempAuthIds) {
      try {
        const {error} = await service.auth.admin.deleteUser(id);
        if (error) restoreErrors.push('delete temp auth user ' + id.slice(0, 8) + ': ' + error.message);
      } catch (e) {
        restoreErrors.push('delete temp auth user ' + id.slice(0, 8) + ': ' + (e.message || e));
      }
    }
    {
      const {error} = await service.from('processing_asana_links').delete().eq('id', LINK_ID);
      if (error) restoreErrors.push('delete asana link: ' + error.message);
    }
    {
      const {error} = await service
        .from('activity_events')
        .delete()
        .eq('entity_type', 'processing.record')
        .eq('entity_id', REC);
      if (error) restoreErrors.push('delete activity events: ' + error.message);
    }
    {
      const {error} = await service.from('processing_records').delete().eq('id', REC); // subtasks cascade
      if (error) restoreErrors.push('delete seeded record: ' + error.message);
    }
    {
      const {error} = await service.from('processing_templates').delete().in('id', createdTemplateIds);
      if (error) restoreErrors.push('delete run templates: ' + error.message);
    }
    if (originalActiveBroiler) {
      const {error} = await service
        .from('processing_templates')
        .update({is_active: true})
        .eq('id', originalActiveBroiler.id);
      if (error) restoreErrors.push('reactivate original broiler template: ' + error.message);
    }
    // Verify the restore.
    try {
      const {data: recLeft} = await service.from('processing_records').select('id').eq('id', REC).maybeSingle();
      if (recLeft) restoreErrors.push('seeded record still present');
      const {data: subLeft} = await service.from('processing_subtasks').select('id').like('id', 'pst-mig177-%');
      if ((subLeft || []).length) restoreErrors.push('seeded subtasks still present: ' + JSON.stringify(subLeft));
      const {data: tplLeft} = await service.from('processing_templates').select('id').in('id', createdTemplateIds);
      if ((tplLeft || []).length) restoreErrors.push('run templates still present: ' + JSON.stringify(tplLeft));
      if (originalActiveBroiler) {
        const {data: act} = await service
          .from('processing_templates')
          .select('is_active')
          .eq('id', originalActiveBroiler.id)
          .maybeSingle();
        if (!act || act.is_active !== true) restoreErrors.push('original broiler template not active again');
      }
    } catch (e) {
      restoreErrors.push('restore verification: ' + (e.message || e));
    }
    if (restoreErrors.length) {
      failures++;
      console.error('RESTORE PROBLEMS:\n- ' + restoreErrors.join('\n- '));
    } else {
      console.log('restore ok — temp users, fixtures, and run templates removed; original active template restored');
    }
  }

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
