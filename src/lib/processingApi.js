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
// effective_status (derived server-side in America/Chicago), completed_at,
// processor, number_processed, customer, source_kind, source_id, source_phase,
// trip_ordinal, archived, source_removed_at, fields, historical_snapshot,
// subtask_total, subtask_done, live_count, search_text, and `source` — the
// normalized LIVE planner projection (mig 176) the UI renders instead of any
// stale Processing snapshot.
export async function listProcessingRecords(sb, {year = null, program = null, includeArchived = false} = {}) {
  const {data, error} = await sb.rpc('list_processing_records', {
    p_year: Number.isFinite(year) ? year : year == null ? null : Number(year) || null,
    p_program: program ?? null,
    p_include_archived: !!includeArchived,
  });
  if (error) throw new Error(`listProcessingRecords: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

// get_processing_record(p_id) -> the record columns (+ effective_status,
// `source` live projection, live_count, and `animals` per-animal detail for
// cattle/sheep tags/ages/weights and pig linked weigh-in weights) + subtasks[]
// + attachments[] + completion_blockers[] (text; server-authoritative).
// Returns null when the id resolves to nothing.
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
// only. kind is 'processor' | 'customer'. Options are stable objects
// {id, label, active} (mig 175): send the full list back — existing ids may be
// renamed (same id, new label) or deactivated (active:false) but NEVER dropped
// (the server refuses deletion); entries without an id are added as new
// options. Never rejects or rewrites stored record values.
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
// NOTE (planner-integration lane): the generic set_processing_field wrapper was
// removed with the configurable Field-template surface. Processing fields are
// fixed; source facts are planner-owned and read-only here. The server RPC
// remains deployed for backward compatibility but has no client caller.

// set_processing_processor(p_id, p_processor). Editable on any record (blank
// clears it, stored as NULL).
export async function setProcessingProcessor(sb, id, processor) {
  const {data, error} = await sb.rpc('set_processing_processor', {p_id: id, p_processor: processor ?? null});
  if (error) throw new Error(`setProcessingProcessor: ${error.message || String(error)}`);
  return data;
}

// set_processing_customer(p_id, p_customer) — Broiler-only (server rejects other
// programs). p_customer must be a json array; the UI stores zero-or-one value
// ([] or [value]) through the single Customer select.
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

// apply_current_template(p_record_id). Idempotent merge-by-stable-step-id
// (mig 177): adds new non-removed template steps, applies renames + current
// assignments to OPEN linked steps only; never duplicates, reopens completed
// work, or touches manual steps / removed-step tombstones.
export async function applyCurrentTemplate(sb, recordId) {
  const {data, error} = await sb.rpc('apply_current_template', {p_record_id: recordId});
  if (error) throw new Error(`applyCurrentTemplate: ${error.message || String(error)}`);
  return data;
}

// preview_latest_template(p_record_id) -> {template_version, additions[],
// renames[], assignment_changes[], removed_blocked[], up_to_date}. Read-only
// diff of the active template against the record's linked subtasks.
export async function previewLatestTemplate(sb, recordId) {
  const {data, error} = await sb.rpc('preview_latest_template', {p_record_id: recordId});
  if (error) throw new Error(`previewLatestTemplate: ${error.message || String(error)}`);
  return data || {};
}

// The caller-scoped RPC list_my_processing_subtasks (mig 175/178) is
// intentionally NOT wrapped for client use: Processing Center checklist steps
// are no longer surfaced in the Task Center (Build Queue item 5). The RPC
// remains deployed. Assigned processing work is worked from its Processing
// record, reached through the Processing Center or the
// processing_subtask_assigned notification deep link.

// ── Admin-only ───────────────────────────────────────────────────────────────

// upsert_processing_template(p_program, p_fields, p_checklist) — admin only.
// Creates a new active version superseding the prior one. Checklist steps
// carry STABLE ids across versions (mig 177): send each existing step with its
// id; new steps without an id are minted one server-side. fields=null keeps
// the active version's fields verbatim (the configurable Fields editor is
// retired — the client only edits checklists now).
export async function upsertProcessingTemplate(sb, {program, fields = null, checklist = []} = {}) {
  const {data, error} = await sb.rpc('upsert_processing_template', {
    p_program: program,
    p_fields: fields ?? null,
    p_checklist: checklist ?? [],
  });
  if (error) throw new Error(`upsertProcessingTemplate: ${error.message || String(error)}`);
  return data;
}

// NOTE (UI-simplification lane): the client wrappers for the one-time Asana
// import/maintenance surface (the Edge-function invoker, the mig-157
// reconciliation workbench RPCs, hard delete, the sync-enabled flag, and the
// parent-record assignee) were removed with their UI. The server-side RPCs and
// Edge actions remain intact for gated operational use outside the app.

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
