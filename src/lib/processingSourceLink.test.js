// Unit coverage for the planner-integration link/format helpers. These are the
// pure presentation counterparts of the mig-176 server projection: exact
// two-way navigation routes and program-specific age formatting.
import {describe, expect, it} from 'vitest';
import {
  NOT_RECORDED,
  ageRangeText,
  displayOrNotRecorded,
  displayRecordTitle,
  monthsWeeksText,
  pigPlanSignal,
  pigTripSexLabel,
  recordAgeText,
  sourceLinkLabel,
  sourceRouteForRecord,
  weeksDaysText,
  yearsMonthsText,
} from './processingSourceLink.js';

describe('sourceRouteForRecord', () => {
  it('routes broiler by the LIVE batch name from the projection (not the id source_id)', () => {
    const rec = {source_kind: 'broiler', source_id: 'batch-uuid-1', source: {batch_name: 'B-26 04'}};
    expect(sourceRouteForRecord(rec)).toBe('/broiler/batches/B-26%2004');
  });

  it('returns null for a broiler record with no live batch name (unmatched source)', () => {
    expect(sourceRouteForRecord({source_kind: 'broiler', source_id: 'x', source: {matched: false}})).toBeNull();
  });

  it('routes cattle and sheep by batch id', () => {
    expect(sourceRouteForRecord({source_kind: 'cattle', source_id: 'cpb-1'})).toBe('/cattle/batches/cpb-1');
    expect(sourceRouteForRecord({source_kind: 'sheep', source_id: 'spb-2'})).toBe('/sheep/batches/spb-2');
  });

  it('routes pig to the exact trip, splitting the composite id on the FIRST colon', () => {
    expect(sourceRouteForRecord({source_kind: 'pig', source_id: 'g1:pt-a:b'})).toBe('/pig/batches/g1?trip=pt-a%3Ab');
  });

  it('returns null for milestones / records without a source', () => {
    expect(sourceRouteForRecord({record_type: 'milestone'})).toBeNull();
    expect(sourceRouteForRecord({source_kind: 'pig', source_id: 'no-colon'})).toBeNull();
    expect(sourceRouteForRecord(null)).toBeNull();
  });
});

describe('sourceLinkLabel', () => {
  it('labels per program', () => {
    expect(sourceLinkLabel({source_kind: 'pig'})).toBe('View pig trip');
    expect(sourceLinkLabel({source_kind: 'broiler'})).toBe('View broiler batch');
    expect(sourceLinkLabel({source_kind: 'cattle'})).toBe('View cattle batch');
    expect(sourceLinkLabel(null)).toBeNull();
  });
});

describe('age formatting', () => {
  it('weeksDaysText: whole days -> Nw Nd', () => {
    expect(weeksDaysText(52)).toBe('7w 3d');
    expect(weeksDaysText(0)).toBe('0w 0d');
    expect(weeksDaysText(-1)).toBeNull();
    expect(weeksDaysText('nope')).toBeNull();
  });

  it('yearsMonthsText: whole days -> Ny Mm', () => {
    expect(yearsMonthsText(400)).toBe('1y 1m');
    expect(yearsMonthsText(29)).toBe('0y 0m');
  });

  it('monthsWeeksText: whole days -> Nm Nw', () => {
    expect(monthsWeeksText(165)).toBe('5m 2w');
    expect(monthsWeeksText(6)).toBe('0m 0w');
  });

  it('ageRangeText collapses equal bounds, ranges distinct ones, marks estimates', () => {
    expect(ageRangeText({min_days: 160, max_days: 160}, monthsWeeksText)).toBe('5m 1w');
    expect(ageRangeText({min_days: 160, max_days: 175}, monthsWeeksText)).toBe('5m 1w – 5m 3w');
    expect(ageRangeText({min_days: 160, max_days: 175, estimated: true}, monthsWeeksText)).toBe('5m 1w – 5m 3w (est.)');
    expect(ageRangeText(null, monthsWeeksText)).toBeNull();
    expect(ageRangeText({min_days: null, max_days: null}, monthsWeeksText)).toBeNull();
  });

  it('recordAgeText picks the program formatter', () => {
    expect(recordAgeText({source_kind: 'broiler', source: {age_days: 52}})).toBe('7w 3d');
    expect(recordAgeText({source_kind: 'pig', source: {age: {min_days: 160, max_days: 160}}})).toBe('5m 1w');
    expect(recordAgeText({source_kind: 'cattle', source: {age: {min_days: 730, max_days: 730}}})).toBe('2y 0m');
    expect(recordAgeText({source_kind: 'cattle', source: {}})).toBeNull();
    expect(recordAgeText({source_kind: 'cattle'})).toBeNull();
  });
});

describe('displayOrNotRecorded', () => {
  it('never estimates: nullish/blank values render the canonical placeholder', () => {
    expect(displayOrNotRecorded(null)).toBe(NOT_RECORDED);
    expect(displayOrNotRecorded(undefined)).toBe(NOT_RECORDED);
    expect(displayOrNotRecorded('   ')).toBe(NOT_RECORDED);
    expect(displayOrNotRecorded(0)).toBe('0');
    expect(displayOrNotRecorded('B-26-04')).toBe('B-26-04');
  });
});

describe('pigPlanSignal', () => {
  it('is a planned-pig-only soft signal', () => {
    expect(pigPlanSignal({source_kind: 'pig', source: {phase: 'planned'}})).toBe('Auto-planned');
    expect(pigPlanSignal({source_kind: 'pig', source: {phase: 'planned', scheduled_with_processor: true}})).toBe(
      'Processor scheduled',
    );
    expect(pigPlanSignal({source_kind: 'pig', source: {phase: 'actual'}})).toBeNull();
    expect(pigPlanSignal({source_kind: 'broiler', source: {phase: 'planned'}})).toBeNull();
    expect(pigPlanSignal({source_kind: 'pig', source_phase: 'planned', source: {}})).toBe('Auto-planned');
    expect(pigPlanSignal(null)).toBeNull();
  });
});

describe('pigTripSexLabel', () => {
  const pigRec = (attribution) => ({
    source_kind: 'pig',
    source_id: 'g1:pt-a',
    sub_batch_attribution: attribution,
  });

  it('maps a boar trip to the singular Boar label for every consumer row', () => {
    expect(pigTripSexLabel(pigRec([{subId: 's1', sex: 'Boars', count: 4}]))).toBe('Boar');
    // Server-side singular/lowercase spellings normalize the same way the
    // SQL boar% matcher does — normalization, not inference.
    expect(pigTripSexLabel(pigRec([{sex: 'boar'}]))).toBe('Boar');
  });

  it('maps a gilt trip to the singular Gilt label', () => {
    expect(pigTripSexLabel(pigRec([{subId: 's1', sex: 'Gilts', count: 3}]))).toBe('Gilt');
    expect(pigTripSexLabel(pigRec([{sex: 'gilt'}]))).toBe('Gilt');
  });

  it('multiple same-sex attribution entries still resolve to the one trip sex', () => {
    expect(
      pigTripSexLabel(
        pigRec([
          {sex: 'Gilts', count: 2},
          {sex: 'gilt', count: 1},
        ]),
      ),
    ).toBe('Gilt');
  });

  it('never guesses: empty, unknown, or conflicting attributions are null (renders Not recorded)', () => {
    expect(pigTripSexLabel(pigRec([]))).toBeNull();
    expect(pigTripSexLabel(pigRec(null))).toBeNull();
    expect(pigTripSexLabel(pigRec([{subId: 's1', count: 4}]))).toBeNull(); // sex absent
    expect(pigTripSexLabel(pigRec([{sex: 'mixed'}]))).toBeNull(); // unknown vocabulary
    expect(pigTripSexLabel(pigRec([{sex: 'Boars'}, {sex: 'Gilts'}]))).toBeNull(); // conflict
  });

  it('resolves per record, so different trips in one batch keep their own sex', () => {
    const tripA = {source_kind: 'pig', source_id: 'g1:pt-a', sub_batch_attribution: [{sex: 'Boars'}]};
    const tripB = {source_kind: 'pig', source_id: 'g1:pt-b', sub_batch_attribution: [{sex: 'Gilts'}]};
    expect(pigTripSexLabel(tripA)).toBe('Boar');
    expect(pigTripSexLabel(tripB)).toBe('Gilt');
  });

  it('is pig-only and null-safe', () => {
    expect(pigTripSexLabel({source_kind: 'cattle', sub_batch_attribution: [{sex: 'Boars'}]})).toBeNull();
    expect(pigTripSexLabel(null)).toBeNull();
  });
});

describe('displayRecordTitle — pig drawer title simplification (display-only)', () => {
  const pigRec = (overrides = {}) => ({
    source_kind: 'pig',
    record_type: 'planner_batch',
    title: 'Pig Trip · P-26-01 · Trip 3',
    trip_ordinal: 3,
    source: {matched: true, batch_name: 'P-26-01'},
    ...overrides,
  });

  it("renders 'Pig Trip · P-26-01 · Trip 3' as 'P-26-01 · Trip 3'", () => {
    expect(displayRecordTitle(pigRec())).toBe('P-26-01 · Trip 3');
  });

  it('preserves the canonical batch name and trip number, including Trip 0 and renamed batches', () => {
    expect(displayRecordTitle(pigRec({trip_ordinal: 0, title: 'Pig Trip · P-26-01 · Trip 0'}))).toBe(
      'P-26-01 · Trip 0',
    );
    expect(displayRecordTitle(pigRec({source: {matched: true, batch_name: 'P-26-02 renamed'}}))).toBe(
      'P-26-02 renamed · Trip 3',
    );
  });

  it('fails closed to the stored title when pig source data is missing or invalid', () => {
    expect(displayRecordTitle(pigRec({source: {matched: false}}))).toBe('Pig Trip · P-26-01 · Trip 3');
    expect(displayRecordTitle(pigRec({source: null}))).toBe('Pig Trip · P-26-01 · Trip 3');
    expect(displayRecordTitle(pigRec({source: {matched: true, batch_name: '   '}}))).toBe(
      'Pig Trip · P-26-01 · Trip 3',
    );
    expect(displayRecordTitle(pigRec({trip_ordinal: null}))).toBe('Pig Trip · P-26-01 · Trip 3');
    expect(displayRecordTitle(pigRec({trip_ordinal: 'x'}))).toBe('Pig Trip · P-26-01 · Trip 3');
  });

  it('leaves every non-pig, milestone, and historical title byte-identical', () => {
    expect(displayRecordTitle({source_kind: 'cattle', record_type: 'planner_batch', title: 'C-26-05'})).toBe('C-26-05');
    expect(displayRecordTitle({source_kind: 'broiler', record_type: 'planner_batch', title: 'B-26-04'})).toBe(
      'B-26-04',
    );
    expect(displayRecordTitle({record_type: 'milestone', title: 'Order boxes'})).toBe('Order boxes');
    expect(displayRecordTitle({source_kind: null, record_type: 'asana_historical', title: 'WCF-P-25-3: 8'})).toBe(
      'WCF-P-25-3: 8',
    );
    // A pig-kind row that is NOT a planner record also stays untouched.
    expect(
      displayRecordTitle({
        source_kind: 'pig',
        record_type: 'asana_historical',
        title: 'WCF-P-25-4: 6',
        trip_ordinal: 1,
      }),
    ).toBe('WCF-P-25-4: 6');
    expect(displayRecordTitle(null)).toBe('');
  });
});
