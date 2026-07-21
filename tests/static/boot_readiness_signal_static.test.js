import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Cold-boot readiness signal guard
// ============================================================================
// The static splash (#wcf-boot-loader) is removed two animation frames after
// React's first paint (src/main.jsx). That paint is often the fail-closed
// "Loading your farm data..." gate itself, so the splash clearing does NOT mean
// farm data has resolved. Specs that gated on the splash alone and then
// asserted data-dependent DOM raced the cold-boot fetch — the mechanism behind
// the rotating root-shard failures.
//
// CONTRACT: a spec file may not reference the splash selector AT ALL. Boot
// readiness comes from tests/helpers/appReady.js#waitForAppReady, which is the
// single owner allowed to combine the two signals. A prohibition is used rather
// than "must also mention waitForAppReady", because the latter passes a file
// that calls the helper once and still hand-rolls a splash-only wait elsewhere,
// and it can be evaded by a different timeout, a reformatted expect, a renamed
// page variable, or the waitForSelector/waitFor form.

const SPEC_ROOT = 'tests';
const SPLASH = '#wcf-boot-loader';
const HELPER = path.join('tests', 'helpers', 'appReady.js');

// Files allowed to reference the splash directly, each for a reason that is NOT
// "wait for the app to be ready before asserting data-dependent DOM".
// Keys are paths relative to tests/, POSIX-separated.
const ALLOWED = new Map([
  // Asserts the splash-clearing behavior itself; makes no data-dependent
  // assertion afterwards.
  ['smoke.spec.js', 'asserts the boot splash fades — the splash IS the subject'],
  // Public-bypass product assertion + a screenshot-capture helper.
  ['newsletter_public.spec.js', 'public bypass clears the splash (product assertion) + screenshot helper'],
  // Local capture utilities; excluded from root CI runs by playwright.config.js
  // testIgnore, so they are not part of the regression floor.
  ['ux_audit.spec.js', 'local capture utility, testIgnore-d from root runs'],
  ['broiler_batches_redesign_screenshots.spec.js', 'local capture utility, testIgnore-d from root runs'],
  ['cattle_sheep_columns_screenshots.spec.js', 'local capture utility, testIgnore-d from root runs'],
  ['daily_redesign_screenshots.spec.js', 'local capture utility, testIgnore-d from root runs'],
]);

// Strip comments before scanning: the contract prohibits CODE references to the
// splash, not documentation about it. tests/helpers/pigReady.js, for example,
// explains in prose that it replaced a splash-only wait for exactly this
// reason — that comment is desirable and must not trip the guard.
// The `[^:]` lookbehind keeps `https://…` inside string literals intact.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// playwright.config.js uses testDir './tests' with testMatch '**/*.spec.js', so
// a nested spec directory WOULD be collected even though none exists today.
// Walk recursively rather than trusting the flat layout to stay flat.
function collectSpecs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.auth') continue;
      out.push(...collectSpecs(full));
    } else if (entry.name.endsWith('.spec.js')) {
      out.push(path.relative(SPEC_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

const specFiles = collectSpecs(SPEC_ROOT);
const read = (rel) => codeOnly(readFileSync(path.join(SPEC_ROOT, rel), 'utf8'));

describe('cold-boot readiness signal', () => {
  it('collects the spec inventory the Playwright config would collect', () => {
    // Sanity: the walk found real specs. A silent empty inventory would make
    // every prohibition below vacuously true.
    expect(specFiles.length).toBeGreaterThan(50);
    expect(specFiles).toContain('smoke.spec.js');
  });

  it('exposes one shared helper that waits for both boot signals', () => {
    const helper = readFileSync(HELPER, 'utf8');
    expect(helper).toContain('export async function waitForAppReady');
    expect(helper).toContain(SPLASH);
    expect(helper).toContain('[data-farm-data-loading]');
  });

  it('keeps the farm-data gate marker the app actually publishes', () => {
    expect(readFileSync(path.join('src', 'main.jsx'), 'utf8')).toContain('data-farm-data-loading');
  });

  it('forbids every non-allowlisted spec from referencing the boot splash at all', () => {
    const offenders = specFiles.filter((rel) => !ALLOWED.has(rel) && read(rel).includes(SPLASH));
    expect(offenders).toEqual([]);
  });

  it('keeps appReady.js the only test helper that touches the splash', () => {
    const helperDir = path.join(SPEC_ROOT, 'helpers');
    const offenders = readdirSync(helperDir)
      .filter((f) => f.endsWith('.js') && path.join(helperDir, f) !== HELPER)
      .filter((f) => codeOnly(readFileSync(path.join(helperDir, f), 'utf8')).includes(SPLASH));
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — no stale entries', () => {
    // A stale entry silently re-opens the door for that file. If a file stopped
    // referencing the splash, drop it from ALLOWED.
    const stale = [...ALLOWED.keys()].filter((rel) => !specFiles.includes(rel) || !read(rel).includes(SPLASH));
    expect(stale).toEqual([]);
  });
});
