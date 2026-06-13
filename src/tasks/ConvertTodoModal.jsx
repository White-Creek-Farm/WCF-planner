// Convert a To Do into a real assigned Task (management/admin).
//
// Opens a prefilled task form (title/description from the item, assignee +
// due date to tweak). NOTHING happens to the To Do until the Task is
// successfully submitted: cancel/close leaves it open unchanged. On submit,
// origination photos are first client-copied into the task's
// task-request-photos creation paths, then convert_todo_item creates the
// Task AND marks the To Do converted in ONE server transaction — the item
// disappears from the To Do UI only after the Task exists. A validation
// failure in the task payload aborts the whole transaction, so the To Do
// stays open.

import React from 'react';
import {todayCentralISO} from '../lib/dateUtils.js';
import {convertTodoItem, copyTodoPhotosToTaskCreation, fireTodoChangeEvent, friendlyTodoError} from '../lib/todoApi.js';
import {fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';
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

function mintTaskIds() {
  const stamp = Date.now().toString(36);
  const rand = () => Math.random().toString(36).slice(2, 8);
  return {id: `ti-${stamp}-${rand()}`, csid: `csid-${stamp}-${rand()}`};
}

export default function ConvertTodoModal({sb, item, profilesById, isOpen, onClose, onConverted}) {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [assigneeId, setAssigneeId] = React.useState('');
  const [dueDate, setDueDate] = React.useState(todayCentralISO());
  const [carryPhotos, setCarryPhotos] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  const idsRef = React.useRef(null);

  const originationPhotos = React.useMemo(
    () => (Array.isArray(item && item.photos) ? item.photos.filter((p) => p && p.kind === 'origination') : []),
    [item],
  );

  React.useEffect(() => {
    if (isOpen && item) {
      idsRef.current = mintTaskIds();
      setTitle(item.title || '');
      setDescription(item.description || item.title || '');
      setAssigneeId('');
      setDueDate(todayCentralISO());
      setCarryPhotos(true);
      setErr('');
      setSaving(false);
    }
  }, [isOpen, item && item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !item) return null;

  const eligibleProfiles = Object.values(profilesById || {})
    .filter((p) => p && p.id && p.full_name)
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  async function save() {
    setErr('');
    if (!title || title.trim().length < 3) {
      setErr('Task title must be at least 3 characters.');
      return;
    }
    if (!description.trim()) {
      setErr('Tasks need a description.');
      return;
    }
    if (!assigneeId) {
      setErr('Pick who this task is assigned to.');
      return;
    }
    if (!dueDate) {
      setErr('Pick a due date.');
      return;
    }
    setSaving(true);
    try {
      const {id, csid} = idsRef.current;
      let creationPhotoPaths = [];
      if (carryPhotos && originationPhotos.length > 0) {
        creationPhotoPaths = await copyTodoPhotosToTaskCreation(sb, id, originationPhotos);
      }
      const result = await convertTodoItem(sb, {
        todoId: item.id,
        task: {
          id,
          client_submission_id: csid,
          title: title.trim(),
          description: description.trim(),
          due_date: dueDate,
          assignee_profile_id: assigneeId,
        },
        creationPhotoPaths,
      });
      fireTodoChangeEvent();
      fireTaskChangeEvent();
      if (onConverted) onConverted(result && result.task_instance_id ? result.task_instance_id : id);
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
      aria-label="Convert to do into a task"
      data-todo-convert-modal="1"
    >
      <div style={taskModalPanel}>
        <h2 style={{fontSize: 18, margin: '0 0 4px', color: '#111827'}}>Convert into a Task</h2>
        <div style={{...taskModalSubtleText, marginBottom: 12}}>
          The To Do stays on the list unless this task is created. Tweak anything before submitting.
        </div>

        <label style={taskModalFieldLabel} htmlFor="todo-convert-title">
          Task title
        </label>
        <input
          id="todo-convert-title"
          style={{...taskModalInput, marginBottom: 10}}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label style={taskModalFieldLabel} htmlFor="todo-convert-desc">
          Description
        </label>
        <textarea
          id="todo-convert-desc"
          style={{...taskModalInput, marginBottom: 10, minHeight: 70, resize: 'vertical'}}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10}}>
          <div style={{flex: '1 1 200px'}}>
            <label style={taskModalFieldLabel} htmlFor="todo-convert-assignee">
              Assign to
            </label>
            <select
              id="todo-convert-assignee"
              style={taskModalInput}
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
            >
              <option value="">Select…</option>
              {eligibleProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </select>
          </div>
          <div style={{flex: '1 1 160px'}}>
            <label style={taskModalFieldLabel} htmlFor="todo-convert-due">
              Due date
            </label>
            <input
              id="todo-convert-due"
              type="date"
              style={taskModalInput}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        {originationPhotos.length > 0 ? (
          <label
            style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginBottom: 6}}
          >
            <input type="checkbox" checked={carryPhotos} onChange={(e) => setCarryPhotos(e.target.checked)} />
            Carry the item&apos;s {originationPhotos.length} photo{originationPhotos.length > 1 ? 's' : ''} into the
            task
          </label>
        ) : null}

        {err ? <div style={taskModalErrorNotice}>{err}</div> : null}

        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button type="button" style={taskModalGhostButton} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            data-todo-convert-save="1"
            style={{...taskModalPrimaryButton, opacity: saving ? 0.7 : 1}}
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Creating task…' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}
