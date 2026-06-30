import {describe, it, expect} from 'vitest';
import {
  detectNewsletterFacts,
  detectBroilerOnFarm,
  detectBroilerProcessed,
  detectPigFarrowings,
  detectPigsOnFarm,
  detectCattleOnFarm,
  detectCattleBirths,
  detectLayerEggs,
  detectPastureMoves,
  detectProcessing,
  detectCompletedTasks,
  detectDailyReports,
  isForbiddenFact,
  isForbiddenText,
  assertNoForbiddenFacts,
  NEWSLETTER_DETECTORS,
} from './newsletterFacts.js';

const PERIOD = {yearMonth: '2026-05', start: '2026-05-01', end: '2026-05-31'};

function withPeriod(extra) {
  return {period: PERIOD, ...extra};
}

describe('newsletter fact detectors — positive, evidence-backed facts', () => {
  it('broiler on-farm counts only active flocks as birdCountActual − mortality', () => {
    const fact = detectBroilerOnFarm(
      withPeriod({
        broilerBatches: [
          {name: 'B-26-04', status: 'active', birdCountActual: 320, mortalityCumulative: 20}, // 300 on farm
          {name: 'B-26-03', status: 'processed', birdCountActual: 250}, // excluded (done)
          {name: 'B-26-06', status: 'planned', birdCount: 900}, // excluded (not hatched yet)
          {name: 'B-26-05', status: 'active', birdCountActual: 150, mortalityCumulative: 0}, // 150 on farm
        ],
      }),
    );
    expect(fact.detectorKey).toBe('broiler_on_farm');
    expect(fact.metricValue).toBe(450); // (320−20) + 150 — planned/processed never counted
    expect(fact.evidence.flockCount).toBe(2);
    expect(fact.confidence).toBe('high');
  });

  it('broilers brought to processing: totalToProcessor, brought = processingDate−1, projected fallback', () => {
    const fact = detectBroilerProcessed(
      withPeriod({
        broilerBatches: [
          // Processed in-period: brought 05-09, counted by totalToProcessor.
          {name: 'B-26-02', status: 'processed', processingDate: '2026-05-10', totalToProcessor: 280},
          // Goes to the processor 05-31 though it processes 06-01 (next month):
          // brought-date − 1 pulls it into May. Not yet tallied → projected
          // live birds (320 − 20 = 300).
          {
            name: 'B-26-03',
            status: 'active',
            processingDate: '2026-06-01',
            totalToProcessor: 0,
            birdCountActual: 320,
            mortalityCumulative: 20,
          },
          // Out of period (brought 04-28) and a planned batch are both excluded.
          {name: 'B-26-01', status: 'processed', processingDate: '2026-04-29', totalToProcessor: 300},
          {name: 'B-26-04', status: 'planned', processingDate: '2026-05-20', birdCountActual: 400},
        ],
      }),
    );
    expect(fact.metricValue).toBe(580); // 280 + 300
    expect(fact.evidence.batches).toBe(2);
    expect(fact.evidence.flocks.map((f) => f.name).sort()).toEqual(['B-26-02', 'B-26-03']);
  });

  it('pig farrowings count litters + born-alive (never mortality)', () => {
    const fact = detectPigFarrowings(
      withPeriod({
        pigFarrowings: [
          {group: 'G1', farrowingDate: '2026-05-03', bornAlive: 11, stillborn: 2},
          {group: 'G2', farrowingDate: '2026-05-20', liveBorn: 9},
          {group: 'G3', farrowingDate: '2026-06-01', bornAlive: 10}, // out of period
        ],
      }),
    );
    expect(fact.evidence.litters).toBe(2);
    expect(fact.evidence.piglets).toBe(20);
    expect(fact.confidence).toBe('high');
    // The stillborn field must never appear in the summary/evidence numbers.
    expect(JSON.stringify(fact)).not.toMatch(/stillborn/i);
  });

  it('NEVER publishes totalBorn as born-alive: omits piglet totals + medium confidence when born-alive is missing', () => {
    const fact = detectPigFarrowings(
      withPeriod({
        // A litter recorded with totalBorn + stillborn but NO explicit born-alive.
        pigFarrowings: [{group: 'G1', farrowingDate: '2026-05-05', totalBorn: 12, stillborn: 3}],
      }),
    );
    expect(fact.evidence.litters).toBe(1);
    expect(fact.evidence.piglets).toBeNull();
    expect(fact.metricValue).toBe(1); // litters, NOT 12
    expect(fact.displayValue).toBe('1 litter');
    expect(fact.confidence).toBe('medium');
    // The totalBorn value (12) and the stillborn count must never surface.
    expect(JSON.stringify(fact)).not.toContain('12');
    expect(JSON.stringify(fact)).not.toMatch(/stillborn/i);
  });

  it('drops to litters-only (medium) when ANY litter is missing born-alive', () => {
    const fact = detectPigFarrowings(
      withPeriod({
        pigFarrowings: [
          {group: 'G1', farrowingDate: '2026-05-03', bornAlive: 10},
          {group: 'G2', farrowingDate: '2026-05-09', totalBorn: 11}, // no born-alive
        ],
      }),
    );
    expect(fact.evidence.litters).toBe(2);
    expect(fact.evidence.piglets).toBeNull();
    expect(fact.confidence).toBe('medium');
    expect(fact.displayValue).toBe('2 litters');
  });

  it('pigs on-farm = ledger current of ACTIVE groups (started − trips − transfers − mortality)', () => {
    const fact = detectPigsOnFarm(
      withPeriod({
        pigFeederGroups: [
          {
            batchName: 'F1',
            status: 'active',
            processingTrips: [{subAttributions: [{subId: 'a', count: 5}]}],
            pigMortalities: [{sub_batch_name: 'A', count: 2}],
            subBatches: [
              {id: 'a', name: 'A', status: 'active', giltCount: 20, boarCount: 10}, // 30 −5 −1 −2 = 22
              {id: 'b', name: 'B', status: 'processed', giltCount: 15, boarCount: 0}, // processed → 0
            ],
          },
          // Parent-only active group: started − trips − transfers − mortality.
          {batchName: 'F3', status: 'active', giltCount: 8, boarCount: 0, processingTrips: [{pigCount: 3}]}, // 8 − 3 = 5
          // Planned group is NOT on the farm yet → excluded entirely.
          {batchName: 'F2', status: 'planned', subBatches: [{id: 'c', name: 'C', status: 'active', giltCount: 100}]},
        ],
        pigBreeders: [{transferredFromBatch: {batchName: 'F1', subBatchName: 'A'}, sex: 'Gilt'}], // 1 transfer from F1/A
      }),
    );
    expect(fact.detectorKey).toBe('pig_on_farm');
    expect(fact.metricValue).toBe(27); // F1 sub A 22 + F3 parent-only 5; processed/planned never counted
    expect(fact.evidence.groupCount).toBe(2);
  });

  it('cattle on-farm + births read their documented shapes', () => {
    expect(detectCattleOnFarm(withPeriod({cattleHerds: [{name: 'Mommas', headCount: 142}]})).metricValue).toBe(142);
    const births = detectCattleBirths(
      withPeriod({
        cattleBirths: [
          {dam: 'C12', birthDate: '2026-05-09'},
          {dam: 'C34', birthDate: '2026-05-22', count: 1},
        ],
      }),
    );
    expect(births.metricValue).toBe(2);
  });

  it('layer eggs sum collection records within the period', () => {
    const fact = detectLayerEggs(
      withPeriod({
        layerProduction: [
          {date: '2026-05-01', eggs: 180},
          {date: '2026-05-02', eggs: 200},
          {date: '2026-04-30', eggs: 999}, // out of period
        ],
      }),
    );
    expect(fact.metricValue).toBe(380);
  });

  it('returns null (no story) when a metric is zero / data missing', () => {
    expect(detectBroilerOnFarm(withPeriod({broilerBatches: []}))).toBeNull();
    expect(detectPigFarrowings(withPeriod({pigFarrowings: []}))).toBeNull();
    expect(detectCattleOnFarm(withPeriod({}))).toBeNull();
  });

  it('detectNewsletterFacts assembles a deterministic, ordered set', () => {
    const facts = detectNewsletterFacts(
      withPeriod({
        broilerBatches: [{name: 'B1', status: 'active', birdCountActual: 100, mortalityCumulative: 0}],
        cattleHerds: [{name: 'H1', headCount: 50}],
      }),
    );
    expect(facts.map((f) => f.detectorKey)).toEqual(['cattle_on_farm', 'broiler_on_farm']);
    expect(facts.map((f) => f.sortOrder)).toEqual([0, 1]);
  });

  it('empty / malformed input yields no facts and never throws', () => {
    expect(detectNewsletterFacts(null)).toEqual([]);
    expect(detectNewsletterFacts({})).toEqual([]);
    expect(detectNewsletterFacts({period: PERIOD})).toEqual([]);
  });
});

describe('finance / mortality boundary', () => {
  it('flags any fact mentioning money or death as forbidden', () => {
    expect(isForbiddenFact({title: 'Calves born', summary: 'Seven healthy calves'})).toBe(false);
    expect(isForbiddenFact({title: 'Cattle sales', summary: 'sold 12 head'})).toBe(true);
    expect(isForbiddenFact({title: 'Revenue up', summary: 'profit climbed'})).toBe(true);
    expect(isForbiddenFact({title: 'Loss', summary: '3 mortalities this month'})).toBe(true);
    expect(isForbiddenFact({title: 'Feed price', summary: 'cost $4.20/bu'})).toBe(true);
    // "processed" / "production" are accomplishments and stay allowed.
    expect(isForbiddenFact({title: 'Broilers processed', summary: '280 birds processed'})).toBe(false);
  });

  it('assertNoForbiddenFacts drops forbidden candidates', () => {
    const kept = assertNoForbiddenFacts([
      {title: 'Calves born', summary: 'seven calves'},
      {title: 'Beef sold', summary: '$3,000 in sales'},
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe('Calves born');
  });

  it('detectNewsletterFacts never emits a forbidden fact', () => {
    const facts = detectNewsletterFacts(
      withPeriod({
        broilerBatches: [{name: 'B1', status: 'growing', currentCount: 100}],
        pigFarrowings: [{group: 'G1', farrowingDate: '2026-05-03', bornAlive: 10}],
      }),
    );
    for (const f of facts) expect(isForbiddenFact(f)).toBe(false);
  });

  it('exposes one detector per registry entry', () => {
    expect(NEWSLETTER_DETECTORS.length).toBeGreaterThanOrEqual(8);
  });
});

describe('autopilot detectors — pasture / processing / tasks / daily reports', () => {
  it('detectPastureMoves counts in-period moves and lists groups', () => {
    const f = detectPastureMoves(
      withPeriod({
        pastureMoves: [
          {date: '2026-05-10', groupLabel: 'Mommas'},
          {date: '2026-05-18', groupLabel: 'Feeders'},
          {date: '2026-04-30', groupLabel: 'Old'}, // out of period
        ],
      }),
    );
    expect(f.metricValue).toBe(2);
    expect(f.detectorKey).toBe('pasture_moves');
    expect(f.evidence.groups).toEqual(['Mommas', 'Feeders']);
  });

  it('detectCompletedTasks drops recurring/system tasks and forbidden titles', () => {
    const f = detectCompletedTasks(
      withPeriod({
        completedTasks: [
          {date: '2026-05-05', title: 'Raised the new barn', fromRecurring: false, designation: 'standard'},
          {date: '2026-05-06', title: 'Daily feed check', fromRecurring: true, designation: 'standard'}, // recurring
          {date: '2026-05-07', title: 'Sold the old tractor', fromRecurring: false, designation: 'standard'}, // forbidden word
          {date: '2026-05-08', title: 'System sync', fromRecurring: false, designation: 'system'}, // system
        ],
      }),
    );
    expect(f.metricValue).toBe(1);
    expect(f.evidence.titles).toEqual(['Raised the new barn']);
    expect(isForbiddenFact(f)).toBe(false);
  });

  it('detectCompletedTasks returns null when every notable title is unsafe', () => {
    const f = detectCompletedTasks(
      withPeriod({completedTasks: [{date: '2026-05-07', title: 'Recorded mortality counts', fromRecurring: false}]}),
    );
    expect(f).toBeNull();
  });

  it('detectProcessing reports batch count + hanging weight (no finance)', () => {
    const f = detectProcessing(
      withPeriod({processingBatches: [{date: '2026-05-15', name: 'B1', hangingWeightLbs: 1200}]}),
    );
    expect(f.metricValue).toBe(1);
    expect(f.displayValue).toMatch(/lbs/);
    expect(isForbiddenFact(f)).toBe(false);
  });

  it('detectDailyReports counts reports across distinct days', () => {
    const f = detectDailyReports(
      withPeriod({dailySubmissions: [{date: '2026-05-01'}, {date: '2026-05-01'}, {date: '2026-05-02'}]}),
    );
    expect(f.metricValue).toBe(3);
    expect(f.evidence.days).toBe(2);
  });

  it('detectNewsletterFacts wires the new sources into the pipeline', () => {
    const facts = detectNewsletterFacts(
      withPeriod({
        pastureMoves: [{date: '2026-05-10', groupLabel: 'Mommas'}],
        completedTasks: [{date: '2026-05-05', title: 'Raised the new barn', fromRecurring: false}],
        dailySubmissions: [{date: '2026-05-01'}],
      }),
    );
    const keys = facts.map((f) => f.detectorKey);
    expect(keys).toContain('pasture_moves');
    expect(keys).toContain('completed_tasks');
    expect(keys).toContain('daily_reports');
    for (const f of facts) expect(isForbiddenFact(f)).toBe(false);
  });
});

describe('isForbiddenText — per-string guard', () => {
  it('flags finance/mortality words and dollar signs, allows clean text', () => {
    expect(isForbiddenText('Sold the herd')).toBe(true);
    expect(isForbiddenText('Recorded a death')).toBe(true);
    expect(isForbiddenText('Cost $5')).toBe(true);
    expect(isForbiddenText('Raised the new barn roof')).toBe(false);
    expect(isForbiddenText('142 head of cattle')).toBe(false);
  });
});
