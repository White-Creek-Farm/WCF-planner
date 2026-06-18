import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const mig134 = read('supabase-migrations/134_originator_task_todo_edit_photos.sql');
const taskMutations = read('src/lib/tasksCenterMutationsApi.js');
const taskPage = read('src/tasks/TaskInstancePage.jsx');
const editTaskModal = read('src/tasks/EditTaskDetailsModal.jsx');
const todoApi = read('src/lib/todoApi.js');
const todoPage = read('src/tasks/TodoItemPage.jsx');

describe('originator task editing RPC', () => {
  it('adds a SECDEF task details RPC for admins or the original creator only', () => {
    expect(mig134).toMatch(/CREATE OR REPLACE FUNCTION public\.update_task_instance_details/);
    expect(mig134).toMatch(/SECURITY DEFINER/);
    expect(mig134).toMatch(/SET search_path = public/);
    expect(mig134).toMatch(/v_admin boolean := public\.is_admin\(\)/);
    expect(mig134).toMatch(/created_by_profile_id IS DISTINCT FROM v_caller/);
    expect(mig134).toMatch(/only the creator or an admin may edit this task/);
    expect(mig134).toMatch(/completed tasks are read-only/);
    expect(mig134).toMatch(/GRANT EXECUTE ON FUNCTION public\.update_task_instance_details/);
  });

  it('validates assignees and appends request photos through the sidecar with the shared cap', () => {
    expect(mig134).toMatch(/_task_validate_creation_photo_paths/);
    expect(mig134).toMatch(/'task-request-photos\/' \|\| p_instance_id \|\| '\//);
    expect(mig134).toMatch(/max 5 photos per task/);
    expect(mig134).toMatch(/target assignee % is not eligible/);
    expect(mig134).toMatch(/INSERT INTO public\.task_instance_photos/);
    expect(mig134).toMatch(/p_instance_id, 'creation', v_path, v_caller/);
    expect(mig134).toMatch(/ON CONFLICT \(instance_id, kind, sort_order\) DO UPDATE/);
    expect(mig134).toMatch(/request_photo_path = CASE[\s\S]*?request_photo_path IS NULL/);
  });

  it('logs task record.updated activity for data or photo changes', () => {
    expect(mig134).toMatch(/INSERT INTO public\.activity_events/);
    expect(mig134).toMatch(/'task\.instance'/);
    expect(mig134).toMatch(/'record\.updated'/);
    expect(mig134).toMatch(/creation_photos_added/);
  });
});

describe('originator to-do editing RPC', () => {
  it('re-issues update_todo_item with p_photo_paths and no PostgREST overload ambiguity', () => {
    expect(mig134).toMatch(/DROP FUNCTION IF EXISTS public\.update_todo_item\(text, text, text, text, date, boolean\)/);
    expect(mig134).toMatch(/CREATE OR REPLACE FUNCTION public\.update_todo_item/);
    expect(mig134).toMatch(/p_photo_paths\s+text\[\] DEFAULT '\{\}'::text\[\]/);
    expect(mig134).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.update_todo_item\(text, text, text, text, date, boolean, text\[\]\)/,
    );
  });

  it('preserves creator-manager edit gates and appends origination photos under the 5 total cap', () => {
    expect(mig134).toMatch(/v_row\.created_by IS DISTINCT FROM v_caller/);
    expect(mig134).toMatch(/only the creator or a manager may edit this item/);
    expect(mig134).toMatch(/PERFORM public\._todo_validate_photo_paths\(p_id, p_photo_paths\)/);
    expect(mig134).toMatch(/v_photo_count \+ v_photo_n > 5/);
    expect(mig134).toMatch(/_todo_insert_photos\(p_id, 'origination', p_photo_paths, v_caller\)/);
    expect(mig134).toMatch(/origination_photos_added/);
  });
});

describe('originator edit client wrappers', () => {
  it('task mutation wrapper calls update_task_instance_details with the full arg shape', () => {
    expect(taskMutations).toMatch(/export async function updateTaskInstanceDetailsV2/);
    expect(taskMutations).toMatch(/sb\.rpc\('update_task_instance_details'/);
    for (const arg of [
      'p_instance_id',
      'p_title',
      'p_description',
      'p_due_date',
      'p_assignee_profile_id',
      'p_creation_photo_paths',
    ]) {
      expect(taskMutations).toContain(arg);
    }
  });

  it('creation photo uploads can append after existing request photos without losing append-only storage', () => {
    expect(taskMutations).toMatch(/existingCreationCount = 0/);
    expect(taskMutations).toMatch(/existingPhotoCount = 0/);
    expect(taskMutations).toMatch(/const slotIndex = creationOffset \+ i/);
    expect(taskMutations).toMatch(
      /assertTaskPhotoLimit\(existingPhotoCount, blobs\.length, 'uploadTaskCreationPhotos'\)/,
    );
    expect(taskMutations).toMatch(/upsert:\s*false/);
  });

  it('to-do update wrapper forwards photo paths to update_todo_item', () => {
    expect(todoApi).toMatch(/export async function updateTodoItem/);
    expect(todoApi).toMatch(/if \(Array\.isArray\(photoPaths\) && photoPaths\.length > 0\)/);
    expect(todoApi).toMatch(/args\.p_photo_paths = photoPaths/);
  });
});

describe('originator edit UI wiring', () => {
  it('TaskInstancePage exposes the details edit modal only to admins or creators', () => {
    expect(taskPage).toMatch(/import EditTaskDetailsModal/);
    expect(taskPage).toMatch(/function canEditDetails/);
    expect(taskPage).toMatch(/ti\.created_by_profile_id === callerProfileId/);
    expect(taskPage).toMatch(/data-task-edit-details-button="1"/);
    expect(taskPage).toMatch(/EditTaskDetailsModal/);
  });

  it('EditTaskDetailsModal edits data and appends photos without capture', () => {
    expect(editTaskModal).toMatch(/loadTaskInstancePhotos/);
    expect(editTaskModal).toMatch(/updateTaskInstanceDetailsV2/);
    expect(editTaskModal).toMatch(/uploadTaskCreationPhotos/);
    expect(editTaskModal).toMatch(/existingCreationCount/);
    expect(editTaskModal).toMatch(/existingPhotoCount/);
    expect(editTaskModal).toMatch(/data-edit-task-field="photos"/);
    expect(editTaskModal).toMatch(/type="file"/);
    expect(editTaskModal).toMatch(/accept="image\/\*"/);
    expect(editTaskModal).not.toMatch(/capture=/);
  });

  it('TodoItemPage lets the existing edit panel append origination photos', () => {
    expect(todoPage).toMatch(/uploadTodoPhotos/);
    expect(todoPage).toMatch(/remainingTodoPhotoSlots/);
    expect(todoPage).toMatch(/data-todo-edit-field="photos"/);
    expect(todoPage).toMatch(/uploadTodoPhotos\(sb, item\.id, 'origination', editPhotos/);
    expect(todoPage).toMatch(/photoPaths/);
    expect(todoPage).not.toMatch(/capture=/);
  });
});
