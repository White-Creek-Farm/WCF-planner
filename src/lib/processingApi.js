// ============================================================================
// src/lib/processingApi.js  —  Processing Calendar client API (mig 156)
// ----------------------------------------------------------------------------
// Thin async wrappers over the SECURITY DEFINER RPCs from
// supabase-migrations/156_processing_calendar.sql. This module is the ONLY
// client path into the Processing domain: every processing_* table is deny-all
// RLS (service_role reaches them via BYPASSRLS), so clients NEVER .from() them —
// reads and writes both route through these RPCs.
//
// Role model (enforced server-side): farm_team / management / admin may read +
// operate; light/equipment_tech/inactive are denied. A handful of RPCs are
// admin-only (templates, hard delete, sync-mode flag). Deterministic failures
// carry the 'PROCESSING_VALIDATION:' prefix; everything else (network / 5xx /
// expired session) is transient. See isProcessingValidationError below.
//
// Every wrapper throws Error(`<fn>: <message>`) on rpc error so callers can
// try/catch and surface a single, consistently-shaped message.
// ============================================================================

// Client-minted id for a milestone record or a subtask. The server validates
// ids against ^[A-Za-z0-9-]+$ (length <= 100); a prefixed UUID satisfies that.
// crypto.randomUUID is available in every supported browser (secure context);
// the fallback covers older runners / non-secure contexts. Minting client-side
// keeps create/add idempotent — the UI generates the id once and can replay the
// same call on retry (the RPCs treat a pre-existing id as a no-op replay).
export function newProcessingId(prefix = 'prc') {
  const safePrefix = /^[A-Za-z0-9]+$/.test(prefix) ? prefix : 'prc';
  const uuid =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return `${safePrefix}-${uuid}`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

// list_processing_records(p_year, p_program, p_include_archived) -> jsonb array.
// Each row: id, record_type, program, title, processing_date, status,
// completed_at, processor, number_processed, customer, source_kind, source_id,
// archived, fields, historical_snapshot, subtask_total, subtask_done.
export async function listProcessingRecords(sb, {year = null, program = null, includeArchived = false} = {}) {
  const {data, error} = await sb.rpc('list_processing_records', {
    p_year: Number.isFinite(year) ? year : year == null ? null : Number(year) || null,
    p_program: program ?? null,
    p_include_archived: !!includeArchived,
  });
  if (error) throw new Error(`listProcessingRecords: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

// get_processing_record(p_id) -> the record columns + subtasks[] + attachments[]
// + completion_blockers[] (text). Returns null when the id resolves to nothing.
export async function getProcessingRecord(sb, id) {
  const {data, error} = await sb.rpc('get_processing_record', {p_id: id});
  if (error) throw new Error(`getProcessingRecord: ${error.message || String(error)}`);
  return data || null;
}

// get_processing_settings() -> the singleton settings row (asana_sync_enabled,
// processor_options, last_sync_at, ...).
export async function getProcessingSettings(sb) {
  const {data, error} = await sb.rpc('get_processing_settings');
  if (error) throw new Error(`getProcessingSettings: ${error.message || String(error)}`);
  return data || {};
}

// ensure_processing_freshness(p_max_age_seconds) -> {ok, ran, fresh?|busy?}.
// The automatic planner-freshness entry point (mig 164): reconciles the four
// planner programs into Processing when the last reconcile is stale, debounced
// server-side and advisory-try-locked. Never calls Asana. The page calls this
// on load BEFORE listing; failures are the caller's to tolerate (the list still
// renders from the last reconciled state).
export async function ensureProcessingFreshness(sb, maxAgeSeconds = 120) {
  const {data, error} = await sb.rpc('ensure_processing_freshness', {p_max_age_seconds: maxAgeSeconds});
  if (error) throw new Error(`ensureProcessingFreshness: ${error.message || String(error)}`);
  return data || {};
}

// set_processing_option_list(p_kind, p_options) -> {ok, kind, options}. Admin
// only. kind is 'processor' | 'customer'; replaces that list wholesale (server
// trims/de-dupes). Never rejects or rewrites stored record values.
export async function setProcessingOptionList(sb, kind, options) {
  const {data, error} = await sb.rpc('set_processing_option_list', {
    p_kind: kind,
    p_options: Array.isArray(options) ? options : [],
  });
  if (error) throw new Error(`setProcessingOptionList: ${error.message || String(error)}`);
  return data;
}

// list_processing_templates(p_program) -> active templates (optionally one
// program). Each: id, program, version, fields[], checklist[], is_active.
export async function listProcessingTemplates(sb, program = null) {
  const {data, error} = await sb.rpc('list_processing_templates', {p_program: program ?? null});
  if (error) throw new Error(`listProcessingTemplates: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

// ── Milestone CRUD (Processing-owned records) ────────────────────────────────

// create_processing_milestone(p_id, p_program, p_title, p_processing_date,
// p_processor, p_customer, p_status, p_assignee_profile_id). id is minted
// client-side when omitted so the create is idempotent on retry. status is the
// canonical vocabulary: 'planned' | 'in_process' | 'complete'.
export async function createProcessingMilestone(
  sb,
  {
    id,
    program,
    title,
    processingDate = null,
    processor = null,
    customer = [],
    status = 'planned',
    assigneeProfileId = null,
  } = {},
) {
  const p_id = id || newProcessingId('prc');
  const {data, error} = await sb.rpc('create_processing_milestone', {
    p_id,
    p_program: program,
    p_title: title,
    p_processing_date: processingDate ?? null,
    p_processor: processor ?? null,
    p_customer: customer ?? [],
    p_status: status ?? 'planned',
    p_assignee_profile_id: assigneeProfileId ?? null,
  });
  if (error) throw new Error(`createProcessingMilestone: ${error.message || String(error)}`);
  return data;
}

// update_processing_milestone(...). All fields optional; the server COALESCEs
// nulls to the existing value (only milestones are editable this way).
// clearDate=true explicitly REMOVES the milestone date (a floating marker);
// clearAssignee=true explicitly clears the assignee.
export async function updateProcessingMilestone(
  sb,
  {
    id,
    title = null,
    processingDate = null,
    status = null,
    processor = null,
    customer = null,
    assigneeProfileId = null,
    clearAssignee = false,
    clearDate = false,
  } = {},
) {
  const {data, error} = await sb.rpc('update_processing_milestone', {
    p_id: id,
    p_title: title ?? null,
    p_processing_date: processingDate ?? null,
    p_status: status ?? null,
    p_processor: processor ?? null,
    p_customer: customer ?? null,
    p_assignee_profile_id: assigneeProfileId ?? null,
    p_clear_assignee: !!clearAssignee,
    p_clear_date: !!clearDate,
  });
  if (error) throw new Error(`updateProcessingMilestone: ${error.message || String(error)}`);
  return data;
}

export async function deleteProcessingMilestone(sb, id) {
  const {data, error} = await sb.rpc('delete_processing_milestone', {p_id: id});
  if (error) throw new Error(`deleteProcessingMilestone: ${error.message || String(error)}`);
  return data;
}

// archive_processing_record(p_id, p_archived) -> {ok, archived}. Soft delete /
// restore for Asana-owned + milestone records (preserves the record + its Asana
// link provenance); refuses planner_batch (Planner-owned). Operational-role gated.
export async function archiveProcessingRecord(sb, id, archived = true) {
  const {data, error} = await sb.rpc('archive_processing_record', {p_id: id, p_archived: archived});
  if (error) throw new Error(`archiveProcessingRecord: ${error.message || String(error)}`);
  return data;
}

// ── Processing-owned field edits ─────────────────────────────────────────────

// set_processing_field(p_id, p_field_id, p_value) — typed local custom-field
// value keyed by the STABLE template field id (mig 164). The server validates
// the value against the ACTIVE template field type and refuses the reserved
// bound ids (see src/lib/processingFields.js RESERVED_PROCESSING_FIELD_IDS).
// Pass value=null to clear.
export async function setProcessingField(sb, id, fieldId, value) {
  const {data, error} = await sb.rpc('set_processing_field', {
    p_id: id,
    p_field_id: fieldId,
    p_value: value === undefined ? null : value,
  });
  if (error) throw new Error(`setProcessingField: ${error.message || String(error)}`);
  return data;
}

// set_processing_assignee(p_id, p_profile_id) — parent record assignee
// (profile-backed; null clears; also clears the imported display-name fallback).
export async function setProcessingAssignee(sb, id, profileId) {
  const {data, error} = await sb.rpc('set_processing_assignee', {
    p_id: id,
    p_profile_id: profileId ?? null,
  });
  if (error) throw new Error(`setProcessingAssignee: ${error.message || String(error)}`);
  return data;
}

// set_processing_processor(p_id, p_processor). Editable on any record (blank
// clears it, stored as NULL).
export async function setProcessingProcessor(sb, id, processor) {
  const {data, error} = await sb.rpc('set_processing_processor', {p_id: id, p_processor: processor ?? null});
  if (error) throw new Error(`setProcessingProcessor: ${error.message || String(error)}`);
  return data;
}

// set_processing_customer(p_id, p_customer) — Broiler-only (server rejects other
// programs). p_customer must be a json array.
export async function setProcessingCustomer(sb, id, customer) {
  const {data, error} = await sb.rpc('set_processing_customer', {p_id: id, p_customer: customer ?? []});
  if (error) throw new Error(`setProcessingCustomer: ${error.message || String(error)}`);
  return data;
}

// ── Completion (gated) + reopen ──────────────────────────────────────────────

// mark_processing_complete(p_id). RAISES
// 'PROCESSING_VALIDATION: cannot complete — <blockers>' when the completion gate
// is unmet (mirror the gate client-side with processingCompletion.js for instant
// feedback before calling this).
export async function markProcessingComplete(sb, id) {
  const {data, error} = await sb.rpc('mark_processing_complete', {p_id: id});
  if (error) throw new Error(`markProcessingComplete: ${error.message || String(error)}`);
  return data;
}

export async function reopenProcessingRecord(sb, id) {
  const {data, error} = await sb.rpc('reopen_processing_record', {p_id: id});
  if (error) throw new Error(`reopenProcessingRecord: ${error.message || String(error)}`);
  return data;
}

// ── Subtask CRUD ─────────────────────────────────────────────────────────────

// add_processing_subtask(p_id, p_record_id, p_label, p_assignee,
// p_assignee_profile_id). Subtask id is minted client-side when omitted
// (idempotent replay). assigneeProfileId is the profile-backed assignment;
// the text assignee remains the imported-name fallback.
export async function addProcessingSubtask(sb, {id, recordId, label, assignee = null, assigneeProfileId = null} = {}) {
  const p_id = id || newProcessingId('pst');
  const {data, error} = await sb.rpc('add_processing_subtask', {
    p_id,
    p_record_id: recordId,
    p_label: label,
    p_assignee: assignee ?? null,
    p_assignee_profile_id: assigneeProfileId ?? null,
  });
  if (error) throw new Error(`addProcessingSubtask: ${error.message || String(error)}`);
  return data;
}

// update_processing_subtask(...). clearAssignee=true explicitly clears BOTH the
// profile-backed and imported text assignee (a subtask has one current assignee).
export async function updateProcessingSubtask(
  sb,
  {id, label = null, assignee = null, assigneeProfileId = null, clearAssignee = false} = {},
) {
  const {data, error} = await sb.rpc('update_processing_subtask', {
    p_id: id,
    p_label: label ?? null,
    p_assignee: assignee ?? null,
    p_assignee_profile_id: assigneeProfileId ?? null,
    p_clear_assignee: !!clearAssignee,
  });
  if (error) throw new Error(`updateProcessingSubtask: ${error.message || String(error)}`);
  return data;
}

// reorder_processing_subtasks(p_record_id, p_ids[]) — set the record's subtask
// order to the given id order (unlisted subtasks keep their relative order
// after the listed block).
export async function reorderProcessingSubtasks(sb, recordId, ids) {
  const {data, error} = await sb.rpc('reorder_processing_subtasks', {
    p_record_id: recordId,
    p_ids: Array.isArray(ids) ? ids : [],
  });
  if (error) throw new Error(`reorderProcessingSubtasks: ${error.message || String(error)}`);
  return data;
}

// set_processing_subtask_done(p_id, p_done). Toggling NEVER auto-completes the
// parent record (server-enforced).
export async function setProcessingSubtaskDone(sb, id, done) {
  const {data, error} = await sb.rpc('set_processing_subtask_done', {p_id: id, p_done: !!done});
  if (error) throw new Error(`setProcessingSubtaskDone: ${error.message || String(error)}`);
  return data;
}

export async function deleteProcessingSubtask(sb, id) {
  const {data, error} = await sb.rpc('delete_processing_subtask', {p_id: id});
  if (error) throw new Error(`deleteProcessingSubtask: ${error.message || String(error)}`);
  return data;
}

// apply_current_template(p_record_id). Additive — adds only checklist steps not
// already present; never destructive, never auto-completes.
export async function applyCurrentTemplate(sb, recordId) {
  const {data, error} = await sb.rpc('apply_current_template', {p_record_id: recordId});
  if (error) throw new Error(`applyCurrentTemplate: ${error.message || String(error)}`);
  return data;
}

// ── Admin-only ───────────────────────────────────────────────────────────────

// upsert_processing_template(p_program, p_fields, p_checklist) — admin only.
// Creates a new active version superseding the prior one.
export async function upsertProcessingTemplate(sb, {program, fields = [], checklist = []} = {}) {
  const {data, error} = await sb.rpc('upsert_processing_template', {
    p_program: program,
    p_fields: fields ?? [],
    p_checklist: checklist ?? [],
  });
  if (error) throw new Error(`upsertProcessingTemplate: ${error.message || String(error)}`);
  return data;
}

// hard_delete_processing_record(p_id) — admin only. Server refuses planner_batch
// rows (planner-owned).
export async function hardDeleteProcessingRecord(sb, id) {
  const {data, error} = await sb.rpc('hard_delete_processing_record', {p_id: id});
  if (error) throw new Error(`hardDeleteProcessingRecord: ${error.message || String(error)}`);
  return data;
}

// set_asana_sync_enabled(p_enabled) — admin only. The explicit source-mode flag:
// while enabled, Asana is the source of truth and imported/source-owned fields
// stay read-only in the app.
export async function setAsanaSyncEnabled(sb, enabled) {
  const {data, error} = await sb.rpc('set_asana_sync_enabled', {p_enabled: !!enabled});
  if (error) throw new Error(`setAsanaSyncEnabled: ${error.message || String(error)}`);
  return data;
}

// ── Asana sync Edge Function ─────────────────────────────────────────────────

// Trigger the server-side Asana mirror (import / probe). The Edge Function
// authenticates the admin and runs the sync with the service role; the Asana
// token never leaves the function. Mirrors newsletterApi's invoke pattern:
// supabase-js v2 carries the HTTP error body on error.context, which we unwrap
// to the real message when present.
//   action : the sync action the function understands. The action string is
//            passed straight through to the Edge Function, so newer actions
//            work without a lib change — e.g. 'dry_run', 'sync_once',
//            'sync_planner_to_processing'.
//   since  : optional ISO cursor to limit the scan (modified-since)
//   probe  : boolean — ask the function for status/config only (no writes)
export async function invokeProcessingAsanaSync(sb, {action, since = null, probe = false} = {}) {
  const body = {mode: 'admin'};
  if (action != null) body.action = action;
  if (since != null) body.since = since;
  if (probe) body.probe = true;
  const {data, error} = await sb.functions.invoke('processing-asana-sync', {body});
  if (error) {
    let detail = error.message || String(error);
    try {
      const errBody = error.context && (await error.context.json());
      if (errBody && errBody.error) detail = errBody.error;
    } catch (_e) {
      /* keep the generic message */
    }
    throw new Error(`invokeProcessingAsanaSync: ${detail}`);
  }
  if (data && data.ok === false) throw new Error(`invokeProcessingAsanaSync: ${data.error || 'failed'}`);
  return data || {};
}

// ── Reconciliation (Planner ⇄ Processing crosswalk) ──────────────────────────
// The reconciliation surface is a management/admin admin tool built on the
// mig-157 RPCs. Planner is senior: reconcile_planner_to_processing bridges every
// live Planner batch/trip into a planner_batch Processing row; the
// processing_asana_links table then maps Asana tasks onto those rows (many Asana
// -> one row for pig trips). list_processing_reconciliation buckets the links so
// an admin can crosswalk needs_review links and acknowledge informational drift.

// reconcile_planner_to_processing() -> {ok, cattle, sheep, broiler, pig}. Atomic,
// advisory-locked, idempotent (safe to re-run) — upserts planner_batch rows by
// (source_kind, source_id). authenticated management/admin only (service_role is
// also permitted for the Edge Function path).
export async function reconcilePlannerToProcessing(sb) {
  const {data, error} = await sb.rpc('reconcile_planner_to_processing');
  if (error) throw new Error(`reconcilePlannerToProcessing: ${error.message || String(error)}`);
  return data || {};
}

// list_processing_reconciliation() -> {links[], planner_only_count,
// needs_review_count, matched_count, historical_count, drift_count}. Each link:
// {id, asana_gid, processing_record_id, program, asana_batch_code, match_status,
// match_method, confidence, candidate_record_ids[], drift, drift_acknowledged_at,
// raw_asana_snapshot, ...}. Operational-role gated server-side.
export async function listProcessingReconciliation(sb) {
  const {data, error} = await sb.rpc('list_processing_reconciliation');
  if (error) throw new Error(`listProcessingReconciliation: ${error.message || String(error)}`);
  return data || {};
}

// resolve_processing_asana_link(p_asana_gid, p_record_id) -> {ok}. Manual
// crosswalk: point a needs_review link at the chosen Planner record
// (candidate_record_ids are only suggestions; many Asana rows may map to one
// record). recordId null sends the link back to needs_review.
export async function resolveProcessingAsanaLink(sb, asanaGid, recordId) {
  const {data, error} = await sb.rpc('resolve_processing_asana_link', {
    p_asana_gid: asanaGid,
    p_record_id: recordId ?? null,
  });
  if (error) throw new Error(`resolveProcessingAsanaLink: ${error.message || String(error)}`);
  return data;
}

// acknowledge_processing_drift(p_asana_gid) -> {ok}. Drift is informational
// (Asana disagrees with the senior Planner on a matched row); acknowledging it
// clears the link from the drift bucket without changing any Planner-owned fact.
export async function acknowledgeProcessingDrift(sb, asanaGid) {
  const {data, error} = await sb.rpc('acknowledge_processing_drift', {p_asana_gid: asanaGid});
  if (error) throw new Error(`acknowledgeProcessingDrift: ${error.message || String(error)}`);
  return data;
}

// triage_processing_asana_record(p_record_id, p_action) -> {ok}. Reclassify an
// Asana-owned record (import_exception / asana_historical / milestone) to
// 'milestone' or 'historical', or 'dismiss' it (archive as not-a-batch). Never
// touches a planner_batch. Used for the planning-note "import exceptions".
export async function triageProcessingAsanaRecord(sb, recordId, action) {
  const {data, error} = await sb.rpc('triage_processing_asana_record', {p_record_id: recordId, p_action: action});
  if (error) throw new Error(`triageProcessingAsanaRecord: ${error.message || String(error)}`);
  return data;
}

// supersede_processing_asana_duplicate(p_asana_gid, p_canonical_record_id) ->
// {ok}. Block a duplicate Asana task's link (match_status='duplicate_blocked'),
// noting the canonical record, and archive the duplicate's own orphaned Asana
// placeholder. Provenance (raw_asana_snapshot) is preserved; the canonical link
// and any planner_batch are never touched.
export async function supersedeProcessingAsanaDuplicate(sb, asanaGid, canonicalRecordId = null) {
  const {data, error} = await sb.rpc('supersede_processing_asana_duplicate', {
    p_asana_gid: asanaGid,
    p_canonical_record_id: canonicalRecordId ?? null,
  });
  if (error) throw new Error(`supersedeProcessingAsanaDuplicate: ${error.message || String(error)}`);
  return data;
}

// ── Error classification ─────────────────────────────────────────────────────
// Deterministic validation failures carry the PROCESSING_VALIDATION prefix from
// the RPCs (bad role, invalid input, completion gate). Everything else is
// transient (network / 5xx / expired session) and worth a retry.

export function isProcessingValidationError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('PROCESSING_VALIDATION');
}

// Strip the wrapper prefix + PROCESSING_VALIDATION marker for a user-facing
// message. e.g. "markProcessingComplete: PROCESSING_VALIDATION: cannot
// complete — Processor is required" -> "cannot complete — Processor is required".
export function friendlyProcessingError(err) {
  const msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
  const idx = msg.indexOf('PROCESSING_VALIDATION:');
  if (idx >= 0) return msg.slice(idx + 'PROCESSING_VALIDATION:'.length).trim();
  return msg.replace(/^[a-zA-Z]+:\s*/, '');
}
