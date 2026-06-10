import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Weigh-in and equipment fueling submitter identity is locked', () => {
  const publicForms = ['src/webforms/WeighInsWebform.jsx', 'src/webforms/EquipmentFuelingWebform.jsx'];

  for (const rel of publicForms) {
    it(`${rel} stamps the signed-in user without roster dropdowns`, () => {
      const src = read(rel);
      expect(src).toContain("import LockedSubmitter from './LockedSubmitter.jsx'");
      expect(src).toContain('const lockedName = sessionSubmitter?.name ||');
      expect(src).toContain('setTeamMember(lockedName)');
      expect(src).not.toContain('loadRoster');
      expect(src).not.toContain('loadAvailability');
      expect(src).not.toContain('availableNamesFor');
      expect(src).not.toContain("localStorage.setItem('wcf_team'");
      expect(src).not.toContain("localStorage.getItem('wcf_team'");
      expect(src).not.toMatch(/<select[^>]*value=\{teamMember\}/);
    });
  }

  const newWeighInModals = [
    'src/shared/AdminNewWeighInModal.jsx',
    'src/cattle/CattleNewWeighInModal.jsx',
    'src/sheep/SheepNewWeighInModal.jsx',
  ];

  for (const rel of newWeighInModals) {
    it(`${rel} uses the locked record-page field for Team`, () => {
      const src = read(rel);
      expect(src).toContain('LockedTeamMemberField');
      expect(src).toContain('authState');
      expect(src).toContain('setTeam(lockedTeamName)');
      expect(src).not.toContain('loadRoster');
      expect(src).not.toContain('activeNames');
      expect(src).not.toContain("localStorage.setItem('wcf_team'");
      expect(src).not.toMatch(/<select[^>]*value=\{team\}/);
    });
  }

  it('broiler weigh-in session metadata displays saved Team as locked, not editable', () => {
    const src = read('src/livestock/WeighInSessionPage.jsx');
    expect(src).toContain('LockedTeamMemberField');
    expect(src).not.toContain('loadRoster');
    expect(src).not.toContain('activeRoster');
    expect(src).not.toContain('metaTeam');
    expect(src).not.toContain('data-testid="broiler-meta-team"');
  });

  it('equipment fueling history displays saved Team as locked, not editable', () => {
    const src = read('src/equipment/EquipmentDetail.jsx');
    expect(src).toContain('LockedTeamMemberField');
    expect(src).toContain("value: f.team_member || ''");
    expect(src).not.toContain("queueFuelingSave(f.id, 'team_member'");
    expect(src).not.toContain('eq.team_members');
  });

  it('public equipment fueling fetch no longer requests per-equipment team_members', () => {
    const src = read('src/webforms/FuelingHub.jsx');
    expect(src).toContain('attachment_checklists');
    expect(src).not.toContain('team_members');
  });

  it('per-equipment roster assignment UI is not rendered from the equipment admin modal', () => {
    const code = stripComments(read('src/admin/EquipmentWebformsAdmin.jsx'));
    expect(code).not.toContain('TeamMembersEditor');
    expect(code).not.toContain('<TeamMembersEditor');
    expect(code).not.toContain('loadRoster');
    expect(code).not.toContain('activeNames');
  });
});
