import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Fleet CI routing — static contract lock (mission Phase 5).
// Proves every DB-owning browser job binds to EXACTLY one project environment +
// one per-project concurrency group, the primary lane is A/B, the secondary
// manual lane is C/D, and nothing targets quarantined test-main or PROD.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ci = read('.github/workflows/ci.yml');
const secondary = read('.github/workflows/ci-secondary-full.yml');

// Split a workflow into job blocks keyed by the top-level job id.
function jobBlocks(yaml) {
  const lines = yaml.split('\n');
  const jobsIdx = lines.findIndex((l) => l === 'jobs:');
  const blocks = {};
  let cur = null;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([a-z0-9-]+):\s*$/);
    if (m) {
      cur = m[1];
      blocks[cur] = [];
    } else if (cur) {
      blocks[cur].push(lines[i]);
    }
  }
  for (const k of Object.keys(blocks)) blocks[k] = blocks[k].join('\n');
  return blocks;
}

describe('ci.yml — primary A/B lane', () => {
  it('has NO legacy workflow-level wcf-test-db concurrency group', () => {
    // No bare "group: wcf-test-db" (legacy). Per-project groups end in -a/-b/... .
    expect(ci).not.toMatch(/group: wcf-test-db(\s|$)/m);
    expect(ci).not.toMatch(/group: wcf-test-db\n/);
  });

  it('e2e-full matrix maps shard1->TEST A->test-a and shard2->TEST B->test-b', () => {
    const jobs = jobBlocks(ci);
    expect(jobs['e2e-full']).toBeTruthy();
    const full = jobs['e2e-full'];
    expect(full).toMatch(/shard: 1[\s\S]*?project: a[\s\S]*?gh_environment: test-a/);
    expect(full).toMatch(/shard: 2[\s\S]*?project: b[\s\S]*?gh_environment: test-b/);
    expect(full).toMatch(/environment: \$\{\{ matrix\.gh_environment \}\}/);
    expect(full).toMatch(/group: wcf-test-db-\$\{\{ matrix\.project \}\}/);
    expect(full).toMatch(/fail-fast: false/);
  });

  it('focused-e2e binds exactly environment test-a + concurrency wcf-test-db-a', () => {
    const f = jobBlocks(ci)['focused-e2e'];
    expect(f).toMatch(/environment: test-a/);
    expect(f).toMatch(/group: wcf-test-db-a/);
  });

  it('pasture-e2e binds exactly environment test-a + concurrency wcf-test-db-a', () => {
    const p = jobBlocks(ci)['pasture-e2e'];
    expect(p).toMatch(/environment: test-a/);
    expect(p).toMatch(/group: wcf-test-db-a/);
  });

  it('verify job is DB-free: no secrets, no environment, no concurrency', () => {
    const v = jobBlocks(ci)['verify'];
    expect(v).not.toContain('secrets.');
    expect(v).not.toMatch(/^\s*environment:/m);
    expect(v).not.toMatch(/^\s*concurrency:/m);
  });

  it('every DB-owning job (has SUPABASE_SERVICE_ROLE_KEY) binds one environment + one concurrency group', () => {
    const jobs = jobBlocks(ci);
    for (const [id, body] of Object.entries(jobs)) {
      if (!body.includes('SUPABASE_SERVICE_ROLE_KEY')) continue;
      expect(body, `${id} must bind an environment`).toMatch(/environment:/);
      expect(body, `${id} must bind a concurrency group`).toMatch(/group: wcf-test-db-/);
    }
  });
});

describe('ci-secondary-full.yml — secondary manual C/D lane', () => {
  it('is workflow_dispatch only (never auto on push/PR/schedule)', () => {
    expect(secondary).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(secondary).not.toMatch(/^\s*push:/m);
    expect(secondary).not.toMatch(/^\s*pull_request:/m);
    expect(secondary).not.toMatch(/^\s*schedule:/m);
  });

  it('e2e-full matrix maps shard1->TEST C->test-c and shard2->TEST D->test-d', () => {
    const full = jobBlocks(secondary)['e2e-full'];
    expect(full).toMatch(/shard: 1[\s\S]*?project: c[\s\S]*?gh_environment: test-c/);
    expect(full).toMatch(/shard: 2[\s\S]*?project: d[\s\S]*?gh_environment: test-d/);
    expect(full).toMatch(/group: wcf-test-db-\$\{\{ matrix\.project \}\}/);
  });
});

describe('quarantine + PROD containment in CI', () => {
  it('no CI workflow references a test-main environment or wcf-test-db-main lease', () => {
    for (const [name, y] of [
      ['ci.yml', ci],
      ['ci-secondary-full.yml', secondary],
    ]) {
      expect(y, `${name} must not use test-main env`).not.toMatch(/environment: test-main/);
      expect(y, `${name} must not use wcf-test-db-main`).not.toContain('wcf-test-db-main');
    }
  });

  it('no CI workflow references the PROD project ref', () => {
    expect(ci).not.toContain('pzfujbjtayhkdlxiblwe');
    expect(secondary).not.toContain('pzfujbjtayhkdlxiblwe');
  });

  it('the four projects a/b/c/d are covered by the matrix lanes, all via wcf-test-db-<project>', () => {
    // Concurrency is always derived from the project (matrix) or a literal
    // per-project group; never a bare shared group.
    for (const y of [ci, secondary]) {
      for (const m of y.matchAll(/group: (wcf-test-db-[a-z${}. ]+)/g)) {
        expect(m[1]).toMatch(/^wcf-test-db-(a|b|c|d|\$\{\{ matrix\.project \}\})$/);
      }
    }
    // matrix project values across the two lanes cover exactly a,b,c,d
    const projects = new Set();
    for (const y of [ci, secondary]) for (const m of y.matchAll(/project: ([a-d])\b/g)) projects.add(m[1]);
    expect([...projects].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
