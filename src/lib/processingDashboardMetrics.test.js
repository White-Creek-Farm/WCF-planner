import {describe, it, expect} from 'vitest';
import {
  PROCESSING_DASHBOARD_PROGRAM_KEYS,
  isBatchRecord,
  recordAnimalCount,
  computeProgramChipCounts,
  computeCompletedProgramTotals,
} from './processingDashboardMetrics.js';

// Minimal record fixture — the shapes the dashboard actually reads:
// program/source_kind, record_type, effective_status, live_count,
// number_processed.
function rec({
  program = 'broiler',
  recordType = 'batch',
  status = 'planned',
  liveCount = null,
  numberProcessed = null,
} = {}) {
  return {
    program,
    source_kind: program,
    record_type: recordType,
    effective_status: status,
    live_count: liveCount,
    number_processed: numberProcessed,
  };
}

describe('recordAnimalCount — canonical live_count ?? number_processed', () => {
  it('prefers live_count, including a REAL recorded zero', () => {
    expect(recordAnimalCount(rec({liveCount: 25, numberProcessed: 99}))).toBe(25);
    expect(recordAnimalCount(rec({liveCount: 0, numberProcessed: 99}))).toBe(0);
  });

  it('falls back to number_processed only when live_count is null/undefined', () => {
    expect(recordAnimalCount(rec({liveCount: null, numberProcessed: 12}))).toBe(12);
    expect(recordAnimalCount({record_type: 'batch', number_processed: 7})).toBe(7);
  });

  it('returns null (missing) — never an invented zero — for absent/unusable values', () => {
    expect(recordAnimalCount(rec())).toBe(null);
    expect(recordAnimalCount(rec({liveCount: ''}))).toBe(null);
    expect(recordAnimalCount(rec({liveCount: 'abc'}))).toBe(null);
    expect(recordAnimalCount(null)).toBe(null);
  });

  it('treats a negative value as invalid/missing — it can never subtract animals', () => {
    expect(recordAnimalCount(rec({liveCount: -5}))).toBe(null);
    expect(recordAnimalCount(rec({liveCount: null, numberProcessed: -3}))).toBe(null);
    // A recorded zero remains a valid zero, not missing.
    expect(recordAnimalCount(rec({liveCount: 0}))).toBe(0);
  });
});

describe('computeProgramChipCounts — batch-only chip counts', () => {
  const rows = [
    rec({program: 'broiler'}),
    rec({program: 'broiler', status: 'complete'}),
    rec({program: 'cattle'}),
    rec({program: 'sheep'}),
    rec({program: 'pig'}),
    rec({program: 'pig'}),
    // Milestones — must not contribute to All or any program chip.
    rec({program: 'broiler', recordType: 'milestone'}),
    rec({program: 'cattle', recordType: 'milestone'}),
    rec({program: 'pig', recordType: 'milestone', status: 'complete'}),
  ];

  it('All counts batch records only — milestones are excluded', () => {
    expect(computeProgramChipCounts(rows).all).toBe(6);
  });

  it('each program chip excludes that program milestone rows', () => {
    const counts = computeProgramChipCounts(rows);
    expect(counts.broiler).toBe(2);
    expect(counts.cattle).toBe(1);
    expect(counts.sheep).toBe(1);
    expect(counts.pig).toBe(2);
  });

  it('All equals the sum of the four batch-only program counts', () => {
    const counts = computeProgramChipCounts(rows);
    expect(counts.all).toBe(counts.broiler + counts.cattle + counts.sheep + counts.pig);
  });

  it('is pure over its input rows — year/search filtering upstream drives the numbers', () => {
    expect(computeProgramChipCounts([])).toEqual({all: 0, broiler: 0, cattle: 0, sheep: 0, pig: 0});
    expect(computeProgramChipCounts(rows.slice(0, 2))).toEqual({all: 2, broiler: 2, cattle: 0, sheep: 0, pig: 0});
  });

  it('fails closed on unknown/null program keys — All can never drift from the four-program sum', () => {
    const counts = computeProgramChipCounts([
      ...rows,
      rec({program: 'goat'}), // unknown program batch row
      {record_type: 'batch', program: null, source_kind: null, effective_status: 'planned'}, // no program at all
      rec({program: 'goat', recordType: 'milestone'}),
    ]);
    // The unrecognized rows count nowhere — not in All, not in any bucket.
    expect(counts).toEqual({all: 6, broiler: 2, cattle: 1, sheep: 1, pig: 2});
    expect(counts.all).toBe(counts.broiler + counts.cattle + counts.sheep + counts.pig);
  });
});

describe('computeCompletedProgramTotals — per-program completed animal totals', () => {
  it('only COMPLETED batch rows contribute; Planned / In Process / milestone rows never do', () => {
    const totals = computeCompletedProgramTotals([
      rec({program: 'broiler', status: 'complete', liveCount: 100}),
      rec({program: 'broiler', status: 'planned', liveCount: 500}),
      rec({program: 'broiler', status: 'in_process', liveCount: 500}),
      // Even a "complete" milestone row is a planning placeholder, not animals.
      rec({program: 'broiler', recordType: 'milestone', status: 'complete', liveCount: 500}),
    ]);
    expect(totals.broiler).toEqual({total: 100, missingCount: 0});
  });

  it('uses live_count with number_processed fallback per row', () => {
    const totals = computeCompletedProgramTotals([
      rec({program: 'cattle', status: 'complete', liveCount: 8, numberProcessed: 99}),
      rec({program: 'cattle', status: 'complete', liveCount: null, numberProcessed: 5}),
    ]);
    expect(totals.cattle).toEqual({total: 13, missingCount: 0});
  });

  it('sums each program independently — no species can leak into another and no combined total exists', () => {
    const totals = computeCompletedProgramTotals([
      rec({program: 'broiler', status: 'complete', liveCount: 700}),
      rec({program: 'cattle', status: 'complete', liveCount: 4}),
      rec({program: 'sheep', status: 'complete', liveCount: 11}),
      rec({program: 'pig', status: 'complete', liveCount: 9}),
    ]);
    expect(totals.broiler.total).toBe(700);
    expect(totals.cattle.total).toBe(4);
    expect(totals.sheep.total).toBe(11);
    expect(totals.pig.total).toBe(9);
    // Shape guard: exactly the four program buckets, no 'all'/'head'/combined
    // key, and each bucket exposes only {total, missingCount}.
    expect(Object.keys(totals)).toEqual([...PROCESSING_DASHBOARD_PROGRAM_KEYS]);
    for (const key of PROCESSING_DASHBOARD_PROGRAM_KEYS) {
      expect(Object.keys(totals[key]).sort()).toEqual(['missingCount', 'total']);
    }
  });

  it('missing counts on completed rows keep the known subtotal truthful and are disclosed, not zeroed', () => {
    const totals = computeCompletedProgramTotals([
      rec({program: 'pig', status: 'complete', liveCount: 6}),
      rec({program: 'pig', status: 'complete'}), // no count recorded
      rec({program: 'pig', status: 'complete', liveCount: ''}), // unusable value
    ]);
    expect(totals.pig).toEqual({total: 6, missingCount: 2});
  });

  it('a recorded zero counts as zero animals, not as missing data', () => {
    const totals = computeCompletedProgramTotals([rec({program: 'sheep', status: 'complete', liveCount: 0})]);
    expect(totals.sheep).toEqual({total: 0, missingCount: 0});
  });

  it('a negative count on a completed row is disclosed as missing and never subtracts animals', () => {
    const totals = computeCompletedProgramTotals([
      rec({program: 'pig', status: 'complete', liveCount: 6}),
      rec({program: 'pig', status: 'complete', liveCount: -5}),
    ]);
    expect(totals.pig).toEqual({total: 6, missingCount: 1});
  });

  it('a program with no completed rows reports an unambiguous 0', () => {
    const totals = computeCompletedProgramTotals([rec({program: 'broiler', status: 'planned', liveCount: 40})]);
    expect(totals.broiler).toEqual({total: 0, missingCount: 0});
    expect(totals.cattle).toEqual({total: 0, missingCount: 0});
    expect(computeCompletedProgramTotals([]).pig).toEqual({total: 0, missingCount: 0});
  });

  it('recomputes per input set — switching the selected-year row subset switches every total', () => {
    const year2025 = [
      rec({program: 'broiler', status: 'complete', liveCount: 640}),
      rec({program: 'pig', status: 'complete', liveCount: 12}),
    ];
    const year2026 = [rec({program: 'broiler', status: 'complete', liveCount: 210})];
    expect(computeCompletedProgramTotals(year2025).broiler.total).toBe(640);
    expect(computeCompletedProgramTotals(year2025).pig.total).toBe(12);
    expect(computeCompletedProgramTotals(year2026).broiler.total).toBe(210);
    expect(computeCompletedProgramTotals(year2026).pig.total).toBe(0);
  });
});

describe('isBatchRecord', () => {
  it('treats only non-milestone records as batches', () => {
    expect(isBatchRecord(rec())).toBe(true);
    expect(isBatchRecord(rec({recordType: 'milestone'}))).toBe(false);
    expect(isBatchRecord(null)).toBe(false);
  });
});
