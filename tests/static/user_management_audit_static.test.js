import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const migration = read('supabase-migrations/171_audited_user_management.sql');
const modal = read('src/auth/UsersModal.jsx');
const api = read('src/lib/userManagementApi.js');
const edge = read('supabase-functions/rapid-processor.ts');
const proof = read('scripts/apply_test_mig_171.cjs');

function functionBody(name) {
  const start = migration.indexOf(`FUNCTION public.${name}`);
  if (start < 0) return '';
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 20);
  return migration.slice(start, next < 0 ? migration.length : next);
}

function edgeBranch(type, nextType) {
  const start = edge.indexOf(`if (type === '${type}')`);
  const end = edge.indexOf(`if (type === '${nextType}')`, start + 1);
  return edge.slice(start, end < 0 ? edge.length : end);
}

describe('migration 171 — audited user-management boundary', () => {
  it('is safe for exec_sql callers that already own the migration transaction', () => {
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/im);
  });

  it('keeps immutable audit snapshots independent of deletable profiles', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.user_management_audit');
    expect(migration).toMatch(/actor_profile_id\s+uuid NOT NULL/);
    expect(migration).toMatch(/target_profile_id\s+uuid NOT NULL/);
    const table = migration.match(/CREATE TABLE IF NOT EXISTS public\.user_management_audit[\s\S]*?\n\);/)?.[0] || '';
    expect(table).not.toMatch(/REFERENCES\s+(?:public\.)?profiles/i);
    expect(migration).toMatch(/ALTER TABLE public\.user_management_audit ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.user_management_audit FROM PUBLIC, anon, authenticated/);
  });

  it('exposes only authenticated SECDEF mutation RPCs and hides private helpers', () => {
    const publicRpcs = [
      'admin_set_user_name',
      'admin_set_user_role',
      'admin_set_user_program_access',
      'admin_prepare_user_delete',
      'admin_finalize_user_delete',
    ];
    for (const name of publicRpcs) {
      const body = functionBody(name);
      expect(body, name).toMatch(/SECURITY DEFINER/);
      expect(body, name).toMatch(/SET search_path = public/);
      expect(migration, name).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`));
      expect(migration, name).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon`),
      );
    }
    for (const name of [
      '_require_user_management_admin',
      '_log_user_management_event',
      '_audit_profile_delete_from_auth_cascade',
      '_user_management_delete_pending',
      '_user_management_effective_admin_count',
      '_lock_user_management_admin',
      '_require_user_management_mutator',
      '_user_profile_delete_blockers',
    ]) {
      expect(migration, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?authenticated`));
    }
  });

  it('validates every canonical role and program key server-side', () => {
    const role = functionBody('admin_set_user_role');
    for (const value of ['admin', 'management', 'farm_team', 'equipment_tech', 'light', 'inactive']) {
      expect(role).toContain(`'${value}'`);
    }
    const access = functionBody('admin_set_user_program_access');
    for (const value of ['broiler', 'layer', 'pig', 'cattle', 'sheep', 'equipment']) {
      expect(access).toContain(`'${value}'`);
    }
    expect(access).toMatch(/p_program_access IS NULL OR cardinality\(p_program_access\) = 0/);
    expect(access).toMatch(/v_clean := NULL/);
  });

  it('enforces self-lockout and effective-last-admin safety', () => {
    const role = functionBody('admin_set_user_role');
    const prepare = functionBody('admin_prepare_user_delete');
    expect(role).toMatch(/p_profile_id = v_caller[\s\S]*?cannot change your own role/);
    expect(prepare).toMatch(/p_profile_id = v_caller[\s\S]*?cannot delete your own account/);
    expect(role).toMatch(/_user_management_effective_admin_count\(\) <= 1/);
    expect(prepare).toMatch(/_user_management_effective_admin_count\(\) <= 1/);
  });

  it('makes Auth cascade success and terminal deletion audit one transaction', () => {
    const trigger = functionBody('_audit_profile_delete_from_auth_cascade');
    const finalize = functionBody('admin_finalize_user_delete');
    expect(trigger).toMatch(/RETURNS trigger/);
    expect(trigger).toMatch(/OLD\.id/);
    expect(trigger).toMatch(/'profile\.delete_requested'/);
    expect(trigger).toMatch(/'profile\.deleted'/);
    expect(trigger).toMatch(/'completed_by', 'profiles_delete_trigger'/);
    expect(trigger).toMatch(/EXISTS \([\s\S]*?FROM auth\.users WHERE id = OLD\.id/);
    expect(trigger).toMatch(/must originate from auth\.users cascade/);
    expect(migration).toMatch(/CREATE TRIGGER profiles_audit_auth_delete/);
    expect(migration).toMatch(/AFTER DELETE ON public\.profiles/);
    expect(migration).toMatch(/EXECUTE FUNCTION public\._audit_profile_delete_from_auth_cascade\(\)/);
    expect(finalize).toMatch(/v_profile_exists IS DISTINCT FROM v_auth_exists/);
    expect(finalize).toMatch(/auth\/profile split-brain state requires repair/);
    expect(finalize).toMatch(/ELSIF NOT v_profile_exists/);
    expect(finalize).toMatch(/v_event := 'profile\.deleted'/);
    expect(finalize).toMatch(/recovered_ambiguous_auth_error/);
  });

  it('uses durable pending requests to close the cross-service two-admin race', () => {
    const pending = functionBody('_user_management_delete_pending');
    const effective = functionBody('_user_management_effective_admin_count');
    const lock = functionBody('_lock_user_management_admin');
    const role = functionBody('admin_set_user_role');
    const prepare = functionBody('admin_prepare_user_delete');

    expect(pending).toMatch(/profile\.delete_requested/);
    expect(pending).toMatch(/NOT EXISTS[\s\S]*?profile\.deleted[\s\S]*?profile\.delete_failed/);
    expect(effective).toMatch(/role = 'admin'/);
    expect(effective).toMatch(/NOT public\._user_management_delete_pending\(p\.id, false\)/);
    expect(lock).toMatch(/pg_advisory_xact_lock\(171001\)/);
    expect(lock).toMatch(/FOR SHARE/);
    expect(lock).toMatch(/admin role required after lock wait/);
    expect(lock).toMatch(/_user_management_delete_pending\(p_caller, false\)/);
    expect(lock).toMatch(/VOLATILE/);
    expect(role).toMatch(/_user_management_delete_pending\(p_profile_id, true\)/);
    expect(prepare).toMatch(/_user_management_delete_pending\(p_profile_id, true\)/);
    const mutator = functionBody('_require_user_management_mutator');
    expect(mutator).toMatch(/_require_user_management_admin\(\)/);
    expect(mutator).toMatch(/_lock_user_management_admin\(v_caller, false\)/);
    for (const name of [
      'admin_set_user_name',
      'admin_set_user_role',
      'admin_set_user_program_access',
      'admin_prepare_user_delete',
    ]) {
      expect(functionBody(name), name).toMatch(/_require_user_management_mutator\(\)/);
    }
    const finalize = functionBody('admin_finalize_user_delete');
    expect(finalize).toMatch(/_require_user_management_admin\(\)/);
    expect(finalize).toMatch(/_lock_user_management_admin\(v_caller, true\)/);
  });

  it('recovers stale and missing-terminal crashes without racing a recent request', () => {
    const prepare = functionBody('admin_prepare_user_delete');
    expect(prepare).toMatch(/created_at > now\(\) - interval '5 minutes'/);
    expect(prepare).toMatch(/wait five minutes before retrying/);
    expect(prepare).toMatch(/'profile\.delete_failed'/);
    expect(prepare).toMatch(/'recovered_as_stale', true/);
    expect(prepare).toMatch(/'retry_required', true/);
    expect(prepare).toMatch(/'recovered_stale_request', true/);
    expect(prepare).toMatch(/NOT v_profile_found AND NOT v_auth_found/);
    expect(prepare).toMatch(/'recovered_missing_terminal', true/);
    expect(prepare).toMatch(/'already_deleted', true/);
    expect(prepare).toMatch(/auth\/profile split-brain state requires repair/);
    const staleReturn = prepare.indexOf("'retry_required', true");
    expect(staleReturn).toBeGreaterThan(prepare.indexOf("'profile.delete_failed'"));
    expect(staleReturn).toBeLessThan(prepare.indexOf('_user_management_effective_admin_count'));
  });

  it('preflights retained profile FKs without attempting a destructive trial delete', () => {
    const blockers = functionBody('_user_profile_delete_blockers');
    const prepare = functionBody('admin_prepare_user_delete');
    expect(blockers).toMatch(/pg_catalog\.pg_constraint/);
    expect(blockers).toMatch(/confrelid = 'public\.profiles'::regclass/);
    expect(blockers).toMatch(/confdeltype IN \('a', 'r'\)/);
    expect(blockers).not.toMatch(/DELETE FROM public\.profiles/i);
    expect(prepare).toMatch(/account has retained farm records; deactivate it instead/);
  });

  it('updates profile data and appends audit evidence inside each RPC transaction', () => {
    const cases = [
      ['admin_set_user_name', /UPDATE public\.profiles[\s\S]*?_log_user_management_event/],
      ['admin_set_user_role', /UPDATE public\.profiles[\s\S]*?_log_user_management_event/],
      ['admin_set_user_program_access', /UPDATE public\.profiles[\s\S]*?_log_user_management_event/],
    ];
    for (const [name, pattern] of cases) expect(functionBody(name), name).toMatch(pattern);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.profiles FROM PUBLIC, anon, authenticated/,
    );
  });
});

describe('UsersModal — RPC-only profile mutations', () => {
  it('contains no direct profiles mutation and uses the dedicated wrappers', () => {
    expect(modal).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    expect(modal).toContain("from '../lib/userManagementApi.js'");
    expect(modal).toMatch(/setUserName\(sb, userId, fullName\)/);
    expect(modal).toMatch(/setUserRole\(sb, userId, newRole\)/);
    expect(modal).toMatch(/setUserProgramAccess\(sb, userId, value\)/);
    expect(api).toMatch(/sb\.rpc\(name, args\)/);
  });

  it('offers equipment tech as active assignment and keeps inactive as a state-only option', () => {
    const roles = modal.match(/const ROLES = \[[\s\S]*?\n {2}\];/)?.[0] || '';
    expect(roles).toContain('equipment_tech');
    expect(roles).not.toContain("v: 'inactive'");
    expect(modal).toMatch(/u\.role === 'inactive' && <option value="inactive">Inactive<\/option>/);
  });

  it('surfaces RPC failures before changing local rows', () => {
    for (const call of ['setUserName', 'setUserRole', 'setUserProgramAccess']) {
      expect(modal).toMatch(new RegExp(`try \\{[\\s\\S]*?await ${call}[\\s\\S]*?catch \\(e\\)`));
    }
    expect(modal).toContain('data-user-management-message="error"');
  });

  it('globally locks user mutations while any row or create action is active', () => {
    expect(modal).toMatch(/const userMutationBusy = umLoading \|\| userActionId !== null/);
    expect(modal).not.toMatch(/disabled=\{userActionId === u\.id\}/);
    expect(modal).toMatch(/sendPasswordReset\(userId, email, name\)[\s\S]*?setUserActionId\(userId\)/);
    expect((modal.match(/disabled=\{userMutationBusy\}/g) || []).length).toBeGreaterThanOrEqual(8);
  });
});

describe('rapid-processor — coordinated Auth deletion', () => {
  const deleteBranch = edgeBranch('user_delete', 'tasks_weekly_summary');
  const createBranch = edgeBranch('user_create', 'user_welcome');

  it('preflights before Auth delete and finalizes both outcomes', () => {
    const prepare = deleteBranch.indexOf("rpc('admin_prepare_user_delete'");
    const remove = deleteBranch.indexOf('admin.auth.admin.deleteUser(profileId)');
    const finalize = deleteBranch.indexOf("rpc('admin_finalize_user_delete'");
    expect(prepare).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(prepare);
    expect(finalize).toBeGreaterThan(remove);
    expect(deleteBranch).toMatch(/p_succeeded: false/);
    expect(deleteBranch).toMatch(/p_succeeded: true/);
    expect(deleteBranch).toMatch(/prepareData\?\.retry_required === true/);
    expect(deleteBranch).toMatch(/prepareData\.already_deleted === true/);
    expect(deleteBranch).toMatch(/alreadyDeleted: true/);
    expect(deleteBranch).toMatch(/if \(reconciliationError\)[\s\S]*?step: 'deleteAudit'[\s\S]*?status: 409/);
    expect(deleteBranch).not.toMatch(/\.from\(\s*['"]profiles['"]\s*\)[\s\S]*?\.delete\(/);
  });

  it('keeps the explicit no-JWT admin gate ahead of every delete step', () => {
    const gate = deleteBranch.indexOf("rpc('is_admin')");
    const prepare = deleteBranch.indexOf("rpc('admin_prepare_user_delete'");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(prepare);
    expect(deleteBranch).toMatch(/status: 401/);
    expect(deleteBranch).toMatch(/status: 403/);
  });

  it('accepts every active assignable role on user creation, but not inactive', () => {
    const allowlist = createBranch.match(/\[\s*'admin',[\s\S]*?\]\.includes\(role\)/)?.[0] || '';
    for (const role of ['admin', 'management', 'farm_team', 'equipment_tech', 'light']) {
      expect(allowlist).toContain(`'${role}'`);
    }
    expect(allowlist).not.toContain("'inactive'");
  });
});

describe('migration 171 TEST proof safety', () => {
  it('uses guarded TEST env fallback and asserts every cleanup operation', () => {
    expect(proof).toContain("'..', '..', 'WCF-planner', '.env.test.local'");
    expect(proof).toMatch(/WCF_TEST_DATABASE !== '1'/);
    expect(proof).toMatch(/url\.includes\(PROD_REF\)/);
    expect(proof).toMatch(/const errors = \[\]/);
    expect(proof).toMatch(/if \(targetAuditError\) errors\.push/);
    expect(proof).toMatch(/if \(actorAuditError\) errors\.push/);
    expect(proof).toMatch(/if \(errors\.length\) throw new Error/);
    expect(proof).toMatch(/must originate from auth\\\.users cascade/i);
    expect(proof).toContain('direct profile delete cannot terminalize or bypass the Auth-owned cascade');
    expect(proof.indexOf("from('user_management_audit')")).toBeLessThan(
      proof.indexOf('service.auth.admin.deleteUser(id)'),
    );
  });
});
