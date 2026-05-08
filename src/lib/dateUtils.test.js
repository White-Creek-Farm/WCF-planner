import {describe, it, expect} from 'vitest';
import {addDays, toISO, fmt, fmtS, todayISO, todayCentralISO, fmtCentralDateTime} from './dateUtils.js';

describe('addDays', () => {
  it('adds days to an ISO date string and returns a Date object', () => {
    const result = addDays('2026-04-25', 5);
    expect(result).toBeInstanceOf(Date);
    expect(toISO(result)).toBe('2026-04-30');
  });

  it('handles negative days (subtraction)', () => {
    expect(toISO(addDays('2026-04-25', -7))).toBe('2026-04-18');
  });

  it('handles month-boundary crossing', () => {
    expect(toISO(addDays('2026-04-28', 5))).toBe('2026-05-03');
  });

  it('handles year-boundary crossing', () => {
    expect(toISO(addDays('2026-12-30', 5))).toBe('2027-01-04');
  });

  it('zero days returns the same date (noon-anchor avoids timezone drift)', () => {
    // The 'T12:00:00' anchor in addDays means a 0-day shift never crosses
    // midnight in any reasonable runner timezone.
    expect(toISO(addDays('2026-04-25', 0))).toBe('2026-04-25');
  });

  it('accepts a Date object as input', () => {
    const start = new Date('2026-04-25T12:00:00');
    expect(toISO(addDays(start, 1))).toBe('2026-04-26');
  });
});

describe('toISO', () => {
  it('returns YYYY-MM-DD from a Date', () => {
    expect(toISO(new Date('2026-04-25T12:00:00Z'))).toBe('2026-04-25');
  });

  it('strips the time portion from a full ISO timestamp string', () => {
    expect(toISO('2026-04-25T15:30:00Z')).toBe('2026-04-25');
  });
});

describe('fmt (mm/dd/yy)', () => {
  it('formats a YYYY-MM-DD string as mm/dd/yy', () => {
    expect(fmt('2026-04-25')).toBe('04/25/26');
  });

  it('zero-pads single-digit months and days', () => {
    expect(fmt('2026-01-05')).toBe('01/05/26');
  });

  it('accepts a full ISO timestamp and uses only the date portion', () => {
    expect(fmt('2026-04-25T15:30:00Z')).toBe('04/25/26');
  });

  it('returns "—" for null, undefined, or empty input', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(fmt('')).toBe('—');
  });

  it('returns "—" for malformed input', () => {
    expect(fmt('not-a-date')).toBe('—');
  });
});

describe('fmtS (mm/dd, no year)', () => {
  it('formats a YYYY-MM-DD string as mm/dd', () => {
    expect(fmtS('2026-04-25')).toBe('04/25');
  });

  it('zero-pads single-digit months and days', () => {
    expect(fmtS('2026-01-05')).toBe('01/05');
  });

  it('returns "—" for null/empty/malformed', () => {
    expect(fmtS(null)).toBe('—');
    expect(fmtS('')).toBe('—');
    expect(fmtS('not-a-date')).toBe('—');
  });
});

describe('todayISO', () => {
  it('returns a YYYY-MM-DD formatted string', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches toISO(new Date()) at the same instant', () => {
    expect(todayISO()).toBe(toISO(new Date()));
  });
});

describe('todayCentralISO', () => {
  it('returns a YYYY-MM-DD formatted string', () => {
    expect(todayCentralISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the Central-time date (CST: UTC-6) for a midnight-UTC instant before CST midnight rolls', () => {
    // 2026-05-08 04:00:00 UTC = 2026-05-07 23:00:00 CST. Central
    // calendar date is still May 7th.
    expect(todayCentralISO(new Date('2026-05-08T04:00:00Z'))).toBe('2026-05-07');
  });

  it('returns the Central-time date (CST: UTC-6) for a UTC instant just after CST midnight rolls', () => {
    // 2026-05-08 06:30:00 UTC = 2026-05-08 00:30:00 CST. Central
    // calendar date has flipped to May 8th.
    expect(todayCentralISO(new Date('2026-05-08T06:30:00Z'))).toBe('2026-05-08');
  });

  it('returns the Central-time date (CDT: UTC-5) for a UTC instant during DST', () => {
    // 2026-07-04 04:30:00 UTC = 2026-07-03 23:30:00 CDT. Central
    // calendar date is still July 3rd because daylight time keeps
    // the offset at -5 (which the formatter computes for us).
    expect(todayCentralISO(new Date('2026-07-04T04:30:00Z'))).toBe('2026-07-03');
  });

  it('accepts a timestamp number as well as a Date instance', () => {
    const ts = Date.parse('2026-05-08T18:00:00Z'); // mid-afternoon Central
    expect(todayCentralISO(ts)).toBe('2026-05-08');
  });
});

describe('fmtCentralDateTime', () => {
  it('formats a UTC instant as mm/dd/yy h:mm AM/PM in America/Chicago (CDT, UTC-5)', () => {
    // 2026-05-08 18:00:00 UTC = 2026-05-08 13:00 CDT (DST in May).
    expect(fmtCentralDateTime('2026-05-08T18:00:00Z')).toBe('05/08/26 1:00 PM');
  });

  it('rolls the displayed date back one day when the UTC instant is before Central midnight', () => {
    // 2026-05-08 04:00:00 UTC = 2026-05-07 23:00 CDT (still May 7th in
    // Central time even though UTC has flipped).
    expect(fmtCentralDateTime('2026-05-08T04:00:00Z')).toBe('05/07/26 11:00 PM');
  });

  it('formats midnight Central correctly as 12:00 AM', () => {
    // 2026-05-08 05:00:00 UTC = 2026-05-08 00:00 CDT.
    expect(fmtCentralDateTime('2026-05-08T05:00:00Z')).toBe('05/08/26 12:00 AM');
  });

  it('respects standard time offset (CST, UTC-6) outside of DST', () => {
    // 2026-12-15 18:00:00 UTC = 2026-12-15 12:00 CST.
    expect(fmtCentralDateTime('2026-12-15T18:00:00Z')).toBe('12/15/26 12:00 PM');
  });

  it('returns "—" for null, undefined, empty, or malformed input', () => {
    expect(fmtCentralDateTime(null)).toBe('—');
    expect(fmtCentralDateTime(undefined)).toBe('—');
    expect(fmtCentralDateTime('')).toBe('—');
    expect(fmtCentralDateTime('not-a-date')).toBe('—');
  });
});
