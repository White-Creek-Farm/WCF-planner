// ============================================================================
// Static lock for Tasks v2 T2 — Task Center route wiring + read-only contract.
// ----------------------------------------------------------------------------
// What this guards:
//
//   1. /tasks route is wired into the router.
//        - src/lib/routes.js maps view='tasks' to '/tasks'.
//   2. main.jsx imports TaskCenterView and mounts it under /tasks via
//      UnauthorizedRedirect with requireAdmin: false.
//   3. main.jsx VALID_VIEWS includes 'tasks' so the URL adapter does not
//      snap the user back to home on first hit.
//   4. T2 components and the tasksCenterApi helper are READ-ONLY:
//        - No calls to any of the six v2 mutation RPCs.
//        - No direct .insert / .update / .delete on task_instances or
//          related tables.
//        - No calls to v1 complete_task_instance.
//        - No imports from tasksAdminApi / tasksUserApi (which carry
//          mutation wrappers).
//        - No storage uploads to task-photos / task-request-photos.
//
// Reverting any of these would silently break a hard gate Codex pinned
// in the T2 brief. The intent is that T3+ commits add a separate
// tasksCenterMutationsApi module; until then T2 components must not
// transact with the database for writes through any path.
// ============================================================================

import {describe, it, expect} from 'vitest';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const routesJs = fs.readFileSync(path.join(ROOT, 'src/lib/routes.js'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const headerJsx = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');
const taskCenterView = fs.readFileSync(path.join(ROOT, 'src/tasks/TaskCenterView.jsx'), 'utf8');
const myTasksTab = fs.readFileSync(path.join(ROOT, 'src/tasks/MyTasksTab.jsx'), 'utf8');
const recurringTab = fs.readFileSync(path.join(ROOT, 'src/tasks/RecurringTab.jsx'), 'utf8');
const completedTab = fs.readFileSync(path.join(ROOT, 'src/tasks/CompletedTab.jsx'), 'utf8');
const systemTasksTab = fs.readFileSync(path.join(ROOT, 'src/tasks/SystemTasksTab.jsx'), 'utf8');
const tasksCenterApi = fs.readFileSync(path.join(ROOT, 'src/lib/tasksCenterApi.js'), 'utf8');
const tasksCenterMutationsApi = fs.readFileSync(path.join(ROOT, 'src/lib/tasksCenterMutationsApi.js'), 'utf8');
const newTaskModal = fs.readFileSync(path.join(ROOT, 'src/tasks/NewTaskModal.jsx'), 'utf8');
const completeTaskModal = fs.readFileSync(path.join(ROOT, 'src/tasks/CompleteTaskModal.jsx'), 'utf8');
const taskPhotoLightbox = fs.readFileSync(path.join(ROOT, 'src/tasks/TaskPhotoLightbox.jsx'), 'utf8');
const editDueDateModal = fs.readFileSync(path.join(ROOT, 'src/tasks/EditDueDateModal.jsx'), 'utf8');
const assignTaskModal = fs.readFileSync(path.join(ROOT, 'src/tasks/AssignTaskModal.jsx'), 'utf8');
const deleteTaskModal = fs.readFileSync(path.join(ROOT, 'src/tasks/DeleteTaskModal.jsx'), 'utf8');
const recurringTemplateModal = fs.readFileSync(path.join(ROOT, 'src/tasks/RecurringTemplateModal.jsx'), 'utf8');
const systemRuleEditModal = fs.readFileSync(path.join(ROOT, 'src/tasks/SystemRuleEditModal.jsx'), 'utf8');
const tasksSummaryFn = fs.readFileSync(path.join(ROOT, 'supabase/functions/tasks-summary/index.ts'), 'utf8');
const rapidProcessorFn = fs.readFileSync(path.join(ROOT, 'supabase-functions/rapid-processor.ts'), 'utf8');
const headerJsxFull = headerJsx;

const T2_FILES = {
  'TaskCenterView.jsx': taskCenterView,
  'MyTasksTab.jsx': myTasksTab,
  'RecurringTab.jsx': recurringTab,
  'CompletedTab.jsx': completedTab,
  'SystemTasksTab.jsx': systemTasksTab,
  'tasksCenterApi.js': tasksCenterApi,
};

const FORBIDDEN_RPC_NAMES = [
  'complete_task_instance',
  'create_one_time_task_instance',
  'update_task_instance_due_date',
  'assign_task_instance',
  'delete_task_instance',
  'generate_system_task_instance',
];

describe('Tasks v2 T2 — /tasks route wiring', () => {
  it('routes.js maps view "tasks" to /tasks', () => {
    expect(routesJs).toMatch(/tasks:\s*'\/tasks'/);
  });

  it('main.jsx imports TaskCenterView from src/tasks/', () => {
    expect(mainJsx).toMatch(/import\s+TaskCenterView\s+from\s+'\.\/tasks\/TaskCenterView\.jsx'/);
  });

  it('main.jsx VALID_VIEWS includes "tasks"', () => {
    // VALID_VIEWS is a flat array literal in main.jsx; assert the entry
    // is present without depending on its exact ordering.
    const validBlock = mainJsx.match(/VALID_VIEWS\s*=\s*\[([\s\S]*?)\]/);
    expect(validBlock).not.toBeNull();
    expect(validBlock[1]).toMatch(/'tasks'/);
  });

  it('main.jsx mounts TaskCenterView at view==="tasks" via UnauthorizedRedirect with requireAdmin:false', () => {
    // The mount block must wire requireAdmin: false (every logged-in
    // user can reach the Task Center) AND pass Header/sb/authState
    // to TaskCenterView.
    expect(mainJsx).toMatch(
      /if\s*\(view\s*===\s*'tasks'\)[\s\S]*?UnauthorizedRedirect[\s\S]*?requireAdmin:\s*false[\s\S]*?TaskCenterView,\s*\{Header,\s*sb,\s*authState\}/,
    );
  });

  // T11 inversion: the legacy view mounts are gone; /my-tasks and
  // /admin/tasks now redirect to /tasks via ALIASES_EXACT.
  it('main.jsx no longer mounts the legacy myTasks view (T11 retired)', () => {
    expect(mainJsx).not.toMatch(/if\s*\(view\s*===\s*'myTasks'\)/);
    expect(mainJsx).not.toMatch(/MyTasksView/);
  });

  it('main.jsx no longer mounts the legacy adminTasks view (T11 retired)', () => {
    expect(mainJsx).not.toMatch(/if\s*\(view\s*===\s*'adminTasks'\)/);
    expect(mainJsx).not.toMatch(/AdminTasksView/);
  });
});

describe('Tasks v2 T2 — read-only contract on T2 components and helper', () => {
  for (const rpc of FORBIDDEN_RPC_NAMES) {
    it(`no T2 file calls ${rpc}`, () => {
      for (const [name, src] of Object.entries(T2_FILES)) {
        expect(src, `${name} must not reference ${rpc}`).not.toMatch(new RegExp(rpc));
      }
    });
  }

  it('no T2 file calls .insert / .update / .delete on task_instances or task tables', () => {
    // We check for the chained pattern .from('task_*')...{insert|update|delete}
    // and the bare RPC-style invocations. Pure read flows use .select.
    const writeChain =
      /\.from\(\s*['"](task_instances|task_templates|task_instance_photos|task_instance_due_date_edits|task_system_rules)['"]\s*\)\s*[\s\S]{0,200}?\.(insert|update|delete|upsert)\s*\(/;
    for (const [name, src] of Object.entries(T2_FILES)) {
      expect(src, `${name} must not write to task_* tables directly`).not.toMatch(writeChain);
    }
  });

  it('no T2 file imports the mutation modules tasksAdminApi or tasksUserApi', () => {
    for (const [name, src] of Object.entries(T2_FILES)) {
      expect(src, `${name} must not import tasksAdminApi`).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
      expect(src, `${name} must not import tasksUserApi`).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
    }
  });

  it('no T2 file uploads to the task-photos or task-request-photos buckets', () => {
    for (const [name, src] of Object.entries(T2_FILES)) {
      expect(src, `${name} must not call storage.upload`).not.toMatch(/\.storage\.from\([^)]*\)\.upload\s*\(/);
    }
  });

  it('TaskCenterView gates the System Tasks tab to admin only', () => {
    // The TABS array marks System Tasks adminOnly; the visibleTabs
    // filter drops adminOnly entries when isAdmin is false. Lock both
    // so removing either silently exposes the tab to non-admins.
    expect(taskCenterView).toMatch(/key:\s*'system'[\s\S]*?adminOnly:\s*true/);
    expect(taskCenterView).toMatch(/visibleTabs\s*=\s*TABS\.filter\(\(t\)\s*=>\s*!t\.adminOnly\s*\|\|\s*isAdmin\)/);
  });

  it('MyTasksTab uses the read-only loader, not a write RPC', () => {
    expect(myTasksTab).toMatch(/loadOpenTaskInstances/);
    expect(myTasksTab).not.toMatch(/sb\.rpc\(/);
  });

  // Codex T2 round-2 fix #1: assignee names come from the SECDEF
  // list_eligible_assignees RPC (mig 041), not from a direct profiles
  // SELECT. The RPC works for non-admin users regardless of profiles
  // RLS and never leaks role/email through the wire.
  it('tasksCenterApi uses list_eligible_assignees and never reads profiles directly', () => {
    expect(tasksCenterApi).toMatch(/sb\.rpc\(\s*['"]list_eligible_assignees['"]\s*\)/);
    expect(tasksCenterApi).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
  });

  it('no T2 file reads the profiles table directly', () => {
    for (const [name, src] of Object.entries(T2_FILES)) {
      expect(src, `${name} must not call .from('profiles') in T2`).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    }
  });

  // Codex T2 round-2 fix #2: due-state comparison must run in
  // America/Chicago (Ronnie's date-only / Central-time lock for
  // tasks). MyTasksTab must use the dateUtils helper, not raw
  // browser-local Date formatting.
  it('MyTasksTab uses todayCentralISO and not browser-local Date formatting', () => {
    expect(myTasksTab).toMatch(/from\s+['"]\.\.\/lib\/dateUtils\.js['"]/);
    expect(myTasksTab).toMatch(/todayCentralISO\(\)/);
    // Negative locks: no raw .getFullYear / .getMonth / .getDate at
    // call sites (these would re-introduce browser-local drift).
    expect(myTasksTab).not.toMatch(/\.getFullYear\(\)/);
    expect(myTasksTab).not.toMatch(/\.getMonth\(\)/);
    expect(myTasksTab).not.toMatch(/\.getDate\(\)/);
  });

  // Codex T2 round-2 fix #3: photo indicator is icon-only in
  // collapsed rows (Ronnie's lock — only icon unless expanded).
  // The Activity-Phase-1 polish replaced the paperclip with a photo
  // icon and switched the aria-label/title to a concrete photo count
  // ("1 photo" / "2 photos"). The "no extra visible word" rule still
  // applies — only the glyph, with the count carried in metadata.
  it('MyTasksTab photo indicator is icon-only with title/aria-label, no visible "Photo" text', () => {
    expect(myTasksTab).toMatch(/data-task-has-photo="1"/);
    expect(myTasksTab).toMatch(/data-task-photo-count=\{count\}/);
    // Label is now a template string for "{count} photos" / "1 photo".
    expect(myTasksTab).toMatch(/const label = count === 1 \? '1 photo' : `\$\{count\} photos`/);
    expect(myTasksTab).toMatch(/aria-label=\{label\}/);
    expect(myTasksTab).toMatch(/title=\{label\}/);
    // Negative locks: no inline "Photo" word, and no paperclip glyph
    // in live render code (the doc comment up top mentions the
    // historical paperclip — strip comments before the negative scan
    // so the lock doesn't trip on its own context).
    const code = myTasksTab.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/🖼\s+Photo/);
    expect(code).not.toContain('📎');
  });
});

// ============================================================================
// Tasks v2 T3 — Header Tasks button + own due/past-due badge.
// ----------------------------------------------------------------------------
// What this guards:
//   1. HeaderBase imports the read-only count helper from tasksCenterApi
//      and the Central-time helper from dateUtils. Reverting either to a
//      mutation module or browser-local Date math would silently change
//      the badge contract.
//   2. The Tasks button has data-tasks-header-link="1" and navigates via
//      setView('tasks'). Renaming the attribute breaks Playwright; pointing
//      it elsewhere breaks the route guarantee.
//   3. The badge has data-tasks-header-badge and renders ONLY when the
//      count is > 0 (no empty pill). Removing the conditional would leak
//      a zero-count pill into the dark bar.
//   4. The Header useEffect deps include sb, callerProfileId, AND view —
//      the view dep is the explicit Codex amendment so the badge catches
//      up after legacy /my-tasks completions.
//   5. Header soft-fails: any loader error sets count=0, never throws out
//      of Header. A try/catch around the count call is the contract.
//   6. main.jsx threads sb into the HeaderBase closure so the Header can
//      query the DB without ad-hoc context plumbing.
// ============================================================================

describe('Tasks v2 T3 — Header Tasks button + own due/past-due badge', () => {
  it('HeaderBase imports countMyOpenDueOrPastTasks from tasksCenterApi', () => {
    expect(headerJsx).toMatch(
      /import\s*\{\s*countMyOpenDueOrPastTasks\s*\}\s*from\s*['"]\.\.\/lib\/tasksCenterApi\.js['"]/,
    );
  });

  it('HeaderBase imports todayCentralISO from dateUtils', () => {
    expect(headerJsx).toMatch(/import\s*\{\s*todayCentralISO\s*\}\s*from\s*['"]\.\.\/lib\/dateUtils\.js['"]/);
  });

  it('HeaderBase does NOT import a mutation module (tasksAdminApi/tasksUserApi)', () => {
    expect(headerJsx).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
    expect(headerJsx).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
  });

  it('HeaderBase signature accepts sb prop', () => {
    expect(headerJsx).toMatch(/export default function Header\(\s*\{\s*sb\s*,/);
  });

  it('Header Tasks button has data-tasks-header-link and navigates to the tasks view', () => {
    expect(headerJsx).toMatch(/data-tasks-header-link="1"/);
    // Post-Notifications-prep (2026-05-14): the Tasks button click handler
    // now uses the shared go(view) helper instead of inline setView. go()
    // closes any open form drawers + closes the burger before delegating
    // to setView, so the route guarantee still holds.
    expect(headerJsx).toMatch(/data-tasks-header-link="1"[\s\S]*?onClick=\{\(\) => go\(\s*['"]tasks['"]\s*\)\}/);
  });

  it('Header badge has data-tasks-header-badge and renders only when count > 0', () => {
    // Conditional render: the badge JSX sits under {myDueCount > 0 && (...)}.
    expect(headerJsx).toMatch(/myDueCount\s*>\s*0\s*&&[\s\S]*?data-tasks-header-badge/);
  });

  it('Header useEffect deps include sb, callerProfileId, AND view (Codex T3 amendment)', () => {
    // The dep array is on the useEffect that calls countMyOpenDueOrPastTasks.
    expect(headerJsx).toMatch(
      /countMyOpenDueOrPastTasks[\s\S]*?\}\s*,\s*\[\s*sb\s*,\s*callerProfileId\s*,\s*view\s*\]/,
    );
  });

  it('Header soft-fails: count effect wraps the call in try/catch', () => {
    // The refresh() inner function must wrap its loader call in try/catch
    // so a transient DB error never throws out of Header rendering.
    expect(headerJsx).toMatch(/try\s*\{[\s\S]*?countMyOpenDueOrPastTasks[\s\S]*?\}\s*catch/);
  });

  it('main.jsx Header closure factory threads sb into HeaderBase', () => {
    // The factory at line ~3097 must include `sb,` in its prop bag so
    // HeaderBase has access to the supabase client.
    expect(mainJsx).toMatch(/React\.createElement\(HeaderBase,\s*\{\s*sb\s*,/);
  });
});

// ============================================================================
// Tasks v2 T4 — Completed + Recurring functional read-only contract.
// ----------------------------------------------------------------------------
// Both tabs must remain strictly read-only:
//   - import only from tasksCenterApi (no admin/user modules);
//   - never call any v2 mutation RPC (covered by the FORBIDDEN_RPC_NAMES
//     loop above — both tabs are already in T2_FILES);
//   - never write to any task_* table (covered by the write-chain check
//     above);
//   - never upload to storage (covered by the upload check above);
//   - render no edit/delete affordance (asserted negatively below).
//
// In addition, the Completed tab uses Central-time formatting for
// completed_at, and the Recurring tab uses the pure groupRecurringByTemplate
// helper so the orphan grouping stays testable.
// ============================================================================

describe('Tasks v2 T4 — Completed tab read-only contract', () => {
  it('CompletedTab imports loaders from tasksCenterApi only', () => {
    expect(completedTab).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterApi\.js['"]/);
    expect(completedTab).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
    expect(completedTab).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
  });

  it('CompletedTab calls loadCompletedTaskInstances and loadEligibleProfilesById', () => {
    expect(completedTab).toMatch(/loadCompletedTaskInstances/);
    expect(completedTab).toMatch(/loadEligibleProfilesById/);
  });

  it('CompletedTab buttons are limited to photo-lightbox + view-only filter chips (no edit/save/delete/complete)', () => {
    // T6/T7 added a photo-affordance button that opens the lightbox.
    // The 2026-05-13 remaining-tabs pass added view-only filter chips
    // (All / Recurring / System / With photos / With notes) on the
    // completed list. Each button must be one of those two read-only
    // affordances — locking by the data-* marker on every button keeps
    // a future drift from slipping an edit/save/delete/complete write
    // handler in without that marker also showing up.
    const buttonOnClicks = Array.from(completedTab.matchAll(/<button\b[\s\S]*?onClick=\{[\s\S]*?\}/g), (m) => m[0]);
    for (const btn of buttonOnClicks) {
      const isPhotoOpen = /data-task-photo-open="1"/.test(btn);
      const isFilterChip = /data-tasks-filter-chip=/.test(btn);
      const isLoadRetry = /data-tasks-load-retry="completed"/.test(btn);
      expect(
        isPhotoOpen || isFilterChip || isLoadRetry,
        'every CompletedTab button must be a photo-open affordance, a filter chip, or load retry',
      ).toBe(true);
    }
  });

  it('CompletedTab uses fmtCentralDateTime for completed_at (Central-time display lock)', () => {
    expect(completedTab).toMatch(/fmtCentralDateTime/);
    // Negative lock: no toLocaleString / toLocaleTimeString that would
    // re-introduce browser-zone drift.
    expect(completedTab).not.toMatch(/toLocaleString\(\)/);
    expect(completedTab).not.toMatch(/toLocaleTimeString\(\)/);
  });

  it('CompletedTab does not read profiles directly', () => {
    expect(completedTab).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
  });
});

describe('Tasks v2 T4 — Recurring tab read-only contract', () => {
  it('RecurringTab imports loaders from tasksCenterApi only', () => {
    expect(recurringTab).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterApi\.js['"]/);
    expect(recurringTab).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
    expect(recurringTab).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
  });

  it('RecurringTab calls loadRecurringTaskTemplates + loadOpenRecurringInstances + groupRecurringByTemplate', () => {
    expect(recurringTab).toMatch(/loadRecurringTaskTemplates/);
    expect(recurringTab).toMatch(/loadOpenRecurringInstances/);
    expect(recurringTab).toMatch(/groupRecurringByTemplate/);
  });

  it('RecurringTab does not reference template mutation helpers', () => {
    // upsertTaskTemplate / deleteTaskTemplate live in tasksAdminApi.js;
    // they must not appear in any Recurring tab read path.
    expect(recurringTab).not.toMatch(/upsertTaskTemplate/);
    expect(recurringTab).not.toMatch(/deleteTaskTemplate/);
  });

  it('RecurringTab admin write controls are gated by isAdmin (T9)', () => {
    // The + New Template button, per-template Edit, and per-template Delete
    // buttons all live inside `{isAdmin && (...)}` blocks so a non-admin
    // never sees the affordance. Lock the gate so a future drift can't
    // accidentally render the buttons unconditionally.
    expect(recurringTab).toMatch(/\{isAdmin\s*&&[\s\S]*?data-recurring-new-button="1"/);
    expect(recurringTab).toMatch(/\{isAdmin\s*&&[\s\S]*?data-recurring-edit-button=/);
    expect(recurringTab).toMatch(/\{isAdmin\s*&&[\s\S]*?data-recurring-delete-button=/);
  });

  it('RecurringTab does not read profiles directly', () => {
    expect(recurringTab).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
  });
});

describe('Tasks v2 T3+T4 — tasksCenterApi loader shape', () => {
  it('countMyOpenDueOrPastTasks scopes to status=open + caller assignee + due_date<=today', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+countMyOpenDueOrPastTasks/);
    // The body of countMyOpenDueOrPastTasks must combine status=open,
    // assignee_profile_id eq, and due_date lte. Lock the substrings; they
    // sit close together inside the chained .from('task_instances') call.
    const body = tasksCenterApi.match(/export\s+async\s+function\s+countMyOpenDueOrPastTasks[\s\S]*?\n\}/);
    expect(body, 'body of countMyOpenDueOrPastTasks must be present').not.toBeNull();
    expect(body[0]).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]open['"]\s*\)/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]assignee_profile_id['"]\s*,\s*callerProfileId\s*\)/);
    expect(body[0]).toMatch(/\.lte\(\s*['"]due_date['"]\s*,\s*todayStr\s*\)/);
  });

  it('loadCompletedTaskInstances scopes to status=completed', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadCompletedTaskInstances/);
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadCompletedTaskInstances[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]completed['"]\s*\)/);
  });

  it('loadOpenRecurringInstances scopes to designation=recurring AND status=open', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadOpenRecurringInstances/);
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadOpenRecurringInstances[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]open['"]\s*\)/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]designation['"]\s*,\s*['"]recurring['"]\s*\)/);
  });

  it('groupRecurringByTemplate is exported as a pure helper', () => {
    expect(tasksCenterApi).toMatch(/export\s+function\s+groupRecurringByTemplate\s*\(/);
  });
});

// ============================================================================
// Tasks v2 T5 — System Tasks tab read-only contract.
// ----------------------------------------------------------------------------
// SystemTasksTab is admin-gated in TaskCenterView (covered by an existing
// T2 lock). Inside the tab, all data flows through tasksCenterApi read
// helpers; no mutation paths exist. The most dangerous regression here
// would be importing or calling generate_system_task_instance — that RPC
// drives system-task generation and any frontend reference would be a
// product-design break (generation is owned by the cron Edge Function,
// not the operator UI). Lock all six v2 mutation RPCs negatively, plus
// the storage/upload/profiles negatives the other T2/T4 tabs already
// enforce.
// ============================================================================

describe('Tasks v2 T5 — System Tasks tab read-only contract', () => {
  it('SystemTasksTab imports loaders from tasksCenterApi only', () => {
    expect(systemTasksTab).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterApi\.js['"]/);
    expect(systemTasksTab).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
    expect(systemTasksTab).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
  });

  it('SystemTasksTab calls loadSystemTaskRules + loadOpenSystemTaskInstances + groupSystemTasksByRule', () => {
    expect(systemTasksTab).toMatch(/loadSystemTaskRules/);
    expect(systemTasksTab).toMatch(/loadOpenSystemTaskInstances/);
    expect(systemTasksTab).toMatch(/groupSystemTasksByRule/);
  });

  it('SystemTasksTab references no v2 mutation RPC names (especially generate_system_task_instance)', () => {
    for (const rpc of FORBIDDEN_RPC_NAMES) {
      expect(systemTasksTab, `SystemTasksTab must not reference ${rpc}`).not.toMatch(new RegExp(rpc));
    }
  });

  it('SystemTasksTab writes to no task_* tables', () => {
    const writeChain =
      /\.from\(\s*['"](task_instances|task_templates|task_instance_photos|task_instance_due_date_edits|task_system_rules)['"]\s*\)\s*[\s\S]{0,200}?\.(insert|update|delete|upsert)\s*\(/;
    expect(systemTasksTab).not.toMatch(writeChain);
  });

  it('SystemTasksTab uploads to no storage bucket', () => {
    expect(systemTasksTab).not.toMatch(/\.storage\.from\([^)]*\)\.upload\s*\(/);
  });

  it('SystemTasksTab admin Edit Rule button is gated by isAdmin (T9)', () => {
    // T9 added a per-rule Edit Rule button. It must live inside an
    // `{isAdmin && (...)}` gate so non-admins never see it (the System
    // Tasks tab itself is already admin-only at the TaskCenterView
    // level, but the in-tab gate is an extra defense).
    expect(systemTasksTab).toMatch(/\{isAdmin\s*&&[\s\S]*?data-system-rule-edit-button=/);
  });

  it('SystemTasksTab does not read profiles directly', () => {
    expect(systemTasksTab).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
  });

  it('SystemTasksTab reads task_system_rules only through tasksCenterApi (no direct .from on this file)', () => {
    expect(systemTasksTab).not.toMatch(/\.from\(\s*['"]task_system_rules['"]\s*\)/);
  });

  it('TaskCenterView still gates the System Tasks tab to admin only after T5 wiring', () => {
    // T5 swaps the placeholder for the functional component but must NOT
    // remove the adminOnly flag or the visibleTabs filter — duplicates
    // T2's existing lock so a future reorg can't drop just this part.
    expect(taskCenterView).toMatch(/key:\s*'system'[\s\S]*?adminOnly:\s*true/);
    expect(taskCenterView).toMatch(/visibleTabs\s*=\s*TABS\.filter\(\(t\)\s*=>\s*!t\.adminOnly\s*\|\|\s*isAdmin\)/);
    // And the system tab body must still be conditional on isAdmin so a
    // direct activeTab='system' from a non-admin can't render the body.
    expect(taskCenterView).toMatch(/activeTab\s*===\s*'system'\s*&&\s*isAdmin/);
  });
});

describe('Tasks v2 T5 — tasksCenterApi system-task loader shape', () => {
  it('loadSystemTaskRules reads task_system_rules', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadSystemTaskRules/);
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadSystemTaskRules[\s\S]*?\n\}/);
    expect(body, 'body of loadSystemTaskRules must be present').not.toBeNull();
    expect(body[0]).toMatch(/\.from\(\s*['"]task_system_rules['"]\s*\)/);
  });

  it('loadOpenSystemTaskInstances scopes to status=open AND (designation=system OR from_system_rule_id IS NOT NULL)', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadOpenSystemTaskInstances/);
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadOpenSystemTaskInstances[\s\S]*?\n\}/);
    expect(body, 'body of loadOpenSystemTaskInstances must be present').not.toBeNull();
    expect(body[0]).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]open['"]\s*\)/);
    // PostgREST .or() is the only way to express the union; lock the
    // exact arg string so a future swap to a single .eq filter (which
    // would silently drop one of the two row populations) trips the
    // static check.
    expect(body[0]).toMatch(/\.or\(\s*['"]designation\.eq\.system,from_system_rule_id\.not\.is\.null['"]\s*\)/);
  });

  it('groupSystemTasksByRule is exported as a pure helper', () => {
    expect(tasksCenterApi).toMatch(/export\s+function\s+groupSystemTasksByRule\s*\(/);
  });
});

// ============================================================================
// Tasks v2 T6 + T7 — NewTaskModal, CompleteTaskModal, TaskPhotoLightbox.
// ----------------------------------------------------------------------------
// /tasks operational surfaces. All DB writes flow through v2 SECDEF RPCs in
// src/lib/tasksCenterMutationsApi.js. Static lock asserts:
//   * NewTaskModal / CompleteTaskModal / TaskPhotoLightbox import only from
//     tasksCenterMutationsApi for mutations (no tasksAdminApi / tasksUserApi
//     legacy wrappers).
//   * NewTaskModal calls create_one_time_task_instance with p_instance and
//     p_creation_photo_paths.
//   * CompleteTaskModal calls complete_task_instance with p_instance_id,
//     p_completion_note, p_completion_photo_paths — never the v1
//     p_completion_photo_path single-arg shape.
//   * Neither modal sets created_by_*, designation, from_recurring_template,
//     or from_system_rule_id in payloads (server-locked).
//   * No T6/T7 file references the other v2 mutation RPCs we don't own:
//     update_task_instance_due_date / assign_task_instance /
//     delete_task_instance / generate_system_task_instance.
//   * No direct .insert/.update/.delete on task_* tables from any T6/T7 file.
//   * Upload helpers stay append-only (upsert:false + duplicate-as-success).
//   * Completion photo paths use task.assignee_profile_id, not the caller.
//   * Header listens for the TASK_CHANGE_EVENT refresh signal.
// ============================================================================

const T6_T7_FILES = {
  'NewTaskModal.jsx': newTaskModal,
  'CompleteTaskModal.jsx': completeTaskModal,
  'TaskPhotoLightbox.jsx': taskPhotoLightbox,
};

const T6_T7_FORBIDDEN_RPC_NAMES = [
  'update_task_instance_due_date',
  'assign_task_instance',
  'delete_task_instance',
  'generate_system_task_instance',
];

describe('Tasks v2 T6 + T7 — mutation modules import boundary', () => {
  it('NewTaskModal / CompleteTaskModal / TaskPhotoLightbox import from tasksCenterMutationsApi', () => {
    expect(newTaskModal).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterMutationsApi\.js['"]/);
    expect(completeTaskModal).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterMutationsApi\.js['"]/);
    expect(taskPhotoLightbox).toMatch(/from\s+['"]\.\.\/lib\/tasksCenterMutationsApi\.js['"]/);
  });

  it('No T6/T7 file imports tasksAdminApi or tasksUserApi (legacy v1 wrappers stay out of /tasks)', () => {
    for (const [name, src] of Object.entries(T6_T7_FILES)) {
      expect(src, `${name} must not import tasksAdminApi`).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
      expect(src, `${name} must not import tasksUserApi`).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
    }
  });

  it('No T6/T7 file calls v2 mutation RPCs we do not own (due_date/assign/delete/system-generate)', () => {
    for (const rpc of T6_T7_FORBIDDEN_RPC_NAMES) {
      for (const [name, src] of Object.entries(T6_T7_FILES)) {
        expect(src, `${name} must not reference ${rpc}`).not.toMatch(new RegExp(rpc));
      }
    }
  });

  it('No T6/T7 file writes directly to task_* tables', () => {
    const writeChain =
      /\.from\(\s*['"](task_instances|task_templates|task_instance_photos|task_instance_due_date_edits|task_system_rules)['"]\s*\)\s*[\s\S]{0,200}?\.(insert|update|delete|upsert)\s*\(/;
    for (const [name, src] of Object.entries(T6_T7_FILES)) {
      expect(src, `${name} must not write to task_* tables directly`).not.toMatch(writeChain);
    }
  });
});

describe('Tasks v2 T6 — create_one_time_task_instance wrapper contract', () => {
  it('createOneTimeTaskInstanceV2 calls create_one_time_task_instance with p_instance + p_creation_photo_paths', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+createOneTimeTaskInstanceV2/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+createOneTimeTaskInstanceV2[\s\S]*?\n\}/);
    expect(body, 'createOneTimeTaskInstanceV2 body must be present').not.toBeNull();
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]create_one_time_task_instance['"]/);
    expect(body[0]).toMatch(/p_instance\s*:/);
    expect(body[0]).toMatch(/p_creation_photo_paths\s*:/);
  });

  it('NewTaskModal payload omits server-locked fields (created_by_*, designation, recurring/system markers)', () => {
    // The payload object literal lives near createOneTimeTaskInstanceV2.
    // None of these field names should appear in the modal source — the
    // v2 RPC locks them server-side and a client-side write would silently
    // be ignored or rejected.
    expect(newTaskModal).not.toMatch(/created_by_profile_id/);
    expect(newTaskModal).not.toMatch(/created_by_display_name/);
    expect(newTaskModal).not.toMatch(/designation\s*:/);
    expect(newTaskModal).not.toMatch(/from_recurring_template/);
    expect(newTaskModal).not.toMatch(/from_system_rule_id/);
  });

  it('NewTaskModal mints stable id + client_submission_id once per modal open', () => {
    // The idsRef pattern keeps id+csid stable across re-renders so a
    // retry hits the same storage path AND the same RPC csid (the RPC
    // dedupes via ON CONFLICT (client_submission_id) DO NOTHING).
    expect(newTaskModal).toMatch(/idsRef/);
    expect(newTaskModal).toMatch(/client_submission_id/);
  });

  it('uploadTaskCreationPhotos stays append-only (upsert:false + duplicate-as-success)', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+uploadTaskCreationPhotos/);
    expect(tasksCenterMutationsApi).toMatch(/upsert:\s*false/);
    expect(tasksCenterMutationsApi).toMatch(/isStorageDuplicateError/);
  });
});

describe('Tasks v2 T7 — complete_task_instance wrapper contract', () => {
  it('completeTaskInstanceV2 calls complete_task_instance with v2 named args (note + paths array)', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+completeTaskInstanceV2/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+completeTaskInstanceV2[\s\S]*?\n\}/);
    expect(body, 'completeTaskInstanceV2 body must be present').not.toBeNull();
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]complete_task_instance['"]/);
    expect(body[0]).toMatch(/p_instance_id\s*:/);
    expect(body[0]).toMatch(/p_completion_note\s*:/);
    expect(body[0]).toMatch(/p_completion_photo_paths\s*:/);
  });

  it('No T6/T7 file uses the v1 single-arg p_completion_photo_path shape', () => {
    // The v1 overload from mig 040 takes (text, text DEFAULT NULL) and
    // a body carrying p_completion_photo_path (singular). PostgREST
    // routes by named-arg match, so the v1 shape MUST NOT appear in any
    // /tasks code or it would silently fall through to v1 instead of v2.
    for (const [name, src] of Object.entries(T6_T7_FILES)) {
      expect(src, `${name} must not use v1 p_completion_photo_path shape`).not.toMatch(
        /p_completion_photo_path\b(?!_)/,
      );
    }
    expect(tasksCenterMutationsApi).not.toMatch(/p_completion_photo_path\b(?!_)/);
  });

  it('CompleteTaskModal uploads to task.assignee_profile_id, not the caller', () => {
    // Per §7 the completion-photo path prefix must use the row's
    // assignee_profile_id even when admin completes someone else's task.
    // The upload helper takes assigneeUid as its first arg; this lock
    // ensures the modal passes task.assignee_profile_id, not authState
    // or callerProfileId. Match the CALL site (uploadTaskCompletionPhotos
    // followed by `(`), not the import line.
    const callBody = completeTaskModal.match(/uploadTaskCompletionPhotos\(\s*[\s\S]*?\)/);
    expect(callBody, 'uploadTaskCompletionPhotos invocation must be present in CompleteTaskModal').not.toBeNull();
    expect(callBody[0]).toMatch(/task\.assignee_profile_id/);
  });

  it('uploadTaskCompletionPhotos stays append-only (upsert:false + duplicate-as-success)', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+uploadTaskCompletionPhotos/);
    // upsert:false + isStorageDuplicateError already asserted globally
    // above; this lock pins that the helper exists by name.
  });
});

describe('Tasks v2 T6 + T7 — Header listens for TASK_CHANGE_EVENT', () => {
  it('Header imports TASK_CHANGE_EVENT from tasksCenterMutationsApi', () => {
    expect(headerJsx).toMatch(
      /import\s*\{\s*TASK_CHANGE_EVENT\s*\}\s*from\s*['"]\.\.\/lib\/tasksCenterMutationsApi\.js['"]/,
    );
  });

  it('Header registers a window listener on TASK_CHANGE_EVENT inside the badge effect', () => {
    expect(headerJsx).toMatch(/addEventListener\(\s*TASK_CHANGE_EVENT/);
    expect(headerJsx).toMatch(/removeEventListener\(\s*TASK_CHANGE_EVENT/);
  });
});

describe('Tasks v2 T6 + T7 — TaskCenterView wires NewTaskModal', () => {
  it('TaskCenterView renders + New Task button and mounts NewTaskModal', () => {
    expect(taskCenterView).toMatch(/data-tasks-new-task-button="1"/);
    expect(taskCenterView).toMatch(/import\s+NewTaskModal\s+from\s+['"]\.\/NewTaskModal\.jsx['"]/);
  });

  it('TaskCenterView fires TASK_CHANGE_EVENT after a successful create', () => {
    expect(taskCenterView).toMatch(/fireTaskChangeEvent\s*\(/);
  });
});

// ============================================================================
// Tasks v2 T8 + T9 — due-date edits, assign/delete, recurring + system admin.
// ----------------------------------------------------------------------------
// Locks:
//   * EditDueDateModal / AssignTaskModal / DeleteTaskModal /
//     RecurringTemplateModal / SystemRuleEditModal import only from
//     tasksCenterMutationsApi for mutations.
//   * Each modal calls the right v2 RPC by name and arg shape.
//   * No T8/T9 file references generate_system_task_instance.
//   * No window.confirm / window.alert / window.prompt anywhere in T8/T9.
//   * SystemRuleEditModal does not write id, generator_kind, name, or
//     description (server-side guarded too, but a missing client filter
//     is still a bug).
//   * RecurringTab admin write buttons are gated by isAdmin (covered above).
// ============================================================================

const T8_T9_FILES = {
  'EditDueDateModal.jsx': editDueDateModal,
  'AssignTaskModal.jsx': assignTaskModal,
  'DeleteTaskModal.jsx': deleteTaskModal,
  'RecurringTemplateModal.jsx': recurringTemplateModal,
  'SystemRuleEditModal.jsx': systemRuleEditModal,
};

describe('Tasks v2 T8 + T9 — module import boundary', () => {
  it('Every T8/T9 modal imports from tasksCenterMutationsApi', () => {
    for (const [name, src] of Object.entries(T8_T9_FILES)) {
      expect(src, `${name} must import tasksCenterMutationsApi`).toMatch(
        /from\s+['"]\.\.\/lib\/tasksCenterMutationsApi\.js['"]/,
      );
    }
  });

  it('No T8/T9 file imports legacy tasksAdminApi or tasksUserApi', () => {
    for (const [name, src] of Object.entries(T8_T9_FILES)) {
      expect(src, `${name} must not import tasksAdminApi`).not.toMatch(/from\s+['"][^'"]*tasksAdminApi[^'"]*['"]/);
      expect(src, `${name} must not import tasksUserApi`).not.toMatch(/from\s+['"][^'"]*tasksUserApi[^'"]*['"]/);
    }
  });

  it('No T8/T9 file references generate_system_task_instance', () => {
    for (const [name, src] of Object.entries(T8_T9_FILES)) {
      expect(src, `${name} must not reference generate_system_task_instance`).not.toMatch(
        /generate_system_task_instance/,
      );
    }
  });

  it('No T8/T9 file calls window.confirm / window.alert / window.prompt', () => {
    for (const [name, src] of Object.entries(T8_T9_FILES)) {
      expect(src, `${name} must not call window.confirm`).not.toMatch(/window\.confirm\s*\(/);
      expect(src, `${name} must not call window.alert`).not.toMatch(/window\.alert\s*\(/);
      expect(src, `${name} must not call window.prompt`).not.toMatch(/window\.prompt\s*\(/);
    }
  });

  it('RecurringTab does not call window.confirm (typed-confirm modal lock)', () => {
    expect(recurringTab).not.toMatch(/window\.confirm\s*\(/);
  });
});

describe('Tasks v2 T8 — update_task_instance_due_date wrapper contract', () => {
  it('updateTaskInstanceDueDateV2 calls update_task_instance_due_date with p_instance_id + p_new_due_date', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+updateTaskInstanceDueDateV2/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+updateTaskInstanceDueDateV2[\s\S]*?\n\}/);
    expect(body, 'updateTaskInstanceDueDateV2 body must be present').not.toBeNull();
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]update_task_instance_due_date['"]/);
    expect(body[0]).toMatch(/p_instance_id\s*:/);
    expect(body[0]).toMatch(/p_new_due_date\s*:/);
  });

  it('EditDueDateModal calls updateTaskInstanceDueDateV2', () => {
    expect(editDueDateModal).toMatch(/updateTaskInstanceDueDateV2\s*\(/);
  });

  it('loadDueDateEditHistory reads task_instance_due_date_edits ordered by edited_at desc', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadDueDateEditHistory/);
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadDueDateEditHistory[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.from\(\s*['"]task_instance_due_date_edits['"]\s*\)/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]instance_id['"]/);
    expect(body[0]).toMatch(/\.order\(\s*['"]edited_at['"]/);
  });
});

describe('Tasks v2 T9 — assign / delete instance wrappers', () => {
  it('assignTaskInstanceV2 calls assign_task_instance with p_instance_id + p_assignee_profile_id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+assignTaskInstanceV2/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+assignTaskInstanceV2[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]assign_task_instance['"]/);
    expect(body[0]).toMatch(/p_instance_id\s*:/);
    expect(body[0]).toMatch(/p_assignee_profile_id\s*:/);
  });

  it('deleteTaskInstanceV2 calls delete_task_instance with p_instance_id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+deleteTaskInstanceV2/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+deleteTaskInstanceV2[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]delete_task_instance['"]/);
    expect(body[0]).toMatch(/p_instance_id\s*:/);
  });

  it('AssignTaskModal calls assignTaskInstanceV2; DeleteTaskModal calls deleteTaskInstanceV2', () => {
    expect(assignTaskModal).toMatch(/assignTaskInstanceV2\s*\(/);
    expect(deleteTaskModal).toMatch(/deleteTaskInstanceV2\s*\(/);
  });

  it('DeleteTaskModal uses typed-confirmation, not window.confirm', () => {
    expect(deleteTaskModal).toMatch(/data-delete-task-field="confirm"/);
    expect(deleteTaskModal).not.toMatch(/window\.confirm\s*\(/);
  });
});

describe('Tasks v2 T9 — recurring template admin CRUD wrappers', () => {
  it('upsertRecurringTaskTemplate writes to task_templates via .upsert with onConflict id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+upsertRecurringTaskTemplate/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+upsertRecurringTaskTemplate[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.from\(\s*['"]task_templates['"]\s*\)\s*\.upsert/);
    expect(body[0]).toMatch(/onConflict:\s*['"]id['"]/);
  });

  it('updateRecurringTaskTemplate writes to task_templates via .update + .eq id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+updateRecurringTaskTemplate/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+updateRecurringTaskTemplate[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.from\(\s*['"]task_templates['"]\s*\)\s*\.update/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]id['"]/);
  });

  it('deleteRecurringTaskTemplate writes to task_templates via .delete + .eq id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+deleteRecurringTaskTemplate/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+deleteRecurringTaskTemplate[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.from\(\s*['"]task_templates['"]\s*\)\s*\.delete/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]id['"]/);
  });

  it('RecurringTemplateModal calls the upsert/update wrappers (not legacy tasksAdminApi names)', () => {
    expect(recurringTemplateModal).toMatch(/upsertRecurringTaskTemplate\s*\(/);
    expect(recurringTemplateModal).toMatch(/updateRecurringTaskTemplate\s*\(/);
    // Negative locks: legacy names from tasksAdminApi must not appear.
    expect(recurringTemplateModal).not.toMatch(/upsertTaskTemplate\b/);
    expect(recurringTemplateModal).not.toMatch(/deleteTaskTemplate\b/);
  });

  // Codex T9 amendment: the recurrence dropdown must render every value
  // from RECURRENCE_OPTIONS (src/lib/tasks.js) — once / daily / weekly /
  // biweekly / monthly / quarterly. A hard-coded subset would prevent
  // creating quarterly templates and would render once/quarterly rows
  // with a blank value when editing legacy data. Lock the import + the
  // derive-from-array shape so the modal can't drift away from the
  // canonical list.
  it('RecurringTemplateModal imports RECURRENCE_OPTIONS from tasks.js (no hard-coded recurrence subset)', () => {
    expect(recurringTemplateModal).toMatch(
      /import\s*\{\s*RECURRENCE_OPTIONS\s*\}\s*from\s*['"]\.\.\/lib\/tasks\.js['"]/,
    );
  });

  it('RecurringTemplateModal derives its dropdown options from RECURRENCE_OPTIONS', () => {
    // The map() call ties the visible options to the source array. A
    // future regression that switches back to a hard-coded array literal
    // would lose this match.
    expect(recurringTemplateModal).toMatch(/RECURRENCE_OPTIONS\.map\(/);
  });

  it('RecurringTemplateModal lists labels for every value in the recurrence enum', () => {
    // The label map sits next to the import. Lock that every value the
    // task_templates.recurrence CHECK accepts has a non-empty label so
    // the dropdown never shows a bare value like "once". Match either
    // quoted-key (`'once': 'One-time'`) or shorthand-key (`once: 'One-time'`)
    // object literal syntax — both are valid JS.
    const enumValues = ['once', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly'];
    for (const v of enumValues) {
      expect(recurringTemplateModal, `RECURRENCE_LABELS must include '${v}'`).toMatch(
        new RegExp(`(?:['"]${v}['"]|\\b${v})\\s*:\\s*['"][^'"]+['"]`),
      );
    }
  });

  it('RecurringTab calls deleteRecurringTaskTemplate (not legacy deleteTaskTemplate)', () => {
    expect(recurringTab).toMatch(/deleteRecurringTaskTemplate\s*\(/);
    expect(recurringTab).not.toMatch(/\bdeleteTaskTemplate\b/);
  });
});

describe('Tasks v2 T9 — system rule update wrapper contract', () => {
  it('updateSystemTaskRule writes to task_system_rules via .update + .eq id', () => {
    expect(tasksCenterMutationsApi).toMatch(/export\s+async\s+function\s+updateSystemTaskRule/);
    const body = tasksCenterMutationsApi.match(/export\s+async\s+function\s+updateSystemTaskRule[\s\S]*?\n\}/);
    expect(body[0]).toMatch(/\.from\(\s*['"]task_system_rules['"]\s*\)\s*\.update/);
    expect(body[0]).toMatch(/\.eq\(\s*['"]id['"]/);
  });

  it('updateSystemTaskRule whitelists only assignee_profile_id, lead_time_days, active (no id/generator_kind/name/description)', () => {
    // The SYSTEM_RULE_UPDATE_COLUMNS array literal is the gate; lock its
    // shape so a future drift can't broaden the surface to mutable name
    // / generator_kind / id (those changes would silently break the
    // Edge Function dispatcher).
    expect(tasksCenterMutationsApi).toMatch(/SYSTEM_RULE_UPDATE_COLUMNS\s*=\s*\[\s*['"]assignee_profile_id['"]/);
    const colsBlock = tasksCenterMutationsApi.match(/SYSTEM_RULE_UPDATE_COLUMNS\s*=\s*\[([\s\S]*?)\]/);
    expect(colsBlock, 'SYSTEM_RULE_UPDATE_COLUMNS array must be present').not.toBeNull();
    expect(colsBlock[1]).toMatch(/['"]assignee_profile_id['"]/);
    expect(colsBlock[1]).toMatch(/['"]lead_time_days['"]/);
    expect(colsBlock[1]).toMatch(/['"]active['"]/);
    expect(colsBlock[1]).not.toMatch(/['"]id['"]/);
    expect(colsBlock[1]).not.toMatch(/['"]generator_kind['"]/);
    expect(colsBlock[1]).not.toMatch(/['"]name['"]/);
    expect(colsBlock[1]).not.toMatch(/['"]description['"]/);
  });

  it('SystemRuleEditModal renders id and generator_kind in a read-only block, never as editable inputs', () => {
    // The read-only block carries data-system-rule-readonly-id and
    // data-system-rule-readonly-kind. There must be no editable input
    // (data-system-rule-field) for those columns.
    expect(systemRuleEditModal).toMatch(/data-system-rule-readonly-id/);
    expect(systemRuleEditModal).toMatch(/data-system-rule-readonly-kind/);
    expect(systemRuleEditModal).not.toMatch(/data-system-rule-field=['"]?id['"]?/);
    expect(systemRuleEditModal).not.toMatch(/data-system-rule-field=['"]?generator-kind['"]?/);
    expect(systemRuleEditModal).not.toMatch(/data-system-rule-field=['"]?name['"]?/);
    expect(systemRuleEditModal).not.toMatch(/data-system-rule-field=['"]?description['"]?/);
  });

  it('SystemRuleEditModal calls updateSystemTaskRule', () => {
    expect(systemRuleEditModal).toMatch(/updateSystemTaskRule\s*\(/);
  });
});

describe('Tasks v2 T8 + T9 — MyTasksTab row-level capability gating', () => {
  it('MyTasksTab gates Reassign and Delete buttons by canAssignRow / canDeleteRow', () => {
    // The TaskRow renders the buttons under canAssign / canDelete props;
    // those props are populated by canAssignRow / canDeleteRow which
    // gate on isAdmin (assign) and admin OR creator==assignee==caller
    // (delete). Lock both helper names so a future drift can't drop the
    // gate.
    expect(myTasksTab).toMatch(/function\s+canAssignRow/);
    expect(myTasksTab).toMatch(/function\s+canDeleteRow/);
    expect(myTasksTab).toMatch(/canAssignRow\(ti\)/);
    expect(myTasksTab).toMatch(/canDeleteRow\(ti\)/);
  });
});

// ============================================================================
// Tasks v2 T10 — weekly digest links to /tasks (not /my-tasks).
// ----------------------------------------------------------------------------
// The digest is now Tasks v2 — every link in the email body must point at
// /tasks, the canonical Task Center. A regression that brought back
// /my-tasks would land users on a route that has been retired (T11) and
// now just redirects, but a dead-named link in branded mail looks broken.
// Lock the link target string + the absence of /my-tasks anywhere in the
// digest plumbing.
// ============================================================================

describe('Tasks v2 T10 — weekly digest link target (/tasks)', () => {
  it('rapid-processor tasks_weekly_summary template links to wcfplanner.com/tasks', () => {
    expect(rapidProcessorFn).toMatch(/href="https:\/\/wcfplanner\.com\/tasks"/);
  });

  it('rapid-processor tasks_weekly_summary template never links to /my-tasks', () => {
    expect(rapidProcessorFn).not.toMatch(/wcfplanner\.com\/my-tasks/);
    expect(rapidProcessorFn).not.toMatch(/href="[^"]*\/my-tasks/);
  });

  it('tasks-summary Edge Function never references /my-tasks', () => {
    // The function generates JSON payloads, not HTML, but a regression
    // that pasted a legacy URL into a debug log or comment would still
    // be misleading. Belt-and-suspenders.
    expect(tasksSummaryFn).not.toMatch(/\/my-tasks/);
  });

  it('tasks-summary Edge Function selects the v2 context columns the email template surfaces', () => {
    // The new template renders designation badge, created-by attribution,
    // photo presence, and description. The select() must include each of
    // those columns or the digest renders empty fields.
    const selectMatch = tasksSummaryFn.match(/\.from\('task_instances'\)\s*\.select\(\s*['"]([^'"]+)['"]/);
    expect(selectMatch, 'task_instances .select(...) must be present').not.toBeNull();
    const selected = selectMatch[1];
    for (const col of [
      'designation',
      'created_by_display_name',
      'request_photo_path',
      'completion_photo_path',
      'description',
    ]) {
      expect(selected, `tasks-summary select must include ${col}`).toContain(col);
    }
  });

  it('tasks-summary preserves cron auth contract (TASKS_CRON_SECRET + service-role bearer)', () => {
    // T10 must not weaken the auth boundary. The function still reads
    // both Vault secrets and authenticateCron still byte-compares both.
    expect(tasksSummaryFn).toMatch(/TASKS_CRON_SECRET/);
    expect(tasksSummaryFn).toMatch(/TASKS_CRON_SERVICE_ROLE_KEY/);
    expect(tasksSummaryFn).toMatch(/safeEqual\(bearer,\s*TASKS_CRON_SERVICE_ROLE_KEY\)/);
  });

  it('tasks-summary preserves probe + audit + cron-test_to-rejection contracts', () => {
    // probe path writes a tsr-probe-* row and returns early.
    expect(tasksSummaryFn).toMatch(/'tsr-probe-'/);
    expect(tasksSummaryFn).toMatch(/probe-only invocation/);
    // cron mode rejects test_to post-auth.
    expect(tasksSummaryFn).toMatch(/test_to is not allowed in cron mode/);
    // audit row writer still hits task_summary_runs.
    expect(tasksSummaryFn).toMatch(/from\('task_summary_runs'\)\s*\.insert/);
  });

  it('rapid-processor still gates tasks_weekly_summary in-function (no auth weakening)', () => {
    // The handler must still byte-compare a caller-supplied secret
    // before any send work, so an anonymous caller can't trigger
    // branded mail. The earlier service-role-bearer compare was retired
    // in favor of a custom shared-secret header (x-tasks-summary-secret
    // == TASKS_CRON_SECRET) — same Vault entry tasks-cron uses, both
    // functions read it via envTrim. Lock the new gate shape.
    expect(rapidProcessorFn).toMatch(
      /type === 'tasks_weekly_summary'[\s\S]*?safeEqual\(\s*summarySecret\s*,\s*TASKS_CRON_SECRET\s*\)/,
    );
    // Negative lock: the retired service-role-bearer compare must NOT
    // be back inside the tasks_weekly_summary branch.
    const branch = rapidProcessorFn.match(/type === 'tasks_weekly_summary'[\s\S]*?\n\s{4}\}/);
    if (branch) {
      expect(branch[0]).not.toMatch(/safeEqual\(\s*bearer\s*,\s*SUPABASE_SERVICE_ROLE_KEY\s*\)/);
    }
  });
});

// ============================================================================
// Tasks v2 T11 — legacy /my-tasks + /admin/tasks routes retired.
// ----------------------------------------------------------------------------
// /tasks is the only canonical Task Center surface. Both legacy paths
// redirect to /tasks via the URL adapter's ALIASES_EXACT map. Frontend
// imports of MyTasksView / AdminTasksView are gone; VALID_VIEWS no
// longer carries the legacy view names; the burger menu's My Tasks +
// Tasks Center entries are gone (the dark-bar Tasks button is the
// canonical destination).
// ============================================================================

describe('Tasks v2 T11 — legacy route retirement', () => {
  it('routes.js ALIASES_EXACT redirects /my-tasks and /admin/tasks to /tasks', () => {
    expect(routesJs).toMatch(/['"]\/my-tasks['"]\s*:\s*['"]\/tasks['"]/);
    expect(routesJs).toMatch(/['"]\/admin\/tasks['"]\s*:\s*['"]\/tasks['"]/);
  });

  it('routes.js VIEW_TO_PATH no longer maps myTasks or adminTasks to legacy paths', () => {
    // Their VIEW_TO_PATH entries are gone — the only way to reach
    // /tasks is through view='tasks'. Visitors hitting /my-tasks or
    // /admin/tasks land via the alias replace-navigate.
    expect(routesJs).not.toMatch(/myTasks\s*:\s*['"]\/my-tasks['"]/);
    expect(routesJs).not.toMatch(/adminTasks\s*:\s*['"]\/admin\/tasks['"]/);
  });

  it('main.jsx does not import MyTasksView or AdminTasksView (legacy components unmounted)', () => {
    expect(mainJsx).not.toMatch(/import\s+MyTasksView\s+from/);
    expect(mainJsx).not.toMatch(/import\s+AdminTasksView\s+from/);
  });

  it('main.jsx VALID_VIEWS no longer contains myTasks or adminTasks', () => {
    const validBlock = mainJsx.match(/VALID_VIEWS\s*=\s*\[([\s\S]*?)\]/);
    expect(validBlock, 'VALID_VIEWS array must be present').not.toBeNull();
    expect(validBlock[1]).not.toMatch(/'myTasks'/);
    expect(validBlock[1]).not.toMatch(/'adminTasks'/);
    // /tasks must still be a valid view.
    expect(validBlock[1]).toMatch(/'tasks'/);
  });

  it('Header.jsx burger menu drops the legacy My Tasks and Tasks Center entries', () => {
    // The dark-bar ✅ Tasks button (data-tasks-header-link) is the
    // single canonical destination. The burger entries that called
    // setView('myTasks') and setView('adminTasks') are gone; the only
    // remaining admin burger entry is 👥 Users (user management).
    expect(headerJsxFull).not.toMatch(/setView\(\s*['"]myTasks['"]\s*\)/);
    expect(headerJsxFull).not.toMatch(/setView\(\s*['"]adminTasks['"]\s*\)/);
    // Sanity: the dark-bar link still exists.
    expect(headerJsxFull).toMatch(/data-tasks-header-link="1"/);
  });
});

// ============================================================================
// Header webforms grouping + Equipment rename + Tasks divider.
// ----------------------------------------------------------------------------
// The dark-bar layout pattern:
//   1. Dailys + Equipment buttons live inside a labeled "Webforms" group
//      (data-header-webforms-group, data-header-webforms-label="Webforms")
//      so they read as related forms, not as one-offs next to ✅ Tasks.
//   2. The legacy "⛽ Fueling" button is renamed "🚜 Equipment" but still
//      routes to setView('fuelingHub') — view name stays untouched so URL
//      adapter, deep links, and main.jsx mount don't care about the label.
//   3. A divider element (data-header-tasks-divider) separates the
//      Webforms group from the ✅ Tasks button so Tasks doesn't read as a
//      third webform link.
// ============================================================================

// Pre-2026-05-14 the dark bar carried a Webforms group (data-header-
// webforms-group, data-header-webforms-equipment) and a visual divider
// (data-header-tasks-divider) before the Tasks button. The Notifications
// Center prep refactor moved every webform destination into the
// hamburger menu and dropped the divider — the new dark bar is brand +
// status + Tasks icon + Notifications placeholder + hamburger.
// tests/static/header_nav_static.test.js locks the new shape and the
// negative locks (no -group / -equipment / -tasks-divider). The block
// that used to live here has been retired.

// ============================================================================
// Task Center assignee availability mapping.
// ----------------------------------------------------------------------------
// Codex spec: profiles hidden via webform_config.tasks_public_assignee_availability
// (the "Public Tasks" team-availability config) must NOT be selectable in
// any Task Center mutation dropdown — NewTask, Reassign (AssignTaskModal),
// Recurring template, or System rule edit.
//
//   - tasksCenterApi exports loadTaskAssignableProfilesById that reads
//     list_eligible_assignees + the webform_config row + filters with
//     visiblePublicAssignees(). Never reads `profiles` directly.
//   - TaskCenterView / MyTasksTab / RecurringTab / SystemTasksTab load
//     BOTH the unfiltered display map (loadEligibleProfilesById) and the
//     filtered assignable map (loadTaskAssignableProfilesById). Display
//     map keeps existing names intact for read-only rows; assignable map
//     drives the modal dropdowns.
//   - NewTaskModal / AssignTaskModal / RecurringTemplateModal /
//     SystemRuleEditModal receive the assignable map as profilesById.
//   - AssignTaskModal / RecurringTemplateModal / SystemRuleEditModal each
//     reset the dropdown to '' when the row's current assignee is not in
//     the assignable map (hidden), so admin must pick a visible profile.
// ============================================================================

describe('Tasks v2 — assignee availability filter on Task Center mutation dropdowns', () => {
  it('tasksCenterApi exposes loadTaskAssignableProfilesById that filters via visiblePublicAssignees', () => {
    expect(tasksCenterApi).toMatch(/export\s+async\s+function\s+loadTaskAssignableProfilesById/);
    expect(tasksCenterApi).toMatch(
      /import\s*\{\s*TASKS_PUBLIC_ASSIGNEE_AVAILABILITY_KEY\s*,\s*visiblePublicAssignees\s*\}\s*from\s*['"]\.\/tasks\.js['"]/,
    );
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadTaskAssignableProfilesById[\s\S]*?\n\}/);
    expect(body, 'loadTaskAssignableProfilesById body must be present').not.toBeNull();
    expect(body[0]).toMatch(/sb\.rpc\(\s*['"]list_eligible_assignees['"]/);
    expect(body[0]).toMatch(/\.from\(\s*['"]webform_config['"]\s*\)/);
    expect(body[0]).toMatch(/TASKS_PUBLIC_ASSIGNEE_AVAILABILITY_KEY/);
    expect(body[0]).toMatch(/visiblePublicAssignees\(/);
  });

  it('loadTaskAssignableProfilesById never reads the profiles table directly', () => {
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadTaskAssignableProfilesById[\s\S]*?\n\}/);
    expect(body[0]).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
  });

  // Codex amendment: hidden-assignee filtering must fail CLOSED. A read
  // error from webform_config must NOT silently fall back to the
  // unfiltered eligible list — that would re-expose hidden profiles in
  // mutation dropdowns. Lock both error-path branches (rowErr + try/catch)
  // so each returns an empty map.
  it('loadTaskAssignableProfilesById fails CLOSED on availability read error/throw', () => {
    const body = tasksCenterApi.match(/export\s+async\s+function\s+loadTaskAssignableProfilesById[\s\S]*?\n\}/);
    expect(body, 'helper body must be present').not.toBeNull();
    // The rowErr branch must return {} (not visiblePublicAssignees-of-eligible).
    expect(body[0]).toMatch(/if\s*\(\s*rowErr\s*\)\s*\{[\s\S]*?return\s*\{\s*\}\s*;/);
    // The try/catch branch must also return {} on throw.
    expect(body[0]).toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*?return\s*\{\s*\}\s*;/);
  });

  it('TaskCenterView loads both the display and assignable profile maps', () => {
    expect(taskCenterView).toMatch(/loadEligibleProfilesById/);
    expect(taskCenterView).toMatch(/loadTaskAssignableProfilesById/);
  });

  it('MyTasksTab / RecurringTab / SystemTasksTab each load the assignable profile map', () => {
    expect(myTasksTab).toMatch(/loadTaskAssignableProfilesById/);
    expect(recurringTab).toMatch(/loadTaskAssignableProfilesById/);
    expect(systemTasksTab).toMatch(/loadTaskAssignableProfilesById/);
  });

  it('AssignTaskModal resets target to "" when the current assignee is hidden (not in profilesById)', () => {
    // The reset effect checks profilesById[cur]; if absent (hidden), the
    // modal opens with "— Select —". Lock both the conditional and the
    // useEffect dep on profilesById so a future drift can't strip the
    // hidden-current-assignee handling.
    expect(assignTaskModal).toMatch(
      /profilesById\s*&&\s*profilesById\[cur\][\s\S]*?setTarget\(cur\)[\s\S]*?setTarget\(''\)/,
    );
    expect(assignTaskModal).toMatch(/\}\s*,\s*\[isOpen,\s*task,\s*profilesById\]/);
  });

  it('RecurringTemplateModal resets assignee to "" when the template assignee is hidden', () => {
    expect(recurringTemplateModal).toMatch(
      /profilesById\s*&&\s*profilesById\[cur\][\s\S]*?setAssigneeId\(cur\)[\s\S]*?setAssigneeId\(''\)/,
    );
    expect(recurringTemplateModal).toMatch(/\}\s*,\s*\[isOpen,\s*template,\s*profilesById\]/);
  });

  it('SystemRuleEditModal resets assignee to "" when the rule assignee is hidden', () => {
    expect(systemRuleEditModal).toMatch(
      /profilesById\s*&&\s*profilesById\[cur\][\s\S]*?setAssigneeId\(cur\)[\s\S]*?setAssigneeId\(''\)/,
    );
    expect(systemRuleEditModal).toMatch(/\}\s*,\s*\[isOpen,\s*rule,\s*profilesById\]/);
  });
});

// ============================================================================
// Task Center tab cold-boot readiness.
// ----------------------------------------------------------------------------
// Each tab owns an async multi-read boot path. A rejected read must fail closed:
// clear stale rows/maps, expose a loaded=false marker, show a retry affordance,
// and not render empty/configured loaded-state content while the error is active.
// ============================================================================

describe('Tasks v2 — tab cold-boot readiness markers', () => {
  const tabs = [
    {
      name: 'MyTasksTab',
      src: myTasksTab,
      loadedMarker: "data-tasks-my-loaded={loading || loadFailed ? 'false' : 'true'}",
      retryMarker: 'data-tasks-load-retry="my-tasks"',
      staleClears: ['setTasks([]);', 'setProfiles({});', 'setAssignableProfiles({});'],
    },
    {
      name: 'CompletedTab',
      src: completedTab,
      loadedMarker: "data-tasks-completed-loaded={loading || loadFailed ? 'false' : 'true'}",
      retryMarker: 'data-tasks-load-retry="completed"',
      staleClears: ['setRows([]);', 'setProfiles({});'],
    },
    {
      name: 'RecurringTab',
      src: recurringTab,
      loadedMarker: "data-tasks-recurring-loaded={loading || loadFailed ? 'false' : 'true'}",
      retryMarker: 'data-tasks-load-retry="recurring"',
      staleClears: ['setTemplates([]);', 'setOpenInstances([]);', 'setProfiles({});', 'setAssignableProfiles({});'],
    },
    {
      name: 'SystemTasksTab',
      src: systemTasksTab,
      loadedMarker: "data-tasks-system-loaded={loading || loadFailed ? 'false' : 'true'}",
      retryMarker: 'data-tasks-load-retry="system"',
      staleClears: ['setRules([]);', 'setOpenInstances([]);', 'setProfiles({});', 'setAssignableProfiles({});'],
    },
  ];

  it('marks loaded=false while loading or failed, and only true after a clean load', () => {
    for (const tab of tabs) {
      expect(tab.src, `${tab.name} must derive loadFailed from err`).toMatch(/const\s+loadFailed\s*=\s*!!err/);
      expect(tab.src, `${tab.name} must expose the loaded marker`).toContain(tab.loadedMarker);
    }
  });

  it('re-enters loading and retries via reloadKey after a load failure', () => {
    for (const tab of tabs) {
      expect(tab.src, `${tab.name} must set loading true on every load attempt`).toMatch(/setLoading\(true\);/);
      expect(tab.src, `${tab.name} must render a retry button`).toContain(tab.retryMarker);
      expect(tab.src, `${tab.name} retry must bump reloadKey`).toMatch(
        /onClick=\{\(\) => setReloadKey\(\(k\) => k \+ 1\)\}/,
      );
    }
  });

  it('clears stale loaded data on load failure', () => {
    for (const tab of tabs) {
      for (const clearCall of tab.staleClears) {
        expect(tab.src, `${tab.name} must clear ${clearCall} on catch`).toContain(clearCall);
      }
    }
  });

  it('does not render loaded tab bodies while loadFailed is active', () => {
    for (const tab of tabs) {
      expect(tab.src, `${tab.name} must hide loaded content under error`).toMatch(
        /\)\s*:\s*loadFailed\s*\?\s*null\s*:/,
      );
    }
  });
});

// ============================================================================
// Photo icon size — MyTasksTab + CompletedTab.
// ----------------------------------------------------------------------------
// The paperclip 📎 button on each task row was 12px (basically invisible).
// Spec bumps it to >= 36px so it's a real tap/click target. Lock the size
// at exactly 36 in PHOTO_LINK_BTN so a future restyle can't silently shrink
// it.
// ============================================================================

describe('Tasks v2 — photo icon size on My Tasks and Completed', () => {
  it('MyTasksTab PHOTO_LINK_BTN sets fontSize: 36', () => {
    const block = myTasksTab.match(/const\s+PHOTO_LINK_BTN\s*=\s*\{[\s\S]*?\};/);
    expect(block, 'MyTasksTab PHOTO_LINK_BTN block must be present').not.toBeNull();
    expect(block[0]).toMatch(/fontSize:\s*36\b/);
  });

  it('CompletedTab PHOTO_LINK_BTN sets fontSize: 36', () => {
    const block = completedTab.match(/const\s+PHOTO_LINK_BTN\s*=\s*\{[\s\S]*?\};/);
    expect(block, 'CompletedTab PHOTO_LINK_BTN block must be present').not.toBeNull();
    expect(block[0]).toMatch(/fontSize:\s*36\b/);
  });
});
