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

  it('reserves both full shards for full mode and keeps them serial', () => {
    expect(workflow).toMatch(/e2e-shard-1:[\s\S]*?mode == 'full'/);
    expect(workflow).toMatch(/e2e-shard-2:[\s\S]*?needs: \[changes, e2e-shard-1\]/);
    expect(workflow).toContain('npm run test:e2e:ci -- --shard=1/2');
    expect(workflow).toContain('npm run test:e2e:ci -- --shard=2/2');
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

  it('keeps TEST serialized and the Pasture suite separately path-gated', () => {
    expect(workflow).toContain('group: wcf-test-db');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("needs.changes.outputs.pasture == 'true'");
    expect(workflow).toContain('playwright.pasture.config.js');
  });

  it('provides one stable fail-closed policy gate across skipped jobs', () => {
    expect(workflow).toContain('e2e-policy-gate:');
    expect(workflow).toContain('Unknown or empty mode; failing closed');
    expect(workflow).toContain('test "$SHARD1_RESULT" = "success"');
    expect(workflow).toContain('test "$FOCUSED_RESULT" = "success"');
  });
});
