// Tasks v2 T6 — New Task modal.
//
// Available to every authenticated user (entire /tasks route is auth-
// gated). The v2 create RPC locks the creator-attribution fields and
// the designation/source fields server-side from auth.uid(); we never
// pass any of them client-side. The RPC also enforces title >= 3 chars,
// description non-empty, due_date present, assignee eligibility
// (role != 'inactive'), and max 5 photos per task.
//
// Idempotency: id and client_submission_id are minted once when the
// modal opens and stay stable across Save retries while the modal is
// open. The RPC's ON CONFLICT (client_submission_id) DO NOTHING returns
// the existing instance_id on retry, so a second Save after a flaky
// network never double-creates.
//
// Photos: optional, up to 5 per task. Uploaded BEFORE the RPC so the rows in
// task-request-photos exist when the SECDEF function validates the
// path prefix. If upload fails, we abort before the RPC — no orphan
// task pointing at missing bytes.
//
// One-time vs Recurring (Lane 15): the modal carries a One-time /
// Recurring toggle. One-time keeps the createOneTimeTaskInstanceV2
// path untouched. Recurring writes a task_templates row through the
// createRecurringTaskTemplateV2 wrapper (-> create_recurring_task_template
// SECDEF RPC, mig 105) and the cron generator turns it into instances.
// task_templates RLS is admin-only, so the RPC is the approved server path
// that lets non-light authenticated roles create a recurring template; it
// role-gates server-side and stamps the owner from auth.uid(). We do not
// mint task instances for recurring directly, and the modal never calls
// sb.rpc directly (the rpc lives in the wrapper). The recurrence field
// names/enums mirror RecurringTemplateModal.jsx (recurrence /
// recurrence_interval / first_due_date, drawn from RECURRENCE_OPTIONS).
// Light users never see the toggle — the recurring option is not rendered
// for them (fail closed); their only create path stays one-time.

import React from 'react';
import {todayCentralISO} from '../lib/dateUtils.js';
import {
  createOneTimeTaskInstanceV2,
  createRecurringTaskTemplateV2,
  MAX_TASK_PHOTOS_PER_TASK,
  uploadTaskCreationPhotos,
} from '../lib/tasksCenterMutationsApi.js';
import {RECURRENCE_OPTIONS} from '../lib/tasks.js';
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

// Recurrence dropdown labels — mirror RecurringTemplateModal.jsx so the
// two surfaces stay in lockstep. Derived from RECURRENCE_OPTIONS
// (src/lib/tasks.js) so the list always matches the task_templates
// .recurrence CHECK constraint.
const RECURRENCE_LABELS = {
  once: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
};
const RECURRENCES = RECURRENCE_OPTIONS.map((key) => ({
  key,
  label: RECURRENCE_LABELS[key] || key,
}));

export default function NewTaskModal({sb, profilesById, authState, isOpen, onClose, onCreated}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [dueDate, setDueDate] = React.useState(todayCentralISO());
  const [photos, setPhotos] = React.useState([]); // array of File
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  // One-time vs recurring. 'once' keeps the existing instance-create
  // path; 'recurring' writes a task_templates row instead. Light users
  // are pinned to 'once' (the toggle never renders for them).
  const [taskMode, setTaskMode] = React.useState('once');
  const [recurrence, setRecurrence] = React.useState('weekly');
  const [interval, setInterval] = React.useState(1);

  // Light users are blocked from the recurring path. Fail closed: detect
  // the role the same way the rest of the app does (authState.role ===
  // 'light', see Header.jsx / main.jsx) and, when light, never render the
  // toggle or recurrence fields. isRecurring can only be true for non-
  // light roles because setTaskMode('recurring') is unreachable without
  // the toggle. A missing/unknown role is treated as light so the toggle
  // never shows without a confirmed non-light role (defense in depth over
  // the server-side task_templates admin RLS).
  const isLight = !authState?.role || authState?.role === 'light';
  const isRecurring = !isLight && taskMode === 'recurring';

  // Stable ids minted ONCE when modal opens; persist across re-renders.
  // Reset only when the modal closes and reopens. tplId is the stable
  // template id for the recurring path (idempotent upsert on retry, same
  // contract as RecurringTemplateModal's newIdRef).
  const idsRef = React.useRef(null);
  if (isOpen && idsRef.current === null) {
    idsRef.current = {id: mintId('tic-onetime'), csid: mintId('csid'), tplId: mintId('tpl')};
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
    setTaskMode('once');
    setRecurrence('weekly');
    setInterval(1);
  }

  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []);
    const room = Math.max(0, MAX_TASK_PHOTOS_PER_TASK - photos.length);
    const next = [...photos, ...files.slice(0, room)];
    setPhotos(next);
    if (files.length > room) {
      setErr(`Tasks can have up to ${MAX_TASK_PHOTOS_PER_TASK} photos.`);
    }
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
      setErr(isRecurring ? 'First due date is required.' : 'Due date is required.');
      return;
    }
    if (isRecurring) {
      const intervalNum = Number(interval);
      if (!Number.isFinite(intervalNum) || intervalNum < 1) {
        setErr('Interval must be a number ≥ 1.');
        return;
      }
      if (!recurrence) {
        setErr('Recurrence is required.');
        return;
      }
    }
    setSaving(true);
    try {
      const ids = idsRef.current;
      if (isRecurring) {
        // Recurring path: write a task_templates row via the SECDEF RPC
        // (create_recurring_task_template, mig 105). task_templates RLS is
        // admin-only, so a non-admin direct write would fail; the RPC
        // role-gates to non-light/non-inactive callers and server-stamps the
        // owner from auth.uid(). The cron generator materializes instances
        // from the template; we do NOT mint a task instance here. dueDate
        // doubles as first_due_date — the same field the one-time path uses.
        // We omit the server-locked attribution fields (created_by is stamped
        // server-side). Photos are a one-time-only affordance; templates don't
        // take creation photos.
        const tpl = await createRecurringTaskTemplateV2(sb, {
          id: ids.tplId,
          title: title.trim(),
          description: description.trim() || null,
          assignee_profile_id: assigneeId,
          recurrence,
          recurrence_interval: Number(interval),
          first_due_date: dueDate,
          active: true,
        });
        if (onCreated) onCreated(tpl && tpl.template_id ? tpl.template_id : ids.tplId);
        reset();
        if (onClose) onClose();
        return;
      }
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
          <h2 style={{fontSize: 18, margin: 0, color: 'var(--ink)'}}>New Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          {/* One-time / Recurring toggle. Hidden ENTIRELY for Light
              users — the recurring option is never rendered for them so
              they cannot create recurring tasks (fail closed). */}
          {!isLight && (
            <div data-new-task-mode-toggle="1">
              <label style={FIELD_LABEL}>Task type</label>
              <div style={{display: 'flex', gap: 6}}>
                {[
                  {key: 'once', label: 'One-time'},
                  {key: 'recurring', label: 'Recurring'},
                ].map((opt) => {
                  const active = taskMode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      data-new-task-mode={opt.key}
                      aria-pressed={active}
                      onClick={() => setTaskMode(opt.key)}
                      style={{
                        flex: 1,
                        padding: '10px 16px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                        border: active ? '1px solid var(--brand)' : '1px solid var(--border-strong)',
                        background: 'white',
                        color: active ? 'var(--brand)' : 'var(--ink-muted)',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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

          {/* Recurrence + interval — only in recurring mode. Field names
              mirror RecurringTemplateModal (recurrence /
              recurrence_interval). */}
          {isRecurring && (
            <div style={{display: 'flex', gap: 10}}>
              <div style={{flex: 1}}>
                <label style={FIELD_LABEL} htmlFor="new-task-recurrence">
                  Recurrence
                </label>
                <select
                  id="new-task-recurrence"
                  data-new-task-field="recurrence"
                  value={recurrence}
                  onChange={(e) => setRecurrence(e.target.value)}
                  style={INPUT}
                >
                  {RECURRENCES.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{width: 110}}>
                <label style={FIELD_LABEL} htmlFor="new-task-interval">
                  Interval
                </label>
                <input
                  id="new-task-interval"
                  data-new-task-field="interval"
                  type="number"
                  min={1}
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  style={INPUT}
                />
              </div>
            </div>
          )}

          <div>
            <label style={FIELD_LABEL} htmlFor="new-task-due-date">
              {isRecurring ? 'First due date' : 'Due date'}
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

          {/* Photos are a one-time-only affordance — recurring templates
              do not carry creation photos. */}
          {!isRecurring && (
            <div>
              <label style={FIELD_LABEL}>Optional photos (up to {MAX_TASK_PHOTOS_PER_TASK})</label>
              <input
                data-new-task-field="photos"
                type="file"
                accept="image/*"
                multiple
                disabled={photos.length >= MAX_TASK_PHOTOS_PER_TASK}
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
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
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
            {saving ? 'Saving…' : isRecurring ? 'Create Template' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
