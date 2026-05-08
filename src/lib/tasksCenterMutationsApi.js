// v2 mutation wrappers for the Task Center (T6 + T7).
//
// Strict separation from src/lib/tasksCenterApi.js (read-only helpers)
// so the static lock for T2-T5 read-only tabs can keep asserting that
// SystemTasksTab / CompletedTab / RecurringTab / MyTasksTab don't import
// from any module containing 'tasksAdminApi' or 'tasksUserApi' — the
// /tasks mutation surfaces import from THIS module instead.
//
// All DB writes flow through the v2 SECURITY DEFINER RPCs from
// supabase-migrations/053_tasks_v2_rls_and_rpcs.sql:
//   - create_one_time_task_instance(p_instance jsonb, p_creation_photo_paths text[])
//   - complete_task_instance(p_instance_id text, p_completion_note text,
//                            p_completion_photo_paths text[])
//
// We never write to task_instances, task_instance_photos, or any other
// task_* table directly, and we never call the v1 complete_task_instance
// (text, text DEFAULT NULL) overload — PostgREST routes by named-arg
// match, so passing p_completion_note + p_completion_photo_paths always
// hits the v2 overload.

import {
  TASK_REQUEST_PHOTOS_BUCKET,
  TASK_PHOTOS_BUCKET,
  isStorageDuplicateError,
  stripTaskRequestPhotoBucket,
  stripCompletionPhotoBucket,
} from './tasks.js';
import {compressImage} from './photoCompress.js';

// ── Filename helpers ────────────────────────────────────────────────────
//
// v1 used a single deterministic filename per kind ('photo-1.jpg' for
// request photos, 'completion-1.jpg' for completion). v2 supports up to
// 5 of each, so filenames are slot-indexed. Filenames must not contain
// '/' or '\\' (RPC validation enforces this).

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
 * Upload up to 5 creation photos for a one-time task to the
 * task-request-photos bucket. Returns the array of DB-prefixed paths
 * in the same order as the input blobs (parallel array). Caller passes
 * the stable instanceId minted when the modal opens.
 *
 * Throws on the first hard error so the modal can abort the create RPC
 * and present a single failure message — partial uploads stay in
 * storage but no task row references them.
 */
export async function uploadTaskCreationPhotos(sb, instanceId, blobs) {
  if (!Array.isArray(blobs) || blobs.length === 0) return [];
  if (blobs.length > 5) {
    throw new Error('uploadTaskCreationPhotos: max 5 creation photos');
  }
  const out = [];
  for (let i = 0; i < blobs.length; i++) {
    const storagePath = buildCreationPhotoStoragePath(instanceId, i);
    const dbPath = buildCreationPhotoDbPath(instanceId, i);
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
 * Upload up to 5 completion photos for an existing task to the
 * task-photos bucket. CRITICAL: pass the row's assigneeUid
 * (`task.assignee_profile_id`), not the current caller — admin
 * completing someone else's task still writes under the assignee's
 * directory because the v2 RPC validates the path prefix against the
 * row's assignee_profile_id. Per the §7 contract.
 */
export async function uploadTaskCompletionPhotos(sb, assigneeUid, instanceId, blobs) {
  if (!Array.isArray(blobs) || blobs.length === 0) return [];
  if (blobs.length > 5) {
    throw new Error('uploadTaskCompletionPhotos: max 5 completion photos');
  }
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
