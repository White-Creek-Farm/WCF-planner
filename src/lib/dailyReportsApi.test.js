import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  LIGHT_DAILY_REPORT_EDIT_WINDOW_MS,
  canDeleteDailyReport,
  canEditOwnRecord,
  isWithinLightDailyReportEditWindow,
} from './dailyReportsApi.js';

const lightAuth = {role: 'light', user: {id: 'user-1'}};
const managerAuth = {role: 'management', user: {id: 'manager-1'}};
const inactiveAuth = {role: 'inactive', user: {id: 'user-1'}};
const NOW = Date.parse('2026-06-12T12:00:00Z');

function record(overrides = {}) {
  return {
    id: 'daily-1',
    owner_profile_id: 'user-1',
    submitted_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('dailyReportsApi Light edit/delete window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a Light user to edit/delete their own daily report inside 3 days of submission', () => {
    const ownRecent = record();
    expect(isWithinLightDailyReportEditWindow(ownRecent, NOW)).toBe(true);
    expect(canEditOwnRecord(lightAuth, ownRecent)).toBe(true);
    expect(canDeleteDailyReport(lightAuth, ownRecent)).toBe(true);
  });

  it('blocks Light edit/delete after 3 days from submitted_at', () => {
    const ownOld = record({
      submitted_at: new Date(NOW - LIGHT_DAILY_REPORT_EDIT_WINDOW_MS - 1000).toISOString(),
    });
    expect(isWithinLightDailyReportEditWindow(ownOld, NOW)).toBe(false);
    expect(canEditOwnRecord(lightAuth, ownOld)).toBe(false);
    expect(canDeleteDailyReport(lightAuth, ownOld)).toBe(false);
  });

  it('blocks Light edit/delete for another user or missing submitted_at', () => {
    expect(canEditOwnRecord(lightAuth, record({owner_profile_id: 'user-2'}))).toBe(false);
    expect(canDeleteDailyReport(lightAuth, record({submitted_at: null}))).toBe(false);
  });

  it('leaves privileged and inactive roles unchanged', () => {
    expect(canEditOwnRecord(managerAuth, record({owner_profile_id: 'user-2', submitted_at: null}))).toBe(true);
    expect(canDeleteDailyReport(managerAuth, record({owner_profile_id: 'user-2', submitted_at: null}))).toBe(true);
    expect(canEditOwnRecord(inactiveAuth, record())).toBe(false);
    expect(canDeleteDailyReport(inactiveAuth, record())).toBe(false);
  });
});
