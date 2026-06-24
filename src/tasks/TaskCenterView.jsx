// Task Center — shell + tab framework. Tasks v2.
//
// Mounted at /tasks (view='tasks') in main.jsx. Auth-gated via
// UnauthorizedRedirect with requireAdmin: false — every logged-in
// user sees the Task Center because the v2 RLS makes task_instances
// transparent.
//
// Tabs:
//   My Tasks       — default. Open-task list with row-level Complete
//                    (T7), Edit Due (T8), Reassign / Delete (T9), and
//                    a click-to-view photo lightbox (T6/T7).
//   Recurring      — read-only listing for everyone; admin gains
//                    + New Template / Edit / Delete via T9.
//   Completed      — read-only completed-task review with photo
//                    lightbox (T4 + T6/T7).
//   System Tasks   — admin-only; read-only listing + admin Edit Rule
//                    via T9 (assignee / lead time / active only).
//
// Mutation surfaces:
//   - + New Task button at the view level mounts NewTaskModal (T6).
//   - Per-tab modals for complete / edit-due / assign / delete / template
//     CRUD / system-rule edit. All DB writes flow through
//     tasksCenterMutationsApi wrappers — components never call
//     .insert/.update/.delete on task_* tables directly.
//
// Tasks v2 cutover is complete. The legacy /my-tasks and /admin/tasks
// paths redirect here via the URL adapter's ALIASES_EXACT map (T11);
// the weekly digest links and template are Tasks v2 (T10).

import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import MyTasksTab from './MyTasksTab.jsx';
import RecurringTab from './RecurringTab.jsx';
import CompletedTab from './CompletedTab.jsx';
import SystemTasksTab from './SystemTasksTab.jsx';
import NewTaskModal from './NewTaskModal.jsx';
import TaskInstancePage from './TaskInstancePage.jsx';
import TodoListTab from './TodoListTab.jsx';
import TodoItemPage from './TodoItemPage.jsx';
import {loadEligibleProfilesById, loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';
import {fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';
import {isTodoParticipant, readTasksCenterMode, writeTasksCenterMode} from '../lib/todoApi.js';

const PAGE_BG = {
  minHeight: '100vh',
  background: 'var(--surface-2)',
  fontFamily: 'inherit',
};
const TAB_BAR = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid var(--border)',
  marginBottom: 14,
  flexWrap: 'wrap',
};
const TAB_BTN_BASE = {
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const TAB_BTN_ACTIVE = {
  ...TAB_BTN_BASE,
  color: 'var(--brand)',
  borderBottom: '2px solid var(--brand)',
};

const TABS = [
  {key: 'mine', label: 'My Tasks'},
  {key: 'recurring', label: 'Recurring'},
  {key: 'completed', label: 'Completed'},
  {key: 'system', label: 'System', adminOnly: true},
];

// The deliberately MEATY Task Center | To Do List segmented toggle — a
// substantial control, not a tab sliver. Hidden entirely for roles outside
// the To Do set (equipment_tech keeps the plain Task Center).
const MODE_TOGGLE_WRAP = {
  display: 'flex',
  background: 'white',
  border: '1px solid var(--border-strong)',
  borderRadius: 14,
  padding: 4,
  gap: 4,
  marginBottom: 16,
};
const MODE_BTN_BASE = {
  flex: 1,
  padding: '13px 0',
  borderRadius: 10,
  border: 'none',
  background: 'transparent',
  color: '#000000',
  cursor: 'pointer',
  fontSize: 15,
  fontWeight: 700,
  fontFamily: 'inherit',
  letterSpacing: 0,
};
const MODE_BTN_ACTIVE = {
  ...MODE_BTN_BASE,
  background: '#085041',
  color: '#ffffff',
};

function TasksModeToggle({mode, onChange}) {
  return (
    <div style={MODE_TOGGLE_WRAP} role="group" aria-label="Task Center or To Do List" data-tasks-mode-toggle="1">
      <button
        type="button"
        data-tasks-mode-center="1"
        aria-pressed={mode === 'center'}
        style={mode === 'center' ? MODE_BTN_ACTIVE : MODE_BTN_BASE}
        onClick={() => onChange('center')}
      >
        Task Center
      </button>
      <button
        type="button"
        data-tasks-mode-todo="1"
        aria-pressed={mode === 'todo'}
        style={mode === 'todo' ? MODE_BTN_ACTIVE : MODE_BTN_BASE}
        onClick={() => onChange('todo')}
      >
        To Do List
      </button>
    </div>
  );
}

function TaskCenterView({Header, sb, authState, forceMode}) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState('mine');
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  // To Do access mirrors the server role set; equipment_tech (and anything
  // else outside it) never sees the toggle and always lands in center mode.
  const todoAllowed = isTodoParticipant(authState && authState.role);
  const [mode, setMode] = React.useState(() => {
    if (!todoAllowed) return 'center';
    if (forceMode === 'todo') return 'todo';
    return readTasksCenterMode();
  });

  React.useEffect(() => {
    if (!todoAllowed && mode !== 'center') setMode('center');
  }, [todoAllowed, mode]);

  // A nonparticipant (equipment_tech) who lands on /tasks/todo would otherwise
  // see the Task Center under a To Do URL. Normalize the URL back to /tasks so
  // the address bar never claims a surface the role cannot use.
  React.useEffect(() => {
    if (forceMode === 'todo' && !todoAllowed) {
      navigate('/tasks', {replace: true});
    }
  }, [forceMode, todoAllowed, navigate]);

  function changeMode(next) {
    if (next === mode) return;
    setMode(next);
    writeTasksCenterMode(next);
    // Keep the URL honest so /tasks/todo deep links and the back button
    // behave; the localStorage preference picks the default at plain /tasks.
    navigate(next === 'todo' ? '/tasks/todo' : '/tasks', {replace: true});
  }
  // Two profile maps. profilesById is the unfiltered display map (every
  // eligible profile, used for read-only name resolution on existing
  // tasks/templates/rules including ones already assigned to a profile
  // hidden via Public Tasks availability). assignableProfilesById is
  // the filtered subset shown in mutation dropdowns (NewTask /
  // Reassign / Recurring template / System rule edit) — Codex
  // amendment: hidden profiles must NOT be selectable going forward.
  const [profilesById, setProfilesById] = React.useState({});
  const [assignableProfilesById, setAssignableProfilesById] = React.useState({});
  const isAdmin = authState && authState.role === 'admin';

  const visibleTabs = TABS.filter((t) => !t.adminOnly || isAdmin);

  // Load eligible profiles once at the view level so the NewTaskModal
  // assignee dropdown opens instantly. Tabs that need their own profile
  // map keep loading their own copy — view-level cache is just for the
  // create modal's snappiness.
  React.useEffect(() => {
    if (!sb) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [displayMap, assignableMap] = await Promise.all([
          loadEligibleProfilesById(sb),
          loadTaskAssignableProfilesById(sb),
        ]);
        if (!cancelled) {
          setProfilesById(displayMap);
          setAssignableProfilesById(assignableMap);
        }
      } catch (_e) {
        /* soft-fail; modal will show an empty assignee list and the user
         * can retry by reopening it after a network blip. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb]);

  // React.createElement instead of JSX so ESLint sees the tab-component
  // imports as referenced. Matches main.jsx's view-mounting pattern.
  let body = null;
  if (activeTab === 'mine') body = React.createElement(MyTasksTab, {sb, authState});
  else if (activeTab === 'recurring') body = React.createElement(RecurringTab, {sb, authState});
  else if (activeTab === 'completed') body = React.createElement(CompletedTab, {sb, authState});
  else if (activeTab === 'system' && isAdmin) body = React.createElement(SystemTasksTab, {sb, authState});
  else body = React.createElement(MyTasksTab, {sb, authState});

  if (mode === 'todo' && todoAllowed) {
    return (
      <div style={PAGE_BG} data-view="task-center">
        {Header ? <Header /> : null}
        <div style={{maxWidth: 880, margin: '0 auto', padding: '16px 18px'}}>
          <TasksModeToggle mode={mode} onChange={changeMode} />
          <TodoListTab sb={sb} authState={authState} />
        </div>
      </div>
    );
  }

  return (
    <div style={PAGE_BG} data-view="task-center">
      {Header ? <Header /> : null}
      <div style={{maxWidth: 880, margin: '0 auto', padding: '16px 18px'}}>
        {todoAllowed ? <TasksModeToggle mode={mode} onChange={changeMode} /> : null}
        <div
          style={{
            marginBottom: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div>
            <h1 style={{fontSize: 20, margin: 0, color: 'var(--ink)'}}>Task Center</h1>
            <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
              All open tasks across the farm. Your tasks are highlighted at the top of the My Tasks tab.
            </div>
          </div>
          <button
            type="button"
            data-tasks-new-task-button="1"
            onClick={() => setNewTaskOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid #085041',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            + New Task
          </button>
        </div>
        {React.createElement(NewTaskModal, {
          sb,
          // Pass the assignable subset — NewTaskModal's dropdown must
          // not surface hidden profiles per Codex amendment.
          profilesById: assignableProfilesById,
          // authState drives the One-time / Recurring toggle gate:
          // Light users never see the Recurring option (fail closed).
          authState,
          isOpen: newTaskOpen,
          onClose: () => setNewTaskOpen(false),
          // Fire the cross-component refresh signal so the Header badge
          // and any open tab re-fetch open data without waiting for
          // focus/navigation.
          onCreated: () => {
            fireTaskChangeEvent();
          },
        })}

        <div style={TAB_BAR} role="tablist" data-tasks-tab-bar="1">
          {visibleTabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-tasks-tab-button={t.key}
                onClick={() => setActiveTab(t.key)}
                style={active ? TAB_BTN_ACTIVE : TAB_BTN_BASE}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {body}
      </div>
    </div>
  );
}

export default function TasksRouter({Header, sb, authState}) {
  const location = useLocation();
  const navigate = useNavigate();

  const legacyTaskId = React.useMemo(() => {
    if (location.pathname !== '/tasks') return null;
    const params = new URLSearchParams(location.search);
    return params.get('task') || null;
  }, [location.pathname, location.search]);

  React.useEffect(() => {
    if (legacyTaskId) {
      navigate('/tasks/' + encodeURIComponent(legacyTaskId), {replace: true});
    }
  }, [legacyTaskId, navigate]);

  if (legacyTaskId) return null;

  // /tasks/todo and /tasks/todo/<id> dispatch BEFORE the task-detail branch —
  // otherwise 'todo' or 'todo/<id>' would be misread as a task instance id.
  // The two TaskCenterView branches carry distinct keys so an in-app
  // navigation between /tasks and /tasks/todo REMOUNTS the view and re-runs
  // the mode initializer — without the key, React preserves the instance and
  // forceMode would be ignored after first mount (mode/URL desync).
  if (location.pathname === '/tasks/todo' || location.pathname === '/tasks/todo/') {
    return React.createElement(TaskCenterView, {key: 'todo', Header, sb, authState, forceMode: 'todo'});
  }
  if (location.pathname.startsWith('/tasks/todo/')) {
    return React.createElement(TodoItemPage, {sb, authState, Header});
  }

  const taskDetailId = location.pathname.startsWith('/tasks/')
    ? location.pathname.slice('/tasks/'.length) || null
    : null;

  if (taskDetailId) {
    return React.createElement(TaskInstancePage, {sb, authState, Header});
  }
  return React.createElement(TaskCenterView, {key: 'center', Header, sb, authState});
}
