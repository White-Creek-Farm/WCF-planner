// To Do List client API (mig 115).
//
// The shared To Do List is a communal repository of open, unassigned work
// inside the Task Center (/tasks). All reads/writes route through the ten
// SECURITY DEFINER RPCs from supabase-migrations/115_todo_items.sql — this
// module never touches todo_items / todo_item_photos directly (deny-all RLS).
//
// Roles: light / farm_team / management / admin participate; management /
// admin manage (approve, reject, reorder, move, convert, remove).
// equipment_tech and inactive have NO To Do access — the server RPCs refuse
// them and the UI hides the toggle/routes.
//
// Photos live in the existing PRIVATE task-photos bucket under the
// 'todo/<todoId>/' prefix (mig 038 policies are bucket-scoped, so no storage
// change was needed). The 5-photo cap is TOTAL across origination plus
// completion, sharing MAX_TASK_PHOTOS_PER_TASK with tasks (mig 115 trigger is
// the DB backstop).

import {TASK_PHOTOS_BUCKET, isStorageDuplicateError} from './tasks.js';
import {compressImage} from './photoCompress.js';
import {MAX_TASK_PHOTOS_PER_TASK, uploadTaskCreationPhotos} from './tasksCenterMutationsApi.js';

// ── Sections ────────────────────────────────────────────────────────────────

export const TODO_SECTIONS = [
  {key: 'general', label: 'General'},
  {key: 'chicken_pigs', label: 'Chicken & Pigs'},
  {key: 'cattle_sheep', label: 'Cattle & Sheep'},
];

const SECTION_KEYS = TODO_SECTIONS.map((s) => s.key);

export function todoSectionLabel(key) {
  const hit = TODO_SECTIONS.find((s) => s.key === key);
  return hit ? hit.label : 'General';
}

// ── Roles ───────────────────────────────────────────────────────────────────

export const TODO_PARTICIPANT_ROLES = ['light', 'farm_team', 'management', 'admin'];
export const TODO_MANAGER_ROLES = ['management', 'admin'];

export function isTodoParticipant(role) {
  return TODO_PARTICIPANT_ROLES.includes(role || '');
}

export function isTodoManager(role) {
  return TODO_MANAGER_ROLES.includes(role || '');
}

// ── Cross-component refresh signal (fireTaskChangeEvent pattern) ────────────

export const TODO_CHANGE_EVENT = 'wcf-todo-change';

export function fireTodoChangeEvent() {
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    try {
      window.dispatchEvent(new CustomEvent(TODO_CHANGE_EVENT));
    } catch (_e) {
      /* CustomEvent unsupported */
    }
  }
}

// ── Persisted view preferences ──────────────────────────────────────────────
// localStorage (not sessionStorage): the Task Center vs To Do List mode and
// the section filter must survive across visits per the approved product
// decision. Both keys are registered in
// tests/static/localstorage_boundary_static.test.js.

export function readTasksCenterMode() {
  try {
    const v = localStorage.getItem('wcf-tasks-center-mode');
    return v === 'todo' ? 'todo' : 'center';
  } catch (_e) {
    return 'center';
  }
}

export function writeTasksCenterMode(mode) {
  try {
    localStorage.setItem('wcf-tasks-center-mode', mode === 'todo' ? 'todo' : 'center');
  } catch (_e) {
    /* persistence is best-effort */
  }
}

export function readTodoSectionFilter() {
  try {
    const v = localStorage.getItem('wcf-todo-section-filter');
    return v === 'all' || SECTION_KEYS.includes(v) ? v : 'all';
  } catch (_e) {
    return 'all';
  }
}

export function writeTodoSectionFilter(filter) {
  try {
    localStorage.setItem('wcf-todo-section-filter', filter === 'all' || SECTION_KEYS.includes(filter) ? filter : 'all');
  } catch (_e) {
    /* persistence is best-effort */
  }
}

// ── Ids and display helpers ─────────────────────────────────────────────────

export function generateTodoItemId() {
  return 'todo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// Whole days since the item was listed (clock-time delta; the rows show a
// coarse freshness cue, not a farm-calendar bucket).
export function daysSinceListed(createdAt, now = new Date()) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const ms = (now instanceof Date ? now.getTime() : Number(now)) - t;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 86400000);
}

export function formatDaysSinceListed(createdAt, now = new Date()) {
  const d = daysSinceListed(createdAt, now);
  if (d <= 0) return 'Listed today';
  if (d === 1) return 'Listed 1 day ago';
  return `Listed ${d} days ago`;
}

// ── Photos ──────────────────────────────────────────────────────────────────
// DB paths are 'task-photos/todo/<todoId>/<kind>-<slot>.jpg'. Slot numbers are
// kind-scoped and continue from the existing max so a rejected completion's
// photos never collide with a later attempt. Deterministic names + upsert
// false + duplicate-as-success keep retries idempotent (Codex T6/T7 lock).

export const MAX_TODO_PHOTOS = MAX_TASK_PHOTOS_PER_TASK;

export function buildTodoPhotoStoragePath(todoId, kind, slotIndex) {
  return `todo/${todoId}/${kind}-${slotIndex + 1}.jpg`;
}

export function buildTodoPhotoDbPath(todoId, kind, slotIndex) {
  return `${TASK_PHOTOS_BUCKET}/${buildTodoPhotoStoragePath(todoId, kind, slotIndex)}`;
}

export function stripTodoPhotoBucket(dbPath) {
  const prefix = `${TASK_PHOTOS_BUCKET}/`;
  return typeof dbPath === 'string' && dbPath.startsWith(prefix) ? dbPath.slice(prefix.length) : dbPath;
}

export function remainingTodoPhotoSlots(existingTotalCount = 0) {
  const n = Number(existingTotalCount);
  const existing = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return Math.max(0, MAX_TODO_PHOTOS - existing);
}

/**
 * Upload To Do photos to the task-photos bucket under todo/<todoId>/.
 * `kind` is 'origination' or 'completion'; slots continue from
 * existingKindCount. Throws before any upload when the 5-total cap would be
 * exceeded. Returns DB-prefixed paths in input order.
 */
export async function uploadTodoPhotos(sb, todoId, kind, blobs, {existingKindCount = 0, existingTotalCount = 0} = {}) {
  if (!Array.isArray(blobs) || blobs.length === 0) return [];
  if (kind !== 'origination' && kind !== 'completion') {
    throw new Error('uploadTodoPhotos: kind must be origination or completion');
  }
  if (existingTotalCount + blobs.length > MAX_TODO_PHOTOS) {
    throw new Error(`uploadTodoPhotos: max ${MAX_TODO_PHOTOS} photos per to do item`);
  }
  const out = [];
  for (let i = 0; i < blobs.length; i++) {
    const slot = existingKindCount + i;
    const storagePath = buildTodoPhotoStoragePath(todoId, kind, slot);
    const dbPath = buildTodoPhotoDbPath(todoId, kind, slot);
    const compressed = await compressImage(blobs[i]);
    const {error} = await sb.storage
      .from(TASK_PHOTOS_BUCKET)
      .upload(storagePath, compressed, {contentType: compressed.type || 'image/jpeg', upsert: false});
    if (error && !isStorageDuplicateError(error)) {
      throw new Error(`uploadTodoPhotos: ${error.message || String(error)}`);
    }
    out.push(dbPath);
  }
  return out;
}

export async function getTodoPhotoSignedUrl(sb, dbPath, ttlSeconds = 600) {
  const storagePath = stripTodoPhotoBucket(dbPath);
  const {data, error} = await sb.storage.from(TASK_PHOTOS_BUCKET).createSignedUrl(storagePath, ttlSeconds);
  if (error) throw new Error(`getTodoPhotoSignedUrl: ${error.message || String(error)}`);
  return data && data.signedUrl ? data.signedUrl : '';
}

/**
 * Carry a To Do item's origination photos into a Task being created by
 * convert: fetch each photo through a signed URL and re-upload through the
 * canonical task creation-photo owner (task-request-photos/<taskId>/...).
 * Returns the creation-photo DB paths for convert_todo_item. Throws on the
 * first failure so the convert modal can abort before the RPC — the To Do
 * stays open unchanged.
 */
export async function copyTodoPhotosToTaskCreation(sb, taskId, photos) {
  const origination = (photos || []).filter((p) => p && p.kind === 'origination' && p.storage_path);
  if (origination.length === 0) return [];
  const blobs = [];
  for (const photo of origination) {
    const url = await getTodoPhotoSignedUrl(sb, photo.storage_path, 120);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`copyTodoPhotosToTaskCreation: photo fetch failed (${res.status})`);
    }
    blobs.push(await res.blob());
  }
  return uploadTaskCreationPhotos(sb, taskId, blobs);
}

// ── RPC wrappers ────────────────────────────────────────────────────────────

// To Do mention picker source - narrower than the generic
// list_comment_mentionable_profiles (which includes equipment_tech): a To Do
// is only readable by participants, so only they are valid mention targets.
// Shape matches loadMentionableProfiles (array of {id, full_name}); the
// self-filter is applied by CommentsSection.
export async function listTodoMentionableProfiles(sb) {
  if (!sb) return [];
  const {data, error} = await sb.rpc('list_todo_mentionable_profiles');
  if (error) return [];
  return data || [];
}

export async function listTodoItems(sb, {includeCompleted = true} = {}) {
  const {data, error} = await sb.rpc('list_todo_items', {p_include_completed: includeCompleted});
  if (error) throw new Error(`listTodoItems: ${error.message || String(error)}`);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    completed: Array.isArray(data?.completed) ? data.completed : [],
  };
}

export async function createTodoItem(sb, {id, title, description, section, dueDate, photoPaths}) {
  const {data, error} = await sb.rpc('create_todo_item', {
    p_id: id,
    p_title: title,
    p_description: description || null,
    p_section: section,
    p_due_date: dueDate || null,
    p_photo_paths: Array.isArray(photoPaths) ? photoPaths : [],
  });
  if (error) throw new Error(`createTodoItem: ${error.message || String(error)}`);
  return data;
}

export async function updateTodoItem(sb, {id, title, description, section, dueDate, clearDueDate, photoPaths}) {
  const args = {
    p_id: id,
    p_title: title ?? null,
    p_description: description ?? null,
    p_section: section ?? null,
    p_due_date: dueDate || null,
    p_clear_due_date: !!clearDueDate,
  };
  if (Array.isArray(photoPaths) && photoPaths.length > 0) {
    args.p_photo_paths = photoPaths;
  }
  const {data, error} = await sb.rpc('update_todo_item', args);
  if (error) throw new Error(`updateTodoItem: ${error.message || String(error)}`);
  return data;
}

export async function submitTodoCompletion(sb, {id, note, photoPaths}) {
  const {data, error} = await sb.rpc('submit_todo_completion', {
    p_id: id,
    p_note: note || null,
    p_photo_paths: Array.isArray(photoPaths) ? photoPaths : [],
  });
  if (error) throw new Error(`submitTodoCompletion: ${error.message || String(error)}`);
  return data;
}

export async function approveTodoCompletion(sb, id) {
  const {data, error} = await sb.rpc('approve_todo_completion', {p_id: id});
  if (error) throw new Error(`approveTodoCompletion: ${error.message || String(error)}`);
  return data;
}

export async function rejectTodoCompletion(sb, id, note) {
  const {data, error} = await sb.rpc('reject_todo_completion', {p_id: id, p_note: note});
  if (error) throw new Error(`rejectTodoCompletion: ${error.message || String(error)}`);
  return data;
}

export async function reorderTodoItems(sb, section, orderedIds) {
  const {data, error} = await sb.rpc('reorder_todo_items', {
    p_section: section,
    p_ordered_ids: Array.isArray(orderedIds) ? orderedIds : [],
  });
  if (error) throw new Error(`reorderTodoItems: ${error.message || String(error)}`);
  return data;
}

export async function moveTodoItem(sb, id, section, position = null) {
  const {data, error} = await sb.rpc('move_todo_item', {
    p_id: id,
    p_section: section,
    p_position: position === null || position === undefined ? null : Number(position),
  });
  if (error) throw new Error(`moveTodoItem: ${error.message || String(error)}`);
  return data;
}

/**
 * Convert an open To Do into a real assigned Task. `task` is the
 * create_one_time_task_instance payload ({id, client_submission_id, title,
 * description, due_date, assignee_profile_id}); creationPhotoPaths are
 * task-request-photos DB paths already copied by
 * copyTodoPhotosToTaskCreation. Task creation + To Do conversion happen in
 * ONE transaction server-side; cancel/failure leaves the To Do open.
 */
export async function convertTodoItem(sb, {todoId, task, creationPhotoPaths}) {
  const {data, error} = await sb.rpc('convert_todo_item', {
    p_id: todoId,
    p_task: task,
    p_creation_photo_paths: Array.isArray(creationPhotoPaths) ? creationPhotoPaths : [],
  });
  if (error) throw new Error(`convertTodoItem: ${error.message || String(error)}`);
  return data;
}

export async function removeTodoItem(sb, id) {
  const {data, error} = await sb.rpc('remove_todo_item', {p_id: id});
  if (error) throw new Error(`removeTodoItem: ${error.message || String(error)}`);
  return data;
}

// ── Error classification ────────────────────────────────────────────────────
// Deterministic validation failures carry the TODO_VALIDATION prefix from the
// RPCs; everything else is transient (network/5xx) and worth a retry.

export function isTodoValidationError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('TODO_VALIDATION');
}

export function friendlyTodoError(err) {
  const msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
  const idx = msg.indexOf('TODO_VALIDATION:');
  if (idx >= 0) return msg.slice(idx + 'TODO_VALIDATION:'.length).trim();
  return msg.replace(/^[a-zA-Z_]+:\s*/, '');
}
