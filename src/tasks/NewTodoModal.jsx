// + New To Do modal — title, details, section, optional due date (cue only),
// up to 5 origination photos. Mints a stable item id while open so a Save
// retry is replay-idempotent (NewTaskModal pattern); photos upload first and
// the RPC only runs after every upload lands, so no item row ever references
// missing photos.

import React from 'react';
import {
  TODO_SECTIONS,
  MAX_TODO_PHOTOS,
  generateTodoItemId,
  uploadTodoPhotos,
  createTodoItem,
  fireTodoChangeEvent,
  friendlyTodoError,
} from '../lib/todoApi.js';
import {
  taskModalOverlay,
  taskModalPanel,
  taskModalFieldLabel,
  taskModalInput,
  taskModalPrimaryButton,
  taskModalGhostButton,
  taskModalErrorNotice,
  taskModalSubtleText,
} from './taskModalStyles.js';

export default function NewTodoModal({sb, isOpen, onClose, onCreated, defaultSection}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [section, setSection] = React.useState(defaultSection || 'general');
  const [dueDate, setDueDate] = React.useState('');
  const [photos, setPhotos] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const idRef = React.useRef(null);

  React.useEffect(() => {
    if (isOpen) {
      idRef.current = generateTodoItemId();
      setSection(defaultSection && defaultSection !== 'all' ? defaultSection : 'general');
      setTitle('');
      setDescription('');
      setDueDate('');
      setPhotos([]);
      setErr('');
      setSaving(false);
    }
  }, [isOpen, defaultSection]);

  if (!isOpen) return null;

  function addPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;
    const room = Math.max(0, MAX_TODO_PHOTOS - photos.length);
    setPhotos([...photos, ...files.slice(0, room)]);
    if (files.length > room) {
      setErr(`To dos can have up to ${MAX_TODO_PHOTOS} photos total.`);
    }
  }

  async function save() {
    setErr('');
    if (!title || title.trim().length < 3) {
      setErr('Title must be at least 3 characters.');
      return;
    }
    setSaving(true);
    try {
      const id = idRef.current;
      const photoPaths = await uploadTodoPhotos(sb, id, 'origination', photos);
      await createTodoItem(sb, {
        id,
        title: title.trim(),
        description: description.trim() || null,
        section,
        dueDate: dueDate || null,
        photoPaths,
      });
      fireTodoChangeEvent();
      if (onCreated) onCreated(id);
      onClose();
    } catch (e) {
      setErr(friendlyTodoError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={taskModalOverlay} role="dialog" aria-modal="true" aria-label="New to do" data-todo-new-modal="1">
      <div style={taskModalPanel}>
        <h2 style={{fontSize: 18, margin: '0 0 12px', color: '#111827'}}>New To Do</h2>

        <label style={taskModalFieldLabel} htmlFor="todo-new-title">
          What needs doing?
        </label>
        <input
          id="todo-new-title"
          style={{...taskModalInput, marginBottom: 10}}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Re-hang the gate by the pig barn"
        />

        <label style={taskModalFieldLabel} htmlFor="todo-new-desc">
          Details (optional)
        </label>
        <textarea
          id="todo-new-desc"
          style={{...taskModalInput, marginBottom: 10, minHeight: 70, resize: 'vertical'}}
          value={description}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Anything the person doing it should know"
        />

        <div style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10}}>
          <div style={{flex: '1 1 180px'}}>
            <label style={taskModalFieldLabel} htmlFor="todo-new-section">
              Section
            </label>
            <select
              id="todo-new-section"
              style={taskModalInput}
              value={section}
              onChange={(e) => setSection(e.target.value)}
            >
              {TODO_SECTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div style={{flex: '1 1 160px'}}>
            <label style={taskModalFieldLabel} htmlFor="todo-new-due">
              Due date (optional, just a cue)
            </label>
            <input
              id="todo-new-due"
              type="date"
              style={taskModalInput}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        <label style={taskModalFieldLabel}>
          Photos ({photos.length}/{MAX_TODO_PHOTOS})
        </label>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={photos.length >= MAX_TODO_PHOTOS}
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
        <div style={taskModalSubtleText}>5 photos total per item, shared between listing and completing it.</div>

        {err ? <div style={taskModalErrorNotice}>{err}</div> : null}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" style={taskModalGhostButton} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            data-todo-new-save="1"
            style={{...taskModalPrimaryButton, opacity: saving ? 0.7 : 1}}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Adding…' : 'Add To Do'}
          </button>
        </div>
      </div>
    </div>
  );
}
