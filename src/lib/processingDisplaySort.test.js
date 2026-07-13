import {describe, expect, it} from 'vitest';
import {sortProcessingRecordsForDisplay} from './processingDisplaySort.js';

function ids(rows) {
  return rows.map((r) => r.id);
}

describe('sortProcessingRecordsForDisplay', () => {
  it('orders the three buckets In Process -> Planned -> Complete', () => {
    const rows = [
      {id: 'c', effective_status: 'complete', completed_at: '2026-05-01T10:00:00Z'},
      {id: 'p', effective_status: 'planned', processing_date: '2026-08-01'},
      {id: 'i', effective_status: 'in_process', processing_date: '2026-07-01'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['i', 'p', 'c']);
  });

  it('sorts In Process oldest processing_date first', () => {
    const rows = [
      {id: 'newer', effective_status: 'in_process', processing_date: '2026-07-10'},
      {id: 'oldest', effective_status: 'in_process', processing_date: '2026-06-01'},
      {id: 'mid', effective_status: 'in_process', processing_date: '2026-06-15'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['oldest', 'mid', 'newer']);
  });

  it('sorts Planned nearest date first (ascending)', () => {
    const rows = [
      {id: 'far', effective_status: 'planned', processing_date: '2026-12-20'},
      {id: 'near', effective_status: 'planned', processing_date: '2026-07-20'},
      {id: 'later', effective_status: 'planned', processing_date: '2026-09-05'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['near', 'later', 'far']);
  });

  it('sorts Complete newest completed_at first (descending)', () => {
    const rows = [
      {id: 'old', effective_status: 'complete', completed_at: '2026-01-05T08:00:00Z', processing_date: '2026-01-04'},
      {id: 'new', effective_status: 'complete', completed_at: '2026-06-20T08:00:00Z', processing_date: '2026-06-19'},
      {id: 'mid', effective_status: 'complete', completed_at: '2026-03-10T08:00:00Z', processing_date: '2026-03-09'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['new', 'mid', 'old']);
  });

  it('sinks undated rows to the end of the In Process and Planned buckets', () => {
    const rows = [
      {id: 'i-undated', effective_status: 'in_process', processing_date: null},
      {id: 'i-dated', effective_status: 'in_process', processing_date: '2026-06-01'},
      {id: 'p-undated', effective_status: 'planned'},
      {id: 'p-dated', effective_status: 'planned', processing_date: '2026-08-01'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['i-dated', 'i-undated', 'p-dated', 'p-undated']);
  });

  it('sinks Complete rows missing completed_at to the end of the Complete bucket', () => {
    const rows = [
      {id: 'no-stamp', effective_status: 'complete', completed_at: null},
      {id: 'stamped', effective_status: 'complete', completed_at: '2026-02-01T00:00:00Z'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['stamped', 'no-stamp']);
  });

  it('treats unknown or missing effective_status as Planned', () => {
    const rows = [
      {id: 'weird', effective_status: 'not-a-status', processing_date: '2026-07-01'},
      {id: 'missing', processing_date: '2026-06-01'},
      {id: 'i', effective_status: 'in_process', processing_date: '2026-09-01'},
      {id: 'c', effective_status: 'complete', completed_at: '2026-01-01T00:00:00Z'},
    ];
    expect(ids(sortProcessingRecordsForDisplay(rows))).toEqual(['i', 'missing', 'weird', 'c']);
  });

  it('returns a new array without mutating the input and keeps tie order stable', () => {
    const rows = [
      {id: 'a', effective_status: 'planned', processing_date: '2026-07-01'},
      {id: 'b', effective_status: 'planned', processing_date: '2026-07-01'},
    ];
    const input = rows.slice();
    const out = sortProcessingRecordsForDisplay(input);
    expect(out).not.toBe(input);
    expect(ids(input)).toEqual(['a', 'b']);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(sortProcessingRecordsForDisplay(null)).toEqual([]);
  });
});
