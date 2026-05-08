// Tasks v2 T9 — Recurring Template modal (admin-only).
//
// Insert or update task_templates rows via the existing admin FOR ALL
// RLS policy from mig 036. Direct .upsert / .update goes through the
// tasksCenterMutationsApi wrappers — no SECDEF RPC because the RLS
// admin gate already gates non-admin writes.
//
// Codex T9 spec:
//   - Modal fields: title, description, assignee, recurrence,
//     recurrence_interval, first_due_date, notes, active.
//   - Validate title, assignee, recurrence, interval >= 1, first_due_date.
//   - New templates default active=false unless admin enables.
//   - Edit preserves the original creator (we never write
//     created_by_profile_id on update).

import React from 'react';
import {upsertRecurringTaskTemplate, updateRecurringTaskTemplate} from '../lib/tasksCenterMutationsApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {RECURRENCE_OPTIONS} from '../lib/tasks.js';

const OVERLAY = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  zIndex: 250,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const PANEL = {
  background: 'white',
  borderRadius: 12,
  padding: 18,
  width: 'min(560px, 96vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
  fontFamily: 'inherit',
};
const FIELD_LABEL = {fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block'};
const INPUT = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const BTN_PRIMARY = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const BTN_GHOST = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
};

// Canonical recurrence labels — derived from RECURRENCE_OPTIONS
// (src/lib/tasks.js) so the dropdown always shows every value the
// task_templates.recurrence CHECK constraint accepts. Keep this map
// in sync with the enum if a future migration extends it.
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

function mintTemplateId() {
  let r;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    r = crypto.randomUUID();
  } else {
    r = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return `tpl-${r}`;
}

export default function RecurringTemplateModal({
  sb,
  isOpen,
  template, // null/undefined for "new"; row object for "edit"
  authState,
  profilesById,
  onClose,
  onSaved,
}) {
  const isEdit = !!(template && template.id);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [recurrence, setRecurrence] = React.useState('weekly');
  const [interval, setInterval] = React.useState(1);
  const [firstDueDate, setFirstDueDate] = React.useState(todayCentralISO());
  const [notes, setNotes] = React.useState('');
  const [active, setActive] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Stable id per modal-open for inserts (idempotent retry).
  const newIdRef = React.useRef(null);

  // Hydrate fields from the row (or new-mode defaults) only when the
  // modal opens or the target template changes. Profile-map changes do
  // NOT belong here — re-firing this effect mid-edit would clobber the
  // user's in-flight input. The assignee re-resolution against the
  // assignable map lives in its own effect below.
  React.useEffect(() => {
    if (!isOpen) {
      setSaving(false);
      setErr('');
      newIdRef.current = null;
      return;
    }
    if (template && template.id) {
      setTitle(template.title || '');
      setDescription(template.description || '');
      setAssigneeId(template.assignee_profile_id || '');
      setRecurrence(template.recurrence || 'weekly');
      setInterval(Number(template.recurrence_interval) || 1);
      setFirstDueDate(template.first_due_date || todayCentralISO());
      setNotes(template.notes || '');
      setActive(!!template.active);
    } else {
      setTitle('');
      setDescription('');
      setAssigneeId('');
      setRecurrence('weekly');
      setInterval(1);
      setFirstDueDate(todayCentralISO());
      setNotes('');
      setActive(false);
      newIdRef.current = mintTemplateId();
    }
  }, [isOpen, template]);

  // Edit-mode only: when the assignable map loads/changes and the
  // template's current assignee is hidden via Public Tasks availability,
  // clear the dropdown to '' so admin must pick a visible assignee.
  // Skipped for new-mode (assigneeId starts at '' and the user picks).
  React.useEffect(() => {
    if (!isOpen) return;
    if (!template || !template.id) return;
    const cur = template.assignee_profile_id || '';
    if (!cur) return;
    if (profilesById && profilesById[cur]) {
      setAssigneeId(cur);
    } else {
      setAssigneeId('');
    }
  }, [isOpen, template, profilesById]);

  if (!isOpen) return null;

  const eligibleProfiles = Object.values(profilesById || {})
    .filter((p) => p && p.id && p.full_name)
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  function close() {
    if (onClose) onClose();
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (title.trim().length < 1) {
      setErr('Title is required.');
      return;
    }
    if (!assigneeId) {
      setErr('Assignee is required.');
      return;
    }
    if (!recurrence) {
      setErr('Recurrence is required.');
      return;
    }
    const intervalNum = Number(interval);
    if (!Number.isFinite(intervalNum) || intervalNum < 1) {
      setErr('Interval must be a number ≥ 1.');
      return;
    }
    if (!firstDueDate) {
      setErr('First due date is required.');
      return;
    }
    setSaving(true);
    try {
      let result;
      if (isEdit) {
        result = await updateRecurringTaskTemplate(sb, template.id, {
          title: title.trim(),
          description: description.trim() || null,
          assignee_profile_id: assigneeId,
          recurrence,
          recurrence_interval: intervalNum,
          first_due_date: firstDueDate,
          notes: notes.trim() || null,
          active,
        });
      } else {
        const id = newIdRef.current || mintTemplateId();
        const callerId = authState && authState.user ? authState.user.id : null;
        result = await upsertRecurringTaskTemplate(sb, {
          id,
          title: title.trim(),
          description: description.trim() || null,
          assignee_profile_id: assigneeId,
          recurrence,
          recurrence_interval: intervalNum,
          first_due_date: firstDueDate,
          notes: notes.trim() || null,
          active,
          created_by_profile_id: callerId,
        });
      }
      if (onSaved) onSaved(result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div
      data-recurring-template-modal="1"
      data-recurring-template-mode={isEdit ? 'edit' : 'new'}
      style={OVERLAY}
      onClick={close}
    >
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>
            {isEdit ? 'Edit Recurring Template' : 'New Recurring Template'}
          </h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div>
            <label style={FIELD_LABEL} htmlFor="recurring-template-title">
              Title
            </label>
            <input
              id="recurring-template-title"
              data-recurring-template-field="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="recurring-template-description">
              Description
            </label>
            <textarea
              id="recurring-template-description"
              data-recurring-template-field="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{...INPUT, resize: 'vertical', minHeight: 60}}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="recurring-template-assignee">
              Assignee
            </label>
            <select
              id="recurring-template-assignee"
              data-recurring-template-field="assignee"
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

          <div style={{display: 'flex', gap: 10}}>
            <div style={{flex: 1}}>
              <label style={FIELD_LABEL} htmlFor="recurring-template-recurrence">
                Recurrence
              </label>
              <select
                id="recurring-template-recurrence"
                data-recurring-template-field="recurrence"
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
              <label style={FIELD_LABEL} htmlFor="recurring-template-interval">
                Interval
              </label>
              <input
                id="recurring-template-interval"
                data-recurring-template-field="interval"
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                style={INPUT}
              />
            </div>
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="recurring-template-first-due">
              First due date
            </label>
            <input
              id="recurring-template-first-due"
              data-recurring-template-field="first-due-date"
              type="date"
              value={firstDueDate}
              onChange={(e) => setFirstDueDate(e.target.value)}
              style={INPUT}
            />
          </div>

          <div>
            <label style={FIELD_LABEL} htmlFor="recurring-template-notes">
              Notes
            </label>
            <textarea
              id="recurring-template-notes"
              data-recurring-template-field="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              style={{...INPUT, resize: 'vertical', minHeight: 50}}
            />
          </div>

          <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151'}}>
            <input
              type="checkbox"
              data-recurring-template-field="active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active (cron will generate instances)
          </label>
        </div>

        {err && (
          <div
            data-recurring-template-error="1"
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: 8,
              marginTop: 12,
              fontSize: 13,
            }}
          >
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-recurring-template-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </div>
    </div>
  );
}
