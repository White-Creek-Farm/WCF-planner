import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// TEST DB lease — static contract locks
// ============================================================================
// The lease system has three load-bearing pieces that must stay in agreement:
//   1. .github/workflows/test-db-lease.yml — a workflow_dispatch-only holder
//      of the wcf-test-db concurrency slot. It must stay inert: no checkout,
//      no install, no secrets, no DB, no repo mutation. Holding the slot is
//      its ONLY job; anything it gains is attack/blast surface on a workflow
//      that anyone with repo write access can dispatch.
//   2. scripts/test_db_lease_run.cjs — the local wrapper. It must keep the
//      PROD refusal in lockstep with tests/setup/assertTestDatabase.js and
//      must never grow shell-string interpolation or secret handling.
//   3. .github/workflows/ci.yml — CI must keep using the SAME concurrency
//      group with cancel-in-progress: false, or the lease serializes nothing.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const workflow = read('.github/workflows/test-db-lease.yml');
const ci = read('.github/workflows/ci.yml');
const wrapper = read('scripts/test_db_lease_run.cjs');
const assertTestDb = read('tests/setup/assertTestDatabase.js');
const pkg = JSON.parse(read('package.json'));

describe('test-db-lease.yml workflow contract', () => {
  it('is workflow_dispatch-only (no push/PR/schedule trigger can burn the shared slot)', () => {
    expect(workflow).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).not.toMatch(/^\s*schedule:/m);
  });

  it('shares the wcf-test-db concurrency group without cancel-in-progress', () => {
    expect(workflow).toMatch(/group: wcf-test-db/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  it('requires a lease_id input and echoes it in run-name for run matching', () => {
    expect(workflow).toMatch(/lease_id:[\s\S]*?required: true/);
    expect(workflow).toMatch(/^run-name: TEST DB lease \$\{\{ inputs\.lease_id \}\}$/m);
  });

  it('declares zero API permissions', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
  });

  it('bounds the hold with a job timeout so a dead wrapper cannot block CI for 6 hours', () => {
    expect(workflow).toMatch(/timeout-minutes: \d+/);
  });

  it('stays inert: no checkout, no install, no secrets, no DB, no repository mutation', () => {
    for (const forbidden of [
      'actions/checkout',
      'secrets.',
      'npm ci',
      'npm install',
      'psql',
      'supabase',
      'SUPABASE',
      'git push',
      'git commit',
    ]) {
      expect(workflow, `workflow must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('never interpolates ${{ }} into the shell script body (injection surface)', () => {
    // ${{ }} may appear only on run-name, env-mapping, or comment lines —
    // never inside the run: script body, where it would expand pre-shell.
    const interpolatingLines = workflow.split('\n').filter((line) => line.includes('${{'));
    for (const line of interpolatingLines) {
      expect(line, `unexpected \${{ }} outside run-name/env/comments: "${line.trim()}"`).toMatch(
        /^\s*(#|run-name:|LEASE_ID:|HOLD_MINUTES:)/,
      );
    }
  });
});

describe('ci.yml stays lease-compatible', () => {
  it('keeps the shared wcf-test-db concurrency group with cancel-in-progress: false', () => {
    expect(ci).toMatch(/group: wcf-test-db/);
    expect(ci).toMatch(/cancel-in-progress: false/);
  });
});

describe('wrapper contract (scripts/test_db_lease_run.cjs)', () => {
  it('keeps the PROD project ref in lockstep with tests/setup/assertTestDatabase.js', () => {
    const fromWrapper = wrapper.match(/const PROD_PROJECT_REF = '([a-z0-9]+)'/);
    const fromGuard = assertTestDb.match(/const PROD_PROJECT_REF = '([a-z0-9]+)'/);
    expect(fromWrapper).not.toBeNull();
    expect(fromGuard).not.toBeNull();
    expect(fromWrapper[1]).toBe(fromGuard[1]);
  });

  it('enforces the WCF_TEST_DATABASE opt-in guard', () => {
    expect(wrapper).toMatch(/WCF_TEST_DATABASE.*!==\s*'1'/);
  });

  it('spawns everything with shell: false and never shell: true', () => {
    expect(wrapper).toContain('shell: false');
    expect(wrapper).not.toContain('shell: true');
  });

  it('handles no Supabase secrets itself (URL + flag only)', () => {
    expect(wrapper).not.toContain('SERVICE_ROLE');
    expect(wrapper).not.toContain('ANON_KEY');
    expect(wrapper).not.toContain('ADMIN_PASSWORD');
  });

  it('matches lease runs by exact run title, never substring', () => {
    expect(wrapper).toContain('RUN_NAME_PREFIX + leaseId');
    expect(wrapper).not.toMatch(/displayTitle\.includes/);
  });

  it('targets the workflow file that actually exists, with a matching run-name prefix', () => {
    const workflowFile = wrapper.match(/const WORKFLOW_FILE = '([^']+)'/);
    expect(workflowFile).not.toBeNull();
    expect(fs.existsSync(path.join(ROOT, '.github', 'workflows', workflowFile[1]))).toBe(true);
    const prefix = wrapper.match(/const RUN_NAME_PREFIX = '([^']+)'/);
    expect(prefix).not.toBeNull();
    expect(workflow).toContain(`run-name: ${prefix[1]}\${{ inputs.lease_id }}`);
  });

  it('is wired as the test:e2e:leased package script', () => {
    expect(pkg.scripts['test:e2e:leased']).toBe('node scripts/test_db_lease_run.cjs --');
  });
});
