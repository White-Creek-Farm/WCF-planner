import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// ci-focused-project.yml — static security/contract lock.
// Proves the manually dispatched focused runner can only target one isolated
// TEST project via a FIXED choice, derives its Environment + concurrency group
// from that choice, never interpolates operator input into a shell, delegates
// specs_json validation to the fail-closed helper, runs workers=1, is
// read-only, and never references PROD / quarantined test-main.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const wf = read('.github/workflows/ci-focused-project.yml');
const PROD_REF = 'pzfujbjtayhkdlxiblwe'; // scripts/fleet/projects.cjs PROD_PROJECT_REF

// Extract the shell body of every `run:` step (inline + block scalar), so we
// can prove NO GitHub ${{ }} expression is interpolated into a shell command
// (the script-injection property). with:/env:/name: lines are NOT shell.
function runShellBodies(yaml) {
  const lines = yaml.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run: (\|?)(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2] !== '|') {
      bodies.push(m[3]); // inline `run: <cmd>`
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') {
        body.push('');
        continue;
      }
      const lead = lines[j].match(/^(\s*)/)[1].length;
      if (lead <= indent) break;
      body.push(lines[j]);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

describe('ci-focused-project.yml — trigger + inputs', () => {
  it('is workflow_dispatch only (never push/PR/schedule)', () => {
    expect(wf).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s*push:/m);
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    expect(wf).not.toMatch(/^\s*schedule:/m);
  });

  it('project is a REQUIRED fixed choice of exactly a, b, c, d', () => {
    expect(wf).toMatch(/project:[\s\S]*?required: true/);
    expect(wf).toMatch(/project:[\s\S]*?type: choice/);
    expect(wf).toMatch(/options: \[a, b, c, d\]/);
    // No main / test-main / PROD / arbitrary project option.
    expect(wf).not.toMatch(/options: \[[^\]]*\bmain\b[^\]]*\]/);
  });

  it('specs_json is a required string input', () => {
    expect(wf).toMatch(/specs_json:[\s\S]*?required: true/);
    expect(wf).toMatch(/specs_json:[\s\S]*?type: string/);
  });

  it('has NO ref input (checkout uses the dispatched github.ref exactly)', () => {
    expect(wf).not.toMatch(/^\s+ref:/m);
    // The checkout step does not pin/override a ref.
    expect(wf).not.toMatch(/uses: actions\/checkout@v4[\s\S]*?with:[\s\S]*?ref:/);
  });
});

describe('ci-focused-project.yml — Environment + concurrency mapping', () => {
  it('binds the Environment DERIVED from the fixed project choice', () => {
    expect(wf).toMatch(/environment: test-\$\{\{ inputs\.project \}\}/);
    // Never a literal/quarantined/PROD environment.
    expect(wf).not.toMatch(/environment: test-main/);
    expect(wf).not.toMatch(/environment: (test-a|test-b|test-c|test-d)\s*$/m);
  });

  it('uses the per-project concurrency group derived from the same choice, no cancel', () => {
    expect(wf).toMatch(/group: wcf-test-db-\$\{\{ inputs\.project \}\}/);
    expect(wf).toMatch(/cancel-in-progress: false/);
    expect(wf).not.toContain('wcf-test-db-main');
    // No bare/legacy shared group.
    expect(wf).not.toMatch(/group: wcf-test-db(\s|$)/m);
  });
});

describe('ci-focused-project.yml — permissions + secrets', () => {
  it('is read-only (contents: read, no write scopes)', () => {
    expect(wf).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
    expect(wf).not.toContain('contents: write');
    expect(wf).not.toContain('id-token:');
    expect(wf).not.toContain('packages:');
    expect(wf).not.toContain('pull-requests: write');
  });

  it('binds exactly the five project TEST secrets already used by CI', () => {
    for (const secret of [
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'VITE_TEST_ADMIN_EMAIL',
      'VITE_TEST_ADMIN_PASSWORD',
    ]) {
      expect(wf, `must bind ${secret}`).toMatch(new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`));
    }
    expect(wf).toMatch(/WCF_TEST_DATABASE: '1'/);
  });

  it('never ROUTES to PROD or quarantined test-main (routing tokens, not comments)', () => {
    expect(wf).not.toContain(PROD_REF);
    expect(wf).not.toMatch(/environment: test-main/);
    expect(wf).not.toContain('wcf-test-db-main');
    // 'main' is not an allowed project choice.
    expect(wf).not.toMatch(/options:.*\bmain\b/);
  });
});

describe('ci-focused-project.yml — injection-safe spec handling', () => {
  it('passes specs_json to the validator ONLY through env, never a shell arg', () => {
    expect(wf).toMatch(/SPECS_JSON: \$\{\{ inputs\.specs_json \}\}/);
    expect(wf).toContain('node scripts/ci_focused_specs.cjs --out validated-specs.txt');
  });

  it('never interpolates any ${{ }} expression into a run: shell body', () => {
    for (const body of runShellBodies(wf)) {
      expect(body, `shell body must not contain a GitHub expression: ${body}`).not.toContain('${{');
    }
  });

  it('specifically never puts operator inputs (project/specs_json) in a shell body', () => {
    for (const body of runShellBodies(wf)) {
      expect(body).not.toContain('inputs.specs_json');
      expect(body).not.toContain('inputs.project');
    }
  });

  it('runs Playwright from the VALIDATED file with workers=1 (serialized reset)', () => {
    expect(wf).toContain('mapfile -t SPECS < validated-specs.txt');
    expect(wf).toContain('refusing unsafe empty run');
    expect(wf).toContain('npm run test:e2e:ci -- --workers=1 "${SPECS[@]}"');
  });

  it('validates BEFORE npm ci / browser install / any DB reset', () => {
    const validateIdx = wf.indexOf('node scripts/ci_focused_specs.cjs');
    const installIdx = wf.indexOf('run: npm ci');
    const playwrightIdx = wf.indexOf('npm run test:e2e:ci');
    expect(validateIdx).toBeGreaterThan(0);
    expect(validateIdx).toBeLessThan(installIdx);
    expect(validateIdx).toBeLessThan(playwrightIdx);
  });
});

describe('ci-focused-project.yml — diagnostics', () => {
  it('uploads artifacts only on failure/cancellation with bounded retention', () => {
    expect(wf).toMatch(/if: \$\{\{ failure\(\) \|\| cancelled\(\) \}\}/);
    expect(wf).toMatch(/retention-days: \d+/);
    expect(wf).toContain('if-no-files-found: ignore');
  });
});
