// ============================================================================
// MyTasksTab — filter chips + due-state bucketing + top-2 pre-expand lock
// ============================================================================
// Codex 2026-05-13 Operator Clarity pass: the My Tasks tab gained three
// scanability surfaces. This file locks each so a future refactor can't
// silently regress them.
//
//   1. Filter chip bar (All / Overdue / Today / Recurring / System).
//      Pure client-side filter on the loaded list; no API change.
//   2. Due-state buckets (Overdue / Due today / Upcoming) inside the
//      "My open tasks" section. Empty buckets skipped at render time.
//   3. Top-2-by-count pre-expand on the "All other open tasks" groups,
//      but ONLY when those groups carry 2+ tasks each — solo groups
//      stay collapsed so the page is calm when nobody has meaningful
//      workload.
//
// Implementation lives entirely inside src/tasks/MyTasksTab.jsx; the
// load-bearing contracts in PROJECT.md (no direct task_* writes from
// UI, header badge soft-fail, assignee dropdowns respect
// tasks_public_assignee_availability) are untouched.
// ============================================================================

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SRC = readFileSync(resolve(ROOT, 'src/tasks/MyTasksTab.jsx'), 'utf8');

describe('MyTasksTab — filter chip bar', () => {
  it('defines a FILTERS list with All / Overdue / Today / Recurring / System keys', () => {
    expect(SRC).toMatch(/const FILTERS\s*=\s*\[/);
    for (const key of ['all', 'overdue', 'today', 'recurring', 'system']) {
      expect(SRC, `filter key ${key} missing`).toMatch(new RegExp(`\\{key:\\s*'${key}'`));
    }
  });

  it('renders the filter chip bar with the lock hook', () => {
    expect(SRC).toMatch(/data-tasks-filter-bar="1"/);
    expect(SRC).toMatch(/data-tasks-filter-chip=\{f\.key\}/);
    expect(SRC).toMatch(/data-tasks-filter-active=/);
  });

  it('filter bar uses role="group" + aria-pressed buttons (segmented toggle, NOT a tablist)', () => {
    // Codex review: the chips are pressable filter buttons, not real
    // ARIA tabs with associated panels and roving tabindex. role="tablist"
    // would mislead assistive tech into expecting tabs semantics this
    // control does not implement. Lock role="group" + aria-label so the
    // grouped toggle-button pattern stays intentional.
    expect(SRC).toMatch(/data-tasks-filter-bar="1"[^/]*role="group"/);
    expect(SRC).toMatch(/aria-label="Task filter"/);
    expect(SRC).toMatch(/aria-pressed=\{active\}/);
    // Defensive: the filter bar must NOT regress back to role="tablist"
    // — the bar is the only place tab-like grouping has been
    // considered, so a tablist string here would only appear in that
    // context.
    expect(SRC).not.toMatch(/data-tasks-filter-bar="1"[^/]*role="tablist"/);
  });

  it('defines matchesFilter with branches for every chip', () => {
    // Pure helper: each chip key maps to a predicate branch.
    expect(SRC).toMatch(/function matchesFilter\(/);
    expect(SRC).toMatch(/filter === 'overdue'/);
    expect(SRC).toMatch(/filter === 'today'/);
    expect(SRC).toMatch(/filter === 'recurring'/);
    expect(SRC).toMatch(/filter === 'system'/);
  });

  it('filter is applied via visibleTasks before split + bucket', () => {
    // visibleTasks must be derived from the loaded tasks list with the
    // filter predicate — section counts must reflect the active chip.
    expect(SRC).toMatch(/const visibleTasks = React\.useMemo/);
    expect(SRC).toMatch(/tasks\.filter\(\(ti\) => matchesFilter\(ti, filter, todayStr\)\)/);
    expect(SRC).toMatch(/splitTasksForMyTab\(visibleTasks/);
  });

  it('changing the filter resets per-group manual override toggles', () => {
    // Filter is a separate scan mode; carrying manual toggles across
    // filter switches would surprise the operator. Reset the override
    // map so the filter-driven defaults take effect on every change.
    expect(SRC).toMatch(/setExpandedOverride\(\{\}\)/);
    expect(SRC).toMatch(/\[filter\]/);
  });
});

describe('MyTasksTab — due-state buckets in My open tasks', () => {
  it('defines bucketByDueState helper', () => {
    expect(SRC).toMatch(/function bucketByDueState\(rows, todayStr\)/);
  });

  it('renders three bucket hooks (overdue / today / upcoming)', () => {
    // Lock the data-attribute markers so e2e specs can target the
    // bucket containers and adjacent label/count blocks.
    expect(SRC).toMatch(/data-tasks-due-bucket=\{bucketKey\}/);
    expect(SRC).toMatch(/data-tasks-due-bucket-count=\{rows\.length\}/);
  });

  it('renders each bucket with its label + count via renderBucket', () => {
    expect(SRC).toMatch(/renderBucket\('overdue',\s*'Overdue'/);
    expect(SRC).toMatch(/renderBucket\('today',\s*'Due today'/);
    expect(SRC).toMatch(/renderBucket\('upcoming',\s*'Upcoming'/);
  });

  it('empty buckets are skipped at render time', () => {
    // The early-return in renderBucket keeps the section quiet when a
    // bucket has zero matches (e.g., nothing overdue today).
    expect(SRC).toMatch(/if \(!rows \|\| rows\.length === 0\) return null/);
  });
});

describe('MyTasksTab — top-2 pre-expand on cross-team groups', () => {
  it('top-2 ranking filters out groups with fewer than 2 tasks', () => {
    // Lock the conservative "≥2 tasks" threshold so solo groups stay
    // collapsed and existing default-collapsed e2e contracts hold.
    expect(SRC).toMatch(/\.filter\(\(g\) => g\.tasks\.length >= 2\)/);
    expect(SRC).toMatch(/\.sort\(\(a, b\) => b\.tasks\.length - a\.tasks\.length\)/);
    expect(SRC).toMatch(/\.slice\(0, 2\)/);
  });

  it('non-"all" filters expand every group with matching tasks', () => {
    // When a filter is active the operator wants to see every
    // matching row, so we widen the auto-expand set to all groups
    // that survived the filter (otherGroups is already filter-scoped).
    expect(SRC).toMatch(/if \(filter !== 'all'\) return new Set\(otherGroups\.map/);
  });

  it('manual toggles in expandedOverride win over the default set', () => {
    // isGroupOpen returns the explicit override when present; falls
    // back to the topTwoIds default otherwise.
    expect(SRC).toMatch(/Object\.prototype\.hasOwnProperty\.call\(expandedOverride, key\)/);
    expect(SRC).toMatch(/topTwoIds\.has\(key\)/);
  });
});

describe('MyTasksTab — row + empty-state polish', () => {
  it('attribution renders on its own line below description, not inside the action row', () => {
    // F: attribution moved out of the button row so the action area is
    // visually just buttons + photo. Hook + label string preserved.
    expect(SRC).toMatch(
      /<div style=\{\{\.\.\.SUB, marginTop: 4\}\} data-task-attribution-label=\{attribution\.label\}>/,
    );
  });

  it('empty My open tasks copy includes the create-task pointer', () => {
    // E: empty-state guidance pointing operators at +New Task above
    // and the cross-team section below so the empty state is useful.
    expect(SRC).toMatch(/Browse other open tasks below, or use \+ New Task above/);
  });

  it('empty filter copy points back at the All chip', () => {
    expect(SRC).toMatch(/No matches for the active filter\. Try the All chip/);
  });
});

describe('MyTasksTab — preserved load-bearing data-* hooks', () => {
  // The new layout MUST preserve every hook the existing e2e specs
  // assert against. A regression here would silently break the
  // tasks_v2_* Playwright suite without a static lock to catch it.
  const REQUIRED_HOOKS = [
    'data-tasks-tab="my-tasks"',
    'data-tasks-section="mine"',
    'data-tasks-section="others"',
    'data-task-row=',
    'data-task-designation=',
    'data-due-state=',
    'data-due-date=',
    'data-task-attribution-label=',
    'data-task-complete-button=',
    'data-task-edit-due-button=',
    'data-task-assign-button=',
    'data-task-delete-button=',
    'data-tasks-group=',
    'data-tasks-group-state=',
    'data-tasks-group-body=',
  ];
  for (const hook of REQUIRED_HOOKS) {
    it(`preserves ${hook}`, () => {
      expect(SRC, `missing required data-* hook: ${hook}`).toContain(hook);
    });
  }

  it('renders the shared TaskPhotoThumbnailButton, which owns the photo data-* hooks', () => {
    // The data-task-has-photo / data-task-photo-open hooks moved into the shared
    // TaskPhotoThumbnailButton component (commit 8394162). The row still renders
    // them through that button, so the e2e photo hooks stay present in the DOM.
    expect(SRC).toContain('TaskPhotoThumbnailButton');
    const photoBtn = readFileSync(resolve(ROOT, 'src/tasks/TaskPhotoThumbnailButton.jsx'), 'utf8');
    expect(photoBtn).toContain('data-task-has-photo="1"');
    expect(photoBtn).toContain('data-task-photo-open="1"');
  });
});
