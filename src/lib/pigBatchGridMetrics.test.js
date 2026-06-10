import {describe, expect, it} from 'vitest';

import {buildPigBatchGridMetrics} from './pigBatchGridMetrics.js';

function dailyLookup(rowsByName) {
  return (name) => rowsByName[name] || [];
}

describe('buildPigBatchGridMetrics', () => {
  it('forces processed parent-only batches to display zero current head on the hub', () => {
    const metrics = buildPigBatchGridMetrics(
      {
        id: 'p-26',
        batchName: 'P-26-02',
        status: 'processed',
        giltCount: 7,
        boarCount: 3,
        subBatches: [],
        processingTrips: [],
        pigMortalities: [],
      },
      {
        breeders: [],
        dailysForName: dailyLookup({
          'P-26-02': [{date: '2026-01-01', feed_lbs: 100, pig_count: 10}],
        }),
      },
    );

    expect(metrics.started).toBe(10);
    expect(metrics.current).toBe(0);
    expect(metrics.feedPerPig).toBe(10);
    expect(metrics.gilts.current).toBe(0);
    expect(metrics.boars.current).toBe(0);
    expect(metrics.gilts.totalFeedLbs).toBe(70);
    expect(metrics.boars.totalFeedLbs).toBe(30);
    // The 70/30 feed split is a started-head allocation (mixed batch, no sex
    // attribution in the source rows); the forced 0 current is exact.
    expect(metrics.gilts.feedEstimated).toBe(true);
    expect(metrics.boars.feedEstimated).toBe(true);
    expect(metrics.gilts.currentEstimated).toBe(false);
    expect(metrics.boars.currentEstimated).toBe(false);
    expect(metrics.hasEstimates).toBe(true);
  });

  it('expands sub-batch chips into sex-specific started/current/feed columns', () => {
    const metrics = buildPigBatchGridMetrics(
      {
        id: 'p-27',
        batchName: 'P-27-01',
        status: 'active',
        giltCount: 8,
        boarCount: 4,
        legacyFeedLbs: 120,
        subBatches: [
          {id: 'g', name: 'P-27-01 Gilts', status: 'active', giltCount: 8, boarCount: 0},
          {id: 'b', name: 'P-27-01 Boars', status: 'active', giltCount: 0, boarCount: 4},
        ],
        processingTrips: [],
        pigMortalities: [],
      },
      {
        breeders: [],
        dailysForName: dailyLookup({
          'P-27-01 Gilts': [{date: '2026-02-01', feed_lbs: 80, pig_count: 8}],
          'P-27-01 Boars': [{date: '2026-02-01', feed_lbs: 40, pig_count: 4}],
        }),
      },
    );

    expect(metrics.started).toBe(12);
    expect(metrics.current).toBe(12);
    expect(metrics.totalFeedLbs).toBe(240);
    expect(metrics.feedPerPig).toBe(20);
    expect(metrics.gilts).toMatchObject({started: 8, current: 8, totalFeedLbs: 160, feedPerPig: 20});
    expect(metrics.boars).toMatchObject({started: 4, current: 4, totalFeedLbs: 80, feedPerPig: 20});
    // Single-sex sub values are exact, but the parent-level legacy feed (120)
    // had no sex attribution, so its 80/40 allocation marks feed estimated.
    expect(metrics.gilts.currentEstimated).toBe(false);
    expect(metrics.boars.currentEstimated).toBe(false);
    expect(metrics.gilts.feedEstimated).toBe(true);
    expect(metrics.boars.feedEstimated).toBe(true);
    expect(metrics.hasEstimates).toBe(true);
  });

  it('marks mixed parent-only batch sex splits as started-head estimates', () => {
    const metrics = buildPigBatchGridMetrics(
      {
        id: 'p-26-02',
        batchName: 'P-26-02',
        status: 'active',
        giltCount: 12,
        boarCount: 8,
        originalPigCount: 20,
        subBatches: [],
        processingTrips: [],
        pigMortalities: [],
      },
      {
        breeders: [],
        dailysForName: dailyLookup({
          'P-26-02': [{date: '2026-03-01', feed_lbs: 5000, pig_count: 20}],
        }),
      },
    );

    expect(metrics.gilts).toMatchObject({started: 12, current: 12, totalFeedLbs: 3000});
    expect(metrics.boars).toMatchObject({started: 8, current: 8, totalFeedLbs: 2000});
    expect(metrics.gilts.currentEstimated).toBe(true);
    expect(metrics.boars.currentEstimated).toBe(true);
    expect(metrics.gilts.feedEstimated).toBe(true);
    expect(metrics.boars.feedEstimated).toBe(true);
    expect(metrics.hasEstimates).toBe(true);
  });

  it('leaves single-sex parent-only batches unmarked — whole-batch values are exact', () => {
    const metrics = buildPigBatchGridMetrics(
      {
        id: 'p-27-02',
        batchName: 'P-27-02',
        status: 'active',
        giltCount: 10,
        boarCount: 0,
        originalPigCount: 10,
        subBatches: [],
        processingTrips: [],
        pigMortalities: [],
      },
      {
        breeders: [],
        dailysForName: dailyLookup({
          'P-27-02': [{date: '2026-03-01', feed_lbs: 900, pig_count: 10}],
        }),
      },
    );

    expect(metrics.gilts).toMatchObject({started: 10, current: 10, totalFeedLbs: 900, feedPerPig: 90});
    expect(metrics.boars.current).toBe(null);
    expect(metrics.boars.totalFeedLbs).toBe(0);
    expect(metrics.gilts.currentEstimated).toBe(false);
    expect(metrics.gilts.feedEstimated).toBe(false);
    expect(metrics.hasEstimates).toBe(false);
  });
});
