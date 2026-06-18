// Full task edit modal for admins and the original task creator.
//
// Assignee due-date edits keep using EditDueDateModal and its two-edit cap.
// This modal routes through update_task_instance_details (mig 134), which is
// narrower: admin or created_by_profile_id only, open tasks only, and optional
// append-only creation photos under task-request-photos/<taskId>/.

import React from 'react';
import {loadTaskInstancePhotos} from '../lib/tasksCenterApi.js';
import {
  MAX_TASK_PHOTOS_PER_TASK,
  remainingTaskPhotoSlots,
  updateTaskInstanceDetailsV2,
  uploadTaskCreationPhotos,
} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPanel as PANEL,
  taskModalPrimaryButton as BTN_PRIMARY,
  taskModalSubtleText as SUBTLE_TEXT,
} from './taskModalStyles.js';

function legacyTaskPhotoInfo(task) {
  const paths = new Set();
  let creation = 0;
  if (task?.request_photo_path) {
    paths.add(task.request_photo_path);
    creation = 1;
  }
  if (task?.completion_photo_path) paths.add(task.completion_photo_path);
  return {total: paths.size, creation};
}

export default function EditTaskDetailsModal({
  sb,
  task,
  isOpen,
  profilesById,
  assignableProfilesById,
  onClose,
  onUpdated,
}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [dueDate, setDueDate] = React.useState('');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [photos, setPhotos] = React.useState([]);
  const [existingPhotoCount, setExistingPhotoCount] = React.useState(0);
  const [existingCreationCount, setExistingCreationCount] = React.useState(0);
  const [photoCountLoaded, setPhotoCountLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  const taskId = task?.id;
  const taskRequestPhotoPath = task?.request_photo_path;
  const taskCompletionPhotoPath = task?.completion_photo_path;

  React.useEffect(() => {
    if (!isOpen || !task) return undefined;
    setTitle(task.title || '');
    setDescription(task.description || '');
    setDueDate(task.due_date || '');
    setAssigneeId(task.assignee_profile_id || '');
    setPhotos([]);
    setSaving(false);
    setErr('');

    let cancelled = false;
    const fallback = legacyTaskPhotoInfo({
      request_photo_path: taskRequestPhotoPath,
      completion_photo_path: taskCompletionPhotoPath,
    });
    setExistingPhotoCount(fallback.total);
    setExistingCreationCount(fallback.creation);
    setPhotoCountLoaded(false);

    async function loadCounts() {
      if (!sb || !taskId) {
        setPhotoCountLoaded(true);
        return;
      }
      try {
        const rows = await loadTaskInstancePhotos(sb, taskId);
        if (cancelled) return;
        const paths = new Set();
        let creation = 0;
        for (const row of rows || []) {
          const key = row?.storage_path || row?.id;
          if (key) paths.add(key);
          if (row?.kind === 'creation') creation += 1;
        }
        setExistingPhotoCount(paths.size > 0 ? paths.size : fallback.total);
        setExistingCreationCount(creation > 0 ? creation : fallback.creation);
      } catch (_e) {
        if (!cancelled) {
          setExistingPhotoCount(fallback.total);
          setExistingCreationCount(fallback.creation);
        }
      } finally {
        if (!cancelled) setPhotoCountLoaded(true);
      }
    }

    loadCounts();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sb, task, taskId, taskRequestPhotoPath, taskCompletionPhotoPath]);

  const profileOptions = React.useMemo(() => {
    const profileMap = profilesById || {};
    const assignableMap = assignableProfilesById || {};
    const map = new Map();
    for (const p of Object.values(assignableMap)) {
      if (p && p.id && p.full_name) map.set(p.id, p);
    }
    const current = task?.assignee_profile_id ? profileMap[task.assignee_profile_id] : null;
    if (current && current.id && current.full_name && !map.has(current.id)) {
      map.set(current.id, current);
    }
    return Array.from(map.values()).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  }, [assignableProfilesById, profilesById, task?.assignee_profile_id]);

  if (!isOpen || !task) return null;

  const remainingPhotoSlots = remainingTaskPhotoSlots(existingPhotoCount);
  const availablePhotoSlots = photoCountLoaded ? Math.max(0, remainingPhotoSlots - photos.length) : 0;
  const photoLimitMessage = `Tasks can have up to ${MAX_TASK_PHOTOS_PER_TASK} photos.`;
  const photoLabel = !photoCountLoaded
    ? 'Add request photos (checking slots)'
    : remainingPhotoSlots <= 0
      ? `Add request photos (0 of ${MAX_TASK_PHOTOS_PER_TASK} slots left)`
      : `Add request photos (${availablePhotoSlots} of ${MAX_TASK_PHOTOS_PER_TASK} slots left)`;

  function close() {
    if (onClose) onClose();
  }

  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (files.length === 0) {
      e.target.value = '';
      return;
    }
    if (availablePhotoSlots <= 0) {
      setErr(photoLimitMessage);
      e.target.value = '';
      return;
    }
    setPhotos([...photos, ...files.slice(0, availablePhotoSlots)]);
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
    if (title.trim().length < 3) {
      setErr('Title must be at least 3 characters.');
      return;
    }
    if (!dueDate) {
      setErr('Due date is required.');
      return;
    }
    if (!assigneeId) {
      setErr('Assignee is required.');
      return;
    }
    if (photos.length > remainingPhotoSlots) {
      setErr(photoLimitMessage);
      return;
    }

    setSaving(true);
    try {
      const photoPaths = await uploadTaskCreationPhotos(sb, task.id, photos, {
        existingCreationCount,
        existingPhotoCount,
      });
      const result = await updateTaskInstanceDetailsV2(sb, {
        id: task.id,
        title: title.trim(),
        description,
        dueDate,
        assigneeProfileId: assigneeId,
        creationPhotoPaths: photoPaths,
      });
      if (onUpdated) onUpdated(task.id, result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-edit-task-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8}}>
          <h2 style={{fontSize: 18, margin: 0, color: 'var(--ink)'}}>Edit Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div>
            <label style={FIELD_LABEL} htmlFor="edit-task-title">
              Title
            </label>
            <input
              id="edit-task-title"
              data-edit-task-field="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="edit-task-description">
              Description
            </label>
            <textarea
              id="edit-task-description"
              data-edit-task-field="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              style={{...INPUT, resize: 'vertical', minHeight: 90}}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="edit-task-assignee">
              Assignee
            </label>
            <select
              id="edit-task-assignee"
              data-edit-task-field="assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              style={INPUT}
            >
              <option value="">Select</option>
              {profileOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="edit-task-due-date">
              Due date
            </label>
            <input
              id="edit-task-due-date"
              data-edit-task-field="due-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL}>{photoLabel}</label>
            <input
              data-edit-task-field="photos"
              type="file"
              accept="image/*"
              multiple
              disabled={availablePhotoSlots <= 0}
              onChange={handlePhotoSelect}
              style={{fontSize: 13, fontFamily: 'inherit'}}
            />
            {photos.length > 0 && (
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6}}>
                {photos.map((p, i) => (
                  <span
                    key={i}
                    data-edit-task-photo={i}
                    style={{
                      fontSize: 12,
                      padding: '4px 8px',
                      background: 'var(--divider)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
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
                        color: 'var(--ink-muted)',
                        padding: 0,
                        fontSize: 14,
                      }}
                      aria-label={`Remove photo ${i + 1}`}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={SUBTLE_TEXT}>5 photos total per task, shared between request and completion photos.</div>
          </div>
        </div>

        {err && (
          <div data-edit-task-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-edit-task-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
