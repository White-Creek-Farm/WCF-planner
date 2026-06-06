import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Equipment Fueling History - locked Team field
// ============================================================================
// /equipment/<slug> Fueling & Checklist History -> Edit Entry: the Team field
// displays the saved submitter through the shared locked-user primitive. It is
// not editable, not roster-backed, and not tied to per-equipment operators.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('Equipment fueling history locked Team field shape', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/equipment/EquipmentDetail.jsx'), 'utf8');

  const teamBlockMatch = src.match(/Team<\/div>[\s\S]{0,2200}?<\/div>\s*\n\s*<div>\s*<div[^>]*>Gallons/);
  if (!teamBlockMatch) {
    throw new Error(
      'Could not locate the Team-field block between the "Team" label and the "Gallons" label in EquipmentDetail.jsx. ' +
        'If the surrounding markup changed, update this test to scope to the new block.',
    );
  }
  const teamBlock = teamBlockMatch[0];

  it('uses the shared locked Team field, not an editable field', () => {
    expect(teamBlock).toContain('LockedTeamMemberField');
    expect(teamBlock).not.toMatch(/<select\b/);
    expect(teamBlock).not.toMatch(/<input\s+type="text"/);
  });

  it('displays the saved submitter from the fueling row', () => {
    expect(teamBlock).toContain("value: f.team_member || ''");
  });

  it('does not read per-equipment operator assignments', () => {
    expect(teamBlock).not.toMatch(/eq\.team_members/);
    expect(teamBlock).not.toMatch(/legacy/i);
    expect(teamBlock).not.toMatch(/No team members assigned/i);
  });

  it('does not save Team changes from the record page', () => {
    expect(teamBlock).not.toMatch(/queueFuelingSave\([^)]*'team_member'/);
    expect(src).not.toContain("queueFuelingSave(f.id, 'team_member'");
  });
});
