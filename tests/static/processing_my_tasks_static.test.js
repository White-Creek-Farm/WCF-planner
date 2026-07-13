import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {resolveNotificationRoute} from '../../src/lib/activityRegistry.js';

// Static guards for the My Tasks "Processing work" section + its navigation
// plumbing (processing-planner-integration lane, mig 175 read RPC + mig 177
// notifications):
//   • MyTasksTab renders a LINK-ONLY 'Processing work' section fed by
//     list_my_processing_subtasks — these rows are NOT task_instances: no
//     due-date buckets, no complete/edit-due/assign/delete controls; each row
//     just opens its Processing record via processingNav;
//   • the Processing loader failure degrades to an empty (hidden) section and
//     can never take down My Tasks;
//   • the activityRegistry + notification resolver deep-link
//     processing.record / processing_subtask_assigned to /processing?record=;
//   • the Header routes every /processing* notification through
//     navigateToProcessingRoute (query string preserved + open-record event
//     for the already-mounted view);
//   • notificationsApi stays the ONLY client that touches the notifications
//     table (all inserts happen inside SECDEF RPCs).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const myTasks = read('src/tasks/MyTasksTab.jsx');
const header = read('src/shared/Header.jsx');

// The Processing work section block: from its data-tasks-section marker to the
// next section ("others"). Scoped assertions below run against ONLY this slice
// so surrounding task_instances markup can't mask a regression.
const sectionStart = myTasks.indexOf('data-tasks-section="processing"');
const sectionEnd = myTasks.indexOf('data-tasks-section="others"');

describe('MyTasksTab — Processing work section', () => {
  it('renders the section fed by listMyProcessingSubtasks with a .catch degrade', () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    expect(myTasks).toMatch(/import \{listMyProcessingSubtasks\} from '\.\.\/lib\/processingApi\.js';/);
    // A Processing loader failure degrades to an empty (hidden) section —
    // it must never reject the Promise.all that loads My Tasks proper.
    expect(myTasks).toMatch(/listMyProcessingSubtasks\(sb\)\.catch\(\(\) => \[\]\)/);
    // Section header + link-only copy.
    expect(myTasks).toMatch(/Processing work \(\{processingWork\.length\}\)/);
    expect(myTasks).toContain('processingWork.length > 0 &&');
  });

  it('the section is LINK-ONLY: no complete/assign/due-date controls, no task-row machinery', () => {
    const section = myTasks.slice(sectionStart, sectionEnd);
    for (const forbidden of [
      'data-task-complete-button',
      'data-task-edit-due-button',
      'data-task-assign-button',
      'data-task-delete-button',
      '<TaskRow',
      'dueStateFor',
      'data-tasks-due-bucket',
      'setCompleteTaskTarget',
      'setEditDueTarget',
      'setAssignTarget',
      'setDeleteTarget',
    ]) {
      expect(section, `Processing section must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Rows are identifiable + display-only (program dot, record title, date text).
    expect(section).toContain('data-processing-work-row={st.subtask_id}');
    expect(section).toContain('data-processing-work-date={st.processing_date}');
  });

  it('rows navigate via processingNav.navigateToProcessingRecord (drawer deep link)', () => {
    expect(myTasks).toMatch(/import \{navigateToProcessingRecord\} from '\.\.\/lib\/processingNav\.js';/);
    const section = myTasks.slice(sectionStart, sectionEnd);
    expect(section).toContain('navigateToProcessingRecord(navigate, st.record_id)');
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
