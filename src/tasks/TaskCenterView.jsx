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
import MyTasksTab from './MyTasksTab.jsx';
import RecurringTab from './RecurringTab.jsx';
import CompletedTab from './CompletedTab.jsx';
import SystemTasksTab from './SystemTasksTab.jsx';
import NewTaskModal from './NewTaskModal.jsx';
import {loadEligibleProfilesById, loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';
import {fireTaskChangeEvent} from '../lib/tasksCenterMutationsApi.js';

const PAGE_BG = {
  minHeight: '100vh',
  background: '#f9fafb',
  fontFamily: 'inherit',
};
const TAB_BAR = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid #e5e7eb',
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
  color: '#6b7280',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const TAB_BTN_ACTIVE = {
  ...TAB_BTN_BASE,
  color: '#085041',
  borderBottom: '2px solid #085041',
};

const TABS = [
  {key: 'mine', label: 'My Tasks'},
  {key: 'recurring', label: 'Recurring'},
  {key: 'completed', label: 'Completed'},
  {key: 'system', label: 'System', adminOnly: true},
];

export default function TaskCenterView({Header, sb, authState}) {
  const [activeTab, setActiveTab] = React.useState('mine');
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);
  const [deepLinkTaskId, setDeepLinkTaskId] = React.useState(null);
  const [deepLinkNonce, setDeepLinkNonce] = React.useState(0);

  const applyDeepLink = React.useCallback(() => {
    const dl = typeof window !== 'undefined' && window._wcfDeepLink;
    if (!dl) return;
    const params = new URLSearchParams(dl);
    const tab = params.get('tab');
    const taskId = params.get('task');
    if (tab === 'completed') setActiveTab('completed');
    else if (taskId && !tab) setActiveTab('mine');
    if (taskId) {
      setDeepLinkTaskId(taskId);
      setDeepLinkNonce((n) => n + 1);
    }
    window._wcfDeepLink = null;
  }, []);

  const onDeepLinkMiss = React.useCallback(() => {
    setActiveTab('completed');
  }, []);

  const onDeepLinkHandled = React.useCallback(() => {
    setDeepLinkTaskId(null);
  }, []);

  React.useEffect(() => {
    applyDeepLink();
  }, [applyDeepLink]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => applyDeepLink();
    window.addEventListener('wcf-task-deep-link', handler);
    return () => window.removeEventListener('wcf-task-deep-link', handler);
  }, [applyDeepLink]);
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
  if (activeTab === 'mine')
    body = React.createElement(MyTasksTab, {
      sb,
      authState,
      deepLinkTaskId,
      deepLinkNonce,
      onDeepLinkMiss,
      onDeepLinkHandled,
    });
  else if (activeTab === 'recurring') body = React.createElement(RecurringTab, {sb, authState});
  else if (activeTab === 'completed')
    body = React.createElement(CompletedTab, {sb, authState, deepLinkTaskId, deepLinkNonce, onDeepLinkHandled});
  else if (activeTab === 'system' && isAdmin) body = React.createElement(SystemTasksTab, {sb, authState});
  else
    body = React.createElement(MyTasksTab, {
      sb,
      authState,
      deepLinkTaskId,
      deepLinkNonce,
      onDeepLinkMiss,
      onDeepLinkHandled,
    });

  return (
    <div style={PAGE_BG} data-view="task-center">
      {Header ? <Header /> : null}
      <div style={{maxWidth: 880, margin: '0 auto', padding: '16px 18px'}}>
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
            <h1 style={{fontSize: 20, margin: 0, color: '#111827'}}>Task Center</h1>
            <div style={{fontSize: 12, color: '#6b7280'}}>
              All open tasks across the farm. Your tasks are highlighted at the top of the My Tasks tab.
            </div>
          </div>
          <button
            type="button"
            data-tasks-new-task-button="1"
            onClick={() => setNewTaskOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
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
