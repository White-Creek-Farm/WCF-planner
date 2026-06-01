import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {
  ENTITY_TYPES,
  ACTIVITY_REGISTRY,
  resolveNotificationRoute,
  routeToView,
} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');
const notifApiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/notificationsApi.js'), 'utf8');
const mig062 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/062_activity_entity_expansion.sql'), 'utf8');
const taskCenterSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/TaskCenterView.jsx'), 'utf8');
const myTasksSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/MyTasksTab.jsx'), 'utf8');
const completedSrc = fs.readFileSync(path.join(ROOT, 'src/tasks/CompletedTab.jsx'), 'utf8');

const EXPECTED_TYPES = [
  'task.instance',
  'broiler.batch',
  'layer.batch',
  'layer.housing',
  'cattle.animal',
  'sheep.animal',
  'equipment.item',
];

describe('activityRegistry entity types', () => {
  it('exports all expected entity types', () => {
    for (const t of EXPECTED_TYPES) {
      expect(Object.values(ENTITY_TYPES), `missing ENTITY_TYPES value: ${t}`).toContain(t);
    }
  });

  it('has registry entries for all entity types', () => {
    for (const t of EXPECTED_TYPES) {
      expect(ACTIVITY_REGISTRY[t], `missing registry entry: ${t}`).toBeTruthy();
      expect(typeof ACTIVITY_REGISTRY[t].displayLabel).toBe('function');
      expect(typeof ACTIVITY_REGISTRY[t].route).toBe('function');
    }
  });
});

describe('SQL migration 062 — role gate + entity resolver', () => {
  it('includes profile_role guard in _activity_can_read', () => {
    expect(mig062).toContain('profile_role()');
    expect(mig062).toMatch(/v_role\s*:=\s*public\.profile_role\(\)/);
  });

  it('rejects null role in _activity_can_read', () => {
    expect(mig062).toMatch(/v_role IS NULL[\s\S]*?RETURN false/);
  });

  it('rejects inactive role in _activity_can_read', () => {
    expect(mig062).toMatch(/v_role\s*=\s*'inactive'[\s\S]*?RETURN false/);
  });

  it('rejects null/blank entity_type and entity_id', () => {
    expect(mig062).toMatch(/p_entity_type IS NULL/);
    expect(mig062).toMatch(/p_entity_id IS NULL/);
  });

  it('includes profile_role guard in _activity_can_write', () => {
    const writeBlock = mig062.slice(mig062.indexOf('_activity_can_write'));
    expect(writeBlock).toContain('profile_role()');
    expect(writeBlock).toMatch(/v_role IS NULL OR v_role = 'inactive'/);
  });

  for (const t of EXPECTED_TYPES) {
    it(`has _activity_can_read branch for ${t}`, () => {
      expect(mig062).toContain(`'${t}'`);
    });
  }

  it('broiler batch resolver uses structured jsonb, not string concatenation', () => {
    expect(mig062).toContain('jsonb_build_array(jsonb_build_object');
    expect(mig062).not.toMatch(/'\[\{"name":"'\s*\|\|/);
  });

  it('enforces program_access via profile_program_access()', () => {
    expect(mig062).toContain('profile_program_access()');
  });

  const PROGRAM_MAP = {
    'broiler.batch': 'broiler',
    'layer.batch': 'layer',
    'layer.housing': 'layer',
    'cattle.animal': 'cattle',
    'sheep.animal': 'sheep',
    'equipment.item': 'equipment',
  };
  for (const [entity, program] of Object.entries(PROGRAM_MAP)) {
    it(`maps ${entity} to program '${program}'`, () => {
      const idx = mig062.indexOf(`'${entity}'`);
      const block = mig062.slice(idx, idx + 600);
      expect(block).toContain(`'${program}' = ANY(v_access)`);
    });
  }

  it('admin bypasses program_access for non-task entities', () => {
    expect(mig062).toMatch(/v_role = 'admin'[\s\S]*?RETURN true/);
  });

  it('task.* types do NOT check program_access', () => {
    const taskBlock = mig062.slice(mig062.indexOf("'task.instance'"), mig062.indexOf("'broiler.batch'"));
    expect(taskBlock).not.toContain('profile_program_access');
  });

  it('ends with schema reload', () => {
    expect(mig062).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('resolveNotificationRoute — task deep links', () => {
  it('routes task_completed to /tasks/<id> record page', () => {
    const route = resolveNotificationRoute({type: 'task_completed', task_instance_id: 'ti-123'});
    expect(route).toBe('/tasks/ti-123');
  });

  it('routes task mention to /tasks/<id> record page', () => {
    const route = resolveNotificationRoute({type: 'mention', task_instance_id: 'ti-456'});
    expect(route).toBe('/tasks/ti-456');
  });

  it('falls back to /tasks for unknown types', () => {
    expect(resolveNotificationRoute({type: 'unknown'})).toBe('/tasks');
  });
});

describe('routeToView', () => {
  it('maps /tasks to tasks view with search', () => {
    expect(routeToView('/tasks?tab=completed&task=ti-123')).toEqual({
      view: 'tasks',
      search: 'tab=completed&task=ti-123',
    });
  });
});

describe('notification deep-link infrastructure', () => {
  it('notificationsApi loads activity_event_id', () => {
    expect(notifApiSrc).toContain('activity_event_id');
  });

  it('Header direct-navigates record-page routes, not all clean paths', () => {
    expect(headerSrc).toContain('isRecordPageRoute');
    expect(headerSrc).toContain("route.startsWith('/tasks/')");
    expect(headerSrc).toContain("route.startsWith('/fleet/')");
    expect(headerSrc).toContain('headerNavigate(route)');
  });

  it('Header does NOT use the generic clean-path direct-navigate condition', () => {
    expect(headerSrc).not.toContain("route.startsWith('/') && !route.includes('?')");
  });

  it('Header no longer dispatches the legacy _wcfEntityDeepLink bridge', () => {
    expect(headerSrc).not.toContain('_wcfEntityDeepLink');
    expect(headerSrc).not.toContain('wcf-entity-deep-link');
  });

  it('Header imports and uses resolveNotificationRoute', () => {
    expect(headerSrc).toContain('resolveNotificationRoute');
    expect(headerSrc).toContain('resolveNotificationRoute(');
  });

  it('Header does not reference setAdminTab', () => {
    expect(headerSrc).not.toContain('setAdminTab');
  });
});

describe('task deep-link — record-page routing', () => {
  it('TasksRouter redirects legacy ?task=<id> to /tasks/<id>', () => {
    expect(taskCenterSrc).toContain("params.get('task')");
    expect(taskCenterSrc).toContain("navigate('/tasks/'");
    expect(taskCenterSrc).toContain('{replace: true}');
  });

  it('TasksRouter routes /tasks/<id> to TaskInstancePage', () => {
    expect(taskCenterSrc).toContain("location.pathname.startsWith('/tasks/')");
    expect(taskCenterSrc).toContain('TaskInstancePage');
  });

  it('MyTasksTab no longer has deep-link or ActivityModal machinery', () => {
    expect(myTasksSrc).not.toContain('deepLinkTaskId');
    expect(myTasksSrc).not.toContain('ActivityModal');
    expect(myTasksSrc).not.toContain('setActivityTarget');
  });

  it('CompletedTab no longer has deep-link or ActivityModal machinery', () => {
    expect(completedSrc).not.toContain('deepLinkTaskId');
    expect(completedSrc).not.toContain('ActivityModal');
    expect(completedSrc).not.toContain('setActivityTarget');
  });

  it('MyTasksTab row titles navigate to /tasks/<id>', () => {
    expect(myTasksSrc).toContain("navigate('/tasks/' + ti.id");
  });

  it('CompletedTab row titles navigate to /tasks/<id>', () => {
    expect(completedSrc).toContain("navigate('/tasks/' + t.id");
  });
});
