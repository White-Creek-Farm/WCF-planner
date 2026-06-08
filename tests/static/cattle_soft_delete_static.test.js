import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig069 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/069_cattle_animal_soft_delete.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleDeleteApi.js'), 'utf8');
const herdsSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleHerdsView.jsx'), 'utf8');
const cowDetailSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CowDetail.jsx'), 'utf8');
const batchSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleProcessingBatch.js'), 'utf8');
const e2eSrc = fs.readFileSync(path.join(ROOT, 'tests/cattle_soft_delete.spec.js'), 'utf8');
const recoveryAdminSrc = fs.readFileSync(path.join(ROOT, 'src/admin/RecentlyDeletedDailyReports.jsx'), 'utf8');

// ── Migration 069 — schema: deleted_at + deleted_by columns ─────────────

describe('mig 069 — schema: deleted_at + deleted_by columns', () => {
  it('adds deleted_at timestamptz column', () => {
    expect(mig069).toMatch(/ALTER TABLE public\.cattle/);
    expect(mig069).toMatch(/deleted_at\s+timestamptz/);
  });
  it('adds deleted_by column', () => {
    expect(mig069).toMatch(/deleted_by\s+uuid/);
  });
});

// ── Migration 069 — tag uniqueness indexes ──────────────────────────────

describe('mig 069 — tag uniqueness indexes', () => {
  it('drops old idx_cattle_tag_unique', () => {
    expect(mig069).toContain('DROP INDEX IF EXISTS idx_cattle_tag_unique');
  });
  it('drops old idx_cattle_tag_active_unique', () => {
    expect(mig069).toContain('DROP INDEX IF EXISTS idx_cattle_tag_active_unique');
  });
  it('recreates idx_cattle_tag_active_unique with deleted_at IS NULL', () => {
    expect(mig069).toMatch(/CREATE UNIQUE INDEX idx_cattle_tag_active_unique[\s\S]*?deleted_at IS NULL/);
  });
  it('preserves active-herd scope (mommas, backgrounders, finishers, bulls)', () => {
    const idxBlock = mig069.match(/CREATE UNIQUE INDEX idx_cattle_tag_active_unique[\s\S]*?;/);
    expect(idxBlock).not.toBeNull();
    for (const herd of ['mommas', 'backgrounders', 'finishers', 'bulls']) {
      expect(idxBlock[0]).toContain(herd);
    }
  });
});

// ── Migration 069 — RLS policies ────────────────────────────────────────

describe('mig 069 — RLS policies', () => {
  const OLD_POLICIES = ['cattle_anon_select', 'cattle_anon_insert', 'cattle_anon_update', 'cattle_auth_all'];
  const NEW_POLICIES = [
    'cattle_anon_select',
    'cattle_anon_insert',
    'cattle_anon_update',
    'cattle_auth_select',
    'cattle_auth_insert',
    'cattle_auth_update',
  ];

  for (const p of OLD_POLICIES) {
    it(`drops old policy ${p}`, () => {
      expect(mig069).toMatch(new RegExp(`DROP POLICY IF EXISTS ${p}\\s+ON public\\.cattle`));
    });
  }

  for (const p of NEW_POLICIES) {
    it(`creates replacement policy ${p}`, () => {
      expect(mig069).toMatch(new RegExp(`CREATE POLICY ${p} ON public\\.cattle`));
    });
  }

  it('anon policies are explicitly scoped TO anon', () => {
    for (const p of ['cattle_anon_select', 'cattle_anon_insert', 'cattle_anon_update']) {
      const policyBlock = mig069.match(new RegExp(`CREATE POLICY ${p}[\\s\\S]*?;`));
      expect(policyBlock, `${p} should exist`).not.toBeNull();
      expect(policyBlock[0]).toMatch(/TO anon/);
    }
  });

  it('does NOT create a DELETE policy', () => {
    expect(mig069).not.toMatch(/FOR DELETE/);
  });
});

// ── Migration 069 — soft_delete_cattle_animal RPC ───────────────────────

describe('mig 069 — soft_delete_cattle_animal RPC', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig069).toMatch(/CREATE OR REPLACE FUNCTION public\.soft_delete_cattle_animal[\s\S]*?SECURITY DEFINER/);
  });
  it('is admin-only', () => {
    expect(mig069).toMatch(/soft_delete_cattle_animal: admin role required/);
  });
  it('checks record exists and is not already deleted', () => {
    expect(mig069).toMatch(/deleted_at IS NULL/);
    expect(mig069).toMatch(/record not found or already deleted/);
  });
  it('inserts record.deleted activity event', () => {
    expect(mig069).toContain("'record.deleted'");
    expect(mig069).toMatch(/INSERT INTO public\.activity_events/);
  });
  it('REVOKE from PUBLIC/anon + GRANT to authenticated', () => {
    expect(mig069).toMatch(/REVOKE ALL ON FUNCTION public\.soft_delete_cattle_animal\([^)]*\) FROM PUBLIC, anon/);
    expect(mig069).toMatch(/GRANT EXECUTE ON FUNCTION public\.soft_delete_cattle_animal\([^)]*\) TO authenticated/);
  });
});

// ── Migration 069 — restore_cattle_animal RPC ───────────────────────────

describe('mig 069 — restore_cattle_animal RPC', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig069).toMatch(/CREATE OR REPLACE FUNCTION public\.restore_cattle_animal[\s\S]*?SECURITY DEFINER/);
  });
  it('is admin-only', () => {
    expect(mig069).toMatch(/restore_cattle_animal: admin role required/);
  });
  it('checks tag conflict before restore', () => {
    expect(mig069).toMatch(/tag.*already in use/);
  });
  it('inserts record.restored activity event', () => {
    expect(mig069).toContain("'record.restored'");
  });
  it('REVOKE from PUBLIC/anon + GRANT to authenticated', () => {
    expect(mig069).toMatch(/REVOKE ALL ON FUNCTION public\.restore_cattle_animal\([^)]*\) FROM PUBLIC, anon/);
    expect(mig069).toMatch(/GRANT EXECUTE ON FUNCTION public\.restore_cattle_animal\([^)]*\) TO authenticated/);
  });
});

// ── Migration 069 — NOTIFY ──────────────────────────────────────────────

describe('mig 069 — NOTIFY', () => {
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig069).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

// ── Active-record filter audit ──────────────────────────────────────────

describe('Active-record filter audit — cattle views', () => {
  const QUERY_FILES = [
    'src/cattle/CattleHerdsView.jsx',
    'src/cattle/CattleHomeView.jsx',
    'src/cattle/CattleForecastView.jsx',
    'src/cattle/CattleBatchesView.jsx',
    'src/cattle/CattleBreedingView.jsx',
    'src/livestock/WeighInSessionPage.jsx',
    'src/webforms/WeighInsWebform.jsx',
    'src/main.jsx',
  ];

  for (const relPath of QUERY_FILES) {
    it(`${relPath} has .is('deleted_at', null) on cattle query`, () => {
      const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
      expect(src).toContain(".is('deleted_at', null)");
    });
  }
});

// ── cattleProcessingBatch exception ─────────────────────────────────────

describe('cattleProcessingBatch — admin processing context exception', () => {
  it('does NOT add deleted_at filter (admin processing context)', () => {
    expect(batchSrc).not.toContain('deleted_at');
  });
});

// ── CowDetail — conditional delete button ───────────────────────────────

describe('CowDetail — conditional delete button', () => {
  it('conditionally renders delete button via onDelete &&', () => {
    expect(cowDetailSrc).toContain('onDelete &&');
  });
});

// ── CattleHerdsView — admin-gated delete + restore ──────────────────────

describe('CattleHerdsView — admin-gated delete + restore', () => {
  it('admin-gates deleteCow via authState?.role === admin', () => {
    expect(herdsSrc).toMatch(/authState\?\.role\s*===\s*'admin'/);
    expect(herdsSrc).toContain('deleteCow');
  });
  it('imports softDeleteCattleAnimal', () => {
    expect(herdsSrc).toContain('softDeleteCattleAnimal');
  });
  it('does not have Recently Deleted UI on herds page', () => {
    expect(herdsSrc).not.toContain('Recently Deleted');
    expect(herdsSrc).not.toContain('restoreCattleAnimal');
  });
});

// ── RecentlyDeletedDailyReports — cattle animal recovery surface ─────────────

describe('RecentlyDeletedDailyReports — cattle animal recovery surface', () => {
  it('queries deleted cattle animals from the admin recovery surface', () => {
    expect(recoveryAdminSrc).toContain("'cattle.animal'");
    expect(recoveryAdminSrc).toContain("table: 'cattle'");
    expect(recoveryAdminSrc).toContain("select: 'id, tag, herd, sex, deleted_at, deleted_by'");
    expect(recoveryAdminSrc).toContain("'deleted_at', 'is', null");
  });

  it('restores cattle animals through restoreCattleAnimal, not from the herd page', () => {
    expect(recoveryAdminSrc).toContain("import {restoreCattleAnimal} from '../lib/cattleDeleteApi.js'");
    expect(recoveryAdminSrc).toContain('restore: restoreCattleAnimal');
    expect(recoveryAdminSrc).toMatch(/recordKind:\s*'animal'/);
    expect(recoveryAdminSrc).toContain('data-recently-deleted-entity={r.entityType}');
    expect(recoveryAdminSrc).toContain('data-recently-deleted-record-kind={r.recordKind}');
    expect(herdsSrc).not.toContain('restoreCattleAnimal');
  });
});

// cattle_soft_delete.spec - current record-page/recovery contract.

describe('cattle_soft_delete.spec - current record-page/recovery contract', () => {
  it('drives delete from the dedicated cattle record page, not inline herd expansion', () => {
    expect(e2eSrc).toContain("'/cattle/herds/' + ids.delCowId");
    expect(e2eSrc).toContain('[data-cattle-animal-page="1"]');
    expect(e2eSrc).not.toContain('await page.locator(\'[data-cow-row-tag="SD-100"]\').click()');
  });

  it('covers restore and restore-conflict through the backend RPC contract', () => {
    expect(e2eSrc).toContain("adminSb.rpc('restore_cattle_animal'");
    expect(e2eSrc).toContain('restore conflict: tag reuse returns backend error');
    expect(e2eSrc).toContain('restoreResult.error.message');
    expect(e2eSrc).not.toContain('Restore failed');
  });
});

// ── cattleDeleteApi — exports ───────────────────────────────────────────

describe('cattleDeleteApi — exports', () => {
  it('exports softDeleteCattleAnimal', () => {
    expect(apiSrc).toMatch(/export async function softDeleteCattleAnimal/);
  });
  it('exports restoreCattleAnimal', () => {
    expect(apiSrc).toMatch(/export async function restoreCattleAnimal/);
  });
});
