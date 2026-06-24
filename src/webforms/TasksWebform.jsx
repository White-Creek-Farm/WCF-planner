// Public Tasks webform — C3.
// Anon submit. One-time task only — no recurrence selector. Posts via
// useOfflineRpcSubmit('task_submit') against mig 041's
// submit_task_instance RPC, which validates submitted_by against the
// 'tasks-public' team availability and assignee against
// tasks_public_assignee_availability.
//
// Submitted-by = roster display name string (filtered roster).
// Assignee     = profiles.id uuid (filtered eligible profiles).
// Roster IDs and profile UUIDs MUST NOT mix in the same hiddenIds array.
//
// Stable parent id is minted as 'ti-' + crypto.randomUUID() per the C3
// spec — useOfflineRpcSubmit's default ${formKind}-<ts>-<rand> doesn't
// match the task_instances PK convention.
import React from 'react';
import {visiblePublicAssignees} from '../lib/tasks.js';
import {listEligibleAssignees, loadPublicAssigneeAvailability} from '../lib/tasksPublicApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {useOfflineRpcSubmit} from '../lib/useOfflineRpcSubmit.js';
import {
  TODO_SECTIONS,
  createTodoItem,
  fireTodoChangeEvent,
  friendlyTodoError,
  generateTodoItemId,
  uploadTodoPhotos,
} from '../lib/todoApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StuckSubmissionsModal from './StuckSubmissionsModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import LockedSubmitter from './LockedSubmitter.jsx';

function mintTiInstanceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'ti-' + crypto.randomUUID().replace(/-/g, '');
  }
  return 'ti-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const wfBg = {
  minHeight: '100vh',
  background: 'var(--bg-page)',
  padding: '1rem',
  fontFamily: 'inherit',
};
const cardS = {
  background: 'white',
  borderRadius: 12,
  padding: '20px',
  marginBottom: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,.08)',
};
const inpS = {
  fontFamily: 'inherit',
  fontSize: 14,
  padding: '10px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  width: '100%',
  outline: 'none',
  background: 'white',
  color: 'var(--ink)',
  boxSizing: 'border-box',
};
const lblS = {display: 'block', fontSize: 13, color: 'var(--ink)', marginBottom: 5, fontWeight: 500};

const TasksWebform = ({sb, sessionSubmitter}) => {
  const [assigneeOptions, setAssigneeOptions] = React.useState([]);
  const [configLoaded, setConfigLoaded] = React.useState(false);

  const today = React.useMemo(() => todayCentralISO(), []);

  const [submissionType, setSubmissionType] = React.useState('task');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [dueDate, setDueDate] = React.useState(today);
  const [todoSection, setTodoSection] = React.useState('general');
  // Login-required form: submitter is locked to the signed-in user (no roster).
  const submittedBy = sessionSubmitter?.name || '';
  const [assignee, setAssignee] = React.useState('');
  const [photoFile, setPhotoFile] = React.useState(null); // Optional File / Blob; one max
  const [submitting, setSubmitting] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [doneState, setDoneState] = React.useState('none'); // 'none' | 'synced' | 'queued'
  const [doneSubmissionType, setDoneSubmissionType] = React.useState('task');
  const [stuckOpen, setStuckOpen] = React.useState(false);

  const {submit, stuckRows, retryStuck, discardStuck} = useOfflineRpcSubmit('task_submit');
  const isTodoMode = submissionType === 'todo';
  const submissionLabel = isTodoMode ? 'To Do' : 'Task';

  const initialStuckShownRef = React.useRef(false);
  React.useEffect(() => {
    if (stuckRows.length > 0 && !initialStuckShownRef.current) {
      initialStuckShownRef.current = true;
      setStuckOpen(true);
    }
  }, [stuckRows.length]);

  React.useEffect(() => {
    Promise.all([listEligibleAssignees(sb), loadPublicAssigneeAvailability(sb)])
      .then(([eligibles, assigneeAvail]) => {
        const visibleAssignees = visiblePublicAssignees(eligibles, assigneeAvail);
        setAssigneeOptions(visibleAssignees);
        setConfigLoaded(true);
      })
      .catch((e) => {
        setErr('Could not load form options: ' + (e && e.message ? e.message : String(e)));
        setConfigLoaded(true);
      });
  }, [sb]);

  function chooseSubmissionType(nextType) {
    if (nextType !== 'task' && nextType !== 'todo') return;
    setSubmissionType(nextType);
    setErr('');
    if (nextType === 'todo') {
      setDueDate('');
      setAssignee('');
    } else {
      setDueDate((d) => d || today);
    }
  }

  async function handleSubmit() {
    if (!title.trim()) {
      setErr('Title is required.');
      return;
    }
    if (isTodoMode && title.trim().length < 3) {
      setErr('Title must be at least 3 characters.');
      return;
    }
    if (!isTodoMode && !dueDate) {
      setErr('Due date is required.');
      return;
    }
    if (!isTodoMode && !submittedBy) {
      setErr('Submitted by is required.');
      return;
    }
    if (!isTodoMode && !assignee) {
      setErr('Assignee is required.');
      return;
    }
    setErr('');
    setSubmitting(true);
    setDoneSubmissionType(submissionType);
    try {
      if (isTodoMode) {
        const id = generateTodoItemId();
        const photoPaths = photoFile ? await uploadTodoPhotos(sb, id, 'origination', [photoFile]) : [];
        await createTodoItem(sb, {
          id,
          title: title.trim(),
          description: description.trim() || null,
          section: todoSection,
          dueDate: dueDate || null,
          photoPaths,
        });
        fireTodoChangeEvent();
        setDoneState('synced');
        return;
      }
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        due_date: dueDate,
        assignee_profile_id: assignee,
        submitted_by_team_member: submittedBy,
      };
      const result = await submit(payload, {parentId: mintTiInstanceId(), photo: photoFile || null});
      setDoneState(result.state);
    } catch (e) {
      const msg = isTodoMode ? friendlyTodoError(e) : e && e.message ? e.message : String(e);
      setErr('Could not submit: ' + msg);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    setDueDate(submissionType === 'todo' ? '' : today);
    setAssignee('');
    setTodoSection('general');
    setPhotoFile(null);
    setErr('');
    setDoneState('none');
  }

  const logoEl = (
    <div style={{textAlign: 'center', marginBottom: 20}}>
      <div style={{fontSize: 18, fontWeight: 800, color: '#085041', letterSpacing: -0.3}}>{'🌾 WCF Planner'}</div>
      <div style={{fontSize: 12, color: 'var(--ink)', marginTop: 2}}>Submit a Task or a Todo</div>
    </div>
  );

  const doneLabel = doneSubmissionType === 'todo' ? 'To Do' : 'Task';

  if (doneState !== 'none')
    return (
      <div style={wfBg}>
        <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '2rem', textAlign: 'center'}}>
          {logoEl}
          <div style={{fontSize: 56, marginBottom: 12}}>{doneState === 'queued' ? '📡' : '✅'}</div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: doneState === 'queued' ? '#92400e' : 'var(--ink)',
              marginBottom: 8,
            }}
          >
            {doneState === 'queued' ? 'Saved on this device' : `${doneLabel} submitted!`}
          </div>
          {doneState === 'queued' && (
            <div
              data-submit-state="queued"
              style={{
                fontSize: 12,
                color: '#78716c',
                marginBottom: 12,
                lineHeight: 1.5,
                background: '#fef3c7',
                border: '1px solid #fde68a',
                borderRadius: 10,
                padding: '8px 12px',
                textAlign: 'left',
              }}
            >
              No connection right now. Your task will sync as soon as the device is back online.
            </div>
          )}
          {doneState === 'synced' && (
            <div data-submit-state="synced" style={{display: 'none'}}>
              synced
            </div>
          )}
          <button
            onClick={resetForm}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: 'none',
              background: '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 10,
            }}
          >
            Submit Another {doneLabel}
          </button>
          <button
            onClick={() => {
              window.location.href = '/dailys';
            }}
            style={{
              width: '100%',
              padding: 14,
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Done
          </button>
        </div>
      </div>
    );

  return (
    <div style={wfBg}>
      <div style={{maxWidth: 480, margin: '0 auto', paddingTop: '1rem'}}>
        {logoEl}

        {stuckRows.length > 0 && (
          <button
            onClick={() => setStuckOpen(true)}
            data-stuck-button="1"
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid #fde68a',
              background: '#fef3c7',
              color: '#92400e',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
              textAlign: 'left',
            }}
          >
            ⚠ {stuckRows.length} unsynced task submission{stuckRows.length === 1 ? '' : 's'} — tap to review
          </button>
        )}

        <div data-submit-kind-toggle="1" style={cardS}>
          <label style={lblS}>Submit type</label>
          <div
            role="group"
            aria-label="Submit type"
            style={{display: 'flex', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-strong)'}}
          >
            {[
              {key: 'task', label: 'Task'},
              {key: 'todo', label: 'To Do'},
            ].map((opt, i) => {
              const selected = submissionType === opt.key;
              return (
                <React.Fragment key={opt.key}>
                  {i > 0 && <div style={{width: 1, background: 'var(--border-strong)', flexShrink: 0}} />}
                  <button
                    type="button"
                    data-submit-kind={opt.key}
                    aria-pressed={selected}
                    onClick={() => chooseSubmissionType(opt.key)}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      border: 'none',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      fontWeight: selected ? 700 : 500,
                      cursor: 'pointer',
                      background: selected ? '#085041' : 'white',
                      color: selected ? '#ffffff' : '#000000',
                    }}
                  >
                    {opt.label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        <div style={cardS}>
          <label style={lblS}>{submissionLabel} title *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            style={inpS}
          />
        </div>

        <div style={cardS}>
          <label style={lblS}>Details</label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add any context the assignee will need…"
            style={{...inpS, resize: 'vertical', fontFamily: 'inherit'}}
          />
        </div>

        <div style={cardS}>
          <label style={lblS}>Due date{isTodoMode ? ' (optional)' : ' *'}</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inpS} />
        </div>

        {isTodoMode && (
          <div style={cardS}>
            <label style={lblS}>Section</label>
            <select value={todoSection} onChange={(e) => setTodoSection(e.target.value)} style={inpS}>
              {TODO_SECTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {!isTodoMode && (
          <>
            <div style={cardS}>
              <LockedSubmitter name={submittedBy} label="Submitted by *" labelStyle={lblS} />
            </div>

            <div style={cardS}>
              <label style={lblS}>Assign to *</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={inpS}>
                <option value="">Select…</option>
                {assigneeOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              {configLoaded && assigneeOptions.length === 0 && (
                <div style={{fontSize: 11, color: '#92400e', marginTop: 6}}>
                  No eligible assignees available. Ask an admin to enable a planner user for public tasks.
                </div>
              )}
            </div>
          </>
        )}

        <div style={cardS}>
          <label style={lblS}>Photo (optional)</label>
          {photoFile ? (
            <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
              <span style={{fontSize: 12, color: 'var(--ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis'}}>
                📎 {photoFile.name || 'photo.jpg'} ({Math.round((photoFile.size || 0) / 1024)} KB)
              </span>
              <button
                type="button"
                onClick={() => setPhotoFile(null)}
                style={{
                  background: 'none',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  padding: '4px 10px',
                  fontSize: 12,
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (f) setPhotoFile(f);
              }}
              style={{...inpS, padding: '8px 10px'}}
            />
          )}
          <div style={{fontSize: 11, color: 'var(--ink-muted)', marginTop: 4}}>
            One photo max. Compressed before upload.
          </div>
        </div>

        {err && (
          <div
            style={{
              color: '#b91c1c',
              fontSize: 13,
              marginBottom: 10,
              padding: '8px 12px',
              background: '#fef2f2',
              borderRadius: 10,
            }}
          >
            {err}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting || (!isTodoMode && !configLoaded)}
          style={{
            width: '100%',
            padding: 14,
            border: 'none',
            borderRadius: 10,
            background: '#085041',
            color: 'white',
            fontSize: 15,
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
            fontFamily: 'inherit',
            marginBottom: 16,
          }}
        >
          {submitting ? 'Submitting…' : `Submit ${submissionLabel}`}
        </button>

        <div style={{textAlign: 'center', marginTop: 12}}>
          <button
            onClick={() => {
              window.location.href = '/dailys';
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#085041',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            {'← Back to Webforms'}
          </button>
        </div>
      </div>

      {stuckOpen && (
        <StuckSubmissionsModal
          rows={stuckRows}
          formLabel="Task submission"
          describeRow={(row) => {
            const args = row.record && row.record.args;
            const parent = args && args.parent_in;
            const t = parent ? parent.title : '?';
            const d = parent ? parent.due_date : '?';
            return `${t} · due ${d} (not yet sent)`;
          }}
          onRetry={async (csid) => {
            await retryStuck(csid);
          }}
          onDiscard={async (csid) => {
            await discardStuck(csid);
          }}
          onClose={() => setStuckOpen(false)}
        />
      )}
    </div>
  );
};

export default TasksWebform;
