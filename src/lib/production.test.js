import {describe, expect, it} from 'vitest';
import {
  buildEggProductionEvents,
  buildLegacyProductionEvents,
  buildProductionAuditView,
  buildProductionLedger,
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
