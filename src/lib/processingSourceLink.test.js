// Unit coverage for the planner-integration link/format helpers. These are the
// pure presentation counterparts of the mig-176 server projection: exact
// two-way navigation routes and program-specific age formatting.
import {describe, expect, it} from 'vitest';
import {
  NOT_RECORDED,
  ageRangeText,
  displayOrNotRecorded,
  monthsWeeksText,
  pigPlanSignal,
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
