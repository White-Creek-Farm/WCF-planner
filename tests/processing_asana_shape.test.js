// ============================================================================
// tests/processing_asana_shape.test.js — unit tests for the PURE Processing ⇄
// Asana mapping/classification/diff module. Runs under Node (vitest, env:node);
// imports the same file the Deno edge fn imports, so passing here locks the
// contract both sides depend on.
// ============================================================================

import {describe, it, expect} from 'vitest';
import {
  SECTION_TO_PROGRAM,
  ASANA_PROJECT_GID,
  sectionToProgram,
  customFieldDisplay,
  indexCustomFields,
  mapAsanaTaskToProcessingRow,
  classifyRecordType,
  mapAsanaSubtask,
  flattenSubtasks,
  isRealComment,
  mapAsanaComment,
  buildDiffPlan,
} from '../supabase/functions/_shared/processingAsanaShape.js';

// ── Realistic fixtures (shaped like Asana API `opt_fields` responses) ────────

// A 2026 broiler batch task, NOT completed, with the full custom-field set
// exactly as the SF Processing Calendar export shows them.
function broilerTaskFixture(overrides = {}) {
  return {
    gid: '1214220021394259',
    resource_type: 'task',
    resource_subtype: 'default_task',
    name: 'WCF-B-26-10: 700 @5LBS',
    completed: false,
    completed_at: null,
    due_on: '2026-07-17',
    start_on: null,
    assignee: {name: 'Ronnie Jones'},
    memberships: [
      {
        project: {gid: ASANA_PROJECT_GID, name: 'SF Processing Calendar '},
        section: {gid: 'sec-broiler', name: 'WCF Broiler Processing'},
      },
    ],
    custom_fields: [
      {gid: 'c1', name: 'Status (Processing)', type: 'enum', enum_value: {name: 'Reserved'}, display_value: 'Reserved'},
      {gid: 'c2', name: 'Animals Processed', type: 'number', number_value: 700, display_value: '700'},
      {gid: 'c3', name: 'Customer (Broiler)', type: 'text', text_value: "Sonny's", display_value: "Sonny's"},
      {
        gid: 'c4',
        name: 'Processor',
        type: 'text',
        text_value: 'Atlanta Poultry Processing',
        display_value: 'Atlanta Poultry Processing',
      },
      {
        gid: 'c5',
        name: 'Actual Processing Date (SF)',
        type: 'date',
        date_value: {date: '2026-07-13'},
        display_value: '2026-07-13',
      },
      {
        gid: 'c6',
        name: 'Planned Processing Date (SF)',
        type: 'date',
        date_value: {date: '2026-10-19'},
        display_value: '2026-10-19',
      },
      {gid: 'c7', name: 'Year', type: 'number', number_value: 2026, display_value: '2026'},
      {gid: 'c8', name: 'Batch Name (Farms)', type: 'text', text_value: 'WCF-B-26-10', display_value: 'WCF-B-26-10'},
      {gid: 'c9', name: 'Farm', type: 'text', text_value: 'WCF', display_value: 'WCF'},
      {gid: 'c10', name: 'Status (Animal Master)', type: 'text', text_value: 'Reserved', display_value: 'Reserved'},
      {
        gid: 'c11',
        name: 'Product Pick-up Date',
        type: 'date',
        date_value: {date: '2026-07-20'},
        display_value: '2026-07-20',
      },
      ...(overrides.extraCustomFields || []),
    ],
    ...overrides.task,
  };
}

// ── sectionToProgram ─────────────────────────────────────────────────────────

describe('sectionToProgram', () => {
  it('maps each canonical section name', () => {
    expect(sectionToProgram('WCF Broiler Processing')).toBe('broiler');
    expect(sectionToProgram('WCF Cattle Processing')).toBe('cattle');
    expect(sectionToProgram('WCF Pig Processing')).toBe('pig');
    expect(sectionToProgram('WCF Lamb Processing')).toBe('sheep'); // Lamb → sheep
  });

  it('trims a trailing/leading space before lookup', () => {
    expect(sectionToProgram('  WCF Cattle Processing  ')).toBe('cattle');
  });

  it('falls back to the Farm Programs enum (incl. plural + Lambs → sheep)', () => {
    expect(sectionToProgram('Broiler')).toBe('broiler');
    expect(sectionToProgram('Cattle')).toBe('cattle');
    expect(sectionToProgram('Pigs')).toBe('pig');
    expect(sectionToProgram('Lambs')).toBe('sheep');
    expect(sectionToProgram('sheep')).toBe('sheep');
  });

  it('returns null for unknown / empty / nullish', () => {
    expect(sectionToProgram('Some Other Section')).toBeNull();
    expect(sectionToProgram('')).toBeNull();
    expect(sectionToProgram('   ')).toBeNull();
    expect(sectionToProgram(null)).toBeNull();
    expect(sectionToProgram(undefined)).toBeNull();
  });

  it('exports the frozen section map + project gid', () => {
    expect(SECTION_TO_PROGRAM['WCF Lamb Processing']).toBe('sheep');
    expect(ASANA_PROJECT_GID).toBe('1201484014160203');
  });
});

// ── customFieldDisplay / indexCustomFields ───────────────────────────────────

describe('customFieldDisplay + indexCustomFields', () => {
  it('resolves enum, number, text, and date custom fields', () => {
    expect(customFieldDisplay({type: 'enum', enum_value: {name: 'Reserved'}})).toBe('Reserved');
    expect(customFieldDisplay({type: 'number', number_value: 700})).toBe(700);
    expect(customFieldDisplay({type: 'text', text_value: "Sonny's"})).toBe("Sonny's");
    expect(customFieldDisplay({type: 'date', date_value: {date: '2026-07-13'}})).toBe('2026-07-13');
    expect(customFieldDisplay({type: 'multi_enum', multi_enum_values: [{name: 'A'}, {name: 'B'}]})).toEqual(['A', 'B']);
  });

  it('indexes a task custom_fields array by name', () => {
    const cf = indexCustomFields(broilerTaskFixture());
    expect(cf['Status (Processing)']).toBe('Reserved');
    expect(cf['Animals Processed']).toBe(700);
    expect(cf['Year']).toBe(2026);
  });
});

// ── mapAsanaTaskToProcessingRow ──────────────────────────────────────────────

describe('mapAsanaTaskToProcessingRow', () => {
  it('maps every contract field from an uncompleted broiler task', () => {
    const task = broilerTaskFixture();
    const row = mapAsanaTaskToProcessingRow(task, {
      sectionName: 'WCF Broiler Processing',
      customFieldsByName: indexCustomFields(task),
      recordType: 'planner_batch',
      sectionGid: 'sec-broiler',
      syncRunId: 'psr-abc',
    });

    expect(row.asana_gid).toBe('1214220021394259');
    expect(row.title).toBe('WCF-B-26-10: 700 @5LBS');
    expect(row.program).toBe('broiler');
    expect(row.record_type).toBe('planner_batch');
    // Not completed → carries the RAW 'Status (Processing)' value.
    expect(row.status).toBe('Reserved');
    expect(row.number_processed).toBe(700);
    expect(row.customer).toEqual(["Sonny's"]); // single value → jsonb array
    expect(row.processor).toBe('Atlanta Poultry Processing');
    // Actual proc date wins over planned + due_on.
    expect(row.processing_date).toBe('2026-07-13');
    expect(row.asana_project_gid).toBe(ASANA_PROJECT_GID);
    expect(row.asana_section_gid).toBe('sec-broiler');
    expect(row.asana_section_name).toBe('WCF Broiler Processing');
    expect(row.sync_run_id).toBe('psr-abc');
    // raw snapshot is the whole task; historical snapshot carries present keys.
    expect(row.raw_asana_snapshot).toBe(task);
    expect(row.historical_snapshot).toMatchObject({
      due_on: '2026-07-17',
      planned_proc: '2026-10-19',
      actual_proc: '2026-07-13',
      product_pickup: '2026-07-20',
      batch_name: 'WCF-B-26-10',
      farm: 'WCF',
      year: 2026,
      animal_master: 'Reserved',
    });
  });

  it("uses the task's indexed custom_fields when no map is supplied", () => {
    const row = mapAsanaTaskToProcessingRow(broilerTaskFixture(), {sectionName: 'WCF Broiler Processing'});
    expect(row.program).toBe('broiler');
    expect(row.number_processed).toBe(700);
    expect(row.record_type).toBe('asana_historical'); // default when unset
  });

  it('forces status=complete when the Asana task is completed', () => {
    const task = broilerTaskFixture({task: {completed: true, completed_at: '2026-07-13T12:00:00Z'}});
    const row = mapAsanaTaskToProcessingRow(task, {sectionName: 'WCF Broiler Processing'});
    expect(row.status).toBe('complete');
  });

  it('falls back to planned proc date, then due_on, for processing_date', () => {
    const task = broilerTaskFixture({
      task: {due_on: '2026-09-01'},
      // strip the actual-proc field so planned wins
    });
    task.custom_fields = task.custom_fields.filter((c) => c.name !== 'Actual Processing Date (SF)');
    const row = mapAsanaTaskToProcessingRow(task, {sectionName: 'WCF Broiler Processing'});
    expect(row.processing_date).toBe('2026-10-19'); // planned
  });
});

// ── classifyRecordType ───────────────────────────────────────────────────────

describe('classifyRecordType', () => {
  // The Asana pass never mints planner_batch (only the Planner bridge does). The
  // migration-157 model narrows classifyRecordType to milestone vs the deferred
  // 'match_candidate' the edge fn hands to matchAsanaTaskToPlanner. Bucketing of
  // candidates (matched / asana_historical / import_exception) is covered in
  // processing_asana_matcher.test.js.
  it('classifies an Asana milestone by resource_subtype', () => {
    const task = broilerTaskFixture({task: {resource_subtype: 'milestone'}});
    expect(classifyRecordType(task, {sectionName: 'WCF Broiler Processing'})).toBe('milestone');
  });

  it('classifies a task with no resolvable program as milestone', () => {
    const task = broilerTaskFixture({task: {memberships: []}});
    expect(classifyRecordType(task, {sectionName: null, program: null})).toBe('milestone');
  });

  it('classifies any program task as a deferred match_candidate (NEVER planner_batch)', () => {
    const task = broilerTaskFixture();
    expect(classifyRecordType(task, {sectionName: 'WCF Broiler Processing', program: 'broiler'})).toBe(
      'match_candidate',
    );
  });

  it("classifies a pre-2024 program task as a match_candidate too (year is the matcher's job)", () => {
    const task = broilerTaskFixture();
    task.due_on = '2023-05-01';
    expect(classifyRecordType(task, {sectionName: 'WCF Broiler Processing', program: 'broiler'})).toBe(
      'match_candidate',
    );
  });
});

// ── mapAsanaSubtask + flattenSubtasks ────────────────────────────────────────

describe('mapAsanaSubtask + flattenSubtasks', () => {
  it('maps a subtask to the subtask importer p_row shape', () => {
    const sub = {
      gid: '1214222225693752',
      name: 'Send Weight & Animal Count',
      assignee: {name: 'Ronnie Jones'},
      completed: true,
      completed_at: '2026-05-01T10:00:00Z',
      due_on: '2026-05-02',
      start_on: null,
    };
    const row = mapAsanaSubtask(sub, '1214220021394259', 3);
    expect(row).toEqual({
      asana_gid: '1214222225693752',
      parent_asana_gid: '1214220021394259',
      label: 'Send Weight & Animal Count',
      assignee: 'Ronnie Jones',
      assignee_gid: null,
      done: true,
      completed_at: '2026-05-01T10:00:00Z',
      due_on: '2026-05-02',
      start_on: null,
      sort_order: 3,
    });
  });

  it('carries the assignee gid for stable user-directory mapping', () => {
    const row = mapAsanaSubtask({gid: 's1', name: 'Step', assignee: {name: 'Ronnie Jones', gid: '777'}}, 'p1', 1);
    expect(row.assignee).toBe('Ronnie Jones');
    expect(row.assignee_gid).toBe('777');
  });

  it('flattens a nested subtask tree with incrementing sort_order (parent first)', () => {
    const tree = [
      {gid: 'a', name: 'A', subtasks: [{gid: 'a1', name: 'A1'}]},
      {gid: 'b', name: 'B'},
    ];
    const flat = flattenSubtasks(tree);
    expect(flat.map((f) => f.subtask.gid)).toEqual(['a', 'a1', 'b']);
    expect(flat.map((f) => f.sortOrder)).toEqual([1, 2, 3]);
    // input is not mutated
    expect(tree[0].subtasks[0].gid).toBe('a1');
  });
});

// ── comments ─────────────────────────────────────────────────────────────────

describe('isRealComment + mapAsanaComment', () => {
  it('includes human comment stories and excludes system stories', () => {
    expect(isRealComment({type: 'comment', text: 'looks good'})).toBe(true);
    expect(isRealComment({type: 'system', text: 'changed the due date'})).toBe(false);
    expect(isRealComment({resource_subtype: 'liked'})).toBe(false);
    expect(isRealComment(null)).toBe(false);
  });

  it('maps a comment story to the normalized shape', () => {
    const story = {
      gid: 'story-1',
      type: 'comment',
      text: 'Confirmed with processor',
      created_at: '2026-06-01T09:00:00Z',
      created_by: {name: 'Brett Post'},
    };
    expect(mapAsanaComment(story)).toEqual({
      asana_comment_gid: 'story-1',
      original_author_name: 'Brett Post',
      body: 'Confirmed with processor',
      created_at: '2026-06-01T09:00:00Z',
    });
  });
});

// ── buildDiffPlan — IDEMPOTENCY is the core guarantee ────────────────────────

describe('buildDiffPlan', () => {
  // Two mapped rows to diff.
  function twoRows() {
    const t1 = broilerTaskFixture();
    const t2 = broilerTaskFixture({
      task: {gid: '1214220021394271', name: 'WCF-B-26-16: 700 @5LBS'},
    });
    const opts = {sectionName: 'WCF Broiler Processing', recordType: 'planner_batch'};
    return [mapAsanaTaskToProcessingRow(t1, opts), mapAsanaTaskToProcessingRow(t2, opts)];
  }

  it('reports all inserts against an empty native store', () => {
    const rows = twoRows();
    const plan = buildDiffPlan(rows, {});
    expect(plan.wouldInsert).toBe(2);
    expect(plan.wouldUpdate).toBe(0);
    expect(plan.wouldSkip).toBe(0);
    expect(plan.inserts).toHaveLength(2);
  });

  it('is IDEMPOTENT: same rows already stored → 0 inserts / 0 updates / all skip', () => {
    const rows = twoRows();
    // Simulate a prior import: native store mirrors the mapped rows exactly.
    const nativeByGid = {};
    for (const r of rows) nativeByGid[r.asana_gid] = r;

    const first = buildDiffPlan(rows, nativeByGid);
    expect(first.wouldInsert).toBe(0);
    expect(first.wouldUpdate).toBe(0);
    expect(first.wouldSkip).toBe(2);

    // Running a SECOND time against the same store is identical (true idempotency).
    const second = buildDiffPlan(rows, nativeByGid);
    expect(second).toEqual(first);
    expect(second.inserts).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
  });

  it('skips even when the native store carries extra DB-only columns + reordered keys', () => {
    const rows = twoRows();
    const nativeByGid = {};
    for (const r of rows) {
      // Native record shape: extra columns + different key order, same business data.
      nativeByGid[r.asana_gid] = {
        id: 'prc-' + r.asana_gid,
        created_at: '2026-01-01T00:00:00Z',
        source_id: null,
        customer: r.customer,
        status: r.status,
        title: r.title,
        program: r.program,
        processing_date: r.processing_date,
        processor: r.processor,
        number_processed: r.number_processed,
        asana_section_name: r.asana_section_name,
        source_kind: null,
        record_type: r.record_type,
      };
    }
    const plan = buildDiffPlan(rows, nativeByGid);
    expect(plan.wouldSkip).toBe(2);
    expect(plan.wouldUpdate).toBe(0);
  });

  it('detects a changed field as an update, and a new gid as an insert', () => {
    const rows = twoRows();
    const nativeByGid = {};
    // First row stored but with a stale status → update. Second row absent → insert.
    nativeByGid[rows[0].asana_gid] = {...rows[0], status: 'complete'};
    const plan = buildDiffPlan(rows, nativeByGid);
    expect(plan.wouldUpdate).toBe(1);
    expect(plan.updates[0].asana_gid).toBe(rows[0].asana_gid);
    expect(plan.wouldInsert).toBe(1);
    expect(plan.inserts[0].asana_gid).toBe(rows[1].asana_gid);
    expect(plan.wouldSkip).toBe(0);
  });

  it('accepts a Map native store as well as a plain object', () => {
    const rows = twoRows();
    const map = new Map();
    for (const r of rows) map.set(r.asana_gid, r);
    const plan = buildDiffPlan(rows, map);
    expect(plan.wouldSkip).toBe(2);
  });
});
