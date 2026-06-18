// To Do item record page — /tasks/todo/<id>.
//
// Durable workspace for one shared To Do item: full details, photo
// thumbnails, status/workflow actions (complete, approve/reject, convert,
// remove), creator/manager editing, and the canonical collaboration section
// (Comments with @mentions + audit Activity) on the todo.item entity.
// Mention notifications deep-link here with a #comment-<id> anchor.
//
// Access mirrors the server gates: light/farm_team/management/admin.
// equipment_tech (and inactive) are bounced back to /tasks — the mig 115
// RPCs and the todo.item _activity_can_read branch refuse them server-side
// regardless.

import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {
  RecordPageFrame,
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
import RecordPageLoadError from '../shared/RecordPageLoadError.jsx';
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
import InlineNotice from '../shared/InlineNotice.jsx';
import DeleteModal from '../shared/DeleteModal.jsx';
import {fmt, fmtCentralDateTime} from '../lib/dateUtils.js';
import {loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';
import {
  TODO_SECTIONS,
  MAX_TODO_PHOTOS,
  TODO_CHANGE_EVENT,
  todoSectionLabel,
  isTodoParticipant,
  isTodoManager,
  listTodoItems,
  listTodoMentionableProfiles,
  remainingTodoPhotoSlots,
  uploadTodoPhotos,
  updateTodoItem,
  approveTodoCompletion,
  removeTodoItem,
  formatDaysSinceListed,
  fireTodoChangeEvent,
  friendlyTodoError,
} from '../lib/todoApi.js';
import TodoPhotoThumbs from './TodoPhotoThumbs.jsx';
import TodoCompleteModal from './TodoCompleteModal.jsx';
import TodoRejectModal from './TodoRejectModal.jsx';
import ConvertTodoModal from './ConvertTodoModal.jsx';
import {taskModalFieldLabel, taskModalInput, taskModalPrimaryButton, taskModalGhostButton} from './taskModalStyles.js';

const ACTION_BTN = {
  padding: '8px 14px',
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const PRIMARY_ACTION_BTN = {
  ...ACTION_BTN,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
};

export default function TodoItemPage({sb, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = decodeURIComponent(location.pathname.replace('/tasks/todo/', ''));
  const role = authState && authState.role;
  const canParticipate = isTodoParticipant(role);
  const canManage = isTodoManager(role);
  const callerId = authState && authState.user ? authState.user.id : null;

  const [item, setItem] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [completeOpen, setCompleteOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [convertOpen, setConvertOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [assignableProfiles, setAssignableProfiles] = React.useState({});

  const [editing, setEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState('');
  const [editDescription, setEditDescription] = React.useState('');
  const [editSection, setEditSection] = React.useState('general');
  const [editDueDate, setEditDueDate] = React.useState('');
  const [editPhotos, setEditPhotos] = React.useState([]);
  const [savingEdit, setSavingEdit] = React.useState(false);

  // Inline load with a cancelled flag so a quick navigation between
  // /tasks/todo/<id> routes can never resolve the OLD record's fetch after
  // the new one and render stale data under the new URL.
  React.useEffect(() => {
    if (!canParticipate) return undefined;
    let cancelled = false;
    setItem(null);
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const data = await listTodoItems(sb, {includeCompleted: true});
        if (cancelled) return;
        const hit = data.items.find((i) => i.id === recordId) || data.completed.find((i) => i.id === recordId) || null;
        setItem(hit);
      } catch (e) {
        if (cancelled) return;
        setItem(null);
        setLoadError({kind: 'error', message: 'Could not load this to do: ' + friendlyTodoError(e)});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, recordId, reloadKey, canParticipate]);

  React.useEffect(() => {
    function onChange() {
      setReloadKey((k) => k + 1);
    }
    window.addEventListener(TODO_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(TODO_CHANGE_EVENT, onChange);
  }, []);

  // Mention deeplink anchor scroll (#comment-<id>), TaskInstancePage pattern.
  React.useEffect(() => {
    if (!loading && location.hash) {
      const anchor = location.hash.slice(1);
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
      }, 200);
    }
  }, [loading, location.hash]);

  React.useEffect(() => {
    if (!canManage || !sb) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const map = await loadTaskAssignableProfilesById(sb);
        if (!cancelled) setAssignableProfiles(map);
      } catch (_e) {
        /* soft-fail */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, canManage]);

  // Role containment: equipment_tech / inactive never see To Do surfaces.
  React.useEffect(() => {
    if (authState && role && !canParticipate) {
      navigate('/tasks', {replace: true});
    }
  }, [authState, role, canParticipate, navigate]);

  if (!canParticipate) return null;

  const backToList = () => navigate('/tasks/todo');

  if (loading) return <RecordPageLoading Header={Header} label="Loading…" />;

  if (loadError) {
    return (
      <RecordPageLoadError
        Header={Header}
        backLabel="Back to To Do List"
        onBack={backToList}
        notice={loadError}
        onRetry={() => setReloadKey((k) => k + 1)}
        maxWidth={760}
        data-todo-record-load-error="true"
      />
    );
  }

  if (!item) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to To Do List"
        onBack={backToList}
        message="This to do is no longer on the list. Completed items live in the Completed section; items converted into Tasks continue in the Task Center."
      />
    );
  }

  const pending = item.status === 'pending_approval';
  const completedItem = item.status === 'completed';
  const canEdit =
    (item.status === 'open' && (canManage || item.created_by === callerId)) || (!completedItem && pending && canManage);
  const existingTodoPhotos = Array.isArray(item.photos) ? item.photos : [];
  const existingTodoPhotoCount = existingTodoPhotos.length;
  const existingOriginationPhotoCount = existingTodoPhotos.filter((p) => p && p.kind === 'origination').length;
  const remainingEditPhotoSlots = remainingTodoPhotoSlots(existingTodoPhotoCount);
  const availableEditPhotoSlots = Math.max(0, remainingEditPhotoSlots - editPhotos.length);
  const editPhotoLimitMessage = `To dos can have up to ${MAX_TODO_PHOTOS} photos total.`;

  function startEdit() {
    setEditTitle(item.title || '');
    setEditDescription(item.description || '');
    setEditSection(item.section || 'general');
    setEditDueDate(item.due_date || '');
    setEditPhotos([]);
    setEditing(true);
  }

  function stopEdit() {
    setEditPhotos([]);
    setEditing(false);
  }

  function addEditPhotos(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;
    if (availableEditPhotoSlots <= 0) {
      setNotice({kind: 'error', message: editPhotoLimitMessage});
      return;
    }
    setEditPhotos([...editPhotos, ...files.slice(0, availableEditPhotoSlots)]);
    if (files.length > availableEditPhotoSlots) {
      setNotice({kind: 'error', message: editPhotoLimitMessage});
    }
  }

  async function saveEdit() {
    setNotice(null);
    if (!editTitle || editTitle.trim().length < 3) {
      setNotice({kind: 'error', message: 'Title must be at least 3 characters.'});
      return;
    }
    setSavingEdit(true);
    try {
      const photoPaths = await uploadTodoPhotos(sb, item.id, 'origination', editPhotos, {
        existingKindCount: existingOriginationPhotoCount,
        existingTotalCount: existingTodoPhotoCount,
      });
      await updateTodoItem(sb, {
        id: item.id,
        title: editTitle.trim(),
        description: editDescription,
        section: editSection,
        dueDate: editDueDate || null,
        clearDueDate: !editDueDate && !!item.due_date,
        photoPaths,
      });
      stopEdit();
      fireTodoChangeEvent();
    } catch (e) {
      setNotice({kind: 'error', message: friendlyTodoError(e)});
    } finally {
      setSavingEdit(false);
    }
  }

  async function approve() {
    setNotice(null);
    try {
      await approveTodoCompletion(sb, item.id);
      fireTodoChangeEvent();
    } catch (e) {
      setNotice({kind: 'error', message: 'Approve failed: ' + friendlyTodoError(e)});
    }
  }

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={760} data-todo-record-loaded="true">
        <RecordBackLink label="Back to To Do List" onBack={backToList} />
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
          <RecordTitle margin="0">{item.title}</RecordTitle>
          {pending ? (
            <span
              data-todo-pending-badge="1"
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                background: '#fef3c7',
                border: '1px solid #fde68a',
                color: '#92400e',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Awaiting approval
            </span>
          ) : null}
          {completedItem ? (
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 999,
                background: '#ecfdf5',
                border: '1px solid #a7f3d0',
                color: '#065f46',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Completed
            </span>
          ) : null}
        </div>

        <div style={{fontSize: 13, color: 'var(--ink-muted)', margin: '6px 0 12px'}}>
          {todoSectionLabel(item.section)} · {item.created_by_name} · {formatDaysSinceListed(item.created_at)}
          {item.due_date ? ` · Due ${fmt(item.due_date)}` : ''}
        </div>

        {notice ? <InlineNotice notice={notice} onDismiss={() => setNotice(null)} /> : null}

        {editing ? (
          <div
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              marginBottom: 14,
            }}
            data-todo-edit-panel="1"
          >
            <label style={taskModalFieldLabel} htmlFor="todo-edit-title">
              Title
            </label>
            <input
              id="todo-edit-title"
              style={{...taskModalInput, marginBottom: 10}}
              value={editTitle}
              maxLength={200}
              onChange={(e) => setEditTitle(e.target.value)}
            />
            <label style={taskModalFieldLabel} htmlFor="todo-edit-desc">
              Details
            </label>
            <textarea
              id="todo-edit-desc"
              style={{...taskModalInput, marginBottom: 10, minHeight: 70, resize: 'vertical'}}
              value={editDescription}
              maxLength={4000}
              onChange={(e) => setEditDescription(e.target.value)}
            />
            <div style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12}}>
              <div style={{flex: '1 1 180px'}}>
                <label style={taskModalFieldLabel} htmlFor="todo-edit-section">
                  Section
                </label>
                <select
                  id="todo-edit-section"
                  style={taskModalInput}
                  value={editSection}
                  onChange={(e) => setEditSection(e.target.value)}
                >
                  {TODO_SECTIONS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{flex: '1 1 160px'}}>
                <label style={taskModalFieldLabel} htmlFor="todo-edit-due">
                  Due date (cue only)
                </label>
                <input
                  id="todo-edit-due"
                  type="date"
                  style={taskModalInput}
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                />
              </div>
            </div>
            <div style={{marginBottom: 12}}>
              <label style={taskModalFieldLabel}>
                Add photos ({availableEditPhotoSlots} of {MAX_TODO_PHOTOS} slots left)
              </label>
              <input
                data-todo-edit-field="photos"
                type="file"
                accept="image/*"
                multiple
                disabled={savingEdit || availableEditPhotoSlots <= 0}
                onChange={(e) => {
                  addEditPhotos(e.target.files);
                  e.target.value = '';
                }}
                style={{fontSize: 13, fontFamily: 'inherit', marginBottom: 6}}
              />
              {editPhotos.length > 0 ? (
                <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6}}>
                  {editPhotos.map((f, i) => (
                    <div
                      key={i}
                      style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ink)'}}
                    >
                      <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{f.name}</span>
                      <button
                        type="button"
                        style={{...taskModalGhostButton, padding: '2px 8px', fontSize: 11}}
                        onClick={() => setEditPhotos(editPhotos.filter((_, j) => j !== i))}
                        disabled={savingEdit}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
                5 photos total per item, shared between listing and completing it.
              </div>
            </div>
            <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8}}>
              <button type="button" style={taskModalGhostButton} onClick={stopEdit} disabled={savingEdit}>
                Cancel
              </button>
              <button
                type="button"
                data-todo-edit-save="1"
                style={{...taskModalPrimaryButton, opacity: savingEdit ? 0.7 : 1}}
                onClick={saveEdit}
                disabled={savingEdit}
              >
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {item.description ? (
              <div
                style={{
                  background: 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: 14,
                  fontSize: 14,
                  color: 'var(--ink)',
                  whiteSpace: 'pre-line',
                  marginBottom: 14,
                }}
              >
                {item.description}
              </div>
            ) : null}
          </>
        )}

        {item.rejection_note && item.status === 'open' ? (
          <div
            data-todo-rejected-cue="1"
            style={{
              background: '#fffbeb',
              border: '1px solid #fde68a',
              color: '#92400e',
              borderRadius: 10,
              padding: '8px 12px',
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            Last completion was sent back{item.rejected_by_name ? ` by ${item.rejected_by_name}` : ''}:{' '}
            {item.rejection_note}
          </div>
        ) : null}

        {pending || completedItem ? (
          <div
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              fontSize: 13,
              color: 'var(--ink)',
              marginBottom: 14,
            }}
            data-todo-completion-info="1"
          >
            <div style={{fontWeight: 700, marginBottom: 4}}>
              {completedItem ? 'Completion' : 'Submitted completion'}
            </div>
            <div>
              {item.completion_submitted_by_name || 'Unknown'}
              {item.completion_submitted_at ? ` · ${fmtCentralDateTime(item.completion_submitted_at)}` : ''}
            </div>
            {item.completion_note ? <div style={{marginTop: 4}}>{item.completion_note}</div> : null}
            {completedItem && item.approved_by_name ? (
              <div style={{marginTop: 4, color: '#065f46'}}>
                Approved by {item.approved_by_name}
                {item.approved_at ? ` · ${fmtCentralDateTime(item.approved_at)}` : ''}
              </div>
            ) : null}
          </div>
        ) : null}

        {Array.isArray(item.photos) && item.photos.length > 0 ? (
          <div style={{marginBottom: 14}}>
            <TodoPhotoThumbs sb={sb} photos={item.photos} />
          </div>
        ) : null}

        <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18}} data-todo-record-actions="1">
          {item.status === 'open' ? (
            <button
              type="button"
              data-todo-complete={item.id}
              style={PRIMARY_ACTION_BTN}
              onClick={() => setCompleteOpen(true)}
            >
              Complete
            </button>
          ) : null}
          {pending && canManage ? (
            <>
              <button type="button" data-todo-approve={item.id} style={PRIMARY_ACTION_BTN} onClick={approve}>
                Approve
              </button>
              <button type="button" data-todo-reject={item.id} style={ACTION_BTN} onClick={() => setRejectOpen(true)}>
                Reject
              </button>
            </>
          ) : null}
          {canEdit && !editing ? (
            <button type="button" data-todo-edit={item.id} style={ACTION_BTN} onClick={startEdit}>
              Edit
            </button>
          ) : null}
          {item.status === 'open' && canManage ? (
            <button type="button" data-todo-convert={item.id} style={ACTION_BTN} onClick={() => setConvertOpen(true)}>
              Convert to Task
            </button>
          ) : null}
          {!completedItem && canManage ? (
            <button type="button" data-todo-remove={item.id} style={ACTION_BTN} onClick={() => setRemoveOpen(true)}>
              Remove
            </button>
          ) : null}
        </div>

        <RecordCollaborationSection
          sb={sb}
          authState={authState}
          entityType="todo.item"
          entityId={item.id}
          entityLabel={item.title}
          loadMentionable={listTodoMentionableProfiles}
        />
      </RecordPageBody>

      <TodoCompleteModal
        sb={sb}
        authState={authState}
        item={item}
        isOpen={completeOpen}
        onClose={() => setCompleteOpen(false)}
        onCompleted={() => {}}
      />
      <TodoRejectModal
        sb={sb}
        item={item}
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onRejected={() => {}}
      />
      <ConvertTodoModal
        sb={sb}
        item={item}
        profilesById={assignableProfiles}
        isOpen={convertOpen}
        onClose={() => setConvertOpen(false)}
        onConverted={(taskId) => navigate('/tasks/' + encodeURIComponent(taskId))}
      />
      {removeOpen ? (
        <DeleteModal
          msg={`Remove "${item.title}" from the To Do List? Its history stays in Activity.`}
          onConfirm={async () => {
            setRemoveOpen(false);
            try {
              await removeTodoItem(sb, item.id);
              fireTodoChangeEvent();
              backToList();
            } catch (e) {
              setNotice({kind: 'error', message: 'Remove failed: ' + friendlyTodoError(e)});
            }
          }}
          onCancel={() => setRemoveOpen(false)}
        />
      ) : null}
    </RecordPageFrame>
  );
}
