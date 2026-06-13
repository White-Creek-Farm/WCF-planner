// Reject a pending To Do completion (management/admin). Requires a short
// rejection note; the item returns to Open and the submitted completion
// note/photos stay visible in the item's Activity history.

import React from 'react';
import {rejectTodoCompletion, fireTodoChangeEvent, friendlyTodoError} from '../lib/todoApi.js';
import {
  taskModalOverlay,
  taskModalSmallPanel,
  taskModalFieldLabel,
  taskModalInput,
  taskModalDangerButton,
  taskModalGhostButton,
  taskModalErrorNotice,
  taskModalReadOnlyBlock,
  taskModalSubtleText,
} from './taskModalStyles.js';

export default function TodoRejectModal({sb, item, isOpen, onClose, onRejected}) {
  const [note, setNote] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (isOpen) {
      setNote('');
      setErr('');
      setSaving(false);
    }
  }, [isOpen, item && item.id]);

  if (!isOpen || !item) return null;

  async function save() {
    setErr('');
    if (!note.trim()) {
      setErr('A short rejection note is required.');
      return;
    }
    setSaving(true);
    try {
      await rejectTodoCompletion(sb, item.id, note.trim());
      fireTodoChangeEvent();
      if (onRejected) onRejected(item.id);
      onClose();
    } catch (e) {
      setErr(friendlyTodoError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={taskModalOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Reject completion"
      data-todo-reject-modal="1"
    >
      <div style={taskModalSmallPanel}>
        <h2 style={{fontSize: 18, margin: '0 0 10px', color: '#111827'}}>Reject completion</h2>
        <div style={taskModalReadOnlyBlock}>
          {item.title}
          {item.completion_submitted_by_name ? (
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 4}}>
              Submitted by {item.completion_submitted_by_name}
              {item.completion_note ? ` — “${item.completion_note}”` : ''}
            </div>
          ) : null}
        </div>

        <label style={taskModalFieldLabel} htmlFor="todo-reject-note">
          Why is it being sent back?
        </label>
        <textarea
          id="todo-reject-note"
          style={{...taskModalInput, marginBottom: 6, minHeight: 60, resize: 'vertical'}}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Short note for the team"
        />
        <div style={taskModalSubtleText}>
          The item returns to Open. The submitted note and photos stay in the item&apos;s history.
        </div>

        {err ? <div style={taskModalErrorNotice}>{err}</div> : null}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" style={taskModalGhostButton} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            data-todo-reject-save="1"
            style={{...taskModalDangerButton, opacity: saving ? 0.7 : 1}}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Rejecting…' : 'Reject completion'}
          </button>
        </div>
      </div>
    </div>
  );
}
