import {describe, expect, it} from 'vitest';
import {
  buildActivityLogExportColumns,
  buildBroilerBatchExportColumns,
  buildEquipmentFleetExportColumns,
  buildLayerBatchExportColumns,
  buildPigBatchExportColumns,
  buildProcessingBatchExportColumns,
} from './operationalExportColumns.js';

function valueFor(columns, header, row) {
  const col = columns.find((c) => c.header === header);
  expect(col, 'missing column ' + header).toBeTruthy();
  return col.value(row);
}

describe('operational export columns', () => {
  it('formats activity rows with friendly event/entity labels and mentions', () => {
    const columns = buildActivityLogExportColumns({
      entityTypeLabels: {pig_batch: 'Pig batch'},
      eventTypeLabels: {comment: 'Comment'},
    });
    const row = {
      created_at: '2026-06-09T12:00:00Z',
      actor_display_name: 'Ronnie',
      event_type: 'comment',
      entity_type: 'pig_batch',
      entity_label: 'P-26-01',
      body: 'Ready',
      mentioned_profile_names: ['CC', 'Codex'],
      id: 'act-1',
    };
    expect(valueFor(columns, 'Event', row)).toBe('Comment');
    expect(valueFor(columns, 'Entity type', row)).toBe('Pig batch');
    expect(valueFor(columns, 'Mentions', row)).toBe('CC, Codex');
    expect(valueFor(columns, 'Body', {...row, deleted_at: '2026-06-09T13:00:00Z'})).toBe('(comment deleted)');
  });

  it('formats equipment fleet readings and fueling dates through caller formatters', () => {
    const columns = buildEquipmentFleetExportColumns({
      fmt: (value) => 'date:' + value,
      fmtReading: (value, unit) => value + ' ' + unit,
    });
    const row = {name: 'Tractor', current_reading: 123.4, tracking_unit: 'hours', last_fueling_date: '2026-06-08'};
    expect(valueFor(columns, 'Current reading', row)).toBe('123.4 hours');
    expect(valueFor(columns, 'Last fueling date', row)).toBe('date:2026-06-08');
  });

  it('supports cattle/sheep processing batch rollup columns', () => {
    const columns = buildProcessingBatchExportColumns({fmt: (value) => value.slice(0, 10), animalLabel: 'Cow'});
    const row = {
      name: 'C-26-01',
      planned_process_date: '2026-06-20',
      animal_count: 4,
      total_live_weight: 3250.25,
      total_hanging_weight: 2010.1,
      yield_pct: 61.842,
    };
    expect(valueFor(columns, 'Cow count', row)).toBe(4);
    expect(valueFor(columns, 'Total live weight', row)).toBe(3250.3);
    expect(valueFor(columns, 'Yield %', row)).toBe(61.8);
  });

  it('exports broiler operational feed metrics', () => {
    const columns = buildBroilerBatchExportColumns({fmt: (value) => 'date:' + value});
    const row = {
      name: 'B-26-01',
      export_status: 'processed',
      hatchDate: '2026-04-01',
      export_total_feed_lbs: 987.65,
      export_feed_per_processed_bird: 4.321,
      avgDressedLbs: 3.456,
    };
    expect(valueFor(columns, 'Status', row)).toBe('processed');
    expect(valueFor(columns, 'Hatch date', row)).toBe('date:2026-04-01');
    expect(valueFor(columns, 'Total feed lbs', row)).toBe(987.7);
    expect(valueFor(columns, 'Feed per processed bird', row)).toBe(4.32);
    expect(valueFor(columns, 'Avg dressed lbs', row)).toBe(3.46);
  });

  it('exports layer batch production and feed cost metrics', () => {
    const columns = buildLayerBatchExportColumns();
    const row = {
      active_housing_names: 'Eggmobile 1',
      current_hens: 244,
      total_feed_lbs: 1234.56,
      total_mortality: 3,
      total_dozens: 808,
      feed_cost: 321.5,
    };
    expect(valueFor(columns, 'Active housings', row)).toBe('Eggmobile 1');
    expect(valueFor(columns, 'Feed lbs', row)).toBe(1234.6);
    expect(valueFor(columns, 'Feed cost', row)).toBe('$321.50');
  });

  it('exports pig batch grid metrics', () => {
    const columns = buildPigBatchExportColumns({fmt: (value) => 'date:' + value});
    const row = {
      batchName: 'P-26-01',
      startDate: '2026-01-02',
      started_head: 20,
      current_head: 12,
      total_feed_lbs: 5123.22,
      feed_per_pig: 256.161,
      gilts_started: 12,
      gilts_current: 8,
      gilts_total_feed_lbs: 3073.93,
      gilts_feed_per_pig: 256.161,
      boars_started: 8,
      boars_current: 4,
      boars_total_feed_lbs: 2049.29,
      boars_feed_per_pig: 256.161,
      cycle_label: 'Cycle 4',
    };
    expect(valueFor(columns, 'Start date', row)).toBe('date:2026-01-02');
    expect(valueFor(columns, 'Current Head', row)).toBe(12);
    expect(valueFor(columns, 'Total Feed', row)).toBe(5123.2);
    expect(valueFor(columns, 'Feed / Pig', row)).toBe(256.2);
    expect(valueFor(columns, 'Gilts Feed / Pig', row)).toBe(256.2);
    expect(valueFor(columns, 'Boars Current', row)).toBe(4);
  });
});
