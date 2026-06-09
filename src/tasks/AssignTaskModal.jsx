// Tasks v2 T9 — Assign Task modal. Admin-only.
//
// Wraps assign_task_instance (mig 053). The RPC is admin-only;
// rejects completed tasks; verifies the new assignee is eligible
// (role != 'inactive'). The eligible-profiles map already filters
// inactives, so the dropdown is the canonical source of valid ids.

import React from 'react';
import {assignTaskInstanceV2} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalPrimaryButton as BTN_PRIMARY,
  taskModalSmallPanel as PANEL,
} from './taskModalStyles.js';

export default function AssignTaskModal({sb, task, isOpen, profilesById, onClose, onAssigned}) {
  const [target, setTarget] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  // Reset modal state when it opens / the row changes. Profile map
  // updates do NOT belong here — re-firing would clobber the admin's
  // in-flight selection. The assignee re-resolution against the
  // assignable map lives in its own effect below.
  React.useEffect(() => {
    if (!isOpen) {
      setTarget('');
      setSaving(false);
      setErr('');
    } else if (task) {
      setTarget(task.assignee_profile_id || '');
    }
  }, [isOpen, task]);

  // When the assignable map loads/changes and the row's current
  // assignee is hidden via Public Tasks availability, clear the
  // dropdown to '' so admin must pick a visible assignee.
  React.useEffect(() => {
    if (!isOpen || !task) return;
    const cur = task.assignee_profile_id || '';
    if (!cur) return;
    if (profilesById && profilesById[cur]) {
      setTarget(cur);
    } else {
      setTarget('');
    }
  }, [isOpen, task, profilesById]);

  if (!isOpen || !task) return null;

  const eligibleProfiles = Object.values(profilesById || {})
    .filter((p) => p && p.id && p.full_name)
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  function close() {
    if (onClose) onClose();
  }

  async function save() {
    if (saving) return;
    setErr('');
    if (!target) {
      setErr('Choose a new assignee.');
      return;
    }
    if (target === task.assignee_profile_id) {
      // No-op; close cleanly so admin doesn't get stuck.
      if (onClose) onClose();
      return;
    }
    setSaving(true);
    try {
      const result = await assignTaskInstanceV2(sb, task.id, target);
      if (onAssigned) onAssigned(task.id, result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-assign-task-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>Reassign Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{fontSize: 13, color: '#374151', marginBottom: 14}}>
          <div style={{fontWeight: 600, color: '#111827'}}>{task.title}</div>
        </div>

        <label style={FIELD_LABEL} htmlFor="assign-task-target">
          New assignee
        </label>
        <select
          id="assign-task-target"
          data-assign-task-field="target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={INPUT}
        >
          <option value="">— Select —</option>
          {eligibleProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>

        {err && (
          <div data-assign-task-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button type="button" data-assign-task-save="1" onClick={save} disabled={saving} style={BTN_PRIMARY}>
            {saving ? 'Reassigning…' : 'Reassign'}
          </button>
        </div>
      </div>
    </div>
  );
}
