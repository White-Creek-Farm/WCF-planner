import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DAILY_EDIT_HUBS = [
  'src/broiler/BroilerDailysView.jsx',
  'src/layer/LayerDailysView.jsx',
  'src/layer/EggDailysView.jsx',
  'src/pig/PigDailysView.jsx',
  'src/cattle/CattleDailysView.jsx',
  'src/sheep/SheepDailysView.jsx',
];

describe('daily report submitter fields are locked to record/user identity', () => {
  it('AdminAddReportModal derives team_member from auth, not team roster', () => {
    const src = read('src/shared/AdminAddReportModal.jsx');
    expect(src).toContain('useAuth');
    expect(src).toContain('lockedSubmitterName');
    expect(src).toContain('LockedTeamMemberField');
    expect(src).not.toContain('loadRoster');
    expect(src).not.toContain('activeNames');
    expect(src).not.toContain('getFormTeamMembers');
    expect(src).not.toMatch(/<select[\s\S]{0,120}teamMember/);
  });

  for (const rel of DAILY_EDIT_HUBS) {
    it(`${rel} shows saved submitter as locked display, not a roster dropdown`, () => {
      const src = read(rel);
      expect(src).toContain('LockedTeamMemberField');
      expect(src).not.toContain('loadRoster');
      expect(src).not.toContain('activeNames');
      expect(src).not.toContain('teamMembers.map');
      expect(src).not.toMatch(/<select[^>]*value=\{form\.teamMember\}/);
      expect(src).not.toMatch(/onChange=\{\(e\) => setForm\([^)]*teamMember/s);
    });
  }
});
