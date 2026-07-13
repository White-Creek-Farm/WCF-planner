// ============================================================================
// tests/processing_asana_matcher.test.js — unit tests for the PURE Processing ⇄
// Asana reconciler matcher (migration-157 link-table contract). Runs under Node
// (vitest, env:node); imports the same file the Deno edge fn imports, so passing
// here locks the deterministic match rules both sides depend on.
//
// Covers: normalizeWcfCode, deriveProcessingYear (DATE precedence, ignores the
// 'Year' field), matchAsanaTaskToPlanner (auto_exact / needs_review / Name↔BN
// disagreement / pig by date+count+sub-batch), classifyBucket (2024 cutoff +
// no-year-no-code), milestone detection, computeDrift.
// ============================================================================

import {describe, it, expect} from 'vitest';
import {
  normalizeWcfCode,
  deriveProcessingYear,
  classifyRecordType,
  classifyBucket,
  matchAsanaTaskToPlanner,
  computeDrift,
  buildDryRunReport,
} from '../supabase/functions/_shared/processingAsanaShape.js';

// ── Fixture builders (shaped like Asana `opt_fields` responses) ──────────────

function cf(name, valueObj) {
  return {gid: 'cf-' + name, name, ...valueObj};
}

// A coded (broiler/cattle/sheep) processing task. Any field passed null is
// omitted so tests can strip a date/code and watch precedence fall through.
function codedTask(o = {}) {
  const {
    name = 'WCF-B-26-10: 700 @5LBS',
    batchName = 'WCF-B-26-10',
    status = 'Reserved',
    animals = 700,
    customer = "Sonny's",
    processor = 'Atlanta Poultry Processing',
    actual = '2026-07-13',
    planned = '2026-10-19',
    due = '2026-07-17',
    created = '2026-04-23',
    year = 2026,
    completed = false,
    resource_subtype = 'default_task',
  } = o;
  const fields = [];
  if (status != null) fields.push(cf('Status (Processing)', {type: 'enum', enum_value: {name: status}}));
  if (animals != null) fields.push(cf('Animals Processed', {type: 'number', number_value: animals}));
  if (customer != null) fields.push(cf('Customer (Broiler)', {type: 'text', text_value: customer}));
  if (processor != null) fields.push(cf('Processor', {type: 'text', text_value: processor}));
  if (actual != null) fields.push(cf('Actual Processing Date (SF)', {type: 'date', date_value: {date: actual}}));
  if (planned != null) fields.push(cf('Planned Processing Date (SF)', {type: 'date', date_value: {date: planned}}));
  if (year != null) fields.push(cf('Year', {type: 'number', number_value: year}));
  if (batchName != null) fields.push(cf('Batch Name (Farms)', {type: 'text', text_value: batchName}));
  return {
    gid: 't-' + String(name),
    resource_type: 'task',
    resource_subtype,
    name,
    completed,
    due_on: due,
    start_on: null,
    created_at: created,
    custom_fields: fields,
  };
}

// A pig trip task (no WCF code; matched by program+date+count+sub-batch).
function pigTask(o = {}) {
  const {batchName = 'SubA', animals = 40, actual = '2026-05-01', due = null, name = 'Pig trip 2026-05-01'} = o;
  const fields = [];
  if (animals != null) fields.push(cf('Animals Processed', {type: 'number', number_value: animals}));
  if (actual != null) fields.push(cf('Actual Processing Date (SF)', {type: 'date', date_value: {date: actual}}));
  if (batchName != null) fields.push(cf('Batch Name (Farms)', {type: 'text', text_value: batchName}));
  return {
    gid: 't-pig-' + String(name),
    resource_type: 'task',
    resource_subtype: 'default_task',
    name,
    completed: false,
    due_on: due,
    start_on: null,
    created_at: '2026-04-01',
    custom_fields: fields,
  };
}

function planner(id, o = {}) {
  const row = {
    id,
    program: o.program || 'broiler',
    title: o.title != null ? o.title : id,
    processing_date: o.processing_date != null ? o.processing_date : null,
    status: o.status != null ? o.status : 'planned',
    number_processed: o.number_processed != null ? o.number_processed : null,
    source_kind: o.source_kind || null,
    source_id: o.source_id || null,
    sub_batch_attribution: o.sub_batch_attribution != null ? o.sub_batch_attribution : [],
  };
  // Included only when passed so default rows genuinely LACK the key, like
  // legacy rows that predate the mig-176 source_phase column.
  if (o.source_phase !== undefined) row.source_phase = o.source_phase;
  return row;
}

// ── normalizeWcfCode ─────────────────────────────────────────────────────────

describe('normalizeWcfCode', () => {
  it('extracts the code from a noisy task Name (trailing colon + description)', () => {
    expect(normalizeWcfCode('WCF-B-26-16: 700 @5LBS')).toBe('WCF-B-26-16');
  });

  it('reads a clean Batch Name value', () => {
    expect(normalizeWcfCode('WCF-B-26-10')).toBe('WCF-B-26-10');
  });

  it('zero-pads an unpadded NN to two digits', () => {
    expect(normalizeWcfCode('WCF-B-26-3')).toBe('WCF-B-26-03');
    expect(normalizeWcfCode('WCF-C-25-7:')).toBe('WCF-C-25-07');
  });

  it('strips a trailing colon and surrounding whitespace/newlines', () => {
    expect(normalizeWcfCode('  WCF-P-24-9:  ')).toBe('WCF-P-24-09');
    expect(normalizeWcfCode('WCF-B-26-16\n700 birds')).toBe('WCF-B-26-16');
  });

  it('supplies the WCF- prefix when the source omits it', () => {
    expect(normalizeWcfCode('B-26-3')).toBe('WCF-B-26-03');
    expect(normalizeWcfCode('L-24-12')).toBe('WCF-L-24-12');
  });

  it('uppercases the program letter and a single-letter suffix', () => {
    expect(normalizeWcfCode('wcf-b-26-3a')).toBe('WCF-B-26-03A');
    expect(normalizeWcfCode('c-25-4B')).toBe('WCF-C-25-04B');
  });

  it('does not swallow a following description word as a suffix', () => {
    expect(normalizeWcfCode('WCF-B-26-3 Extra birds')).toBe('WCF-B-26-03');
  });

  it('is idempotent (normalize∘normalize === normalize)', () => {
    const once = normalizeWcfCode('wcf-b-26-3a');
    expect(normalizeWcfCode(once)).toBe(once);
  });

  it('returns null when no code is present or input is nullish', () => {
    expect(normalizeWcfCode('add 240 whole birds starting in July?')).toBeNull();
    expect(normalizeWcfCode('')).toBeNull();
    expect(normalizeWcfCode(null)).toBeNull();
    expect(normalizeWcfCode(undefined)).toBeNull();
  });
});

// ── deriveProcessingYear (DATE, never the 'Year' field) ──────────────────────

describe('deriveProcessingYear', () => {
  it('uses the actual proc date and IGNORES a garbage Year field', () => {
    const task = codedTask({actual: '2026-07-13', planned: '2025-01-01', due: '2024-01-01', year: 2099});
    expect(deriveProcessingYear(task)).toBe(2026);
  });

  it('falls back to planned proc when actual is absent', () => {
    const task = codedTask({actual: null, planned: '2025-05-05', due: '2024-01-01', year: 2099});
    expect(deriveProcessingYear(task)).toBe(2025);
  });

  it('falls back to due_on when actual + planned are absent', () => {
    const task = codedTask({actual: null, planned: null, due: '2023-03-03', year: 2099});
    expect(deriveProcessingYear(task)).toBe(2023);
  });

  it('falls back to created_at when no proc/due date exists', () => {
    const task = codedTask({actual: null, planned: null, due: null, created: '2022-01-09', year: 2099});
    expect(deriveProcessingYear(task)).toBe(2022);
  });

  it('returns null when no date is derivable at all', () => {
    const task = codedTask({actual: null, planned: null, due: null, created: null, year: 2099});
    expect(deriveProcessingYear(task)).toBeNull();
  });
});

// ── milestone detection ──────────────────────────────────────────────────────

describe('milestone detection', () => {
  it('classifyRecordType flags an Asana milestone by resource_subtype', () => {
    const task = codedTask({resource_subtype: 'milestone'});
    expect(classifyRecordType(task, {sectionName: 'WCF Broiler Processing', program: 'broiler'})).toBe('milestone');
  });

  it('classifyRecordType flags a task with no resolvable program as milestone', () => {
    const task = codedTask();
    expect(classifyRecordType(task, {sectionName: null, program: null})).toBe('milestone');
  });

  it('classifyRecordType returns match_candidate for a normal program task', () => {
    const task = codedTask();
    expect(classifyRecordType(task, {sectionName: 'WCF Broiler Processing', program: 'broiler'})).toBe(
      'match_candidate',
    );
  });

  it('matchAsanaTaskToPlanner returns method=milestone for a milestone (excluded from matching)', () => {
    const task = codedTask({resource_subtype: 'milestone'});
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', plannerRows: []});
    expect(res.method).toBe('milestone');
    expect(res.recordId).toBeNull();
  });

  it('classifyBucket returns milestone for a milestone', () => {
    const task = codedTask({resource_subtype: 'milestone'});
    expect(classifyBucket(task)).toBe('milestone');
  });
});

// ── classifyBucket — 2024 cutoff ─────────────────────────────────────────────

describe('classifyBucket', () => {
  it('matched === true short-circuits to matched', () => {
    expect(classifyBucket(codedTask(), {matched: true, year: 2019})).toBe('matched');
  });

  it('unmatched with a derivable year < 2024 → historical', () => {
    const task = codedTask({actual: '2023-06-01', year: 2099});
    expect(classifyBucket(task, {matched: false})).toBe('historical');
  });

  it('the cutoff is INCLUSIVE at 2024 → import_exception', () => {
    const task = codedTask({actual: '2024-01-02', year: 2099});
    expect(classifyBucket(task, {matched: false})).toBe('import_exception');
  });

  it('unmatched with a derivable year >= 2024 → import_exception', () => {
    const task = codedTask({actual: '2025-08-08', year: 2099});
    expect(classifyBucket(task, {matched: false})).toBe('import_exception');
  });

  it('no derivable year (and no code) → needs_review', () => {
    const bare = {gid: 'x', name: 'a loose note', resource_subtype: 'default_task', custom_fields: []};
    expect(classifyBucket(bare, {matched: false})).toBe('needs_review');
  });

  it('honours an explicit year override', () => {
    expect(classifyBucket(codedTask(), {matched: false, year: 2020})).toBe('historical');
    expect(classifyBucket(codedTask(), {matched: false, year: 2024})).toBe('import_exception');
  });
});

// ── matchAsanaTaskToPlanner — coded programs ─────────────────────────────────

describe('matchAsanaTaskToPlanner (coded)', () => {
  it('exactly ONE candidate → auto_exact with the record id', () => {
    const task = codedTask({name: 'WCF-B-26-10: 700 @5LBS', batchName: 'WCF-B-26-10'});
    const rows = [
      planner('prc-10', {program: 'broiler', title: 'WCF-B-26-10'}),
      planner('prc-99', {program: 'broiler', title: 'WCF-B-26-99'}),
      planner('prc-cattle', {program: 'cattle', title: 'WCF-C-26-10'}), // wrong program: ignored
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', code: 'WCF-B-26-10', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('prc-10');
    expect(res.candidateIds).toEqual(['prc-10']);
    expect(res.confidence).toBe('high');
  });

  it('matches a noisy planner title normalized the SAME way', () => {
    const task = codedTask({name: 'WCF-B-26-3', batchName: 'WCF-B-26-3'});
    const rows = [planner('prc-3', {program: 'broiler', title: 'WCF-B-26-3: legacy 700 @5LBS'})];
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('prc-3');
  });

  it('TWO planner rows for one code → needs_review (none auto), both candidates', () => {
    const task = codedTask({name: 'WCF-B-26-10: 700 @5LBS', batchName: 'WCF-B-26-10'});
    const rows = [
      planner('prc-10a', {program: 'broiler', title: 'WCF-B-26-10'}),
      planner('prc-10b', {program: 'broiler', title: 'WCF-B-26-10: dup'}),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', code: 'WCF-B-26-10', plannerRows: rows});
    expect(res.method).toBe('needs_review');
    expect(res.recordId).toBeNull();
    expect(res.candidateIds.sort()).toEqual(['prc-10a', 'prc-10b']);
  });

  it('Name-code and Batch-Name-code resolve to DIFFERENT rows → needs_review (union candidates)', () => {
    const task = codedTask({name: 'WCF-B-26-10: 700 @5LBS', batchName: 'WCF-B-26-16'});
    const rows = [
      planner('prc-10', {program: 'broiler', title: 'WCF-B-26-10'}),
      planner('prc-16', {program: 'broiler', title: 'WCF-B-26-16'}),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', code: 'WCF-B-26-10', plannerRows: rows});
    expect(res.method).toBe('needs_review');
    expect(res.recordId).toBeNull();
    expect(res.candidateIds.sort()).toEqual(['prc-10', 'prc-16']);
  });

  it('Name and Batch-Name codes AGREE on one row → auto_exact (no false disagreement veto)', () => {
    const task = codedTask({name: 'WCF-B-26-10: 700 @5LBS', batchName: 'WCF-B-26-10'});
    const rows = [planner('prc-10', {program: 'broiler', title: 'WCF-B-26-10'})];
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('prc-10');
  });

  it('a code with NO planner match, pre-2024 → historical', () => {
    const task = codedTask({name: 'WCF-B-23-05', batchName: 'WCF-B-23-05', actual: '2023-05-01', year: 2099});
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', plannerRows: []});
    expect(res.method).toBe('historical');
    expect(res.candidateIds).toEqual([]);
  });

  it('a code with NO planner match, >=2024 → needs_review', () => {
    const task = codedTask({name: 'WCF-B-26-77', batchName: 'WCF-B-26-77'});
    const res = matchAsanaTaskToPlanner(task, {program: 'broiler', plannerRows: []});
    expect(res.method).toBe('needs_review');
    expect(res.candidateIds).toEqual([]);
  });
});

// ── matchAsanaTaskToPlanner — pig (date + count + sub-batch) ──────────────────

describe('matchAsanaTaskToPlanner (pig)', () => {
  it('date + count + sub-batch overlap uniquely → auto_exact', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA'});
    const rows = [
      planner('pig-1', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: [{subBatchId: 'SubA'}],
      }),
      planner('pig-2', {
        program: 'pig',
        processing_date: '2026-05-02',
        number_processed: 40,
        sub_batch_attribution: [{subBatchId: 'SubA'}],
      }),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('pig-1');
  });

  it('same date+count on two trips, sub-batch discriminates to one → auto_exact', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubB'});
    const rows = [
      planner('pig-a', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubA'],
      }),
      planner('pig-b', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubB'],
      }),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('pig-b');
  });

  it('same date+count on two trips, NO sub-batch signal on the task → needs_review', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: null});
    const rows = [
      planner('pig-a', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubA'],
      }),
      planner('pig-b', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubB'],
      }),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('needs_review');
    expect(res.candidateIds.sort()).toEqual(['pig-a', 'pig-b']);
  });

  it('count mismatch (no date+count candidate), pre-2024 → historical', () => {
    const task = pigTask({actual: '2023-05-01', animals: 999, batchName: 'SubA'});
    const rows = [
      planner('pig-a', {
        program: 'pig',
        processing_date: '2023-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubA'],
      }),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('historical');
    expect(res.recordId).toBeNull();
  });
});

// ── matchAsanaTaskToPlanner — pig planned vs actual (mig-176 source_phase) ────

describe('matchAsanaTaskToPlanner (pig source_phase)', () => {
  const signals = {
    program: 'pig',
    processing_date: '2026-05-01',
    number_processed: 40,
    sub_batch_attribution: ['SubA'],
  };

  it('a PLANNED pig row is never matched, even on perfect date+count+sub-batch signals', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA'});
    const rows = [planner('pig-planned', {...signals, source_phase: 'planned'})];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('needs_review'); // unmatched >=2024 — NOT auto_exact
    expect(res.recordId).toBeNull();
    expect(res.candidateIds).toEqual([]); // not even a review candidate
  });

  it('the SAME row with source_phase=actual IS matched auto_exact (control)', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA'});
    const rows = [planner('pig-actual', {...signals, source_phase: 'actual'})];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('pig-actual');
    expect(res.confidence).toBe('high');
  });

  it('a planned twin never contests its actual row → auto_exact to the actual row alone', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA'});
    const rows = [
      planner('pig-planned', {...signals, source_phase: 'planned'}),
      planner('pig-actual', {...signals, source_phase: 'actual'}),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('auto_exact');
    expect(res.recordId).toBe('pig-actual');
    expect(res.candidateIds).toEqual(['pig-actual']);
  });

  it('planned rows are excluded from needs_review candidate lists too', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: null});
    const rows = [
      planner('pig-actual-a', {...signals, sub_batch_attribution: ['SubA'], source_phase: 'actual'}),
      planner('pig-actual-b', {...signals, sub_batch_attribution: ['SubB'], source_phase: 'actual'}),
      planner('pig-planned', {...signals, source_phase: 'planned'}),
    ];
    const res = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: rows});
    expect(res.method).toBe('needs_review');
    expect(res.candidateIds.sort()).toEqual(['pig-actual-a', 'pig-actual-b']);
  });

  it('legacy rows without source_phase (key absent or explicit null) still match (back-compat)', () => {
    const task = pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA'});
    const absent = planner('pig-legacy', signals); // no source_phase key at all
    expect(absent).not.toHaveProperty('source_phase');
    const resAbsent = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: [absent]});
    expect(resAbsent.method).toBe('auto_exact');
    expect(resAbsent.recordId).toBe('pig-legacy');

    const nullRow = planner('pig-null', {...signals, source_phase: null});
    const resNull = matchAsanaTaskToPlanner(task, {program: 'pig', plannerRows: [nullRow]});
    expect(resNull.method).toBe('auto_exact');
    expect(resNull.recordId).toBe('pig-null');
  });
});

// ── computeDrift ─────────────────────────────────────────────────────────────

describe('computeDrift', () => {
  it('reports date, number, and status fields where Asana disagrees with Planner', () => {
    const task = codedTask({actual: '2026-07-13', animals: 700, status: 'Reserved', completed: false});
    const plannerRow = planner('prc-10', {processing_date: '2026-07-10', number_processed: 650, status: 'planned'});
    const drift = computeDrift(task, plannerRow);
    expect(drift.processing_date).toEqual({asana: '2026-07-13', planner: '2026-07-10'});
    expect(drift.number_processed).toEqual({asana: 700, planner: 650});
    expect(drift.status).toEqual({asana: 'Reserved', planner: 'planned'});
  });

  it('is empty when Asana agrees with Planner (status compared case-insensitively)', () => {
    const task = codedTask({actual: '2026-07-13', animals: 700, status: 'Reserved', completed: false});
    const plannerRow = planner('prc-10', {processing_date: '2026-07-13', number_processed: 700, status: 'reserved'});
    expect(computeDrift(task, plannerRow)).toEqual({});
  });

  it('treats a completed Asana task as status=complete', () => {
    const task = codedTask({actual: '2026-07-13', animals: 700, completed: true});
    const plannerRow = planner('prc-10', {processing_date: '2026-07-13', number_processed: 700, status: 'planned'});
    const drift = computeDrift(task, plannerRow);
    expect(drift.status).toEqual({asana: 'complete', planner: 'planned'});
    expect(drift.processing_date).toBeUndefined();
    expect(drift.number_processed).toBeUndefined();
  });

  it('returns {} for a null planner row', () => {
    expect(computeDrift(codedTask(), null)).toEqual({});
  });
});

// ── buildDryRunReport — read-only review packet mirrors the write path ────────

describe('buildDryRunReport', () => {
  const BROILER = 'WCF Broiler Processing';
  const PIG = 'WCF Pig Processing';

  // A representative fetch: matched(+drift) / historical / import_exception /
  // needs_review(ambiguous) / duplicate-code + planner-contested / milestones /
  // pig auto-match — one of each so every bucket + collision path is exercised.
  function scenario() {
    const plannerRows = [
      planner('prc-b10', {
        program: 'broiler',
        title: 'WCF-B-26-10',
        processing_date: '2026-07-10',
        number_processed: 700,
        status: 'planned',
        source_id: 'broiler:B-26-10',
      }),
      planner('prc-20a', {program: 'broiler', title: 'WCF-B-26-20', source_id: 'broiler:B-26-20a'}),
      planner('prc-20b', {program: 'broiler', title: 'WCF-B-26-20', source_id: 'broiler:B-26-20b'}),
      planner('prc-30', {
        program: 'broiler',
        title: 'WCF-B-26-30',
        processing_date: '2026-07-13',
        number_processed: 700,
        status: 'Reserved',
        source_id: 'broiler:B-26-30',
      }),
      planner('pig-1', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubA'],
        source_id: '111:222',
      }),
    ];
    const tasks = [
      // matched + drift (date 07-13 vs planner 07-10, status Reserved vs planned)
      {task: codedTask(), sectionName: BROILER},
      // historical (no planner code, year 2023)
      {
        task: codedTask({
          name: 'WCF-B-23-05',
          batchName: 'WCF-B-23-05',
          actual: '2023-05-01',
          planned: null,
          due: null,
          created: '2023-01-01',
        }),
        sectionName: BROILER,
      },
      // import_exception (no planner code, year 2026)
      {
        task: codedTask({
          name: 'WCF-B-26-77',
          batchName: 'WCF-B-26-77',
          actual: '2026-08-08',
          planned: null,
          due: null,
        }),
        sectionName: BROILER,
      },
      // needs_review ambiguous (two planner rows share the code)
      {task: codedTask({name: 'WCF-B-26-20: x', batchName: 'WCF-B-26-20'}), sectionName: BROILER},
      // duplicate Asana code + planner contested (two tasks auto-match prc-30)
      {task: codedTask({name: 'WCF-B-26-30: A', batchName: 'WCF-B-26-30'}), sectionName: BROILER},
      {task: codedTask({name: 'WCF-B-26-30: B', batchName: 'WCF-B-26-30'}), sectionName: BROILER},
      // milestones: an Asana milestone, and a task with no resolvable program
      {task: codedTask({resource_subtype: 'milestone', name: 'Kickoff milestone'}), sectionName: BROILER},
      {task: codedTask({name: 'Loose planning note', batchName: null}), sectionName: null},
      // pig auto-match
      {task: pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA', name: 'Pig SubA'}), sectionName: PIG},
    ];
    return {plannerRows, tasks, report: buildDryRunReport(tasks, plannerRows)};
  }

  it('totals reflect fetched tasks and planner rows', () => {
    const {report} = scenario();
    expect(report.tasksFetched).toBe(9);
    expect(report.plannerRows).toBe(5);
  });

  it('assigns the SAME buckets the write path would', () => {
    const {report} = scenario();
    expect(report.buckets).toEqual({matched: 4, historical: 1, import_exception: 1, needs_review: 1, milestone: 2});
  });

  it('emits per-record review entries for needs_review (with candidates) and import_exception (with reason)', () => {
    const {report} = scenario();
    const needs = report.review.filter((r) => r.bucket === 'needs_review');
    const exc = report.review.filter((r) => r.bucket === 'import_exception');
    expect(needs).toHaveLength(1);
    expect(needs[0].candidateIds.sort()).toEqual(['prc-20a', 'prc-20b']);
    expect(needs[0].candidates.map((c) => c.source_id).sort()).toEqual(['broiler:B-26-20a', 'broiler:B-26-20b']);
    expect(exc).toHaveLength(1);
    expect(exc[0].code).toBe('WCF-B-26-77');
    expect(exc[0].reason).toBe('unmatched_ge_2024');
  });

  it('lists milestones (Asana milestone + no-program task)', () => {
    const {report} = scenario();
    expect(report.milestones).toHaveLength(2);
    expect(report.milestones.map((m) => m.title).sort()).toEqual(['Kickoff milestone', 'Loose planning note']);
  });

  it('reports duplicate Asana codes, ambiguous candidate collisions, and planner-contested rows', () => {
    const {report} = scenario();
    const dup = report.collisions.duplicateAsanaCodes;
    expect(dup).toHaveLength(1);
    expect(dup[0].code).toBe('WCF-B-26-30');
    expect(dup[0].gids).toHaveLength(2);
    expect(report.collisions.ambiguousCandidates).toHaveLength(1);
    expect(report.collisions.ambiguousCandidates[0].candidateIds.sort()).toEqual(['prc-20a', 'prc-20b']);
    const contested = report.collisions.plannerContested;
    expect(contested).toHaveLength(1);
    expect(contested[0].recordId).toBe('prc-30');
    expect(contested[0].gids).toHaveLength(2);
  });

  it('surfaces pig match candidates with date/count/tokens/method + candidate detail', () => {
    const {report} = scenario();
    expect(report.pigCandidates).toHaveLength(1);
    const p = report.pigCandidates[0];
    expect(p.date).toBe('2026-05-01');
    expect(p.count).toBe(40);
    expect(p.tokens).toEqual(['suba']);
    expect(p.method).toBe('auto_exact');
    expect(p.candidates.map((c) => c.id)).toEqual(['pig-1']);
    expect(p.candidates[0].source_id).toBe('111:222');
  });

  it('previews drift for auto_exact matches only (informational, never applied)', () => {
    const {report} = scenario();
    expect(report.driftPreview).toHaveLength(1);
    const d = report.driftPreview[0];
    expect(d.recordId).toBe('prc-b10');
    expect(d.drift.processing_date).toEqual({asana: '2026-07-13', planner: '2026-07-10'});
    expect(d.drift.status).toEqual({asana: 'Reserved', planner: 'planned'});
  });

  it('does not flag pig many-to-one (N sub-batch tasks → one trip) as planner-contested', () => {
    const plannerRows = [
      planner('pig-1', {
        program: 'pig',
        processing_date: '2026-05-01',
        number_processed: 40,
        sub_batch_attribution: ['SubA', 'SubB'],
      }),
    ];
    const tasks = [
      {task: pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubA', name: 'Pig A'}), sectionName: PIG},
      {task: pigTask({actual: '2026-05-01', animals: 40, batchName: 'SubB', name: 'Pig B'}), sectionName: PIG},
    ];
    const report = buildDryRunReport(tasks, plannerRows);
    expect(report.buckets.matched).toBe(2);
    expect(report.collisions.plannerContested).toHaveLength(0);
  });

  it('is safe on empty input (all zero buckets, empty detail)', () => {
    const report = buildDryRunReport([], []);
    expect(report.tasksFetched).toBe(0);
    expect(report.plannerRows).toBe(0);
    expect(report.buckets).toEqual({matched: 0, historical: 0, import_exception: 0, needs_review: 0, milestone: 0});
    expect(report.review).toEqual([]);
    expect(report.milestones).toEqual([]);
    expect(report.pigCandidates).toEqual([]);
    expect(report.driftPreview).toEqual([]);
    expect(report.collisions).toEqual({duplicateAsanaCodes: [], ambiguousCandidates: [], plannerContested: []});
  });
});
