import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ============================================================================
// Session role resolution must FAIL CLOSED (Final Playwright closure lane).
//
// loadUser once resolved `profile?.role || 'farm_team'`: any timed-out or
// errored profile fetch silently DEMOTED admins and ELEVATED light/inactive
// users to the farm_team UI tier. Server RLS still gated writes, but the
// client rendered the wrong surface — and in CI this made admin-only
// assertions fail whenever the shared TEST DB stalled past the 5s fetch race.
// The contract now: the profile row is the only privilege source; a fetch
// that cannot produce a row throws into the fail-closed catch ('inactive' +
// home), and a row with no role resolves to 'inactive', never 'farm_team'.
// ============================================================================

describe('loadUser session role fail-closed contract', () => {
  const main = read('src/main.jsx');

  it('never assumes farm_team when the profile is missing', () => {
    expect(main).not.toMatch(/profile\?\.role \|\| 'farm_team'/);
    expect(main).not.toMatch(/\|\|\s*'farm_team'/);
  });

  it('retries the capped profile fetch and throws into the fail-closed catch', () => {
    expect(main).toMatch(/for \(let attempt = 0; attempt < 3 && !profile; attempt\+\+\)/);
    expect(main).toMatch(/if \(!profile\) throw profileFailure \|\| new Error\('profile load failed'\)/);
    // The REST error path must not be swallowed into a null-data resolve.
    expect(main).toMatch(/if \(res\.error\) throw res\.error/);
  });

  it('resolves a role-less profile row to least-privilege inactive', () => {
    expect(main).toMatch(/let resolvedRole = profile\.role \|\| 'inactive'/);
  });

  it('keeps the fail-closed catch at least-privilege inactive', () => {
    expect(main).toMatch(/setAuthState\(\{user, role: 'inactive', name: user\.email\}\)/);
  });
});
