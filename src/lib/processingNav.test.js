import {describe, it, expect, vi, afterEach} from 'vitest';
import {
  PROCESSING_OPEN_RECORD_EVENT,
  processingRecordRoute,
  processingSourceRoute,
  parseProcessingRecordId,
  navigateToProcessingRoute,
  navigateToProcessingRecord,
} from './processingNav.js';

describe('processingRecordRoute', () => {
  it('builds the per-record deep link with an encoded id', () => {
    expect(processingRecordRoute('pr-123')).toBe('/processing?record=pr-123');
    expect(processingRecordRoute('a b&c')).toBe('/processing?record=a%20b%26c');
  });

  it('degrades to the flat /processing page when the id is missing', () => {
    expect(processingRecordRoute()).toBe('/processing');
    expect(processingRecordRoute(null)).toBe('/processing');
    expect(processingRecordRoute('')).toBe('/processing');
  });
});

describe('processingSourceRoute', () => {
  it('builds single-part source keys (broiler/cattle/sheep)', () => {
    expect(processingSourceRoute('broiler', 'ppp-v4-abc')).toBe('/processing?source=broiler:ppp-v4-abc');
    expect(processingSourceRoute('cattle', 'cb-1')).toBe('/processing?source=cattle:cb-1');
  });

  it('keeps the pig groupId:tripId colon separator literal while encoding each part', () => {
    expect(processingSourceRoute('pig', 'grp-1', 'trip-2')).toBe('/processing?source=pig:grp-1:trip-2');
    // A part containing reserved characters is encoded; the separator is not.
    expect(processingSourceRoute('pig', 'g 1', 't&2')).toBe('/processing?source=pig:g%201:t%262');
  });

  it('URLSearchParams round-trips the source value back to kind:id parts', () => {
    const route = processingSourceRoute('pig', 'grp-1', 'trip-2');
    const params = new URLSearchParams(route.split('?')[1]);
    expect(params.get('source')).toBe('pig:grp-1:trip-2');
  });
});

describe('parseProcessingRecordId', () => {
  it('extracts the record id (decoding it) from a record deep link', () => {
    expect(parseProcessingRecordId('/processing?record=pr-123')).toBe('pr-123');
    expect(parseProcessingRecordId(processingRecordRoute('a b&c'))).toBe('a b&c');
  });

  it('returns null for the flat page, source links, and non-processing routes', () => {
    expect(parseProcessingRecordId('/processing')).toBe(null);
    expect(parseProcessingRecordId('/processing?source=broiler:x')).toBe(null);
    expect(parseProcessingRecordId('/tasks?record=pr-1')).toBe(null);
    expect(parseProcessingRecordId('/processing/other?record=pr-1')).toBe(null);
    expect(parseProcessingRecordId(null)).toBe(null);
    expect(parseProcessingRecordId(undefined)).toBe(null);
  });
});

describe('navigateToProcessingRoute / navigateToProcessingRecord', () => {
  // vitest runs in a node environment — stub the minimal window surface the
  // helper touches so the already-mounted-view event dispatch is observable.
  afterEach(() => {
    delete globalThis.window;
  });

  it('navigates and dispatches the open-record event for record deep links', () => {
    const dispatched = [];
    globalThis.window = {dispatchEvent: (e) => dispatched.push(e)};
    const navigate = vi.fn();
    navigateToProcessingRoute(navigate, '/processing?record=pr-9');
    expect(navigate).toHaveBeenCalledWith('/processing?record=pr-9');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe(PROCESSING_OPEN_RECORD_EVENT);
    expect(dispatched[0].detail).toEqual({recordId: 'pr-9'});
  });

  it('navigates WITHOUT dispatching for source links and the flat page', () => {
    const dispatchEvent = vi.fn();
    globalThis.window = {dispatchEvent};
    const navigate = vi.fn();
    navigateToProcessingRoute(navigate, '/processing?source=pig:g1:t1');
    navigateToProcessingRoute(navigate, '/processing');
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('navigateToProcessingRecord builds the route and dispatches with the raw id', () => {
    const dispatched = [];
    globalThis.window = {dispatchEvent: (e) => dispatched.push(e)};
    const navigate = vi.fn();
    navigateToProcessingRecord(navigate, 'pr-42');
    expect(navigate).toHaveBeenCalledWith('/processing?record=pr-42');
    expect(dispatched[0].detail.recordId).toBe('pr-42');
  });

  it('survives a non-browser environment (no window) without throwing', () => {
    const navigate = vi.fn();
    expect(() => navigateToProcessingRecord(navigate, 'pr-1')).not.toThrow();
    expect(navigate).toHaveBeenCalledWith('/processing?record=pr-1');
  });
});
