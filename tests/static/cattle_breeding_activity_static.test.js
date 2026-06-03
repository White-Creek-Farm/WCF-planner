import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const viewSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBreedingView.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const activityViewSrc = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
const mig078 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/078_cattle_breeding_activity_entity.sql'), 'utf8');

describe('Custom editable-table Activity — cattle breeding cycles (Phase B)', () => {
  it('CattleBreedingView imports recordActivityEvent and has a recordBreedingActivity helper', () => {
    expect(viewSrc).toMatch(/import \{recordActivityEvent\} from '\.\.\/lib\/entityMutations\.js'/);
    expect(viewSrc).toContain('async function recordBreedingActivity(');
  });
  it('scopes the audit to the cattle.breeding workflow entity (NOT cattle.animal)', () => {
    expect(viewSrc).toMatch(/recordActivityEvent\(sb, \{[\s\S]*?entityType: 'cattle\.breeding'/);
    expect(viewSrc).toContain("entityId: 'cattle-breeding'");
    const fn = viewSrc.match(/async function recordBreedingActivity\([\s\S]*?\n {2}\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).not.toContain("entityType: 'cattle.animal'");
  });
  it('logs create / edit / delete with the right event types after the table write', () => {
    // saveCycle logs created vs updated; deleteCycle logs deleted.
    expect(viewSrc).toMatch(/recordBreedingActivity\(editId \? 'field\.updated' : 'record\.created'/);
    expect(viewSrc).toMatch(
      /from\('cattle_breeding_cycles'\)\.delete\(\)[\s\S]*?recordBreedingActivity\('record\.deleted'/,
    );
  });
  it('registry + global Activity recognize the cattle.breeding entity', () => {
    expect(registrySrc).toContain("CATTLE_BREEDING: 'cattle.breeding'");
    expect(registrySrc).toMatch(/CATTLE_BREEDING\]: \{[\s\S]*?route: \(\) => '\/cattle\/breeding'/);
    expect(activityViewSrc).toContain("'cattle.breeding': 'Cattle Breeding'");
  });
});

describe('mig 078 — _activity_can_read cattle.breeding branch', () => {
  it('replaces _activity_can_read and adds a cattle.breeding branch gated on cattle program', () => {
    expect(mig078).toMatch(/CREATE OR REPLACE FUNCTION public\._activity_can_read/);
    expect(mig078).toMatch(/IF p_entity_type = 'cattle\.breeding' THEN[\s\S]*?RETURN 'cattle' = ANY\(v_access\)/);
  });
  it('preserves the prior cattle.forecast + weighin.session branches (full-replace)', () => {
    expect(mig078).toContain("IF p_entity_type = 'cattle.forecast' THEN");
    expect(mig078).toContain("IF p_entity_type = 'weighin.session' THEN");
  });
  it('keeps anon revoked + authenticated granted and reloads PostgREST', () => {
    expect(mig078).toMatch(/REVOKE ALL ON FUNCTION public\._activity_can_read\(text, text\) FROM PUBLIC, anon/);
    expect(mig078).toMatch(/GRANT EXECUTE ON FUNCTION public\._activity_can_read\(text, text\) TO authenticated/);
    expect(mig078).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
