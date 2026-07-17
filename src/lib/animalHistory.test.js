import {describe, expect, it} from 'vitest';
import {
  ANIMAL_HISTORY_START_MONTH,
  animalHistoryScaleMax,
  broilersOnFarmAt,
  buildAnimalHistoryRows,
  buildAnimalHistorySnapshot,
  cattleOnFarmAt,
  formatAnimalHistoryMonth,
  layersFreshnessAt,
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

  it('gives sibling housings under one batch their own exact-label counts, never each other`s', () => {
    // PROD regression: Eggmobile 2 and Layer Schooner both belong to l-26-01.
    // The Layer Schooner row must not also count for Eggmobile 2 (293+293+115
    // once produced the wrong 701 layer total).
    const batches = [{id: 'l-26-01', name: 'L-26-01', arrival_date: '2026-01-01'}];
    const housings = [
      {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', start_date: '2026-01-05'},
      {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', start_date: '2026-01-05'},
      {id: 'h-e3', batch_id: 'l-26-03', housing_name: 'Eggmobile 3', start_date: '2026-01-05'},
    ];
    const dailys = [
      {batch_label: 'Eggmobile 2', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 156},
      {batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 293},
      {batch_label: 'Eggmobile 3', batch_id: 'l-26-03', date: '2026-04-10', layer_count: 115},
    ];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(156 + 293 + 115);
  });

  it('never counts one daily row for a second sibling housing without its own evidence', () => {
    const batches = [{id: 'l-26-01', name: 'L-26-01', arrival_date: '2026-01-01'}];
    const housings = [
      {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', start_date: '2026-01-05'},
      {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', start_date: '2026-01-05'},
    ];
    const dailys = [{batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 293}];

    // Eggmobile 2 has no evidence of its own: total is Schooner only, not 586.
    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(293);
  });

  it('matches exact housing labels case-insensitively', () => {
    const batches = [{id: 'l-26-01', name: 'L-26-01', arrival_date: '2026-01-01'}];
    const housings = [
      {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', start_date: '2026-01-05'},
      {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', start_date: '2026-01-05'},
    ];
    const dailys = [
      {batch_label: '  eggmobile 2 ', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 156},
      {batch_label: 'LAYER SCHOONER', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 293},
    ];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(156 + 293);
  });

  it('keeps unambiguous batch-id fallback for a single-housing legacy row', () => {
    const batches = [{id: 'lb-9', name: 'L-25-01', arrival_date: '2025-06-01'}];
    const housings = [{id: 'h-1', batch_id: 'lb-9', housing_name: 'Eggmobile 1', start_date: '2025-06-05'}];
    const dailys = [{batch_label: 'L-25-01', batch_id: 'lb-9', date: '2026-04-10', layer_count: 120}];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(120);
  });

  it('fails closed on a batch-level label shared by multiple sibling housings', () => {
    const batches = [{id: 'l-26-01', name: 'L-26-01', arrival_date: '2026-01-01'}];
    const housings = [
      {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', start_date: '2026-01-05', current_count: 150},
      {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', start_date: '2026-01-05', current_count: 290},
    ];
    // Parent-batch label: cannot be attributed to either sibling. Both fall
    // back to their own current_count instead of guessing 300 for one of them.
    const dailys = [{batch_label: 'L-26-01', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 300}];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(150 + 290);
  });

  it('keeps a housing with dated count evidence even when start_date is absent', () => {
    // PROD regression: Retirement Home has no start_date but real dated counts.
    const batches = [];
    const housings = [{id: 'h-rh', housing_name: 'Retirement Home', start_date: null, status: 'active'}];
    const dailys = [{batch_label: 'Retirement Home', date: '2026-04-10', layer_count: 67}];

    expect(layersOnFarmAt(batches, housings, dailys, '2026-04-30')).toBe(67);
    // Before its earliest dated evidence the housing contributes nothing.
    expect(layersOnFarmAt(batches, housings, dailys, '2026-03-31')).toBe(0);
  });

  it('lets a fresher dated current_count supersede an older daily, but not an undated one', () => {
    const batches = [{id: 'lb-1', name: 'L-26-01', arrival_date: '2026-01-01'}];
    const dailys = [{batch_label: 'Eggmobile 1', batch_id: 'lb-1', date: '2026-04-10', layer_count: 156}];

    const fresherAnchor = [
      {
        id: 'h-1',
        batch_id: 'lb-1',
        housing_name: 'Eggmobile 1',
        start_date: '2026-01-05',
        current_count: 140,
        current_count_date: '2026-04-20',
      },
    ];
    expect(layersOnFarmAt(batches, fresherAnchor, dailys, '2026-04-30')).toBe(140);
    // The fresher anchor is ignored for as-of dates before it exists.
    expect(layersOnFarmAt(batches, fresherAnchor, dailys, '2026-04-15')).toBe(156);

    const undatedAnchor = [
      {
        id: 'h-1',
        batch_id: 'lb-1',
        housing_name: 'Eggmobile 1',
        start_date: '2026-01-05',
        current_count: 140,
        current_count_date: null,
      },
    ];
    expect(layersOnFarmAt(batches, undatedAnchor, dailys, '2026-04-30')).toBe(156);
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
    expect(row.layers).toBe(snapshot.layers);
  });

  it('exposes no combined animal total on snapshots or history rows', () => {
    const data = {
      layerBatches: [{id: 'lb-99', name: 'L-26-99', original_count: 99, arrival_date: '2026-06-01', status: 'active'}],
      layerHousings: [],
      layerDailys: [],
    };

    const snapshot = buildAnimalHistorySnapshot(data, '2026-06-15');
    const [row] = buildAnimalHistoryRows(data, '2026-06-15');

    expect(snapshot).not.toHaveProperty('total');
    expect(row).not.toHaveProperty('total');
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

describe('layer freshness disclosure (layersFreshnessAt)', () => {
  const batches = [{id: 'l-26-01', name: 'L-26-01', arrival_date: '2026-01-01'}];
  const housings = [
    {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', start_date: '2026-01-05'},
    {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', start_date: '2026-01-05'},
  ];
  const dailys = [
    {batch_label: 'Eggmobile 2', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 156},
    {batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 293},
  ];

  it('mixed contributing dates disclose the OLDEST evidence date, never the newest', () => {
    const mixed = [
      dailys[0], // Eggmobile 2: 156 @ 2026-04-10
      {batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-06-01', layer_count: 280},
    ];
    const freshness = layersFreshnessAt(batches, housings, mixed, '2026-07-16');
    expect(freshness.oldestReported).toBe('2026-04-10');
    expect(freshness.hasUndatedCounts).toBe(false);
  });

  it('flows onto snapshots and history rows for the disclosure surfaces', () => {
    const data = {layerBatches: batches, layerHousings: housings, layerDailys: dailys};
    const snapshot = buildAnimalHistorySnapshot(data, '2026-07-16');
    const [row] = buildAnimalHistoryRows(data, '2026-07-16');

    expect(snapshot.layers).toBe(156 + 293);
    expect(snapshot.layersOldestReported).toBe('2026-04-10');
    expect(snapshot.layersHasUndatedCounts).toBe(false);
    expect(row.layersOldestReported).toBe('2026-04-10');
    expect(row.layersHasUndatedCounts).toBe(false);
  });

  it('a newer zero-count housing does not affect freshness', () => {
    const withZero = [
      housings[1],
      {
        id: 'h-e2',
        batch_id: 'l-26-01',
        housing_name: 'Eggmobile 2',
        start_date: '2026-01-05',
        current_count: 0,
        current_count_date: '2026-06-22',
      },
    ];
    // Eggmobile 2 counts 156 from its 2026-04-10 daily (zero anchor never
    // overrides); the zero anchor's newer date is not layer-count evidence.
    const freshness = layersFreshnessAt(batches, withZero, dailys, '2026-07-16');
    expect(freshness.oldestReported).toBe('2026-04-10');
    expect(freshness.hasUndatedCounts).toBe(false);
  });

  it('any positive undated contributor raises the undated flag', () => {
    const withUndated = [
      housings[0],
      {id: 'h-x', batch_id: 'l-26-09', housing_name: 'Eggmobile 9', start_date: '2026-01-05', current_count: 50},
    ];
    const freshness = layersFreshnessAt(batches, withUndated, dailys.slice(0, 1), '2026-07-16');
    expect(freshness.oldestReported).toBe('2026-04-10');
    expect(freshness.hasUndatedCounts).toBe(true);

    // Undated contributors only: no date, flag raised.
    const undatedOnly = layersFreshnessAt(batches, [withUndated[1]], [], '2026-07-16');
    expect(undatedOnly.oldestReported).toBeNull();
    expect(undatedOnly.hasUndatedCounts).toBe(true);
  });

  it('respects the as-of boundary', () => {
    // Before any evidence exists nothing contributes: no date, no flag.
    const before = layersFreshnessAt(batches, housings, dailys, '2026-03-31');
    expect(before.oldestReported).toBeNull();
    expect(before.hasUndatedCounts).toBe(false);

    // Evidence dated after asOf cannot drive the disclosure: at 2026-05-01
    // only the 2026-04-10 rows exist, so a later 2026-06-01 report is unseen.
    const mixed = [
      ...dailys,
      {batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-06-01', layer_count: 280},
    ];
    expect(layersFreshnessAt(batches, housings, mixed, '2026-05-01').oldestReported).toBe('2026-04-10');
  });
});

describe('animal history per-species chart scale', () => {
  it('computes each species y-axis maximum from that species only', () => {
    expect(animalHistoryScaleMax([5200, 4800, 3100])).toBe(5500);
    expect(animalHistoryScaleMax([42, 38, 45])).toBe(50);
    expect(animalHistoryScaleMax([601, 590])).toBe(700);
    expect(animalHistoryScaleMax([0, 0])).toBe(10);
    expect(animalHistoryScaleMax([])).toBe(10);
  });

  it('keeps broiler magnitudes out of the other species scales', () => {
    const rows = [
      {broilers: 5200, layers: 631, pigs: 210, cattle: 42, sheep: 88},
      {broilers: 4100, layers: 598, pigs: 195, cattle: 40, sheep: 91},
    ];
    const maxFor = (key) => animalHistoryScaleMax(rows.map((r) => r[key]));

    expect(maxFor('broilers')).toBe(5500);
    expect(maxFor('layers')).toBe(700);
    expect(maxFor('pigs')).toBe(250);
    expect(maxFor('cattle')).toBe(50);
    expect(maxFor('sheep')).toBe(100);
    // No non-broiler scale is dragged to the broiler magnitude.
    expect(maxFor('cattle')).toBeLessThan(maxFor('broilers') / 10);
  });
});
