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
  findPriorPigWeighInSession,
  computeRankMatchedPigEntryADG,
  computeRankMatchedPigGroupADG,
  seedGlobalADG,
  buildFarrowingAgeDistribution,
  projectFarrowingAgeWindow,
  allocatePlannedTrips,
  movePigsBetweenTrips,
  recalculateProjections,
  addPlannedTrip,
  deletePlannedTripWithReconciliation,
  deleteReconciliationRecipient,
  reconcilePlannedTripsForSend,
  formatAgeRange,
  formatFeedPerPig,
  formatGroupAdg,
  formatAvgWeight,
} from './pigForecast.js';

describe('constants', () => {
  it('exposes the trip-size and weight constants Codex locked', () => {
    expect(PLANNED_TRIP_MIN_SIZE).toBe(5);
    expect(PLANNED_TRIP_MAX_SIZE).toBe(12);
    expect(PLANNED_TRIP_TARGET_WEIGHT_LBS).toBe(275);
    expect(PLANNED_TRIP_OVER_WEIGHT_WARN_LBS).toBe(325);
  });
});

describe('formatAgeRange', () => {
  it('renders both bounds with daysToMWD when hasActual=true', () => {
    expect(formatAgeRange({minDays: 60, maxDays: 90, hasActual: true})).toBe('2m 0w – 3m 0w');
  });

  it('appends "(est.)" when hasActual=false', () => {
    expect(formatAgeRange({minDays: 60, maxDays: 90, hasActual: false})).toBe('2m 0w – 3m 0w (est.)');
  });

  it('uses 0m 0w for zero-day bounds (Up-to-oldest case)', () => {
    expect(formatAgeRange({minDays: 0, maxDays: 14, hasActual: true})).toBe('0m 0w – 0m 2w');
  });

  it('returns "—" when either bound is null/undefined', () => {
    expect(formatAgeRange({minDays: null, maxDays: 30, hasActual: true})).toBe('—');
    expect(formatAgeRange({minDays: 30, maxDays: null, hasActual: true})).toBe('—');
    expect(formatAgeRange({})).toBe('—');
    expect(formatAgeRange()).toBe('—');
  });

  it('returns "—" for non-numeric bounds (defensive)', () => {
    expect(formatAgeRange({minDays: 'abc', maxDays: 30, hasActual: true})).toBe('—');
  });
});

describe('formatFeedPerPig', () => {
  it('rounds to nearest lb', () => {
    expect(formatFeedPerPig(416.4)).toBe('416 lb');
    expect(formatFeedPerPig(416.6)).toBe('417 lb');
    expect(formatFeedPerPig(0)).toBe('0 lb');
  });

  it('returns "—" for null / NaN / non-numeric', () => {
    expect(formatFeedPerPig(null)).toBe('—');
    expect(formatFeedPerPig(undefined)).toBe('—');
    expect(formatFeedPerPig(NaN)).toBe('—');
    expect(formatFeedPerPig('abc')).toBe('—');
  });
});

describe('formatGroupAdg', () => {
  it('shows positive ADG with leading + sign and two decimals', () => {
    expect(formatGroupAdg(1.82)).toBe('+1.82 lb/day');
    expect(formatGroupAdg(0.5)).toBe('+0.50 lb/day');
  });

  it('shows negative ADG with ASCII hyphen-minus and absolute value (Codex W6 lock)', () => {
    expect(formatGroupAdg(-0.5)).toBe('-0.50 lb/day');
    expect(formatGroupAdg(-1.82)).toBe('-1.82 lb/day');
    // Negative lock: never use Unicode minus (U+2212) per Codex's correction.
    expect(formatGroupAdg(-1)).not.toContain('−');
  });

  it('shows zero ADG without sign as 0.00 lb/day', () => {
    expect(formatGroupAdg(0)).toBe('0.00 lb/day');
    // Sub-rounding values that round to zero stay at 0.00 (no sign).
    expect(formatGroupAdg(0.001)).toBe('0.00 lb/day');
    expect(formatGroupAdg(-0.001)).toBe('0.00 lb/day');
  });

  it('returns "— no prior weigh-in" when ADG is null/missing', () => {
    expect(formatGroupAdg(null)).toBe('— no prior weigh-in');
    expect(formatGroupAdg(undefined)).toBe('— no prior weigh-in');
    expect(formatGroupAdg(NaN)).toBe('— no prior weigh-in');
  });
});

describe('formatAvgWeight', () => {
  it('rounds to nearest lb', () => {
    expect(formatAvgWeight(263)).toBe('263 lb');
    expect(formatAvgWeight(262.6)).toBe('263 lb');
    expect(formatAvgWeight(262.4)).toBe('262 lb');
  });

  it('returns "—" for null / NaN', () => {
    expect(formatAvgWeight(null)).toBe('—');
    expect(formatAvgWeight(undefined)).toBe('—');
    expect(formatAvgWeight(NaN)).toBe('—');
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

describe('findPriorPigWeighInSession', () => {
  it('finds the newest earlier pig session for the same batch slug', () => {
    const current = {id: 'cur', species: 'pig', batch_id: 'P-26-01 A', date: '2026-05-20'};
    const sessions = [
      current,
      {id: 'older', species: 'pig', batch_id: 'p-26-01-a', date: '2026-04-01', started_at: '2026-04-01T08:00:00'},
      {id: 'prior', species: 'pig', batch_id: 'P 26 01 A', date: '2026-05-01', started_at: '2026-05-01T09:00:00'},
      {id: 'other', species: 'pig', batch_id: 'P-26-01-B', date: '2026-05-15'},
      {id: 'future', species: 'pig', batch_id: 'P-26-01-A', date: '2026-05-21'},
    ];
    expect(findPriorPigWeighInSession(current, sessions).id).toBe('prior');
  });

  it('breaks same-date prior candidates by started_at descending', () => {
    const current = {id: 'cur', species: 'pig', batch_id: 'A', date: '2026-05-20'};
    const sessions = [
      {id: 'am', species: 'pig', batch_id: 'A', date: '2026-05-01', started_at: '2026-05-01T08:00:00'},
      {id: 'pm', species: 'pig', batch_id: 'A', date: '2026-05-01', started_at: '2026-05-01T15:00:00'},
    ];
    expect(findPriorPigWeighInSession(current, sessions).id).toBe('pm');
  });
});

describe('computeRankMatchedPigEntryADG', () => {
  it('pairs current and prior pig weights by ASC rank and returns entry-level ADG', () => {
    const out = computeRankMatchedPigEntryADG(
      [
        {id: 'heavy', weight: 260},
        {id: 'light', weight: 220},
        {id: 'mid', weight: 240},
      ],
      [
        {id: 'p-heavy', weight: 230},
        {id: 'p-light', weight: 200},
        {id: 'p-mid', weight: 215},
      ],
      '2026-05-31',
      '2026-05-01',
    );
    expect(out.map((x) => x.entryId)).toEqual(['light', 'mid', 'heavy']);
    expect(out[0]).toMatchObject({
      rank: 1,
      currentWeightLbs: 220,
      priorWeightLbs: 200,
      daysBetween: 30,
      weightDeltaLbs: 20,
    });
    expect(out[0].adgLbsPerDay).toBeCloseTo(20 / 30, 6);
    expect(out[2].weightDeltaLbs).toBe(30);
    expect(out[2].adgLbsPerDay).toBeCloseTo(30 / 30, 6);
  });

  it('only returns matched ranks and ignores invalid weights', () => {
    const out = computeRankMatchedPigEntryADG(
      [
        {id: 'a', weight: 210},
        {id: 'bad', weight: 0},
        {id: 'b', weight: 230},
      ],
      [{id: 'p-a', weight: 190}],
      '2026-05-11',
      '2026-05-01',
    );
    expect(out).toHaveLength(1);
    expect(out[0].entryId).toBe('a');
    expect(
      computeRankMatchedPigEntryADG([{id: 'a', weight: 210}], [{id: 'p', weight: 190}], '2026-05-01', '2026-05-01'),
    ).toEqual([]);
  });
});

describe('computeRankMatchedPigGroupADG', () => {
  it('averages rank-matched entry ADG values', () => {
    const out = computeRankMatchedPigGroupADG(
      [
        {id: 'a', weight: 220},
        {id: 'b', weight: 250},
      ],
      [
        {id: 'pa', weight: 200},
        {id: 'pb', weight: 220},
      ],
      '2026-05-31',
      '2026-05-01',
    );
    expect(out).toBeCloseTo((20 / 30 + 30 / 30) / 2, 6);
  });

  it('returns null when there are no matched ranks', () => {
    expect(computeRankMatchedPigGroupADG([{id: 'a', weight: 220}], [], '2026-05-31', '2026-05-01')).toBeNull();
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

describe('farrowing-weighted age windows', () => {
  const cycle = {id: 'c1', group: '1', exposureStart: '2025-09-07'};
  const farrowingRecs = [
    {id: 'f1', group: '1', farrowingDate: '2026-01-01', alive: 3},
    {id: 'f2', group: '1', farrowingDate: '2026-01-09', alive: 24},
    {id: 'f3', group: '1', farrowingDate: '2026-01-17', alive: 3},
  ];

  it('builds age buckets from real farrowing counts, oldest first', () => {
    const dist = buildFarrowingAgeDistribution({
      cycleId: 'c1',
      asOfDate: '2026-06-01',
      breedingCycles: [cycle],
      farrowingRecs,
    });
    expect(dist.source).toBe('farrowing-weighted');
    expect(dist.totalWeight).toBe(30);
    expect(dist.buckets).toEqual([
      {ageDays: 151, weight: 3},
      {ageDays: 143, weight: 24},
      {ageDays: 135, weight: 3},
    ]);
  });

  it('slices the skewed 21-gilt example by farrowing-count weighted rank windows', () => {
    const dist = buildFarrowingAgeDistribution({
      cycleId: 'c1',
      asOfDate: '2026-06-01',
      breedingCycles: [cycle],
      farrowingRecs,
    });
    const g1 = projectFarrowingAgeWindow(dist, {populationCount: 21, rankOffset: 0, windowCount: 11});
    const g2 = projectFarrowingAgeWindow(dist, {populationCount: 21, rankOffset: 11, windowCount: 10});
    expect(g1).toMatchObject({minDays: 143, maxDays: 151, hasActual: true});
    expect(g1.avgDays).toBeCloseTo(144.53, 2);
    expect(g2).toMatchObject({minDays: 135, maxDays: 143, hasActual: true});
    expect(g2.avgDays).toBeCloseTo(141.32, 2);
  });

  it('keeps a one-trip population as the full known band rather than a midpoint', () => {
    const dist = buildFarrowingAgeDistribution({
      cycleId: 'c1',
      asOfDate: '2026-06-01',
      breedingCycles: [cycle],
      farrowingRecs,
    });
    const onlyTrip = projectFarrowingAgeWindow(dist, {populationCount: 1, rankOffset: 0, windowCount: 1});
    expect(onlyTrip.minDays).toBe(135);
    expect(onlyTrip.maxDays).toBe(151);
    expect(onlyTrip.avgDays).toBeCloseTo(143, 6);
  });

  it('falls back to an estimated full cycle band when farrowing counts are absent', () => {
    const dist = buildFarrowingAgeDistribution({
      cycleId: 'c1',
      asOfDate: '2026-06-01',
      breedingCycles: [cycle],
      farrowingRecs: [],
      cycleAgeDaysAtRef: {minDays: 135, maxDays: 151},
    });
    const window = projectFarrowingAgeWindow(dist, {populationCount: 21, rankOffset: 11, windowCount: 10});
    expect(window).toEqual({
      source: 'estimated-cycle-band',
      hasActual: false,
      minDays: 135,
      maxDays: 151,
      avgDays: 143,
    });
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
  const weightedAgeDistributionAtRef = {
    source: 'farrowing-weighted',
    buckets: [
      {ageDays: 151, weight: 3},
      {ageDays: 143, weight: 24},
      {ageDays: 135, weight: 3},
    ],
    totalWeight: 30,
  };

  it('rank-windows farrowing-weighted ages to trips after sorting by date', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-06-01',
      globalAdgLbsPerDay: 1.5,
      ageDistributionAtRef: weightedAgeDistributionAtRef,
      populationCount: 9,
    });
    expect(out[0].id).toBe('t1');
    expect(out[1].id).toBe('t2');
    expect(out[0].daysUntil).toBe(0);
    expect(out[1].daysUntil).toBe(30);
    expect(out[0].projectedMinLbs).toBeCloseTo(143 * 1.5, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(151 * 1.5, 6);
    expect(out[0].projectionSource).toBe('farrowing-weighted');
    expect(out[0].projectionHasActualFarrowing).toBe(true);
    expect(out[1].projectedMinLbs).toBeCloseTo((135 + 30) * 1.5, 6);
    expect(out[1].projectedMaxLbs).toBeCloseTo((143 + 30) * 1.5, 6);
  });

  it('processed trips come off the top of the age stack before remaining planned trips', () => {
    const out = recalculateProjections(
      [{id: 'remaining', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 10, order: 0}],
      {
        referenceDate: '2026-06-01',
        globalAdgLbsPerDay: 1.6,
        ageDistributionAtRef: weightedAgeDistributionAtRef,
        populationCount: 21,
        alreadyShippedCount: 11,
      },
    );
    expect(out[0].projectedMinLbs).toBeCloseTo(135 * 1.6, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(143 * 1.6, 6);
  });

  it('ignores latestEntriesDate because weigh-ins do not move planned forecasts', () => {
    const out = recalculateProjections(
      [{id: 'a', date: '2026-06-17', sex: 'boar', subBatchId: 'sub-2', plannedCount: 2, order: 0}],
      {
        latestEntries: [{weight: 270}, {weight: 230}],
        latestEntriesDate: '2026-05-19',
        referenceDate: '2026-06-04',
        globalAdgLbsPerDay: 1.14,
        cycleAgeDaysAtRef: {minDays: 135, maxDays: 151},
      },
    );
    expect(out[0].daysUntil).toBe(13);
    expect(out[0].projectedMinLbs).toBeCloseTo((135 + 13) * 1.14, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo((151 + 13) * 1.14, 6);
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

  it('uses cycle age even when latest weights are passed', () => {
    const out = recalculateProjections(baseTrips, {
      latestEntries: entries,
      referenceDate: '2026-05-15',
      globalAdgLbsPerDay: 1.5,
      cycleAgeDaysAtRef: {minDays: 60, maxDays: 90},
    });
    expect(out[0].projectedAvgLbs).toBeCloseTo((77 * 1.5 + 107 * 1.5) / 2, 6);
    expect(out[0].projectedMinLbs).toBeCloseTo(77 * 1.5, 6);
    expect(out[0].projectedMaxLbs).toBeCloseTo(107 * 1.5, 6);
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
        globalAdgLbsPerDay: 1,
        cycleAgeDaysAtRef: {minDays: 180, maxDays: 220},
      },
    );
    expect(out[0].projectedMaxLbs).toBeGreaterThan(PLANNED_TRIP_OVER_WEIGHT_WARN_LBS);
    expect(out[0].warnings).toContain('overweight');
  });

  it('falls back to null projection for trips beyond the remaining forecast population', () => {
    const trips = [
      {id: 'a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 0},
      {id: 'b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 5, order: 1},
    ];
    const out = recalculateProjections(trips, {
      referenceDate: '2026-06-01',
      globalAdgLbsPerDay: 1.5,
      ageDistributionAtRef: weightedAgeDistributionAtRef,
      populationCount: 5,
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

describe('addPlannedTrip', () => {
  const baseChain = [
    {id: 't-a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 0},
    {id: 't-b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 1},
    {id: 't-c', date: '2026-06-10', sex: 'boar', subBatchId: 'sub-1', plannedCount: 8, order: 0},
  ];

  it('on empty chain: positive-count Add establishes the first trip; order starts at 0', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    const r = addPlannedTrip([], {
      subBatchId: 'sub-9',
      sex: 'boar',
      date: '2026-07-01',
      plannedCount: 5,
      idFactory: ids,
    });
    expect(r.error).toBeUndefined();
    expect(r.trips[0]).toEqual({
      id: 'new-1',
      date: '2026-07-01',
      sex: 'gilt' === r.trips[0].sex ? 'gilt' : 'boar',
      subBatchId: 'sub-9',
      plannedCount: 5,
      order: 0,
    });
  });

  it('on existing chain with positive count: preserves chain total by drawing from a single source trip', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    // chain has gilt trips with plannedCount [12, 12]; total 24. Add 5 dated AFTER both → draws from PREVIOUS (last existing).
    const r = addPlannedTrip(baseChain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-07-01',
      plannedCount: 5,
      idFactory: ids,
    });
    expect(r.error).toBeUndefined();
    const giltTotal = r.trips
      .filter((t) => t.subBatchId === 'sub-1' && t.sex === 'gilt')
      .reduce((s, t) => s + (t.plannedCount || 0), 0);
    expect(giltTotal).toBe(24);
    // Source was t-b (the last existing): plannedCount went 12 → 7.
    expect(r.trips.find((t) => t.id === 't-b').plannedCount).toBe(7);
    // The new trip carries the requested count.
    expect(r.trips[r.trips.length - 1]).toMatchObject({plannedCount: 5, order: 2});
  });

  it('new date BEFORE first existing trip: draws from the NEXT (first) trip', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    const r = addPlannedTrip(baseChain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-05-01',
      plannedCount: 4,
      idFactory: ids,
    });
    expect(r.error).toBeUndefined();
    expect(r.trips.find((t) => t.id === 't-a').plannedCount).toBe(12 - 4);
    expect(r.trips.find((t) => t.id === 't-b').plannedCount).toBe(12);
  });

  it('new date BETWEEN existing trips: prefers PREVIOUS, falls back to NEXT when prev lacks count', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    // Insert between t-a and t-b. First try a count prev can supply.
    const r1 = addPlannedTrip(baseChain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-06-08',
      plannedCount: 3,
      idFactory: ids,
    });
    expect(r1.error).toBeUndefined();
    expect(r1.trips.find((t) => t.id === 't-a').plannedCount).toBe(12 - 3);
    expect(r1.trips.find((t) => t.id === 't-b').plannedCount).toBe(12);

    // Now try a count larger than prev's plannedCount — falls back to next.
    const skewedChain = [
      {id: 't-a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 2, order: 0},
      {id: 't-b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 1},
    ];
    const r2 = addPlannedTrip(skewedChain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-06-08',
      plannedCount: 5,
      idFactory: ids,
    });
    expect(r2.error).toBeUndefined();
    // prev had only 2 — fall back to next (t-b): 12 → 7.
    expect(r2.trips.find((t) => t.id === 't-a').plannedCount).toBe(2);
    expect(r2.trips.find((t) => t.id === 't-b').plannedCount).toBe(12 - 5);
  });

  it('refuses positive-count Add when no source trip in the chain has enough plannedCount', () => {
    const tiny = [
      {id: 't-a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 3, order: 0},
      {id: 't-b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 4, order: 1},
    ];
    let n = 0;
    const ids = () => 'new-' + ++n;
    const r = addPlannedTrip(tiny, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-07-01',
      plannedCount: 10,
      idFactory: ids,
    });
    expect(r.error).toMatch(/Cannot draw the requested count/);
  });

  it('0-count Add is allowed even on an existing chain (placeholder for later count-moves)', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    const r = addPlannedTrip(baseChain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      date: '2026-07-01',
      plannedCount: 0,
      idFactory: ids,
    });
    expect(r.error).toBeUndefined();
    expect(r.trips[r.trips.length - 1].plannedCount).toBe(0);
    // Existing trips untouched.
    expect(r.trips.find((t) => t.id === 't-a').plannedCount).toBe(12);
    expect(r.trips.find((t) => t.id === 't-b').plannedCount).toBe(12);
  });

  it('separates order across (subBatchId, sex) chains', () => {
    let n = 0;
    const ids = () => 'new-' + ++n;
    // Adding boar with count 0 (boars chain has only t-c; order shifts to 1).
    const r = addPlannedTrip(baseChain, {
      subBatchId: 'sub-1',
      sex: 'boar',
      date: '2026-07-01',
      plannedCount: 0,
      idFactory: ids,
    });
    expect(r.trips[r.trips.length - 1].order).toBe(1);
  });

  it('rejects malformed inputs without mutating', () => {
    expect(addPlannedTrip(baseChain, {sex: 'gilt', date: '2026-07-01', plannedCount: 5}).error).toMatch(/subBatchId/);
    expect(
      addPlannedTrip(baseChain, {subBatchId: 'sub-1', sex: 'mixed', date: '2026-07-01', plannedCount: 5}).error,
    ).toMatch(/sex/);
    expect(
      addPlannedTrip(baseChain, {subBatchId: 'sub-1', sex: 'gilt', date: '07/01/26', plannedCount: 5}).error,
    ).toMatch(/YYYY-MM-DD/);
    expect(
      addPlannedTrip(baseChain, {subBatchId: 'sub-1', sex: 'gilt', date: '2026-07-01', plannedCount: -3}).error,
    ).toMatch(/non-negative/);
  });
});

describe('deletePlannedTripWithReconciliation', () => {
  const chain = [
    {id: 't-a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 10, order: 0},
    {id: 't-b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 1},
    {id: 't-c', date: '2026-06-29', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 6, order: 2},
    {id: 't-other', date: '2026-06-15', sex: 'boar', subBatchId: 'sub-1', plannedCount: 5, order: 0},
  ];

  it('moves the deleted trip plannedCount onto the NEXT chain trip when present', () => {
    const r = deletePlannedTripWithReconciliation(chain, 't-b');
    expect(r.error).toBeUndefined();
    const ids = r.trips.map((t) => t.id);
    expect(ids).not.toContain('t-b');
    const tc = r.trips.find((t) => t.id === 't-c');
    expect(tc.plannedCount).toBe(6 + 8);
    expect(r.trips.find((t) => t.id === 't-other').plannedCount).toBe(5);
  });

  it('falls back to PREVIOUS trip when the deleted trip is the last in chain', () => {
    const r = deletePlannedTripWithReconciliation(chain, 't-c');
    expect(r.error).toBeUndefined();
    const tb = r.trips.find((t) => t.id === 't-b');
    expect(tb.plannedCount).toBe(8 + 6);
  });

  it('uses the NEXT trip when deleting the FIRST trip in chain', () => {
    const r = deletePlannedTripWithReconciliation(chain, 't-a');
    expect(r.error).toBeUndefined();
    const tb = r.trips.find((t) => t.id === 't-b');
    expect(tb.plannedCount).toBe(8 + 10);
  });

  it('refuses to delete the only planned trip in a chain', () => {
    const single = [{id: 's-1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-9', plannedCount: 5, order: 0}];
    const r = deletePlannedTripWithReconciliation(single, 's-1');
    expect(r.error).toMatch(/only planned trip/);
  });

  it('refuses when tripId not found', () => {
    expect(deletePlannedTripWithReconciliation(chain, 'missing').error).toMatch(/not found/);
  });
});

describe('deleteReconciliationRecipient', () => {
  const chain = [
    {id: 't-a', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 10, order: 0},
    {id: 't-b', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 1},
    {id: 't-c', date: '2026-06-29', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 6, order: 2},
    {id: 't-other', date: '2026-06-15', sex: 'boar', subBatchId: 'sub-1', plannedCount: 5, order: 0},
  ];

  it('returns the NEXT chain trip when one follows the deleted trip', () => {
    expect(deleteReconciliationRecipient(chain, 't-b').id).toBe('t-c');
    expect(deleteReconciliationRecipient(chain, 't-a').id).toBe('t-b');
  });

  it('falls back to the PREVIOUS trip when deleting the last in chain', () => {
    expect(deleteReconciliationRecipient(chain, 't-c').id).toBe('t-b');
  });

  it('scopes the chain to the same (subBatchId, sex) pair', () => {
    // t-other is the only boar trip — no recipient in its own chain.
    expect(deleteReconciliationRecipient(chain, 't-other')).toBeNull();
  });

  it('returns null for a single-trip chain (no recipient)', () => {
    const single = [{id: 's-1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-9', plannedCount: 5, order: 0}];
    expect(deleteReconciliationRecipient(single, 's-1')).toBeNull();
  });

  it('returns null for missing tripId or non-array input', () => {
    expect(deleteReconciliationRecipient(chain, 'missing')).toBeNull();
    expect(deleteReconciliationRecipient(null, 't-a')).toBeNull();
  });
});

describe('reconcilePlannedTripsForSend', () => {
  const chain = [
    {id: 't-1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 0},
    {id: 't-2', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 1},
    {id: 't-3', date: '2026-06-29', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 6, order: 2},
    {id: 't-other', date: '2026-06-15', sex: 'boar', subBatchId: 'sub-1', plannedCount: 5, order: 0},
  ];

  it('selects the first chain trip with date >= today as the target', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 12,
      today: '2026-05-25',
    });
    expect(r.error).toBeUndefined();
    expect(r.targetTripId).toBe('t-1');
    expect(r.targetTripDate).toBe('2026-06-01');
  });

  it('falls back to earliest chain trip when every trip is in the past', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 12,
      today: '2026-12-31',
    });
    expect(r.error).toBeUndefined();
    expect(r.targetTripId).toBe('t-1');
  });

  it('exact send (selected == planned): consumes target only', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 12,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-1')).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-2').plannedCount).toBe(8);
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-3').plannedCount).toBe(6);
    expect(r.pushedRemainder).toBe(0);
  });

  it('under-pull (selected < planned): consumes target, pushes remainder forward to NEXT', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 8,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-1')).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-2').plannedCount).toBe(8 + 4);
    expect(r.pushedRemainder).toBe(4);
  });

  it('over-pull (selected > planned, satisfiable from chain): consumes target + later trips', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 18,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-1')).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-2').plannedCount).toBe(8 - 6);
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-3').plannedCount).toBe(6);
  });

  it('over-pull cascading: removes intermediate fully-consumed trips', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 12 + 8 + 4,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-1')).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-2')).toBeUndefined();
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-3').plannedCount).toBe(6 - 4);
  });

  it('refuses over-pull when the chain is exhausted', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 100,
      today: '2026-05-01',
    });
    expect(r.error).toMatch(/exceed the total planned count/);
    expect(r.updatedPlannedTrips).toBeUndefined();
  });

  it('under-pull with no NEXT trip leaves a residual planned trip rather than refusing', () => {
    // Codex amendment: the chain-edge case must not block a real send.
    // Keep the target alive with reduced plannedCount so the residual
    // can be sent later. The helper signals this branch via
    // remainderStayedOnTarget=true so the UI can render
    // residual-aware copy instead of the "push forward" wording.
    const lastOnly = [{id: 't-1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 0}];
    const r = reconcilePlannedTripsForSend(lastOnly, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 8,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.targetTripId).toBe('t-1');
    expect(r.targetTripDate).toBe('2026-06-01');
    const residual = r.updatedPlannedTrips.find((t) => t.id === 't-1');
    expect(residual).toBeDefined();
    expect(residual.plannedCount).toBe(4);
    expect(r.pushedRemainder).toBe(4);
    expect(r.remainderStayedOnTarget).toBe(true);
  });

  it('under-pull WITH a next trip clears remainderStayedOnTarget (push-forward path)', () => {
    const chainTwo = [
      {id: 't-1', date: '2026-06-01', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 12, order: 0},
      {id: 't-2', date: '2026-06-15', sex: 'gilt', subBatchId: 'sub-1', plannedCount: 8, order: 1},
    ];
    const r = reconcilePlannedTripsForSend(chainTwo, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 8,
      today: '2026-05-01',
    });
    expect(r.error).toBeUndefined();
    expect(r.pushedRemainder).toBe(4);
    expect(r.remainderStayedOnTarget).toBe(false);
  });

  it('refuses when no planned trip exists for the (sub, sex) chain', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-9',
      sex: 'gilt',
      sendCount: 5,
      today: '2026-05-01',
    });
    expect(r.error).toMatch(/No planned trip exists/);
  });

  it('keeps trips in other (sub, sex) chains untouched', () => {
    const r = reconcilePlannedTripsForSend(chain, {
      subBatchId: 'sub-1',
      sex: 'gilt',
      sendCount: 12,
      today: '2026-05-01',
    });
    expect(r.updatedPlannedTrips.find((t) => t.id === 't-other').plannedCount).toBe(5);
  });

  it('rejects malformed inputs', () => {
    expect(reconcilePlannedTripsForSend(chain, {subBatchId: 'sub-1', sex: 'gilt', sendCount: 0}).error).toMatch(
      /sendCount/,
    );
    expect(reconcilePlannedTripsForSend(chain, {subBatchId: 'sub-1', sex: 'mixed', sendCount: 5}).error).toMatch(/sex/);
    expect(reconcilePlannedTripsForSend(chain, {sex: 'gilt', sendCount: 5}).error).toMatch(/subBatchId/);
  });
});
