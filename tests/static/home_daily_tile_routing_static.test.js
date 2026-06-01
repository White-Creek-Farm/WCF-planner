import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Daily-report hotfix (part 1): the Admin Home "LAST 5 DAYS — ALL DAILY
// REPORTS" tiles must navigate directly to each report's dedicated record page
// instead of waking the legacy dailys-hub edit modal (setPendingEdit + setView).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');

describe('HomeDashboard Last-5-Days daily tiles route to record pages', () => {
  it('declares the direct daily-report record-page route map', () => {
    expect(homeSrc).toContain('DAILY_RECORD_ROUTES');
    expect(homeSrc).toContain("'/broiler/dailys/'");
    expect(homeSrc).toContain("'/pig/dailys/'");
    expect(homeSrc).toContain("'/layer/dailys/'");
    expect(homeSrc).toContain("'/layer/eggs/'"); // egg dailys live under layer
    expect(homeSrc).toContain("'/cattle/dailys/'");
    expect(homeSrc).toContain("'/sheep/dailys/'");
  });

  it('navigates the tile via pathForDailyReport(r)', () => {
    expect(homeSrc).toContain('pathForDailyReport');
    expect(homeSrc).toMatch(/const path = pathForDailyReport\(r\)/);
    expect(homeSrc).toMatch(/navigate\(path\)/);
  });

  it('no longer calls setPendingEdit for daily report tiles (legacy edit modal)', () => {
    expect(homeSrc).not.toMatch(/setPendingEdit\(/);
  });
});
