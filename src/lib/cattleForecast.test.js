import {describe, it, expect} from 'vitest';
import {
  monthKey,
  monthStartMs,
  parseMonthKey,
  monthsInHorizon,
  monthsForAssignment,
  monthLabel,
  dateToMonthKey,
  cowWeighInHistory,
  computeLast3ADG,
  computeLast2ADG,
  resolveADGForCow,
  eligibilityFor,
  isHeiferEligibleForInclude,
  projectedWeightAtMonth,
  findFirstEligibleUnhiddenMonth,
  buildForecast,
  parseBatchName,
  formatBatchName,
  highestStoredNumberForYear,
  nextRealBatchName,
  buildVirtualBatchNames,
  validateRealBatchRename,
  checkProcessorGate,
  batchHasAllHangingWeights,
  batchMissingHangingTags,
  ADG_SOURCES,
  WATCHLIST_REASONS,
  FORECAST_FALLBACK_ADG_DEFAULT,
  FORECAST_BIRTH_WEIGHT_LB_DEFAULT,
  FORECAST_DISPLAY_WEIGHT_MIN_DEFAULT,
  FORECAST_DISPLAY_WEIGHT_MAX_DEFAULT,
} from './cattleForecast.js';

const TODAY = new Date('2026-05-02T12:00:00Z').getTime();

function cow(overrides) {
  return {
    id: 'c1',
    tag: '1001',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Angus',
    breeding_blacklist: false,
    pct_wagyu: null,
    origin: 'Smith Ranch',
    birth_date: '2024-08-01',
    purchase_date: null,
    dam_tag: null,
    sire_tag: null,
    breeding_status: null,
    old_tags: [],
    ...overrides,
  };
}

function wi(tag, weight, isoDateTime) {
  return {tag, weight, entered_at: isoDateTime};
}

// ── month / horizon helpers ──────────────────────────────────────────────────
describe('monthsForAssignment — Codex 2026-05-04 finding #1 lock', () => {
  it('starts at the CURRENT month, not January, so backward projections cannot land in past months', () => {
    // TODAY = 2026-05-02 → first assignment month = 2026-05.
    const months = monthsForAssignment(TODAY, 3);
    expect(months[0]).toBe('2026-05');
    expect(months).not.toContain('2026-01');
    expect(months).not.toContain('2026-04');
    expect(months[months.length - 1]).toBe('2029-12');
  });
  it('rollover-forward: as today advances, past months drop out of assignment', () => {
    const aug15 = new Date('2026-08-15T12:00:00Z').getTime();
    const months = monthsForAssignment(aug15, 1);
    expect(months[0]).toBe('2026-08');
    expect(months).not.toContain('2026-07');
  });
});

describe('monthKey + parseMonthKey + monthsInHorizon', () => {
  it('formats and parses cleanly', () => {
    expect(monthKey(2026, 5)).toBe('2026-05');
    expect(parseMonthKey('2026-05')).toEqual({year: 2026, month: 5});
    expect(parseMonthKey('bogus')).toBe(null);
  });
  it('horizon = current year + N years, full months each', () => {
    const months = monthsInHorizon(TODAY, 3);
    expect(months[0]).toBe('2026-01');
    expect(months[months.length - 1]).toBe('2029-12');
    expect(months.length).toBe(48);
  });
  it('monthLabel returns "Mon YYYY"', () => {
    expect(monthLabel('2026-05')).toBe('May 2026');
  });
  it('dateToMonthKey extracts YYYY-MM', () => {
    expect(dateToMonthKey('2026-08-15')).toBe('2026-08');
    expect(dateToMonthKey(null)).toBe(null);
  });
});

// ── cowWeighInHistory ────────────────────────────────────────────────────────
describe('cowWeighInHistory', () => {
  it('returns [] when no weigh-ins match', () => {
    expect(cowWeighInHistory(cow(), [])).toEqual([]);
  });
  it('sorts desc by entered_at and includes prior weigh_in tags (excludes import)', () => {
    const c = cow({
      tag: '1001',
      old_tags: [
        {tag: '900', source: 'weigh_in'},
        {tag: 'PURCH-42', source: 'import'},
      ],
    });
    const list = [
      wi('1001', 1100, '2026-04-15T12:00:00Z'),
      wi('900', 800, '2025-10-01T12:00:00Z'),
      wi('PURCH-42', 600, '2024-09-01T12:00:00Z'), // import — must NOT be included
    ];
    const h = cowWeighInHistory(c, list);
    expect(h.length).toBe(2);
    expect(h[0].weight).toBe(1100);
    expect(h[1].weight).toBe(800);
  });
  it('drops non-positive parsed weights', () => {
    const list = [wi('1001', 0, '2026-04-15T12:00:00Z'), wi('1001', 'abc', '2026-04-10T12:00:00Z')];
    expect(cowWeighInHistory(cow(), list)).toEqual([]);
  });
});

// ── ADG ladder ───────────────────────────────────────────────────────────────
describe('computeLast3ADG (count-based, last 3 weigh-ins)', () => {
  it('null when fewer than 3 points', () => {
    expect(computeLast3ADG([{weight: 1000, ms: TODAY}])).toBe(null);
    expect(
      computeLast3ADG([
        {weight: 1100, ms: TODAY},
        {weight: 1000, ms: TODAY - 60 * 86400000},
      ]),
    ).toBe(null);
  });
  it('uses newest and 3rd-most-recent regardless of calendar window', () => {
    const h = [
      {weight: 1200, ms: TODAY}, // newest
      {weight: 1140, ms: TODAY - 30 * 86400000},
      {weight: 1080, ms: TODAY - 60 * 86400000}, // 3rd-most-recent
      {weight: 900, ms: TODAY - 200 * 86400000}, // ignored — older than top-3
    ];
    const r = computeLast3ADG(h);
    expect(r).not.toBe(null);
    // (1200 - 1080) / 60 = 2.0 lb/day
    expect(r.adg).toBeCloseTo(2.0);
    expect(r.gapDays).toBe(60);
    expect(r.weightsUsed).toBe(3);
  });
});

describe('computeLast2ADG', () => {
  it('uses the 2 most recent points', () => {
    const h = [
      {weight: 1100, ms: TODAY},
      {weight: 800, ms: TODAY - 200 * 86400000},
    ];
    const r = computeLast2ADG(h);
    expect(r).not.toBe(null);
    expect(r.adg).toBeCloseTo(1.5);
  });
  it('null when fewer than 2 points', () => {
    expect(computeLast2ADG([{weight: 1000, ms: TODAY}])).toBe(null);
  });
});

describe('resolveADGForCow — 5-step ladder', () => {
  const settings = {fallbackAdg: 1.18};
  const eligNorm = {eligible: true, useGlobalAdgOnly: false};
  const eligGlobal = {eligible: true, useGlobalAdgOnly: true};

  it('1) last 3 weigh-ins ADG when available', () => {
    const c = cow();
    const h = [
      {weight: 1200, ms: TODAY},
      {weight: 1140, ms: TODAY - 30 * 86400000},
      {weight: 1080, ms: TODAY - 60 * 86400000},
    ];
    const r = resolveADGForCow({cow: c, history: h, settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.source).toBe(ADG_SOURCES.LAST_3);
    expect(r.adg).toBeCloseTo(2.0);
  });
  it('2) last 2 weigh-ins when only 2 history points exist', () => {
    const c = cow();
    const h = [
      {weight: 1100, ms: TODAY},
      {weight: 800, ms: TODAY - 200 * 86400000},
    ];
    const r = resolveADGForCow({cow: c, history: h, settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.source).toBe(ADG_SOURCES.LAST_2);
    expect(r.adg).toBeCloseTo(1.5);
  });
  it('3) one weigh-in + global ADG', () => {
    const c = cow();
    const h = [{weight: 1100, ms: TODAY}];
    const r = resolveADGForCow({cow: c, history: h, settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.source).toBe(ADG_SOURCES.ONE_PLUS_FALLBACK);
    expect(r.adg).toBe(1.18);
  });
  it('4) DOB + birth-weight + global ADG when no weigh-ins but DOB present', () => {
    const c = cow({birth_date: '2024-08-01'});
    const r = resolveADGForCow({cow: c, history: [], settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.source).toBe(ADG_SOURCES.DOB_PLUS_FALLBACK);
    expect(r.adg).toBe(1.18);
  });
  it('5) watchlist when no weigh-ins AND no DOB', () => {
    const c = cow({birth_date: null});
    const r = resolveADGForCow({cow: c, history: [], settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.source).toBe(ADG_SOURCES.NONE);
    expect(r.adg).toBe(null);
  });
  it('momma steers + selected momma heifers always use GLOBAL_ONLY', () => {
    const c = cow({herd: 'mommas', sex: 'steer'});
    const h = [
      {weight: 1200, ms: TODAY},
      {weight: 1140, ms: TODAY - 30 * 86400000},
      {weight: 1080, ms: TODAY - 60 * 86400000},
    ];
    const r = resolveADGForCow({cow: c, history: h, settings, todayMs: TODAY, eligibility: eligGlobal});
    expect(r.source).toBe(ADG_SOURCES.GLOBAL_ONLY);
    expect(r.adg).toBe(1.18);
  });
  it('flags negative ADG honestly when computed (last 2 weigh-ins, no fallback)', () => {
    const c = cow();
    const h = [
      {weight: 1000, ms: TODAY},
      {weight: 1100, ms: TODAY - 14 * 86400000},
    ];
    const r = resolveADGForCow({cow: c, history: h, settings, todayMs: TODAY, eligibility: eligNorm});
    expect(r.adg).toBeCloseTo(-100 / 14);
    expect(r.negative).toBe(true);
    expect(r.source).toBe(ADG_SOURCES.LAST_2);
  });
});

// ── eligibility ──────────────────────────────────────────────────────────────
describe('eligibilityFor — locked inclusion rules', () => {
  it('backgrounders auto-included regardless of sex', () => {
    expect(eligibilityFor(cow({herd: 'backgrounders', sex: 'heifer'}), new Set()).eligible).toBe(true);
  });
  it('finishers auto-included regardless of sex', () => {
    expect(eligibilityFor(cow({herd: 'finishers', sex: 'steer'}), new Set()).eligible).toBe(true);
  });
  it('momma steers auto-included with global ADG only', () => {
    const r = eligibilityFor(cow({herd: 'mommas', sex: 'steer'}), new Set());
    expect(r.eligible).toBe(true);
    expect(r.useGlobalAdgOnly).toBe(true);
    expect(r.source).toBe('auto-momma-steer');
  });
  it('momma heifers excluded by default; included via explicit modal selection', () => {
    const c = cow({id: 'm-heifer-1', herd: 'mommas', sex: 'heifer'});
    expect(eligibilityFor(c, new Set()).eligible).toBe(false);
    const r = eligibilityFor(c, new Set(['m-heifer-1']));
    expect(r.eligible).toBe(true);
    expect(r.useGlobalAdgOnly).toBe(true);
    expect(r.source).toBe('momma-heifer-include');
  });
  it('momma adult cows are NEVER forecasted', () => {
    expect(eligibilityFor(cow({herd: 'mommas', sex: 'cow'}), new Set()).eligible).toBe(false);
  });
  it('processed/sold/deceased excluded under all circumstances', () => {
    expect(eligibilityFor(cow({herd: 'processed'}), new Set()).eligible).toBe(false);
    expect(eligibilityFor(cow({herd: 'sold'}), new Set()).eligible).toBe(false);
    expect(eligibilityFor(cow({herd: 'deceased'}), new Set()).eligible).toBe(false);
  });
  it('bulls herd excluded', () => {
    expect(eligibilityFor(cow({herd: 'bulls', sex: 'bull'}), new Set()).eligible).toBe(false);
  });
});

describe('isHeiferEligibleForInclude — modal + buildForecast guard', () => {
  it('momma heifer under 15 months and not pregnant is eligible', () => {
    const c = cow({herd: 'mommas', sex: 'heifer', birth_date: '2025-08-01'});
    expect(isHeiferEligibleForInclude(c, TODAY)).toBe(true);
  });
  it('momma heifer over 15 months is excluded', () => {
    // TODAY = 2026-05-02. DOB 2024-09-01 → ~20 calendar months.
    const c = cow({herd: 'mommas', sex: 'heifer', birth_date: '2024-09-01'});
    expect(isHeiferEligibleForInclude(c, TODAY)).toBe(false);
  });
  it('15-month boundary: <=15 cal months eligible, >=16 cal months excluded', () => {
    // TODAY = 2026-05-02. Calendar-month math, day-of-month-aware.
    // DOB 2025-02-02 → exactly 15 cal months → eligible.
    expect(isHeiferEligibleForInclude(cow({herd: 'mommas', sex: 'heifer', birth_date: '2025-02-02'}), TODAY)).toBe(
      true,
    );
    // DOB 2025-02-01 → 15 cal months and 1 day → still eligible.
    expect(isHeiferEligibleForInclude(cow({herd: 'mommas', sex: 'heifer', birth_date: '2025-02-01'}), TODAY)).toBe(
      true,
    );
    // DOB 2025-01-01 → 16 cal months → excluded.
    expect(isHeiferEligibleForInclude(cow({herd: 'mommas', sex: 'heifer', birth_date: '2025-01-01'}), TODAY)).toBe(
      false,
    );
  });
  it('pregnant heifer is excluded regardless of age', () => {
    const c = cow({herd: 'mommas', sex: 'heifer', birth_date: '2025-08-01', breeding_status: 'PREGNANT'});
    expect(isHeiferEligibleForInclude(c, TODAY)).toBe(false);
  });
  it('non-momma or non-heifer is excluded', () => {
    expect(isHeiferEligibleForInclude(cow({herd: 'finishers', sex: 'heifer'}), TODAY)).toBe(false);
    expect(isHeiferEligibleForInclude(cow({herd: 'mommas', sex: 'cow'}), TODAY)).toBe(false);
    expect(isHeiferEligibleForInclude(cow({herd: 'mommas', sex: 'steer'}), TODAY)).toBe(false);
  });
  it('heifer with no birth_date is kept visible (per Ronnie 2026-05-04)', () => {
    const c = cow({herd: 'mommas', sex: 'heifer', birth_date: null});
    expect(isHeiferEligibleForInclude(c, TODAY)).toBe(true);
  });
});

describe('buildForecast — stale heifer-include rows do not leak ineligible heifers', () => {
  it('pregnant momma heifer in includes does not become forecast-eligible', () => {
    const pregnantHeifer = cow({
      id: 'm-heifer-pg',
      tag: '9001',
      herd: 'mommas',
      sex: 'heifer',
      birth_date: '2025-08-01',
      breeding_status: 'PREGNANT',
    });
    const r = buildForecast({
      cattle: [pregnantHeifer],
      weighIns: [],
      settings: {fallbackAdg: 1.5},
      includes: new Set(['m-heifer-pg']),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    // Stale include must be filtered out — animalRows is empty, watchlist
    // ignores her too because she's not auto-eligible without the include.
    expect(r.animalRows.find((row) => row.cow.id === 'm-heifer-pg')).toBeUndefined();
    expect(r.watchlist.find((row) => row.cow.id === 'm-heifer-pg')).toBeUndefined();
  });
  it('over-15-month momma heifer in includes does not become forecast-eligible', () => {
    const oldHeifer = cow({
      id: 'm-heifer-old',
      tag: '9002',
      herd: 'mommas',
      sex: 'heifer',
      birth_date: '2024-09-01',
    });
    const r = buildForecast({
      cattle: [oldHeifer],
      weighIns: [],
      settings: {fallbackAdg: 1.5},
      includes: new Set(['m-heifer-old']),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    expect(r.animalRows.find((row) => row.cow.id === 'm-heifer-old')).toBeUndefined();
  });
  it('finish candidate summary excludes pregnant and over-15-month momma heifers', () => {
    const cattle = [
      cow({id: 'finisher', tag: '9101', herd: 'finishers', sex: 'steer'}),
      cow({id: 'backgrounder', tag: '9102', herd: 'backgrounders', sex: 'heifer'}),
      cow({id: 'momma-steer', tag: '9103', herd: 'mommas', sex: 'steer'}),
      cow({id: 'momma-heifer-ok', tag: '9104', herd: 'mommas', sex: 'heifer', birth_date: '2025-08-01'}),
      cow({
        id: 'momma-heifer-pregnant',
        tag: '9105',
        herd: 'mommas',
        sex: 'heifer',
        birth_date: '2025-08-01',
        breeding_status: 'PREGNANT',
      }),
      cow({id: 'momma-heifer-aged', tag: '9106', herd: 'mommas', sex: 'heifer', birth_date: '2024-09-01'}),
      cow({id: 'momma-cow', tag: '9107', herd: 'mommas', sex: 'cow'}),
      cow({id: 'bull', tag: '9108', herd: 'bulls', sex: 'bull'}),
      cow({id: 'processed', tag: '9109', herd: 'processed', sex: 'steer'}),
    ];
    const out = buildForecast({
      cattle,
      weighIns: [],
      settings: {fallbackAdg: 1.5},
      // Stale include rows must not make filtered heifers count as on-farm
      // finish candidates.
      includes: new Set(['momma-heifer-ok', 'momma-heifer-pregnant', 'momma-heifer-aged']),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });

    expect(out.summary.finishCandidates).toBe(4);
  });
  it('auto-promoted cow (was-heifer) in includes does not leak as forecast-eligible', () => {
    // After mig 044's trigger fires, heifer.sex becomes 'cow'. The
    // heifer_includes row still references her id, but eligibilityFor
    // routes mommas+cow to excluded-momma-cow regardless of includes.
    const promoted = cow({
      id: 'm-promoted',
      tag: '9003',
      herd: 'mommas',
      sex: 'cow',
      birth_date: '2025-08-01',
    });
    const r = buildForecast({
      cattle: [promoted],
      weighIns: [],
      settings: {fallbackAdg: 1.5},
      includes: new Set(['m-promoted']),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    expect(r.animalRows.find((row) => row.cow.id === 'm-promoted')).toBeUndefined();
  });
  it('valid heifer-include still produces a forecast row', () => {
    const h = cow({
      id: 'm-heifer-ok',
      tag: '9004',
      herd: 'mommas',
      sex: 'heifer',
      birth_date: '2025-08-01',
    });
    const r = buildForecast({
      cattle: [h],
      weighIns: [],
      settings: {fallbackAdg: 1.5},
      includes: new Set(['m-heifer-ok']),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    // No weigh-ins → DOB+global ladder kicks in; she should at least be
    // in the helper output (animalRow or watchlist depending on the
    // displayMin window). Either way, she didn't get filtered as stale.
    const mentioned =
      r.animalRows.some((row) => row.cow.id === 'm-heifer-ok') ||
      r.watchlist.some((row) => row.cow.id === 'm-heifer-ok');
    expect(mentioned).toBe(true);
  });
});

// ── projection / month assignment ────────────────────────────────────────────
describe('projectedWeightAtMonth + findFirstEligibleUnhiddenMonth', () => {
  it('linear projection from anchor — month checkpoint is the 15th', () => {
    const anchorMs = new Date('2026-05-01T12:00:00Z').getTime();
    const proj = projectedWeightAtMonth({
      anchorWeight: 1000,
      anchorMs,
      targetMonthKey: '2026-08',
      adg: 2,
    });
    // 2026-05-01 12:00Z → 2026-08-15 12:00Z = 106 days. 1000 + 2*106 = 1212.
    expect(proj).toBeCloseTo(1212);
  });
  it('monthStartMs anchors a YYYY-MM key to the 15th of the month', () => {
    const ms = monthStartMs('2026-08');
    expect(new Date(ms).toISOString()).toBe('2026-08-15T12:00:00.000Z');
  });
  it('first eligible unhidden month — picks earliest in window (15th anchor)', () => {
    const horizon = monthsInHorizon(TODAY, 1);
    const anchorMs = new Date('2026-05-01T12:00:00Z').getTime();
    const r = findFirstEligibleUnhiddenMonth({
      cow: cow({id: 'c-x'}),
      anchorWeight: 1000,
      anchorMs,
      adg: 2,
      horizon,
      weightMin: 1200,
      weightMax: 1500,
      hiddenSet: new Set(),
    });
    // Need 200 lb gain at 2 lb/day = 100 days. 2026-05-01 + 100d ≈ 2026-08-09.
    // First month-15 projection >= 1200 is 2026-08 (2026-08-15 = 106 days
    // out, projected 1212). With month-1 anchor this would land in 2026-09;
    // the 15th anchor moves it forward by ~half a month.
    expect(r).not.toBe(null);
    expect(r.monthKey).toBe('2026-08');
  });
  it('hidden month is skipped — assignment lands in the next eligible', () => {
    const horizon = monthsInHorizon(TODAY, 1);
    const anchorMs = new Date('2026-05-01T12:00:00Z').getTime();
    const hidden = new Set(['c-x|2026-08']);
    const r = findFirstEligibleUnhiddenMonth({
      cow: cow({id: 'c-x'}),
      anchorWeight: 1000,
      anchorMs,
      adg: 2,
      horizon,
      weightMin: 1200,
      weightMax: 1500,
      hiddenSet: hidden,
    });
    expect(r.monthKey).toBe('2026-09');
  });
});

// ── batch naming + sequence ──────────────────────────────────────────────────
describe('parseBatchName / formatBatchName', () => {
  it('parses C-YY-NN and zero-pads on format', () => {
    expect(parseBatchName('C-26-04')).toEqual({yy: 26, n: 4});
    expect(formatBatchName(26, 4)).toBe('C-26-04');
    expect(parseBatchName('not-a-name')).toBe(null);
    // Tolerates 3+ digits (defensive — unlikely but cheap).
    expect(parseBatchName('C-26-100')).toEqual({yy: 26, n: 100});
  });
});

describe('highestStoredNumberForYear + nextRealBatchName', () => {
  it('returns 0 when no batches in the year', () => {
    expect(highestStoredNumberForYear([], 26)).toBe(0);
  });
  it('returns max sequence within the requested year only', () => {
    const real = [{name: 'C-25-09'}, {name: 'C-26-01'}, {name: 'C-26-03'}];
    expect(highestStoredNumberForYear(real, 26)).toBe(3);
    expect(highestStoredNumberForYear(real, 25)).toBe(9);
  });
  it('nextRealBatchName uses the processing date year', () => {
    const real = [{name: 'C-26-03'}];
    expect(nextRealBatchName(real, '2026-05-12')).toBe('C-26-04');
    // New year → starts at 01 even when prior years have higher sequences.
    expect(nextRealBatchName(real, '2027-01-04')).toBe('C-27-01');
  });
});

describe('buildVirtualBatchNames', () => {
  const buckets = (months) =>
    months.map((mk) => ({
      monthKey: mk,
      label: mk,
      year: parseInt(mk.slice(0, 4), 10),
      animalIds: ['a', 'b'],
      projectedTotalLbs: 0,
      count: 2,
      overCapacity: false,
    }));

  it('continues contiguously after the highest stored real number for the same year', () => {
    const real = [{name: 'C-26-02'}];
    const v = buildVirtualBatchNames({realBatches: real, virtualMonths: buckets(['2026-08', '2026-10'])});
    expect(v.map((x) => x.name)).toEqual(['C-26-03', 'C-26-04']);
  });
  it('resets to 01 on year change', () => {
    const real = [{name: 'C-26-02'}];
    const v = buildVirtualBatchNames({
      realBatches: real,
      virtualMonths: buckets(['2026-12', '2027-02']),
    });
    expect(v.map((x) => x.name)).toEqual(['C-26-03', 'C-27-01']);
  });
  it('starts at 01 in a year with no real or prior virtuals', () => {
    const v = buildVirtualBatchNames({realBatches: [], virtualMonths: buckets(['2027-04'])});
    expect(v[0].name).toBe('C-27-01');
  });
  it('scheduled rows reserve their slot without renumbering earlier unscheduled virtuals', () => {
    // Codex 2026-05-12 correction: scheduling July as C-26-03 must NOT
    // push May/June virtual batches to C-26-04 / C-26-05. New virtual
    // months always fill the lowest available slot; a later scheduled
    // batch is just a reservation, not a counter bump.
    const scheduled = [{name: 'C-26-03', planned_process_date: '2026-07-15', status: 'scheduled'}];
    // virtualMonths excludes July (it's reserved by the scheduled row).
    const v = buildVirtualBatchNames({
      realBatches: [],
      scheduledBatches: scheduled,
      virtualMonths: buckets(['2026-05', '2026-06', '2026-08']),
    });
    expect(v.map((x) => x.name)).toEqual(['C-26-01', 'C-26-02', 'C-26-04']);
  });
  it('real bumps the cursor floor; scheduled reservations are just skipped', () => {
    // Real C-26-02 is already complete (in the past — cursor floor 3);
    // scheduled C-26-04 reserves slot 4 (future booking). Virtual June
    // is the first to assign from floor → 03. July would naturally
    // take 04 but that's reserved → bump to 05. September naturally
    // takes 06.
    const real = [{name: 'C-26-02', actual_process_date: '2026-05-15', status: 'complete'}];
    const scheduled = [{name: 'C-26-04', planned_process_date: '2026-08-15', status: 'scheduled'}];
    const v = buildVirtualBatchNames({
      realBatches: real,
      scheduledBatches: scheduled,
      virtualMonths: buckets(['2026-06', '2026-07', '2026-09']),
    });
    expect(v.map((x) => x.name)).toEqual(['C-26-03', 'C-26-05', 'C-26-06']);
  });
});

describe('validateRealBatchRename', () => {
  const real = [{name: 'C-26-01'}, {name: 'C-26-02'}, {name: 'C-26-03'}];

  it('format must be C-YY-NN', () => {
    expect(validateRealBatchRename({proposedName: 'foo', currentName: 'C-26-03', realBatches: real}).reason).toBe(
      'format',
    );
  });
  it('rejects duplicates', () => {
    expect(validateRealBatchRename({proposedName: 'C-26-02', currentName: 'C-26-03', realBatches: real}).reason).toBe(
      'duplicate',
    );
  });
  it('rejects skipping the sequence (gap > +1)', () => {
    expect(validateRealBatchRename({proposedName: 'C-26-09', currentName: 'C-26-03', realBatches: real}).reason).toBe(
      'sequence_gap',
    );
  });
  it('allows replacing into an existing slot', () => {
    expect(validateRealBatchRename({proposedName: 'C-26-01', currentName: 'C-26-01', realBatches: real}).ok).toBe(true);
  });
  it('new year must start at 01', () => {
    expect(validateRealBatchRename({proposedName: 'C-27-04', currentName: 'C-26-03', realBatches: real}).reason).toBe(
      'new_year_must_start_at_01',
    );
    expect(validateRealBatchRename({proposedName: 'C-27-01', currentName: 'C-26-03', realBatches: real}).ok).toBe(true);
  });
  it('blocks renaming the highest batch upward (creates a gap)', () => {
    // real = [C-26-01, C-26-02, C-26-03]; rename C-26-03 → C-26-04 leaves
    // slot 3 empty. New batches must come via Send-to-Processor, not
    // hand-rename, so this is correctly blocked.
    expect(validateRealBatchRename({proposedName: 'C-26-04', currentName: 'C-26-03', realBatches: real}).reason).toBe(
      'sequence_gap',
    );
  });
  it('allows gap-fill rename', () => {
    // real = [C-26-01, C-26-04]; rename C-26-04 → C-26-02 fills the gap.
    const gappy = [{name: 'C-26-01'}, {name: 'C-26-04'}];
    expect(validateRealBatchRename({proposedName: 'C-26-02', currentName: 'C-26-04', realBatches: gappy}).ok).toBe(
      true,
    );
  });
  it('December/January cross-year rename: C-26-12 → C-27-01', () => {
    const dec = [{name: 'C-26-12'}];
    expect(validateRealBatchRename({proposedName: 'C-27-01', currentName: 'C-26-12', realBatches: dec}).ok).toBe(true);
  });
});

// ── Send-to-Processor gate ──────────────────────────────────────────────────
describe('checkProcessorGate', () => {
  const next = {
    name: 'C-26-04',
    monthKey: '2026-08',
    label: 'Aug 2026',
    animalIds: ['a', 'b', 'c'],
    allowedTagSet: new Set(['1001', '1002', '1003']),
    projectedTotalLbs: 0,
  };
  it('all selected tags inside next batch → ok', () => {
    const r = checkProcessorGate({selectedTags: ['1001', '1002'], nextProcessorBatch: next});
    expect(r.ok).toBe(true);
    expect(r.blockedTags).toEqual([]);
  });
  it('any tag outside next batch → blocked, lists blocked tags', () => {
    const r = checkProcessorGate({selectedTags: ['1001', '9999'], nextProcessorBatch: next});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tags_outside_next_batch');
    expect(r.blockedTags).toEqual(['9999']);
  });
  it('no nextProcessorBatch → blocked', () => {
    const r = checkProcessorGate({selectedTags: ['1001'], nextProcessorBatch: null});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_next_batch');
  });
  it('partial subset (less than allowed) → ok', () => {
    const r = checkProcessorGate({selectedTags: ['1001'], nextProcessorBatch: next});
    expect(r.ok).toBe(true);
  });
});

// ── batch state helpers ─────────────────────────────────────────────────────
describe('batchHasAllHangingWeights / batchMissingHangingTags', () => {
  it('false when any cow lacks hanging weight', () => {
    const b = {
      cows_detail: [
        {tag: '1001', hanging_weight: 600},
        {tag: '1002', hanging_weight: null},
      ],
    };
    expect(batchHasAllHangingWeights(b)).toBe(false);
    expect(batchMissingHangingTags(b)).toEqual(['1002']);
  });
  it('true when every cow has hanging > 0', () => {
    const b = {
      cows_detail: [
        {tag: '1001', hanging_weight: 600},
        {tag: '1002', hanging_weight: 700},
      ],
    };
    expect(batchHasAllHangingWeights(b)).toBe(true);
    expect(batchMissingHangingTags(b)).toEqual([]);
  });
  it('false when cows_detail empty (degenerate)', () => {
    expect(batchHasAllHangingWeights({cows_detail: []})).toBe(false);
  });
});

// ── orchestrator: buildForecast ─────────────────────────────────────────────
describe('buildForecast — orchestrator end-to-end', () => {
  function seedCattle() {
    return [
      // F1: finisher with strong rolling ADG → ready in 2026-09
      cow({id: 'F1', tag: '1001', sex: 'steer', herd: 'finishers', birth_date: '2024-08-01'}),
      // M-Steer: momma steer → uses global ADG only
      cow({id: 'MS1', tag: '2001', sex: 'steer', herd: 'mommas', birth_date: '2025-04-01'}),
      // M-Heifer included via modal — DOB 2025-08-01 keeps her under the
      // 15-month modal cap at TODAY=2026-05-02 (~9 months).
      cow({id: 'MH1', tag: '3001', sex: 'heifer', herd: 'mommas', birth_date: '2025-08-01'}),
      // M-Heifer NOT included → excluded
      cow({id: 'MH2', tag: '3002', sex: 'heifer', herd: 'mommas', birth_date: '2025-08-01'}),
      // M-Cow → never forecast
      cow({id: 'MC1', tag: '3100', sex: 'cow', herd: 'mommas'}),
      // Outcome → never forecast
      cow({id: 'P1', tag: '4001', sex: 'steer', herd: 'processed'}),
      // Backgrounder no weigh-ins, has DOB → DOB+birth_weight+fallback ladder
      cow({id: 'B1', tag: '5001', sex: 'heifer', herd: 'backgrounders', birth_date: '2025-01-15'}),
      // Watchlist case: no weigh-in, no DOB
      cow({id: 'W1', tag: '6001', sex: 'steer', herd: 'finishers', birth_date: null}),
    ];
  }
  function seedWeighIns() {
    return [
      // F1: rolling ADG of 2.0 lb/day from 1000 lb today − 28 lb at 14 days back
      wi('1001', 1100, '2026-05-02T12:00:00Z'),
      wi('1001', 1072, '2026-04-18T12:00:00Z'),
    ];
  }
  function seedRealBatches() {
    return [
      {name: 'C-26-01', status: 'complete'},
      {name: 'C-26-02', status: 'active'},
    ];
  }
  it('respects inclusion + outcome rules and runs the ladder end-to-end', () => {
    const out = buildForecast({
      cattle: seedCattle(),
      weighIns: seedWeighIns(),
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(['MH1']),
      hidden: [],
      realBatches: seedRealBatches(),
      todayMs: TODAY,
    });
    const ids = new Set(out.animalRows.map((r) => r.cow.id));
    expect(ids.has('F1')).toBe(true);
    expect(ids.has('MS1')).toBe(true);
    expect(ids.has('MH1')).toBe(true);
    expect(ids.has('B1')).toBe(true);
    expect(ids.has('W1')).toBe(true);
    expect(ids.has('MH2')).toBe(false); // not selected
    expect(ids.has('MC1')).toBe(false); // adult cow
    expect(ids.has('P1')).toBe(false); // processed
  });
  it('virtual batch names continue after the highest stored real batch in the same year', () => {
    const out = buildForecast({
      cattle: seedCattle(),
      weighIns: seedWeighIns(),
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: seedRealBatches(),
      todayMs: TODAY,
    });
    // Real batches reach C-26-02 → first virtual in 2026 must be C-26-03+
    if (out.virtualBatches.length > 0) {
      const firstName = out.virtualBatches[0].name;
      expect(firstName.startsWith('C-26-')).toBe(true);
      const num = parseBatchName(firstName).n;
      expect(num).toBeGreaterThanOrEqual(3);
    }
  });
  it('hide a cow in their assigned month → reassigns to next eligible month', () => {
    // Plain finisher F1 with rolling ADG=2 lb/day; assign first eligible
    const baseInputs = {
      cattle: seedCattle(),
      weighIns: seedWeighIns(),
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    };
    const before = buildForecast(baseInputs);
    const f1Before = before.animalRows.find((r) => r.cow.id === 'F1');
    expect(f1Before.readyMonth).toBeTruthy();
    // Now hide that month — F1 should land in a later month.
    const after = buildForecast({
      ...baseInputs,
      hidden: [{cattle_id: 'F1', month_key: f1Before.readyMonth}],
    });
    const f1After = after.animalRows.find((r) => r.cow.id === 'F1');
    expect(f1After.readyMonth).not.toBe(f1Before.readyMonth);
  });
  it('cow with no weigh-in and no DOB → watchlist with NO_WEIGHT_NO_DOB reason', () => {
    const out = buildForecast({
      cattle: seedCattle(),
      weighIns: seedWeighIns(),
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    const w1 = out.animalRows.find((r) => r.cow.id === 'W1');
    expect(w1.watchlistReasons).toContain(WATCHLIST_REASONS.NO_WEIGHT_NO_DOB);
    expect(w1.readyMonth).toBe(null);
  });
  it('nextProcessorBatch carries the allowed tag set + currentYearTotalForecast', () => {
    const out = buildForecast({
      cattle: seedCattle(),
      weighIns: seedWeighIns(),
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: seedRealBatches(),
      todayMs: TODAY,
    });
    expect(out.nextProcessorBatch).not.toBe(null);
    expect(out.nextProcessorBatch.allowedTagSet instanceof Set).toBe(true);
    // Has at least F1 in the next batch (it's the closest-projected eligible cow).
    expect(out.nextProcessorBatch.allowedTagSet.has('1001')).toBe(true);
    expect(typeof out.nextProcessorBatch.currentYearTotalForecast).toBe('number');
  });
});

// ── Codex 2026-05-04 review — regression locks ─────────────────────────────
describe('buildForecast — assignment never lands in a past month (Codex finding #1)', () => {
  it('finisher already at target weight on May 2 cannot be assigned to January of the same year', () => {
    // Cow is at 1450 lb today and gaining. Backward projection to Jan 1 of
    // the current year would land in [1200, 1500] without the assignment-
    // horizon clip and put the cow in 2026-01.
    const c = {
      id: 'AT-MAX',
      tag: '7001',
      sex: 'steer',
      herd: 'finishers',
      breed: 'Angus',
      old_tags: [],
      birth_date: '2024-08-01',
    };
    const w = [
      {tag: '7001', weight: 1450, entered_at: '2026-05-02T12:00:00Z'},
      {tag: '7001', weight: 1430, entered_at: '2026-04-18T12:00:00Z'},
    ];
    const out = buildForecast({
      cattle: [c],
      weighIns: w,
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    });
    const row = out.animalRows.find((r) => r.cow.id === 'AT-MAX');
    // readyMonth must be 2026-05 or later — never 2026-01..2026-04.
    expect(row.readyMonth).not.toBe(null);
    expect(row.readyMonth >= '2026-05').toBe(true);
    expect(out.nextProcessorBatch).not.toBe(null);
    expect(out.nextProcessorBatch.monthKey >= '2026-05').toBe(true);
  });
});

describe('buildForecast — hidden cow surfaces in hide month (Codex finding #2)', () => {
  it('cow hidden in their assigned month appears in hiddenAnimalIds for that month even after assignment rolls forward', () => {
    const c = {
      id: 'F1',
      tag: '1001',
      sex: 'steer',
      herd: 'finishers',
      breed: 'Angus',
      old_tags: [],
      birth_date: '2024-08-01',
    };
    const w = [
      {tag: '1001', weight: 1100, entered_at: '2026-05-02T12:00:00Z'},
      {tag: '1001', weight: 1072, entered_at: '2026-04-18T12:00:00Z'},
    ];
    const baseInputs = {
      cattle: [c],
      weighIns: w,
      settings: {displayMin: 1200, displayMax: 1500, fallbackAdg: 1.18, birthWeight: 64, horizonYears: 3},
      includes: new Set(),
      hidden: [],
      realBatches: [],
      todayMs: TODAY,
    };
    const before = buildForecast(baseInputs);
    const f1Before = before.animalRows.find((r) => r.cow.id === 'F1');
    expect(f1Before.readyMonth).not.toBe(null);

    const hideMonth = f1Before.readyMonth;
    const after = buildForecast({...baseInputs, hidden: [{cattle_id: 'F1', month_key: hideMonth}]});
    const f1After = after.animalRows.find((r) => r.cow.id === 'F1');
    // Assignment rolls forward.
    expect(f1After.readyMonth).not.toBe(hideMonth);

    // The hide month's bucket must still surface F1 in hiddenAnimalIds so
    // the UI can render an Unhide button for that specific month, even
    // though F1's current assignment is elsewhere.
    const hideBucket = after.monthBuckets.find((b) => b.monthKey === hideMonth);
    expect(hideBucket).toBeTruthy();
    expect(hideBucket.hiddenAnimalIds).toContain('F1');
    // And F1 must NOT be double-counted in animalIds for the hide month.
    expect(hideBucket.animalIds).not.toContain('F1');
  });
});

// ── locked defaults ─────────────────────────────────────────────────────────
describe('locked default constants', () => {
  it('match the migration', () => {
    expect(FORECAST_FALLBACK_ADG_DEFAULT).toBe(1.18);
    expect(FORECAST_BIRTH_WEIGHT_LB_DEFAULT).toBe(64);
    expect(FORECAST_DISPLAY_WEIGHT_MIN_DEFAULT).toBe(1200);
    expect(FORECAST_DISPLAY_WEIGHT_MAX_DEFAULT).toBe(1500);
  });
});
