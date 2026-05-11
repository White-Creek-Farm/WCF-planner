import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');

describe('HomeDashboard NEXT 30 DAYS planner icons', () => {
  const weekEventsBlock = homeSrc.match(/\/\/ What's happening in the next 30 days[\s\S]*?weekEvents\.sort/);

  it('builds next-30-day events with planner icon keys, not emoji icon fields', () => {
    expect(weekEventsBlock, 'expected the next-30-day event builder block').not.toBeNull();
    expect(weekEventsBlock[0]).not.toMatch(/\bicon:\s*['"]/);

    for (const type of ['brooder-in', 'schooner-in', 'processing']) {
      expect(weekEventsBlock[0]).toMatch(
        new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*ANIMAL_ICON_KEYS\\.broiler`),
      );
    }

    for (const type of ['wt-4wk', 'wt-6wk']) {
      expect(weekEventsBlock[0]).toMatch(
        new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*PLANNER_ICON_KEYS\\.weighins`),
      );
    }

    for (const type of ['farrow-open', 'farrow-close', 'farrow-due', 'pig-age']) {
      expect(weekEventsBlock[0]).toMatch(new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*ANIMAL_ICON_KEYS\\.pig`));
    }
  });

  it('renders the next-30-day list with PlannerIcon', () => {
    expect(homeSrc).toMatch(
      /weekEvents\.map\(\(e,\s*i\)\s*=>[\s\S]*?<PlannerIcon\s+iconKey=\{e\.iconKey\}\s+size=\{18\}\s*\/>/,
    );
    expect(homeSrc).not.toMatch(/<span style=\{\{fontSize:\s*18\}\}>\{e\.icon\}<\/span>/);
  });
});
