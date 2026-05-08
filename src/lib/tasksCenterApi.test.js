// Unit tests for the pure helpers exported by tasksCenterApi.
//
// Async DB loaders (loadOpenTaskInstances / loadCompletedTaskInstances /
// loadRecurringTaskTemplates / loadOpenRecurringInstances /
// countMyOpenDueOrPastTasks) are exercised by Playwright against the
// real test DB; the pure helpers below are deterministic and worth
// covering in vitest so future refactors don't silently break the
// grouping or the My-Tasks split.

import {describe, it, expect} from 'vitest';
import {
  splitTasksForMyTab,
  attributionFor,
  dueStateFor,
  photoPresenceFor,
  groupRecurringByTemplate,
} from './tasksCenterApi.js';

describe('splitTasksForMyTab', () => {
  it('puts caller-assigned rows in mine and groups everything else by assignee', () => {
    const profilesById = {
      u1: {id: 'u1', full_name: 'Alice'},
      u2: {id: 'u2', full_name: 'Bob'},
    };
    const tasks = [
      {id: 't1', assignee_profile_id: 'u1', title: 'A1'},
      {id: 't2', assignee_profile_id: 'u2', title: 'B1'},
      {id: 't3', assignee_profile_id: 'u2', title: 'B2'},
    ];
    const out = splitTasksForMyTab(tasks, 'u1', profilesById);
    expect(out.mine.map((t) => t.id)).toEqual(['t1']);
    expect(out.otherGroups).toHaveLength(1);
    expect(out.otherGroups[0].name).toBe('Bob');
    expect(out.otherGroups[0].tasks.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('groups null-assignee rows under "Unassigned" and unknown profiles under "Unknown user"', () => {
    const profilesById = {u1: {id: 'u1', full_name: 'Alice'}};
    const tasks = [
      {id: 't1', assignee_profile_id: null, title: 'A1'},
      {id: 't2', assignee_profile_id: 'ghost', title: 'B1'},
    ];
    const out = splitTasksForMyTab(tasks, 'u1', profilesById);
    const names = out.otherGroups.map((g) => g.name).sort();
    expect(names).toEqual(['Unassigned', 'Unknown user']);
  });
});

describe('dueStateFor', () => {
  it('returns "overdue" when due_date < todayStr', () => {
    expect(dueStateFor({due_date: '2026-05-01'}, '2026-05-08')).toBe('overdue');
  });
  it('returns "today" when due_date === todayStr', () => {
    expect(dueStateFor({due_date: '2026-05-08'}, '2026-05-08')).toBe('today');
  });
  it('returns "upcoming" when due_date > todayStr', () => {
    expect(dueStateFor({due_date: '2026-05-10'}, '2026-05-08')).toBe('upcoming');
  });
  it('returns "upcoming" for null/missing due_date', () => {
    expect(dueStateFor({}, '2026-05-08')).toBe('upcoming');
    expect(dueStateFor(null, '2026-05-08')).toBe('upcoming');
  });
});

describe('attributionFor', () => {
  it('prefers public-webform attribution when submission_source matches', () => {
    expect(attributionFor({submission_source: 'public_webform', submitted_by_team_member: 'Sam'})).toEqual({
      label: 'Submitted by',
      name: 'Sam',
    });
  });
  it('falls back to created_by_display_name', () => {
    expect(attributionFor({created_by_display_name: 'Admin Bob'})).toEqual({
      label: 'Created by',
      name: 'Admin Bob',
    });
  });
  it('labels recurring source when only from_recurring_template is set', () => {
    expect(attributionFor({from_recurring_template: true})).toEqual({
      label: 'Source',
      name: 'Recurring template',
    });
  });
  it('labels system source when only from_system_rule_id is set', () => {
    expect(attributionFor({from_system_rule_id: 'rule-x'})).toEqual({
      label: 'Source',
      name: 'System rule',
    });
  });
  it('returns null when nothing applies', () => {
    expect(attributionFor({})).toBeNull();
    expect(attributionFor(null)).toBeNull();
  });
});

describe('photoPresenceFor', () => {
  it('flags request and completion paths independently', () => {
    expect(photoPresenceFor({request_photo_path: 'a', completion_photo_path: null})).toEqual({
      hasRequest: true,
      hasCompletion: false,
    });
    expect(photoPresenceFor({request_photo_path: null, completion_photo_path: 'b'})).toEqual({
      hasRequest: false,
      hasCompletion: true,
    });
  });
  it('handles a null/empty row', () => {
    expect(photoPresenceFor(null)).toEqual({hasRequest: false, hasCompletion: false});
    expect(photoPresenceFor({})).toEqual({hasRequest: false, hasCompletion: false});
  });
});

describe('groupRecurringByTemplate', () => {
  const templates = [
    {id: 'tpl-active', title: 'Daily check', active: true},
    {id: 'tpl-inactive', title: 'Old chore', active: false},
  ];

  it('buckets open instances under their parent template by template_id', () => {
    const opens = [
      {id: 'i1', template_id: 'tpl-active', title: 'A1', due_date: '2026-05-08'},
      {id: 'i2', template_id: 'tpl-active', title: 'A2', due_date: '2026-05-09'},
      {id: 'i3', template_id: 'tpl-inactive', title: 'O1', due_date: '2026-05-08'},
    ];
    const out = groupRecurringByTemplate(templates, opens);
    expect(out.templates).toHaveLength(2);
    const active = out.templates.find((b) => b.template.id === 'tpl-active');
    expect(active.openCount).toBe(2);
    expect(active.instances.map((i) => i.id)).toEqual(['i1', 'i2']);
    const inactive = out.templates.find((b) => b.template.id === 'tpl-inactive');
    expect(inactive.openCount).toBe(1);
    expect(out.orphans).toEqual([]);
  });

  it('routes instances with NULL template_id into orphans', () => {
    const opens = [
      {id: 'orphan-a', template_id: null, title: 'Orphan A', due_date: '2026-05-08'},
      {id: 'i1', template_id: 'tpl-active', title: 'A1', due_date: '2026-05-08'},
    ];
    const out = groupRecurringByTemplate(templates, opens);
    expect(out.orphans.map((i) => i.id)).toEqual(['orphan-a']);
    expect(out.templates.find((b) => b.template.id === 'tpl-active').openCount).toBe(1);
  });

  it('routes instances whose template_id is unknown (parent missing from input) into orphans', () => {
    const opens = [{id: 'mystery', template_id: 'tpl-gone', title: 'Mystery'}];
    const out = groupRecurringByTemplate(templates, opens);
    expect(out.orphans.map((i) => i.id)).toEqual(['mystery']);
  });

  it('preserves the input template order (caller already sorted)', () => {
    const out = groupRecurringByTemplate(templates, []);
    expect(out.templates.map((b) => b.template.id)).toEqual(['tpl-active', 'tpl-inactive']);
  });

  it('returns empty buckets and empty orphans when both inputs are empty', () => {
    const out = groupRecurringByTemplate([], []);
    expect(out.templates).toEqual([]);
    expect(out.orphans).toEqual([]);
  });

  it('tolerates null/undefined inputs', () => {
    const out = groupRecurringByTemplate(null, undefined);
    expect(out.templates).toEqual([]);
    expect(out.orphans).toEqual([]);
  });
});
