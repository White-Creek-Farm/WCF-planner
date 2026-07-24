import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {resolveNotificationRoute} from '../../src/lib/activityRegistry.js';

// Static guards proving Processing Center work is EXCLUDED from the Task Center
// (Build Queue item 5), plus the still-valid processing NOTIFICATION deep-link
// plumbing (which is independent of the Task Center list):
//   • MyTasksTab no longer renders a 'Processing work' section and no longer
//     fetches list_my_processing_subtasks — processing_subtasks are not
//     task_instances and must not appear in any Task Center list surface;
//   • processingApi.js no longer exports the listMyProcessingSubtasks client
//     wrapper (the RPC stays deployed but has no client consumer);
//   • the activityRegistry + notification resolver still deep-link
//     processing.record / processing_subtask_assigned to /processing?record=
//     so assignees still reach their work from the Processing record;
//   • the Header routes every /processing* notification through
//     navigateToProcessingRoute (query string preserved + open-record event
//     for the already-mounted view);
//   • notificationsApi stays the ONLY client that touches the notifications
//     table (all inserts happen inside SECDEF RPCs).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const myTasks = read('src/tasks/MyTasksTab.jsx');
const processingApi = read('src/lib/processingApi.js');
const header = read('src/shared/Header.jsx');

describe('Task Center excludes Processing Center work (Build Queue item 5)', () => {
  it('MyTasksTab renders no Processing work section and fetches no processing subtasks', () => {
    // The removed section and every marker/state that fed it must be gone, so
    // no processing_subtasks row can appear in a task_instances list surface.
    for (const forbidden of [
      'data-tasks-section="processing"',
      'data-processing-work-row',
      'data-processing-work-date',
      'listMyProcessingSubtasks',
      'list_my_processing_subtasks',
      'navigateToProcessingRecord',
      'processingWork',
      'Processing work (',
    ]) {
      expect(myTasks, `MyTasksTab must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // The two remaining sections (mine + others) render ordinary task_instances
    // exactly as before; the Processing section is not among them.
    expect(myTasks).toContain('data-tasks-section="mine"');
    expect(myTasks).toContain('data-tasks-section="others"');
  });

  it('processingApi.js no longer exports the listMyProcessingSubtasks client wrapper', () => {
    expect(processingApi).not.toContain('export async function listMyProcessingSubtasks');
    expect(processingApi).not.toContain('listMyProcessingSubtasks');
  });
});

describe('notification + registry routing into /processing?record=', () => {
  it('resolveNotificationRoute deep-links processing_subtask_assigned to the exact record', () => {
    expect(
      resolveNotificationRoute({
        type: 'processing_subtask_assigned',
        activity_entity_type: 'processing.record',
        activity_entity_id: 'prc-xyz',
      }),
    ).toBe('/processing?record=prc-xyz');
    // Event resolution is best-effort server-side: a notification without a
    // resolvable event falls back to the flat page, never a broken route.
    expect(resolveNotificationRoute({type: 'processing_subtask_assigned'})).toBe('/processing');
  });

  it('activityRegistry routes processing.record through processingRecordRoute (?record=)', () => {
    const registry = read('src/lib/activityRegistry.js');
    expect(registry).toMatch(/import \{processingRecordRoute\} from '\.\/processingNav\.js';/);
    expect(registry).toMatch(/route: \(id\) => processingRecordRoute\(id\)/);
  });

  it('Header routes /processing* notification clicks via navigateToProcessingRoute', () => {
    expect(header).toMatch(/import \{navigateToProcessingRoute\} from '\.\.\/lib\/processingNav\.js';/);
    // The startsWith guard catches EVERY /processing route shape (flat,
    // ?record=, ?source=) before the generic view/record-page routing.
    expect(header).toMatch(/if \(route\.startsWith\('\/processing'\)\) \{/);
    expect(header).toContain('navigateToProcessingRoute(headerNavigate, route)');
  });
});

describe('notifications table client boundary', () => {
  it("src/lib/notificationsApi.js stays the ONLY runtime client touching .from('notifications')", () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
        if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/(^|\s)\/\/[^\n]*/g, '$1')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        if (/\.from\(\s*['"]notifications['"]\s*\)/.test(code)) {
          offenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual(['src/lib/notificationsApi.js']);
  });
});
