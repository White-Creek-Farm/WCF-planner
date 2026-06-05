import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Lane 1 CP1 — authenticated Light-user portal static guards
// ----------------------------------------------------------------------------
// Locks the load-bearing pieces of the Light role: the DB constraint, role
// plumbing, fail-closed route containment, login-required form surfaces, the
// injected/locked submitter, and the portal home + nav containment. These are
// source-level guards; the RLS/ownership enforcement is a later checkpoint and
// is intentionally NOT claimed here (see PROJECT.md Lane 1 detail).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Light role — DB constraint (migration 087)', () => {
  const mig = read('supabase-migrations/087_profiles_role_light.sql');

  it('recreates profiles_role_check including light as a superset of prior roles', () => {
    expect(mig).toMatch(/profiles_role_check/);
    for (const role of ['farm_team', 'management', 'admin', 'inactive', 'equipment_tech', 'light']) {
      expect(mig, `role ${role} in CHECK`).toContain(`'${role}'`);
    }
    expect(mig).toMatch(/ALTER TABLE profiles\s+ADD CONSTRAINT profiles_role_check/);
  });
});

describe('Light role — plumbing', () => {
  const main = read('src/main.jsx');
  const users = read('src/auth/UsersModal.jsx');
  const rapid = read('supabase-functions/rapid-processor.ts');

  it('DEV role override whitelist includes light', () => {
    expect(main).toMatch(/\['admin', 'management', 'farm_team', 'inactive', 'light'\]\.includes\(override\)/);
  });

  it('UsersModal can assign the light role', () => {
    expect(users).toMatch(/\{v: 'light', l: 'Light'\}/);
  });

  it('rapid-processor welcome email labels the light role', () => {
    expect(rapid).toMatch(/light:\s*'[^']*Light[^']*'/);
  });
});

describe('Light role — fail-closed route containment (main.jsx)', () => {
  const main = read('src/main.jsx');

  it('defines a Light allowed-view allowlist with the agreed surfaces', () => {
    const allowIdx = main.indexOf('LIGHT_ALLOWED_VIEWS');
    expect(allowIdx, 'LIGHT_ALLOWED_VIEWS defined').toBeGreaterThan(-1);
    // Capture the Set literal that follows.
    const slice = main.slice(allowIdx, allowIdx + 600);
    for (const v of ['home', 'webformhub', 'tasksWebform', 'addfeed', 'webform', 'fuelingHub', 'fuelSupply', 'tasks']) {
      expect(slice, `allowlist contains ${v}`).toContain(`'${v}'`);
    }
    // Forbidden surfaces must NOT be in the allowlist literal. 'weighins' is
    // deliberately excluded — Light users do not submit weigh-ins.
    for (const v of [
      'weighins',
      'activity',
      'clientErrors',
      'webforms',
      'equipmentHome',
      'broilerHome',
      'cattleHome',
    ]) {
      expect(slice, `allowlist excludes ${v}`).not.toContain(`'${v}'`);
    }
  });

  it('hides the Weigh-Ins tile on the /dailys hub for Light', () => {
    // main.jsx passes hideWeighIns: isLight into WebformHub; the hub gates the
    // Weigh-Ins tile behind that flag so Light users never see a dead link.
    expect(main).toMatch(/hideWeighIns:\s*isLight/);
    const hub = read('src/webforms/WebformHub.jsx');
    expect(hub).toMatch(/hideWeighIns/);
    expect(hub).toMatch(/\{!hideWeighIns &&/);
  });

  it('canAccessProgram denies every program to light', () => {
    expect(main).toMatch(/if \(authState\.role === 'light'\) return false;/);
  });

  it('redirect effect snaps a light user off any non-allowed view', () => {
    expect(main).toMatch(/if \(isLight && view && !canLightAccessView\(view\)\) setView\('home'\)/);
  });

  it('render guard fails closed to the Light portal for non-allowed views', () => {
    expect(main).toMatch(/if \(isLight && !canLightAccessView\(view\)\) return React\.createElement\(LightHomePortal/);
  });

  it('home renders the Light portal for light, HomeDashboard otherwise', () => {
    expect(main).toMatch(/if \(isLight\) return React\.createElement\(LightHomePortal/);
  });
});

describe('Light role — login-required form surfaces inject a locked submitter', () => {
  const main = read('src/main.jsx');

  it('builds sessionSubmitter from the signed-in identity', () => {
    expect(main).toMatch(/const sessionSubmitter = \{/);
    expect(main).toMatch(/name: authState\.name \|\| authState\.user\?\.email/);
  });

  it('threads sessionSubmitter into every form surface', () => {
    const idx = main.indexOf('REPORT/FORM SURFACES (login required)');
    expect(idx).toBeGreaterThan(-1);
    const slice = main.slice(idx, idx + 1400);
    for (const comp of [
      'PigDailysWebform',
      'AddFeedWebform',
      'WeighInsWebform',
      'TasksWebform',
      'WebformHub',
      'FuelingHub',
      'FuelSupplyWebform',
    ]) {
      expect(slice, `${comp} gets sessionSubmitter`).toContain(comp);
    }
    expect(slice).toMatch(/sessionSubmitter/);
  });
});

describe('Light role — locked submitter component + form wiring', () => {
  it('LockedSubmitter is presentational only (no auth/supabase coupling)', () => {
    const ls = read('src/webforms/LockedSubmitter.jsx');
    expect(ls).not.toMatch(/useAuth\s*\(|AuthContext/);
    expect(ls).not.toMatch(/@supabase\/supabase-js|\bcreateClient\s*\(|from '\.\.\/lib\/supabase/);
  });

  // The forms whose submitter is locked to the signed-in user on the
  // authenticated path. TasksWebform is intentionally excluded — its
  // submit_task_instance RPC validates submitted_by against the tasks-public
  // roster, so locking it to a session name is deferred to an RPC-contract
  // change (tracked as CP1 residual risk).
  const LOCKED_FORMS = [
    'src/webforms/WebformHub.jsx',
    'src/webforms/AddFeedWebform.jsx',
    'src/webforms/WeighInsWebform.jsx',
    'src/webforms/PigDailysWebform.jsx',
    'src/webforms/EquipmentFuelingWebform.jsx',
    'src/webforms/FuelSupplyWebform.jsx',
  ];
  for (const rel of LOCKED_FORMS) {
    it(`${rel} locks the submitter to the signed-in user`, () => {
      const src = read(rel);
      expect(src, 'imports LockedSubmitter').toMatch(/import LockedSubmitter from '\.\/LockedSubmitter\.jsx'/);
      expect(src, 'derives submitterLocked from sessionSubmitter').toMatch(/sessionSubmitter\?\.name/);
      expect(src, 'renders the locked field').toMatch(
        /submitterLocked \?\s*[\s\S]{0,40}LockedSubmitter|<LockedSubmitter/,
      );
    });
  }
});

describe('Light role — header + portal containment', () => {
  const header = read('src/shared/Header.jsx');
  const portal = read('src/dashboard/LightHomePortal.jsx');
  const homeAlerts = read('src/dashboard/homeAlerts.js');

  it('Header defines isLight and hides Activity from light', () => {
    expect(header).toMatch(/const isLight = authState\?\.role === 'light'/);
    expect(header).toMatch(/\{!isLight && \([\s\S]*?data-header-menu-item="activity"/);
  });

  it('Light portal exposes exactly the four allowed shortcuts', () => {
    for (const v of ['webformhub', 'addfeed', 'fuelingHub', 'tasks']) {
      expect(portal, `portal tile ${v}`).toContain(`'${v}'`);
    }
    // No program-dashboard or admin shortcuts on the portal.
    for (const v of ['broilerHome', 'cattleHome', 'equipmentHome', 'activity', 'webforms']) {
      expect(portal, `portal excludes ${v}`).not.toContain(`'${v}'`);
    }
  });

  it('Light portal renders the shared operational home sections', () => {
    for (const helper of ['buildMissedDailyReports', 'buildEquipmentAttention', 'buildNext30Events']) {
      expect(portal, `${helper} imported/used`).toContain(helper);
      expect(homeAlerts, `${helper} defined`).toMatch(new RegExp(`export function ${helper}\\b`));
    }
    expect(portal).toMatch(/data-light-home-missed-dailys="1"/);
    expect(portal).toMatch(/data-light-home-equipment-attention="1"/);
    expect(portal).toMatch(/data-light-home-next-30="1"/);
    expect(portal).toMatch(
      /data-light-portal-grid="1"[\s\S]*?weekEvents\.length > 0[\s\S]*?data-light-home-next-30="1"/,
    );
    expect(portal).not.toMatch(/Nothing scheduled in the next 30 days/);
    expect(portal).toMatch(/NEXT 30 DAYS/);
  });

  it('Light equipment attention rows route to the allowed public equipment surface, not /fleet', () => {
    expect(portal).toMatch(/navigate\('\/equipment\/' \+ a\.slug\)/);
    expect(portal).not.toMatch(/navigate\('\/fleet\//);
  });

  it('Light alert cards are visible but do not expose the full-dashboard global dismiss controls', () => {
    expect(portal).not.toMatch(/Clear all|clearAllMissed|clearMissedEntry/);
    expect(portal).not.toMatch(/from\('app_store'\)\.upsert/);
  });
});
