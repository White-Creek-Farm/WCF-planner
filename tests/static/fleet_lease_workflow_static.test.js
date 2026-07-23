import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Per-project lease workflow — static contract lock (mirrors the legacy
// test-db-lease.yml guarantees). It must stay inert and per-project, and the
// legacy global lease must remain present (not removed before cutover).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const wf = read('.github/workflows/test-db-lease-project.yml');

describe('test-db-lease-project.yml contract', () => {
  it('is workflow_dispatch-only', () => {
    expect(wf).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s*push:/m);
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    expect(wf).not.toMatch(/^\s*schedule:/m);
  });

  it('uses a PER-PROJECT concurrency group derived from a fixed choice, no cancel-in-progress', () => {
    expect(wf).toMatch(/group: wcf-test-db-\$\{\{ inputs\.project \}\}/);
    expect(wf).toMatch(/cancel-in-progress: false/);
    expect(wf).toMatch(/type: choice/);
    expect(wf).toMatch(/options: \[a, b, c, d, main\]/);
  });

  it('requires project + lease_id inputs and echoes both in run-name', () => {
    expect(wf).toMatch(/project:[\s\S]*?required: true/);
    expect(wf).toMatch(/lease_id:[\s\S]*?required: true/);
    expect(wf).toMatch(/^run-name: TEST DB lease \$\{\{ inputs\.project \}\} \$\{\{ inputs\.lease_id \}\}$/m);
  });

  it('declares zero permissions and a bounded timeout', () => {
    expect(wf).toMatch(/^permissions: \{\}$/m);
    expect(wf).toMatch(/timeout-minutes: \d+/);
  });

  it('stays inert: no checkout, install, secrets, DB, or repo mutation', () => {
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
      expect(wf, `must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('only interpolates ${{ }} on run-name/env/comment lines, never in the shell body', () => {
    for (const line of wf.split('\n').filter((l) => l.includes('${{'))) {
      expect(line.trim(), `unexpected \${{ }}: "${line.trim()}"`).toMatch(
        /^(#|run-name:|group:|PROJECT:|LEASE_ID:|HOLD_MINUTES:|project:|lease_id:|hold_minutes:)/,
      );
    }
  });

  it('does NOT remove the legacy global lease (both workflows coexist pre-cutover)', () => {
    expect(fs.existsSync(path.join(ROOT, '.github/workflows/test-db-lease.yml'))).toBe(true);
  });
});
