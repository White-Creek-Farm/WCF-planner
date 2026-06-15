// ============================================================================
// Task Center remaining tabs — Operator Clarity lock
// ============================================================================
// Sibling to `tasks_my_tab_filter_and_buckets.test.js`. The earlier My Tasks
// pass shipped chip-based filtering + due-state buckets + top-2 cross-team
// pre-expand. This file locks the matching clarity pass for the other three
// Task Center tabs:
//
//   Completed:  filter chip bar (All / Recurring / System / With photos /
//               With notes) + date buckets (Today / Last 7 days / Older).
//
//   Recurring:  Active / Inactive template sub-sections (Inactive collapses
//               behind a single toggle by default). Conservative per-template
//               pre-expand — templates with ≥1 open instance auto-expand;
//               solo zero-open templates stay collapsed.
//
//   System:     Active / Inactive rule sub-sections (Inactive collapses
//               behind a single toggle by default). Per-rule overdue count
//               surfaces when ≥1 open instance is past due. NO per-rule
//               auto-expand (config view, not a work-queue scan; T5 e2e
//               contract asserts default-collapsed bodies).
//
// All three tabs preserve the existing data-* hooks the Playwright suite
// asserts against; new hooks are scoped to the new structure (sub-section
// containers, inactive toggle, chip bar) and a separate overdue-count badge.
//
// Load-bearing contracts the lock implicitly preserves (each tab body):
//   - No direct `.insert/.update/.delete` on task_* tables. Writes flow
//     through tasksCenterMutationsApi wrappers only.
//   - Assignable profile dropdowns still pass the FILTERED profile map.
//   - System task generation stays in cron / Edge. The frontend never
//     calls generate_system_task_instance.
//   - No window.alert/confirm/prompt anywhere in these files (typed-
//     confirmation modal pattern preserved for template delete).
// ============================================================================

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const completedSrc = readFileSync(resolve(ROOT, 'src/tasks/CompletedTab.jsx'), 'utf8');
const recurringSrc = readFileSync(resolve(ROOT, 'src/tasks/RecurringTab.jsx'), 'utf8');
const systemSrc = readFileSync(resolve(ROOT, 'src/tasks/SystemTasksTab.jsx'), 'utf8');

const TAB_SOURCES = [
  ['src/tasks/CompletedTab.jsx', completedSrc],
  ['src/tasks/RecurringTab.jsx', recurringSrc],
  ['src/tasks/SystemTasksTab.jsx', systemSrc],
];

// ── Completed tab ─────────────────────────────────────────────────────────
describe('CompletedTab — filter chip bar', () => {
  it('defines a FILTERS list with All / Recurring / System / With photos / With notes', () => {
    expect(completedSrc).toMatch(/const FILTERS\s*=\s*\[/);
    for (const key of ['all', 'recurring', 'system', 'photos', 'notes']) {
      expect(completedSrc, `filter key ${key} missing`).toMatch(new RegExp(`\\{key:\\s*'${key}'`));
    }
  });

  it('renders the filter chip bar with the lock hooks', () => {
    expect(completedSrc).toMatch(/data-tasks-filter-bar="1"/);
    expect(completedSrc).toMatch(/data-tasks-filter-chip=\{f\.key\}/);
    expect(completedSrc).toMatch(/data-tasks-filter-active=/);
  });

  it('filter bar uses role="group" + aria-pressed buttons (NOT a tablist)', () => {
    expect(completedSrc).toMatch(/data-tasks-filter-bar="1"[^/]*role="group"/);
    expect(completedSrc).toMatch(/aria-label="Completed filter"/);
    expect(completedSrc).toMatch(/aria-pressed=\{active\}/);
    expect(completedSrc).not.toMatch(/data-tasks-filter-bar="1"[^/]*role="tablist"/);
  });

  it('matchesCompletedFilter has branches for every chip', () => {
    expect(completedSrc).toMatch(/function matchesCompletedFilter\(/);
    expect(completedSrc).toMatch(/filter === 'recurring'/);
    expect(completedSrc).toMatch(/filter === 'system'/);
    expect(completedSrc).toMatch(/filter === 'photos'/);
    expect(completedSrc).toMatch(/filter === 'notes'/);
  });

  it('filter scopes the loaded list via visibleRows before bucketing', () => {
    expect(completedSrc).toMatch(/const visibleRows = React\.useMemo/);
    expect(completedSrc).toMatch(/rows\.filter\(\(ti\) => matchesCompletedFilter\(ti, filter\)\)/);
    expect(completedSrc).toMatch(/bucketByCompletedAt\(visibleRows/);
  });
});

describe('CompletedTab — date buckets', () => {
  it('defines bucketByCompletedAt helper', () => {
    expect(completedSrc).toMatch(/function bucketByCompletedAt\(rows, todayStr\)/);
  });

  it('renders three bucket hooks (today / last-7-days / older)', () => {
    expect(completedSrc).toMatch(/data-tasks-completed-bucket=\{bucketKey\}/);
    expect(completedSrc).toMatch(/data-tasks-completed-bucket-count=\{bucketRows\.length\}/);
    expect(completedSrc).toMatch(/renderBucket\('today',\s*'Today'/);
    expect(completedSrc).toMatch(/renderBucket\('last-7-days',\s*'Last 7 days'/);
    expect(completedSrc).toMatch(/renderBucket\('older',\s*'Older'/);
  });

  it('empty buckets are skipped at render time', () => {
    expect(completedSrc).toMatch(/if \(!bucketRows \|\| bucketRows\.length === 0\) return null/);
  });

  it('bucket comparison runs in America/Chicago, not UTC', () => {
    // Codex 2026-05-14 hotfix: a 9:00 PM Central completion is the next
    // UTC day. Slicing the row's toISOString() would push it into the
    // wrong bucket and contradict the Central section labels. Lock that
    // the comparison uses centralISOFor (the shared Central YMD helper)
    // for the row date, and that the raw UTC slice pattern is gone.
    expect(completedSrc).toMatch(/import \{[^}]*centralISOFor[^}]*\} from '\.\.\/lib\/dateUtils\.js'/);
    expect(completedSrc).toMatch(/const atYMD = centralISOFor\(ti\.completed_at\)/);
    expect(completedSrc).not.toMatch(/at\.toISOString\(\)\.slice\(0,\s*10\)/);
  });
});

describe('CompletedTab — preserved row contract + read-only boundary', () => {
  const REQUIRED_HOOKS = [
    'data-tasks-tab="completed"',
    'data-task-row=',
    'data-task-designation=',
    'data-task-status="completed"',
    'data-completed-at=',
    'data-due-date=',
    'data-completed-by-name=',
    'data-completion-note="1"',
    'data-task-attribution-label=',
  ];
  for (const hook of REQUIRED_HOOKS) {
    it(`preserves ${hook}`, () => {
      expect(completedSrc, `missing required data-* hook: ${hook}`).toContain(hook);
    });
  }

  it('renders the shared TaskPhotoThumbnailButton, which owns the photo data-* hooks', () => {
    // The data-task-has-photo / data-task-photo-open hooks moved into the shared
    // TaskPhotoThumbnailButton component (commit 8394162). The row still renders
    // them through that button, so the e2e photo hooks stay present in the DOM.
    expect(completedSrc).toContain('TaskPhotoThumbnailButton');
    const photoBtn = readFileSync(resolve(ROOT, 'src/tasks/TaskPhotoThumbnailButton.jsx'), 'utf8');
    expect(photoBtn).toContain('data-task-has-photo="1"');
    expect(photoBtn).toContain('data-task-photo-open="1"');
  });

  it('imports only read helpers — no mutation wrapper imports', () => {
    // Lock the T2/T4 read-only contract: Completed tab uses the
    // TASK_CHANGE_EVENT name to refresh after a sibling tab completes a
    // task, but must NOT pull in any write wrappers from
    // tasksCenterMutationsApi (no fireTaskChangeEvent, no delete/edit/
    // complete RPCs).
    expect(completedSrc).toMatch(/from '\.\.\/lib\/tasksCenterMutationsApi\.js'/);
    expect(completedSrc).toMatch(/import \{TASK_CHANGE_EVENT\} from '\.\.\/lib\/tasksCenterMutationsApi\.js'/);
    expect(completedSrc).not.toMatch(/fireTaskChangeEvent/);
    expect(completedSrc).not.toMatch(/completeTaskInstance/);
    expect(completedSrc).not.toMatch(/deleteTaskInstance/);
  });
});

// ── Recurring tab ─────────────────────────────────────────────────────────
describe('RecurringTab — active / inactive sub-sections', () => {
  it('partitions templates by active flag', () => {
    expect(recurringSrc).toMatch(/grouped\.templates\.filter\(\(b\) => b\.template\.active\)/);
    expect(recurringSrc).toMatch(/grouped\.templates\.filter\(\(b\) => !b\.template\.active\)/);
  });

  it('renders active sub-section with hook', () => {
    expect(recurringSrc).toMatch(/data-recurring-section="active"/);
    expect(recurringSrc).toMatch(/Active templates \(\{activeBuckets\.length\}\)/);
  });

  it('renders inactive sub-section behind a collapsible toggle', () => {
    expect(recurringSrc).toMatch(/data-recurring-section="inactive"/);
    expect(recurringSrc).toMatch(/data-recurring-inactive-toggle="1"/);
    expect(recurringSrc).toMatch(/data-recurring-inactive-state=\{showInactive \? 'expanded' : 'collapsed'\}/);
    expect(recurringSrc).toMatch(/const \[showInactive, setShowInactive\] = React\.useState\(false\)/);
  });

  it('hides the inactive section entirely when there are no inactive templates', () => {
    expect(recurringSrc).toMatch(/inactiveBuckets\.length > 0/);
  });
});

describe('RecurringTab — conservative pre-expand on open count', () => {
  it('isTemplateOpen falls back to openCount >= 1 default', () => {
    expect(recurringSrc).toMatch(/function isTemplateOpen\(b\)/);
    expect(recurringSrc).toMatch(/return b\.openCount >= 1;/);
  });

  it('manual toggle override wins over the default', () => {
    expect(recurringSrc).toMatch(/Object\.prototype\.hasOwnProperty\.call\(expandedOverride, key\)/);
    expect(recurringSrc).toMatch(/setExpandedOverride/);
  });
});

describe('RecurringTab — preserved hooks + admin/mutation boundary', () => {
  const REQUIRED_HOOKS = [
    'data-tasks-tab="recurring"',
    'data-recurring-template=',
    'data-recurring-template-body=',
    'data-recurring-new-button="1"',
    'data-recurring-edit-button=',
    'data-recurring-delete-button=',
    'data-template-state=',
    'data-template-open-count=',
    'data-tasks-group-state=',
    'data-recurring-orphans="1"',
    'data-delete-template-modal="1"',
    'data-delete-template-field=',
    'data-delete-template-save="1"',
  ];
  for (const hook of REQUIRED_HOOKS) {
    it(`preserves ${hook}`, () => {
      expect(recurringSrc, `missing required data-* hook: ${hook}`).toContain(hook);
    });
  }

  it('template delete still routes through deleteRecurringTaskTemplate wrapper', () => {
    expect(recurringSrc).toMatch(/import \{[^}]*deleteRecurringTaskTemplate[^}]*\}/);
    expect(recurringSrc).toMatch(/await deleteRecurringTaskTemplate\(sb, template\.id\)/);
  });

  it('no direct task_templates / task_instances writes', () => {
    expect(recurringSrc).not.toMatch(/from\(['"]task_templates['"]\)\s*\.(insert|update|delete|upsert)/);
    expect(recurringSrc).not.toMatch(/from\(['"]task_instances['"]\)\s*\.(insert|update|delete|upsert)/);
  });
});

// ── System Tasks tab ─────────────────────────────────────────────────────
describe('SystemTasksTab — active / inactive sub-sections', () => {
  it('partitions rules by active flag', () => {
    expect(systemSrc).toMatch(/grouped\.rules\.filter\(\(b\) => b\.rule\.active\)/);
    expect(systemSrc).toMatch(/grouped\.rules\.filter\(\(b\) => !b\.rule\.active\)/);
  });

  it('renders active sub-section with hook', () => {
    expect(systemSrc).toMatch(/data-system-section="active"/);
    expect(systemSrc).toMatch(/Active rules \(\{activeBuckets\.length\}\)/);
  });

  it('renders inactive sub-section behind a collapsible toggle', () => {
    expect(systemSrc).toMatch(/data-system-section="inactive"/);
    expect(systemSrc).toMatch(/data-system-inactive-toggle="1"/);
    expect(systemSrc).toMatch(/data-system-inactive-state=\{showInactive \? 'expanded' : 'collapsed'\}/);
    expect(systemSrc).toMatch(/const \[showInactive, setShowInactive\] = React\.useState\(false\)/);
  });

  it('hides the inactive section entirely when there are no inactive rules', () => {
    expect(systemSrc).toMatch(/inactiveBuckets\.length > 0/);
  });
});

describe('SystemTasksTab — per-rule overdue count', () => {
  it('overdueCountFor helper counts overdue instances via dueStateFor', () => {
    expect(systemSrc).toMatch(/function overdueCountFor\(instances, todayStr\)/);
    expect(systemSrc).toMatch(/dueStateFor\(ti, todayStr\) === 'overdue'/);
  });

  it('header pill renders only when overdueCount > 0', () => {
    expect(systemSrc).toMatch(/overdueCount > 0 &&/);
    expect(systemSrc).toMatch(/data-rule-overdue-count=\{overdueCount\}/);
  });
});

describe('SystemTasksTab — no auto-expand (config view, not a work-queue scan)', () => {
  it('per-rule expand state is purely manual (no auto-expand on open count)', () => {
    // The expanded state remains a simple useState boolean map keyed
    // by rule id; isOpen falls back to false (`!!expanded[key]`) when
    // the key is absent. T5 e2e contract: `data-system-rule-body=...`
    // has count 0 at initial load.
    expect(systemSrc).toMatch(/const \[expanded, setExpanded\] = React\.useState\(\{\}\);/);
    expect(systemSrc).toMatch(/const isOpen = !!expanded\[key\];/);
    // Defensive: no code path that pre-fills expanded from open count.
    expect(systemSrc).not.toMatch(/openCount >= 1/);
  });
});

describe('SystemTasksTab — preserved hooks + read-only generator boundary', () => {
  const REQUIRED_HOOKS = [
    'data-tasks-tab="system"',
    'data-system-rule=',
    'data-system-rule-body=',
    'data-system-rule-edit-button=',
    'data-rule-state=',
    'data-rule-generator-kind=',
    'data-rule-lead-time-days=',
    'data-rule-open-count=',
    'data-tasks-group-state=',
    'data-system-orphans="1"',
    'data-source-event-key=',
    'data-due-state=',
    'data-due-date=',
  ];
  for (const hook of REQUIRED_HOOKS) {
    it(`preserves ${hook}`, () => {
      expect(systemSrc, `missing required data-* hook: ${hook}`).toContain(hook);
    });
  }

  it('does not import or call the system-task generator RPC from the frontend', () => {
    expect(systemSrc).not.toMatch(/generate_system_task_instance/);
    expect(systemSrc).not.toMatch(/from\(['"]task_system_rules['"]\)\s*\.(insert|update|delete|upsert)/);
    expect(systemSrc).not.toMatch(/from\(['"]task_instances['"]\)\s*\.(insert|update|delete|upsert)/);
  });
});

// ── Cross-tab: no native dialogs anywhere in the three files ─────────────
describe('remaining tabs — no native browser dialogs', () => {
  // The three tab files must not introduce window.alert / window.confirm /
  // window.prompt. Typed-confirmation modal stays the only deletion path
  // on Recurring; Completed is read-only; System has Edit-Rule only.
  // Identifier-boundary regex from the prod-stability lock pattern.
  const NATIVE_DIALOG_RE = /(?:^|[^A-Za-z0-9_.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/m;
  for (const [label, src] of TAB_SOURCES) {
    it(`${label}: no raw alert / confirm / prompt`, () => {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
      expect(code, `${label} contains a raw native dialog call`).not.toMatch(NATIVE_DIALOG_RE);
    });
  }
});
