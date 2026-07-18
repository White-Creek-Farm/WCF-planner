import {describe, it, expect} from 'vitest';
import {summarizeCarcassYield} from './carcassYield.js';

// One shared carcass-yield helper for cattle/sheep/pig Processing Source
// details. Locks: planner-parity math (sum first, divide once, one decimal),
// exact source-identity totals, and fail-closed behavior — null fields for
// missing/zero/malformed inputs, never 0%, NaN, or Infinity.

describe('summarizeCarcassYield', () => {
  it('cattle/sheep shape: sums valid positive detail weights and divides once (one decimal)', () => {
    // Mirrors the cattle batch page example: 1100+1450 live, 660+870 hanging.
    const s = summarizeCarcassYield({liveValues: [1100, 1450], hangingValues: [660, 870]});
    expect(s.totalLive).toBe(2550);
    expect(s.totalHang).toBe(1530);
    expect(s.yieldPct).toBe(60);
  });

  it('pig shape: summed live weights + single trip hangingWeight matches tripYield exactly', () => {
    // Mirrors src/lib/pig.test.js: 400+400 live, 555 hanging → 69.4 (69.375 rounded).
    const s = summarizeCarcassYield({liveValues: [400, 400], hangingTotal: 555});
    expect(s.totalLive).toBe(800);
    expect(s.totalHang).toBe(555);
    expect(s.yieldPct).toBe(69.4);
  });

  it('display example: 3,240 live / 2,009 hanging → 62.0', () => {
    const s = summarizeCarcassYield({liveValues: [3240], hangingTotal: 2009});
    expect(s.yieldPct).toBe(62);
    expect(s.yieldPct.toFixed(1)).toBe('62.0');
  });

  it('sums BEFORE dividing — never averages per-animal percentages', () => {
    // Per-animal yields would be 50% and 70% (average 60); the correct
    // summed yield is 850/1500 = 56.7.
    const s = summarizeCarcassYield({liveValues: [1000, 500], hangingValues: [500, 350]});
    expect(s.yieldPct).toBe(56.7);
  });

  it('accepts valid numeric strings and decimal numbers (planner-stored shapes)', () => {
    const s = summarizeCarcassYield({liveValues: ['400', '400'], hangingTotal: '600'});
    expect(s.totalLive).toBe(800);
    expect(s.totalHang).toBe(600);
    expect(s.yieldPct).toBe(75);
    const dec = summarizeCarcassYield({liveValues: [120.5, '130.5'], hangingTotal: 125.5});
    expect(dec.totalLive).toBe(251);
    expect(dec.totalHang).toBe(125.5);
    expect(dec.yieldPct).toBe(50);
  });

  it('STRICT validation: partial-numeric and formatted strings are rejected, never parseFloat-truncated', () => {
    // parseFloat('120junk') would yield 120; the strict rule contributes 0.
    const s = summarizeCarcassYield({liveValues: [400, '120junk', 400], hangingTotal: 555});
    expect(s.totalLive).toBe(800);
    expect(s.yieldPct).toBe(69.4);
    // Thousands separators are not valid stored weights.
    expect(summarizeCarcassYield({liveValues: ['1,200'], hangingTotal: 600}).totalLive).toBeNull();
    // Whitespace-only, NaN, and Infinity never count — on either side.
    expect(summarizeCarcassYield({liveValues: ['   '], hangingTotal: 600}).totalLive).toBeNull();
    expect(summarizeCarcassYield({liveValues: [NaN, Infinity], hangingTotal: 600}).totalLive).toBeNull();
    expect(summarizeCarcassYield({liveValues: [800], hangingTotal: '555junk'}).yieldPct).toBeNull();
    expect(summarizeCarcassYield({liveValues: [800], hangingTotal: Infinity}).yieldPct).toBeNull();
  });

  it('ignores malformed, zero, and negative entries instead of poisoning totals', () => {
    const s = summarizeCarcassYield({liveValues: [400, 'abc', 0, -50, null, undefined, 400], hangingTotal: 555});
    expect(s.totalLive).toBe(800);
    expect(s.yieldPct).toBe(69.4);
  });

  it('fails closed to nulls: empty inputs produce no percentage — never 0%, NaN, or Infinity', () => {
    expect(summarizeCarcassYield({})).toEqual({totalLive: null, totalHang: null, yieldPct: null});
    expect(summarizeCarcassYield()).toEqual({totalLive: null, totalHang: null, yieldPct: null});
    // Live present, hanging missing → no yield (planned/incomplete data).
    const liveOnly = summarizeCarcassYield({liveValues: [400, 400]});
    expect(liveOnly.totalLive).toBe(800);
    expect(liveOnly.totalHang).toBeNull();
    expect(liveOnly.yieldPct).toBeNull();
    // Hanging present, live missing → no yield (division would be Infinity).
    const hangOnly = summarizeCarcassYield({hangingTotal: 555});
    expect(hangOnly.totalLive).toBeNull();
    expect(hangOnly.totalHang).toBe(555);
    expect(hangOnly.yieldPct).toBeNull();
    // Zero hanging weight is not carcass data.
    expect(summarizeCarcassYield({liveValues: [400], hangingTotal: 0}).yieldPct).toBeNull();
  });

  it('a direct hangingTotal takes precedence over per-row hanging values', () => {
    const s = summarizeCarcassYield({liveValues: [1000], hangingValues: [111], hangingTotal: 600});
    expect(s.totalHang).toBe(600);
    expect(s.yieldPct).toBe(60);
  });
});
