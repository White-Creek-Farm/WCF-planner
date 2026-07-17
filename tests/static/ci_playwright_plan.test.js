import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

const require = createRequire(import.meta.url);
const {planPlaywright} = require('../../scripts/ci_playwright_plan.cjs');

const plan = (files, options = {}) => planPlaywright({files, rootDir: process.cwd(), ...options});

describe('risk-based Playwright planner', () => {
  it('skips browser work for docs and static/unit-only changes', () => {
    expect(plan(['PROJECT.md']).mode).toBe('none');
    expect(plan(['tests/static/example.test.js']).mode).toBe('none');
  });

  it('selects the exact changed root browser spec', () => {
    const result = plan(['tests/fuel_bill_pdf.spec.js']);
    expect(result.mode).toBe('focused');
    expect(result.specs).toEqual(['tests/fuel_bill_pdf.spec.js']);
  });

  it('selects focused surface coverage for a low-risk product file', () => {
    const result = plan(['src/newsletter/NewsletterPublicPage.jsx']);
    expect(result.mode).toBe('focused');
    expect(result.specs).toContain('tests/newsletter_public.spec.js');
  });

  it.each([
    'supabase-migrations/187_example.sql',
    'supabase-functions/rapid-processor.ts',
    'src/auth/AuthProvider.jsx',
    'src/main.jsx',
    'src/components/Header.jsx',
    'tests/setup/reset.js',
    '.github/workflows/ci.yml',
  ])('requires full shards for high-risk path %s', (file) => {
    expect(plan([file]).mode).toBe('full');
  });

  it('fails safe to full for an unclassified product path', () => {
    const result = plan(['src/new-surface/UnknownPage.jsx']);
    expect(result.mode).toBe('full');
    expect(result.reason).toMatch(/unclassified/);
  });

  it('routes pasture-only changes to the isolated suite', () => {
    const result = plan(['src/pasture/PastureMapPage.jsx']);
    expect(result).toMatchObject({mode: 'none', pasture: true});
  });

  it('forces full shards for nightly, manual, and labelled runs', () => {
    expect(plan(['PROJECT.md'], {event: 'schedule'}).mode).toBe('full');
    expect(plan(['PROJECT.md'], {forceFull: true}).mode).toBe('full');
    expect(plan(['PROJECT.md'], {labels: ['high-risk']}).mode).toBe('full');
    expect(plan(['PROJECT.md'], {labels: ['full-e2e']}).mode).toBe('full');
  });

  it('treats absent PR labels on push events as an empty label set', () => {
    expect(plan(['PROJECT.md'], {event: 'push', labels: null}).mode).toBe('none');
  });

  it('does not repeat browser work after GitHub merges the already-tested PR combined head', () => {
    const result = plan(['.github/workflows/ci.yml'], {
      event: 'push',
      trustedPrMerge: true,
    });
    expect(result).toMatchObject({mode: 'none', pasture: false});
    expect(result.reason).toMatch(/PR merge already evaluated/);
  });

  it('still fails direct main pushes through ordinary risk classification', () => {
    expect(plan(['.github/workflows/ci.yml'], {event: 'push'}).mode).toBe('full');
  });

  it('fails safe to full when the changed-file diff is missing', () => {
    expect(plan([])).toMatchObject({mode: 'full', pasture: true});
  });
});
