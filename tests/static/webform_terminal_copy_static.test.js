import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOGIN_GATED_FORMS = [
  'src/webforms/AddFeedWebform.jsx',
  'src/webforms/EquipmentFuelingWebform.jsx',
  'src/webforms/FuelSupplyWebform.jsx',
  'src/webforms/PigDailysWebform.jsx',
  'src/webforms/TasksWebform.jsx',
  'src/webforms/WebformHub.jsx',
  'src/webforms/WeighInsWebform.jsx',
];

describe('Lane H locked submitter copy', () => {
  it('LockedSubmitter is presentational and uses the standard signed-in caption', () => {
    const src = read('src/webforms/LockedSubmitter.jsx');
    expect(src).toContain("label = 'Team member'");
    expect(src).toContain('data-locked-submitter="1"');
    expect(src).toContain('Signed-in user');
    expect(src).toContain('signed in');
    expect(src).not.toMatch(/import .*useAuth/);
    expect(src).not.toContain('useAuth(');
    expect(src).not.toContain('sb.');
  });

  for (const rel of LOGIN_GATED_FORMS) {
    it(`${rel} does not render the retired title-case Team Member locked-submitter label`, () => {
      const src = read(rel);
      expect(src).not.toContain('label="Team Member"');
      expect(src).not.toContain("getLabel('team_member', 'Team Member')");
    });
  }
});

describe('Lane H terminal submit copy', () => {
  for (const rel of LOGIN_GATED_FORMS) {
    it(`${rel} exposes submit-state markers for synced/queued/stuck outcomes`, () => {
      const src = read(rel);
      expect(src).toContain('data-submit-state');
      expect(src).toContain('Saved on this device');
    });
  }

  it('daily-report webforms distinguish queued and stuck terminal states', () => {
    const hub = read('src/webforms/WebformHub.jsx');
    const pig = read('src/webforms/PigDailysWebform.jsx');
    for (const src of [hub, pig]) {
      expect(src).toContain('data-submit-state="queued"');
      expect(src).toContain('data-submit-state="stuck"');
      expect(src).toContain('sync needs help');
      expect(src).toContain('Open the stuck submissions panel');
    }
  });

  it('RPC queue forms keep queued copy visible before any retry succeeds', () => {
    for (const rel of ['src/webforms/AddFeedWebform.jsx', 'src/webforms/EquipmentFuelingWebform.jsx']) {
      const src = read(rel);
      expect(src).toContain('will sync as soon as the device is back online');
      expect(src).toContain('data-submit-state');
    }
  });
});
