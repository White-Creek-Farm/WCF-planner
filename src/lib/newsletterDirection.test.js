import {describe, expect, it} from 'vitest';
import {
  DIRECTION_DEBOUNCE_MS,
  canonicalizeIntake,
  intakeEqual,
  isDirectionDirty,
  directionSaveLabel,
} from './newsletterDirection.js';

describe('newsletterDirection.canonicalizeIntake', () => {
  it('drops empty / whitespace-only answers and sorts by key', () => {
    expect(canonicalizeIntake({b: 'two', a: 'one', c: '   ', d: ''})).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ]);
  });

  it('treats non-object input as empty', () => {
    expect(canonicalizeIntake(null)).toEqual([]);
    expect(canonicalizeIntake(undefined)).toEqual([]);
    expect(canonicalizeIntake('nope')).toEqual([]);
  });

  it('coerces non-string values to strings', () => {
    expect(canonicalizeIntake({a: 5, b: true})).toEqual([
      ['a', '5'],
      ['b', 'true'],
    ]);
  });
});

describe('newsletterDirection.intakeEqual', () => {
  it('server {} equals empty textareas (no spurious dirty)', () => {
    expect(intakeEqual({}, {highlights: '', people: '   '})).toBe(true);
  });

  it('is order-independent', () => {
    expect(intakeEqual({a: '1', b: '2'}, {b: '2', a: '1'})).toBe(true);
  });

  it('detects a real content change', () => {
    expect(intakeEqual({a: '1'}, {a: '2'})).toBe(false);
    expect(intakeEqual({}, {a: 'typed'})).toBe(false);
  });
});

describe('newsletterDirection.isDirectionDirty', () => {
  it('is true only when local differs from the last saved intake', () => {
    expect(isDirectionDirty({a: 'x'}, {})).toBe(true);
    expect(isDirectionDirty({a: 'x'}, {a: 'x'})).toBe(false);
    // Typing back to the saved value clears dirty.
    expect(isDirectionDirty({a: 'x', b: ''}, {a: 'x'})).toBe(false);
  });
});

describe('newsletterDirection.directionSaveLabel', () => {
  it('maps each state to a label + tone', () => {
    expect(directionSaveLabel('saving')).toEqual({text: 'Saving…', tone: 'muted'});
    expect(directionSaveLabel('saved')).toEqual({text: 'Saved', tone: 'ok'});
    expect(directionSaveLabel('unsaved')).toEqual({text: 'Unsaved…', tone: 'warn'});
    expect(directionSaveLabel('error')).toEqual({text: 'Save failed — retry', tone: 'danger'});
    expect(directionSaveLabel('idle').tone).toBe('faint');
  });
});

describe('newsletterDirection debounce window', () => {
  it('is within the intended 700–1000ms band', () => {
    expect(DIRECTION_DEBOUNCE_MS).toBeGreaterThanOrEqual(700);
    expect(DIRECTION_DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });
});
