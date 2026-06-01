import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Daily-report hotfix (parts 3+4 + scope generalization): the six daily record
// pages must share one generic record-page controls helper — a responsive
// label/value grid, consistent control width, a roster-backed Team Member
// dropdown, and mm/dd/yyyy titles — instead of bespoke per-page field-row /
// input / textarea styles. This is the reusable site-wide foundation; other
// record pages migrate onto it in a later visual-consistency lane.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DAILY_PAGES = [
  'src/broiler/PoultryDailyPage.jsx',
  'src/layer/LayerDailyPage.jsx',
  'src/layer/EggDailyPage.jsx',
  'src/pig/PigDailyPage.jsx',
  'src/cattle/CattleDailyPage.jsx',
  'src/sheep/SheepDailyPage.jsx',
];

describe('daily record pages use the shared record-page controls', () => {
  for (const rel of DAILY_PAGES) {
    const src = read(rel);

    it(`${rel} imports the generic recordPageControls helper (not the old daily one)`, () => {
      expect(src).toContain("from '../shared/recordPageControls.jsx'");
      expect(src).not.toContain('dailyRecordControls');
    });

    it(`${rel} uses the responsive field-row class + roster Team Member dropdown`, () => {
      expect(src).toContain('recordFieldRowClass');
      expect(src).toContain('className={fieldRowClass}');
      expect(src).toContain('TeamMemberSelect');
    });

    it(`${rel} does not re-declare bespoke flex field-row / fixed-width input styles`, () => {
      // Old per-page primitives were a flex 'space-between' field row and a
      // width:120 input — both now live in the shared helper.
      expect(src).not.toMatch(/justifyContent:\s*'space-between'/);
      expect(src).not.toMatch(/const inp = \{[\s\S]*?width:\s*120/);
    });

    it(`${rel} renders the title via the mm/dd/yyyy formatter`, () => {
      expect(src).toContain('fmtMDY(record.date)');
    });
  }

  it('the shared helper documents its intended future record-page consumers', () => {
    const src = read('src/shared/recordPageControls.jsx');
    expect(src).toMatch(/FUTURE CONSUMERS/);
    for (const consumer of ['task', 'weigh-in', 'equipment']) {
      expect(src.toLowerCase()).toContain(consumer);
    }
  });
});
