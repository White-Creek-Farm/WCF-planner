import {describe, it, expect} from 'vitest';
import {daysToMWD, cycleRecords, calcAgeRange, activePigFeederDailyTargets} from './pig.js';

describe('daysToMWD', () => {
  it('returns null for 0 or negative day counts', () => {
    expect(daysToMWD(0)).toBeNull();
    expect(daysToMWD(-5)).toBeNull();
  });

  it('formats whole-month boundaries with zero weeks', () => {
    expect(daysToMWD(30)).toBe('1m 0w');
    expect(daysToMWD(60)).toBe('2m 0w');
  });

  it('formats partial-month durations as months + weeks', () => {
    expect(daysToMWD(37)).toBe('1m 1w'); // 30 + 7
    expect(daysToMWD(96)).toBe('3m 0w'); // 90 + 6 (drops <7d remainder)
  });

  it('drops days below one week', () => {
    expect(daysToMWD(35)).toBe('1m 0w'); // 30 + 5 → no extra week
    expect(daysToMWD(43)).toBe('1m 1w'); // 30 + 13 → 1 week
  });
});

describe('cycleRecords', () => {
  // exposureStart 2026-01-01 puts the farrowing window at 2026-04-27 → 2026-06-10
  // (GESTATION_DAYS=116 plus the 45-day boar window).
  const cycle = {id: 'c1', group: '1', exposureStart: '2026-01-01'};

  it('returns empty when cycle, exposureStart, or farrowingRecs are missing', () => {
    expect(cycleRecords(null, [])).toEqual([]);
    expect(cycleRecords({id: 'x', group: '1'}, [])).toEqual([]);
    expect(cycleRecords(cycle, null)).toEqual([]);
  });

  it('keeps records inside the theoretical farrowing window', () => {
    const recs = [
      {id: 'r1', group: '1', farrowingDate: '2026-05-01'}, // inside
      {id: 'r2', group: '1', farrowingDate: '2026-04-27'}, // window start
      {id: 'r3', group: '1', farrowingDate: '2026-06-10'}, // window end
    ];
    expect(cycleRecords(cycle, recs).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('excludes records before the window or after the buffer', () => {
    const recs = [
      {id: 'early', group: '1', farrowingDate: '2026-04-01'}, // before window
      {id: 'late', group: '1', farrowingDate: '2026-07-01'}, // beyond +14d buffer
    ];
    expect(cycleRecords(cycle, recs)).toEqual([]);
  });

  it('keeps records within the 14-day post-window buffer', () => {
    expect(cycleRecords(cycle, [{id: 'buf', group: '1', farrowingDate: '2026-06-24'}]).map((r) => r.id)).toEqual([
      'buf',
    ]);
  });

  it('rejects records from a different group', () => {
    expect(cycleRecords(cycle, [{id: 'wrong-group', group: '2', farrowingDate: '2026-05-01'}])).toEqual([]);
  });

  it('rejects records missing farrowingDate', () => {
    expect(cycleRecords(cycle, [{id: 'no-date', group: '1'}])).toEqual([]);
  });
});

describe('calcAgeRange', () => {
  const cycle = {id: 'c1', group: '1', exposureStart: '2026-01-01', sowCount: 12};

  it('returns the dash placeholder when the cycle is unknown', () => {
    expect(calcAgeRange('missing', null, [], [])).toEqual({
      text: '—',
      hasActual: false,
      count: 0,
      total: 0,
      minDays: null,
      maxDays: null,
    });
  });

  it('returns the dash placeholder when exposureStart is missing', () => {
    const out = calcAgeRange('c1', null, [{id: 'c1', group: '1'}], []);
    expect(out.text).toBe('—');
    expect(out.hasActual).toBe(false);
  });

  it('uses the theoretical farrowing window when no records exist (estimated suffix)', () => {
    // Pin asOfDate to 2026-08-01 so the test does not drift with "today".
    const out = calcAgeRange('c1', new Date('2026-08-01T12:00:00'), [cycle], []);
    expect(out.hasActual).toBe(false);
    expect(out.count).toBe(0);
    expect(out.total).toBe(12);
    expect(out.text.endsWith('(est.)')).toBe(true);
    // Window 2026-04-27 → 2026-06-10. From 2026-08-01:
    //   oldestDays  ≈ 96 → "3m 0w"
    //   youngestDays ≈ 52 → "1m 3w"
    expect(out.text).toMatch(/^1m 3w – 3m 0w \(est\.\)$/);
  });

  it('uses actual farrowing records when present (no estimated suffix)', () => {
    const recs = [{id: 'r1', group: '1', farrowingDate: '2026-05-01'}];
    const out = calcAgeRange('c1', new Date('2026-08-01T12:00:00'), [cycle], recs);
    expect(out.hasActual).toBe(true);
    expect(out.count).toBe(1);
    expect(out.text.endsWith('(est.)')).toBe(false);
    // Single date → first === last; from 2026-08-01 to 2026-05-01 = 92 days → "3m 0w"
    expect(out.text).toBe('3m 0w – 3m 0w');
  });

  it('renders "Not yet born" when ref is before any farrowing date', () => {
    const recs = [{id: 'r1', group: '1', farrowingDate: '2026-05-01'}];
    const out = calcAgeRange('c1', new Date('2026-04-15T12:00:00'), [cycle], recs);
    expect(out.text).toBe('Not yet born');
    expect(out.hasActual).toBe(true);
    expect(out.count).toBe(1);
    expect(out.total).toBe(12);
  });

  it('renders "Up to <oldest>" when newest pigs have not yet been born', () => {
    const recs = [
      {id: 'r1', group: '1', farrowingDate: '2026-05-01'},
      {id: 'r2', group: '1', farrowingDate: '2026-06-05'},
    ];
    const out = calcAgeRange('c1', new Date('2026-05-15T12:00:00'), [cycle], recs);
    // oldest 14d > 0, youngest negative → "Up to 0m 2w"
    expect(out.text).toBe('Up to 0m 2w');
    expect(out.hasActual).toBe(true);
  });

  it('respects the pinned asOfDate (does not advance with "now")', () => {
    const recs = [{id: 'r1', group: '1', farrowingDate: '2026-05-01'}];
    const a = calcAgeRange('c1', new Date('2026-08-01T12:00:00'), [cycle], recs);
    const b = calcAgeRange('c1', new Date('2026-08-01T12:00:00'), [cycle], recs);
    expect(a.text).toBe(b.text);
  });

  it('returns numeric minDays/maxDays for the planned-trip projector', () => {
    // exposureStart 2026-01-01 → theoretical window 2026-04-27..2026-06-10.
    // Pin asOfDate to 2026-08-01.
    const out = calcAgeRange('c1', new Date('2026-08-01T12:00:00'), [cycle], []);
    // youngestDays ≈ 52, oldestDays ≈ 96 with the theoretical window.
    expect(out.minDays).toBe(52);
    expect(out.maxDays).toBe(96);
  });

  it('clamps minDays to 0 when youngest pigs are still unborn (Up-to case)', () => {
    const recs = [
      {id: 'r1', group: '1', farrowingDate: '2026-05-01'},
      {id: 'r2', group: '1', farrowingDate: '2026-06-05'},
    ];
    const out = calcAgeRange('c1', new Date('2026-05-15T12:00:00'), [cycle], recs);
    // oldest 14d, youngest negative → clamp youngest to 0.
    expect(out.minDays).toBe(0);
    expect(out.maxDays).toBe(14);
  });

  it('returns null minDays/maxDays when entire cycle is not yet born', () => {
    const recs = [{id: 'r1', group: '1', farrowingDate: '2026-05-01'}];
    const out = calcAgeRange('c1', new Date('2026-04-15T12:00:00'), [cycle], recs);
    expect(out.text).toBe('Not yet born');
    expect(out.minDays).toBeNull();
    expect(out.maxDays).toBeNull();
  });
});

describe('activePigFeederDailyTargets', () => {
  it('returns [] for empty/missing feeder groups', () => {
    expect(activePigFeederDailyTargets(undefined)).toEqual([]);
    expect(activePigFeederDailyTargets(null)).toEqual([]);
    expect(activePigFeederDailyTargets([])).toEqual([]);
  });

  it('excludes an active parent feeder group with NO sub-batches (the P-27-01 symptom)', () => {
    const groups = [{id: 'g1', batchName: 'P-27-01', status: 'active', subBatches: []}];
    expect(activePigFeederDailyTargets(groups)).toEqual([]);
  });

  it('excludes an active parent feeder group whose subBatches key is absent', () => {
    const groups = [{id: 'g1', batchName: 'P-27-01', status: 'active'}];
    expect(activePigFeederDailyTargets(groups)).toEqual([]);
  });

  it('includes active sub-batches of an active parent, with id/name/parentBatchName', () => {
    const groups = [
      {
        id: 'g1',
        batchName: 'P-26-01',
        status: 'active',
        subBatches: [
          {id: 'a', name: 'P-26-01A', status: 'active'},
          {id: 'b', name: 'P-26-01B', status: 'active'},
        ],
      },
    ];
    expect(activePigFeederDailyTargets(groups)).toEqual([
      {id: 'a', name: 'P-26-01A', parentBatchName: 'P-26-01'},
      {id: 'b', name: 'P-26-01B', parentBatchName: 'P-26-01'},
    ]);
  });

  it('excludes processed/inactive sub-batches', () => {
    const groups = [
      {
        id: 'g1',
        batchName: 'P-26-01',
        status: 'active',
        subBatches: [
          {id: 'a', name: 'P-26-01A', status: 'active'},
          {id: 'b', name: 'P-26-01B', status: 'processed'},
        ],
      },
    ];
    expect(activePigFeederDailyTargets(groups)).toEqual([{id: 'a', name: 'P-26-01A', parentBatchName: 'P-26-01'}]);
  });

  it('returns [] when an active parent has sub-batches but all are inactive', () => {
    const groups = [
      {
        id: 'g1',
        batchName: 'P-26-01',
        status: 'active',
        subBatches: [{id: 'a', name: 'P-26-01A', status: 'processed'}],
      },
    ];
    expect(activePigFeederDailyTargets(groups)).toEqual([]);
  });

  it('excludes sub-batches of an inactive parent feeder group', () => {
    const groups = [
      {
        id: 'g1',
        batchName: 'P-25-09',
        status: 'archived',
        subBatches: [{id: 'a', name: 'P-25-09A', status: 'active'}],
      },
    ];
    expect(activePigFeederDailyTargets(groups)).toEqual([]);
  });

  it('preserves feeder-group order then sub order across multiple groups', () => {
    const groups = [
      {id: 'g1', batchName: 'B1', status: 'active', subBatches: [{id: 'a', name: 'B1A', status: 'active'}]},
      {id: 'g2', batchName: 'B2', status: 'active', subBatches: []},
      {
        id: 'g3',
        batchName: 'B3',
        status: 'active',
        subBatches: [
          {id: 'c', name: 'B3A', status: 'active'},
          {id: 'd', name: 'B3B', status: 'active'},
        ],
      },
    ];
    expect(activePigFeederDailyTargets(groups).map((t) => t.name)).toEqual(['B1A', 'B3A', 'B3B']);
  });
});
