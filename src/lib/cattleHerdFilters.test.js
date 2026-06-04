import {describe, it, expect} from 'vitest';
import {
  ageDays,
  ageMonths,
  monthsAgoISO,
  cowTagSet,
  lastWeightFor,
  calfCountFor,
  lastCalvedFor,
  isNonCalvingCow,
  isUnmatchedCalf,
  buildCattlePredicate,
  buildCattleComparator,
  parseSmartFilter,
  mergeObservedValues,
  CATTLE_SORT_KEYS,
  STALE_WEIGHT_DAYS_DEFAULT,
} from './cattleHerdFilters.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const TODAY = new Date('2026-05-02T12:00:00Z').getTime();

function cow(overrides) {
  return {
    id: 'c1',
    tag: '1001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    pct_wagyu: null,
    origin: 'Smith Ranch',
    birth_date: '2022-01-15',
    purchase_date: null,
    dam_tag: null,
    sire_tag: null,
    breeding_status: null,
    old_tags: [],
    ...overrides,
  };
}

function weighIn(tag, weight, enteredAt) {
  return {tag, weight, entered_at: enteredAt};
}

// ── helpers tests ────────────────────────────────────────────────────────────
describe('ageDays / ageMonths', () => {
  it('returns null for missing birth_date', () => {
    expect(ageDays(null, TODAY)).toBe(null);
    expect(ageMonths(null, TODAY)).toBe(null);
  });
  it('returns null for future birth_date', () => {
    expect(ageDays('2099-01-01', TODAY)).toBe(null);
  });
  it('today=birth → 0 days', () => {
    expect(ageDays('2026-05-02', TODAY)).toBe(0);
  });
  it('roughly 4 years 3.5 months for 2022-01-15 against 2026-05-02', () => {
    expect(ageMonths('2022-01-15', TODAY)).toBeGreaterThan(50);
    expect(ageMonths('2022-01-15', TODAY)).toBeLessThan(54);
  });
});

describe('monthsAgoISO', () => {
  it('subtracts calendar months using UTC dates', () => {
    expect(monthsAgoISO(TODAY, 4)).toBe('2026-01-02');
    expect(monthsAgoISO(TODAY, 9)).toBe('2025-08-02');
    expect(monthsAgoISO(TODAY, 30)).toBe('2023-11-02');
  });
  it('clamps end-of-month dates to the target month', () => {
    const mar31 = new Date('2026-03-31T12:00:00Z').getTime();
    expect(monthsAgoISO(mar31, 1)).toBe('2026-02-28');
  });
});

describe('cowTagSet', () => {
  it('current tag only when no old_tags', () => {
    const s = cowTagSet(cow({tag: '1001', old_tags: []}));
    expect([...s]).toEqual(['1001']);
  });
  it('includes weigh_in + manual prior tags', () => {
    const s = cowTagSet(
      cow({
        tag: '1001',
        old_tags: [
          {tag: '900', source: 'weigh_in'},
          {tag: '500', source: 'manual'},
        ],
      }),
    );
    expect([...s].sort()).toEqual(['1001', '500', '900']);
  });
  it("excludes 'import' source — purchase tag from selling farm", () => {
    const s = cowTagSet(
      cow({
        tag: '1001',
        old_tags: [
          {tag: 'PURCH-42', source: 'import'},
          {tag: '900', source: 'weigh_in'},
        ],
      }),
    );
    expect([...s].sort()).toEqual(['1001', '900']);
  });
});

describe('lastWeightFor', () => {
  it('returns null when no weigh-ins', () => {
    expect(lastWeightFor(cow(), [])).toBe(null);
  });
  it('first matching tag in entered_at-desc list wins', () => {
    const wi = [weighIn('1001', 1100, '2026-04-01'), weighIn('1001', 900, '2025-01-01')];
    expect(lastWeightFor(cow({tag: '1001'}), wi)).toBe(1100);
  });
  it('matches against prior weigh_in tags too', () => {
    const wi = [weighIn('900', 850, '2024-06-01')];
    const c = cow({tag: '1001', old_tags: [{tag: '900', source: 'weigh_in'}]});
    expect(lastWeightFor(c, wi)).toBe(850);
  });
});

describe('calfCountFor — Codex 2026-04-29 contract', () => {
  it('sums total_born across calving rows', () => {
    const recs = [
      {dam_tag: '1001', total_born: 2}, // twins
      {dam_tag: '1001', total_born: 1},
      {dam_tag: '2002', total_born: 1},
    ];
    expect(calfCountFor('1001', recs)).toBe(3);
  });
  it('falls back to 1 when total_born is null / 0 / non-numeric', () => {
    const recs = [
      {dam_tag: '1001', total_born: null},
      {dam_tag: '1001', total_born: 0},
      {dam_tag: '1001', total_born: 'three'},
    ];
    expect(calfCountFor('1001', recs)).toBe(3);
  });
  it('returns 0 for empty tag or no records', () => {
    expect(calfCountFor('', [])).toBe(0);
    expect(calfCountFor('1001', [])).toBe(0);
  });
});

describe('lastCalvedFor', () => {
  it('returns max calving_date for the cow', () => {
    const recs = [
      {dam_tag: '1001', calving_date: '2025-03-01'},
      {dam_tag: '1001', calving_date: '2026-02-15'},
      {dam_tag: '2002', calving_date: '2026-04-01'},
    ];
    expect(lastCalvedFor('1001', recs)).toBe('2026-02-15');
  });
  it('returns null when no records', () => {
    expect(lastCalvedFor('1001', [])).toBe(null);
  });
});

// ── predicate tests ─────────────────────────────────────────────────────────
describe('herd exception predicates', () => {
  it('Non Calving Cows = cow/heifer 30mo+ with no calving record in the last 9 months', () => {
    const recs = [
      {dam_tag: 'RECENT', calving_date: '2025-08-02'},
      {dam_tag: 'OLD', calving_date: '2025-08-01'},
    ];

    expect(isNonCalvingCow(cow({tag: 'RECENT', birth_date: '2023-11-02'}), recs, TODAY)).toBe(false);
    expect(isNonCalvingCow(cow({tag: 'OLD', birth_date: '2023-11-02'}), recs, TODAY)).toBe(true);
    expect(isNonCalvingCow(cow({tag: 'NEVER', birth_date: '2023-11-02'}), recs, TODAY)).toBe(true);
    expect(isNonCalvingCow(cow({tag: 'HEIFER', sex: 'heifer', birth_date: '2023-11-02'}), recs, TODAY)).toBe(true);
    expect(isNonCalvingCow(cow({tag: 'YOUNG', birth_date: '2023-11-03'}), recs, TODAY)).toBe(false);
    expect(isNonCalvingCow(cow({tag: 'BULL', sex: 'bull', birth_date: '2020-01-01'}), recs, TODAY)).toBe(false);
    expect(isNonCalvingCow(cow({tag: 'NO-DOB', birth_date: null}), recs, TODAY)).toBe(false);
  });

  it('Unmatched Calves = any sex, recent DOB or no DOB, with no dam_tag', () => {
    expect(isUnmatchedCalf(cow({tag: 'YOUNG', sex: 'steer', birth_date: '2026-01-02', dam_tag: null}), TODAY)).toBe(
      true,
    );
    expect(isUnmatchedCalf(cow({tag: 'NO-DOB', sex: 'bull', birth_date: null, dam_tag: null}), TODAY)).toBe(true);
    expect(isUnmatchedCalf(cow({tag: 'MATCHED', birth_date: '2026-01-02', dam_tag: 'M001'}), TODAY)).toBe(false);
    expect(isUnmatchedCalf(cow({tag: 'OLDER', birth_date: '2026-01-01', dam_tag: null}), TODAY)).toBe(false);
    expect(isUnmatchedCalf(cow({tag: 'FUTURE', birth_date: '2026-06-01', dam_tag: null}), TODAY)).toBe(false);
  });

  it('buildCattlePredicate unions selected exception filters, then composes with normal filters', () => {
    const recs = [{dam_tag: 'RECENT', calving_date: '2025-08-02'}];
    const p = buildCattlePredicate(
      {herdSet: ['mommas'], nonCalvingCows: true, unmatchedCalves: true},
      {todayMs: TODAY, calvingRecs: recs},
    );
    const list = [
      cow({tag: 'NCC', herd: 'mommas', birth_date: '2023-11-02'}),
      cow({tag: 'UC', herd: 'mommas', sex: 'steer', birth_date: '2026-01-02', dam_tag: null}),
      cow({tag: 'RECENT', herd: 'mommas', birth_date: '2023-11-02'}),
      cow({tag: 'OTHER-HERD', herd: 'finishers', sex: 'steer', birth_date: '2026-01-02', dam_tag: null}),
    ];

    expect(list.filter(p).map((c) => c.tag)).toEqual(['NCC', 'UC']);
  });
});

describe('buildCattlePredicate — per dimension', () => {
  const ctx = {todayMs: TODAY, calvingRecs: [], weighIns: []};

  it('herdSet limits to listed herds', () => {
    const p = buildCattlePredicate({herdSet: ['mommas']}, ctx);
    expect(p(cow({herd: 'mommas'}))).toBe(true);
    expect(p(cow({herd: 'finishers'}))).toBe(false);
  });
  it('sex limits to listed sexes', () => {
    const p = buildCattlePredicate({sex: ['heifer']}, ctx);
    expect(p(cow({sex: 'heifer'}))).toBe(true);
    expect(p(cow({sex: 'cow'}))).toBe(false);
  });
  it('ageMonthsRange.min', () => {
    const p = buildCattlePredicate({ageMonthsRange: {min: 18}}, ctx);
    expect(p(cow({birth_date: '2022-01-15'}))).toBe(true); // ~52mo
    expect(p(cow({birth_date: '2025-06-01'}))).toBe(false); // ~11mo
    expect(p(cow({birth_date: null}))).toBe(false); // missing → excluded
  });
  it('ageMonthsRange.max', () => {
    const p = buildCattlePredicate({ageMonthsRange: {max: 12}}, ctx);
    expect(p(cow({birth_date: '2025-06-01'}))).toBe(true);
    expect(p(cow({birth_date: '2022-01-15'}))).toBe(false);
  });
  it('birthDateRange.after / before', () => {
    const p = buildCattlePredicate({birthDateRange: {after: '2024-01-01'}}, ctx);
    expect(p(cow({birth_date: '2025-06-01'}))).toBe(true);
    expect(p(cow({birth_date: '2022-01-15'}))).toBe(false);
  });

  it('calvedStatus yes/no', () => {
    const recs = [{dam_tag: '1001', calving_date: '2025-03-01'}];
    const ctxR = {...ctx, calvingRecs: recs};
    expect(buildCattlePredicate({calvedStatus: 'yes'}, ctxR)(cow({tag: '1001'}))).toBe(true);
    expect(buildCattlePredicate({calvedStatus: 'no'}, ctxR)(cow({tag: '1001'}))).toBe(false);
    expect(buildCattlePredicate({calvedStatus: 'no'}, ctxR)(cow({tag: '9999'}))).toBe(true);
  });

  it('calving-family filters auto-restrict to female sexes (Codex 2026-05-02)', () => {
    // Without this auto-restrict, bulls/steers with no calving rows would
    // leak into "Never calved" / "Not calved this year" / calfCount min=0.
    const ctxR = {todayMs: TODAY, calvingRecs: []};

    // calvedStatus='no' → bull and steer must NOT match even with no records.
    const pNo = buildCattlePredicate({calvedStatus: 'no'}, ctxR);
    expect(pNo(cow({tag: 'B', sex: 'bull'}))).toBe(false);
    expect(pNo(cow({tag: 'S', sex: 'steer'}))).toBe(false);
    expect(pNo(cow({tag: 'H', sex: 'heifer'}))).toBe(true);
    expect(pNo(cow({tag: 'C', sex: 'cow'}))).toBe(true);

    // calvingWindow.noneSince — same restriction.
    const pWindow = buildCattlePredicate({calvingWindow: {mode: 'noneSince', since: '2026-01-01'}}, ctxR);
    expect(pWindow(cow({tag: 'B', sex: 'bull'}))).toBe(false);
    expect(pWindow(cow({tag: 'S', sex: 'steer'}))).toBe(false);
    expect(pWindow(cow({tag: 'H', sex: 'heifer'}))).toBe(true);

    // calfCountRange — same restriction.
    const pCalfMin = buildCattlePredicate({calfCountRange: {min: 0, max: 0}}, ctxR);
    expect(pCalfMin(cow({tag: 'B', sex: 'bull'}))).toBe(false);
    expect(pCalfMin(cow({tag: 'S', sex: 'steer'}))).toBe(false);
    expect(pCalfMin(cow({tag: 'H', sex: 'heifer'}))).toBe(true);

    // lastCalvedRange — same restriction.
    const pRange = buildCattlePredicate({lastCalvedRange: {after: '2025-01-01'}}, ctxR);
    expect(pRange(cow({tag: 'B', sex: 'bull'}))).toBe(false);
    expect(pRange(cow({tag: 'S', sex: 'steer'}))).toBe(false);

    // Sanity: when NO calving-family filter is active, bulls/steers are NOT
    // auto-restricted by accident.
    const pIdle = buildCattlePredicate({}, ctxR);
    expect(pIdle(cow({tag: 'B', sex: 'bull'}))).toBe(true);
  });

  it('calvingWindow.noneSince matches never-calved AND last_calved < since', () => {
    // Three cows: never-calved, calved 2025-03-01 (before 2026-01-01),
    // calved 2026-02-15 (after since).
    const recs = [
      {dam_tag: 'A', calving_date: '2025-03-01'},
      {dam_tag: 'B', calving_date: '2026-02-15'},
    ];
    const p = buildCattlePredicate(
      {calvingWindow: {mode: 'noneSince', since: '2026-01-01'}},
      {...ctx, calvingRecs: recs},
    );
    expect(p(cow({tag: 'A'}))).toBe(true); // calved last year → matches
    expect(p(cow({tag: 'B'}))).toBe(false); // calved this year → excluded
    expect(p(cow({tag: 'NEVER'}))).toBe(true); // never calved → matches
  });

  it('calfCountRange', () => {
    const recs = [
      {dam_tag: '1001', total_born: 2},
      {dam_tag: '1001', total_born: 1},
    ];
    const p = buildCattlePredicate({calfCountRange: {min: 3}}, {...ctx, calvingRecs: recs});
    expect(p(cow({tag: '1001'}))).toBe(true);
    expect(p(cow({tag: '9999'}))).toBe(false);
  });

  it('breedingBlacklist true / false', () => {
    expect(buildCattlePredicate({breedingBlacklist: true}, ctx)(cow({breeding_blacklist: true}))).toBe(true);
    expect(buildCattlePredicate({breedingBlacklist: true}, ctx)(cow({breeding_blacklist: false}))).toBe(false);
    expect(buildCattlePredicate({breedingBlacklist: false}, ctx)(cow({breeding_blacklist: false}))).toBe(true);
  });

  it('breedingStatus including unset', () => {
    const p = buildCattlePredicate({breedingStatus: ['unset']}, ctx);
    expect(p(cow({breeding_status: null}))).toBe(true);
    expect(p(cow({breeding_status: 'OPEN'}))).toBe(false);
    const p2 = buildCattlePredicate({breedingStatus: ['OPEN', 'PREGNANT']}, ctx);
    expect(p2(cow({breeding_status: 'OPEN'}))).toBe(true);
    expect(p2(cow({breeding_status: null}))).toBe(false);
  });

  it('damPresence / sirePresence — independent tri-state', () => {
    expect(buildCattlePredicate({damPresence: 'present'}, ctx)(cow({dam_tag: '500'}))).toBe(true);
    expect(buildCattlePredicate({damPresence: 'present'}, ctx)(cow({dam_tag: null}))).toBe(false);
    expect(buildCattlePredicate({damPresence: 'missing'}, ctx)(cow({dam_tag: null}))).toBe(true);
    expect(buildCattlePredicate({sirePresence: 'missing'}, ctx)(cow({sire_tag: null}))).toBe(true);
    // composing: hasDam AND missingSire (Codex's enumerated 6th state via two-chip composition)
    const p = buildCattlePredicate({damPresence: 'present', sirePresence: 'missing'}, ctx);
    expect(p(cow({dam_tag: '500', sire_tag: null}))).toBe(true);
    expect(p(cow({dam_tag: '500', sire_tag: '600'}))).toBe(false);
    expect(p(cow({dam_tag: null, sire_tag: null}))).toBe(false);
  });

  it('weightTier — 4 distinct states', () => {
    const recentDate = new Date(TODAY - 10 * 86400000).toISOString();
    const oldDate = new Date(TODAY - 200 * 86400000).toISOString();
    // hasWeight = recent and value > 0
    const wiHas = [weighIn('1001', 1200, recentDate)];
    expect(buildCattlePredicate({weightTier: 'hasWeight'}, {...ctx, weighIns: wiHas})(cow({tag: '1001'}))).toBe(true);
    expect(buildCattlePredicate({weightTier: 'noWeight'}, {...ctx, weighIns: wiHas})(cow({tag: '1001'}))).toBe(false);
    expect(buildCattlePredicate({weightTier: 'staleWeight'}, {...ctx, weighIns: wiHas})(cow({tag: '1001'}))).toBe(
      false,
    );
    expect(buildCattlePredicate({weightTier: 'staleOrNoWeight'}, {...ctx, weighIns: wiHas})(cow({tag: '1001'}))).toBe(
      false,
    );

    // staleWeight = has weight but entered_at older than threshold
    const wiStale = [weighIn('1001', 1200, oldDate)];
    expect(buildCattlePredicate({weightTier: 'staleWeight'}, {...ctx, weighIns: wiStale})(cow({tag: '1001'}))).toBe(
      true,
    );
    expect(buildCattlePredicate({weightTier: 'staleOrNoWeight'}, {...ctx, weighIns: wiStale})(cow({tag: '1001'}))).toBe(
      true,
    );
    expect(buildCattlePredicate({weightTier: 'hasWeight'}, {...ctx, weighIns: wiStale})(cow({tag: '1001'}))).toBe(true);

    // noWeight = no entry at all
    expect(buildCattlePredicate({weightTier: 'noWeight'}, ctx)(cow({tag: '9999'}))).toBe(true);
    expect(buildCattlePredicate({weightTier: 'staleOrNoWeight'}, ctx)(cow({tag: '9999'}))).toBe(true);
    expect(buildCattlePredicate({weightTier: 'hasWeight'}, ctx)(cow({tag: '9999'}))).toBe(false);
  });

  it('weightRange', () => {
    const wi = [weighIn('1001', 1200, '2026-04-01')];
    const p = buildCattlePredicate({weightRange: {min: 1000, max: 1300}}, {...ctx, weighIns: wi});
    expect(p(cow({tag: '1001'}))).toBe(true);
    const p2 = buildCattlePredicate({weightRange: {min: 1300}}, {...ctx, weighIns: wi});
    expect(p2(cow({tag: '1001'}))).toBe(false);
  });

  it('breed (case-insensitive) + origin', () => {
    expect(buildCattlePredicate({breed: ['angus']}, ctx)(cow({breed: 'Angus'}))).toBe(true);
    expect(buildCattlePredicate({breed: ['Hereford']}, ctx)(cow({breed: 'Angus'}))).toBe(false);
    expect(buildCattlePredicate({origin: ['smith ranch']}, ctx)(cow({origin: 'Smith Ranch'}))).toBe(true);
  });

  it('wagyuPctRange', () => {
    expect(buildCattlePredicate({wagyuPctRange: {min: 50}}, ctx)(cow({pct_wagyu: 75}))).toBe(true);
    expect(buildCattlePredicate({wagyuPctRange: {min: 50}}, ctx)(cow({pct_wagyu: 25}))).toBe(false);
    expect(buildCattlePredicate({wagyuPctRange: {min: 50}}, ctx)(cow({pct_wagyu: null}))).toBe(false);
  });

  it('textSearch — tag, prior tag (excluding import), dam, breed', () => {
    const c = cow({
      tag: '1001',
      dam_tag: '500',
      breed: 'Black Angus',
      old_tags: [
        {tag: 'PURCH-42', source: 'import'},
        {tag: '900', source: 'weigh_in'},
      ],
    });
    expect(buildCattlePredicate({textSearch: '500'}, ctx)(c)).toBe(true);
    expect(buildCattlePredicate({textSearch: 'angus'}, ctx)(c)).toBe(true);
    expect(buildCattlePredicate({textSearch: '900'}, ctx)(c)).toBe(true); // prior weigh_in tag
    expect(buildCattlePredicate({textSearch: 'PURCH'}, ctx)(c)).toBe(false); // import excluded
    expect(buildCattlePredicate({textSearch: '1001'}, ctx)(c)).toBe(true);
    expect(buildCattlePredicate({textSearch: 'XYZ'}, ctx)(c)).toBe(false);
  });
});

describe('buildCattlePredicate — composition', () => {
  it('AND across 4 dimensions', () => {
    const ctx = {todayMs: TODAY};
    const p = buildCattlePredicate(
      {herdSet: ['mommas'], sex: ['cow'], ageMonthsRange: {min: 24}, breedingBlacklist: false},
      ctx,
    );
    expect(p(cow({herd: 'mommas', sex: 'cow', birth_date: '2022-01-15', breeding_blacklist: false}))).toBe(true);
    expect(p(cow({herd: 'finishers'}))).toBe(false);
    expect(p(cow({herd: 'mommas', sex: 'heifer'}))).toBe(false);
    expect(p(cow({herd: 'mommas', sex: 'cow', birth_date: '2025-06-01'}))).toBe(false);
    expect(p(cow({herd: 'mommas', sex: 'cow', birth_date: '2022-01-15', breeding_blacklist: true}))).toBe(false);
  });
});

// ── comparator tests ────────────────────────────────────────────────────────
describe('buildCattleComparator — per key', () => {
  const ctx = {todayMs: TODAY, calvingRecs: [], weighIns: []};

  it('tag asc / desc — numeric-aware', () => {
    const list = [{tag: '1001'}, {tag: '500'}, {tag: '2002'}];
    const asc = [...list].sort(buildCattleComparator([{key: 'tag', dir: 'asc'}], ctx));
    expect(asc.map((x) => x.tag)).toEqual(['500', '1001', '2002']);
    const desc = [...list].sort(buildCattleComparator([{key: 'tag', dir: 'desc'}], ctx));
    expect(desc.map((x) => x.tag)).toEqual(['2002', '1001', '500']);
  });

  it('tag — empty tag sorts last in both directions', () => {
    const list = [{tag: ''}, {tag: '1001'}, {tag: '500'}];
    const asc = [...list].sort(buildCattleComparator([{key: 'tag', dir: 'asc'}], ctx));
    expect(asc[asc.length - 1].tag).toBe('');
    const desc = [...list].sort(buildCattleComparator([{key: 'tag', dir: 'desc'}], ctx));
    expect(desc[desc.length - 1].tag).toBe('');
  });

  it('age asc = youngest first (newest birth_date)', () => {
    const list = [
      {tag: 'A', birth_date: '2022-01-15'},
      {tag: 'B', birth_date: '2025-06-01'},
      {tag: 'C', birth_date: '2024-03-10'},
    ];
    const asc = [...list].sort(buildCattleComparator([{key: 'age', dir: 'asc'}], ctx));
    expect(asc.map((x) => x.tag)).toEqual(['B', 'C', 'A']); // newest first
  });

  it('age desc = oldest first (oldest birth_date)', () => {
    const list = [
      {tag: 'A', birth_date: '2022-01-15'},
      {tag: 'B', birth_date: '2025-06-01'},
      {tag: 'C', birth_date: '2024-03-10'},
    ];
    const desc = [...list].sort(buildCattleComparator([{key: 'age', dir: 'desc'}], ctx));
    expect(desc.map((x) => x.tag)).toEqual(['A', 'C', 'B']);
  });

  it('age — missing birth_date sorts last regardless of direction', () => {
    const list = [
      {tag: 'A', birth_date: '2022-01-15'},
      {tag: 'B', birth_date: null},
      {tag: 'C', birth_date: '2024-03-10'},
    ];
    const asc = [...list].sort(buildCattleComparator([{key: 'age', dir: 'asc'}], ctx));
    expect(asc[asc.length - 1].tag).toBe('B');
    const desc = [...list].sort(buildCattleComparator([{key: 'age', dir: 'desc'}], ctx));
    expect(desc[desc.length - 1].tag).toBe('B');
  });

  it('lastWeight asc = lightest first; missing sorts last', () => {
    const wi = [weighIn('A', 1200, '2026-04-01'), weighIn('B', 900, '2026-04-01'), weighIn('C', 1500, '2026-04-01')];
    const list = [{tag: 'A'}, {tag: 'B'}, {tag: 'C'}, {tag: 'D'}]; // D has no weigh-in
    const asc = [...list].sort(buildCattleComparator([{key: 'lastWeight', dir: 'asc'}], {...ctx, weighIns: wi}));
    expect(asc.map((x) => x.tag)).toEqual(['B', 'A', 'C', 'D']);
    const desc = [...list].sort(buildCattleComparator([{key: 'lastWeight', dir: 'desc'}], {...ctx, weighIns: wi}));
    expect(desc.map((x) => x.tag)).toEqual(['C', 'A', 'B', 'D']);
  });

  it('herd asc — locked order (mommas, backgrounders, finishers, bulls, processed, deceased, sold)', () => {
    const list = [{herd: 'finishers'}, {herd: 'mommas'}, {herd: 'sold'}, {herd: 'bulls'}];
    const asc = [...list].sort(buildCattleComparator([{key: 'herd', dir: 'asc'}], ctx));
    expect(asc.map((x) => x.herd)).toEqual(['mommas', 'finishers', 'bulls', 'sold']);
  });

  it('calfCount asc — fewest first (0 first)', () => {
    const recs = [
      {dam_tag: 'A', total_born: 2},
      {dam_tag: 'A', total_born: 1},
      {dam_tag: 'B', total_born: 1},
    ];
    const list = [{tag: 'A'}, {tag: 'B'}, {tag: 'C'}];
    const asc = [...list].sort(buildCattleComparator([{key: 'calfCount', dir: 'asc'}], {...ctx, calvingRecs: recs}));
    expect(asc.map((x) => x.tag)).toEqual(['C', 'B', 'A']); // 0, 1, 3
  });
});

describe('buildCattleComparator — composition', () => {
  it('primary sex + secondary age tie-break', () => {
    const list = [
      {tag: 'A', sex: 'cow', birth_date: '2022-01-15'},
      {tag: 'B', sex: 'heifer', birth_date: '2025-06-01'},
      {tag: 'C', sex: 'cow', birth_date: '2024-03-10'},
    ];
    const sorted = [...list].sort(
      buildCattleComparator(
        [
          {key: 'sex', dir: 'asc'},
          {key: 'age', dir: 'asc'},
        ],
        {todayMs: TODAY},
      ),
    );
    // sex asc: cow before heifer. Within cows: age asc = newest first.
    expect(sorted.map((x) => x.tag)).toEqual(['C', 'A', 'B']);
  });

  it('herd in sort list is harmless when not the primary effect', () => {
    const list = [
      {tag: 'A', herd: 'finishers', birth_date: '2024-01-01'},
      {tag: 'B', herd: 'finishers', birth_date: '2025-01-01'},
    ];
    const sorted = [...list].sort(
      buildCattleComparator(
        [
          {key: 'herd', dir: 'asc'},
          {key: 'age', dir: 'asc'},
        ],
        {todayMs: TODAY},
      ),
    );
    expect(sorted.map((x) => x.tag)).toEqual(['B', 'A']);
  });

  it('unknown sort key is silently dropped', () => {
    const list = [{tag: 'A'}, {tag: 'B'}];
    expect(() => [...list].sort(buildCattleComparator([{key: 'bogus', dir: 'asc'}], {}))).not.toThrow();
  });

  it('CATTLE_SORT_KEYS is the parser/comparator ground truth', () => {
    expect(CATTLE_SORT_KEYS).toContain('age');
    expect(CATTLE_SORT_KEYS).toContain('lastWeight');
  });
});

// ── parseSmartFilter tests ──────────────────────────────────────────────────
describe('parseSmartFilter — Codex worked examples', () => {
  it('"heffers older then 18 months" → sex=heifer + ageMonthsRange.min=18', () => {
    const p = parseSmartFilter('heffers older then 18 months', {todayMs: TODAY});
    expect(p.chips.sex).toEqual(['heifer']);
    expect(p.chips.ageMonthsRange).toEqual({min: 18});
    expect(p.confidence).toBe('high');
    expect(p.unmapped).toEqual([]);
  });

  it('"mommas havent calvd this year" → herdSet=[mommas] + calvingWindow.noneSince(<thisYear>-01-01)', () => {
    const p = parseSmartFilter('mommas havent calvd this year', {todayMs: TODAY});
    expect(p.chips.herdSet).toEqual(['mommas']);
    expect(p.chips.calvingWindow).toEqual({mode: 'noneSince', since: '2026-01-01'});
    // Note about date interpretation surfaces in preview banner
    expect(p.notes.some((n) => /no calving since/i.test(n))).toBe(true);
  });

  it('"finishrs stale wait" → herdSet=[finishers] + weightTier=staleWeight', () => {
    const p = parseSmartFilter('finishrs stale wait', {todayMs: TODAY});
    expect(p.chips.herdSet).toEqual(['finishers']);
    expect(p.chips.weightTier).toBe('staleWeight');
    expect(p.confidence).toBe('high');
  });

  it('"blacklisted angis cows" → blacklist + breed Angus (fuzzy) + sex cow; medium confidence', () => {
    const breedOptions = [{label: 'Angus'}, {label: 'Hereford'}, {label: 'Black Angus'}];
    const p = parseSmartFilter('blacklisted angis cows', {todayMs: TODAY, breedOptions});
    expect(p.chips.breedingBlacklist).toBe(true);
    expect(p.chips.breed).toEqual(['Angus']);
    expect(p.chips.sex).toEqual(['cow']);
    expect(p.confidence).toBe('medium');
    expect(p.notes.some((n) => /angis.*Angus/i.test(n))).toBe(true);
  });
});

describe('parseSmartFilter — sort vs filter (Codex amendment 5)', () => {
  it('"oldest heifers first" → sex=heifer + sort age desc', () => {
    const p = parseSmartFilter('oldest heifers first', {todayMs: TODAY});
    expect(p.chips.sex).toEqual(['heifer']);
    expect(p.sortRules).toEqual([{key: 'age', dir: 'desc'}]);
  });
  it('"old heifers" (no anchor, no sort phrase) → sex=heifer; "old" lands in unmapped', () => {
    const p = parseSmartFilter('old heifers', {todayMs: TODAY});
    expect(p.chips.sex).toEqual(['heifer']);
    expect(p.chips.ageMonthsRange).toBeUndefined();
    expect(p.sortRules).toEqual([]);
    expect(p.unmapped).toContain('old');
    expect(p.confidence).toBe('medium');
  });
  it('"youngest first" alone → sortRules only, no chips', () => {
    const p = parseSmartFilter('youngest first', {todayMs: TODAY});
    expect(p.sortRules).toEqual([{key: 'age', dir: 'asc'}]);
    expect(Object.keys(p.chips)).toEqual([]);
  });
});

describe('parseSmartFilter — weight phrase mapping (4 distinct states)', () => {
  it('"stale weight" → staleWeight', () => {
    expect(parseSmartFilter('stale weight').chips.weightTier).toBe('staleWeight');
  });
  it('"no weight" → noWeight', () => {
    expect(parseSmartFilter('no weight').chips.weightTier).toBe('noWeight');
  });
  it('"no recent weight" → staleOrNoWeight (matched before "no weight")', () => {
    expect(parseSmartFilter('no recent weight').chips.weightTier).toBe('staleOrNoWeight');
  });
  it('"weighed" → hasWeight', () => {
    expect(parseSmartFilter('weighed').chips.weightTier).toBe('hasWeight');
  });
});

describe('parseSmartFilter — lineage two-chip composition', () => {
  it('"orphan" → both damPresence + sirePresence missing', () => {
    const p = parseSmartFilter('orphan');
    expect(p.chips.damPresence).toBe('missing');
    expect(p.chips.sirePresence).toBe('missing');
  });
  it('"missing sire" → sirePresence=missing only', () => {
    const p = parseSmartFilter('missing sire');
    expect(p.chips.sirePresence).toBe('missing');
    expect(p.chips.damPresence).toBeUndefined();
  });
  it('"known parents" → both present', () => {
    const p = parseSmartFilter('known parents');
    expect(p.chips.damPresence).toBe('present');
    expect(p.chips.sirePresence).toBe('present');
  });
});

describe('parseSmartFilter — edge cases', () => {
  it('empty / whitespace input → low confidence, empty chips', () => {
    expect(parseSmartFilter('').chips).toEqual({});
    expect(parseSmartFilter('').confidence).toBe('low');
    expect(parseSmartFilter('   ').chips).toEqual({});
  });
  it('unknown gibberish → low confidence', () => {
    const p = parseSmartFilter('xyzzy plugh', {todayMs: TODAY});
    expect(p.confidence).toBe('low');
    expect(Object.keys(p.chips)).toEqual([]);
  });
  it('contradictory ranges → low confidence + empty chips', () => {
    const p = parseSmartFilter('older than 24 months younger than 12 months', {todayMs: TODAY});
    expect(p.confidence).toBe('low');
    expect(p.chips.ageMonthsRange).toBeUndefined();
    expect(p.notes.some((n) => /contradictory/i.test(n))).toBe(true);
  });
  it('"never calved" → calvedStatus=no; "calved" alone → calvedStatus=yes', () => {
    expect(parseSmartFilter('never calved').chips.calvedStatus).toBe('no');
    expect(parseSmartFilter('has calved').chips.calvedStatus).toBe('yes');
  });
  it('"havent calved this year" wins over plain "havent calved" — calvingWindow set, not calvedStatus', () => {
    const p = parseSmartFilter('havent calved this year', {todayMs: TODAY});
    expect(p.chips.calvingWindow).toEqual({mode: 'noneSince', since: '2026-01-01'});
    expect(p.chips.calvedStatus).toBeUndefined();
  });
  it('years unit → converts to months', () => {
    const p = parseSmartFilter('older than 2 years', {todayMs: TODAY});
    expect(p.chips.ageMonthsRange).toEqual({min: 24});
  });
});

// ── breed/origin observed-value merge ──────────────────────────────────────
describe('mergeObservedValues — Codex amendment 3', () => {
  it('historical strings on cattle records remain filterable', () => {
    const active = [{label: 'Angus'}, {label: 'Hereford'}];
    const observed = ['Angus', 'Heritage Wagyu', 'Brahman']; // "Heritage Wagyu" no longer active
    const merged = mergeObservedValues(active, observed);
    const labels = merged.map((m) => m.label);
    expect(labels).toContain('Angus');
    expect(labels).toContain('Hereford');
    expect(labels).toContain('Heritage Wagyu');
    expect(labels).toContain('Brahman');
  });
  it('flags historical values with source=historical', () => {
    const active = [{label: 'Angus'}];
    const merged = mergeObservedValues(active, ['Angus', 'Heritage Wagyu']);
    expect(merged.find((m) => m.label === 'Angus').source).toBe('active');
    expect(merged.find((m) => m.label === 'Heritage Wagyu').source).toBe('historical');
  });
  it('case-insensitive dedup', () => {
    const active = [{label: 'Angus'}];
    const merged = mergeObservedValues(active, ['angus']);
    expect(merged).toHaveLength(1);
  });
  it('inactive option rows are excluded from the active pass (Codex 2026-05-02)', () => {
    // Without the active===false skip, retired breeds appear as filter
    // choices even when no live cow uses them.
    const options = [
      {label: 'Angus', active: true},
      {label: 'Retired Heritage', active: false},
    ];
    const merged = mergeObservedValues(options, []);
    expect(merged.map((m) => m.label)).toEqual(['Angus']);
  });
  it('inactive option row IS included when observed on a cow (historical)', () => {
    const options = [
      {label: 'Angus', active: true},
      {label: 'Retired Heritage', active: false},
    ];
    const merged = mergeObservedValues(options, ['Retired Heritage']);
    const labels = merged.map((m) => m.label);
    expect(labels).toContain('Angus');
    expect(labels).toContain('Retired Heritage');
    expect(merged.find((m) => m.label === 'Retired Heritage').source).toBe('historical');
  });
  it('option rows with active === undefined are treated as active (back-compat)', () => {
    const options = [{label: 'Angus'}]; // no `active` key — pre-existing pattern
    const merged = mergeObservedValues(options, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('active');
  });
});

describe('STALE_WEIGHT_DAYS_DEFAULT — locked default', () => {
  it('is 90 days', () => {
    expect(STALE_WEIGHT_DAYS_DEFAULT).toBe(90);
  });
});
