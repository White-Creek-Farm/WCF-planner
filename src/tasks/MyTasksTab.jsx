// Task Center — My Tasks tab. Read-only in T2 (Tasks v2). Layout:
//
//   Top section: "My open tasks (N)" — tasks where assignee_profile_id
//   is the caller. Always expanded. Sorted by due_date asc so overdue
//   rows surface first.
//
//   Below: every other open task grouped by assignee, each group
//   collapsed by default. Click the group header to expand.
//
// No mutations: no complete buttons, no due-date editors, no
// assign/delete UI, no photo upload. Photo indicator (📎) renders
// when the row carries request_photo_path or completion_photo_path.
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
  splitTasksForMyTab,
  attributionFor,
  dueStateFor,
  photoPresenceFor,
} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT, fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import CompleteTaskModal from './CompleteTaskModal.jsx';
import TaskPhotoLightbox from './TaskPhotoLightbox.jsx';

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
const PHOTO_LINK_BTN = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 12,
  color: '#6b7280',
  fontFamily: 'inherit',
};

// eslint-disable-next-line no-unused-vars -- referenced via JSX <TaskRow .../> below
function TaskRow({ti, todayStr, canComplete, onComplete, onOpenPhotos}) {
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
      </div>
    </div>
  );
}

export default function MyTasksTab({sb, authState}) {
  const [tasks, setTasks] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [expanded, setExpanded] = React.useState({}); // {assigneeProfileId: bool}
  const [completeTaskTarget, setCompleteTaskTarget] = React.useState(null);
  const [photoTaskTarget, setPhotoTaskTarget] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const callerProfileId = authState && authState.user ? authState.user.id : null;
  const isAdmin = authState && authState.role === 'admin';

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      try {
        const [list, profMap] = await Promise.all([loadOpenTaskInstances(sb), loadEligibleProfilesById(sb)]);
        if (!cancelled) {
          setTasks(list);
          setProfiles(profMap);
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
                  onComplete={setCompleteTaskTarget}
                  onOpenPhotos={setPhotoTaskTarget}
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
                            onComplete={setCompleteTaskTarget}
                            onOpenPhotos={setPhotoTaskTarget}
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
    </div>
  );
}
