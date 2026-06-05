import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const MIG = fs.readFileSync(path.join(ROOT, 'supabase-migrations/095_app_saved_views.sql'), 'utf8');

// ============================================================================
// Locks the app_saved_views migration contract (095): generic per-surface saved
// views with server-trusted ownership and public-or-owner / owner-only RLS.
// ============================================================================

describe('095_app_saved_views — table shape', () => {
  it('creates the table with the agreed columns', () => {
    expect(MIG).toContain('CREATE TABLE IF NOT EXISTS public.app_saved_views');
    expect(MIG).toMatch(/surface_key\s+text\s+NOT NULL/);
    expect(MIG).toMatch(/name\s+text\s+NOT NULL/);
    expect(MIG).toMatch(/view_state\s+jsonb\s+NOT NULL/);
    expect(MIG).toMatch(/owner_profile_id\s+uuid\s+NOT NULL REFERENCES public\.profiles\(id\)/);
    expect(MIG).toMatch(/created_at\s+timestamptz\s+NOT NULL/);
    expect(MIG).toMatch(/updated_at\s+timestamptz\s+NOT NULL/);
  });

  it('constrains visibility to private/public', () => {
    expect(MIG).toMatch(/visibility[\s\S]*?CHECK \(visibility IN \('private', 'public'\)\)/);
  });
});

describe('095_app_saved_views — server-trusted ownership', () => {
  it('stamps owner_profile_id from auth.uid() on insert', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.stamp_saved_view_owner');
    expect(MIG).toMatch(/NEW\.owner_profile_id := auth\.uid\(\)/);
    expect(MIG).toContain('BEFORE INSERT ON public.app_saved_views');
  });

  it('freezes owner + bumps updated_at on update', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.touch_saved_view_updated_at');
    expect(MIG).toMatch(/NEW\.owner_profile_id := OLD\.owner_profile_id/);
    expect(MIG).toMatch(/NEW\.updated_at := now\(\)/);
    expect(MIG).toContain('BEFORE UPDATE ON public.app_saved_views');
  });
});

describe('095_app_saved_views — RLS + grants', () => {
  it('enables RLS and grants only authenticated', () => {
    expect(MIG).toContain('ALTER TABLE public.app_saved_views ENABLE ROW LEVEL SECURITY');
    expect(MIG).toMatch(/REVOKE ALL ON TABLE public\.app_saved_views FROM PUBLIC, anon/);
    expect(MIG).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.app_saved_views TO authenticated/);
  });

  it('SELECT is public-or-owner', () => {
    expect(MIG).toMatch(/CREATE POLICY app_saved_views_select[\s\S]*?FOR SELECT/);
    expect(MIG).toMatch(/USING \(visibility = 'public' OR owner_profile_id = auth\.uid\(\)\)/);
  });

  it('INSERT/UPDATE/DELETE are owner-only', () => {
    expect(MIG).toMatch(/CREATE POLICY app_saved_views_insert[\s\S]*?WITH CHECK \(owner_profile_id = auth\.uid\(\)\)/);
    expect(MIG).toMatch(/CREATE POLICY app_saved_views_update[\s\S]*?FOR UPDATE/);
    expect(MIG).toMatch(/CREATE POLICY app_saved_views_delete[\s\S]*?USING \(owner_profile_id = auth\.uid\(\)\)/);
  });

  it('is BEGIN/COMMIT-free (exec_sql TEST apply + psql --single-transaction PROD)', () => {
    expect(MIG).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(MIG).not.toMatch(/^\s*COMMIT;\s*$/m);
  });
});
