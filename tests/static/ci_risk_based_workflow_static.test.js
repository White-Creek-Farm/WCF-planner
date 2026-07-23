import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const planner = readFileSync('scripts/ci_playwright_plan.cjs', 'utf8');

describe('risk-based Playwright CI workflow', () => {
  it('classifies every run before selecting browser work', () => {
    expect(workflow).toContain('node scripts/ci_playwright_plan.cjs');
    expect(workflow).toContain('mode: ${{ steps.plan.outputs.mode }}');
    expect(workflow).toContain('specs_json: ${{ steps.plan.outputs.specs_json }}');
  });

  it('runs focused coverage only for focused mode', () => {
    expect(workflow).toContain('focused-e2e:');
    expect(workflow).toContain("needs.changes.outputs.mode == 'focused'");
    expect(workflow).toContain('npm run test:e2e:ci -- "${SPECS[@]}"');
    expect(workflow).toContain('refusing unsafe empty run');
  });

  it('runs both full shards for full mode as concurrent per-project matrix legs (A/B)', () => {
    // The isolated fleet replaced the serial shard-1 -> shard-2 chain with a
    // matrix e2e-full job: shard 1 on TEST A, shard 2 on TEST B, CONCURRENTLY
    // (different projects, no shared DB, fail-fast:false).
    expect(workflow).toMatch(/e2e-full:[\s\S]*?mode == 'full'/);
    expect(workflow).toContain('--shard=${{ matrix.shard }}/2');
    expect(workflow).toMatch(/shard: 1[\s\S]*?project: a/);
    expect(workflow).toMatch(/shard: 2[\s\S]*?project: b/);
    expect(workflow).toContain('fail-fast: false');
  });

  it('runs full coverage nightly and by explicit manual or label request', () => {
    expect(workflow).toContain("cron: '17 8 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(planner).toContain("event === 'schedule'");
    expect(planner).toContain("'full-e2e'");
    expect(planner).toContain("'high-risk'");
  });

  it('does not repeat browser work after the already-tested PR combined head merges', () => {
    expect(workflow).toContain("startsWith(github.event.head_commit.message, 'Merge pull request #')");
    expect(workflow).toContain('--trusted-pr-merge "$TRUSTED_PR_MERGE"');
    expect(planner).toContain("event === 'push' && trustedPrMerge");
  });

  it('serializes each project via per-project concurrency and keeps the Pasture suite path-gated', () => {
    // Per-project groups (wcf-test-db-<project>) replace the single shared group;
    // queue (not cancel) semantics preserved.
    expect(workflow).toContain('group: wcf-test-db-');
    expect(workflow).not.toMatch(/group: wcf-test-db(\s|$)/m);
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("needs.changes.outputs.pasture == 'true'");
    expect(workflow).toContain('playwright.pasture.config.js');
  });

  it('provides one stable fail-closed policy gate across skipped jobs', () => {
    expect(workflow).toContain('e2e-policy-gate:');
    expect(workflow).toContain('Unknown or empty mode; failing closed');
    expect(workflow).toContain('test "$FULL_RESULT" = "success"');
    expect(workflow).toContain('test "$FOCUSED_RESULT" = "success"');
  });
});
