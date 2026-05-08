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

  it('main.jsx does NOT remove the legacy myTasks mount (legacy /my-tasks stays live)', () => {
    expect(mainJsx).toMatch(/if\s*\(view\s*===\s*'myTasks'\)/);
    expect(mainJsx).toMatch(/MyTasksView/);
  });

  it('main.jsx does NOT remove the legacy adminTasks mount (legacy /admin/tasks stays live)', () => {
    expect(mainJsx).toMatch(/if\s*\(view\s*===\s*'adminTasks'\)/);
    expect(mainJsx).toMatch(/AdminTasksView/);
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
  // Expanded details land in T3+; until then, the visible label
  // text "Photo" must not render alongside the paperclip.
  it('MyTasksTab photo indicator is icon-only with title/aria-label, no visible "Photo" text', () => {
    // The data attribute marker stays so tests can find it; the
    // visible content must be only the paperclip glyph and the
    // accessibility metadata.
    expect(myTasksTab).toMatch(/data-task-has-photo="1"/);
    expect(myTasksTab).toMatch(/aria-label="Task has at least one photo"/);
    expect(myTasksTab).toMatch(/title="Task has at least one photo"/);
    // Negative lock: no "Photo" word inside the indicator span.
    expect(myTasksTab).not.toMatch(/📎\s+Photo/);
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

  it('Header Tasks button has data-tasks-header-link and navigates to setView("tasks")', () => {
    expect(headerJsx).toMatch(/data-tasks-header-link="1"/);
    expect(headerJsx).toMatch(/data-tasks-header-link="1"[\s\S]*?onClick={[\s\S]*?setView\(\s*['"]tasks['"]\s*\)/);
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

  it('CompletedTab renders no edit/save/delete/complete buttons', () => {
    // Negative locks: no button onClick that fires a write or mutation
    // helper. We accept the tab toggle buttons (none in CompletedTab —
    // it has no <button> at all in T4).
    expect(completedTab).not.toMatch(/<button[\s\S]*?onClick/);
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

  it('RecurringTab buttons are all collapse toggles, never edit/delete/save controls', () => {
    // The only <button> elements are the per-template collapse toggles
    // wired to the local toggle() helper. Lock that any button onClick
    // calls toggle(...) so a future drift can't slip an edit handler in.
    const buttonOnClicks = Array.from(recurringTab.matchAll(/<button\b[\s\S]*?onClick=\{[\s\S]*?\}/g), (m) => m[0]);
    expect(buttonOnClicks.length).toBeGreaterThan(0);
    for (const btn of buttonOnClicks) {
      expect(btn, 'every Recurring tab button must call toggle(...) only').toMatch(/toggle\(/);
    }
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
