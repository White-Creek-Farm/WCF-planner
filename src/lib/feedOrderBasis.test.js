import {describe, it, expect} from 'vitest';
import {addMonthsYM, calendarOrderYM, feedOrderBasis, recommendedFeedOrder, ymFromDate} from './feedOrderBasis.js';

describe('feedOrderBasis', () => {
  it('uses the count-aware Actual On Hand when a current-month count exists', () => {
    expect(feedOrderBasis({hasCurrentCount: true, actualOnHand: 5500, endOfPrevEst: 7222})).toBe(5500);
  });

  it('falls back to the previous-month estimate when no current-month count', () => {
    expect(feedOrderBasis({hasCurrentCount: false, actualOnHand: 5500, endOfPrevEst: 7222})).toBe(7222);
  });

  it('falls back to the estimate if a count is flagged but Actual On Hand is null', () => {
    expect(feedOrderBasis({hasCurrentCount: true, actualOnHand: null, endOfPrevEst: 7222})).toBe(7222);
  });
});

describe('recommendedFeedOrder — count-aware contract (production screenshot, Jun 1 2026)', () => {
  // The bug: with a fresh June physical count, the recommendation still
  // subtracted End of May Est. instead of Actual On Hand.
  it('Starter: 5,571 need − 5,500 on hand = 71 (was 0 from 5,571 − 7,222 est.)', () => {
    expect(
      recommendedFeedOrder({needThruNext: 5571, hasCurrentCount: true, actualOnHand: 5500, endOfPrevEst: 7222}),
    ).toBe(71);
  });

  it('Grower: 31,000 need − 13,117 on hand = 17,883', () => {
    expect(
      recommendedFeedOrder({needThruNext: 31000, hasCurrentCount: true, actualOnHand: 13117, endOfPrevEst: 99999}),
    ).toBe(17883);
  });

  it('Layer: 8,599 need − 8,500 on hand = 99 (was 104 from 8,599 − 8,495 est.)', () => {
    expect(
      recommendedFeedOrder({needThruNext: 8599, hasCurrentCount: true, actualOnHand: 8500, endOfPrevEst: 8495}),
    ).toBe(99);
  });
});

describe('recommendedFeedOrder — basis selection + clamping', () => {
  it('no current-month count keeps the previous-month estimate basis', () => {
    expect(
      recommendedFeedOrder({needThruNext: 8599, hasCurrentCount: false, actualOnHand: 8500, endOfPrevEst: 8495}),
    ).toBe(104);
  });

  it('clamps a negative recommendation to 0 (already have more than needed)', () => {
    expect(
      recommendedFeedOrder({needThruNext: 5571, hasCurrentCount: false, actualOnHand: null, endOfPrevEst: 7222}),
    ).toBe(0);
  });

  it('returns null when no basis is available (no count, no prev-month ledger end)', () => {
    expect(
      recommendedFeedOrder({needThruNext: 5571, hasCurrentCount: false, actualOnHand: null, endOfPrevEst: null}),
    ).toBeNull();
  });

  it('a current-month count produces a recommendation even with no prev-month ledger', () => {
    expect(
      recommendedFeedOrder({needThruNext: 5571, hasCurrentCount: true, actualOnHand: 5500, endOfPrevEst: null}),
    ).toBe(71);
  });
});

describe('calendarOrderYM', () => {
  it('pins every day in July 2026 to the July 2026 order month', () => {
    expect(calendarOrderYM(new Date(2026, 6, 1))).toBe('2026-07');
    expect(calendarOrderYM(new Date(2026, 6, 15))).toBe('2026-07');
    expect(calendarOrderYM(new Date(2026, 6, 31))).toBe('2026-07');
  });

  it('advances only when the calendar month flips', () => {
    expect(calendarOrderYM(new Date(2026, 7, 1))).toBe('2026-08');
  });

  it('handles year rollover', () => {
    expect(calendarOrderYM(new Date(2026, 11, 15))).toBe('2026-12');
    expect(addMonthsYM('2026-12', 1)).toBe('2027-01');
    expect(ymFromDate(new Date(2026, 11, 15))).toBe('2026-12');
  });
});
