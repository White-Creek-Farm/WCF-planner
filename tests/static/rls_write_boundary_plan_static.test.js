import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// DB/RLS legacy write-boundary — Tier 1 safety invariants (2026-06-23)
// ============================================================================
// Locks the facts the Tier-1 anon-policy drop (candidate migration 138) relies
// on, and asserts the candidate migration is a pure, drop-only change that does
// NOT touch the authenticated boundary. This is a planning/safety guard for a
// candidate migration that is NOT yet applied to PROD.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const mig = fs.readFileSync(path.join(ROOT, 'supabase-migrations/138_drop_dead_anon_write_policies.sql'), 'utf8');

const DEAD_POLICIES = [
  ['cattle_dailys', 'cattle_dailys_anon_insert'],
  ['sheep_dailys', 'sheep_dailys_anon_insert'],
  ['sheep_dailys', 'sheep_dailys_anon_select'],
  ['weigh_ins', 'weigh_ins_anon_insert'],
  ['weigh_ins', 'weigh_ins_anon_select'],
  ['weigh_ins', 'weigh_ins_anon_update'],
  ['weigh_in_sessions', 'weigh_in_sessions_anon_insert'],
  ['weigh_in_sessions', 'weigh_in_sessions_anon_update'],
  ['weigh_in_sessions', 'weigh_in_sessions_anon_select'],
  ['sheep_comments', 'sheep_comments_anon_insert'],
  ['sheep_comments', 'sheep_comments_anon_select'],
];

describe('login gate makes the anon write paths dead (Tier-1 basis)', () => {
  it('main.jsx returns LoginScreen when authState === false', () => {
    expect(mainSrc).toMatch(/authState === false\)?\s*return\s*<LoginScreen/);
  });
  it('the login gate precedes the weighins write view in the render', () => {
    const gate = mainSrc.indexOf('authState === false) return <LoginScreen');
    const weighinsView = mainSrc.indexOf("view === 'weighins'");
    expect(gate).toBeGreaterThan(-1);
    expect(weighinsView).toBeGreaterThan(gate);
  });
});

describe('candidate migration 138 — drop-only, does not touch the auth boundary', () => {
  // Strip SQL comments (full-line and inline `-- ...`) so assertions target
  // executable DDL only — the header explains auth_all/REVOKE/GRANT in prose.
  const migSql = mig
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

  it('drops every dead public/anon policy in scope', () => {
    for (const [table, policy] of DEAD_POLICIES) {
      const re = new RegExp(`DROP POLICY IF EXISTS ${policy} ON public\\.${table}`);
      expect(migSql, `${policy} on ${table}`).toMatch(re);
    }
  });
  it('uses idempotent DROP POLICY IF EXISTS only — no policy is recreated', () => {
    expect(migSql).not.toMatch(/CREATE POLICY/);
    const drops = migSql.match(/DROP POLICY[^\n]*/g) || [];
    expect(drops.length).toBeGreaterThanOrEqual(DEAD_POLICIES.length);
    for (const d of drops) expect(d).toMatch(/DROP POLICY IF EXISTS/);
  });
  it('does NOT drop or alter any *_auth_all policy (authenticated boundary preserved)', () => {
    expect(migSql).not.toMatch(/auth_all/);
  });
  it('does NOT REVOKE or GRANT table privileges (policy-only change)', () => {
    expect(migSql).not.toMatch(/\b(REVOKE|GRANT)\b/);
  });
  it('reloads PostgREST per repo convention', () => {
    expect(migSql).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
