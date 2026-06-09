// Tasks v2 T9 — Delete Task modal with typed confirmation.
//
// No window.confirm — Codex T9 lock requires a typed-confirmation
// modal. Operator must type the literal word DELETE before the Save
// button enables. Wraps delete_task_instance (mig 053) which:
//   - rejects completed tasks for everyone;
//   - admin can delete any open task;
//   - regular users can delete only open tasks where they are BOTH the
//     creator AND the assignee.
//
// The component does not pre-check the regular-user rule beyond not
// rendering the Delete button; the RPC re-validates server-side.

import React from 'react';
import {deleteTaskInstanceV2} from '../lib/tasksCenterMutationsApi.js';
import {
  taskModalDangerButton as BTN_DANGER,
  taskModalErrorNotice as ERROR_NOTICE,
  taskModalFieldLabel as FIELD_LABEL,
  taskModalGhostButton as BTN_GHOST,
  taskModalInput as INPUT,
  taskModalOverlay as OVERLAY,
  taskModalSmallPanel as PANEL,
} from './taskModalStyles.js';

const CONFIRM_PHRASE = 'DELETE';

export default function DeleteTaskModal({sb, task, isOpen, onClose, onDeleted}) {
  const [typed, setTyped] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!isOpen) {
      setTyped('');
      setSaving(false);
      setErr('');
    }
  }, [isOpen]);

  if (!isOpen || !task) return null;

  const confirmed = typed.trim().toUpperCase() === CONFIRM_PHRASE;

  function close() {
    if (onClose) onClose();
  }

  async function save() {
    if (saving || !confirmed) return;
    setErr('');
    setSaving(true);
    try {
      const result = await deleteTaskInstanceV2(sb, task.id);
      if (onDeleted) onDeleted(task.id, result);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div data-delete-task-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>Delete Task</h2>
          <button type="button" onClick={close} style={BTN_GHOST}>
            Cancel
          </button>
        </div>

        <div style={{fontSize: 13, color: '#374151', marginBottom: 12}}>
          This deletes <span style={{fontWeight: 600, color: '#111827'}}>{task.title}</span> and any associated photos,
          audit history, and sidecar rows. Completed tasks cannot be deleted; this only applies to open tasks.
        </div>

        <label style={FIELD_LABEL} htmlFor="delete-task-confirm">
          Type {CONFIRM_PHRASE} to confirm
        </label>
        <input
          id="delete-task-confirm"
          data-delete-task-field="confirm"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          style={INPUT}
        />

        {err && (
          <div data-delete-task-error="1" style={ERROR_NOTICE}>
            {err}
          </div>
        )}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" onClick={close} disabled={saving} style={BTN_GHOST}>
            Cancel
          </button>
          <button
            type="button"
            data-delete-task-save="1"
            onClick={save}
            disabled={saving || !confirmed}
            style={BTN_DANGER}
          >
            {saving ? 'Deleting…' : 'Delete Permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
