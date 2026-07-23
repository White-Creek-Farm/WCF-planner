import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import lease from '../scripts/fleet/lease.cjs';
import secrets from '../scripts/fleet/secrets.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {resolveLease, buildDispatchArgs, assertLeaseEnvSafe, leaseRunTitle} = lease;

describe('lease routing (per-project, no fallback)', () => {
  it('maps each fleet bootstrap project to its own concurrency group', () => {
    expect(resolveLease('test-a')).toMatchObject({project: 'a', group: 'wcf-test-db-a'});
    expect(resolveLease('test-b')).toMatchObject({project: 'b', group: 'wcf-test-db-b'});
    expect(resolveLease('test-c')).toMatchObject({project: 'c', group: 'wcf-test-db-c'});
    expect(resolveLease('test-d')).toMatchObject({project: 'd', group: 'wcf-test-db-d'});
  });

  it('refuses a missing assignment (no default/fallback)', () => {
    expect(() => resolveLease('')).toThrow(/explicit project assignment/i);
    expect(() => resolveLease(null)).toThrow(/explicit project assignment/i);
  });

  it('refuses PROD, quarantined test-main, and unknown targets', () => {
    expect(() => resolveLease('prod')).toThrow(/PROD/i);
    expect(() => resolveLease('Farm Planner')).toThrow(/PROD/i);
    expect(() => resolveLease('test-main')).toThrow(/QUARANTINED/i);
    expect(() => resolveLease('main')).toThrow(/QUARANTINED/i);
    expect(() => resolveLease('test-e')).toThrow();
  });

  it('builds dispatch args with the fixed project choice', () => {
    const args = buildDispatchArgs({project: 'a', leaseId: 'lease-1', holdMinutes: 45});
    expect(args).toContain('test-db-lease-project.yml');
    expect(args).toContain('project=a');
    expect(args).toContain('lease_id=lease-1');
    expect(args).toContain('hold_minutes=45');
  });

  it('leaseRunTitle is project+id exact', () => {
    expect(leaseRunTitle({project: 'b', leaseId: 'x'})).toBe('TEST DB lease b x');
  });

  it('env guard mirrors the PROD refusal', () => {
    expect(() => assertLeaseEnvSafe({})).toThrow(/WCF_TEST_DATABASE/);
    expect(() => assertLeaseEnvSafe({WCF_TEST_DATABASE: '1'})).toThrow(/VITE_SUPABASE_URL/);
    expect(() =>
      assertLeaseEnvSafe({WCF_TEST_DATABASE: '1', VITE_SUPABASE_URL: 'https://pzfujbjtayhkdlxiblwe.supabase.co'}),
    ).toThrow(/PRODUCTION/i);
    expect(() =>
      assertLeaseEnvSafe({WCF_TEST_DATABASE: '1', VITE_SUPABASE_URL: 'https://dkigsoyejzjwldqtqkkn.supabase.co'}),
    ).not.toThrow();
  });
});

describe('secret routing custody', () => {
  it('service-role key is NOT a VITE_ (browser) variable; URL/anon/admin are the only VITE ones', () => {
    expect(secrets.SECRET_NAMES).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(secrets.SECRET_NAMES.filter((n) => n.startsWith('VITE_'))).toEqual([
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'VITE_TEST_ADMIN_EMAIL',
      'VITE_TEST_ADMIN_PASSWORD',
    ]);
    expect(secrets.SECRET_NAMES.some((n) => n.startsWith('VITE_') && n.includes('SERVICE_ROLE'))).toBe(false);
  });

  it('envNameForKey isolates each TEST project; refuses PROD/reference', () => {
    expect(secrets.envNameForKey('test-a')).toBe('test-a');
    expect(secrets.envNameForKey('test-c')).toBe('test-c');
    expect(() => secrets.envNameForKey('prod')).toThrow();
    expect(() => secrets.envNameForKey('test-main')).toThrow();
  });

  it('planSecretRouting carries names only, never values', () => {
    const plan = secrets.planSecretRouting('test-b');
    // Exactly repo + environment + secret NAMES; no value-bearing field exists.
    expect(plan).toEqual({
      repo: 'White-Creek-Farm/WCF-planner',
      environment: 'test-b',
      secret_names: secrets.SECRET_NAMES,
    });
    expect(Object.keys(plan)).toEqual(['repo', 'environment', 'secret_names']);
    expect(JSON.stringify(plan)).not.toContain('eyJ'); // no JWT-shaped value
  });

  it('setEnvSecret sends the VALUE via stdin, never in argv', async () => {
    const calls = [];
    const io = {run: async (file, args, opts) => (calls.push({file, args, opts}), {code: 0, stdout: '', stderr: ''})};
    await secrets.setEnvSecret(io, {
      environment: 'test-a',
      name: 'SUPABASE_SERVICE_ROLE_KEY',
      value: 'eyJsuper.secret.value',
    });
    const call = calls[0];
    expect(call.args.join(' ')).not.toContain('eyJsuper.secret.value'); // not in argv
    expect(call.opts.input).toBe('eyJsuper.secret.value'); // in stdin
    expect(call.args).toContain('--env');
    expect(call.args).toContain('test-a');
  });

  it('routeProjectSecrets with apply=false is a names-only plan (no io calls)', async () => {
    let ran = false;
    const io = {run: async () => ((ran = true), {code: 0, stdout: '', stderr: ''})};
    const r = await secrets.routeProjectSecrets(io, {key: 'test-a', values: {}, apply: false});
    expect(r.applied).toBe(false);
    expect(r.secret_names).toEqual(secrets.SECRET_NAMES);
    expect(ran).toBe(false);
  });

  it('refuses to set an unknown secret name', async () => {
    const io = {run: async () => ({code: 0})};
    await expect(secrets.setEnvSecret(io, {environment: 'test-a', name: 'HAX', value: 'x'})).rejects.toThrow(
      /unknown secret name/i,
    );
  });

  it('routeProjectSecrets(apply) fails closed on partial credentials (missing value)', async () => {
    const calls = [];
    const io = {run: async (f, a, o) => (calls.push({a, o}), {code: 0, stdout: '[]', stderr: ''})};
    // missing SUPABASE_SERVICE_ROLE_KEY -> must refuse, not route a partial set
    const values = {
      VITE_SUPABASE_URL: 'u',
      VITE_SUPABASE_ANON_KEY: 'a',
      VITE_TEST_ADMIN_EMAIL: 'e',
      VITE_TEST_ADMIN_PASSWORD: 'p',
    };
    await expect(secrets.routeProjectSecrets(io, {key: 'test-a', values, apply: true})).rejects.toThrow(
      /Missing value/i,
    );
  });
});

describe('environment protection policy (Phase 3 containment)', () => {
  it('has no required reviewers or wait timer (automated CI compatible)', () => {
    expect(secrets.ENV_PROTECTION_POLICY.reviewers).toEqual([]);
    expect(secrets.ENV_PROTECTION_POLICY.wait_timer).toBe(0);
  });

  it('uses a CUSTOM branch policy, not all-branches/wildcard', () => {
    expect(secrets.ENV_PROTECTION_POLICY.deployment_branch_policy).toEqual({
      protected_branches: false,
      custom_branch_policies: true,
    });
    // exact allowed branches; no wildcard
    expect(secrets.ALLOWED_BRANCHES).toEqual([
      'main',
      'feature/test-project-fleet',
      'feature/test-playwright-reliability',
    ]);
    expect(secrets.ALLOWED_BRANCHES.some((b) => b.includes('*'))).toBe(false);
  });

  it('per-project environment names are distinct and cover exactly TEST A-D', () => {
    const envs = ['test-a', 'test-b', 'test-c', 'test-d'].map((k) => secrets.envNameForKey(k));
    expect(new Set(envs).size).toBe(4);
    expect(envs).toEqual(['test-a', 'test-b', 'test-c', 'test-d']);
    // quarantined test-main gets no environment
    expect(() => secrets.envNameForKey('test-main')).toThrow();
    expect(() => secrets.envNameForKey('prod')).toThrow();
  });

  it('secrets.cjs never functionally references a PROD ref, test-main ref, or DR/test-main environment', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/fleet/secrets.cjs'), 'utf8');
    expect(src).not.toContain('pzfujbjtayhkdlxiblwe'); // PROD ref literal
    expect(src).not.toContain('msxvjupafhkcrerulolv'); // test-main ref literal
    // no quoted (functional) dr-backup / test-main environment name — a doc
    // comment contrasting the dr-backup env is fine, a routed env name is not.
    expect(src).not.toMatch(/["']dr-backup["']/);
    expect(src).not.toMatch(/["']test-main["']/);
  });
});
