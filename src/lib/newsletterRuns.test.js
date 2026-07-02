import {describe, expect, it} from 'vitest';
import {
  describeNewsletterRun,
  describeNewsletterRunProvider,
  isRunError,
  formatRunTimestamp,
} from './newsletterRuns.js';

describe('newsletterRuns.describeNewsletterRunProvider', () => {
  it('names the AI provider vs the template fallback', () => {
    expect(describeNewsletterRunProvider('anthropic')).toBe('AI · Anthropic');
    expect(describeNewsletterRunProvider('template')).toBe('Template');
    expect(describeNewsletterRunProvider(null)).toBe('');
    expect(describeNewsletterRunProvider(undefined)).toBe('');
  });
});

describe('newsletterRuns.describeNewsletterRun', () => {
  it('labels a planner harvest as a no-AI fact scan', () => {
    expect(describeNewsletterRun({runType: 'harvest'})).toEqual({
      label: 'Gathered facts',
      detail: 'planner scan · no AI',
    });
  });

  it('labels a draft run with its provider (AI vs template)', () => {
    expect(describeNewsletterRun({runType: 'ai_draft', provider: 'anthropic'})).toEqual({
      label: 'Wrote draft',
      detail: 'AI · Anthropic',
    });
    expect(describeNewsletterRun({runType: 'ai_draft', provider: 'template'})).toEqual({
      label: 'Wrote draft',
      detail: 'Template',
    });
  });

  it('labels reminder-task and publish runs', () => {
    expect(describeNewsletterRun({runType: 'task_create'}).label).toBe('Reminder task');
    expect(describeNewsletterRun({runType: 'publish'}).label).toBe('Published');
  });

  it('falls back to a safe label for unknown / missing types', () => {
    expect(describeNewsletterRun({runType: 'weird'}).label).toBe('weird');
    expect(describeNewsletterRun({}).label).toBe('Run');
    expect(describeNewsletterRun(null).label).toBe('Run');
  });
});

describe('newsletterRuns.isRunError', () => {
  it('is true only for an error status', () => {
    expect(isRunError({status: 'error'})).toBe(true);
    expect(isRunError({status: 'ok'})).toBe(false);
    expect(isRunError(null)).toBe(false);
  });
});

describe('newsletterRuns.formatRunTimestamp', () => {
  it('returns "" for missing / invalid dates', () => {
    expect(formatRunTimestamp(null)).toBe('');
    expect(formatRunTimestamp('')).toBe('');
    expect(formatRunTimestamp('not-a-date')).toBe('');
  });

  it('returns a non-empty label for a valid ISO date', () => {
    expect(formatRunTimestamp('2026-07-01T14:05:00.000Z').length).toBeGreaterThan(0);
  });
});
