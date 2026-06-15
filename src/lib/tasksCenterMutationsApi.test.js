import {describe, expect, it} from 'vitest';
import {assertTaskPhotoLimit, MAX_TASK_PHOTOS_PER_TASK, remainingTaskPhotoSlots} from './tasksCenterMutationsApi.js';

describe('task photo total limit helpers', () => {
  it('uses a 5-photo total cap for each task', () => {
    expect(MAX_TASK_PHOTOS_PER_TASK).toBe(5);
    expect(remainingTaskPhotoSlots(0)).toBe(5);
    expect(remainingTaskPhotoSlots(3)).toBe(2);
    expect(remainingTaskPhotoSlots(5)).toBe(0);
    expect(remainingTaskPhotoSlots(8)).toBe(0);
  });

  it('rejects new photos that would exceed the total task cap', () => {
    expect(() => assertTaskPhotoLimit(4, 1, 'completion')).not.toThrow();
    expect(() => assertTaskPhotoLimit(4, 2, 'completion')).toThrow(/completion: max 5 photos per task/);
  });
});
