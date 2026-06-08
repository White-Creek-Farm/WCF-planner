import {describe, it, expect} from 'vitest';
import {
  SHEEP_FLOCK_KEYS,
  SHEEP_OUTCOME_KEYS,
  SHEEP_SORT_KEYS,
  ageMonths,
  sheepTagSet,
  lastWeightFor,
  buildLambingEvidence,
  lambCountFor,
  lastLambedFor,
  buildSheepPredicate,
  buildSheepComparator,
  mergeObservedSheepValues,
} from './sheepFlockFilters.js';

const TODAY = new Date('2026-06-08T12:00:00Z').getTime();

function ewe(overrides = {}) {
  return {
    id: 's1',
    tag: '1001',
    sex: 'ewe',
    flock: 'ewes',
    breed: 'Katahdin',
    origin: 'North pasture',
    birth_date: '2023-01-15',
    dam_tag: null,
    dam_reg_num: null,
    sire_tag: null,
    sire_reg_num: null,
    breeding_status: null,
    breeding_blacklist: false,
    maternal_issue_flag: false,
    old_tags: [],
    ...overrides,
  };
}

function weighIn(tag, weight, enteredAt) {
  return {tag, weight, entered_at: enteredAt};
}

describe('sheep flock filter constants', () => {
  it('keeps active flocks and outcomes separate', () => {
    expect(SHEEP_FLOCK_KEYS).toEqual(['rams', 'ewes', 'feeders']);
    expect(SHEEP_OUTCOME_KEYS).toEqual(['processed', 'deceased', 'sold']);
  });

  it('exposes ordered sort keys for the Sheep Flocks UI', () => {
    expect(SHEEP_SORT_KEYS).toEqual([
      'tag',
      'age',
      'lastWeight',
      'flock',
      'sex',
      'lastLambed',
      'lambCount',
      'breed',
      'origin',
      'breedingStatus',
    ]);
  });
});

describe('sheep identity + weight helpers', () => {
  it('ageMonths is stable from UTC noon dates', () => {
    expect(ageMonths('2026-06-08', TODAY)).toBe(0);
    expect(ageMonths('2023-01-15', TODAY)).toBeGreaterThan(40);
  });

  it('sheepTagSet includes current and non-import prior tags', () => {
    const tags = sheepTagSet(
      ewe({
        tag: '1001',
        old_tags: [
          {tag: 'A-1', source: 'manual'},
          {tag: 'PURCH-1', source: 'import'},
          {tag: 'WI-1', source: 'weigh_in'},
        ],
      }),
    );
    expect([...tags].sort()).toEqual(['1001', 'A-1', 'WI-1']);
  });

  it('lastWeightFor reads the first matching entered_at-desc weigh-in', () => {
    const row = ewe({tag: '1001', old_tags: [{tag: 'OLD-1', source: 'weigh_in'}]});
    expect(lastWeightFor(row, [weighIn('OLD-1', 155, '2026-05-01'), weighIn('1001', 140, '2025-01-01')])).toBe(155);
  });
});

describe('lambing evidence', () => {
  it('sums total_born with a fallback of 1 per row', () => {
    const rows = [
      {dam_tag: 'E1', total_born: 2},
      {dam_tag: 'E1', total_born: 0},
      {dam_tag: 'E2', total_born: 1},
    ];
    expect(lambCountFor('E1', rows)).toBe(3);
  });

  it('adds linked lamb sheep rows when explicit lambing rows are absent', () => {
    const dam = ewe({id: 'dam', tag: 'E1'});
    const lamb = ewe({id: 'lamb-1', tag: 'L1', sex: 'lamb', flock: 'feeders', dam_tag: 'E1', birth_date: '2026-03-01'});
    const evidence = buildLambingEvidence([dam, lamb], []);
    expect(lambCountFor('E1', evidence)).toBe(1);
    expect(lastLambedFor('E1', evidence)).toBe('2026-03-01');
  });

  it('does not duplicate lamb rows already referenced by lamb_id or lamb_tag', () => {
    const lamb = ewe({id: 'lamb-1', tag: 'L1', sex: 'lamb', dam_tag: 'E1', birth_date: '2026-03-01'});
    const evidence = buildLambingEvidence(
      [lamb],
      [{id: 'lr-1', dam_tag: 'E1', lamb_id: 'lamb-1', lamb_tag: 'L1', lambing_date: '2026-03-01', total_born: 1}],
    );
    expect(evidence).toHaveLength(1);
    expect(lambCountFor('E1', evidence)).toBe(1);
  });
});

describe('buildSheepPredicate', () => {
  const rows = [
    ewe({tag: 'E1', flock: 'ewes', sex: 'ewe', breed: 'Katahdin', origin: 'Farm A', birth_date: '2022-01-01'}),
    ewe({tag: 'R1', flock: 'rams', sex: 'ram', breed: 'Dorper', origin: 'Farm B', birth_date: '2024-01-01'}),
    ewe({tag: 'F1', flock: 'feeders', sex: 'lamb', breed: 'Katahdin', dam_tag: 'E1', birth_date: '2026-03-01'}),
  ];
  const lambingRows = [{dam_tag: 'E1', lambing_date: '2026-03-01', total_born: 2}];
  const weighIns = [weighIn('E1', 170, '2026-06-01'), weighIn('R1', 220, '2025-01-01')];

  it('composes flock, sex, breed, origin, and text search filters', () => {
    const pred = buildSheepPredicate(
      {flockSet: ['ewes'], sex: ['ewe'], breed: ['Katahdin'], origin: ['Farm A'], textSearch: 'E1'},
      {todayMs: TODAY, lambingRows, weighIns},
    );
    expect(rows.filter(pred).map((r) => r.tag)).toEqual(['E1']);
  });

  it('lambing-family filters are ewe-only', () => {
    const pred = buildSheepPredicate({lambedStatus: 'no'}, {todayMs: TODAY, lambingRows, weighIns});
    expect(pred(rows[1])).toBe(false);
    expect(pred(rows[2])).toBe(false);
  });

  it('filters by lamb count and last lambed range', () => {
    const pred = buildSheepPredicate(
      {lambCountRange: {min: 2}, lastLambedRange: {after: '2026-01-01'}},
      {todayMs: TODAY, lambingRows, weighIns},
    );
    expect(rows.filter(pred).map((r) => r.tag)).toEqual(['E1']);
  });

  it('filters weight tiers using stale threshold', () => {
    const stale = buildSheepPredicate(
      {weightTier: 'staleWeight'},
      {todayMs: TODAY, lambingRows, weighIns, staleDaysThreshold: 90},
    );
    expect(rows.filter(stale).map((r) => r.tag)).toEqual(['R1']);
  });
});

describe('buildSheepComparator', () => {
  it('applies ordered sort rules with missing values last', () => {
    const rows = [
      ewe({tag: '20', breed: 'B', birth_date: '2024-01-01'}),
      ewe({tag: '3', breed: 'A', birth_date: '2022-01-01'}),
      ewe({tag: '', breed: 'A', birth_date: null}),
    ];
    const sorted = [...rows].sort(
      buildSheepComparator([
        {key: 'breed', dir: 'asc'},
        {key: 'tag', dir: 'asc'},
      ]),
    );
    expect(sorted.map((r) => r.tag)).toEqual(['3', '', '20']);
  });

  it('sorts by lamb count and last lambed', () => {
    const rows = [ewe({tag: 'A'}), ewe({tag: 'B'})];
    const lambingRows = [
      {dam_tag: 'A', lambing_date: '2026-02-01', total_born: 1},
      {dam_tag: 'B', lambing_date: '2026-03-01', total_born: 3},
    ];
    const sorted = [...rows].sort(buildSheepComparator([{key: 'lambCount', dir: 'desc'}], {lambingRows}));
    expect(sorted.map((r) => r.tag)).toEqual(['B', 'A']);
  });
});

describe('mergeObservedSheepValues', () => {
  it('merges active configured options with historical observed values', () => {
    expect(
      mergeObservedSheepValues(
        [
          {label: 'Katahdin', active: true},
          {label: 'Retired', active: false},
        ],
        ['Dorper', 'Retired', 'Katahdin'],
      ).map((x) => x.label),
    ).toEqual(['Dorper', 'Katahdin', 'Retired']);
  });
});
