import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Fixture-budget package A contract
// ============================================================================
// Package A reduced per-test setup round trips WITHOUT weakening per-test
// isolation. These guards keep that true: the scenario fixtures must still
// reset per test, the seeds must use the shared cached-identity helper (not a
// re-duplicated per-seed listUsers), and the reset must fail closed on TRUNCATE
// error (Promise.all, never allSettled).

const read = (rel) => readFileSync(path.join('tests', rel), 'utf8');

describe('per-test reset ownership preserved', () => {
  const fixtures = read('fixtures.js');

  for (const scenario of ['cattleForecastScenario', 'cattleForecastSendFlowScenario', 'animalTransferScenario']) {
    it(`${scenario} still resets the DB per test`, () => {
      // Grab the fixture body and assert it resets, and is not worker-scoped
      // (worker scope would reset once per worker, reintroducing cross-test
      // residue — the A4 decision this lane must not reverse).
      const idx = fixtures.indexOf(`${scenario}:`);
      expect(idx).toBeGreaterThan(-1);
      const body = fixtures.slice(idx, idx + 400);
      expect(body).toContain('resetTestDatabase(');
      expect(body).not.toContain("scope: 'worker'");
    });
  }
});

describe('reset concurrency fails closed', () => {
  const reset = read('setup/reset.js');
  it('uses Promise.all, not Promise.allSettled', () => {
    expect(reset).toContain('Promise.all(');
    // The API call, not the word — the safety comment says "NOT allSettled".
    expect(reset).not.toContain('Promise.allSettled');
  });
  it('still throws on TRUNCATE error', () => {
    expect(reset).toMatch(/TRUNCATE failed/);
  });
  it('TRUNCATE names only public tables', () => {
    expect(reset).toContain('public."${t}"');
    expect(reset).not.toMatch(/TRUNCATE TABLE storage\./);
  });
  it('storage sweeps fail closed — throw on error, no warn-and-tolerate masking', () => {
    expect(reset).toContain('storageCleanupError');
    expect(reset).not.toContain('console.warn');
    expect(reset).not.toContain('tolerating');
  });
});

describe('seeds use the shared cached-identity helper', () => {
  for (const seed of ['scenarios/cattle_forecast_seed.js', 'scenarios/animal_transfer_seed.js']) {
    const src = read(seed);
    it(`${seed} imports ensureTestAdminProfile and drops the local listUsers`, () => {
      expect(src).toContain("from '../setup/testAdminIdentity.js'");
      expect(src).toContain('ensureTestAdminProfile(');
      // The per-seed listUsers duplication must not come back.
      expect(src).not.toContain('auth.admin.listUsers');
    });
  }
});
