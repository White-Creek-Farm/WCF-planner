// Static contract lock for the shared To Do List lane (mig 115).
//
// Covers: migration shape (tables, deny-all RLS, SECDEF RPC family, 5-total
// photo trigger, notification types, todo.item activity branches preserving
// the mig 112 cattle.log branches), the todoApi client boundary (RPC-only,
// shared photo cap, registered localStorage keys, role sets excluding
// equipment_tech), the Task Center meaty toggle + router dispatch, the
// activity registry / notification routing, the record page collaboration
// mount, and the weekly digest availability redaction + To Do section.

import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const mig = read('supabase-migrations/115_todo_items.sql');
const mig133 = read('supabase-migrations/133_task_system_generation_and_todo_notifications.sql');
const todoApi = read('src/lib/todoApi.js');
const taskCenterView = read('src/tasks/TaskCenterView.jsx');
const todoListTab = read('src/tasks/TodoListTab.jsx');
const todoItemPage = read('src/tasks/TodoItemPage.jsx');
const newTodoModal = read('src/tasks/NewTodoModal.jsx');
const completeModal = read('src/tasks/TodoCompleteModal.jsx');
const rejectModal = read('src/tasks/TodoRejectModal.jsx');
const convertModal = read('src/tasks/ConvertTodoModal.jsx');
const howTo = read('src/tasks/TodoHowTo.jsx');
const photoThumbs = read('src/tasks/TodoPhotoThumbs.jsx');
const registry = read('src/lib/activityRegistry.js');
const summaryFn = read('supabase/functions/tasks-summary/index.ts');
const rapidFn = read('supabase-functions/rapid-processor.ts');

const TODO_RPCS = [
  'create_todo_item',
  'list_todo_items',
  'update_todo_item',
  'submit_todo_completion',
  'approve_todo_completion',
  'reject_todo_completion',
  'reorder_todo_items',
  'move_todo_item',
  'convert_todo_item',
  'remove_todo_item',
];

describe('mig 115: tables and RLS', () => {
  it('creates todo_items with the locked section/status models', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.todo_items/);
    expect(mig).toMatch(/section IN \('general', 'chicken_pigs', 'cattle_sheep'\)/);
    expect(mig).toMatch(/status IN \('open', 'pending_approval', 'completed', 'converted', 'removed'\)/);
  });

  it('creates todo_item_photos with origination/completion kinds and slot bounds', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.todo_item_photos/);
    expect(mig).toMatch(/kind IN \('origination', 'completion'\)/);
    expect(mig).toMatch(/sort_order BETWEEN 0 AND 4/);
    expect(mig).toMatch(/UNIQUE \(todo_id, kind, sort_order\)/);
  });

  it('locks both tables deny-all with no direct client grants', () => {
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.todo_items FROM PUBLIC, anon, authenticated/);
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.todo_item_photos FROM PUBLIC, anon, authenticated/);
    expect(mig).toMatch(/CREATE POLICY todo_items_deny_all ON public\.todo_items\s+FOR ALL USING \(false\)/);
    expect(mig).toMatch(
      /CREATE POLICY todo_item_photos_deny_all ON public\.todo_item_photos\s+FOR ALL USING \(false\)/,
    );
  });

  it('enforces the 5-total photo cap with an advisory-lock trigger (mig 114 pattern)', () => {
    expect(mig).toMatch(/_enforce_todo_item_photos_max_5_total/);
    expect(mig).toMatch(/pg_advisory_xact_lock\(hashtext\('todo_item_photos'\), hashtext\(NEW\.todo_id\)\)/);
    expect(mig).toMatch(/max 5 photos per to do item/);
    expect(mig).toMatch(/CREATE TRIGGER todo_item_photos_max_5_total/);
  });
});

describe('mig 115: SECDEF RPC family', () => {
  it('defines all ten RPCs as SECURITY DEFINER with search_path public', () => {
    for (const fn of TODO_RPCS) {
      const def = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`);
      expect(mig, fn).toMatch(def);
    }
    // Every RPC body in this migration is SECDEF + pinned search_path.
    const secdefCount = (mig.match(/SECURITY DEFINER/g) || []).length;
    expect(secdefCount).toBeGreaterThanOrEqual(TODO_RPCS.length);
  });

  it('grants EXECUTE to authenticated only (anon revoked) for each RPC', () => {
    for (const fn of TODO_RPCS) {
      expect(mig, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`));
      expect(mig, fn).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
    }
  });

  it('role-gates participants and managers explicitly (equipment_tech excluded)', () => {
    expect(mig).toMatch(/NOT IN \('light', 'farm_team', 'management', 'admin'\)/);
    expect(mig).toMatch(/NOT IN \('management', 'admin'\)/);
    // equipment_tech may appear in comments but never in a role gate list.
    expect(mig).not.toMatch(/IN \([^)]*'equipment_tech'/);
  });

  it('keeps the two-step completion model: manager auto-approve + pending for others', () => {
    expect(mig).toMatch(/IF v_manager THEN[\s\S]*?status = 'completed'/);
    expect(mig).toMatch(/status = 'pending_approval'/);
    expect(mig).toMatch(/'auto_approved', true/);
  });

  it('rejection requires a note and preserves completion history in Activity', () => {
    expect(mig).toMatch(/a short rejection note is required/);
    expect(mig).toMatch(/todo\.completion_rejected/);
    expect(mig).toMatch(/'completion_note', v_row\.completion_note/);
  });

  it('convert reuses the mig 053 task-create RPC in one transaction and only converts OPEN items', () => {
    expect(mig).toMatch(/public\.create_one_time_task_instance\(p_task, COALESCE\(p_creation_photo_paths/);
    expect(mig).toMatch(/only an open item can be converted/);
    expect(mig).toMatch(/status = 'converted'/);
  });

  it('validates photo paths to the task-photos bucket todo/ prefix', () => {
    expect(mig).toMatch(/'task-photos\/todo\/' \|\| p_todo_id \|\| '\/'/);
  });
});

describe('mig 115: notifications and activity gates', () => {
  it('re-issues notifications_type_check with the legacy three plus three todo types', () => {
    expect(mig).toMatch(
      /CHECK \(type IN \('task_completed', 'mention', 'comment_mention',\s*'todo_completion_approved', 'todo_completion_rejected',\s*'todo_converted'\)\)/,
    );
  });

  it('notifications carry activity_event_id for entity routing and skip self-notify', () => {
    expect(mig).toMatch(/IF p_recipient IS NULL OR p_recipient = p_actor THEN\s+RETURN;/);
    expect(mig).toMatch(/task_instance_id, activity_event_id, title, body, created_at/);
  });

  it('_activity_can_read adds a todo.item branch with the explicit role gate', () => {
    expect(mig).toMatch(
      /IF p_entity_type = 'todo\.item' THEN[\s\S]*?todo_items WHERE id = p_entity_id[\s\S]*?v_role IN \('light', 'farm_team', 'management', 'admin'\)/,
    );
  });

  // The _activity_can_write function body only, bounded to its REVOKE line so
  // assertions never bleed into the post_comment/edit_comment re-issues that
  // follow it (those legitimately contain 'todo.item' in their mention guards).
  function canWriteBody(src) {
    const start = src.indexOf('CREATE OR REPLACE FUNCTION public._activity_can_write');
    const end = src.indexOf('REVOKE ALL ON FUNCTION public._activity_can_write', start);
    return src.slice(start, end);
  }

  it('faithfully preserves the mig 112 cattle.log branches in BOTH re-issued gates', () => {
    expect(mig).toMatch(
      /IF p_entity_type = 'cattle\.log' THEN\s+RETURN v_role IN \('light', 'farm_team', 'management', 'admin'\);/,
    );
    expect(canWriteBody(mig)).toMatch(/IF p_entity_type = 'cattle\.log' THEN\s+RETURN false;/);
  });

  it('adds list_todo_mentionable_profiles scoped to the participant roles only (no equipment_tech)', () => {
    expect(mig).toMatch(/CREATE OR REPLACE FUNCTION public\.list_todo_mentionable_profiles\(\)/);
    const fn = mig.slice(mig.indexOf('list_todo_mentionable_profiles'));
    expect(fn).toMatch(/p\.role IN \('light', 'farm_team', 'management', 'admin'\)/);
    expect(
      mig.slice(
        mig.indexOf('CREATE OR REPLACE FUNCTION public.list_todo_mentionable_profiles'),
        mig.indexOf('$td_mention$', mig.indexOf('$td_mention$') + 1),
      ),
    ).not.toMatch(/equipment_tech/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_todo_mentionable_profiles\(\) TO authenticated/);
  });

  it('re-issues post_comment + edit_comment with a todo.item participant mention guard', () => {
    // Both generic comment RPCs reject a mention target outside the To Do
    // participant set when the comment is on a todo.item entity.
    const post = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public.post_comment'));
    expect(post).toMatch(
      /p_entity_type = 'todo\.item' AND v_mention_role NOT IN \('light', 'farm_team', 'management', 'admin'\)/,
    );
    expect(post).toMatch(/is not a To Do participant/);
    const edit = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public.edit_comment'));
    expect(edit).toMatch(
      /v_row\.entity_type = 'todo\.item' AND v_mention_role NOT IN \('light', 'farm_team', 'management', 'admin'\)/,
    );
    expect(edit).toMatch(/is not a To Do participant/);
  });

  it('the edit_comment re-issue preserves the mig 112 cattle.log mirror + originals guards', () => {
    const edit = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public.edit_comment'));
    expect(edit).toMatch(/cattle_log_tag_links\s+WHERE mirror_comment_id = p_comment_id/);
    expect(edit).toMatch(/IF v_row\.entity_type = 'cattle\.log' THEN/);
  });

  it('_activity_can_write deliberately has NO todo.item branch (generic comments delegate to can_read)', () => {
    const canWrite = canWriteBody(mig);
    expect(canWrite).not.toMatch(/IF p_entity_type = 'todo\.item'/);
    expect(canWrite).toMatch(/RETURN public\._activity_can_read\(p_entity_type, p_entity_id\);/);
  });

  it('adds the task_summary_runs.total_todo_items audit column', () => {
    expect(mig).toMatch(
      /ALTER TABLE public\.task_summary_runs\s+ADD COLUMN IF NOT EXISTS total_todo_items int NOT NULL DEFAULT 0/,
    );
  });
});

describe('mig 133: manager To Do approval notifications', () => {
  it('widens notifications_type_check for todo_completion_submitted without dropping existing types', () => {
    expect(mig133).toMatch(/DROP CONSTRAINT IF EXISTS notifications_type_check/);
    for (const type of [
      'task_completed',
      'mention',
      'comment_mention',
      'todo_completion_approved',
      'todo_completion_rejected',
      'todo_converted',
      'todo_completion_submitted',
    ]) {
      expect(mig133, type).toContain(`'${type}'`);
    }
  });

  it('defines a server-only manager fan-out helper scoped to management/admin', () => {
    expect(mig133).toMatch(/CREATE OR REPLACE FUNCTION public\._todo_notify_managers/);
    expect(mig133).toMatch(/SECURITY DEFINER/);
    expect(mig133).toMatch(/p\.role IN \('management', 'admin'\)/);
    expect(mig133).toMatch(/p\.id IS DISTINCT FROM p_actor/);
    expect(mig133).toMatch(/'todo_completion_submitted'/);
    expect(mig133).toMatch(/task_instance_id, activity_event_id, title, body, created_at/);
    expect(mig133).toMatch(/REVOKE ALL ON FUNCTION public\._todo_notify_managers\(uuid, text, text, text\)/);
  });

  it('re-issues submit_todo_completion with manager notification on the pending approval branch only', () => {
    expect(mig133).toMatch(/CREATE OR REPLACE FUNCTION public\.submit_todo_completion/);
    expect(mig133).toMatch(/IF v_manager THEN[\s\S]*?status = 'completed'/);
    expect(mig133).toMatch(/PERFORM public\._todo_notify_creator/);
    expect(mig133).toMatch(
      /ELSE[\s\S]*?status = 'pending_approval'[\s\S]*?'todo\.completion_submitted'[\s\S]*?PERFORM public\._todo_notify_managers/,
    );
    expect(mig133).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.submit_todo_completion\(text, text, text\[\]\) TO authenticated/,
    );
  });
});

describe('todoApi client boundary', () => {
  it('calls all ten RPCs by name and never writes todo tables directly', () => {
    for (const fn of TODO_RPCS) {
      expect(todoApi, fn).toMatch(new RegExp(`sb\\.rpc\\('${fn}'`));
    }
    expect(todoApi).not.toMatch(/\.from\('todo_items'\)/);
    expect(todoApi).not.toMatch(/\.from\('todo_item_photos'\)/);
  });

  it('exposes a To Do mention loader that calls the narrower RPC', () => {
    expect(todoApi).toMatch(/export async function listTodoMentionableProfiles\(sb\)/);
    expect(todoApi).toMatch(/sb\.rpc\('list_todo_mentionable_profiles'\)/);
  });

  it('shares the task photo cap constant (5 total)', () => {
    expect(todoApi).toMatch(
      /import \{MAX_TASK_PHOTOS_PER_TASK, uploadTaskCreationPhotos\} from '\.\/tasksCenterMutationsApi\.js'/,
    );
    expect(todoApi).toMatch(/export const MAX_TODO_PHOTOS = MAX_TASK_PHOTOS_PER_TASK/);
  });

  it('uploads append-only to the task-photos bucket under todo/<id>/ with duplicate-as-success', () => {
    expect(todoApi).toMatch(/upsert: false/);
    expect(todoApi).toMatch(/isStorageDuplicateError/);
    expect(todoApi).toMatch(/`todo\/\$\{todoId\}\/\$\{kind\}-\$\{slotIndex \+ 1\}\.jpg`/);
  });

  it('persists mode + section filter under the registered localStorage keys only', () => {
    expect(todoApi).toMatch(/localStorage\.getItem\(\s*'wcf-tasks-center-mode'\s*\)/);
    expect(todoApi).toMatch(/localStorage\.setItem\(\s*'wcf-tasks-center-mode'/);
    expect(todoApi).toMatch(/localStorage\.getItem\(\s*'wcf-todo-section-filter'\s*\)/);
    expect(todoApi).toMatch(/localStorage\.setItem\(\s*'wcf-todo-section-filter'/);
  });

  it('locks the role sets: participants exclude equipment_tech; managers are management/admin', () => {
    expect(todoApi).toMatch(/TODO_PARTICIPANT_ROLES = \['light', 'farm_team', 'management', 'admin'\]/);
    expect(todoApi).toMatch(/TODO_MANAGER_ROLES = \['management', 'admin'\]/);
    // equipment_tech may appear in comments but never inside a role array.
    expect(todoApi).not.toMatch(/\[[^\]]*'equipment_tech'/);
  });

  it('carries convert photos through the canonical task creation-photo owner', () => {
    expect(todoApi).toMatch(/uploadTaskCreationPhotos\(sb, taskId, blobs\)/);
  });
});

describe('Task Center toggle + router', () => {
  it('renders the meaty mode toggle only for To Do participants', () => {
    expect(taskCenterView).toMatch(/data-tasks-mode-toggle="1"/);
    expect(taskCenterView).toMatch(/data-tasks-mode-center="1"/);
    expect(taskCenterView).toMatch(/data-tasks-mode-todo="1"/);
    expect(taskCenterView).toMatch(/isTodoParticipant\(authState && authState\.role\)/);
    expect(taskCenterView).toMatch(/todoAllowed \? <TasksModeToggle/);
  });

  it('persists the mode via the todoApi localStorage helpers', () => {
    expect(taskCenterView).toMatch(/readTasksCenterMode\(\)/);
    expect(taskCenterView).toMatch(/writeTasksCenterMode\(next\)/);
  });

  it('dispatches /tasks/todo and /tasks/todo/<id> BEFORE the task-detail branch', () => {
    const routerSrc = taskCenterView.slice(taskCenterView.indexOf('function TasksRouter'));
    const todoIdx = routerSrc.indexOf("startsWith('/tasks/todo/')");
    const taskIdx = routerSrc.indexOf("location.pathname.slice('/tasks/'.length)");
    expect(todoIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(todoIdx).toBeLessThan(taskIdx);
    expect(routerSrc).toMatch(/forceMode: 'todo'/);
    expect(routerSrc).toMatch(/TodoItemPage/);
  });

  it('keyes the two TaskCenterView router branches so an in-app /tasks <-> /tasks/todo nav remounts', () => {
    const routerSrc = taskCenterView.slice(taskCenterView.indexOf('function TasksRouter'));
    expect(routerSrc).toMatch(/key: 'todo'/);
    expect(routerSrc).toMatch(/key: 'center'/);
  });

  it('normalizes /tasks/todo back to /tasks for nonparticipants (equipment_tech)', () => {
    expect(taskCenterView).toMatch(
      /forceMode === 'todo' && !todoAllowed[\s\S]*?navigate\('\/tasks', \{replace: true\}\)/,
    );
  });

  it('the record page passes the To Do mention loader so the picker excludes equipment_tech', () => {
    expect(todoItemPage).toMatch(/listTodoMentionableProfiles/);
    expect(todoItemPage).toMatch(/loadMentionable=\{listTodoMentionableProfiles\}/);
  });

  it('CommentsSection accepts an optional mention-loader prop defaulting to the generic loader', () => {
    const comments = read('src/shared/CommentsSection.jsx');
    expect(comments).toMatch(/loadMentionable = loadMentionableProfiles/);
    expect(comments).toMatch(/await loadMentionable\(s\)/);
    const collab = read('src/shared/RecordCollaborationSection.jsx');
    expect(collab).toMatch(/loadMentionable=\{loadMentionable\}/);
  });
});

describe('To Do list surface', () => {
  it('fails closed with marker, retry, and cleared rows on load error', () => {
    expect(todoListTab).toMatch(/data-todo-list-loaded=\{loading \? undefined : '1'\}/);
    expect(todoListTab).toMatch(/setItems\(\[\]\);\s*setCompleted\(\[\]\);/);
    expect(todoListTab).toMatch(/Retry/);
    expect(todoListTab).toMatch(/InlineNotice/);
  });

  it('renders the three fixed sections plus the All/section chips and pending filter', () => {
    expect(todoListTab).toMatch(/data-todo-section-filter="1"/);
    expect(todoListTab).toMatch(/data-todo-section-chip=\{s\.key\}/);
    expect(todoListTab).toMatch(/data-todo-pending-filter="1"/);
    expect(todoListTab).toMatch(/writeTodoSectionFilter/);
  });

  it('rows are openable hoverable tiles with keyboard activation', () => {
    expect(todoListTab).toMatch(/className="hoverable-tile"/);
    expect(todoListTab).toMatch(/openableProps\(/);
  });

  it('manager reorder uses the hand-rolled HTML5 drag pattern plus explicit move controls (no new dependency)', () => {
    expect(todoListTab).toMatch(/onDragStart/);
    expect(todoListTab).toMatch(/onDragOver/);
    expect(todoListTab).toMatch(/onDrop/);
    expect(todoListTab).toMatch(/data-todo-move-up=\{item\.id\}/);
    expect(todoListTab).toMatch(/data-todo-move-down=\{item\.id\}/);
    expect(todoListTab).toMatch(/data-todo-move-section=\{item\.id\}/);
  });

  it('keeps the Completed section collapsed by default and remove behind DeleteModal', () => {
    expect(todoListTab).toMatch(/data-todo-completed-toggle="1"/);
    expect(todoListTab).toMatch(/useState\(false\)[\s\S]*completedOpen/);
    expect(todoListTab).toMatch(/DeleteModal/);
  });

  it('mounts the How to Use modal (not a collapsible panel)', () => {
    expect(todoListTab).toMatch(/data-todo-howto="1"/);
    expect(howTo).toMatch(/data-todo-howto-modal="1"/);
    expect(howTo).toMatch(/role="dialog"/);
    expect(howTo).toMatch(/aria-modal="true"/);
  });
});

describe('To Do record page', () => {
  it('mounts the canonical collaboration section on todo.item', () => {
    expect(todoItemPage).toMatch(/entityType="todo\.item"/);
    expect(todoItemPage).toMatch(/RecordCollaborationSection/);
  });

  it('uses record chrome with loaded/error markers and a not-found state', () => {
    expect(todoItemPage).toMatch(/data-todo-record-loaded="true"/);
    expect(todoItemPage).toMatch(/data-todo-record-load-error="true"/);
    expect(todoItemPage).toMatch(/RecordPageNotFound/);
  });

  it('bounces non-participant roles (equipment_tech) back to /tasks', () => {
    expect(todoItemPage).toMatch(
      /if \(authState && role && !canParticipate\) \{\s*navigate\('\/tasks', \{replace: true\}\);/,
    );
  });

  it('scrolls to #comment- anchors for mention deeplinks', () => {
    expect(todoItemPage).toMatch(/location\.hash/);
    expect(todoItemPage).toMatch(/scrollIntoView/);
  });
});

describe('photo inputs and thumbnails', () => {
  it('image inputs are type=file accept=image/* with NO capture attribute', () => {
    for (const [name, src] of [
      ['NewTodoModal', newTodoModal],
      ['TodoCompleteModal', completeModal],
    ]) {
      expect(src, name).toMatch(/type="file"/);
      expect(src, name).toMatch(/accept="image\/\*"/);
      expect(src, name).not.toMatch(/capture=/);
    }
    expect(rejectModal).not.toMatch(/type="file"/);
    expect(convertModal).not.toMatch(/type="file"/);
  });

  it('thumbnails use imageAltText for user media and signed URLs from the private bucket', () => {
    expect(photoThumbs).toMatch(/imageAltText\(/);
    expect(photoThumbs).toMatch(/getTodoPhotoSignedUrl/);
  });
});

describe('activity registry + notification routing', () => {
  it('registers todo.item with the /tasks/todo/<id> route', () => {
    expect(registry).toMatch(/TODO_ITEM: 'todo\.item'/);
    expect(registry).toMatch(/route: \(id\) => `\/tasks\/todo\/\$\{encodeURIComponent\(id\)\}`/);
  });

  it('routes the four todo notification types (converted prefers the created Task)', () => {
    expect(registry).toMatch(/todo_completion_approved/);
    expect(registry).toMatch(/todo_completion_rejected/);
    expect(registry).toMatch(/todo_completion_submitted/);
    expect(registry).toMatch(/notification\.type === 'todo_converted' && notification\.task_instance_id/);
  });
});

describe('weekly digest: availability redaction + To Do section', () => {
  it('tasks-summary loads the availability config and drops hidden recipients before the loop', () => {
    expect(summaryFn).toMatch(/tasks_public_assignee_availability/);
    expect(summaryFn).toMatch(/fetchHiddenProfileIds/);
    expect(summaryFn).toMatch(/for \(const id of hiddenIds\) byId\.delete\(id\);/);
    const hiddenIdx = summaryFn.indexOf('byId.delete(id)');
    const loopIdx = summaryFn.indexOf('for (const bucket of buckets)');
    expect(hiddenIdx).toBeGreaterThan(-1);
    expect(hiddenIdx).toBeLessThan(loopIdx);
  });

  it('availability read failure THROWS (fail closed, no sends) instead of failing open', () => {
    expect(summaryFn).toMatch(/select webform_config \(assignee availability\): \$\{error\.message\}/);
  });

  it('To Do digest roles exclude equipment_tech and eligible profiles join the recipient set', () => {
    expect(summaryFn).toMatch(/TODO_DIGEST_ROLES = \['light', 'farm_team', 'management', 'admin'\]/);
    expect(summaryFn).toMatch(/fetchTodoEligibleProfiles/);
    expect(summaryFn).toMatch(/TODO_DIGEST_ROLES\.includes\(bucket\.role\) \? todos : \[\]/);
  });

  it('audits total_todo_items', () => {
    expect(summaryFn).toMatch(/total_todo_items: number;/);
    expect(summaryFn).toMatch(/total_todo_items = totalTodos/);
  });

  it('rapid-processor renders the To Do section and only skips when ALL sections are empty', () => {
    expect(rapidFn).toMatch(/function tasksWeeklyTodoHtml/);
    expect(rapidFn).toMatch(/openTasks\.length === 0 && completedTasks\.length === 0 && todoItems\.length === 0/);
    expect(rapidFn).toMatch(/on the to do list/);
    expect(rapidFn).toMatch(/Awaiting approval/);
  });
});
