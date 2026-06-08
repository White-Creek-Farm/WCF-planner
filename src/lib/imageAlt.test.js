import {describe, expect, it} from 'vitest';
import {imageAltText} from './imageAlt.js';

describe('imageAltText', () => {
  it('uses a trimmed file name when one is available', () => {
    expect(imageAltText(' receipt.jpg ', {fallback: 'Fueling photo'})).toBe('receipt.jpg');
  });

  it('falls back to the caller context when the file name is empty', () => {
    expect(imageAltText('', {fallback: 'Daily report photo'})).toBe('Daily report photo');
  });

  it('adds a one-based position only for multi-photo sets', () => {
    expect(imageAltText('', {fallback: 'Task photo', index: 1, total: 3})).toBe('Task photo 2 of 3');
    expect(imageAltText('', {fallback: 'Task photo', index: 0, total: 1})).toBe('Task photo');
  });
});
