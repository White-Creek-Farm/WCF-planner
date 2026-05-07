import {describe, it, expect} from 'vitest';
import {
  PLANNED_TRIP_MIN_SIZE,
  PLANNED_TRIP_MAX_SIZE,
  PLANNED_TRIP_TARGET_WEIGHT_LBS,
  PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
  sumFeedLbs,
  computeFeedPerPig,
  computeAvgWeight,
  computeGroupADG,
  seedGlobalADG,
  allocatePlannedTrips,
  movePigsBetweenTrips,
  recalculateProjections,
} from './pigForecast.js';

describe('constants', () => {
  it('exposes the trip-size and weight constants Codex locked', () => {
    expect(PLANNED_TRIP_MIN_SIZE).toBe(5);
    expect(PLANNED_TRIP_MAX_SIZE).toBe(12);
    expect(PLANNED_TRIP_TARGET_WEIGHT_LBS).toBe(275);
    expect(PLANNED_TRIP_OVER_WEIGHT_WARN_LBS).toBe(325);
  });
});

describe('sumFeedLbs', () => {
  it('sums feed_lbs across pig_dailys rows', () => {
    expect(
      sumFeedLbs([
        {date: '2026-04-01', feed_lbs: 100},
        {date: '2026-04-02', feed_lbs: 80},
      ]),
    ).toBe(180);
  });

  it('skips rows past the cutoff date', () => {
    expect(
      sumFeedLbs(
        [
          {date: '2026-04-01', feed_lbs: 100},
          {date: '2026-04-15', feed_lbs: 80},
          {date: '2026-04-30', feed_lbs: 60},
        ],
        '2026-04-15',
      ),
    ).toBe(180);
  });

  it('treats missing feed_lbs and bad rows as zero contributions', () => {
    expect(sumFeedLbs([{date: '2026-04-01', feed_lbs: 50}, {date: '2026-04-02'}, null, {feed_lbs: 999}])).toBe(50);
  });

  it('returns 0 for non-array input', () => {
    expect(sumFeedLbs(null)).toBe(0);
    expect(sumFeedLbs(undefined)).toBe(0);
    expect(sumFeedLbs([])).toBe(0);
  });
});

describe('computeFeedPerPig', () => {
  it('combines pig_dailys + legacyFeedLbs and divides by head count', () => {
    const out = computeFeedPerPig({
      pigDailys: [
        {date: '2026-04-01', feed_lbs: 200},
        {date: '2026-04-02', feed_lbs: 200},
      ],
      legacyFeedLbs: 100,
      cutoffDate: '2026-04-30',
      pigCount: 10,
    });
    expect(out).toBe(50); // (400 + 100) / 10
  });

  it('returns null when pigCount is 0 or missing', () => {
    expect(computeFeedPerPig({pigDailys: [], legacyFeedLbs: 0, pigCount: 0})).toBeNull();
    expect(computeFeedPerPig({pigDailys: [], legacyFeedLbs: 0, pigCount: -3})).toBeNull();
    expect(computeFeedPerPig({pigDailys: [], legacyFeedLbs: 0, pigCount: 'abc'})).toBeNull();
  });

  it('floors negative net feed at 0', () => {
    expect(computeFeedPerPig({pigDailys: [], legacyFeedLbs: -50, pigCount: 10})).toBe(0);
  });
});

describe('computeAvgWeight', () => {
  it('averages positive weights, ignoring missing/zero', () => {
    const out = computeAvgWeight([{weight: 250}, {weight: 280}, {weight: 0}, {weight: null}, null]);
    expect(out).toBe(265);
  });

  it('returns null on empty or all-invalid input', () => {
    expect(computeAvgWeight([])).toBeNull();
    expect(computeAvgWeight(null)).toBeNull();
    expect(computeAvgWeight([{weight: 0}, {weight: -10}, {weight: 'x'}])).toBeNull();
  });
});

describe('computeGroupADG', () => {
  it('returns lb/day between two sessions', () => {
    const adg = computeGroupADG({date: '2026-05-01', avgWeightLbs: 250}, {date: '2026-04-01', avgWeightLbs: 200});
    // 50 lb over 30 days = 1.666... lb/day
    expect(adg).toBeCloseTo(50 / 30, 6);
  });

  it('returns null when prior session is missing', () => {
    expect(computeGroupADG({date: '2026-05-01', avgWeightLbs: 250}, null)).toBeNull();
  });

  it('returns null when same date (zero days)', () => {
    expect(
      computeGroupADG({date: '2026-05-01', avgWeightLbs: 250}, {date: '2026-05-01', avgWeightLbs: 240}),
    ).toBeNull();
  });

  it('returns null when either session has missing avgWeight', () => {
    expect(computeGroupADG({date: '2026-05-01'}, {date: '2026-04-01', avgWeightLbs: 200})).toBeNull();
  });

  it('handles negative ADG (weight loss) without filtering', () => {
    const adg = computeGroupADG({date: '2026-05-01', avgWeightLbs: 240}, {date: '2026-04-01', avgWeightLbs: 250});
    expect(adg).toBeCloseTo(-10 / 30, 6);
  });
});

describe('seedGlobalADG', () => {
  it('returns null with no usable sessions', () => {
    expect(seedGlobalADG(null)).toBeNull();
    expect(seedGlobalADG([])).toBeNull();
    expect(seedGlobalADG([{ageDays: 0, avgWeightLbs: 100}])).toBeNull();
  });

  it('fits a slope-through-origin from age-vs-weight data points', () => {
    // Two perfectly linear points: weight = 1.5 * age
    const out = seedGlobalADG([
      {ageDays: 100, avgWeightLbs: 150},
      {ageDays: 200, avgWeightLbs: 300},
    ]);
    expect(out.valueLbsPerDay).toBeCloseTo(1.5, 6);
    expect(out.sampleCount).toBe(2);
  });

  it('skips invalid rows but still uses the rest', () => {
    const out = seedGlobalADG([
      {ageDays: 100, avgWeightLbs: 200},
      {ageDays: -5, avgWeightLbs: 50}, // skipped
      {ageDays: 200, avgWeightLbs: 0}, // skipped
      null,
    ]);
    expect(out.sampleCount).toBe(1);
    expect(out.valueLbsPerDay).toBeCloseTo(2, 6);
  });
});

describe('allocatePlannedTrips', () => {
  // Deterministic id factory so tests are stable.
  const ids = (() => {
    let n = 0;
    return () => `t${++n}`;
  })();

  it('returns [] when remainingCount <= 0', () => {
    expect(
      allocatePlannedTrips({
        remainingCount: 0,
        sex: 'gilt',
        subBatchId: 'sub-1',
        startDate: '2026-06-01',
        idFactory: ids,
      }),
    ).toEqual([]);
  });

  it('returns [] when startDate is missing', () => {
    expect(allocatePlannedTrips({remainingCount: 10, sex: 'gilt', subBatchId: 'sub-1', idFactory: ids})).toEqual([]);
  });

  it('one trip when count fits in maxSize', () => {
    const trips = allocatePlannedTrips({
      remainingCount: 8,
      sex: 'gilt',
      subBatchId: 'sub-1',
      startDate: '2026-06-01',
      idFactory: ids,
    });
    expect(trips).toHaveLength(1);
    expect(trips[0].plannedCount).toBe(8);
    expect(trips[0].date).toBe('2026-06-01');
    expect(trips[0].sex).toBe('gilt');
    expect(trips[0].subBatchId).toBe('sub-1');
    expect(trips[0].order).toBe(0);
  });

  it('splits over maxSize and distributes the remainder to the earliest trips', () => {
    const trips = allocatePlannedTrips({
      remainingCount: 26,
      sex: 'boar',
      subBatchId: 'sub-2',
      startDate: '2026-06-01',
      tripSpacingDays: 7,
      idFactory: ids,
    });
    // 26 / 12 = 3 trips; base 8 + remainder 2 → [9, 9, 8]
    expect(trips.map((t) => t.plannedCount)).toEqual([9, 9, 8]);
    expect(trips.map((t) => t.date)).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
    expect(trips.map((t) => t.order)).toEqual([0, 1, 2]);
    expect(trips.every((t) => t.sex === 'boar' && t.subBatchId === 'sub-2')).toBe(true);
  });

  it('keeps a smaller-than-min final trip rather than rejecting it (warning happens later)', () => {
    const trips = allocatePlannedTrips({
      remainingCount: 14,
      sex: 'gilt',
      subBatchId: 'sub-3',
      startDate: '2026-06-01',
      idFactory: ids,
    });
    // 14 / 12 = 2 trips; base 7 + 0 remainder → [7, 7] — both above min
    expect(trips.map((t) => t.plannedCount)).toEqual([7, 7]);
  });

  it('returns the persistable shape only (no projection fields)', () => {
    const trips = allocatePlannedTrips({
      remainingCount: 5,
      sex: 'gilt',
      subBatchId: 'sub-1',
      startDate: '2026-06-01',
      idFactory: ids,
    });
    expect(Object.keys(trips[0]).sort()).toEqual(['date', 'id', 'order', 'plannedCount', 'sex', 'subBatchId'].sort());
  });
});

describe('movePigsBetweenTrips', () => {
  const trips = [
    {id: 't1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 0},
    {id: 't2', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 1},
    {id: 't3', date: '2026-06-29', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 4, order: 2},
  ];

  it('moves count from from→to and leaves other trips alone', () => {
    const r = movePigsBetweenTrips(trips, 't1', 't2', 2);
    expect(r.error).toBeUndefined();
    expect(r.trips.find((t) => t.id === 't1').plannedCount).toBe(6);
    expect(r.trips.find((t) => t.id === 't2').plannedCount).toBe(10);
    expect(r.trips.find((t) => t.id === 't3').plannedCount).toBe(4);
  });

  it('returns immutably (does not mutate the source)', () => {
    movePigsBetweenTrips(trips, 't1', 't2', 2);
    expect(trips[0].plannedCount).toBe(8);
    expect(trips[1].plannedCount).toBe(8);
  });

  it('rejects count > source plannedCount', () => {
    const r = movePigsBetweenTrips(trips, 't3', 't1', 5);
    expect(r.trips).toBeUndefined();
    expect(r.error).toMatch(/exceeds source plannedCount/);
  });

  it('rejects same trip move and zero/negative count', () => {
    expect(movePigsBetweenTrips(trips, 't1', 't1', 1).error).toMatch(/must differ/);
    expect(movePigsBetweenTrips(trips, 't1', 't2', 0).error).toMatch(/positive integer/);
    expect(movePigsBetweenTrips(trips, 't1', 't2', -3).error).toMatch(/positive integer/);
  });

  it('rejects unknown trip ids', () => {
    expect(movePigsBetweenTrips(trips, 'nope', 't1', 1).error).toMatch(/fromTripId/);
    expect(movePigsBetweenTrips(trips, 't1', 'nope', 1).error).toMatch(/toTripId/);
  });

  it('rejects cross-sex / cross-subgroup moves', () => {
    const cross = [
      {id: 'a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0},
      {id: 'b', date: '2026-06-15', sex: 'boar', subBatchId: 'sub-1', plannedCount: 5, order: 1},
    ];
    expect(movePigsBetweenTrips(cross, 'a', 'b', 1).error).toMatch(/sex and subBatchId/);
    const crossSub = [
      {id: 'a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0},
      {id: 'b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-2', plannedCount: 5, order: 1},
    ];
    expect(movePigsBetweenTrips(crossSub, 'a', 'b', 1).error).toMatch(/sex and subBatchId/);
  });
});

describe('recalculateProjections', () => {
  const baseTrips = [
    // Out-of-order on purpose to verify internal sort.
    {id: 't2', date: '2026-07-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 4, order: 1},
    {id: 't1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0},
  ];
  // 9 entries sorted desc: top 5 → trip 1, next 4 → trip 2.
  const entries = [
    {weight: 260},
    {weight: 255},
    {weight: 250},
    {weight: 245},
    {weight: 240},
    {weight: 235},
    {weight: 230},
    {weight: 225},
    {weight: 220},
  ];

  it('rank-windows entries to trips after sorting by date', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
    });
    expect(out[0].id).toBe('t1');
    expect(out[1].id).toBe('t2');
    expect(out[0].daysUntil).toBe(17);
    expect(out[1].daysUntil).toBe(47);
    // t1 takes top 5 (260…240), avg=250, +1.5*17=25.5 → 275.5
    expect(out[0].projectedAvgLbs).toBeCloseTo(275.5, 6);
    expect(out[0].projectedMinLbs).toBeCloseTo(240 + 25.5, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(260 + 25.5, 6);
    expect(out[0].ready).toBe(true);
    // t2 takes next 4 (235…220), avg=227.5, +1.5*47=70.5 → 298
    expect(out[1].projectedAvgLbs).toBeCloseTo(298, 6);
    expect(out[1].ready).toBe(true);
  });

  it('returns null projections when no global ADG is available', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: null,
    });
    expect(out[0].projectedAvgLbs).toBeNull();
    expect(out[0].projectedMinLbs).toBeNull();
    expect(out[0].projectedMaxLbs).toBeNull();
    expect(out[0].ready).toBe(false);
  });

  it('returns null projections in pre-weigh-in mode when no cycle age is provided', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: [],
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
    });
    expect(out[0].projectedAvgLbs).toBeNull();
    expect(out[1].projectedAvgLbs).toBeNull();
  });

  it('uses cycle age + ADG to project anonymous slots when no weights exist yet', () => {
    // Pre-weigh-in mode: no latestEntries, but the linked cycle gives an
    // age window of 60-90 days at the reference date. ADG 1.5 lb/day.
    const out = recalculateProjections(baseTrips, {
      latestEntries: [],
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
      cycleAgeDaysAtRef: {minDays: 60, maxDays: 90},
    });
    // t1 is 17 days out → ages become 77 / 107 days → weights 115.5 / 160.5
    expect(out[0].id).toBe('t1');
    expect(out[0].projectedMinLbs).toBeCloseTo(77 * 1.5, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(107 * 1.5, 6);
    expect(out[0].projectedAvgLbs).toBeCloseTo((77 * 1.5 + 107 * 1.5) / 2, 6);
    // t2 is 47 days out → ages become 107 / 137 days → weights 160.5 / 205.5
    expect(out[1].id).toBe('t2');
    expect(out[1].projectedMinLbs).toBeCloseTo(107 * 1.5, 6);
    expect(out[1].projectedMaxLbs).toBeCloseTo(137 * 1.5, 6);
  });

  it('ignores cycle age when latest weights exist (rank-window mode wins)', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
      cycleAgeDaysAtRef: {minDays: 60, maxDays: 90},
    });
    // Same as the rank-window test — cycle age must NOT shift the result.
    expect(out[0].projectedAvgLbs).toBeCloseTo(275.5, 6);
    expect(out[0].projectedMinLbs).toBeCloseTo(240 + 25.5, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(260 + 25.5, 6);
  });

  it('returns null projections in pre-weigh-in mode when cycle age is malformed', () => {
    const cases = [
      {minDays: -1, maxDays: 30},
      {minDays: 0, maxDays: -5},
      {minDays: 'abc', maxDays: 30},
      {minDays: NaN, maxDays: 30},
      null,
    ];
    for (const cycleAge of cases) {
      const out = recalculateProjections(baseTrips, {
        latestEntries: [],
        referenceDate: '2026-05-15',
        globalAdgLbsPerDay: 1.5,
        cycleAgeDaysAtRef: cycleAge,
      });
      expect(out[0].projectedAvgLbs).toBeNull();
      expect(out[1].projectedAvgLbs).toBeNull();
    }
  });

  it('returns null projections when ADG is missing even if cycle age is valid', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: [],
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: null,
      cycleAgeDaysAtRef: {minDays: 60, maxDays: 90},
    });
    expect(out[0].projectedAvgLbs).toBeNull();
    expect(out[1].projectedAvgLbs).toBeNull();
  });

  it('flags undersized trips with the "undersized" warning', () => {
    const tripsWithSmall = [{id: 'a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 3, order: 0}];
    const out = recalculateProjections(tripsWithSmall, {
      latestEntries: [{weight: 250}, {weight: 245}, {weight: 240}],
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1,
    });
    expect(out[0].warnings).toContain('undersized');
  });

  it('flags overweight projected trips', () => {
    const out = recalculateProjections(
      [{id: 'a', date: '2026-09-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0}],
      {
        latestEntries: [{weight: 280}, {weight: 275}, {weight: 270}, {weight: 265}, {weight: 260}],
        referenceDate: '2026-05-15',
        globalAdgLbsPerDay: 0.5,
      },
    );
    // 109 days × 0.5 = +54.5; sliceMax 280 → 334.5 > 325
    expect(out[0].projectedMaxLbs).toBeGreaterThan(PLANNED_TRIP_OVER_WEIGHT_WARN_LBS);
    expect(out[0].warnings).toContain('overweight');
  });

  it('falls back to null projection for trips beyond the available entry stack', () => {
    const trips = [
      {id: 'a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0},
      {id: 'b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 1},
    ];
    // Only 5 entries — trip a takes them all, trip b gets none.
    const out = recalculateProjections(trips, {
      latestEntries: [{weight: 240}, {weight: 235}, {weight: 230}, {weight: 225}, {weight: 220}],
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1,
    });
    expect(out[0].projectedAvgLbs).not.toBeNull();
    expect(out[1].projectedAvgLbs).toBeNull();
  });

  it('preserves the persistable fields on every returned trip', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
    });
    for (const t of out) {
      expect(t).toMatchObject({
        id: expect.any(String),
        date: expect.any(String),
        sex: expect.any(String),
        subBatchId: expect.any(String),
        plannedCount: expect.any(Number),
        order: expect.any(Number),
      });
    }
  });
});
