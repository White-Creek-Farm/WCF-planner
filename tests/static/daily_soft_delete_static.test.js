import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ENTITY_TYPES, ACTIVITY_REGISTRY} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig067 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/067_daily_soft_delete.sql'), 'utf8');
const mig070 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/070_daily_delete_all_active_roles.sql'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/dailyReportsApi.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/admin/RecentlyDeletedDailyReports.jsx'), 'utf8');
const wfAdminSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformsAdminView.jsx'), 'utf8');
const dupCheckSrc = fs.readFileSync(path.join(ROOT, 'src/lib/dailyDuplicateCheck.js'), 'utf8');

const DAILY_TABLES = ['poultry_dailys', 'layer_dailys', 'egg_dailys', 'pig_dailys', 'cattle_dailys', 'sheep_dailys'];
const DAILY_ENTITY_TYPES = ['poultry.daily', 'layer.daily', 'egg.daily', 'pig.daily', 'cattle.daily', 'sheep.daily'];
const DAILY_PROGRAMS = {
  'poultry.daily': 'broiler',
  'layer.daily': 'layer',
  'egg.daily': 'layer',
  'pig.daily': 'pig',
  'cattle.daily': 'cattle',
  'sheep.daily': 'sheep',
};

// ── Migration 067 ───────────────────────────────────────────────────────

describe('mig 067 — schema: deleted_at + deleted_by columns', () => {
  for (const t of DAILY_TABLES) {
    it(`${t} gets deleted_at column`, () => {
      expect(mig067).toContain(`ALTER TABLE public.${t}`);
      expect(mig067).toMatch(new RegExp(`${t}[\\s\\S]*?deleted_at\\s+timestamptz`));
    });
  }
  for (const t of DAILY_TABLES) {
    it(`${t} gets active partial index`, () => {
      expect(mig067).toMatch(new RegExp(`${t}_active_idx`));
    });
  }
});

describe('mig 067 — _activity_can_read daily resolver branches', () => {
  for (const et of DAILY_ENTITY_TYPES) {
    it(`has resolver branch for ${et}`, () => {
      expect(mig067).toContain(`'${et}'`);
    });
  }
  it('does NOT filter deleted_at inside _activity_can_read', () => {
    const canReadBody = mig067.match(/\$can_read\$([\s\S]*?)\$can_read\$/);
    expect(canReadBody).not.toBeNull();
    expect(canReadBody[1]).not.toContain('deleted_at IS NULL');
  });
  it('preserves all 10 existing entity type branches', () => {
    for (const et of [
      'task.instance',
      'task.template',
      'task.system_rule',
      'broiler.batch',
      'pig.batch',
      'layer.batch',
      'layer.housing',
      'cattle.animal',
      'cattle.processing',
      'sheep.animal',
      'sheep.processing',
      'equipment.item',
    ]) {
      expect(mig067, `missing existing branch for ${et}`).toContain(`'${et}'`);
    }
  });
  it('enforces program_access on daily branches', () => {
    for (const [et, program] of Object.entries(DAILY_PROGRAMS)) {
      expect(mig067).toContain(`'${program}' = ANY(v_access)`);
    }
  });
});

describe('mig 070 — soft_delete_daily_report RPC (active-authenticated)', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig070).toMatch(/CREATE OR REPLACE FUNCTION public\.soft_delete_daily_report[\s\S]*?SECURITY DEFINER/);
  });
  it('requires authenticated caller', () => {
    expect(mig070).toMatch(/soft_delete_daily_report: authenticated caller required/);
  });
  it('rejects null or inactive role', () => {
    expect(mig070).toMatch(/v_role IS NULL OR v_role = 'inactive'/);
    expect(mig070).toMatch(/caller role % cannot delete/);
  });
  it('does NOT enforce admin-only', () => {
    expect(mig070).not.toMatch(/soft_delete_daily_report: admin role required/);
  });
  it('validates entity_type against allowlist', () => {
    for (const et of DAILY_ENTITY_TYPES) {
      expect(mig070).toContain(`WHEN '${et}'`);
    }
  });
  it('checks record exists and is not already deleted', () => {
    expect(mig070).toMatch(/deleted_at IS NULL/);
    expect(mig070).toMatch(/record not found or already deleted/);
  });
  it('sets deleted_at + deleted_by in the same transaction as the activity event', () => {
    expect(mig070).toContain('SET deleted_at = now(), deleted_by = $1');
    expect(mig070).toContain("'record.deleted'");
    expect(mig070).toMatch(/INSERT INTO public\.activity_events/);
  });
  it('REVOKE from anon + GRANT to authenticated', () => {
    expect(mig070).toMatch(/REVOKE ALL ON FUNCTION public\.soft_delete_daily_report\([^)]*\) FROM PUBLIC, anon/);
    expect(mig070).toMatch(/GRANT EXECUTE ON FUNCTION public\.soft_delete_daily_report\([^)]*\) TO authenticated/);
  });
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig070).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('mig 067 — restore_daily_report RPC', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig067).toMatch(/CREATE OR REPLACE FUNCTION public\.restore_daily_report[\s\S]*?SECURITY DEFINER/);
  });
  it('is admin-only', () => {
    expect(mig067).toMatch(/restore_daily_report: admin role required/);
  });
  it('checks record exists and IS deleted', () => {
    expect(mig067).toMatch(/deleted_at IS NOT NULL/);
    expect(mig067).toMatch(/record not found or not deleted/);
  });
  it('clears deleted_at + deleted_by and inserts record.restored event', () => {
    expect(mig067).toContain('SET deleted_at = NULL, deleted_by = NULL');
    expect(mig067).toContain("'record.restored'");
  });
  it('REVOKE from anon + GRANT to authenticated', () => {
    expect(mig067).toMatch(/REVOKE ALL ON FUNCTION public\.restore_daily_report\([^)]*\) FROM PUBLIC, anon/);
    expect(mig067).toMatch(/GRANT EXECUTE ON FUNCTION public\.restore_daily_report\([^)]*\) TO authenticated/);
  });
});

describe('mig 067 — NOTIFY', () => {
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig067).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

// ── Activity Registry ───────────────────────────────────────────────────

describe('activityRegistry — daily entity types', () => {
  for (const et of DAILY_ENTITY_TYPES) {
    it(`exports ${et} in ENTITY_TYPES`, () => {
      expect(Object.values(ENTITY_TYPES)).toContain(et);
    });
    it(`has registry entry for ${et}`, () => {
      expect(ACTIVITY_REGISTRY[et]).toBeTruthy();
      expect(typeof ACTIVITY_REGISTRY[et].route).toBe('function');
      expect(typeof ACTIVITY_REGISTRY[et].displayLabel).toBe('function');
      expect(ACTIVITY_REGISTRY[et].program).toBeTruthy();
    });
  }
  it('poultry.daily has program broiler', () => {
    expect(ACTIVITY_REGISTRY['poultry.daily'].program).toBe('broiler');
  });
  it('egg.daily has program layer', () => {
    expect(ACTIVITY_REGISTRY['egg.daily'].program).toBe('layer');
  });
});

// ── Client API ──────────────────────────────────────────────────────────

describe('dailyReportsApi — RPC wrappers', () => {
  it('exports softDeleteDailyReport', () => {
    expect(apiSrc).toMatch(/export async function softDeleteDailyReport/);
  });
  it('exports restoreDailyReport', () => {
    expect(apiSrc).toMatch(/export async function restoreDailyReport/);
  });
  it('calls soft_delete_daily_report RPC', () => {
    expect(apiSrc).toContain("'soft_delete_daily_report'");
  });
  it('calls restore_daily_report RPC', () => {
    expect(apiSrc).toContain("'restore_daily_report'");
  });
  it('does not directly query daily tables', () => {
    const code = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const t of DAILY_TABLES) {
      expect(code).not.toContain(`.from('${t}')`);
    }
  });
});

// ── Admin view ──────────────────────────────────────────────────────────

describe('RecentlyDeletedDailyReports — admin view', () => {
  it('queries deleted rows (deleted_at IS NOT NULL)', () => {
    expect(adminSrc).toContain("'deleted_at', 'is', null");
  });
  it('calls restoreDailyReport on restore', () => {
    expect(adminSrc).toContain('restoreDailyReport');
  });
  it('keeps daily reports in the combined recently-deleted recovery config', () => {
    for (const et of DAILY_ENTITY_TYPES) {
      expect(adminSrc).toContain(`'${et}'`);
    }
    expect(adminSrc).toContain("recordKind: 'daily'");
    expect(adminSrc).toContain('const RECOVERY_CONFIG = {...TABLE_CONFIG, ...ANIMAL_CONFIG};');
  });
  it('is a fail-closed combined records recovery surface', () => {
    expect(adminSrc).toContain('Recently Deleted Records');
    expect(adminSrc).toContain('Could not load recently deleted records. Please retry.');
    expect(adminSrc).toContain('No deleted records.');
    expect(adminSrc).toContain("data-recently-deleted-dailys-loaded={loading || loadError ? 'false' : 'true'}");
    expect(adminSrc).toContain('data-recently-deleted-dailys-retry="1"');
  });
  it('is wired into WebformsAdminView as Deleted tab', () => {
    expect(wfAdminSrc).toContain('RecentlyDeletedDailyReports');
    expect(wfAdminSrc).toContain("id: 'deleted'");
  });
});

// ── Active-record filter audit ──────────────────────────────────────────
// Every normal daily-table SELECT query must have .is('deleted_at', null).
// This test reads each file that queries daily tables and asserts the filter
// is present. It intentionally SKIPS:
//   - insert calls (creates, not reads)
//   - RecentlyDeletedDailyReports (queries deleted rows by design)
//   - the migration file itself
//   - restore/delete RPC wrapper calls (not table reads)

describe('Active-record filter audit', () => {
  const QUERY_FILES = [
    'src/main.jsx',
    'src/broiler/BroilerDailysView.jsx',
    'src/layer/LayerDailysView.jsx',
    'src/layer/EggDailysView.jsx',
    'src/pig/PigDailysView.jsx',
    'src/cattle/CattleDailysView.jsx',
    'src/sheep/SheepDailysView.jsx',
    'src/admin/FeedCostByMonthPanel.jsx',
    'src/layer/LayerBatchesView.jsx',
    'src/cattle/CattleHomeView.jsx',
    'src/sheep/SheepHomeView.jsx',
    'src/layer/LayersView.jsx',
  ];

  for (const relPath of QUERY_FILES) {
    it(`${relPath} has deleted_at filter on daily table reads`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
      for (const t of DAILY_TABLES) {
        const fromPattern = new RegExp(`\\.from\\(['"]${t}['"]\\)`, 'g');
        let match;
        while ((match = fromPattern.exec(code)) !== null) {
          const after = code.slice(match.index, match.index + 300);
          if (after.includes('.insert(') || after.includes('.upsert(')) continue;
          if (after.includes('.delete()')) continue;
          if (after.includes('.update(')) continue;
          expect(after, `${relPath}: .from('${t}') missing deleted_at filter`).toContain(".is('deleted_at', null)");
        }
      }
    });
  }

  it('dailyDuplicateCheck.js filters deleted records from duplicate checks', () => {
    expect(dupCheckSrc).toContain(".is('deleted_at', null)");
  });
});

// ── canDeleteDailyReport helper ─────────────────────────────────────────

describe('canDeleteDailyReport helper', () => {
  it('is exported from dailyReportsApi', () => {
    expect(apiSrc).toMatch(/export function canDeleteDailyReport/);
  });
  it('rejects inactive role', () => {
    expect(apiSrc).toContain("role === 'inactive'"); // CP2: early-return false for inactive
  });
  it('does not gate on admin', () => {
    const helperBody = apiSrc.match(/export function canDeleteDailyReport[\s\S]*?^}/m);
    expect(helperBody).not.toBeNull();
    expect(helperBody[0]).not.toContain("=== 'admin'");
  });
});

// ── UI delete guard — all 6 views use canDeleteDailyReport ─────────────

describe('Daily view delete buttons use canDeleteDailyReport, not admin-only', () => {
  const VIEW_FILES = [
    'src/broiler/BroilerDailysView.jsx',
    'src/layer/LayerDailysView.jsx',
    'src/layer/EggDailysView.jsx',
    'src/pig/PigDailysView.jsx',
    'src/cattle/CattleDailysView.jsx',
    'src/sheep/SheepDailysView.jsx',
  ];

  for (const relPath of VIEW_FILES) {
    it(`${relPath} imports canDeleteDailyReport`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      expect(src).toContain('canDeleteDailyReport');
    });
    it(`${relPath} uses the record-aware canDeleteDailyReport for the delete guard (CP2)`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      // CP2: Light deletes only its own rows, so the edited record must be
      // passed to canDeleteDailyReport (no-record => Light always false).
      // Whitespace-tolerant: prettier may wrap the call across lines.
      expect(src).toMatch(/canDeleteDailyReport\(\s*authState\s*,\s*records\.find\(\(r\) => r\.id === editId\)/);
      expect(src).not.toMatch(/canDeleteDailyReport\(authState\)/);
    });
    it(`${relPath} does not gate delete on admin-only`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      expect(src).not.toMatch(/authState\?\.role === 'admin'[\s\S]*?Delete/);
    });
  }
});

// ── No hard deletes remain ──────────────────────────────────────────────

describe('No hard deletes on daily tables in view code', () => {
  const VIEW_FILES = [
    'src/broiler/BroilerDailysView.jsx',
    'src/layer/LayerDailysView.jsx',
    'src/layer/EggDailysView.jsx',
    'src/pig/PigDailysView.jsx',
    'src/cattle/CattleDailysView.jsx',
    'src/sheep/SheepDailysView.jsx',
    'src/main.jsx',
  ];

  for (const relPath of VIEW_FILES) {
    it(`${relPath} does not hard-delete daily records`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
      for (const t of DAILY_TABLES) {
        expect(code, `${relPath}: hard .delete() on ${t}`).not.toMatch(
          new RegExp(`\\.from\\(['"]${t}['"]\\)[\\s\\S]*?\\.delete\\(\\)`),
        );
      }
    });
  }
});
