// v2 mutation wrappers for the Task Center (T6 + T7 + T8 + T9).
//
// Strict separation from src/lib/tasksCenterApi.js (read-only helpers)
// so the import-boundary static lock can keep asserting that Task
// Center tab and modal files only pull mutations from THIS module —
// never from the legacy tasksAdminApi or tasksUserApi modules.
//
// task_instances writes flow through v2 SECURITY DEFINER RPCs from
// supabase-migrations/053_tasks_v2_rls_and_rpcs.sql:
//   - create_one_time_task_instance(p_instance, p_creation_photo_paths)  [T6]
//   - complete_task_instance(p_instance_id, p_completion_note,
//                            p_completion_photo_paths)                    [T7]
//   - update_task_instance_due_date(p_instance_id, p_new_due_date)        [T8]
//   - update_task_instance_details(p_instance_id, p_title, p_description,
//                                  p_due_date, p_assignee_profile_id,
//                                  p_creation_photo_paths)                [134]
//   - assign_task_instance(p_instance_id, p_assignee_profile_id)          [T9]
//   - delete_task_instance(p_instance_id)                                 [T9]
// We never write to task_instances, task_instance_photos, or
// task_instance_due_date_edits directly — those tables either have no
// INSERT policy (audit, sidecar) or are gated by the SECDEF RPCs.
//
// task_templates and task_system_rules writes are gated at the RLS
// layer by an admin FOR ALL policy, so the wrappers below
// (upsert/update/delete recurring template; updateSystemTaskRule)
// route through plain .from(...).upsert/.update/.delete with column
// whitelists. The whitelists are intentional: id / generator_kind /
// name / description on task_system_rules stay out of the update
// path because the Edge Function dispatcher recognizes only the four
// built-in generator_kinds, and renaming/rekeying a rule would
// silently break generation.
//
// We never call the v1 complete_task_instance(text, text DEFAULT NULL)
// overload — PostgREST routes by named-arg match, so the v2 named-arg
// shape (p_completion_note + p_completion_photo_paths) always hits the
// v2 RPC. We also never call generate_system_task_instance from the
// frontend — that stays owned by the cron Edge Function.

import {
  TASK_REQUEST_PHOTOS_BUCKET,
  TASK_PHOTOS_BUCKET,
  isStorageDuplicateError,
  stripTaskRequestPhotoBucket,
  stripCompletionPhotoBucket,
} from './tasks.js';
import {compressImage} from './photoCompress.js';

export const MAX_TASK_PHOTOS_PER_TASK = 5;

function normalizedPhotoCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function remainingTaskPhotoSlots(existingPhotoCount = 0) {
  return Math.max(0, MAX_TASK_PHOTOS_PER_TASK - normalizedPhotoCount(existingPhotoCount));
}

export function assertTaskPhotoLimit(existingPhotoCount, newPhotoCount, helperName = 'task photos') {
  const existing = normalizedPhotoCount(existingPhotoCount);
  const incoming = normalizedPhotoCount(newPhotoCount);
  if (existing + incoming > MAX_TASK_PHOTOS_PER_TASK) {
    throw new Error(`${helperName}: max ${MAX_TASK_PHOTOS_PER_TASK} photos per task`);
  }
}

// ── Filename helpers ────────────────────────────────────────────────────
//
// v1 used a single deterministic filename per kind ('photo-1.jpg' for
// request photos, 'completion-1.jpg' for completion). v2 keeps slot-
// indexed filenames while the task as a whole is capped at 5 photos.
// Filenames must not contain '/' or '\\' (RPC validation enforces this).

export function buildCreationPhotoFilename(slotIndex) {
  // 1-indexed for human readability of stored paths.
  return `creation-${slotIndex + 1}.jpg`;
}

export function buildCompletionPhotoFilename(slotIndex) {
  return `completion-${slotIndex + 1}.jpg`;
}

export function buildCreationPhotoStoragePath(instanceId, slotIndex) {
  if (typeof instanceId !== 'string' || !instanceId) {
    throw new Error('buildCreationPhotoStoragePath: instanceId required');
  }
  return `${instanceId}/${buildCreationPhotoFilename(slotIndex)}`;
}

export function buildCreationPhotoDbPath(instanceId, slotIndex) {
  return `${TASK_REQUEST_PHOTOS_BUCKET}/${buildCreationPhotoStoragePath(instanceId, slotIndex)}`;
}

export function buildCompletionPhotoStoragePathV2(assigneeUid, instanceId, slotIndex) {
  if (typeof assigneeUid !== 'string' || !assigneeUid) {
    throw new Error('buildCompletionPhotoStoragePathV2: assigneeUid required');
  }
  if (typeof instanceId !== 'string' || !instanceId) {
    throw new Error('buildCompletionPhotoStoragePathV2: instanceId required');
  }
  return `${assigneeUid}/${instanceId}/${buildCompletionPhotoFilename(slotIndex)}`;
}

export function buildCompletionPhotoDbPathV2(assigneeUid, instanceId, slotIndex) {
  return `${TASK_PHOTOS_BUCKET}/${buildCompletionPhotoStoragePathV2(assigneeUid, instanceId, slotIndex)}`;
}

// ── Upload helpers ──────────────────────────────────────────────────────
//
// Both buckets are append-only (no UPDATE policy). Codex T6/T7 lock
// keeps `upsert:false` and treats duplicate / 409 / "already exists" as
// idempotent success — the bytes that landed first stay authoritative,
// and the retry call returns the canonical dbPath as if it had been the
// first attempt. Caller mints stable instanceIds across Save retries
// while the modal is open so retry hits the same path.

async function uploadOnePhoto(sb, bucket, storagePath, dbPath, blobOrFile, helperName) {
  if (!blobOrFile) {
    throw new Error(`${helperName}: blobOrFile required`);
  }
  const compressed = await compressImage(blobOrFile);
  const {error} = await sb.storage
    .from(bucket)
    .upload(storagePath, compressed, {contentType: compressed.type || 'image/jpeg', upsert: false});
  if (error && !isStorageDuplicateError(error)) {
    throw new Error(`${helperName}: ${error.message || String(error)}`);
  }
  return dbPath;
}

/**
 * Upload up to 5 total task photos for a one-time task to the
 * task-request-photos bucket. Returns the array of DB-prefixed paths
 * in the same order as the input blobs (parallel array). Caller passes
 * the stable instanceId minted when the modal opens.
 *
 * Throws on the first hard error so the modal can abort the create RPC
 * and present a single failure message — partial uploads stay in
 * storage but no task row references them.
 */
export async function uploadTaskCreationPhotos(
  sb,
  instanceId,
  blobs,
  {existingCreationCount = 0, existingPhotoCount = 0} = {},
) {
  if (!Array.isArray(blobs) || blobs.length === 0) return [];
  const creationOffset = normalizedPhotoCount(existingCreationCount);
  assertTaskPhotoLimit(existingPhotoCount, blobs.length, 'uploadTaskCreationPhotos');
  const out = [];
  for (let i = 0; i < blobs.length; i++) {
    const slotIndex = creationOffset + i;
    const storagePath = buildCreationPhotoStoragePath(instanceId, slotIndex);
    const dbPath = buildCreationPhotoDbPath(instanceId, slotIndex);
    const result = await uploadOnePhoto(
      sb,
      TASK_REQUEST_PHOTOS_BUCKET,
      storagePath,
      dbPath,
      blobs[i],
      'uploadTaskCreationPhotos',
    );
    out.push(result);
  }
  return out;
}

/**
 * Upload completion photos for an existing task to the
 * task-photos bucket. CRITICAL: pass the row's assigneeUid
 * (`task.assignee_profile_id`), not the current caller — admin
 * completing someone else's task still writes under the assignee's
 * directory because the v2 RPC validates the path prefix against the
 * row's assignee_profile_id. Per the §7 contract.
 */
export async function uploadTaskCompletionPhotos(sb, assigneeUid, instanceId, blobs, {existingPhotoCount = 0} = {}) {
  if (!Array.isArray(blobs) || blobs.length === 0) return [];
  assertTaskPhotoLimit(existingPhotoCount, blobs.length, 'uploadTaskCompletionPhotos');
  const out = [];
  for (let i = 0; i < blobs.length; i++) {
    const storagePath = buildCompletionPhotoStoragePathV2(assigneeUid, instanceId, i);
    const dbPath = buildCompletionPhotoDbPathV2(assigneeUid, instanceId, i);
    const result = await uploadOnePhoto(
      sb,
      TASK_PHOTOS_BUCKET,
      storagePath,
      dbPath,
      blobs[i],
      'uploadTaskCompletionPhotos',
    );
    out.push(result);
  }
  return out;
}

// ── RPC wrappers ────────────────────────────────────────────────────────

/**
 * Create a one-time task via the v2 SECDEF RPC. The server locks
 * created_by_profile_id + created_by_display_name from auth.uid() —
 * never pass them in the payload. designation, from_recurring_template,
 * and from_system_rule_id are also server-controlled and must stay
 * out of the payload.
 *
 * payload shape (jsonb): {
 *   id: stable text id (mint when modal opens),
 *   client_submission_id: stable uuid (mint when modal opens),
 *   title: text (>=3 chars),
 *   description: text (non-empty),
 *   due_date: 'YYYY-MM-DD',
 *   assignee_profile_id: uuid string
 * }
 *
 * creationPhotoDbPaths: array of bucket-prefixed DB paths from
 * uploadTaskCreationPhotos(); pass [] for no photos.
 *
 * Returns the RPC's jsonb result {ok, idempotent_replay, instance_id, ...}.
 */
export async function createOneTimeTaskInstanceV2(sb, payload, creationPhotoDbPaths) {
  const {data, error} = await sb.rpc('create_one_time_task_instance', {
    p_instance: payload,
    p_creation_photo_paths: Array.isArray(creationPhotoDbPaths) ? creationPhotoDbPaths : [],
  });
  if (error) {
    throw new Error(`createOneTimeTaskInstanceV2: ${error.message || String(error)}`);
  }
  return data;
}

/**
 * Complete a task via the v2 SECDEF RPC. PostgREST routes by named-arg
 * match: passing p_completion_note + p_completion_photo_paths always
 * hits the v2 overload (mig 053), never the v1 overload from mig 040.
 *
 * The RPC validates the completion_note is non-empty and that every
 * photo path matches 'task-photos/<row.assignee_profile_id>/<id>/'
 * with a non-empty filename and no inner separators.
 *
 * Returns the RPC's jsonb result.
 */
export async function completeTaskInstanceV2(sb, instanceId, completionNote, completionPhotoDbPaths) {
  const {data, error} = await sb.rpc('complete_task_instance', {
    p_instance_id: instanceId,
    p_completion_note: completionNote,
    p_completion_photo_paths: Array.isArray(completionPhotoDbPaths) ? completionPhotoDbPaths : [],
  });
  if (error) {
    throw new Error(`completeTaskInstanceV2: ${error.message || String(error)}`);
  }
  return data;
}

// ── Signed-URL helpers (lightbox) ───────────────────────────────────────
//
// Lazy: callers fetch on click, never eagerly per row. We re-implement
// thin wrappers here (rather than importing tasksUserApi) so the
// /tasks mutation/lightbox surfaces have no transitive dependency on
// the legacy v1 completion wrappers in tasksUserApi.

export async function getCenterRequestPhotoSignedUrl(sb, dbPath, ttlSeconds = 600) {
  const storagePath = stripTaskRequestPhotoBucket(dbPath);
  if (!storagePath) return null;
  const {data, error} = await sb.storage.from(TASK_REQUEST_PHOTOS_BUCKET).createSignedUrl(storagePath, ttlSeconds);
  if (error) {
    throw new Error(`getCenterRequestPhotoSignedUrl: ${error.message || String(error)}`);
  }
  return data && data.signedUrl ? data.signedUrl : null;
}

export async function getCenterCompletionPhotoSignedUrl(sb, dbPath, ttlSeconds = 600) {
  const storagePath = stripCompletionPhotoBucket(dbPath);
  if (!storagePath) return null;
  const {data, error} = await sb.storage.from(TASK_PHOTOS_BUCKET).createSignedUrl(storagePath, ttlSeconds);
  if (error) {
    throw new Error(`getCenterCompletionPhotoSignedUrl: ${error.message || String(error)}`);
  }
  return data && data.signedUrl ? data.signedUrl : null;
}

// ── T8: due-date edit ──────────────────────────────────────────────────
//
// Wraps update_task_instance_due_date (mig 053). The RPC handles all
// auth and role logic server-side: admin unlimited; regular user must
// be the assignee and is capped at 2 edits via due_date_edit_count;
// completed tasks reject; same-date writes are no-ops; audit row is
// inserted into task_instance_due_date_edits with a 'tdde-' + uuid id.
// We never write that audit table directly — there is no INSERT policy.
export async function updateTaskInstanceDueDateV2(sb, instanceId, newDueDate) {
  const {data, error} = await sb.rpc('update_task_instance_due_date', {
    p_instance_id: instanceId,
    p_new_due_date: newDueDate,
  });
  if (error) {
    throw new Error(`updateTaskInstanceDueDateV2: ${error.message || String(error)}`);
  }
  return data;
}

/**
 * Edit an OPEN task's primary details via mig 134. Admins can edit any open
 * task; a regular caller can edit only tasks they created. Creation photos are
 * appended to task_instance_photos by the RPC and, when needed, mirrored into
 * request_photo_path for legacy photo-presence indicators.
 */
export async function updateTaskInstanceDetailsV2(
  sb,
  {id, title, description, dueDate, assigneeProfileId, creationPhotoPaths},
) {
  const {data, error} = await sb.rpc('update_task_instance_details', {
    p_instance_id: id,
    p_title: title ?? null,
    p_description: description ?? null,
    p_due_date: dueDate || null,
    p_assignee_profile_id: assigneeProfileId || null,
    p_creation_photo_paths: Array.isArray(creationPhotoPaths) ? creationPhotoPaths : [],
  });
  if (error) {
    throw new Error(`updateTaskInstanceDetailsV2: ${error.message || String(error)}`);
  }
  return data;
}

// ── T9: assign + delete (admin or rule-restricted) ─────────────────────
//
// assignTaskInstanceV2: admin-only at the RPC layer; rejects completed
// tasks and verifies the new assignee is eligible (role != 'inactive').
export async function assignTaskInstanceV2(sb, instanceId, newAssigneeProfileId) {
  const {data, error} = await sb.rpc('assign_task_instance', {
    p_instance_id: instanceId,
    p_assignee_profile_id: newAssigneeProfileId,
  });
  if (error) {
    throw new Error(`assignTaskInstanceV2: ${error.message || String(error)}`);
  }
  return data;
}

// deleteTaskInstanceV2: admin can delete any open task; regular user
// can delete only open tasks where created_by_profile_id AND
// assignee_profile_id both equal the caller (RPC enforces). Completed
// tasks reject for everyone.
export async function deleteTaskInstanceV2(sb, instanceId) {
  const {data, error} = await sb.rpc('delete_task_instance', {
    p_instance_id: instanceId,
  });
  if (error) {
    throw new Error(`deleteTaskInstanceV2: ${error.message || String(error)}`);
  }
  return data;
}

// ── T9: recurring template admin CRUD ──────────────────────────────────
//
// Direct task_templates writes via the existing admin FOR ALL RLS
// policy from mig 036. We do NOT route these through a SECDEF RPC
// because the RLS admin gate is sufficient and there's no per-row
// non-admin write path to model. A non-admin caller's INSERT/UPDATE/
// DELETE attempt is blocked at the RLS layer.
//
// Component callers must pre-validate title/assignee/recurrence/
// interval/first_due_date; the DB CHECK constraints catch malformed
// values but the modal should fail fast for UX. The wrapper itself
// stays thin so test-time behavior matches prod-time behavior.

const TEMPLATE_INSERT_COLUMNS = [
  'id',
  'title',
  'description',
  'assignee_profile_id',
  'recurrence',
  'recurrence_interval',
  'first_due_date',
  'notes',
  'active',
  'created_by_profile_id',
];

const TEMPLATE_UPDATE_COLUMNS = [
  'title',
  'description',
  'assignee_profile_id',
  'recurrence',
  'recurrence_interval',
  'first_due_date',
  'notes',
  'active',
];

function pickColumns(payload, allowed) {
  const out = {};
  for (const k of allowed) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, k)) {
      out[k] = payload[k];
    }
  }
  return out;
}

/**
 * Insert or update a recurring task_templates row. Caller mints the id
 * and passes it on the payload (keeps the modal idempotent across
 * Save retries — same id means upsert hits the same row).
 *
 * Whitelisted columns only: id/title/description/assignee_profile_id/
 * recurrence/recurrence_interval/first_due_date/notes/active +
 * created_by_profile_id on insert. This filter prevents a future
 * accidental field leak (e.g., a stray boolean flag from an admin
 * editor) from writing a column the contract doesn't cover.
 */
export async function upsertRecurringTaskTemplate(sb, payload) {
  if (!payload || !payload.id) {
    throw new Error('upsertRecurringTaskTemplate: id required');
  }
  const filtered = pickColumns(payload, TEMPLATE_INSERT_COLUMNS);
  const {data, error} = await sb.from('task_templates').upsert(filtered, {onConflict: 'id'}).select().single();
  if (error) {
    throw new Error(`upsertRecurringTaskTemplate: ${error.message || String(error)}`);
  }
  return data;
}

/**
 * Create a recurring template from the Task Center New Task modal for a
 * NON-ADMIN authenticated user. task_templates RLS is admin-only, so a
 * direct write (upsertRecurringTaskTemplate above) only works for admins.
 * This routes through the create_recurring_task_template SECURITY DEFINER
 * RPC (mig 105), which role-gates to non-light/non-inactive callers and
 * server-stamps created_by_profile_id from auth.uid(). Admin and non-admin
 * both use this path from New Task; the admin RecurringTemplateModal keeps
 * the direct upsert/update/delete wrappers for full template management.
 *
 * Caller mints the id (idempotent on retry; the RPC ON CONFLICT DO NOTHING
 * returns the existing template id). The RPC ignores any created_by in the
 * payload — owner identity is the authenticated caller only.
 */
export async function createRecurringTaskTemplateV2(sb, template) {
  if (!template || !template.id) {
    throw new Error('createRecurringTaskTemplateV2: id required');
  }
  const {data, error} = await sb.rpc('create_recurring_task_template', {p_template: template});
  if (error) {
    throw new Error(`createRecurringTaskTemplateV2: ${error.message || String(error)}`);
  }
  return data;
}

/**
 * Update specific columns on an existing recurring template. Filter to
 * the same whitelist as upsert (minus id/created_by). Used by the Edit
 * modal so we don't accidentally clobber the original creator id.
 */
export async function updateRecurringTaskTemplate(sb, id, patch) {
  if (!id) throw new Error('updateRecurringTaskTemplate: id required');
  const filtered = pickColumns(patch, TEMPLATE_UPDATE_COLUMNS);
  const {data, error} = await sb.from('task_templates').update(filtered).eq('id', id).select().single();
  if (error) {
    throw new Error(`updateRecurringTaskTemplate: ${error.message || String(error)}`);
  }
  return data;
}

export async function deleteRecurringTaskTemplate(sb, id) {
  if (!id) throw new Error('deleteRecurringTaskTemplate: id required');
  const {error} = await sb.from('task_templates').delete().eq('id', id);
  if (error) {
    throw new Error(`deleteRecurringTaskTemplate: ${error.message || String(error)}`);
  }
  // Existing instances stay alive via mig 050's ON DELETE SET NULL —
  // they appear in the Recurring tab orphan group thereafter.
  return {ok: true, id};
}

// ── T9: system rule admin update (built-in rules only, narrow columns) ─
//
// Direct task_system_rules .update via the existing admin FOR ALL RLS
// policy from mig 052. We expose ONLY the three columns Codex's T9
// brief permits: assignee_profile_id, lead_time_days, active. id /
// generator_kind / name / description stay read-only — the Edge
// Function dispatcher recognizes only the four built-in generator
// kinds, so renaming or rekeying a rule would silently break
// generation. No CREATE / DELETE on system rules in this lane.
const SYSTEM_RULE_UPDATE_COLUMNS = ['assignee_profile_id', 'lead_time_days', 'active'];

export async function updateSystemTaskRule(sb, ruleId, patch) {
  if (!ruleId) throw new Error('updateSystemTaskRule: ruleId required');
  const filtered = pickColumns(patch, SYSTEM_RULE_UPDATE_COLUMNS);
  const {data, error} = await sb
    .from('task_system_rules')
    .update({...filtered, updated_at: new Date().toISOString()})
    .eq('id', ruleId)
    .select()
    .single();
  if (error) {
    throw new Error(`updateSystemTaskRule: ${error.message || String(error)}`);
  }
  return data;
}

// ── Lightweight cross-component refresh signal ──────────────────────────
//
// After a successful create or complete, fire this event so other
// surfaces (Header badge, sibling tab data) can reload without waiting
// for window focus / view change. Listeners must always tolerate the
// event firing on a tab they don't own — soft-fail any reload error.

export const TASK_CHANGE_EVENT = 'wcf-task-change';

export function fireTaskChangeEvent() {
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    try {
      window.dispatchEvent(new CustomEvent(TASK_CHANGE_EVENT));
    } catch (_e) {
      /* CustomEvent unsupported in some test envs; swallow */
    }
  }
}
