import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the processing-complete lane (migs 164/165/166 + the Edge
// importer-completeness/cutover boundaries + the client engine wiring):
//   • mig 164 — assignee model, typed field values (reserved-id lockstep),
//     milestone status/assignee/clear-date, subtask reorder, Activity emits,
//     checklist auto-seed on the planner INSERT branch only, operational
//     reconcile + automatic freshness;
//   • mig 165 — imported system stories → immutable historical Activity,
//     comment mentions (+ one-shot backfill), local-ownership rules for
//     imported assignees;
//   • mig 166 — native attachment upload boundary (native/ namespace, no
//     UPDATE/DELETE policies, add_processing_attachment);
//   • edge — cutover enforcement, fail-closed destination preflight before
//     every write, per-lane action isolation, recursive subtasks, 429 backoff;
//   • client — freshness on load, profile-backed people, attachment
//     field-name fix + signed open + upload owner. The template-driven
//     Details editor is RETIRED (planner-integration lane): record fields are
//     fixed/planner-owned; the drawer renders the read-only Source details
//     projection instead and no client path calls set_processing_field.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig164 = read('supabase-migrations/164_processing_engine.sql');
const mig165 = read('supabase-migrations/165_processing_import_history.sql');
const mig166 = read('supabase-migrations/166_processing_attachments_upload.sql');
const edge = read('supabase/functions/processing-asana-sync/index.ts');
const shape = read('supabase/functions/_shared/processingAsanaShape.js');
const fieldsLib = read('src/lib/processingFields.js');
const api = read('src/lib/processingApi.js');
const attachApi = read('src/lib/processingAttachmentsApi.js');
const view = read('src/processing/ProcessingCalendarView.jsx');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const templatesModal = read('src/processing/ProcessingTemplatesModal.jsx');
const milestoneModal = read('src/processing/AddMilestoneModal.jsx');

function fn164(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = mig164.match(re);
  return m ? m[0] : '';
}
function fn165(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = mig165.match(re);
  return m ? m[0] : '';
}

describe('mig 164 — engine schema + RPC boundary', () => {
  it('adds the assignee columns + freshness stamp (idempotent ADD COLUMN IF NOT EXISTS)', () => {
    expect(mig164).toMatch(
      /ALTER TABLE public\.processing_records[\s\S]*?assignee_profile_id uuid REFERENCES public\.profiles/,
    );
    expect(mig164).toMatch(/assignee_name\s+text/);
    expect(mig164).toMatch(
      /ALTER TABLE public\.processing_subtasks[\s\S]*?assignee_profile_id uuid REFERENCES public\.profiles/,
    );
    expect(mig164).toMatch(/last_planner_reconcile_at timestamptz/);
  });

  it('set_processing_field: operational, milestone-refusing, reserved-id locked in lockstep with the client', () => {
    const body = fn164('set_processing_field');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('public._processing_require_operational()');
    expect(body).toContain('milestones do not take template fields');
    expect(body).toContain('_processing_reserved_field_ids()');
    // typed validation per template type
    for (const t of ["'number'", "'date'", "'multi'"]) expect(body).toContain(t);
    expect(body).toContain('is not on the active');
    // The SQL reserved array mirrors RESERVED_PROCESSING_FIELD_IDS exactly.
    const sqlIds = mig164
      .match(/ARRAY\['procActual'[\s\S]*?'processor'\]/)[0]
      .match(/'([A-Za-z]+)'/g)
      .map((s) => s.slice(1, -1));
    const clientIds = fieldsLib
      .match(/RESERVED_PROCESSING_FIELD_IDS = Object\.freeze\(\[[\s\S]*?\]\)/)[0]
      .match(/'([A-Za-z]+)'/g)
      .map((s) => s.slice(1, -1));
    expect(sqlIds.sort()).toEqual(clientIds.sort());
    expect(mig164).toContain(
      'GRANT EXECUTE ON FUNCTION public.set_processing_field(text, text, jsonb) TO authenticated',
    );
  });

  it('milestone RPCs drop the old signatures (no ambiguous overloads) and validate canonical status', () => {
    expect(mig164).toContain(
      'DROP FUNCTION IF EXISTS public.create_processing_milestone(text, text, text, date, text, jsonb);',
    );
    expect(mig164).toContain(
      'DROP FUNCTION IF EXISTS public.update_processing_milestone(text, text, date, text, text, jsonb);',
    );
    expect(mig164).toContain('DROP FUNCTION IF EXISTS public.add_processing_subtask(text, text, text, text);');
    expect(mig164).toContain('DROP FUNCTION IF EXISTS public.update_processing_subtask(text, text, text);');
    const create = fn164('create_processing_milestone');
    expect(create).toMatch(/NOT IN \('planned','in_process','complete'\)/);
    const update = fn164('update_processing_milestone');
    expect(update).toMatch(/NOT IN \('planned','in_process','complete'\)/);
    // explicit clears beat COALESCE-keep
    expect(update).toContain('WHEN p_clear_date THEN NULL');
    expect(update).toContain('WHEN p_clear_assignee THEN NULL');
  });

  it('every Processing-owned mutation emits best-effort Activity via the shared emitter', () => {
    expect(mig164).toContain('CREATE OR REPLACE FUNCTION public._processing_emit_activity');
    expect(mig164).toMatch(/_processing_emit_activity[\s\S]*?EXCEPTION WHEN OTHERS THEN\s*\n\s*NULL/);
    for (const fn of [
      'set_processing_processor',
      'set_processing_customer',
      'set_processing_assignee',
      'set_processing_field',
      'mark_processing_complete',
      'reopen_processing_record',
      'add_processing_subtask',
      'update_processing_subtask',
      'delete_processing_subtask',
      'reorder_processing_subtasks',
      'apply_current_template',
    ]) {
      expect(fn164(fn), `${fn} emits Activity`).toContain('_processing_emit_activity');
    }
  });

  it('checklist auto-seed lives ONLY on the planner INSERT branch (update never re-seeds)', () => {
    const body = fn164('upsert_processing_from_planner');
    expect(body).toContain("RETURN jsonb_build_object('id', v_id, 'action', 'updated')");
    // The seed loop sits AFTER the updated-return (insert path only).
    const updatedReturn = body.indexOf("'updated'");
    const seedLoop = body.indexOf('jsonb_array_elements(COALESCE(v_tpl.checklist');
    expect(seedLoop).toBeGreaterThan(updatedReturn);
    expect(body).toContain('is_active = true');
  });

  it('reconcile widens to the operational roles and stamps the freshness marker', () => {
    const body = fn164('reconcile_planner_to_processing');
    expect(body).toContain("NOT IN ('farm_team','management','admin')");
    expect(body).toContain("pg_advisory_xact_lock(hashtext('processing_reconcile'))");
    expect(body).toContain('last_planner_reconcile_at = now()');
  });

  it('ensure_processing_freshness: operational gate, staleness stamp, try-lock skip', () => {
    const body = fn164('ensure_processing_freshness');
    expect(body).toContain('public._processing_require_operational()');
    expect(body).toContain('last_planner_reconcile_at');
    expect(body).toContain("pg_try_advisory_xact_lock(hashtext('processing_reconcile'))");
    expect(body).toContain('public.reconcile_planner_to_processing()');
    expect(mig164).toContain('GRANT EXECUTE ON FUNCTION public.ensure_processing_freshness(int) TO authenticated');
    expect(mig164).toContain('REVOKE ALL ON FUNCTION public.ensure_processing_freshness(int) FROM PUBLIC, anon');
  });

  it('read RPCs return assignee + broiler farm_arrival alongside TOF', () => {
    const list = fn164('list_processing_records');
    expect(list).toContain("'assignee_profile_id', r.assignee_profile_id");
    expect(list).toContain("'farm_arrival', bt.hatch_date");
    expect(list).toContain("'time_on_farm_days', bt.tof_days");
    const get = fn164('get_processing_record');
    expect(get).toContain("'farm_arrival', v_hatch");
  });
});

describe('mig 165 — imported history, mentions, local-ownership', () => {
  it('record_processing_history_event: service_role only, deterministic id, original timestamp, NULL actor', () => {
    const body = fn165('record_processing_history_event');
    expect(body).toContain("'ae-asana-' || v_gid");
    expect(body).toContain("'imported.system'");
    expect(body).toMatch(/NULL, 'imported\.system'/); // actor_profile_id stays NULL
    expect(body).toContain("COALESCE((p_row->>'created_at')::timestamptz, now())");
    expect(mig165).toContain('GRANT EXECUTE ON FUNCTION public.record_processing_history_event(jsonb) TO service_role');
    expect(mig165).toContain(
      'REVOKE ALL ON FUNCTION public.record_processing_history_event(jsonb) FROM PUBLIC, anon, authenticated',
    );
  });

  it('record_processing_comment validates mentions against real profiles and backfills once', () => {
    const body = fn165('record_processing_comment');
    expect(body).toMatch(/EXISTS \(SELECT 1 FROM public\.profiles WHERE id = \(v_m #>> '\{\}'\)::uuid\)/);
    expect(body).toContain("'mentions_backfilled'");
    expect(body).toMatch(/COALESCE\(array_length\(mentions, 1\), 0\) = 0/);
  });

  it('imported assignees can never clobber a local assignment (records + subtasks)', () => {
    const sub = fn165('upsert_processing_subtask_from_asana');
    expect(sub).toMatch(/CASE WHEN assignee_profile_id IS NOT NULL THEN assignee\b/);
    expect(sub).toMatch(/CASE WHEN done_locally_set THEN done/); // mig 157 rule preserved
    const rec = fn165('upsert_processing_from_asana');
    expect(rec).toMatch(/CASE WHEN assignee_profile_id IS NOT NULL THEN assignee_name/);
    expect(rec).toContain('Asana import may not create planner_batch records');
  });
});

describe('mig 166 — native attachment upload boundary', () => {
  it('INSERT policy: operational roles, bucket-scoped, native/ namespace ONLY; no UPDATE/DELETE policies', () => {
    expect(mig166).toContain('processing_attachments_operational_insert');
    expect(mig166).toContain('FOR INSERT TO authenticated');
    expect(mig166).toMatch(/profile_role\(\) IN \('farm_team', 'management', 'admin'\)/);
    expect(mig166).toContain("name LIKE 'native/%'");
    expect(mig166).not.toMatch(/FOR (UPDATE|DELETE)/);
  });

  it('add_processing_attachment: operational, path-locked to the record, size-capped, caller provenance', () => {
    expect(mig166).toContain('public._processing_require_operational()');
    expect(mig166).toContain("NOT LIKE ('native/' || v_rec_id || '/%')");
    expect(mig166).toContain('52428800');
    expect(mig166).toContain('_processing_emit_activity');
    expect(mig166).toContain('GRANT EXECUTE ON FUNCTION public.add_processing_attachment(jsonb) TO authenticated');
  });
});

describe('edge — cutover, preflight, isolation, completeness', () => {
  it('enforces asana_sync_enabled for EVERY Asana action (probe + planner-only reconcile exempt)', () => {
    // The cutover read sits AFTER the planner-only branch and BEFORE the token
    // check, so no Asana-touching action can run once the flag is false.
    const plannerIdx = edge.indexOf("if (action === 'sync_planner_to_processing')");
    const cutoverIdx = edge.indexOf(".select('asana_sync_enabled, asana_comments_import_enabled')");
    const tokenIdx = edge.indexOf("error: 'ASANA_ACCESS_TOKEN not configured'");
    expect(plannerIdx).toBeGreaterThan(-1);
    expect(cutoverIdx).toBeGreaterThan(plannerIdx);
    expect(tokenIdx).toBeGreaterThan(cutoverIdx);
    expect(edge).toContain('asana_sync_enabled is false — Asana sync/import is locked (final cutover)');
  });

  it('cron mode pins COMMENTS-ONLY import; the comments flag unlocks ONLY sync_comments (mig 185)', () => {
    // The recurring path can never run sync_once or any wider Asana action.
    expect(edge).toContain("const action = mode === 'cron' ? 'sync_comments' :");
    expect(edge).not.toContain("mode === 'cron' ? 'sync_once'");
    // The independent comments flag widens exactly ONE action past the global
    // cutover; everything else still requires asana_sync_enabled.
    expect(edge).toContain(
      "const allowed = action === 'sync_comments' ? globalEnabled || commentsEnabled : globalEnabled",
    );
    expect(edge).toContain(
      'comments import is locked — asana_sync_enabled and asana_comments_import_enabled are both false',
    );
    // A missing settings row fails closed for both branches.
    expect(edge).toMatch(/globalEnabled = !!settings && settings\.asana_sync_enabled === true/);
    expect(edge).toMatch(/commentsEnabled = !!settings && settings\.asana_comments_import_enabled === true/);
  });

  it('runs the fail-closed destination preflight before every write action', () => {
    expect(edge).toContain('const WRITE_ACTIONS = new Set([');
    for (const a of [
      'sync_review_queue',
      'sync_comments',
      'sync_artifacts',
      'sync_activity',
      'sync_once',
      'sync_since',
      'attachment_backfill',
      'import_templates',
    ]) {
      const re = new RegExp(`WRITE_ACTIONS[\\s\\S]*?'${a}'`);
      expect(edge, `${a} in WRITE_ACTIONS`).toMatch(re);
    }
    expect(edge).toContain('enforceDestinationPreflight(svc)');
    expect(edge).toContain('destination preflight failed — unresolved destinations');
    // destination_audit is registered as the read-only full enumeration.
    expect(edge).toContain("'destination_audit'");
    expect(edge).toContain('runDestinationAudit(svc)');
    expect(edge).toContain('buildDestinationAudit');
  });

  it('fetches subtasks GENUINELY recursively and honors 429 Retry-After', () => {
    expect(edge).toContain('async function fetchSubtasksRecursive(');
    expect(edge).toMatch(/num_subtasks/);
    expect(edge).toMatch(/fetchSubtasksRecursive\(childGid, depth \+ 1\)/);
    expect(edge).toContain('res.status === 429');
    expect(edge).toContain("retryAfterMs(res.headers.get('retry-after'), attempt)");
  });

  it('maps users by stable gid/email (workspace directory + auth emails), never display name alone', () => {
    expect(edge).toContain('loadMappingContext');
    expect(edge).toContain('buildUserDirectory');
    expect(edge).toContain('mapAsanaUserToProfile');
    expect(edge).toContain('svc.auth.admin.listUsers');
    expect(edge).toContain('parseAsanaMentionProfileIds');
  });

  it('registers the per-lane actions with their dedicated dry runs', () => {
    for (const a of [
      'artifacts_dry_run',
      'sync_artifacts',
      'activity_dry_run',
      'sync_activity',
      'attachment_dry_run',
      'attachment_backfill',
    ]) {
      expect(edge, `action ${a}`).toContain(`'${a}'`);
    }
    expect(edge).toContain('runArtifactsImport');
    expect(edge).toContain('runActivityImport');
    expect(edge).toContain('record_processing_history_event');
    expect(edge).toContain('isSystemStory');
  });

  it('pure shape module exports the completeness layer + CF destination map', () => {
    for (const name of [
      'CF_DESTINATIONS',
      'buildUserDirectory',
      'mapAsanaUserToProfile',
      'parseAsanaMentionProfileIds',
      'isSystemStory',
      'mapAsanaSystemStory',
      'retryAfterMs',
      'buildDestinationAudit',
      'mergeTemplateChecklistAssignees',
      'asanaColorToPalette',
    ]) {
      expect(shape, `shape exports ${name}`).toMatch(new RegExp(`export (function|const) ${name}\\b`));
    }
    // The snapshot now carries the previously-dropped Asana facts.
    for (const key of ['farm_arrival', 'condemned', 'notes', 'assignee_name']) {
      expect(shape, `snapshot key ${key}`).toContain(key);
    }
    // In-Proccess (real Asana spelling) normalizes to In Process display.
    const statusLib = read('src/lib/processingStatusDisplay.js');
    expect(statusLib).toContain("'in-proccess'");
  });
});

describe('client — engine wiring', () => {
  it('the page ensures planner freshness on load (tolerated failure) before listing', () => {
    expect(view).toContain('ensureProcessingFreshness');
    const loadIdx = view.indexOf('await ensureProcessingFreshness(sb)');
    const listIdx = view.indexOf('await listProcessingRecords(sb');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(loadIdx);
    expect(api).toContain("sb.rpc('ensure_processing_freshness'");
  });

  it('the generic Details editor is RETIRED: no details section, no set_processing_field caller anywhere', () => {
    // Planner-integration lane: record fields are fixed. The drawer renders the
    // read-only Source details projection; the configurable field engine and
    // its write path must not return to the client.
    expect(drawer).not.toContain('data-processing-details-section');
    expect(drawer).not.toContain('resolveFieldDisplay');
    expect(drawer).not.toContain('isFieldEditable');
    expect(drawer).not.toContain('setProcessingField');
    expect(drawer).toContain('data-processing-source-section');
    expect(drawer).toContain('data-processing-source-link');
    // No file under src/processing/ calls setProcessingField, and the client
    // API no longer exports it (the server RPC stays deployed, caller-less).
    const processingDir = path.join(ROOT, 'src', 'processing');
    for (const file of fs.readdirSync(processingDir)) {
      const src = read(path.join('src', 'processing', file));
      expect(src, `${file} must not reference setProcessingField`).not.toContain('setProcessingField');
    }
    expect(api).not.toMatch(/export (async )?function setProcessingField\b/);
  });

  it('people pickers are profile-backed (list_eligible_assignees); the parent assignee is retired', () => {
    expect(view).toContain('loadEligibleProfilesById');
    expect(drawer).not.toMatch(/PEOPLE = \[/);
    expect(templatesModal).toContain('loadEligibleProfilesById');
    expect(templatesModal).not.toMatch(/const PEOPLE = \[/);
    // UI-simplification lane: no parent record Assignee/Owner control anywhere;
    // checklist/subtask assignees remain profile-backed in the drawer.
    expect(drawer).not.toContain('setProcessingAssignee');
    expect(drawer).not.toContain('data-processing-assignee-select');
    expect(drawer).toContain('reassignSubtask');
    expect(milestoneModal).not.toContain('data-processing-milestone-assignee');
    expect(milestoneModal).toContain('data-processing-milestone-status');
  });

  it('templates manager is CHECKLIST-ONLY: stable step ids, id-less new steps, fields:null save', () => {
    // The configurable Fields editor is retired with the Details section: no
    // field-id minting, no color palette, no fields reset.
    expect(templatesModal).not.toContain("newProcessingId('fld')");
    expect(templatesModal).not.toContain('PROCESSING_FIELD_PALETTE');
    expect(templatesModal).not.toContain('data-processing-color-palette');
    expect(templatesModal).not.toContain('defaultProcessingFields');
    // Drag reorder survives on checklist steps.
    expect(templatesModal).toContain('draggable: true');
    // Stable ids (mig 177): existing step ids are preserved verbatim on save;
    // NEW steps go up WITHOUT an id (the server mints 'stp-<uuid>').
    expect(templatesModal).toMatch(/if \(c\.id\) out\.id = c\.id;/);
    expect(templatesModal).toMatch(/\{id: null, label: '', assignee: null, assignee_profile_id: null\}/);
    // Save never touches fields — the server preserves the active version's
    // fields verbatim on fields:null.
    expect(templatesModal).toMatch(
      /upsertProcessingTemplate\(sb, \{program, fields: null, checklist: cleanChecklist\}\)/,
    );
    // Hotfix: reset remains unavailable from the visible modal footer.
    expect(templatesModal).not.toContain('data-processing-template-reset');
  });

  it('attachments: DB field names (filename/size_bytes), signed open, native upload through the single owner', () => {
    // The old file_name/file_size mismatch must not return.
    expect(drawer).not.toContain('at.file_name');
    expect(drawer).not.toContain('at.file_size');
    expect(drawer).toContain('at.filename');
    expect(drawer).toContain('at.size_bytes');
    expect(drawer).toContain('getProcessingAttachmentUrl');
    expect(drawer).toContain('uploadProcessingAttachment');
    expect(drawer).toContain('data-processing-add-files');
    expect(attachApi).toContain("PROCESSING_ATTACHMENT_BUCKET = 'processing-attachments'");
    expect(attachApi).toMatch(/native\/\$\{recordId\}/);
    expect(attachApi).toContain('upsert: false');
    // Destructive removal exists ONLY inside the mig-185 two-phase delete flow:
    // request RPC → policy-gated storage remove → truthful finalize RPC. The
    // CODE remove call (`).remove([`) is single-sited and both RPC brackets are
    // present (comments may mention remove; code may call it once).
    expect(attachApi.match(/\)\.remove\(\[/g)).toHaveLength(1);
    expect(attachApi).toContain("rpc('request_processing_attachment_delete'");
    expect(attachApi).toContain("rpc('finalize_processing_attachment_delete'");
    const reqIdx = attachApi.indexOf("rpc('request_processing_attachment_delete'");
    const rmIdx = attachApi.indexOf(').remove([');
    const finIdx = attachApi.indexOf("rpc('finalize_processing_attachment_delete'");
    expect(reqIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(reqIdx);
    expect(finIdx).toBeGreaterThan(rmIdx);
    // A blocked/failed Storage removal is finalized ok=false and THROWS — the
    // client can never report an unremoved object as deleted.
    expect(attachApi).toContain('p_ok: removed');
    expect(attachApi).toMatch(/if \(!removed\) throw new Error/);
  });

  it('attachment delete UI is ADMIN-only, per-tile, filename-confirmed; upload stays operational (picker + drop zone)', () => {
    // Upload affordances (picker + drop zone) key off canOperate — unchanged
    // operational gating (Ronnie 2026-07-16: upload is NOT admin-only).
    expect(drawer).toContain("const isAdmin = role === 'admin'");
    expect(drawer).toContain('data-processing-attachment-dropzone');
    expect(drawer).toMatch(/\{\.\.\.\(canOperate\s*\?\s*\{\s*onDragEnter/);
    // The browser must never open a dropped file; drop shares the picker's
    // sequential upload path.
    expect(drawer).toMatch(/function onZoneDrop\(e\) \{\s*e\.preventDefault\(\);/);
    expect(drawer).toMatch(/function onZoneDragOver\(e\) \{\s*e\.preventDefault\(\);/);
    expect(drawer).toContain('uploadFiles(Array.from(e.dataTransfer?.files || []))');
    // Delete: separate control (not nested in the open button), admin-gated,
    // filename-specific confirm, per-attachment busy.
    expect(drawer).toContain('data-processing-attachment-open');
    expect(drawer).toContain('data-processing-attachment-delete');
    expect(drawer).toContain('data-processing-attachment-delete-confirm');
    // Delete is admin-gated and the whole action row is hidden while the
    // filename-confirm is open (the rename lane moved Delete into a shared
    // action group with Rename, still under !confirming and isAdmin).
    expect(drawer).toMatch(/!confirming && \(/);
    expect(drawer).toMatch(/\{isAdmin && \(/);
    expect(drawer).toContain('Delete {name}?');
    expect(drawer).toContain('deletingAttachmentIds.has(at.id)');
    expect(drawer).toContain('deleteProcessingAttachment(sb, {attachmentId: at.id})');
  });

  it('metrics count BATCH rows only (milestones excluded)', () => {
    expect(view).toMatch(/const batchRows = yearRows\.filter\(\(r\) => r\._isBatch\)/);
    // Planner-integration lane: batch == anything that is not a milestone
    // (list_processing_records already excludes import_exception rows), so a
    // future record_type can never silently vanish from the stat cards.
    expect(view).toMatch(/_isBatch: rec\.record_type !== 'milestone'/);
  });
});
