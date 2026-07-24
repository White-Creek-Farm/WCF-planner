import {describe, it, expect} from 'vitest';
import {RESOURCES} from './broiler.js';
import {FIRST_SCHOONER_INDEX, timelineRowSeparation} from './broilerTimelineRows.js';

// ============================================================================
// Broiler timeline row-separation model — pure contract
// ----------------------------------------------------------------------------
// Locks the two visual-scanning rules for /broiler/timeline:
//   1. Exactly one strong divider, at the brooder -> schooner boundary
//      (before Schooner 1), NOT the old hard-coded `ri === 2` (above Brooder 3).
//   2. Schooner rows alternate plain / shaded fills in resource order; brooder
//      rows are unstriped ('none'). The mapping is derived from RESOURCES, so
//      it "follows resource order" by construction.
// ============================================================================

describe('timeline row separation — brooder/schooner boundary', () => {
  it('FIRST_SCHOONER_INDEX is the first schooner and follows the last brooder', () => {
    expect(RESOURCES[FIRST_SCHOONER_INDEX].type).toBe('schooner');
    expect(FIRST_SCHOONER_INDEX).toBeGreaterThan(0);
    expect(RESOURCES[FIRST_SCHOONER_INDEX - 1].type).toBe('brooder');
    // It is the very first schooner in resource order.
    expect(RESOURCES.findIndex((r) => r.type === 'schooner')).toBe(FIRST_SCHOONER_INDEX);
  });

  it('marks exactly one boundary divider, on the first schooner row', () => {
    const boundaries = RESOURCES.map((_, i) => timelineRowSeparation(i)).filter((r) => r.boundaryTop);
    expect(boundaries).toHaveLength(1);
    expect(timelineRowSeparation(FIRST_SCHOONER_INDEX).boundaryTop).toBe(true);
    // The last brooder does NOT carry the divider (the old ri===2 bug did).
    expect(timelineRowSeparation(FIRST_SCHOONER_INDEX - 1).boundaryTop).toBe(false);
  });
});

describe('timeline row separation — fill bands', () => {
  it('brooder rows are unstriped with no divider', () => {
    RESOURCES.forEach((res, i) => {
      if (res.type !== 'brooder') return;
      expect(timelineRowSeparation(i)).toEqual({boundaryTop: false, fill: 'none'});
    });
  });

  it('schooner rows alternate plain/shaded starting plain, in resource order', () => {
    const schoonerFills = RESOURCES.map((res, i) => ({res, sep: timelineRowSeparation(i)})).filter(
      (x) => x.res.type === 'schooner',
    );
    schoonerFills.forEach((x, order) => {
      expect(x.sep.fill).toBe(order % 2 === 1 ? 'shaded' : 'plain');
    });
    // No schooner is ever 'none'.
    expect(schoonerFills.every((x) => x.sep.fill === 'plain' || x.sep.fill === 'shaded')).toBe(true);
    // Adjacent schooner rows always differ (true alternation).
    for (let k = 1; k < schoonerFills.length; k++) {
      expect(schoonerFills[k].sep.fill).not.toBe(schoonerFills[k - 1].sep.fill);
    }
  });

  it('matches the exact shipped enumeration by resource label', () => {
    const byLabel = Object.fromEntries(RESOURCES.map((res, i) => [res.label, timelineRowSeparation(i).fill]));
    expect(byLabel['Schooner 1']).toBe('plain');
    expect(byLabel['Schooner 2 & 3']).toBe('shaded');
    expect(byLabel['Schooner 4 & 5']).toBe('plain');
    expect(byLabel['Schooner 6 & 6A']).toBe('shaded');
    expect(byLabel['Schooner 7 & 7A']).toBe('plain');
  });

  it('is defensive out of range', () => {
    expect(timelineRowSeparation(-1)).toEqual({boundaryTop: false, fill: 'none'});
    expect(timelineRowSeparation(RESOURCES.length)).toEqual({boundaryTop: false, fill: 'none'});
  });
});
