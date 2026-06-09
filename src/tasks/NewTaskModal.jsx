// Tasks v2 T6 — New Task modal.
//
// Available to every authenticated user (entire /tasks route is auth-
// gated). The v2 create RPC locks the creator-attribution fields and
// the designation/source fields server-side from auth.uid(); we never
// pass any of them client-side. The RPC also enforces title >= 3 chars,
// description non-empty, due_date present, assignee eligibility
// (role != 'inactive'), and max 5 creation photos.
//
// Idempotency: id and client_submission_id are minted once when the
// modal opens and stay stable across Save retries while the modal is
// open. The RPC's ON CONFLICT (client_submission_id) DO NOTHING returns
// the existing instance_id on retry, so a second Save after a flaky
// network never double-creates.
//
// Photos: optional, up to 5. Uploaded BEFORE the RPC so the rows in
// task-request-photos exist when the SECDEF function validates the
// path prefix. If upload fails, we abort before the RPC — no orphan
// task pointing at missing bytes.

import React from 'react';
import {todayCentralISO} from '../lib/dateUtils.js';
import {createOneTimeTaskInstanceV2, uploadTaskCreationPhotos} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPanel as PANEL,
  taskModalPrimaryButton as BTN_PRIMARY,
} from './taskModalStyles.js';

// Stable id minted client-side. Crypto.randomUUID is widely available
// in modern browsers; we fall back to a Math.random shape only if not.
function mintId(prefix) {
  let r;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    r = crypto.randomUUID();
  } else {
    r = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return `${prefix}-${r}`;
}

export default function NewTaskModal({sb, profilesById, isOpen, onClose, onCreated}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [dueDate, setDueDate] = React.useState(todayCentralISO());
  const [photos, setPhotos] = React.useState([]); // array of File
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Stable ids minted ONCE when modal opens; persist across re-renders.
  // Reset only when the modal closes and reopens.
  const idsRef = React.useRef(null);
  if (isOpen && idsRef.current === null) {
    idsRef.current = {id: mintId('tic-onetime'), csid: mintId('csid')};
  }
  if (!isOpen && idsRef.current !== null) {
    idsRef.current = null;
  }

  const eligibleProfiles = React.useMemo(() => {
    return Object.values(profilesById || {})
      .filter((p) => p && p.id && p.full_name)
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  }, [profilesById]);

  if (!isOpen) return null;

  function reset() {
    setTitle('');
    setDescription('');
    setAssigneeId('');
    setDueDate(todayCentralISO());
    setPhotos([]);
    setSaving(false);
    setErr('');
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

  function close() {
    reset();
    if (onClose) onClose();
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (title.trim().length < 3) {
      setErr('Title must be at least 3 characters.');
      return;
    }
    if (description.trim().length === 0) {
      setErr('Description is required.');
      return;
    }
    if (!assigneeId) {
      setErr('Assignee is required.');
      return;
    }
    if (!dueDate) {
      setErr('Due date is required.');
      return;
    }
    setSaving(true);
    try {
      const ids = idsRef.current;
      const photoPaths = await uploadTaskCreationPhotos(sb, ids.id, photos);
      const result = await createOneTimeTaskInstanceV2(
        sb,
        {
          id: ids.id,
          client_submission_id: ids.csid,
          title: title.trim(),
          description: description.trim(),
          due_date: dueDate,
          assignee_profile_id: assigneeId,
        },
        photoPaths,
      );
      const newId = result && result.instance_id ? result.instance_id : ids.id;
      if (onCreated) onCreated(newId);
      reset();
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-new-task-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>New Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div>
            <label style={FIELD_LABEL} htmlFor="new-task-title">
              Title (min 3 chars)
            </label>
            <input
              id="new-task-title"
              data-new-task-field="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="new-task-description">
              Description
            </label>
            <textarea
              id="new-task-description"
              data-new-task-field="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{...INPUT, resize: 'vertical', minHeight: 70}}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="new-task-assignee">
              Assignee
            </label>
            <select
              id="new-task-assignee"
              data-new-task-field="assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              style={INPUT}
            >
              <option value="">— Select —</option>
              {eligibleProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="new-task-due-date">
              Due date
            </label>
            <input
              id="new-task-due-date"
              data-new-task-field="due-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL}>Optional photos (up to 5)</label>
            <input
              data-new-task-field="photos"
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
                    data-new-task-photo={i}
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
          <div data-new-task-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-new-task-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Saving…' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
