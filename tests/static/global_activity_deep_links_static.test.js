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
  it('routes task_completed to completed tab with task id', () => {
    const route = resolveNotificationRoute({type: 'task_completed', task_instance_id: 'ti-123'});
    expect(route).toBe('/tasks?tab=completed&task=ti-123');
  });

  it('routes task mention to /tasks?task=<id>', () => {
    const route = resolveNotificationRoute({type: 'mention', task_instance_id: 'ti-456'});
    expect(route).toBe('/tasks?task=ti-456');
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

  it('Header dispatches wcf-task-deep-link event for same-page navigation', () => {
    expect(headerSrc).toContain('wcf-task-deep-link');
    expect(headerSrc).toContain('dispatchEvent');
  });

  it('TaskCenterView listens for wcf-task-deep-link event', () => {
    expect(taskCenterSrc).toContain('wcf-task-deep-link');
    expect(taskCenterSrc).toContain('addEventListener');
  });

  it('Header imports and uses resolveNotificationRoute', () => {
    expect(headerSrc).toContain('resolveNotificationRoute');
    expect(headerSrc).toContain('resolveNotificationRoute(n)');
  });

  it('Header does not reference setAdminTab', () => {
    expect(headerSrc).not.toContain('setAdminTab');
  });
});

describe('task deep-link — open tasks (MyTasksTab)', () => {
  it('TaskCenterView parses tab and task from deep link', () => {
    expect(taskCenterSrc).toContain("params.get('tab')");
    expect(taskCenterSrc).toContain("params.get('task')");
  });

  it('TaskCenterView switches to completed tab when tab=completed', () => {
    expect(taskCenterSrc).toContain("setActiveTab('completed')");
  });

  it('TaskCenterView switches to mine tab when task without tab', () => {
    expect(taskCenterSrc).toContain("setActiveTab('mine')");
  });

  it('MyTasksTab accepts deepLinkTaskId and opens activity', () => {
    expect(myTasksSrc).toContain('deepLinkTaskId');
    expect(myTasksSrc).toContain('setActivityTarget');
    expect(myTasksSrc).toContain('scrollIntoView');
  });

  it('MyTasksTab calls onDeepLinkMiss when task not found in open tasks', () => {
    expect(myTasksSrc).toContain('onDeepLinkMiss');
  });

  it('MyTasksTab calls onDeepLinkHandled when task is found', () => {
    expect(myTasksSrc).toContain('onDeepLinkHandled');
  });

  it('MyTasksTab uses deepLinkNonce to handle re-clicks', () => {
    expect(myTasksSrc).toContain('deepLinkNonce');
  });

  it('TaskCenterView provides onDeepLinkMiss that switches to completed', () => {
    expect(taskCenterSrc).toContain('onDeepLinkMiss');
    expect(taskCenterSrc).toMatch(/onDeepLinkMiss[\s\S]*?setActiveTab\('completed'\)/);
  });

  it('TaskCenterView clears deepLinkTaskId via onDeepLinkHandled', () => {
    expect(taskCenterSrc).toContain('onDeepLinkHandled');
    expect(taskCenterSrc).toMatch(/onDeepLinkHandled[\s\S]*?setDeepLinkTaskId\(null\)/);
  });
});

describe('task deep-link — completed tasks (CompletedTab)', () => {
  it('CompletedTab accepts deepLinkTaskId, deepLinkNonce, and onDeepLinkHandled', () => {
    expect(completedSrc).toContain('deepLinkTaskId');
    expect(completedSrc).toContain('deepLinkNonce');
    expect(completedSrc).toContain('onDeepLinkHandled');
  });

  it('CompletedTab scrolls to deep-linked task', () => {
    expect(completedSrc).toContain('scrollIntoView');
    expect(completedSrc).toContain('data-task-row');
  });

  it('CompletedTab opens ActivityPanel for deep-linked task', () => {
    expect(completedSrc).toContain('setActivityTarget');
    expect(completedSrc).toContain("entityType: 'task.instance'");
  });

  it('CompletedTab renders ActivityModal', () => {
    expect(completedSrc).toContain('ActivityModal');
  });

  it('CompletedTab calls onDeepLinkHandled after lookup', () => {
    expect(completedSrc).toContain('onDeepLinkHandled()');
  });

  it('TaskCenterView passes deepLinkTaskId, deepLinkNonce, and onDeepLinkHandled to CompletedTab', () => {
    expect(taskCenterSrc).toMatch(/CompletedTab,\s*\{[\s\S]*?deepLinkTaskId/);
    expect(taskCenterSrc).toMatch(/CompletedTab,\s*\{[\s\S]*?deepLinkNonce/);
    expect(taskCenterSrc).toMatch(/CompletedTab,\s*\{[\s\S]*?onDeepLinkHandled/);
  });
});
