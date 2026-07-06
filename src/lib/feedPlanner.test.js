// ============================================================================
// src/lib/feedPlanner.test.js
// ----------------------------------------------------------------------------
// Unit tests for the snapshot-anchored feed planner. Covers the contracts
// Codex locked for commit 1:
//
//   • Pig feeder current-count derivation matches PigBatchesView's ledger
//     formula (started − tripPigs − transfers − mortality). Locked
//     fixture: 50 → 8 → 2 → 5 = 35 at day 70.
//   • Variable-rate burn over the runway window. Naive `onHand / todayBurn`
//     is materially wrong vs forward day-by-day projection.
//   • Snapshot-anchored on-hand: snapshot 18 days old → today's on-hand =
//     snapshot − consumption_over_18_days.
//   • Stale-snapshot threshold at 21 days.
//   • Suggested order rounding UP to ORDER_ROUNDING_LBS (50 lbs).
//   • Order-by-date math (today + max(0, runway − leadTime)).
//   • Poultry: starter / grower / layerfeed compute independently.
//   • Empty-state behavior (no snapshot returns null on-hand).
// ============================================================================

import {describe, it, expect} from 'vitest';
import {
  pigFeederSubCurrentCount,
  pigFeederLbsPerDayAtAge,
  pigDailyBurnLbs,
  poultryDailyBurnLbs,
  runwayDays,
  totalBurnOverDays,
  onHandFromSnapshot,
  isSnapshotStale,
  suggestOrder,
  LEAD_TIME_DAYS,
  RESERVE_DAYS,
  ORDER_ROUNDING_LBS,
  STALE_SNAPSHOT_DAYS,
  PIG_FEED_RATES,
} from './feedPlanner.js';

// ── Pig ledger fixture (Codex's locked scenario) ───────────────────────────
//
// Sub-batch 'sub-x' starts at 50 (30 gilts + 20 boars). One processing
// trip attributes 8 to that sub. Two mortality entries (1 pig each) for
// that sub. Five breeders transferred from that sub.
// Expected current count: 50 − 8 − 5 − 2 = 35.

const SUB_X = {
  id: 'sub-x',
  name: 'sub-x',
  giltCount: 30,
  boarCount: 20,
  originalPigCount: 50,
};

const FIXTURE_GROUP = {
  batchName: 'P-26-01',
  status: 'active',
  cycleId: 'cycle-1',
  subBatches: [SUB_X],
  processingTrips: [
    {
      id: 'trip-1',
      date: '2026-04-01',
      pigCount: 8,
      subAttributions: [{subId: 'sub-x', subBatchName: 'sub-x', sex: 'mixed', count: 8}],
    },
  ],
  pigMortalities: [
    {sub_batch_name: 'sub-x', count: 1, date: '2026-03-15', team_member: 'BMAN', comment: ''},
    {sub_batch_name: 'sub-x', count: 1, date: '2026-04-10', team_member: 'BMAN', comment: ''},
  ],
};

const FIXTURE_BREEDERS = [
  {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-01', subBatchName: 'sub-x'}},
  {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-01', subBatchName: 'sub-x'}},
  {sex: 'Boar', archived: false, transferredFromBatch: {batchName: 'P-26-01', subBatchName: 'sub-x'}},
  {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-01', subBatchName: 'sub-x'}},
  {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-01', subBatchName: 'sub-x'}},
  // Unrelated breeder: different parent, must be ignored.
  {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-99', subBatchName: 'other'}},
];

describe('pigFeederSubCurrentCount — Codex locked fixture', () => {
  it('returns 35 for the 50→8→2→5 scenario', () => {
    expect(pigFeederSubCurrentCount(FIXTURE_GROUP, SUB_X, FIXTURE_BREEDERS)).toBe(35);
  });

  it('clamps to 0 when ledger goes negative (data corruption guard)', () => {
    const overcooked = {
      ...FIXTURE_GROUP,
      processingTrips: [
        {
          id: 'trip-2',
          date: '2026-04-01',
          subAttributions: [{subId: 'sub-x', count: 100}],
        },
      ],
    };
    expect(pigFeederSubCurrentCount(overcooked, SUB_X, [])).toBe(0);
  });

  it('returns 0 for a missing sub or group', () => {
    expect(pigFeederSubCurrentCount(null, SUB_X, [])).toBe(0);
    expect(pigFeederSubCurrentCount(FIXTURE_GROUP, null, [])).toBe(0);
  });

  it('ignores breeders transferred from a different parent', () => {
    const onlyOtherParent = [
      {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-99', subBatchName: 'sub-x'}},
    ];
    // 50 − 8 − 0 − 2 = 40 (no transfers count from this parent)
    expect(pigFeederSubCurrentCount(FIXTURE_GROUP, SUB_X, onlyOtherParent)).toBe(40);
  });
});

describe('pigFeederLbsPerDayAtAge — preserves legacy curve', () => {
  it('clamps to 1 lb/day below day 30.44', () => {
    expect(pigFeederLbsPerDayAtAge(0)).toBe(1);
    expect(pigFeederLbsPerDayAtAge(15)).toBe(1);
    expect(pigFeederLbsPerDayAtAge(30)).toBe(1);
  });

  it('grows linearly (ageDays / 30.44) above the floor', () => {
    // day 60 → 60/30.44 ≈ 1.971
    expect(pigFeederLbsPerDayAtAge(60)).toBeCloseTo(1.971, 2);
    // day 70 → 70/30.44 ≈ 2.300
    expect(pigFeederLbsPerDayAtAge(70)).toBeCloseTo(2.3, 2);
    // day 100 → 100/30.44 ≈ 3.286
    expect(pigFeederLbsPerDayAtAge(100)).toBeCloseTo(3.286, 2);
  });

  it('returns 0 for negative or non-finite ages', () => {
    expect(pigFeederLbsPerDayAtAge(-1)).toBe(0);
    expect(pigFeederLbsPerDayAtAge(NaN)).toBe(0);
  });
});

// ── Variable-rate runway proof ─────────────────────────────────────────────
//
// 35 feeder pigs at day 70, 1500 lbs on hand. Naive runway divides by
// today's burn rate; forward projection walks day by day and integrates.
// Burn grows with age, so naive overstates runway.

describe('runwayDays — variable-rate forward projection beats naive', () => {
  // Isolated feeder-only context: empty breeders so the burn function
  // exercises ONLY the variable-rate feeder math. (pigDailyBurnLbs adds
  // 5 lbs/day per non-nursing sow + 5 lbs/day per boar in production —
  // covered by the aggregate test above. Here we want a clean signal
  // that the rate grows with age.)
  const TODAY = '2026-05-09';
  const BIRTH = '2026-02-28'; // 70 days before
  const ctx = {
    feederGroups: [
      {
        ...FIXTURE_GROUP,
        startDate: BIRTH,
        cycleId: null,
      },
    ],
    breedingCycles: [],
    breeders: FIXTURE_BREEDERS, // gives the 5 transfers off sub-x = 35 remaining
    farrowingRecs: [],
  };
  // feederLbs is independent of the breeders[] sow/boar tally — it only
  // depends on each sub-batch's ledger-derived remaining count. Reading
  // it directly isolates the variable-rate signal we want to assert.
  const feederBurnFn = (d) => pigDailyBurnLbs(d, ctx).feederLbs;

  it('day-70 burn ≠ day-100 burn (rate grows with age)', () => {
    const day70 = feederBurnFn(TODAY);
    const day100 = feederBurnFn('2026-06-08'); // 70 + 30 days
    // 35 pigs × (70/30.44) ≈ 80.5 lbs/day; 35 × (100/30.44) ≈ 115.0 lbs/day
    expect(day70).toBeCloseTo(35 * (70 / 30.44), 1);
    expect(day100).toBeCloseTo(35 * (100 / 30.44), 1);
    expect(day100).toBeGreaterThan(day70 + 25);
  });

  it('forward runway is materially less than naive division', () => {
    const onHand = 1500;
    const naiveDays = onHand / feederBurnFn(TODAY); // ≈ 18.6
    const forward = runwayDays({onHandLbs: onHand, fromDateISO: TODAY, burnRateFn: feederBurnFn});
    // Forward must be at least 1 full day less than naive — Codex's
    // "naive is materially wrong" assertion.
    expect(forward).toBeLessThan(Math.floor(naiveDays));
    // Sanity: 1500 lbs at ~80-115 lbs/day, age-growing → 12-18 days.
    expect(forward).toBeGreaterThanOrEqual(11);
    expect(forward).toBeLessThan(19);
  });

  it('returns 0 for non-positive on-hand', () => {
    expect(runwayDays({onHandLbs: 0, fromDateISO: TODAY, burnRateFn: feederBurnFn})).toBe(0);
    expect(runwayDays({onHandLbs: -5, fromDateISO: TODAY, burnRateFn: feederBurnFn})).toBe(0);
  });

  it('caps at maxDays for zero-burn scenarios', () => {
    const days = runwayDays({onHandLbs: 1000, fromDateISO: TODAY, burnRateFn: () => 0, maxDays: 365});
    expect(days).toBe(365);
  });
});

// ── pigDailyBurnLbs aggregate ──────────────────────────────────────────────

describe('pigDailyBurnLbs — sows + boars + feeders', () => {
  const TODAY = '2026-05-09';

  it('aggregates non-nursing sows × 5 + boars × 5 + feeders × age-rate', () => {
    const ctx = {
      feederGroups: [{...FIXTURE_GROUP, startDate: '2026-02-28', cycleId: null}],
      breedingCycles: [],
      breeders: [
        // 5 transfers (already in FIXTURE_BREEDERS — counted as active sows
        // for the planner because archived !== true).
        ...FIXTURE_BREEDERS.filter((b) => b.transferredFromBatch.batchName === 'P-26-01'),
        // 2 fresh boars (no transfer history).
        {sex: 'Boar', archived: false},
        {sex: 'Boar', archived: false},
      ],
      farrowingRecs: [],
    };
    const out = pigDailyBurnLbs(TODAY, ctx);
    // Sow count from breeders: 4 sows + 1 boar from transfers, plus 2 fresh
    // boars. Active sows = 4. Active boars = 1 + 2 = 3.
    // Non-nursing sows: 4 × 5 = 20. Boars: 3 × 5 = 15. Sum sow+boar = 35.
    expect(out.sowLbs).toBe(20);
    expect(out.boarLbs).toBe(15);
    // Feeders: 35 pigs × (70 / 30.44) ≈ 80.5 lbs/day.
    expect(out.feederLbs).toBeCloseTo(35 * (70 / 30.44), 1);
    expect(out.totalLbs).toBeCloseTo(35 + 80.5, 0);
  });

  it('counts nursing sows at 15 lbs/day', () => {
    const out = pigDailyBurnLbs(TODAY, {
      feederGroups: [],
      breedingCycles: [{id: 'cycle-nursing', group: '1', exposureStart: '2026-01-01'}],
      breeders: [
        {sex: 'Sow', archived: false},
        {sex: 'Sow', archived: false},
        {sex: 'Gilt', archived: false},
        {sex: 'Boar', archived: false},
      ],
      farrowingRecs: [{group: '1', farrowingDate: '2026-04-27'}],
    });

    expect(PIG_FEED_RATES.sowNursingLbsPerDay).toBe(15);
    expect(out.nursing).toBe(1);
    expect(out.nonNursing).toBe(2);
    expect(out.sowLbs).toBe(1 * 15 + 2 * 5);
    expect(out.boarLbs).toBe(5);
    expect(out.totalLbs).toBe(30);
  });

  it('adds farrowing-record piglets not represented in the linked feeder batch', () => {
    const cycle = {id: 'cycle-farrow-feed', group: '3', exposureStart: '2026-01-01'};
    const out = pigDailyBurnLbs(TODAY, {
      feederGroups: [
        {
          id: 'farrowing-cycle-cycle-farrow-feed',
          batchName: 'P-27-01',
          cycleId: cycle.id,
          farmBorn: true,
          status: 'active',
          originalPigCount: 0,
          giltCount: 0,
          boarCount: 0,
          subBatches: [],
          processingTrips: [],
          pigMortalities: [],
        },
      ],
      breedingCycles: [cycle],
      breeders: [],
      farrowingRecs: [
        {id: 'f1', group: '3', farrowingDate: '2026-04-27', alive: 9},
        {id: 'f2', group: '3', farrowingDate: '2026-05-01', totalBorn: 10, deaths: 3},
      ],
    });

    expect(out.feederLbs).toBe(0);
    expect(out.sowLbs).toBe(30);
    expect(out.farrowingPiglets).toBe(16);
    expect(out.farrowingPigletLbs).toBe(16);
    expect(out.totalLbs).toBe(46);
  });

  it('does not double count farrowing piglets already represented by a linked batch', () => {
    const cycle = {id: 'cycle-farrow-feed', group: '3', exposureStart: '2026-01-01'};
    const out = pigDailyBurnLbs(TODAY, {
      feederGroups: [
        {
          id: 'farrowing-cycle-cycle-farrow-feed',
          batchName: 'P-27-01',
          cycleId: cycle.id,
          farmBorn: true,
          status: 'active',
          originalPigCount: 9,
          giltCount: 0,
          boarCount: 0,
          subBatches: [],
          processingTrips: [],
          pigMortalities: [],
        },
      ],
      breedingCycles: [cycle],
      breeders: [],
      farrowingRecs: [
        {id: 'f1', group: '3', farrowingDate: '2026-04-27', alive: 9},
        {id: 'f2', group: '3', farrowingDate: '2026-05-01', totalBorn: 10, deaths: 3},
      ],
    });

    expect(out.feederLbs).toBe(9);
    expect(out.sowLbs).toBe(30);
    expect(out.farrowingPiglets).toBe(7);
    expect(out.farrowingPigletLbs).toBe(7);
    expect(out.totalLbs).toBe(46);
  });

  it('zero out when no feeders, no sows, no boars', () => {
    const out = pigDailyBurnLbs(TODAY, {feederGroups: [], breedingCycles: [], breeders: [], farrowingRecs: []});
    expect(out.totalLbs).toBe(0);
  });

  // Codex commit-1 review point #1: parent-only batches (legacy data with
  // no subBatches[]) must subtract trips + transfers + mortality at the
  // parent level — same ledger frame as the sub-batch path.
  it('parent-only batch subtracts trips + transfers + mortality (no subs)', () => {
    const parentOnly = {
      batchName: 'P-26-LEGACY',
      status: 'active',
      cycleId: null,
      startDate: '2026-02-28', // 70 days before TODAY (2026-05-09)
      // No subBatches[] → triggers the parent-only fallback.
      giltCount: 30,
      boarCount: 20,
      processingTrips: [{id: 'trip-x', date: '2026-04-01', pigCount: 8}],
      pigMortalities: [
        {sub_batch_name: null, count: 1, date: '2026-03-15', team_member: 'BMAN'},
        {sub_batch_name: null, count: 1, date: '2026-04-10', team_member: 'BMAN'},
      ],
    };
    const breeders = [
      // 5 transfers from this parent batch (any/no subBatchName).
      {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-LEGACY'}},
      {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-LEGACY'}},
      {sex: 'Boar', archived: false, transferredFromBatch: {batchName: 'P-26-LEGACY'}},
      {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-LEGACY'}},
      {sex: 'Sow', archived: false, transferredFromBatch: {batchName: 'P-26-LEGACY'}},
    ];
    const out = pigDailyBurnLbs(TODAY, {
      feederGroups: [parentOnly],
      breedingCycles: [],
      breeders,
      farrowingRecs: [],
    });
    // Expected remaining: 50 − 8 − 5 − 2 = 35 (same as the sub-batch
    // fixture). Day-70 rate = 70/30.44. Feeder feed = 35 × 70/30.44.
    const expectedFeederLbs = 35 * (70 / 30.44);
    expect(out.feederLbs).toBeCloseTo(expectedFeederLbs, 1);
  });

  it('parent-only batch with NO transfers + NO mortality matches started − trips', () => {
    const parentOnly = {
      batchName: 'P-26-CLEAN',
      status: 'active',
      cycleId: null,
      startDate: '2026-02-28',
      giltCount: 30,
      boarCount: 20,
      processingTrips: [{id: 'trip-1', pigCount: 8}],
      pigMortalities: [],
    };
    const out = pigDailyBurnLbs(TODAY, {
      feederGroups: [parentOnly],
      breedingCycles: [],
      breeders: [],
      farrowingRecs: [],
    });
    // 50 − 8 = 42 remaining; rate same as above.
    expect(out.feederLbs).toBeCloseTo(42 * (70 / 30.44), 1);
  });
});

// ── Poultry independent feed types ─────────────────────────────────────────
//
// Anchored on the existing planner: getFeedSchedule(breed) for broilers
// (FEED_BIRDS=700 baked into totalLbs), LAYER_FEED_SCHEDULE for layers
// weeks 1-20, LAYER_FEED_PER_DAY × projected-hen-count for layers
// weeks 21+. Daily burn = (week's totalLbs / 7) for broilers,
// (week's lbsPerBird × birdCount / 7) for layers in chick phases.
// Cross-checked against the same lib/broiler.js source-of-truth helpers
// the existing monthly projection uses.

import {getFeedSchedule, LAYER_FEED_SCHEDULE, LAYER_FEED_PER_DAY} from './broiler.js';

describe('poultryDailyBurnLbs — anchored on getFeedSchedule + LAYER_FEED_SCHEDULE', () => {
  it('broiler week-1 (CC starter) daily lbs matches schedule[0].totalLbs / 7', () => {
    // Hatched today, age 0 → week 1 starter.
    const ctx = {
      batches: [
        {
          id: 'b1',
          status: 'active',
          breed: 'CC',
          hatchDate: '2026-05-09',
          original_count: 750,
          birdCountActual: 720,
        },
      ],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    const expected = getFeedSchedule('CC')[0].totalLbs / 7;
    expect(out.starterLbs).toBeCloseTo(expected, 5);
    expect(out.growerLbs).toBe(0);
    expect(out.layerLbs).toBe(0);
  });

  it('broiler week-3 (CC grower) lands in growerLbs not starterLbs', () => {
    // 14 days old → week 3 (grower for CC).
    const ctx = {
      batches: [{id: 'b1', status: 'active', breed: 'CC', hatchDate: '2026-04-25', birdCountActual: 720}],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    const expected = getFeedSchedule('CC')[2].totalLbs / 7;
    expect(getFeedSchedule('CC')[2].phase).toBe('grower');
    expect(out.starterLbs).toBe(0);
    expect(out.growerLbs).toBeCloseTo(expected, 5);
  });

  it('broiler past end of schedule contributes 0 (batch finished feeding)', () => {
    // CC schedule runs 7 weeks → 49 days. At day 100 the batch is past it.
    const ctx = {
      batches: [{id: 'b1', status: 'active', breed: 'CC', hatchDate: '2026-01-29'}],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.starterLbs).toBe(0);
    expect(out.growerLbs).toBe(0);
  });

  it('WR breed uses WR schedule (longer grower window, week 8 still active)', () => {
    // 49 days old → week 8 for WR (still in schedule); CC would be done.
    const ctx = {
      batches: [
        {id: 'b1', status: 'active', breed: 'WR', hatchDate: '2026-03-21'},
        {id: 'b2', status: 'active', breed: 'CC', hatchDate: '2026-03-21'},
      ],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    // CC schedule has only 7 weeks → at week 8 (idx 7), out of range.
    // WR has 8 weeks → idx 7 is the last grower week.
    const wrExpected = getFeedSchedule('WR')[7].totalLbs / 7;
    expect(out.growerLbs).toBeCloseTo(wrExpected, 5);
  });

  it('layer week-1 chicks contribute starterLbs scaled by original_count', () => {
    // Day 0, 100 chicks → week 1 starter at LAYER_FEED_SCHEDULE[0].lbsPerBird.
    const ctx = {
      batches: [],
      layerBatches: [{id: 'lb1', status: 'active', brooder_entry_date: '2026-05-09', original_count: 100}],
      layerHousings: [],
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    const expected = (LAYER_FEED_SCHEDULE[0].lbsPerBird * 100) / 7;
    expect(out.starterLbs).toBeCloseTo(expected, 5);
  });

  it('layer week-21+ uses LAYER_FEED_PER_DAY × projected hens from housings', () => {
    // 21 weeks = 147 days old; falls past LAYER_FEED_SCHEDULE end (20 weeks).
    const ctx = {
      batches: [],
      layerBatches: [{id: 'lb1', status: 'active', brooder_entry_date: '2025-12-13', original_count: 80}],
      // computeProjectedCount uses anchor_count - mortality since anchor_date.
      // Housing has anchor_count=80 and no mortality entries → projected 80.
      layerHousings: [
        {
          id: 'h1',
          batch_id: 'lb1',
          status: 'active',
          anchor_count: 80,
          anchor_date: '2026-04-01',
          current_count: 80,
        },
      ],
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.starterLbs).toBe(0);
    expect(out.growerLbs).toBe(0);
    expect(out.layerLbs).toBeCloseTo(80 * LAYER_FEED_PER_DAY, 5);
  });

  it('layer week-21+ falls back to original_count when no housings exist', () => {
    const ctx = {
      batches: [],
      layerBatches: [{id: 'lb1', status: 'active', brooder_entry_date: '2025-12-13', original_count: 80}],
      layerHousings: [], // no housings yet
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.layerLbs).toBeCloseTo(80 * LAYER_FEED_PER_DAY, 5);
  });

  it('skips inactive batches and inactive housings', () => {
    const ctx = {
      batches: [{id: 'b1', status: 'processed', breed: 'CC', hatchDate: '2026-05-01'}],
      layerBatches: [{id: 'lb1', status: 'sold', brooder_entry_date: '2026-05-01', original_count: 100}],
      layerHousings: [],
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.starterLbs).toBe(0);
    expect(out.growerLbs).toBe(0);
    expect(out.layerLbs).toBe(0);
  });

  it('returns zeros for missing hatchDate or start date', () => {
    const ctx = {
      batches: [{id: 'b1', status: 'active', breed: 'CC' /* no hatchDate */}],
      layerBatches: [{id: 'lb1', status: 'active', original_count: 100 /* no start */}],
      layerHousings: [],
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.starterLbs).toBe(0);
    expect(out.growerLbs).toBe(0);
    expect(out.layerLbs).toBe(0);
  });

  it('starter / grower / layer compute independently across mixed batches', () => {
    const ctx = {
      batches: [
        {id: 'b1', status: 'active', breed: 'CC', hatchDate: '2026-05-08'}, // age 1 → wk 1 starter
        {id: 'b2', status: 'active', breed: 'CC', hatchDate: '2026-04-11'}, // age 28 → wk 5 grower
      ],
      layerBatches: [
        {id: 'lb1', status: 'active', brooder_entry_date: '2025-12-08', original_count: 50}, // ~22 wks → layer phase
      ],
      layerHousings: [],
      layerDailys: [],
    };
    const out = poultryDailyBurnLbs('2026-05-09', ctx);
    expect(out.starterLbs).toBeGreaterThan(0);
    expect(out.growerLbs).toBeGreaterThan(0);
    expect(out.layerLbs).toBeCloseTo(50 * LAYER_FEED_PER_DAY, 5);
  });
});

// ── Snapshot anchor ────────────────────────────────────────────────────────

describe('onHandFromSnapshot — snapshot − consumption since', () => {
  it('returns the snapshot value when snapshotDate === today', () => {
    expect(
      onHandFromSnapshot({
        snapshotLbs: 1500,
        snapshotDateISO: '2026-05-09',
        todayISO: '2026-05-09',
      }),
    ).toBe(1500);
  });

  it('subtracts caller-supplied consumed lbs over the window', () => {
    const result = onHandFromSnapshot({
      snapshotLbs: 1500,
      snapshotDateISO: '2026-04-21',
      todayISO: '2026-05-09', // 18 days later
      consumedLbsFn: (_from, _to) => {
        // Crude: 30 lbs/day × 18 days = 540.
        return 540;
      },
    });
    expect(result).toBe(960);
  });

  it('falls back to projected burn when no consumed fn is supplied', () => {
    const result = onHandFromSnapshot({
      snapshotLbs: 1000,
      snapshotDateISO: '2026-05-01',
      todayISO: '2026-05-09', // 8 days
      burnRateFn: () => 50, // flat 50 lbs/day
    });
    expect(result).toBe(1000 - 8 * 50);
  });

  it('clamps to 0 when consumption exceeds snapshot', () => {
    const result = onHandFromSnapshot({
      snapshotLbs: 100,
      snapshotDateISO: '2026-04-01',
      todayISO: '2026-05-09',
      consumedLbsFn: () => 500, // way more than snapshot
    });
    expect(result).toBe(0);
  });

  it('returns null when snapshotDate is in the future', () => {
    const result = onHandFromSnapshot({
      snapshotLbs: 1000,
      snapshotDateISO: '2026-12-31',
      todayISO: '2026-05-09',
    });
    expect(result).toBeNull();
  });

  it('returns null when no snapshot is supplied (empty state)', () => {
    expect(onHandFromSnapshot({snapshotLbs: null, snapshotDateISO: null, todayISO: '2026-05-09'})).toBeNull();
  });
});

describe('isSnapshotStale — 21-day threshold', () => {
  it('returns false for fresh snapshots (<= 21 days)', () => {
    expect(isSnapshotStale({snapshotDateISO: '2026-04-21', todayISO: '2026-05-09'})).toBe(false); // 18 days
    expect(isSnapshotStale({snapshotDateISO: '2026-04-18', todayISO: '2026-05-09'})).toBe(false); // 21 days
  });

  it('returns true once past 21 days', () => {
    expect(isSnapshotStale({snapshotDateISO: '2026-04-17', todayISO: '2026-05-09'})).toBe(true); // 22 days
  });

  it('returns false when no snapshot', () => {
    expect(isSnapshotStale({snapshotDateISO: null, todayISO: '2026-05-09'})).toBe(false);
  });

  it('matches the exported constant', () => {
    expect(STALE_SNAPSHOT_DAYS).toBe(21);
  });
});

// ── Suggested order ────────────────────────────────────────────────────────

describe('suggestOrder — reserve target + rounding + order-by-date', () => {
  const TODAY = '2026-05-09';

  it('rounds UP to ORDER_ROUNDING_LBS (50)', () => {
    const out = suggestOrder({
      onHandLbs: 100,
      todayISO: TODAY,
      burnRateFn: () => 50, // flat
      leadTimeDays: 7,
      reserveDays: 30,
    });
    // Horizon burn: 37 × 50 = 1850. raw = 1850 − 100 = 1750. Already a
    // multiple of 50, so rounding leaves it.
    expect(out.rawOrderLbs).toBe(1750);
    expect(out.suggestedOrderLbs).toBe(1750);
  });

  it('rounds 1387 → 1400 (ceil to nearest 50)', () => {
    const out = suggestOrder({
      onHandLbs: 113,
      todayISO: TODAY,
      burnRateFn: () => 40.54, // chosen so horizon × rate − onHand ≈ 1387
      leadTimeDays: 7,
      reserveDays: 30,
    });
    // 37 × 40.54 = 1499.98 → raw ≈ 1387 (floor)
    expect(out.suggestedOrderLbs % ORDER_ROUNDING_LBS).toBe(0);
    expect(out.suggestedOrderLbs).toBeGreaterThanOrEqual(out.rawOrderLbs);
    expect(out.suggestedOrderLbs - out.rawOrderLbs).toBeLessThan(ORDER_ROUNDING_LBS);
  });

  it('returns 0 suggested when on-hand already covers the horizon', () => {
    const out = suggestOrder({
      onHandLbs: 5000,
      todayISO: TODAY,
      burnRateFn: () => 50,
      leadTimeDays: 7,
      reserveDays: 30,
    });
    expect(out.rawOrderLbs).toBe(0);
    expect(out.suggestedOrderLbs).toBe(0);
  });

  it('orderByDate = today + max(0, runway − leadTime)', () => {
    // 1500 lbs at 50 lbs/day flat → runway 30 days. Lead 7 → orderBy +23.
    const out = suggestOrder({
      onHandLbs: 1500,
      todayISO: TODAY,
      burnRateFn: () => 50,
      leadTimeDays: 7,
      reserveDays: 30,
    });
    expect(out.daysOfRunway).toBe(30);
    expect(out.orderByDateISO).toBe('2026-06-01'); // 2026-05-09 + 23 days
    expect(out.orderIsLate).toBe(false);
  });

  it('flags orderIsLate when runway < leadTime', () => {
    const out = suggestOrder({
      onHandLbs: 200,
      todayISO: TODAY,
      burnRateFn: () => 50, // 4 days runway, < 7 day lead
      leadTimeDays: 7,
      reserveDays: 30,
    });
    expect(out.daysOfRunway).toBe(4);
    expect(out.orderIsLate).toBe(true);
    expect(out.orderByDateISO).toBe(TODAY); // today
  });

  it('balanceAfterDelivery = onHand − burn(today..delivery) + suggestedOrder', () => {
    const out = suggestOrder({
      onHandLbs: 1500,
      todayISO: TODAY,
      burnRateFn: () => 50,
      leadTimeDays: 7,
      reserveDays: 30,
    });
    // burn during 7-day lead = 350. raw order = 37×50 − 1500 = 1850−1500 = 350.
    // balance = 1500 − 350 + 350 = 1500.
    expect(out.suggestedOrderLbs).toBe(350);
    expect(out.balanceAfterDelivery).toBe(1500);
  });

  it('uses default constants when leadTime/reserve/rounding omitted', () => {
    const out = suggestOrder({
      onHandLbs: 1000,
      todayISO: TODAY,
      burnRateFn: () => 50,
    });
    // Default lead 7, reserve 30 → horizon 37 days.
    expect(out.horizonDays).toBe(LEAD_TIME_DAYS + RESERVE_DAYS.default);
    expect(out.suggestedOrderLbs % ORDER_ROUNDING_LBS).toBe(0);
  });
});

describe('totalBurnOverDays — straight integration', () => {
  it('sums daily burn across the window', () => {
    expect(totalBurnOverDays({fromDateISO: '2026-05-09', throughDays: 10, burnRateFn: () => 7})).toBe(70);
  });

  it('returns 0 for non-positive window', () => {
    expect(totalBurnOverDays({fromDateISO: '2026-05-09', throughDays: 0, burnRateFn: () => 100})).toBe(0);
    expect(totalBurnOverDays({fromDateISO: '2026-05-09', throughDays: -3, burnRateFn: () => 100})).toBe(0);
  });
});
