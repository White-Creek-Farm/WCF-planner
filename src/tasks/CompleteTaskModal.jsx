// Tasks v2 T7 — Complete Task modal.
//
// Wraps the v2 complete_task_instance(p_instance_id, p_completion_note,
// p_completion_photo_paths) RPC. PostgREST routes by named-arg match;
// these arg names always hit the v2 overload, never the v1 overload
// from mig 040.
//
// Required: completion note (non-empty).
// Optional: up to 5 completion photos.
//
// CRITICAL — the §7 photo-storage contract: completion photos go under
// task-photos/<row.assignee_profile_id>/<instance_id>/, NOT under the
// caller's auth.uid(). Even when admin completes someone else's task,
// the path uses the row assignee. The RPC validates the prefix; getting
// it wrong server-side raises. The upload helper takes assigneeUid as
// its first arg precisely so this is hard to miss.

import React from 'react';
import {completeTaskInstanceV2, uploadTaskCompletionPhotos} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPanel as PANEL,
  taskModalPrimaryButton as BTN_PRIMARY,
} from './taskModalStyles.js';

export default function CompleteTaskModal({sb, task, isOpen, onClose, onCompleted, authState}) {
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) {
      setNote('');
      setPhotos([]);
      setSaving(false);
      setErr('');
    }
  }, [isOpen]);

  if (!isOpen || !task) return null;

  function close() {
    if (onClose) onClose();
  }

  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []);
    const next = [...photos, ...files].slice(0, 5);
    setPhotos(next);
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
    setSaving(true);
    try {
      // Use the ROW's assignee_profile_id, not the caller. Per §7 the
      // path prefix must match the row assignee even when admin
      // completes someone else's task.
      const photoPaths = await uploadTaskCompletionPhotos(sb, task.assignee_profile_id, task.id, photos);
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
            <label style={FIELD_LABEL}>Optional completion photos (up to 5)</label>
            <input
              data-complete-task-field="photos"
              type="file"
              accept="image/*"
              multiple
              disabled={photos.length >= 5}
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
