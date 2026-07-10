import {describe, expect, it} from 'vitest';
import {
  normalizeProcessingStatus,
  pigBatchProcessingStatusLabel,
  pigBatchProcessingStatusVariant,
  processingStatusLabel,
} from './processingStatusDisplay.js';

describe('processingStatusDisplay', () => {
  it('maps stored planner values to the uniform display vocabulary', () => {
    expect(processingStatusLabel('planned')).toBe('Planned');
    expect(processingStatusLabel('scheduled')).toBe('Planned');
    expect(processingStatusLabel('active')).toBe('In Process');
    expect(processingStatusLabel('processed')).toBe('Complete');
    expect(processingStatusLabel('complete')).toBe('Complete');
  });

  it('normalizes the real Asana In-Proccess spelling (double-c) to In Process', () => {
    expect(processingStatusLabel('In-Proccess')).toBe('In Process');
    expect(processingStatusLabel('in proccess')).toBe('In Process');
    expect(processingStatusLabel('IN_PROCCESS')).toBe('In Process');
  });

  it('normalizes empty and unknown values conservatively to planned', () => {
    expect(normalizeProcessingStatus(null)).toBe('planned');
    expect(normalizeProcessingStatus('')).toBe('planned');
    expect(normalizeProcessingStatus('not-a-real-status')).toBe('planned');
  });

  it('derives pig active display status from whether pigs are actually in the batch', () => {
    expect(pigBatchProcessingStatusLabel({status: 'active'}, {started: 0, current: 0})).toBe('Planned');
    expect(pigBatchProcessingStatusVariant({status: 'active'}, {started: 0, current: 0})).toBe('warn');
    expect(pigBatchProcessingStatusLabel({status: 'active'}, {started: 24, current: 5})).toBe('In Process');
    expect(pigBatchProcessingStatusLabel({status: 'active'}, {started: 0, current: 5})).toBe('In Process');
    expect(pigBatchProcessingStatusLabel({status: 'processed'}, {started: 24, current: 0})).toBe('Complete');
  });
});
