import {describe, it, expect} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW, HASH_COMPAT, ALIASES_EXACT, ALIASES_PREFIX} from './routes.js';

// Tests for the URL ↔ view mapping that drives the Phase 3 router adapter.
// Two invariants matter most: (1) round-trip integrity so the URL sync effects
// don't lose information, and (2) the public webform paths /addfeed and
// /weighins stay byte-stable since they're printed on materials in the field
// (§7 don't-touch). The 2026-05-06 rename intentionally moved the daily-
// reports hub from /webforms to /dailys and the equipment/fueling hub from
// /fueling to /equipment; old paths remain working aliases.

describe('VIEW_TO_PATH ↔ PATH_TO_VIEW round-trip', () => {
  it('every view in VIEW_TO_PATH round-trips back to itself via PATH_TO_VIEW', () => {
    for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
      expect(PATH_TO_VIEW[path]).toBe(view);
    }
  });

  it('every path in PATH_TO_VIEW points back to a view in VIEW_TO_PATH', () => {
    for (const [path, view] of Object.entries(PATH_TO_VIEW)) {
      expect(VIEW_TO_PATH[view]).toBe(path);
    }
  });

  it('all paths are unique (no two views collapse to the same path)', () => {
    const paths = Object.values(VIEW_TO_PATH);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('PATH_TO_VIEW has the same number of entries as VIEW_TO_PATH (no info lost)', () => {
    expect(Object.keys(PATH_TO_VIEW).length).toBe(Object.keys(VIEW_TO_PATH).length);
  });
});

describe('HASH_COMPAT', () => {
  it('every hash bookmark maps to a path that exists in PATH_TO_VIEW', () => {
    for (const [, path] of Object.entries(HASH_COMPAT)) {
      expect(PATH_TO_VIEW[path]).toBeDefined();
    }
  });

  it('does not include the supabase recovery hash (SetPasswordScreen parses it directly)', () => {
    const keys = Object.keys(HASH_COMPAT);
    expect(keys.some((k) => k.includes('access_token'))).toBe(false);
    expect(keys.some((k) => k.includes('recovery'))).toBe(false);
  });

  it('#webforms now points at the canonical /dailys (post 2026-05-06 rename)', () => {
    expect(HASH_COMPAT['#webforms']).toBe('/dailys');
  });
});

describe('canonical anchors (paths printed on field materials per §7)', () => {
  it('home is /', () => {
    expect(VIEW_TO_PATH.home).toBe('/');
  });

  it('public daily-reports hub canonical is /dailys (post 2026-05-06 rename)', () => {
    expect(VIEW_TO_PATH.webformhub).toBe('/dailys');
    expect(PATH_TO_VIEW['/dailys']).toBe('webformhub');
  });

  it('public equipment/fueling hub canonical is /equipment (post 2026-05-06 rename)', () => {
    expect(VIEW_TO_PATH.fuelingHub).toBe('/equipment');
    expect(PATH_TO_VIEW['/equipment']).toBe('fuelingHub');
  });

  it('logged-in equipment module canonical is /fleet (post 2026-05-06 rename)', () => {
    expect(VIEW_TO_PATH.equipmentHome).toBe('/fleet');
    expect(PATH_TO_VIEW['/fleet']).toBe('equipmentHome');
  });

  it('/fleet sub-routes (fuel-log, per-piece detail) are owned by EquipmentHome — not registered as separate views', () => {
    // EquipmentHome owns sub-routing under /fleet/* internally; main.jsx
    // routes any /fleet/<sub> path to view='equipmentHome' so the
    // EquipmentHome subView logic can dispatch. Adding /fleet/fuel-log
    // (or any other /fleet/<sub>) to PATH_TO_VIEW would route to a view
    // that's not in main.jsx VALID_VIEWS and snap the user home.
    expect(PATH_TO_VIEW['/fleet/fuel-log']).toBeUndefined();
    expect(VIEW_TO_PATH.equipmentFuelLog).toBeUndefined();
    expect(VIEW_TO_PATH.equipmentFleet).toBeUndefined();
  });

  it('public byte-stable: /addfeed and /weighins (printed on field materials)', () => {
    expect(VIEW_TO_PATH.addfeed).toBe('/addfeed');
    expect(VIEW_TO_PATH.weighins).toBe('/weighins');
  });

  it('admin tasks center mounts at /admin/tasks', () => {
    expect(VIEW_TO_PATH.adminTasks).toBe('/admin/tasks');
    expect(PATH_TO_VIEW['/admin/tasks']).toBe('adminTasks');
  });

  it('public tasks webform mounts at /dailys/tasks (post 2026-05-06 rename)', () => {
    expect(VIEW_TO_PATH.tasksWebform).toBe('/dailys/tasks');
    expect(PATH_TO_VIEW['/dailys/tasks']).toBe('tasksWebform');
  });

  it('logged-in my-tasks mounts at /my-tasks', () => {
    expect(VIEW_TO_PATH.myTasks).toBe('/my-tasks');
    expect(PATH_TO_VIEW['/my-tasks']).toBe('myTasks');
  });
});

describe('aliases (legacy paths preserved as redirects post 2026-05-06 rename)', () => {
  it('exact aliases redirect legacy public paths to canonical', () => {
    expect(ALIASES_EXACT['/webforms']).toBe('/dailys');
    expect(ALIASES_EXACT['/webforms/tasks']).toBe('/dailys/tasks');
    expect(ALIASES_EXACT['/fueling']).toBe('/equipment');
    expect(ALIASES_EXACT['/fueling/supply']).toBe('/equipment/supply');
  });

  it('exact aliases redirect legacy logged-in equipment utility paths to /fleet', () => {
    expect(ALIASES_EXACT['/equipment/fleet']).toBe('/fleet');
    expect(ALIASES_EXACT['/equipment/fuel-log']).toBe('/fleet/fuel-log');
  });

  it('does NOT alias /equipment/<slug> — that path is the new public checklist surface', () => {
    // /equipment is now the public equipment-checklist hub; /equipment/<slug>
    // resolves to that hub's per-piece detail. Old logged-in /equipment/<slug>
    // bookmarks intentionally land on the public checklist for that piece,
    // not on the logged-in /fleet/<slug> detail.
    expect(ALIASES_EXACT['/equipment/jd-317']).toBeUndefined();
    expect(ALIASES_EXACT['/equipment/c362']).toBeUndefined();
  });

  it('every alias target is either a canonical path in VIEW_TO_PATH or a sub-path of /dailys, /equipment, or /fleet', () => {
    const canonicals = new Set(Object.values(VIEW_TO_PATH));
    for (const [, target] of Object.entries(ALIASES_EXACT)) {
      const ok =
        canonicals.has(target) ||
        target.startsWith('/dailys/') ||
        target.startsWith('/equipment/') ||
        target.startsWith('/fleet/');
      expect(ok, `alias target ${target} is not a known canonical or sub-path`).toBe(true);
    }
  });

  it('prefix aliases cover /webforms/<sub> and /fueling/<slug>', () => {
    const map = Object.fromEntries(ALIASES_PREFIX);
    expect(map['/webforms/']).toBe('/dailys/');
    expect(map['/fueling/']).toBe('/equipment/');
  });

  it('prefix aliases preserve the trailing path (e.g. /webforms/sheep → /dailys/sheep)', () => {
    // Simulate what main.jsx does: oldPrefix replaced with newPrefix.
    const apply = (path) => {
      for (const [oldPrefix, newPrefix] of ALIASES_PREFIX) {
        if (path.startsWith(oldPrefix)) {
          return newPrefix + path.slice(oldPrefix.length);
        }
      }
      return null;
    };
    expect(apply('/webforms/sheep')).toBe('/dailys/sheep');
    expect(apply('/webforms/broiler')).toBe('/dailys/broiler');
    expect(apply('/fueling/jd-317')).toBe('/equipment/jd-317');
  });
});
