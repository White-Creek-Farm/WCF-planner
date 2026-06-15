import {describe, expect, it} from 'vitest';
import {
  ANIMAL_HISTORY_START_MONTH,
  broilersOnFarmAt,
  buildAnimalHistoryRows,
  buildAnimalHistorySnapshot,
  cattleOnFarmAt,
  formatAnimalHistoryMonth,
  layersOnFarmAt,
  pigsOnFarmAt,
  sheepOnFarmAt,
} from './animalHistory.js';

describe('animal history month-end counts', () => {
  it('builds newest-first rows from the Oct 2024 floor through the current month', () => {
    const rows = buildAnimalHistoryRows(
      {
        batches: [{name: 'B-24-01', hatchDate: '2024-02-10', processingDate: '2024-11-15', birdCountActual: 10}],
        broilerDailys: [],
      },
      '2024-12-10',
    );

    expect(ANIMAL_HISTORY_START_MONTH).toBe('2024-10');
    expect(rows.map((r) => r.month)).toEqual(['2024-12', '2024-11', '2024-10']);
    expect(rows.find((r) => r.month === '2024-10').broilers).toBe(10);
    expect(rows.find((r) => r.month === '2024-11').broilers).toBe(0);
    expect(rows.find((r) => r.month === '2024-12').isPartialMonth).toBe(true);
    expect(rows.find((r) => r.month === '2024-11').isPartialMonth).toBe(false);
  });

  it('formats month and snapshot labels without local-time month rollback', () => {
    expect(formatAnimalHistoryMonth('2026-06')).toBe('Jun 2026');
  });

  it('does not invent rows before any planner evidence exists', () => {
    expect(buildAnimalHistoryRows({}, '2026-06-11')).toEqual([]);
  });

  it('counts broilers from hatch through the day before processing with mortality through the snapshot', () => {
    const batches = [{name: 'B-26-01', hatchDate: '2026-01-15', processingDate: '2026-03-20', birdCountActual: 100}];
    const dailys = [
      {batch_label: 'B-26-01', date: '2026-01-20', mortality_count: 2},
      {batch_label: 'B-26-01', date: '2026-02-10', mortality_count: 3},
      {batch_label: 'B-26-01', date: '2026-03-21', mortality_count: 99},
    ];

    expect(broilersOnFarmAt(batches, dailys, '2026-02-28')).toBe(95);
    expect(broilersOnFarmAt(batches, dailys, '2026-03-31')).toBe(0);
  });

  it('uses latest layer daily counts inside the housing active window', () => {
    const batches = [{id: 'lb-1', name: 'L-26-01', original_count: 200, arrival_date: '2026-01-01'}];
    const housings = [
      {
        id: 'h-1',
        batch_id: 'lb-1',
        housing_name: 'Eggmobile 1',
        start_date: '2026-01-10',
        retired_date: '2026-03-01',
        current_count: 180,
        current_count_date: '2026-02-15',
      },
    ];
    const dailys = [
      {batch_label: 'Eggmobile 1', batch_id: 'lb-1', date: '2026-01-31', layer_count: 190},
      {batch_label: 'Eggmobile 1', batch_id: 'lb-1', date: '2026-02-20', layer_count: 175},
      {batch_label: 'Eggmobile 1', batch_id: 'lb-1', date: '2026-03-10', layer_count: 170},
    ];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-01-31')).toBe(190);
    expect(layersOnFarmAt(batches, housings, dailys, '2026-02-28')).toBe(175);
    expect(layersOnFarmAt(batches, housings, dailys, '2026-03-31')).toBe(0);
  });

  it('builds the current snapshot with the same no-housing layer batch logic as the current history row', () => {
    const data = {
      layerBatches: [{id: 'lb-99', name: 'L-26-99', original_count: 99, arrival_date: '2026-06-01', status: 'active'}],
      layerHousings: [],
      layerDailys: [],
    };

    const snapshot = buildAnimalHistorySnapshot(data, '2026-06-15');
    const [row] = buildAnimalHistoryRows(data, '2026-06-15');

    expect(snapshot.month).toBe('2026-06');
    expect(snapshot.snapshotDate).toBe('2026-06-15');
    expect(snapshot.isPartialMonth).toBe(true);
    expect(snapshot.layers).toBe(99);
    expect(snapshot.total).toBe(99);
    expect(row.layers).toBe(snapshot.layers);
    expect(row.total).toBe(snapshot.total);
  });

  it('uses pig daily counts and subtracts later target events while breeders cover SOWS/BOARS fallback', () => {
    const feederGroups = [
      {
        id: 'fg-1',
        batchName: 'P-26-01',
        status: 'active',
        startDate: '2026-01-01',
        giltCount: 10,
        boarCount: 0,
        processingTrips: [{date: '2026-02-15', pigCount: 3}],
        pigMortalities: [{date: '2026-02-20', count: 1}],
        subBatches: [],
      },
    ];
    const breeders = [
      {id: 'sow-1', sex: 'Sow', status: 'Sow Group', purchaseDate: '2025-01-01', archived: false},
      {id: 'boar-1', sex: 'Boar', status: 'Boar Group', purchaseDate: '2025-01-01', archived: false},
    ];
    const dailys = [{batch_label: 'P-26-01', date: '2026-01-31', pig_count: 9}];

    expect(pigsOnFarmAt(feederGroups, breeders, dailys, '2026-02-28')).toBe(7);
  });

  it('rewinds cattle and sheep transfers to decide whether an animal was on farm at a prior month end', () => {
    const cattle = [{id: 'cow-1', tag: '1', herd: 'processed', created_at: '2026-01-01'}];
    const cattleTransfers = [
      {cattle_id: 'cow-1', from_herd: 'mommas', to_herd: 'finishers', transferred_at: '2026-02-10'},
      {cattle_id: 'cow-1', from_herd: 'finishers', to_herd: 'processed', transferred_at: '2026-03-10'},
    ];
    const sheep = [{id: 'sheep-1', tag: '100', flock: 'feeders', created_at: '2026-01-01'}];
    const sheepTransfers = [
      {sheep_id: 'sheep-1', from_flock: 'ewes', to_flock: 'feeders', transferred_at: '2026-02-10'},
    ];

    expect(cattleOnFarmAt(cattle, cattleTransfers, '2026-02-28')).toBe(1);
    expect(cattleOnFarmAt(cattle, cattleTransfers, '2026-03-31')).toBe(0);
    expect(sheepOnFarmAt(sheep, sheepTransfers, '2026-01-31')).toBe(1);
    expect(sheepOnFarmAt(sheep, sheepTransfers, '2026-02-28')).toBe(1);
  });
});
