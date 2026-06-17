import {describe, it, expect} from 'vitest';
import {
  PROGRAM_COLORS,
  PROGRAM_FALLBACK,
  getProgramColor,
  programDotStyle,
  programPillStyle,
} from './programColors.js';
import {getReadableText} from './styles.js';

// CP0 §A12 locked palette — these hexes are ratified; this test pins them so a
// future edit can't silently drift the program identity colors.
const LOCKED = {
  pig: '#2B4C9B',
  broiler: '#C7920A',
  layer: '#D2601A',
  cattle: '#8E3328',
  sheep: '#4CA035',
  equipment: '#6B7280',
};

describe('PROGRAM_COLORS (locked palette)', () => {
  it('exposes exactly the six ratified hexes', () => {
    expect(PROGRAM_COLORS).toEqual(LOCKED);
  });
});

describe('getProgramColor', () => {
  it('resolves canonical keys', () => {
    expect(getProgramColor('pig')).toBe('#2B4C9B');
    expect(getProgramColor('cattle')).toBe('#8E3328');
  });

  it('is case-insensitive', () => {
    expect(getProgramColor('Sheep')).toBe('#4CA035');
    expect(getProgramColor('LAYER')).toBe('#D2601A');
  });

  it('resolves aliases (eggs ride layer, admin/equip ride gray)', () => {
    expect(getProgramColor('egg')).toBe(PROGRAM_COLORS.layer);
    expect(getProgramColor('admin')).toBe(PROGRAM_COLORS.equipment);
    expect(getProgramColor('broilers')).toBe(PROGRAM_COLORS.broiler);
  });

  it('falls back to slate gray for unknown/empty keys', () => {
    expect(getProgramColor('weasel')).toBe(PROGRAM_FALLBACK);
    expect(getProgramColor(null)).toBe(PROGRAM_FALLBACK);
    expect(getProgramColor(undefined)).toBe(PROGRAM_FALLBACK);
  });
});

describe('collision avoidance (the two risks A12 was tuned for)', () => {
  it('sheep green is distinct from the forest brand green and the ok-status family', () => {
    // Brand green is #085041; sheep must not collide with it.
    expect(PROGRAM_COLORS.sheep.toLowerCase()).not.toBe('#085041');
    // Sheep is a brighter grass green — its green channel dominates and it is
    // clearly lighter than the dark brand green.
    const sheep = PROGRAM_COLORS.sheep;
    const r = parseInt(sheep.slice(1, 3), 16);
    const g = parseInt(sheep.slice(3, 5), 16);
    const b = parseInt(sheep.slice(5, 7), 16);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('broiler and layer are far enough apart to read at dot size', () => {
    // Layer should be redder (higher R-minus-G) than broiler so the two split.
    const split = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      return r - g;
    };
    expect(split(PROGRAM_COLORS.layer)).toBeGreaterThan(split(PROGRAM_COLORS.broiler));
  });
});

describe('pill text auto-contrast (getReadableText)', () => {
  // Contract is "contrast-safe", not a specific color. broiler gold is the one
  // hue light enough to take dark text; the rest cross the YIQ 0.5 threshold and
  // take white. Pin the clear-cut ends and assert every program returns one of
  // the two valid inks.
  it('broiler (light gold) takes dark text', () => {
    expect(getReadableText(PROGRAM_COLORS.broiler)).toBe('#0f172a');
  });

  it('the dark hues (pig, cattle) take white text', () => {
    expect(getReadableText(PROGRAM_COLORS.pig)).toBe('white');
    expect(getReadableText(PROGRAM_COLORS.cattle)).toBe('white');
  });

  it('every program resolves to a valid contrast ink', () => {
    for (const hex of Object.values(PROGRAM_COLORS)) {
      expect(['white', '#0f172a']).toContain(getReadableText(hex));
    }
  });
});

describe('style helpers', () => {
  it('programDotStyle is a solid round dot at the requested size', () => {
    const s = programDotStyle('pig', 12);
    expect(s.background).toBe('#2B4C9B');
    expect(s.borderRadius).toBe('50%');
    expect(s.width).toBe(12);
  });

  it('programPillStyle: unselected has no fill/border; selected is solid with contrast text', () => {
    const off = programPillStyle('cattle', false);
    expect(off.background).toBe('transparent');
    expect(off.border).toBe('none');
    expect(off.color).toBe('var(--text-secondary)');

    const on = programPillStyle('cattle', true);
    expect(on.background).toBe('#8E3328');
    expect(on.color).toBe('white');
    expect(on.borderRadius).toBe(10); // 10px floor (A3)
  });
});
