import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Light review hub', () => {
  const portal = read('src/dashboard/LightHomePortal.jsx');
  const hub = read('src/dashboard/MySubmissions.jsx');

  it('renames the Light portal daily/report review entry points', () => {
    expect(portal).toContain('Enter Daily Reports');
    expect(portal).toContain('View Past Reports');
    expect(portal).not.toContain('My Submissions');
    expect(portal).toContain('Daily report logs and equipment');
  });

  it('repurposes the legacy My Submissions route as a past-report link hub', () => {
    expect(hub).toContain('data-view-past-reports="1"');
    expect(hub).toContain('Enter Daily Reports');
    expect(hub).toContain('View Past Reports');
    for (const v of ['broilerdailys', 'layerdailys', 'eggdailys', 'pigdailys', 'cattledailys', 'sheepdailys']) {
      expect(hub, `review hub links ${v}`).toContain(`'${v}'`);
    }
    expect(hub).toContain("'fuelingHub'");
    expect(hub).not.toMatch(/equipment_fuelings|fuel_supplies|update_equipment_fueling|delete_equipment_fueling/);
  });
});

describe('Light daily report edit/delete window', () => {
  const api = read('src/lib/dailyReportsApi.js');
  const mig = read('supabase-migrations/113_light_daily_report_edit_window.sql');

  it('client helper gates Light daily report mutations to 3 days after submitted_at', () => {
    expect(api).toMatch(/LIGHT_DAILY_REPORT_EDIT_WINDOW_MS\s*=\s*3 \* 24 \* 60 \* 60 \* 1000/);
    expect(api).toMatch(/record\?\.submitted_at/);
    expect(api).toMatch(/owner_profile_id === uid && isWithinLightDailyReportEditWindow\(record\)/);
  });

  it('database RPCs enforce the same submitted_at window for Light users', () => {
    expect(mig).toContain("_assert_light_daily_report_mutation_window");
    expect(mig).toContain("p_submitted_at + interval '3 days'");
    expect(mig).toMatch(/t\.owner_profile_id,\s*t\.submitted_at/);
    expect(mig).toMatch(/owner_profile_id,\s*submitted_at/);
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
