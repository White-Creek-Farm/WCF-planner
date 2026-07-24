// Task Center — My Tasks tab. Tasks v2.
//
// Layout (Codex 2026-05-13 Operator Clarity pass):
//   Filter chip bar:   All / Overdue / Today / Recurring / System.
//                      Pure client-side filter on the loaded open-task
//                      list. Filters both my-section and other-groups.
//
//   My open tasks (N): bucketed by due state — Overdue, Due today,
//                      Upcoming. Empty sub-buckets are hidden so the
//                      list scans clean when, e.g., nothing's overdue.
//
//   All other open tasks (N): grouped by assignee. The two groups
//                      with the largest open-task counts are expanded
//                      by default ONLY when those groups carry 2+
//                      tasks each — solo-task groups don't represent
//                      workload worth auto-surfacing, and the 2+
//                      threshold keeps the page calm when every
//                      teammate has just one item. When a non-"all"
//                      filter is active, every group with matching
//                      tasks expands so the filter shows its work.
//
// Row-level controls (T6-T9):
//   - Photo thumbnail opens TaskPhotoLightbox; visible when the
//     row carries request_photo_path or completion_photo_path. The
//     button's aria-label / title carries the explicit photo count
//     ("1 photo" / "2 photos") for accessibility.
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
// name from mig 050. Attribution renders on its own line below the
// description for cleaner scanning at every viewport width.

import React from 'react';
import {useNavigate} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
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
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import CompleteTaskModal from './CompleteTaskModal.jsx';
import TaskPhotoLightbox from './TaskPhotoLightbox.jsx';
// eslint-disable-next-line no-unused-vars -- referenced via JSX <TaskPhotoThumbnailButton .../> below
import TaskPhotoThumbnailButton from './TaskPhotoThumbnailButton.jsx';
import EditDueDateModal from './EditDueDateModal.jsx';
import AssignTaskModal from './AssignTaskModal.jsx';
import DeleteTaskModal from './DeleteTaskModal.jsx';

const CARD = {
  background: 'white',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 10,
  boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  border: '1px solid var(--border)',
};
const SUB = {fontSize: 12, color: 'var(--ink-muted)'};
const SECTION_HEADER = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--ink)',
  margin: '14px 0 8px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const BUCKET_HEADER = {
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--ink-muted)',
  margin: '10px 0 6px',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const BUCKET_DOT_OVERDUE = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#dc2626',
};
const BUCKET_DOT_TODAY = {
  ...BUCKET_DOT_OVERDUE,
  background: '#f59e0b',
};
const BUCKET_DOT_UPCOMING = {
  ...BUCKET_DOT_OVERDUE,
  background: '#9ca3af',
};
const GROUP_HEADER = {
  background: 'white',
  border: '1px solid var(--border)',
  borderRadius: 10,
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
  borderRadius: 10,
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
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  fontFamily: 'inherit',
};
const ROW_DANGER_BTN = {
  padding: '4px 10px',
  borderRadius: 10,
  border: '1px solid #b91c1c',
  background: 'white',
  color: '#b91c1c',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const LOAD_RETRY_BTN = {
  padding: '6px 12px',
  borderRadius: 10,
  border: '1px solid #991b1b',
  background: 'white',
  color: '#991b1b',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  marginBottom: 12,
};

const FILTER_BAR = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 6,
};
const FILTER_CHIP_BASE = {
  padding: '5px 12px',
  borderRadius: 999,
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink-muted)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const FILTER_CHIP_ACTIVE = {
  ...FILTER_CHIP_BASE,
  background: 'white',
  border: '1px solid var(--brand)',
  color: 'var(--brand)',
};

const FILTERS = [
  {key: 'all', label: 'All'},
  {key: 'overdue', label: 'Overdue'},
  {key: 'today', label: 'Today'},
  {key: 'recurring', label: 'Recurring'},
  {key: 'system', label: 'System'},
];

// Pure filter predicate. Used to scope both the my-section and the
// other-groups list to the active chip without re-querying.
function matchesFilter(ti, filter, todayStr) {
  if (filter === 'all') return true;
  if (filter === 'overdue') return dueStateFor(ti, todayStr) === 'overdue';
  if (filter === 'today') return dueStateFor(ti, todayStr) === 'today';
  if (filter === 'recurring') return ti.designation === 'recurring';
  if (filter === 'system') return ti.designation === 'system';
  return true;
}

// Bucket my tasks by due state for the three sub-section headers.
// Inputs are already filter-scoped so each bucket reflects the active
// chip. Empty buckets are skipped at render time.
function bucketByDueState(rows, todayStr) {
  const overdue = [];
  const today = [];
  const upcoming = [];
  for (const ti of rows || []) {
    const s = dueStateFor(ti, todayStr);
    if (s === 'overdue') overdue.push(ti);
    else if (s === 'today') today.push(ti);
    else upcoming.push(ti);
  }
  return {overdue, today, upcoming};
}

// eslint-disable-next-line no-unused-vars -- referenced via JSX <TaskRow .../> below
function TaskRow({
  sb,
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
  onNavigate,
}) {
  const due = dueStateFor(ti, todayStr);
  const attribution = attributionFor(ti);
  const photo = photoPresenceFor(ti);
  const openTask = () => {
    if (onNavigate) onNavigate(ti);
  };
  return (
    <div
      className="hoverable-tile"
      data-task-row={ti.id}
      data-task-designation={ti.designation || ''}
      {...openableProps(openTask)}
      aria-label={`Open task: ${ti.title}`}
      style={CARD}
    >
      <div
        style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap'}}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--ink)',
            flex: '1 1 200px',
            minWidth: 0,
            wordBreak: 'break-word',
          }}
        >
          <span>{ti.title}</span>
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
        <div style={{fontSize: 13, color: 'var(--ink)', marginTop: 4, whiteSpace: 'pre-wrap'}}>{ti.description}</div>
      )}
      {attribution && (
        <div style={{...SUB, marginTop: 4}} data-task-attribution-label={attribution.label}>
          {attribution.label}: <span style={{color: 'var(--ink)'}}>{attribution.name}</span>
        </div>
      )}
      <div
        style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8}}
        onClick={(e) => e.stopPropagation()}
      >
        {(photo.hasRequest || photo.hasCompletion) && (
          <TaskPhotoThumbnailButton sb={sb} task={ti} onClick={() => onOpenPhotos && onOpenPhotos(ti)} />
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
  const navigate = useNavigate();
  const [tasks, setTasks] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [assignableProfiles, setAssignableProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [expandedOverride, setExpandedOverride] = React.useState({});
  const [filter, setFilter] = usePersistentViewState('tasks.my.filter', 'all');
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
      setLoading(true);
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
        if (!cancelled) {
          setTasks([]);
          setProfiles({});
          setAssignableProfiles({});
          setErr(e && e.message ? e.message : String(e));
        }
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

  // Apply the active filter chip BEFORE the my/other split + bucketing
  // so counts in section headers reflect what the operator actually
  // sees rendered.
  const visibleTasks = React.useMemo(
    () => tasks.filter((ti) => matchesFilter(ti, filter, todayStr)),
    [tasks, filter, todayStr],
  );
  const {mine, otherGroups} = splitTasksForMyTab(visibleTasks, callerProfileId, profiles);
  const mineBuckets = bucketByDueState(mine, todayStr);
  const mineCount = mine.length;
  const otherCount = otherGroups.reduce((n, g) => n + g.tasks.length, 0);

  // Top-2 pre-expand: when the filter is "all", expand the two groups
  // with the largest task counts AMONG groups that carry 2+ tasks. The
  // 2+ threshold avoids auto-expanding solo-task groups (low signal
  // for cross-team workload scanning) and keeps the page calm when
  // every teammate has just one item. When a narrower filter is
  // active, expand every group that has matching tasks so the
  // filtered view shows its result without an extra click. Manual
  // toggles in expandedOverride win over both defaults.
  const topTwoIds = React.useMemo(() => {
    if (filter !== 'all') return new Set(otherGroups.map((g) => g.profileId || '__unassigned__'));
    const ranked = otherGroups
      .filter((g) => g.tasks.length >= 2)
      .slice()
      .sort((a, b) => b.tasks.length - a.tasks.length)
      .slice(0, 2);
    return new Set(ranked.map((g) => g.profileId || '__unassigned__'));
  }, [otherGroups, filter]);

  function isGroupOpen(key) {
    if (Object.prototype.hasOwnProperty.call(expandedOverride, key)) return !!expandedOverride[key];
    return topTwoIds.has(key);
  }

  function toggleGroup(profileId) {
    const key = profileId || '__unassigned__';
    const current = isGroupOpen(key);
    setExpandedOverride((prev) => ({...prev, [key]: !current}));
  }

  // Visible/rendered order for record sequence nav: My-tasks buckets (overdue →
  // today → upcoming) then ONLY the expanded other-assignee groups. Collapsed
  // groups don't render their rows, so they are excluded from the sequence.
  const taskSeqRows = [
    ...(mineBuckets.overdue || []),
    ...(mineBuckets.today || []),
    ...(mineBuckets.upcoming || []),
    ...otherGroups.filter((g) => isGroupOpen(g.profileId || '__unassigned__')).flatMap((g) => g.tasks),
  ];

  // Reset the per-group manual overrides when the filter changes so the
  // filter-driven defaults take effect (every match expanded). Pre-existing
  // manual toggles on "all" are wiped intentionally — the filter is a
  // separate scan mode, not an enrichment of the previous view.
  React.useEffect(() => {
    setExpandedOverride({});
  }, [filter]);

  function renderBucket(bucketKey, label, dotStyle, rows) {
    if (!rows || rows.length === 0) return null;
    return (
      <div data-tasks-due-bucket={bucketKey} data-tasks-due-bucket-count={rows.length}>
        <div style={BUCKET_HEADER}>
          <span style={dotStyle} aria-hidden="true" />
          {label} ({rows.length})
        </div>
        {rows.map((ti) => (
          <TaskRow
            key={ti.id}
            sb={sb}
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
            onNavigate={(ti) => navigate('/tasks/' + ti.id, recordSeqNavOptions(labeledSeqItems(taskSeqRows, 'title')))}
          />
        ))}
      </div>
    );
  }

  const loadFailed = !!err;

  return (
    <div data-tasks-tab="my-tasks" data-tasks-my-loaded={loading || loadFailed ? 'false' : 'true'}>
      {loadFailed && (
        <div
          data-tasks-error="1"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '8px 12px',
            borderRadius: 10,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {loadFailed && (
        <button
          type="button"
          data-tasks-load-retry="my-tasks"
          onClick={() => setReloadKey((k) => k + 1)}
          style={LOAD_RETRY_BTN}
        >
          Retry
        </button>
      )}

      {loading ? (
        <div style={SUB}>Loading…</div>
      ) : loadFailed ? null : (
        <>
          {/* Filter chip bar — client-side scope on the loaded list.
              Counts in section headers below reflect the active filter
              so the user sees how many rows the chip matched. */}
          {/* Segmented filter — pressable toggle buttons, NOT a tablist.
              role="group" + aria-pressed per button matches the actual
              behavior (no associated tab panels, no roving tabindex);
              role="tablist" would mislead assistive tech into expecting
              ARIA tabs semantics this control does not implement. */}
          <div data-tasks-filter-bar="1" style={FILTER_BAR} role="group" aria-label="Task filter">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  data-tasks-filter-chip={f.key}
                  data-tasks-filter-active={active ? '1' : '0'}
                  aria-pressed={active}
                  onClick={() => setFilter(f.key)}
                  style={active ? FILTER_CHIP_ACTIVE : FILTER_CHIP_BASE}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <div data-tasks-section="mine">
            <div style={SECTION_HEADER}>My open tasks ({mineCount})</div>
            {mineCount === 0 ? (
              <div style={CARD}>
                <div style={{fontSize: 13, color: 'var(--ink)'}}>
                  {filter === 'all'
                    ? 'Nothing assigned to you right now. Browse other open tasks below, or use + New Task above to create one.'
                    : 'No matches for the active filter. Try the All chip, or check the other open tasks below.'}
                </div>
              </div>
            ) : (
              <>
                {renderBucket('overdue', 'Overdue', BUCKET_DOT_OVERDUE, mineBuckets.overdue)}
                {renderBucket('today', 'Due today', BUCKET_DOT_TODAY, mineBuckets.today)}
                {renderBucket('upcoming', 'Upcoming', BUCKET_DOT_UPCOMING, mineBuckets.upcoming)}
              </>
            )}
          </div>

          {/* Processing Center checklist steps are intentionally NOT shown in
              the Task Center (Build Queue item 5). Assigned processing work is
              worked from its Processing record — reached via the Processing
              Center or the assignment notification deep link
              (/processing?record=<id>). The caller-scoped my-processing-subtasks
              RPC (mig 175/178) stays deployed but has no client consumer here.
              Do not reintroduce a processing section into any task_instances
              list surface. */}

          <div data-tasks-section="others" style={{marginTop: 18}}>
            <div style={SECTION_HEADER}>All other open tasks ({otherCount})</div>
            {otherGroups.length === 0 ? (
              <div style={CARD}>
                <div style={{fontSize: 13, color: 'var(--ink)'}}>
                  {filter === 'all' ? 'No other open tasks.' : 'No other open tasks match the active filter.'}
                </div>
              </div>
            ) : (
              otherGroups.map((g) => {
                const key = g.profileId || '__unassigned__';
                const isOpen = isGroupOpen(key);
                return (
                  <div key={key} data-tasks-group={key}>
                    <button type="button" onClick={() => toggleGroup(g.profileId)} style={GROUP_HEADER}>
                      <span style={{fontSize: 14, fontWeight: 600, color: 'var(--ink)'}}>
                        {g.name} <span style={{...SUB, marginLeft: 4}}>({g.tasks.length})</span>
                      </span>
                      <span
                        data-tasks-group-state={isOpen ? 'expanded' : 'collapsed'}
                        style={{fontSize: 13, color: 'var(--ink-muted)'}}
                      >
                        {isOpen ? '▾' : '▸'}
                      </span>
                    </button>
                    {isOpen && (
                      <div data-tasks-group-body={key} style={{paddingLeft: 8, marginBottom: 8}}>
                        {g.tasks.map((ti) => (
                          <TaskRow
                            key={ti.id}
                            sb={sb}
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
                            onNavigate={(ti) =>
                              navigate('/tasks/' + ti.id, recordSeqNavOptions(labeledSeqItems(taskSeqRows, 'title')))
                            }
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
        authState,
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
