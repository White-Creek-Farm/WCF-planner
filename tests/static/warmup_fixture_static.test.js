import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Cold-start warm-up fixture contract
// ============================================================================
// Playwright guarantees a {scope:'worker', auto:true} fixture runs exactly once
// per worker, so asserting that configuration IS asserting the once-per-worker
// behavior. These guards lock the rest of the contract Codex specified.

const fixtures = readFileSync('tests/fixtures.js', 'utf8');
// The warm-up fixture body, from its key to the end of its options tuple, with
// comments stripped — the block's own comments describe the safety properties
// ("logged out — no storageState"), which must not trip the code-only guards.
const warmupRaw = fixtures.slice(fixtures.indexOf('_coldStartWarmUp:'), fixtures.indexOf('Navigation readiness'));
const warmup = warmupRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('warm-up fixture scope + timeout contract', () => {
  it('is worker-scoped and automatic (runs once per worker, not per test/file)', () => {
    expect(warmup).toContain("scope: 'worker'");
    expect(warmup).toContain('auto: true');
  });
  it('has its OWN 60s fixture timeout', () => {
    expect(warmup).toContain('timeout: 60_000');
  });
  it('does not raise the ordinary test/action/navigation budgets', () => {
    // playwright.config.js keeps the default 30s test timeout (no `timeout:`
    // at defineConfig top level) and the existing action/navigation timeouts.
    const cfg = readFileSync('playwright.config.js', 'utf8');
    // No TOP-LEVEL (2-space) test-timeout override — the default 30s stands.
    // (webServer.timeout is nested at 4-space and is unrelated.)
    expect(cfg).not.toMatch(/^ {2}timeout:\s*\d/m);
    expect(cfg).toContain('actionTimeout: 10_000');
    expect(cfg).toContain('navigationTimeout: 20_000');
  });
  it('uses the worker browser and always closes its temporary context', () => {
    expect(warmup).toMatch(/async \(\{browser\}, use\)/);
    expect(warmup).toContain('await browser.newContext()');
    expect(warmup).toContain('} finally {');
    expect(warmup).toContain('await context.close();');
  });
  it('derives the origin from a constant kept in sync with the config baseURL', () => {
    const cfg = readFileSync('playwright.config.js', 'utf8');
    // The isolated TEST fleet made baseURL a template literal
    // `http://localhost:${PW_PORT}` with PW_PORT defaulting to 5173 (CI and
    // ordinary local runs use the default; only the local per-project isolated
    // runner overrides PW_PORT). Resolve that default origin and lock
    // warmup.js's LOCAL_APP_ORIGIN to it.
    const tmpl = cfg.match(/baseURL:\s*`([^`]+)`/);
    expect(tmpl).toBeTruthy();
    const portDefault = cfg.match(/PW_PORT\s*=\s*process\.env\.PW_PORT\s*\|\|\s*'(\d+)'/);
    expect(portDefault).toBeTruthy();
    const resolved = tmpl[1].replace(/\$\{PW_PORT\}/g, portDefault[1]);
    // LOCAL_APP_ORIGIN in warmup.js must equal the config's default baseURL.
    const warmupSrc = readFileSync('tests/setup/warmup.js', 'utf8');
    expect(warmupSrc).toContain(`export const LOCAL_APP_ORIGIN = '${resolved}'`);
  });
});

describe('warm-up fixture safety', () => {
  it('refuses a non-local origin before doing anything', () => {
    expect(warmup).toMatch(/assertLocalTestOrigin\(LOCAL_APP_ORIGIN\)/);
  });
  it('is logged out and performs no data mutation', () => {
    // No storageState (logged out), no reset/seed/mutation/upload of any kind.
    expect(warmup).not.toContain('storageState');
    expect(warmup).not.toContain('resetTestDatabase');
    expect(warmup).not.toMatch(/\.upsert\(|\.insert\(|\.update\(|\.delete\(/);
    expect(warmup).not.toMatch(/\.upload\(|storage\./);
    expect(warmup).not.toMatch(/seed[A-Z]/);
  });
  it('warms IndexedDB with the throwaway probe DB and writes no records', () => {
    expect(warmup).toContain('WARMUP_PROBE_DB');
    expect(warmup).not.toContain('wcf-offline-queue');
    // open/close only — no store writes.
    expect(warmup).toContain('indexedDB.open(dbName)');
    expect(warmup).not.toMatch(/\.put\(|\.add\(|objectStore\(|createObjectStore/);
  });
  it('does not swallow a warm-up failure, retry, reload, or sleep', () => {
    // The only try/finally exists to close the context; it does not catch.
    expect(warmup).not.toContain('catch (err) {\n        req'); // (that catch rejects — see below)
    expect(warmup).not.toContain('page.reload');
    expect(warmup).not.toContain('waitForTimeout');
    expect(warmup).not.toMatch(/setTimeout\(/); // no sleep
    // The inner IDB catch REJECTS (fail visible), it does not resolve.
    expect(warmup).toMatch(/catch \(err\) \{\s*reject\(err\);/);
  });
});

describe('Pasture stays outside the canonical fixture', () => {
  it('pasture specs do not import fixtures.js (own config/import boundary)', () => {
    const pasture = readdirSync('tests').filter((f) => f.startsWith('pasture_map_') && f.endsWith('.spec.js'));
    expect(pasture.length).toBeGreaterThan(0);
    for (const f of pasture) {
      expect(readFileSync(path.join('tests', f), 'utf8')).not.toContain("from './fixtures.js'");
    }
  });
});
