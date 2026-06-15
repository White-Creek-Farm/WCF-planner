// Tasks v2 T7 — Complete Task modal.
//
// Wraps the v2 complete_task_instance(p_instance_id, p_completion_note,
// p_completion_photo_paths) RPC. PostgREST routes by named-arg match;
// these arg names always hit the v2 overload, never the v1 overload
// from mig 040.
//
// Required: completion note (non-empty).
// Optional photos stay capped at 5 total per task, including any
// creation photos already attached.
//
// CRITICAL — the §7 photo-storage contract: completion photos go under
// task-photos/<row.assignee_profile_id>/<instance_id>/, NOT under the
// caller's auth.uid(). Even when admin completes someone else's task,
// the path uses the row assignee. The RPC validates the prefix; getting
// it wrong server-side raises. The upload helper takes assigneeUid as
// its first arg precisely so this is hard to miss.

import React from 'react';
import {loadTaskInstancePhotos} from '../lib/tasksCenterApi.js';
import {
  completeTaskInstanceV2,
  MAX_TASK_PHOTOS_PER_TASK,
  remainingTaskPhotoSlots,
  uploadTaskCompletionPhotos,
} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPanel as PANEL,
  taskModalPrimaryButton as BTN_PRIMARY,
} from './taskModalStyles.js';

function legacyTaskPhotoCount(task) {
  const paths = new Set();
  if (task?.request_photo_path) paths.add(task.request_photo_path);
  if (task?.completion_photo_path) paths.add(task.completion_photo_path);
  return paths.size;
}

export default function CompleteTaskModal({sb, task, isOpen, onClose, onCompleted}) {
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [existingPhotoCount, setExistingPhotoCount] = React.useState(0);
  const [photoCountLoaded, setPhotoCountLoaded] = React.useState(false);
  const taskId = task?.id;
  const taskRequestPhotoPath = task?.request_photo_path;
  const taskCompletionPhotoPath = task?.completion_photo_path;

  React.useEffect(() => {
    if (!isOpen) {
      setNote('');
      setPhotos([]);
      setSaving(false);
      setErr('');
      setExistingPhotoCount(0);
      setPhotoCountLoaded(false);
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen || !taskId) return undefined;
    let cancelled = false;
    const fallbackCount = legacyTaskPhotoCount({
      request_photo_path: taskRequestPhotoPath,
      completion_photo_path: taskCompletionPhotoPath,
    });
    setExistingPhotoCount(fallbackCount);
    setPhotoCountLoaded(false);

    async function loadExistingCount() {
      if (!sb || !taskId) {
        setPhotoCountLoaded(true);
        return;
      }
      try {
        const rows = await loadTaskInstancePhotos(sb, taskId);
        if (cancelled) return;
        const paths = new Set();
        for (const row of rows || []) {
          paths.add(row?.storage_path || row?.id);
        }
        setExistingPhotoCount(paths.size > 0 ? paths.size : fallbackCount);
      } catch (_e) {
        if (!cancelled) setExistingPhotoCount(fallbackCount);
      } finally {
        if (!cancelled) setPhotoCountLoaded(true);
      }
    }

    loadExistingCount();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sb, taskId, taskRequestPhotoPath, taskCompletionPhotoPath]);

  const remainingPhotoSlots = remainingTaskPhotoSlots(existingPhotoCount);
  const availablePhotoSlots = photoCountLoaded ? Math.max(0, remainingPhotoSlots - photos.length) : 0;
  const photoLimitMessage = `Tasks can have up to ${MAX_TASK_PHOTOS_PER_TASK} photos.`;
  const photoLabel = !photoCountLoaded
    ? 'Optional completion photos (checking slots)'
    : remainingPhotoSlots <= 0
      ? `Optional completion photos (0 of ${MAX_TASK_PHOTOS_PER_TASK} slots left)`
      : `Optional completion photos (${availablePhotoSlots} of ${MAX_TASK_PHOTOS_PER_TASK} slots left)`;

  if (!isOpen || !task) return null;

  function close() {
    if (onClose) onClose();
  }

  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []);
    if (availablePhotoSlots <= 0) {
      setErr(photoLimitMessage);
      e.target.value = '';
      return;
    }
    const next = [...photos, ...files.slice(0, availablePhotoSlots)];
    setPhotos(next);
    if (files.length > availablePhotoSlots) {
      setErr(photoLimitMessage);
    }
    e.target.value = '';
  }

  function removePhoto(idx) {
    setPhotos(photos.filter((_, i) => i !== idx));
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (note.trim().length === 0) {
      setErr('Completion note is required.');
      return;
    }
    if (photos.length > remainingPhotoSlots) {
      setErr(photoLimitMessage);
      return;
    }
    setSaving(true);
    try {
      // Use the ROW's assignee_profile_id, not the caller. Per §7 the
      // path prefix must match the row assignee even when admin
      // completes someone else's task.
      const photoPaths = await uploadTaskCompletionPhotos(sb, task.assignee_profile_id, task.id, photos, {
        existingPhotoCount,
      });
      const result = await completeTaskInstanceV2(sb, task.id, note.trim(), photoPaths);
      if (onCompleted) onCompleted(task.id, result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-complete-task-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>Complete Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div data-complete-task-row={task.id} style={{fontSize: 13, color: '#374151', marginBottom: 14}}>
          <div style={{fontWeight: 600, color: '#111827'}}>{task.title}</div>
          {task.due_date && <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>Due {task.due_date}</div>}
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div>
            <label style={FIELD_LABEL} htmlFor="complete-task-note">
              Completion note (required)
            </label>
            <textarea
              id="complete-task-note"
              data-complete-task-field="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              style={{...INPUT, resize: 'vertical', minHeight: 90}}
            />
          </div>

          <div>
            <label style={FIELD_LABEL}>{photoLabel}</label>
            <input
              data-complete-task-field="photos"
              type="file"
              accept="image/*"
              multiple
              disabled={availablePhotoSlots <= 0}
              onChange={handlePhotoSelect}
              style={{fontSize: 13}}
            />
            {photos.length > 0 && (
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6}}>
                {photos.map((p, i) => (
                  <span
                    key={i}
                    data-complete-task-photo={i}
                    style={{
                      fontSize: 12,
                      padding: '4px 8px',
                      background: '#f3f4f6',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {p.name || `Photo ${i + 1}`}
                    <button
                      type="button"
                      onClick={() => removePhoto(i)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: '#6b7280',
                        padding: 0,
                        fontSize: 14,
                      }}
                      aria-label={`Remove photo ${i + 1}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {err && (
          <div data-complete-task-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-complete-task-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Completing…' : 'Mark Complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
