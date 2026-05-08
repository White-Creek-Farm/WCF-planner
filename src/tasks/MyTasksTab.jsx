// Task Center — My Tasks tab. Tasks v2.
//
// Layout:
//   Top section: "My open tasks (N)" — tasks where assignee_profile_id
//   is the caller. Always expanded. Sorted by due_date asc so overdue
//   rows surface first.
//
//   Below: every other open task grouped by assignee, each group
//   collapsed by default. Click the group header to expand.
//
// Row-level controls (T6-T9):
//   - Photo affordance (📎) opens TaskPhotoLightbox; visible when the
//     row carries request_photo_path or completion_photo_path.
//   - Complete button (T7) — admin OR caller-as-assignee on open rows.
//   - Edit Due button (T8) — admin OR caller-as-assignee on open rows.
//     Modal mirrors the regular-user 2/2 cap from the RPC.
//   - Reassign button (T9) — admin only on open rows.
//   - Delete button (T9) — admin OR (creator AND assignee both ==
//     caller) on open rows. Typed-confirmation modal.
//
// Designation badges (Recurring / System) come from ti.designation
// per mig 050. Attribution string ("Submitted by ..." / "Created by
// ...") is computed by attributionFor() — public-webform rows show
// the operator name, logged-in-created rows show the locked creator
// name from mig 050.

import React from 'react';
import {
  loadOpenTaskInstances,
  loadEligibleProfilesById,
  loadTaskAssignableProfilesById,
  splitTasksForMyTab,
  attributionFor,
  dueStateFor,
  photoPresenceFor,
} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT, fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import CompleteTaskModal from './CompleteTaskModal.jsx';
import TaskPhotoLightbox from './TaskPhotoLightbox.jsx';
import EditDueDateModal from './EditDueDateModal.jsx';
import AssignTaskModal from './AssignTaskModal.jsx';
import DeleteTaskModal from './DeleteTaskModal.jsx';

const CARD = {
  background: 'white',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 10,
  boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  border: '1px solid #e5e7eb',
};
const SUB = {fontSize: 12, color: '#6b7280'};
const SECTION_HEADER = {
  fontSize: 13,
  fontWeight: 700,
  color: '#374151',
  margin: '14px 0 8px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const GROUP_HEADER = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: '8px 12px',
  marginBottom: 8,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: 'inherit',
  width: '100%',
  textAlign: 'left',
};
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
const BADGE_OVERDUE = {...BADGE_BASE, background: '#fef2f2', color: '#991b1b', marginLeft: 0};
const BADGE_TODAY = {...BADGE_BASE, background: '#fffbeb', color: '#92400e', marginLeft: 0};

const COMPLETE_BTN = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const ROW_GHOST_BTN = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'inherit',
};
const ROW_DANGER_BTN = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #b91c1c',
  background: 'white',
  color: '#b91c1c',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const PHOTO_LINK_BTN = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  // 36px paperclip per Codex amendment — original 12px was too small to
  // notice. Icon-only; visible "Photo" text stays out per the existing
  // T2 lock.
  fontSize: 36,
  lineHeight: 1,
  color: '#6b7280',
  fontFamily: 'inherit',
};

// eslint-disable-next-line no-unused-vars -- referenced via JSX <TaskRow .../> below
function TaskRow({
  ti,
  todayStr,
  canComplete,
  canEditDue,
  canAssign,
  canDelete,
  onComplete,
  onOpenPhotos,
  onEditDue,
  onAssign,
  onDelete,
}) {
  const due = dueStateFor(ti, todayStr);
  const attribution = attributionFor(ti);
  const photo = photoPresenceFor(ti);
  return (
    <div data-task-row={ti.id} data-task-designation={ti.designation || ''} style={CARD}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10}}>
        <div style={{fontSize: 15, fontWeight: 600, color: '#111827', flex: 1}}>
          {ti.title}
          {ti.designation === 'recurring' && (
            <span data-task-badge="recurring" style={BADGE_RECURRING}>
              Recurring
            </span>
          )}
          {ti.designation === 'system' && (
            <span data-task-badge="system" style={BADGE_SYSTEM}>
              System
            </span>
          )}
        </div>
        <div style={{...SUB, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6}}>
          {due === 'overdue' && (
            <span data-due-state="overdue" style={BADGE_OVERDUE}>
              Overdue
            </span>
          )}
          {due === 'today' && (
            <span data-due-state="today" style={BADGE_TODAY}>
              Due today
            </span>
          )}
          <span data-due-date={ti.due_date}>{ti.due_date}</span>
        </div>
      </div>
      {ti.description && (
        <div style={{fontSize: 13, color: '#374151', marginTop: 4, whiteSpace: 'pre-wrap'}}>{ti.description}</div>
      )}
      <div style={{display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 8}}>
        {attribution && (
          <span style={SUB} data-task-attribution-label={attribution.label}>
            {attribution.label}: <span style={{color: '#374151'}}>{attribution.name}</span>
          </span>
        )}
        {(photo.hasRequest || photo.hasCompletion) && (
          <button
            type="button"
            data-task-has-photo="1"
            data-task-photo-open="1"
            onClick={() => onOpenPhotos && onOpenPhotos(ti)}
            title="Task has at least one photo"
            aria-label="Task has at least one photo"
            style={PHOTO_LINK_BTN}
          >
            📎
          </button>
        )}
        {canComplete && (
          <button
            type="button"
            data-task-complete-button="1"
            onClick={() => onComplete && onComplete(ti)}
            style={COMPLETE_BTN}
          >
            Complete
          </button>
        )}
        {canEditDue && (
          <button
            type="button"
            data-task-edit-due-button="1"
            onClick={() => onEditDue && onEditDue(ti)}
            style={ROW_GHOST_BTN}
          >
            Edit Due
          </button>
        )}
        {canAssign && (
          <button
            type="button"
            data-task-assign-button="1"
            onClick={() => onAssign && onAssign(ti)}
            style={ROW_GHOST_BTN}
          >
            Reassign
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            data-task-delete-button="1"
            onClick={() => onDelete && onDelete(ti)}
            style={ROW_DANGER_BTN}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export default function MyTasksTab({sb, authState}) {
  const [tasks, setTasks] = React.useState([]);
  // profiles is the unfiltered display map (for row name rendering).
  // assignableProfiles is the filtered subset for write-modal dropdowns
  // — hidden profiles via Public Tasks availability are excluded.
  const [profiles, setProfiles] = React.useState({});
  const [assignableProfiles, setAssignableProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [expanded, setExpanded] = React.useState({}); // {assigneeProfileId: bool}
  const [completeTaskTarget, setCompleteTaskTarget] = React.useState(null);
  const [photoTaskTarget, setPhotoTaskTarget] = React.useState(null);
  const [editDueTarget, setEditDueTarget] = React.useState(null);
  const [assignTarget, setAssignTarget] = React.useState(null);
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const callerProfileId = authState && authState.user ? authState.user.id : null;
  const isAdmin = authState && authState.role === 'admin';

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      try {
        const [list, profMap, assignableMap] = await Promise.all([
          loadOpenTaskInstances(sb),
          loadEligibleProfilesById(sb),
          loadTaskAssignableProfilesById(sb),
        ]);
        if (!cancelled) {
          setTasks(list);
          setProfiles(profMap);
          setAssignableProfiles(assignableMap);
        }
      } catch (e) {
        if (!cancelled) setErr(e && e.message ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, reloadKey]);

  // Listen for cross-component create/complete events so a task created
  // through the +New Task modal (or completed via the Complete modal in
  // a sibling render path) refreshes My Tasks without waiting for focus.
  React.useEffect(() => {
    function onChange() {
      setReloadKey((k) => k + 1);
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener(TASK_CHANGE_EVENT, onChange);
    }
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener(TASK_CHANGE_EVENT, onChange);
      }
    };
  }, []);

  function canCompleteRow(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    if (callerProfileId && ti.assignee_profile_id === callerProfileId) return true;
    return false;
  }

  // T8: due-date edit visibility — admin always; regular user only when
  // assignee. The RPC also enforces a 2/2 cap for regular users; the
  // modal mirrors it client-side. We let the modal render even when
  // the cap is hit so the user can read the history; Save is disabled.
  function canEditDueRow(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    if (callerProfileId && ti.assignee_profile_id === callerProfileId) return true;
    return false;
  }

  // T9: assign — admin only (RPC enforces).
  function canAssignRow(ti) {
    if (!ti || ti.status !== 'open') return false;
    return !!isAdmin;
  }

  // T9: delete — admin can delete any open task; regular user can only
  // delete tasks where they are BOTH creator and assignee (RPC enforces
  // the same; we hide the button to keep the row uncluttered).
  function canDeleteRow(ti) {
    if (!ti || ti.status !== 'open') return false;
    if (isAdmin) return true;
    if (callerProfileId && ti.created_by_profile_id === callerProfileId && ti.assignee_profile_id === callerProfileId) {
      return true;
    }
    return false;
  }

  // todayCentralISO ties due-state comparisons to America/Chicago, so
  // overdue / due-today doesn't drift on a phone set to a different
  // timezone (Ronnie's date-only / Central-time lock for tasks).
  const todayStr = todayCentralISO();
  const {mine, otherGroups} = splitTasksForMyTab(tasks, callerProfileId, profiles);

  function toggleGroup(profileId) {
    const key = profileId || '__unassigned__';
    setExpanded((prev) => ({...prev, [key]: !prev[key]}));
  }

  return (
    <div data-tasks-tab="my-tasks">
      {err && (
        <div
          data-tasks-error="1"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {loading ? (
        <div style={SUB}>Loading…</div>
      ) : (
        <>
          <div data-tasks-section="mine">
            <div style={SECTION_HEADER}>My open tasks ({mine.length})</div>
            {mine.length === 0 ? (
              <div style={CARD}>
                <div style={{fontSize: 13, color: '#374151'}}>Nothing assigned to you right now.</div>
              </div>
            ) : (
              mine.map((ti) => (
                <TaskRow
                  key={ti.id}
                  ti={ti}
                  todayStr={todayStr}
                  canComplete={canCompleteRow(ti)}
                  canEditDue={canEditDueRow(ti)}
                  canAssign={canAssignRow(ti)}
                  canDelete={canDeleteRow(ti)}
                  onComplete={setCompleteTaskTarget}
                  onOpenPhotos={setPhotoTaskTarget}
                  onEditDue={setEditDueTarget}
                  onAssign={setAssignTarget}
                  onDelete={setDeleteTarget}
                />
              ))
            )}
          </div>

          <div data-tasks-section="others" style={{marginTop: 18}}>
            <div style={SECTION_HEADER}>
              All other open tasks ({otherGroups.reduce((n, g) => n + g.tasks.length, 0)})
            </div>
            {otherGroups.length === 0 ? (
              <div style={CARD}>
                <div style={{fontSize: 13, color: '#374151'}}>No other open tasks.</div>
              </div>
            ) : (
              otherGroups.map((g) => {
                const key = g.profileId || '__unassigned__';
                const isOpen = !!expanded[key];
                return (
                  <div key={key} data-tasks-group={key}>
                    <button type="button" onClick={() => toggleGroup(g.profileId)} style={GROUP_HEADER}>
                      <span style={{fontSize: 14, fontWeight: 600, color: '#111827'}}>
                        {g.name} <span style={{...SUB, marginLeft: 4}}>({g.tasks.length})</span>
                      </span>
                      <span
                        data-tasks-group-state={isOpen ? 'expanded' : 'collapsed'}
                        style={{fontSize: 13, color: '#6b7280'}}
                      >
                        {isOpen ? '▾' : '▸'}
                      </span>
                    </button>
                    {isOpen && (
                      <div data-tasks-group-body={key} style={{paddingLeft: 8, marginBottom: 8}}>
                        {g.tasks.map((ti) => (
                          <TaskRow
                            key={ti.id}
                            ti={ti}
                            todayStr={todayStr}
                            canComplete={canCompleteRow(ti)}
                            canEditDue={canEditDueRow(ti)}
                            canAssign={canAssignRow(ti)}
                            canDelete={canDeleteRow(ti)}
                            onComplete={setCompleteTaskTarget}
                            onOpenPhotos={setPhotoTaskTarget}
                            onEditDue={setEditDueTarget}
                            onAssign={setAssignTarget}
                            onDelete={setDeleteTarget}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {React.createElement(CompleteTaskModal, {
        sb,
        task: completeTaskTarget,
        isOpen: !!completeTaskTarget,
        onClose: () => setCompleteTaskTarget(null),
        onCompleted: () => {
          setCompleteTaskTarget(null);
          fireTaskChangeEvent();
          setReloadKey((k) => k + 1);
        },
      })}
      {React.createElement(TaskPhotoLightbox, {
        sb,
        task: photoTaskTarget,
        isOpen: !!photoTaskTarget,
        onClose: () => setPhotoTaskTarget(null),
      })}
      {React.createElement(EditDueDateModal, {
        sb,
        // Resolve to the live tasks-row each render so a click handler
        // captured before the most recent reload doesn't pin stale data
        // (due_date / edit-count) into the modal. Falls back to the
        // captured ref so the modal still renders on a transient miss.
        task: editDueTarget ? tasks.find((t) => t.id === editDueTarget.id) || editDueTarget : null,
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
        // Reassign dropdown must NOT surface hidden profiles — pass the
        // filtered assignable map.
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
          setReloadKey((k) => k + 1);
        },
      })}
    </div>
  );
}
