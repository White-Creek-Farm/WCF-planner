// Complete a To Do — note (optional) plus completion photos up to the 5-total
// item cap. For management/admin the submission auto-approves straight into
// Completed; for everyone else the item stays in place with an Awaiting
// approval badge until a manager signs off.

import React from 'react';
import {
  MAX_TODO_PHOTOS,
  uploadTodoPhotos,
  submitTodoCompletion,
  fireTodoChangeEvent,
  friendlyTodoError,
  isTodoManager,
} from '../lib/todoApi.js';
import {
  taskModalOverlay,
  taskModalSmallPanel,
  taskModalFieldLabel,
  taskModalInput,
  taskModalPrimaryButton,
  taskModalGhostButton,
  taskModalErrorNotice,
  taskModalSubtleText,
  taskModalReadOnlyBlock,
} from './taskModalStyles.js';

export default function TodoCompleteModal({sb, item, authState, isOpen, onClose, onCompleted}) {
  const [note, setNote] = React.useState('');
  const [photos, setPhotos] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (isOpen) {
      setNote('');
      setPhotos([]);
      setErr('');
      setSaving(false);
    }
  }, [isOpen, item && item.id]);

  if (!isOpen || !item) return null;

  const existingPhotos = Array.isArray(item.photos) ? item.photos : [];
  const existingTotal = existingPhotos.length;
  const existingCompletion = existingPhotos.filter((p) => p && p.kind === 'completion').length;
  const remainingSlots = Math.max(0, MAX_TODO_PHOTOS - existingTotal - photos.length);
  const autoApproves = isTodoManager(authState && authState.role);

  function addPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;
    const room = Math.max(0, MAX_TODO_PHOTOS - existingTotal - photos.length);
    setPhotos([...photos, ...files.slice(0, room)]);
    if (files.length > room) {
      setErr(`This item can hold ${MAX_TODO_PHOTOS} photos total (${existingTotal} already attached).`);
    }
  }

  async function save() {
    setErr('');
    setSaving(true);
    try {
      const photoPaths = await uploadTodoPhotos(sb, item.id, 'completion', photos, {
        existingKindCount: existingCompletion,
        existingTotalCount: existingTotal,
      });
      const result = await submitTodoCompletion(sb, {id: item.id, note: note.trim() || null, photoPaths});
      fireTodoChangeEvent();
      if (onCompleted) onCompleted(item.id, result);
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
      aria-label="Complete to do"
      data-todo-complete-modal="1"
    >
      <div style={taskModalSmallPanel}>
        <h2 style={{fontSize: 18, margin: '0 0 10px', color: '#111827'}}>Complete To Do</h2>
        <div style={taskModalReadOnlyBlock}>{item.title}</div>

        <label style={taskModalFieldLabel} htmlFor="todo-complete-note">
          What got done? (optional)
        </label>
        <textarea
          id="todo-complete-note"
          style={{...taskModalInput, marginBottom: 10, minHeight: 60, resize: 'vertical'}}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Short note about the result"
        />

        <label style={taskModalFieldLabel}>
          Completion photos ({existingTotal + photos.length}/{MAX_TODO_PHOTOS} total)
        </label>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={remainingSlots <= 0}
          onChange={(e) => {
            addPhotos(e.target.files);
            e.target.value = '';
          }}
          style={{fontSize: 13, fontFamily: 'inherit', marginBottom: 6}}
        />
        {photos.length > 0 ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6}}>
            {photos.map((f, i) => (
              <div key={i} style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151'}}>
                <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{f.name}</span>
                <button
                  type="button"
                  style={{...taskModalGhostButton, padding: '2px 8px', fontSize: 11}}
                  onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div style={taskModalSubtleText}>
          {autoApproves
            ? 'You are a manager, so this completes the item immediately.'
            : 'A manager will review and approve this completion before it moves to Completed.'}
        </div>

        {err ? <div style={taskModalErrorNotice}>{err}</div> : null}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" style={taskModalGhostButton} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            data-todo-complete-save="1"
            style={{...taskModalPrimaryButton, opacity: saving ? 0.7 : 1}}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Submitting…' : autoApproves ? 'Complete' : 'Submit completion'}
          </button>
        </div>
      </div>
    </div>
  );
}
