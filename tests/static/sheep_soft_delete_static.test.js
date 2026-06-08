import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig074 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/074_sheep_animal_soft_delete.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/sheepDeleteApi.js'), 'utf8');
const animalSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');
const detailSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDetail.jsx'), 'utf8');
const batchHelperSrc = fs.readFileSync(path.join(ROOT, 'src/lib/sheepProcessingBatch.js'), 'utf8');
const recoveryAdminSrc = fs.readFileSync(path.join(ROOT, 'src/admin/RecentlyDeletedDailyReports.jsx'), 'utf8');

// ── Migration 074 — schema: deleted_at + deleted_by columns ─────────────

describe('mig 074 — schema: deleted_at + deleted_by columns', () => {
  it('adds deleted_at timestamptz column', () => {
    expect(mig074).toMatch(/ALTER TABLE public\.sheep/);
    expect(mig074).toMatch(/deleted_at\s+timestamptz/);
  });
  it('adds deleted_by column referencing profiles', () => {
    expect(mig074).toMatch(/deleted_by\s+uuid REFERENCES public\.profiles\(id\)/);
  });
});

// ── Migration 074 — tag uniqueness indexes ──────────────────────────────

describe('mig 074 — tag uniqueness indexes', () => {
  it('drops old idx_sheep_tag_unique', () => {
    expect(mig074).toContain('DROP INDEX IF EXISTS idx_sheep_tag_unique');
  });
  it('drops old idx_sheep_tag_active_unique', () => {
    expect(mig074).toContain('DROP INDEX IF EXISTS idx_sheep_tag_active_unique');
  });
  it('recreates idx_sheep_tag_active_unique with deleted_at IS NULL', () => {
    expect(mig074).toMatch(/CREATE UNIQUE INDEX idx_sheep_tag_active_unique[\s\S]*?deleted_at IS NULL/);
  });
  it('preserves active-flock scope (rams, ewes, feeders)', () => {
    const idxBlock = mig074.match(/CREATE UNIQUE INDEX idx_sheep_tag_active_unique[\s\S]*?;/);
    expect(idxBlock).not.toBeNull();
    for (const flock of ['rams', 'ewes', 'feeders']) {
      expect(idxBlock[0]).toContain(flock);
    }
  });
  it('adds a partial active lookup index', () => {
    expect(mig074).toMatch(/CREATE INDEX IF NOT EXISTS sheep_active_idx[\s\S]*?WHERE deleted_at IS NULL/);
  });
});

// ── Migration 074 — RLS policies ────────────────────────────────────────
// Strict cattle 069 parity: drop the legacy anon SELECT + single auth FOR ALL
// policy and create six scoped replacements (anon + auth select/insert/update).
// No DELETE path; deleted rows hidden from anon + non-admin auth reads.

describe('mig 074 — RLS policies', () => {
  const OLD_POLICIES = ['sheep_anon_select', 'sheep_auth_all'];
  const NEW_POLICIES = [
    'sheep_anon_select',
    'sheep_anon_insert',
    'sheep_anon_update',
    'sheep_auth_select',
    'sheep_auth_insert',
    'sheep_auth_update',
  ];

  for (const p of OLD_POLICIES) {
    it(`drops old policy ${p}`, () => {
      expect(mig074).toMatch(new RegExp(`DROP POLICY IF EXISTS ${p}\\s+ON public\\.sheep`));
    });
  }

  for (const p of NEW_POLICIES) {
    it(`creates replacement policy ${p}`, () => {
      expect(mig074).toMatch(new RegExp(`CREATE POLICY ${p} ON public\\.sheep`));
    });
  }

  it('anon policies are explicitly scoped TO anon', () => {
    for (const p of ['sheep_anon_select', 'sheep_anon_insert', 'sheep_anon_update']) {
      const block = mig074.match(new RegExp(`CREATE POLICY ${p} ON public\\.sheep[\\s\\S]*?;`));
      expect(block, `${p} should exist`).not.toBeNull();
      expect(block[0]).toMatch(/TO anon/);
    }
  });

  it('anon/auth reads hide deleted rows; admins still see them', () => {
    const anonSel = mig074.match(/CREATE POLICY sheep_anon_select ON public\.sheep[\s\S]*?;/);
    expect(anonSel[0]).toMatch(/deleted_at IS NULL/);
    const authSel = mig074.match(/CREATE POLICY sheep_auth_select ON public\.sheep[\s\S]*?;/);
    expect(authSel[0]).toMatch(/deleted_at IS NULL OR public\.profile_role\(\) = 'admin'/);
  });

  it('does NOT create a DELETE policy (no app-level hard delete)', () => {
    expect(mig074).not.toMatch(/FOR DELETE/);
  });
});

// ── Migration 074 — soft_delete_sheep_animal RPC ────────────────────────

describe('mig 074 — soft_delete_sheep_animal RPC', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig074).toMatch(/CREATE OR REPLACE FUNCTION public\.soft_delete_sheep_animal[\s\S]*?SECURITY DEFINER/);
  });
  it('is admin-only', () => {
    expect(mig074).toMatch(/soft_delete_sheep_animal: admin role required/);
  });
  it('checks record exists and is not already deleted', () => {
    expect(mig074).toMatch(/deleted_at IS NULL/);
    expect(mig074).toMatch(/record not found or already deleted/);
  });
  it('inserts record.deleted activity event for sheep.animal', () => {
    expect(mig074).toContain("'record.deleted'");
    expect(mig074).toContain("'sheep.animal'");
    expect(mig074).toMatch(/INSERT INTO public\.activity_events/);
  });
  it('REVOKE from PUBLIC/anon + GRANT to authenticated', () => {
    expect(mig074).toMatch(/REVOKE ALL ON FUNCTION public\.soft_delete_sheep_animal\([^)]*\) FROM PUBLIC, anon/);
    expect(mig074).toMatch(/GRANT EXECUTE ON FUNCTION public\.soft_delete_sheep_animal\([^)]*\) TO authenticated/);
  });
});

// ── Migration 074 — restore_sheep_animal RPC ────────────────────────────

describe('mig 074 — restore_sheep_animal RPC', () => {
  it('is SECURITY DEFINER', () => {
    expect(mig074).toMatch(/CREATE OR REPLACE FUNCTION public\.restore_sheep_animal[\s\S]*?SECURITY DEFINER/);
  });
  it('is admin-only', () => {
    expect(mig074).toMatch(/restore_sheep_animal: admin role required/);
  });
  it('rejects active tag conflicts using flock + tag + deleted_at IS NULL semantics', () => {
    const fn = mig074.match(/CREATE OR REPLACE FUNCTION public\.restore_sheep_animal[\s\S]*?\$fn\$;/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/tag.*already in use/);
    expect(fn[0]).toMatch(/flock IN \('rams','ewes','feeders'\)/);
    expect(fn[0]).toMatch(/deleted_at IS NULL/);
  });
  it('inserts record.restored activity event', () => {
    expect(mig074).toContain("'record.restored'");
  });
  it('REVOKE from PUBLIC/anon + GRANT to authenticated', () => {
    expect(mig074).toMatch(/REVOKE ALL ON FUNCTION public\.restore_sheep_animal\([^)]*\) FROM PUBLIC, anon/);
    expect(mig074).toMatch(/GRANT EXECUTE ON FUNCTION public\.restore_sheep_animal\([^)]*\) TO authenticated/);
  });
});

// ── Migration 074 — NOTIFY ──────────────────────────────────────────────

describe('mig 074 — NOTIFY', () => {
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig074).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

// ── sheepDeleteApi — exports ────────────────────────────────────────────

describe('sheepDeleteApi — exports', () => {
  it('exports softDeleteSheepAnimal calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function softDeleteSheepAnimal/);
    expect(apiSrc).toContain("sb.rpc('soft_delete_sheep_animal'");
  });
  it('exports restoreSheepAnimal calling the RPC', () => {
    expect(apiSrc).toMatch(/export async function restoreSheepAnimal/);
    expect(apiSrc).toContain("sb.rpc('restore_sheep_animal'");
  });
});

// ── SheepAnimalPage — soft-delete via RPC, admin-gated ──────────────────

describe('SheepAnimalPage — soft-delete via RPC, admin-gated', () => {
  it('uses softDeleteSheepAnimal instead of a hard delete', () => {
    expect(animalSrc).toContain('softDeleteSheepAnimal');
    expect(animalSrc).not.toMatch(/from\('sheep'\)\.delete\(\)/);
  });
  it('confirm copy no longer claims permanent deletion', () => {
    expect(animalSrc).not.toContain('Permanently delete this sheep record');
    expect(animalSrc).toContain('Admin/backend recovery is available');
  });
  it('admin-gates the delete action', () => {
    expect(animalSrc).toMatch(/onDelete=\{authState\?\.role === 'admin' \? \(\) => deleteSheep\(\) : undefined\}/);
  });
});

// ── SheepDetail — conditional delete button ─────────────────────────────

describe('SheepDetail — conditional delete button', () => {
  it('conditionally renders the delete button via onDelete &&', () => {
    expect(detailSrc).toMatch(/\{onDelete && \(/);
  });
});

describe('RecentlyDeletedDailyReports — sheep animal recovery surface', () => {
  it('queries deleted sheep animals from the admin recovery surface', () => {
    expect(recoveryAdminSrc).toContain("'sheep.animal'");
    expect(recoveryAdminSrc).toContain("table: 'sheep'");
    expect(recoveryAdminSrc).toContain("select: 'id, tag, flock, sex, deleted_at, deleted_by'");
    expect(recoveryAdminSrc).toContain("'deleted_at', 'is', null");
  });

  it('restores sheep animals through restoreSheepAnimal', () => {
    expect(recoveryAdminSrc).toContain("import {restoreSheepAnimal} from '../lib/sheepDeleteApi.js'");
    expect(recoveryAdminSrc).toContain('restore: restoreSheepAnimal');
    expect(recoveryAdminSrc).toMatch(/recordKind:\s*'animal'/);
    expect(recoveryAdminSrc).toContain('data-recently-deleted-entity={r.entityType}');
    expect(recoveryAdminSrc).toContain('data-recently-deleted-record-kind={r.recordKind}');
  });
});

// ── Active-record filter audit — sheep read sites ───────────────────────

describe('Active-record filter audit — sheep read sites', () => {
  it('SheepAnimalPage filters the record load and list by deleted_at', () => {
    expect(animalSrc).toContain(".eq('id', sheepId).is('deleted_at', null)");
    expect(animalSrc).toContain(".is('deleted_at', null).order('tag')");
  });
  it('SheepHomeView filters the sheep query', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepHomeView.jsx'), 'utf8');
    expect(src).toContain("from('sheep').select('*').is('deleted_at', null)");
  });
  it('SheepFlocksView filters the sheep list', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
    expect(src).toContain("from('sheep').select('*').is('deleted_at', null).order('tag')");
  });
  it('SheepBatchPage filters the available-sheep pool', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchPage.jsx'), 'utf8');
    expect(src).toContain("from('sheep').select('*').is('deleted_at', null)");
  });
  it('WeighInSessionPage sheep branch filters deleted_at', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/livestock/WeighInSessionPage.jsx'), 'utf8');
    expect(src).toMatch(/from\('sheep'\)\.select\('\*'\)\.is\('deleted_at', null\)/);
  });
  it('WeighInsWebform sheep lookup filters deleted_at', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');
    expect(src).toMatch(/from\('sheep'\)[\s\S]{0,120}\.is\('deleted_at', null\)/);
  });
  it('main.jsx sheep-for-home lookup filters deleted_at', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
    expect(src).toMatch(/from\('sheep'\)\s*\.select\('id,flock'\)\s*\.is\('deleted_at', null\)/);
  });
});

// ── sheepProcessingBatch — admin processing context exception ────────────
// Mirrors the cattleProcessingBatch exception: the send-to-processor / detach
// helper operates in an admin processing context and intentionally does NOT
// add a deleted_at filter, matching cattle parity.

describe('sheepProcessingBatch — admin processing context exception', () => {
  it('does NOT add deleted_at filter (admin processing context)', () => {
    expect(batchHelperSrc).not.toContain('deleted_at');
  });
});
