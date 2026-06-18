import {describe, expect, it} from 'vitest';
import {
  buildEggProductionEvents,
  buildLegacyProductionEvents,
  buildProductionAuditView,
  buildProductionEventsView,
  buildProductionLedger,
  buildProductionMatrix,
  buildProductionModel,
  buildProductionSummary,
  buildProductionYearRows,
  formatProductionDelta,
  formatProductionNumber,
  homeProductionStats,
  reconcileProductionEvents,
} from './production.js';

describe('production reconciliation', () => {
  it('holds all legacy rows in a Planner-covered program/year, even export-dated duplicates', () => {
    const plannerEvents = buildLegacyProductionEvents([
      {id: 'planner-pig', event_date: '2026-04-03', program: 'pig', batch_name: 'P-26-01A', quantity: 5},
      {id: 'planner-broiler-5', event_date: '2026-05-01', program: 'broiler', batch_name: 'B-26-05', quantity: 600},
    ]).map((event) => ({...event, source: 'planner', sourceLabel: 'Planner'}));
    const legacyEvents = buildLegacyProductionEvents([
      // exact match -> held
      {id: 'legacy-pig', event_date: '2026-04-03', program: 'PIG', batch_name: 'P-26-01A', quantity: 5},
      // no line-up, but broiler 2026 is Planner-covered -> held (superseded), NOT counted
      {id: 'legacy-broiler-4', event_date: '2026-04-01', program: 'CHICKEN', batch_name: 'B-26-04', quantity: 574},
    ]);

    const result = reconcileProductionEvents({plannerEvents, legacyEvents});

    // Planner wins by coverage: broiler total is the Planner 600 only — the 574
    // legacy row is held, not added on top.
    expect(result.events.filter((event) => event.program === 'pig')).toHaveLength(1);
    expect(
      result.events.filter((event) => event.program === 'broiler').reduce((sum, event) => sum + event.quantity, 0),
    ).toBe(600);
    expect(result.audit.map((row) => row.status)).toEqual(['matched', 'superseded']);
    expect(result.audit.every((row) => row.counted === false)).toBe(true);
  });

  it('counts legacy backfill only where Planner has no events for that program/year', () => {
    const plannerEvents = buildLegacyProductionEvents([
      {id: 'planner-broiler', event_date: '2026-05-01', program: 'broiler', batch_name: 'B-26-05', quantity: 600},
    ]).map((event) => ({...event, source: 'planner', sourceLabel: 'Planner'}));
    const legacyEvents = buildLegacyProductionEvents([
      // 2024 broiler: Planner has nothing -> legacy counts as backfill
      {id: 'legacy-2024', event_date: '2024-06-01', program: 'CHICKEN', batch_name: 'B-24-01', quantity: 2500},
    ]);

    const result = reconcileProductionEvents({plannerEvents, legacyEvents});

    expect(result.events.filter((event) => event.year === '2024')).toHaveLength(1);
    expect(result.events.filter((event) => event.year === '2024')[0].quantity).toBe(2500);
    expect(result.audit[0].status).toBe('legacy_only');
    expect(result.audit[0].counted).toBe(true);
  });

  it('holds conflicts out of totals so Planner wins until review', () => {
    const plannerEvents = buildLegacyProductionEvents([
      {id: 'planner-cattle', event_date: '2026-04-03', program: 'cattle', batch_name: 'C-26-01', quantity: 4},
    ]).map((event) => ({...event, source: 'planner', sourceLabel: 'Planner'}));
    const legacyEvents = buildLegacyProductionEvents([
      {id: 'legacy-cattle', event_date: '2026-04-03', program: 'CATTLE', batch_name: 'C-26-01', quantity: 5},
    ]);

    const result = reconcileProductionEvents({plannerEvents, legacyEvents});

    expect(result.events).toHaveLength(1);
    expect(result.events[0].quantity).toBe(4);
    expect(result.audit[0].status).toBe('conflict');
    expect(result.audit[0].counted).toBe(false);
  });
});

describe('production yearly totals', () => {
  it('calculates YoY inside each program, including explicit zero years', () => {
    const events = buildLegacyProductionEvents([
      {event_date: '2023-10-18', program: 'LAMB', quantity: 26},
      {event_date: '2024-01-01', program: 'LAMB', quantity: 0},
      {event_date: '2025-07-23', program: 'LAMB', quantity: 3},
    ]);

    expect(buildProductionYearRows(events, 'sheep')).toEqual([
      {year: '2023', quantity: 26, yoy: null},
      {year: '2024', quantity: 0, yoy: -26},
      {year: '2025', quantity: 3, yoy: 3},
    ]);
  });

  it('formats eggs as dozens without mixing them into animal counts', () => {
    const eggEvents = buildEggProductionEvents([
      {id: 'egg-1', date: '2026-06-01', group1_count: 12, group2_count: 6, group3_count: '', group4_count: 0},
    ]);
    const model = buildProductionModel({eggDailys: [eggEvents[0].raw]});
    const stats = homeProductionStats(model, 2026);

    expect(eggEvents[0].quantity).toBe(18);
    expect(formatProductionNumber('egg', 18)).toBe('1.5');
    expect(formatProductionDelta('egg', -24)).toBe('-2');
    expect(stats.find((stat) => stat.programKey === 'egg').value).toBe('1.5');
    expect(stats).toHaveLength(5);
  });
});

describe('production multi-year matrix', () => {
  const model = buildProductionModel({
    legacyEvents: [
      {id: 'b22', event_date: '2022-06-01', program: 'CHICKEN', batch_name: 'B-22', quantity: 1846},
      {id: 'b23', event_date: '2023-06-01', program: 'CHICKEN', batch_name: 'B-23', quantity: 961},
      {id: 'p22', event_date: '2022-06-01', program: 'PIG', batch_name: 'P-22', quantity: 25},
      {id: 'p23', event_date: '2023-06-01', program: 'PIG', batch_name: 'P-23', quantity: 45},
      {id: 'p24', event_date: '2024-06-01', program: 'PIG', batch_name: 'P-24', quantity: 45},
      {id: 'c22', event_date: '2022-06-01', program: 'CATTLE', batch_name: 'C-22', quantity: 4},
      {id: 's23', event_date: '2023-06-01', program: 'LAMB', batch_name: 'L-23', quantity: 26},
      {id: 's24', event_date: '2024-01-01', program: 'LAMB', batch_name: 'L-24', quantity: 0},
    ],
    // Eggs are stored as individual eggs; the matrix displays dozens.
    eggDailys: [
      {id: 'e22', date: '2022-06-01', group1_count: 2980 * 12},
      {id: 'e23', date: '2023-06-01', group1_count: 3210 * 12},
    ],
  });
  const matrix = buildProductionMatrix(model);
  const cell = (label, year) => matrix.rows.find((r) => r.label === label).cells.find((c) => c.year === year);

  it('orders rows Broilers, Pigs, Cattle, Sheep/Lamb, Eggs last', () => {
    expect(matrix.rows.map((r) => r.label)).toEqual(['Broilers', 'Pigs', 'Cattle', 'Sheep/Lamb', 'Eggs']);
  });

  it('lists every recorded year oldest to newest and flags the latest', () => {
    expect(matrix.years).toEqual(['2022', '2023', '2024']);
    expect(matrix.latest).toBe('2024');
    expect(cell('Broilers', '2024').isLatest).toBe(true);
    expect(cell('Broilers', '2022').isLatest).toBe(false);
  });

  it('renders a missing program/year as dash/dash but a real zero as 0', () => {
    // Broilers have no 2024 record -> dash total + dash delta.
    expect(cell('Broilers', '2024')).toMatchObject({hasData: false, totalText: '—', deltaText: '—', deltaKind: 'none'});
    // Sheep/Lamb 2022 not recorded -> dash; 2024 is a real zero -> "0".
    expect(cell('Sheep/Lamb', '2022').totalText).toBe('—');
    expect(cell('Sheep/Lamb', '2024').totalText).toBe('0');
    expect(cell('Sheep/Lamb', '2024').deltaText).toBe('-26');
    expect(cell('Sheep/Lamb', '2024').deltaKind).toBe('down');
  });

  it('shows a dash delta for a program first recorded year and ±0 for flat', () => {
    expect(cell('Sheep/Lamb', '2023').deltaText).toBe('—'); // first recorded year for sheep
    expect(cell('Broilers', '2022').deltaText).toBe('—'); // first recorded year for broilers
    expect(cell('Pigs', '2024').deltaText).toBe('±0'); // 45 -> 45
    expect(cell('Pigs', '2024').deltaKind).toBe('flat');
  });

  it('displays egg totals and deltas in dozens with decimal handling', () => {
    expect(cell('Eggs', '2022').totalText).toBe('2,980');
    expect(cell('Eggs', '2023').totalText).toBe('3,210');
    expect(cell('Eggs', '2023').deltaText).toBe('+230');
    expect(cell('Eggs', '2023').deltaKind).toBe('up');
    expect(cell('Eggs', '2024').totalText).toBe('—');
  });
});

describe('production events view', () => {
  const model = buildProductionModel({
    batches: [
      {
        id: 'hist-b2602',
        name: 'B-26-02',
        status: 'processed',
        processingDate: '2026-01-27',
        totalToProcessor: 508,
      },
      {
        id: 'hist-b2601',
        name: 'B-26-01',
        status: 'processed',
        processingDate: '2026-01-08',
        totalToProcessor: 493,
      },
      {
        id: 'hist-b2503',
        name: 'B-25-03',
        status: 'processed',
        processingDate: '2025-06-13',
        totalToProcessor: 705,
      },
    ],
    cattleProcessingBatches: [
      {id: 'c1', name: 'C-26-01', actual_process_date: '2026-04-03', cows_detail: [1, 2, 3, 4]},
    ],
    eggDailys: [{id: 'e1', date: '2026-06-01', group1_count: 24}],
    legacyEvents: [
      {id: 'L-b2602', event_date: '2026-01-27', program: 'CHICKEN', batch_name: '', quantity: 508},
      {id: 'L-b2601', event_date: '2026-01-08', program: 'CHICKEN', batch_name: '', quantity: 493},
      {id: 'L-b2503', event_date: '2025-06-11', program: 'CHICKEN', batch_name: '', quantity: 705},
      // 2026 cattle is covered by Planner -> held out of totals, but must still appear here.
      {id: 'L1', event_date: '2026-04-03', program: 'CATTLE', batch_name: 'C-26-01', quantity: 5},
      // 2024 cattle has no Planner record -> counted backfill.
      {id: 'L2', event_date: '2024-02-01', program: 'CATTLE', batch_name: 'C-24-01', quantity: 3},
    ],
  });

  it('excludes egg events and shows every imported production event, including held-out rows', () => {
    const view = buildProductionEventsView(model, {});
    expect(view.some((row) => row.program === 'egg')).toBe(false);
    // counted Planner cattle (4), held-out legacy conflict (5), and backfill (3) all appear
    expect(view.find((row) => row.quantity === 4)).toBeTruthy();
    expect(view.find((row) => row.quantity === 5)).toBeTruthy();
    expect(view.find((row) => row.quantity === 3)).toBeTruthy();
  });

  it('sorts by date desc and can still filter by year when a caller asks', () => {
    const all = buildProductionEventsView(model, {});
    expect(all[0].date >= all[all.length - 1].date).toBe(true);
    expect(all[0].date.startsWith('2026')).toBe(true);

    const y2024 = buildProductionEventsView(model, {year: '2024'});
    expect(y2024).toHaveLength(1);
    expect(y2024.every((row) => row.date.startsWith('2024'))).toBe(true);
  });

  it('adds broiler batch names and record links to uniquely matched imported events', () => {
    const view = buildProductionEventsView(model, {});
    expect(view.find((row) => row.id === 'legacy:L-b2602')).toMatchObject({
      batchName: 'B-26-02',
      recordPath: '/broiler/batches/B-26-02',
      matchedBatchName: 'B-26-02',
    });
    expect(view.find((row) => row.id === 'legacy:L-b2601')).toMatchObject({
      batchName: 'B-26-01',
      recordPath: '/broiler/batches/B-26-01',
      matchedBatchName: 'B-26-01',
    });
    expect(view.find((row) => row.id === 'legacy:L-b2503')).toMatchObject({
      batchName: 'B-25-03',
      recordPath: '/broiler/batches/B-25-03',
      matchedBatchName: 'B-25-03',
    });
  });

  it('does not link an imported event when the planner match is ambiguous', () => {
    const ambiguous = buildProductionModel({
      batches: [
        {id: 'a', name: 'B-26-A', status: 'processed', processingDate: '2026-05-01', totalToProcessor: 600},
        {id: 'b', name: 'B-26-B', status: 'processed', processingDate: '2026-05-01', totalToProcessor: 600},
      ],
      legacyEvents: [{id: 'L-ambiguous', event_date: '2026-05-01', program: 'CHICKEN', batch_name: '', quantity: 600}],
    });
    const row = buildProductionEventsView(ambiguous, {}).find((item) => item.id === 'legacy:L-ambiguous');
    expect(row.batchName).toBe('');
    expect(row.recordPath).toBe('');
  });

  it('shows import-only batch names as text without linking to missing records', () => {
    const importOnly = buildProductionModel({
      legacyEvents: [{id: 'L-old', event_date: '2023-02-01', program: 'CHICKEN', batch_name: 'B-23-01', quantity: 500}],
    });
    const row = buildProductionEventsView(importOnly, {}).find((item) => item.id === 'legacy:L-old');
    expect(row.batchName).toBe('B-23-01');
    expect(row.recordPath).toBe('');
  });
});

describe('production reconciliation summary and ledger', () => {
  // Planner wins: a matching legacy row is held out, a same-batch/different-count
  // row is a held-out conflict, and a Planner-only row counts on top.
  const sources = {
    cattleProcessingBatches: [
      {id: 'c1', name: 'C-26-01', actual_process_date: '2026-04-03', cows_detail: [1, 2, 3, 4]},
      {id: 'c2', name: 'C-26-09', actual_process_date: '2026-05-01', cows_detail: [1, 2, 3]},
    ],
    legacyEvents: [
      {id: 'L1', event_date: '2026-04-03', program: 'CATTLE', batch_name: 'C-26-01', quantity: 4},
      {id: 'L2', event_date: '2026-05-01', program: 'CATTLE', batch_name: 'C-26-09', quantity: 9},
      {id: 'L3', event_date: '2024-02-01', program: 'CATTLE', batch_name: 'C-24-01', quantity: 3},
    ],
  };
  const model = buildProductionModel(sources);

  it('decomposes counted totals into Planner vs legacy backfill with held-out rows', () => {
    const cattle2026 = buildProductionSummary(model, '2026').find((row) => row.programKey === 'cattle');
    expect(cattle2026).toMatchObject({
      counted: 7,
      plannerCounted: 7,
      legacyCounted: 0,
      heldOut: 13,
      conflict: 9,
    });

    const cattle2024 = buildProductionSummary(model, '2024').find((row) => row.programKey === 'cattle');
    expect(cattle2024).toMatchObject({counted: 3, legacyCounted: 3, plannerCounted: 0, heldOut: 0});

    // No Podio columns exist on the summary anymore.
    expect(cattle2026).not.toHaveProperty('rawPodio');
    expect(cattle2026).not.toHaveProperty('delta');
  });

  it('lists only counted events in the ledger and every legacy disposition in the audit view', () => {
    const ledger2026 = buildProductionLedger(model, '2026');
    expect(ledger2026).toHaveLength(2);
    expect(ledger2026.every((row) => row.counted && row.source === 'planner' && row.status === 'planner')).toBe(true);

    const audit2026 = buildProductionAuditView(model, '2026');
    expect(audit2026.map((row) => row.status).sort()).toEqual(['conflict', 'matched']);
    expect(audit2026.every((row) => row.counted === false)).toBe(true);
    const conflict = audit2026.find((row) => row.status === 'conflict');
    expect(conflict.tone).toBe('danger');
    expect(conflict.reason).toMatch(/Planner wins/);
  });
});
