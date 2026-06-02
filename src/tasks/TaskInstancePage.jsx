import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordSequenceNav from '../shared/RecordSequenceNav.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
/* eslint-disable no-unused-vars -- shell primitives are used in JSX only */
import {
  RecordPageFrame,
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
/* eslint-enable no-unused-vars */
import {recordFormCard, recordFieldRowClass, recordFieldLabel} from '../shared/recordPageControls.jsx';
import {
  loadTaskInstanceById,
  loadEligibleProfilesById,
  loadTaskAssignableProfilesById,
  attributionFor,
  dueStateFor,
  photoPresenceFor,
} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT, fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';
import {fmt, fmtCentralDateTime, todayCentralISO} from '../lib/dateUtils.js';
import CompleteTaskModal from './CompleteTaskModal.jsx';
import TaskPhotoLightbox from './TaskPhotoLightbox.jsx';
import EditDueDateModal from './EditDueDateModal.jsx';
import AssignTaskModal from './AssignTaskModal.jsx';
import DeleteTaskModal from './DeleteTaskModal.jsx';

const BADGE_BASE = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const BADGE_RECURRING = {...BADGE_BASE, background: '#eef2ff', color: '#3730a3'};
const BADGE_SYSTEM = {...BADGE_BASE, background: '#ecfdf5', color: '#047857'};

export default function TaskInstancePage({sb, authState, Header}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recordId = location.pathname.replace('/tasks/', '');
  // Originating list order handed through route state; absent on direct links,
  // legacy ?task redirects, and notification deep-links.
  const recordSeq = location.state?.recordSeq || null;
  function navigateSeq(id) {
    navigate('/tasks/' + id, recordSeqNavOptions(recordSeq));
  }

  const [record, setRecord] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [profiles, setProfiles] = React.useState({});
  const [assignableProfiles, setAssignableProfiles] = React.useState({});

  const [completeTarget, setCompleteTarget] = React.useState(null);
  const [editDueTarget, setEditDueTarget] = React.useState(null);
  const [assignTarget, setAssignTarget] = React.useState(null);
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [photoTarget, setPhotoTarget] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const callerProfileId = authState && authState.user ? authState.user.id : null;
  const isAdmin = authState && authState.role === 'admin';

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [task, profMap, assignableMap] = await Promise.all([
        loadTaskInstanceById(sb, recordId),
        loadEligibleProfilesById(sb),
        loadTaskAssignableProfilesById(sb),
      ]);
      setRecord(task || null);
      setProfiles(profMap || {});
      setAssignableProfiles(assignableMap || {});
    } catch (e) {
      setRecord(null);
      setProfiles({});
      setAssignableProfiles({});
      setLoadError({
        kind: 'error',
        message: 'Could not load task record. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    setRecord(null);
    setLoading(true);
    setNotice(null);
    setLoadError(null);
    loadAll();
  }, [recordId, reloadKey]);

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
    function onChange() {
      setReloadKey((k) => k + 1);
    }
    window.addEventListener(TASK_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(TASK_CHANGE_EVENT, onChange);
  }, []);

  function canComplete(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    return !!(callerProfileId && ti.assignee_profile_id === callerProfileId);
  }

  function canEditDue(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    return !!(callerProfileId && ti.assignee_profile_id === callerProfileId);
  }

  function canAssign(ti) {
    if (!ti || ti.status !== 'open') return false;
    return !!isAdmin;
  }

  function canDelete(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    return !!(
      callerProfileId &&
      ti.created_by_profile_id === callerProfileId &&
      ti.assignee_profile_id === callerProfileId
    );
  }

  function nameFor(profileId) {
    if (!profileId) return null;
    const p = profiles[profileId];
    return p && p.full_name ? p.full_name : 'Unknown user';
  }

  if (loading) {
    return <RecordPageLoading Header={Header} label="Loading…" />;
  }

  if (loadError) {
    return (
      <RecordPageFrame Header={Header}>
        <RecordPageBody maxWidth={760}>
          <RecordBackLink label="Back to Task Center" onBack={() => navigate('/tasks')} />
          <InlineNotice notice={loadError} onDismiss={() => setLoadError(null)} />
        </RecordPageBody>
      </RecordPageFrame>
    );
  }

  if (!record) {
    return (
      <RecordPageNotFound
        Header={Header}
        backLabel="Back to Task Center"
        onBack={() => navigate('/tasks')}
        message="Task not found."
      />
    );
  }

  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={760} data-task-instance-record-loaded="true">
        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

          <RecordBackLink label="Back to Task Center" onBack={() => navigate('/tasks')} />

          <RecordSequenceNav seq={recordSeq} currentId={recordId} onNavigate={navigateSeq} />

          <div style={recordFormCard}>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10}}>
              <RecordTitle fontSize={20} margin={0}>
                {record.title}
              </RecordTitle>
              {record.designation === 'recurring' && <span style={BADGE_RECURRING}>Recurring</span>}
              {record.designation === 'system' && <span style={BADGE_SYSTEM}>System</span>}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 10px',
                  borderRadius: 10,
                  background: record.status === 'open' ? '#d1fae5' : '#f3f4f6',
                  color: record.status === 'open' ? '#065f46' : '#374151',
                  textTransform: 'uppercase',
                }}
              >
                {record.status}
              </span>
            </div>

            <div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Due date</span>
                <span>
                  {fmt(record.due_date)}
                  {(() => {
                    const due = dueStateFor(record, todayCentralISO());
                    if (record.status !== 'open') return null;
                    if (due === 'overdue')
                      return (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            fontWeight: 600,
                            color: '#991b1b',
                            background: '#fef2f2',
                            padding: '1px 6px',
                            borderRadius: 999,
                          }}
                        >
                          Overdue
                        </span>
                      );
                    if (due === 'today')
                      return (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            fontWeight: 600,
                            color: '#92400e',
                            background: '#fffbeb',
                            padding: '1px 6px',
                            borderRadius: 999,
                          }}
                        >
                          Due today
                        </span>
                      );
                    return null;
                  })()}
                </span>
              </div>
              <div className={recordFieldRowClass}>
                <span style={recordFieldLabel}>Assigned to</span>
                <span>{nameFor(record.assignee_profile_id) || 'Unassigned'}</span>
              </div>
              {(() => {
                const attr = attributionFor(record);
                if (!attr) return null;
                return (
                  <div className={recordFieldRowClass}>
                    <span style={recordFieldLabel}>{attr.label}</span>
                    <span>{attr.name}</span>
                  </div>
                );
              })()}
            </div>

            {record.description && (
              <div style={{marginTop: 10, fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap'}}>
                {record.description}
              </div>
            )}

            {record.status === 'completed' && (
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 14px',
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  borderRadius: 8,
                }}
              >
                <div style={{fontSize: 12, fontWeight: 600, color: '#065f46', marginBottom: 4}}>Completed</div>
                <div style={{fontSize: 12, color: '#374151'}}>
                  {fmtCentralDateTime(record.completed_at)}
                  {nameFor(record.completed_by_profile_id) && <> · By {nameFor(record.completed_by_profile_id)}</>}
                </div>
                {record.completion_note && (
                  <div style={{fontSize: 13, color: '#374151', marginTop: 6, whiteSpace: 'pre-wrap'}}>
                    {record.completion_note}
                  </div>
                )}
              </div>
            )}

            {(() => {
              const photo = photoPresenceFor(record);
              if (!photo.hasRequest && !photo.hasCompletion) return null;
              const count = (photo.hasRequest ? 1 : 0) + (photo.hasCompletion ? 1 : 0);
              const label = count === 1 ? '1 photo' : count + ' photos';
              return (
                <div style={{marginTop: 10}}>
                  <button
                    type="button"
                    data-task-photo-open="1"
                    onClick={() => setPhotoTarget(record)}
                    title={label}
                    aria-label={label}
                    style={{
                      background: 'none',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      padding: '4px 10px',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontFamily: 'inherit',
                      color: '#374151',
                    }}
                  >
                    🖼 {label}
                  </button>
                </div>
              );
            })()}

            {record.status === 'open' && (
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12}}>
                {canComplete(record) && (
                  <button
                    type="button"
                    data-task-complete-button="1"
                    onClick={() => setCompleteTarget(record)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      border: '1px solid #085041',
                      background: '#085041',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                    }}
                  >
                    Complete
                  </button>
                )}
                {canEditDue(record) && (
                  <button
                    type="button"
                    data-task-edit-due-button="1"
                    onClick={() => setEditDueTarget(record)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 500,
                      fontFamily: 'inherit',
                    }}
                  >
                    Edit Due
                  </button>
                )}
                {canAssign(record) && (
                  <button
                    type="button"
                    data-task-assign-button="1"
                    onClick={() => setAssignTarget(record)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 500,
                      fontFamily: 'inherit',
                    }}
                  >
                    Reassign
                  </button>
                )}
                {canDelete(record) && (
                  <button
                    type="button"
                    data-task-delete-button="1"
                    onClick={() => setDeleteTarget(record)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      border: '1px solid #b91c1c',
                      background: 'white',
                      color: '#b91c1c',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>

          <RecordCollaborationSection
            sb={sb}
            authState={authState}
            entityType="task.instance"
            entityId={record.id}
            entityLabel={record.title}
            spacing={0}
          />

          {React.createElement(CompleteTaskModal, {
            sb,
            authState,
            task: completeTarget,
            isOpen: !!completeTarget,
            onClose: () => setCompleteTarget(null),
            onCompleted: () => {
              setCompleteTarget(null);
              fireTaskChangeEvent();
              setReloadKey((k) => k + 1);
            },
          })}
          {React.createElement(TaskPhotoLightbox, {
            sb,
            task: photoTarget,
            isOpen: !!photoTarget,
            onClose: () => setPhotoTarget(null),
          })}
          {React.createElement(EditDueDateModal, {
            sb,
            task: editDueTarget,
            isOpen: !!editDueTarget,
            isAdmin,
            profilesById: profiles,
            onClose: () => setEditDueTarget(null),
            onUpdated: () => {
              setEditDueTarget(null);
              fireTaskChangeEvent();
              setReloadKey((k) => k + 1);
            },
          })}
          {React.createElement(AssignTaskModal, {
            sb,
            task: assignTarget,
            isOpen: !!assignTarget,
            profilesById: assignableProfiles,
            onClose: () => setAssignTarget(null),
            onAssigned: () => {
              setAssignTarget(null);
              fireTaskChangeEvent();
              setReloadKey((k) => k + 1);
            },
          })}
          {React.createElement(DeleteTaskModal, {
            sb,
            task: deleteTarget,
            isOpen: !!deleteTarget,
            onClose: () => setDeleteTarget(null),
            onDeleted: () => {
              setDeleteTarget(null);
              fireTaskChangeEvent();
              navigate('/tasks');
            },
          })}
        </div>
      </RecordPageBody>
    </RecordPageFrame>
  );
}
