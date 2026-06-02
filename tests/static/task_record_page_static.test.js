import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pageSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/TaskInstancePage.jsx'), 'utf8');
const myTasksSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/MyTasksTab.jsx'), 'utf8');
const completedSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/CompletedTab.jsx'), 'utf8');
const completeModalSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/CompleteTaskModal.jsx'), 'utf8');
const centerSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/TaskCenterView.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasksCenterApi.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');

describe('TaskInstancePage — record page structure', () => {
  it('renders RecordCollaborationSection with task.instance entityType', () => {
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(pageSrc).toContain('entityType="task.instance"');
  });
  it('passes entityId and entityLabel to the collaboration section', () => {
    expect(pageSrc).toContain('entityId={record.id}');
    expect(pageSrc).toContain('entityLabel={record.title}');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(pageSrc).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(pageSrc).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('handles hash anchors for comment deep-links', () => {
    expect(pageSrc).toContain('location.hash');
    expect(pageSrc).toContain('scrollIntoView');
  });
  it('loads task via loadTaskInstanceById', () => {
    expect(pageSrc).toContain('loadTaskInstanceById');
  });
  it('renders the title via the shared RecordTitle (emits data-record-title="1")', () => {
    // CP3 migrated the page onto RecordPageShell; the data-record-title marker
    // is now emitted by the shared RecordTitle component (same as daily pages).
    expect(pageSrc).toContain('RecordTitle');
    expect(pageSrc).toContain("from '../shared/RecordPageShell.jsx'");
  });
  it('has a back link to /tasks', () => {
    expect(pageSrc).toContain("navigate('/tasks')");
  });
  it('mounts CompleteTaskModal for task completion', () => {
    expect(pageSrc).toContain('CompleteTaskModal');
  });
  it('mounts EditDueDateModal for due date editing', () => {
    expect(pageSrc).toContain('EditDueDateModal');
  });
  it('mounts AssignTaskModal for reassignment', () => {
    expect(pageSrc).toContain('AssignTaskModal');
  });
  it('mounts DeleteTaskModal for task deletion', () => {
    expect(pageSrc).toContain('DeleteTaskModal');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(pageSrc).not.toMatch(/import ActivityPanel/);
    expect(pageSrc).not.toMatch(/import ActivityModal/);
  });
  it('fires TASK_CHANGE_EVENT on mutations', () => {
    expect(pageSrc).toContain('fireTaskChangeEvent');
  });
});

describe('ActivityPanel/ActivityModal removal from list views', () => {
  it('MyTasksTab does not import ActivityPanel', () => {
    expect(myTasksSrc).not.toMatch(/import ActivityPanel/);
  });
  it('MyTasksTab does not import ActivityModal', () => {
    expect(myTasksSrc).not.toMatch(/import ActivityModal/);
  });
  it('CompletedTab does not import ActivityPanel', () => {
    expect(completedSrc).not.toMatch(/import ActivityPanel/);
  });
  it('CompletedTab does not import ActivityModal', () => {
    expect(completedSrc).not.toMatch(/import ActivityModal/);
  });
  it('CompleteTaskModal does not import ActivityPanel', () => {
    expect(completeModalSrc).not.toMatch(/import ActivityPanel/);
  });
});

describe('/tasks/<id> subpath routing', () => {
  it('main.jsx has isTasksSubpath detection', () => {
    expect(mainSrc).toContain("location.pathname.startsWith('/tasks/')");
  });
  it('main.jsx URL adapter guard includes /tasks/ subpath', () => {
    expect(mainSrc).toContain("view === 'tasks' && location.pathname.startsWith('/tasks/')");
  });
  it('activityRegistry task.instance route returns /tasks/<id>', () => {
    expect(registrySrc).toContain('route: (id) => `/tasks/${encodeURIComponent(id)}`');
  });
  it('activityRegistry routeToView handles /tasks/ subpaths', () => {
    expect(registrySrc).toContain("path.startsWith('/tasks/')");
  });
  it('resolveNotificationRoute returns /tasks/<id> for task_instance_id', () => {
    expect(registrySrc).toContain('`/tasks/${encodeURIComponent(notification.task_instance_id)}`');
  });
  it('resolveNotificationRoute does not use ?task= query params', () => {
    expect(registrySrc).not.toContain("'/tasks?task=");
    expect(registrySrc).not.toContain("'/tasks?tab=completed");
  });
});

describe('tasksCenterApi — loadTaskInstanceById', () => {
  it('exports loadTaskInstanceById', () => {
    expect(apiSrc).toMatch(/export\s+async\s+function\s+loadTaskInstanceById/);
  });
  it('queries task_instances by id with maybeSingle', () => {
    expect(apiSrc).toContain("from('task_instances')");
    expect(apiSrc).toContain(".eq('id', id)");
    expect(apiSrc).toContain('.maybeSingle()');
  });
});

describe('TasksRouter — legacy redirect and sub-routing', () => {
  it('TaskCenterView exports TasksRouter as default', () => {
    expect(centerSrc).toMatch(/export default function TasksRouter/);
  });
  it('TasksRouter redirects ?task=<id> to /tasks/<id>', () => {
    expect(centerSrc).toContain("params.get('task')");
    expect(centerSrc).toContain("navigate('/tasks/'");
    expect(centerSrc).toContain('{replace: true}');
  });
  it('TasksRouter mounts TaskInstancePage for /tasks/<id>', () => {
    expect(centerSrc).toContain("location.pathname.startsWith('/tasks/')");
    expect(centerSrc).toContain('TaskInstancePage');
  });
  it('TaskCenterView no longer has deep-link state', () => {
    expect(centerSrc).not.toContain('deepLinkTaskId');
    expect(centerSrc).not.toContain('deepLinkNonce');
    expect(centerSrc).not.toContain('onDeepLinkMiss');
    expect(centerSrc).not.toContain('applyDeepLink');
  });
});

describe('TaskInstancePage - cold-boot readiness', () => {
  const loadAllMatch = pageSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}React\.useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the task record page in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('keeps missing task rows as not-found while surfacing helper failures', () => {
    expect(loadAllSrc).toContain('loadTaskInstanceById(sb, recordId)');
    expect(loadAllSrc).toContain('loadEligibleProfilesById(sb)');
    expect(loadAllSrc).toContain('loadTaskAssignableProfilesById(sb)');
    expect(loadAllSrc).toContain('setRecord(task || null);');
    expect(loadAllSrc).toContain('Could not load task record');
  });

  it('clears stale task/profile state and renders loadError through InlineNotice', () => {
    expect(loadAllSrc).toContain('setRecord(null);');
    expect(loadAllSrc).toContain('setProfiles({});');
    expect(loadAllSrc).toContain('setAssignableProfiles({});');
    expect(pageSrc).toMatch(/if \(loadError\)[\s\S]*?<InlineNotice notice=\{loadError\}/);
  });

  it('exposes a loaded marker only on the resolved task record body', () => {
    expect(pageSrc).toMatch(/<RecordPageBody[^>]*data-task-instance-record-loaded="true"/);
  });
});
