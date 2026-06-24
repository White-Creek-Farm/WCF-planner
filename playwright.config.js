import {defineConfig, devices} from '@playwright/test';
import {loadEnv} from 'vite';

// Load .env.test + .env.test.local into process.env so Node-side fixtures
// (tests/setup/reset.js, global.setup.js) see VITE_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, WCF_TEST_DATABASE, etc. The webServer (vite
// dev server) loads them itself via --mode test; this is for the runner
// process. Empty prefix = load every env var, not just VITE_*.
const env = loadEnv('test', process.cwd(), '');
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

// ============================================================================
// Playwright config — Phase A2 scaffolding.
// ============================================================================
// Backend: separate Supabase test project (Phase A1, manual). VITE_SUPABASE_URL
// + VITE_SUPABASE_ANON_KEY load from .env.test (committable safe values) and
// .env.test.local (service role key + admin password — gitignored). The
// dev:test npm script runs `vite --mode test` so Vite picks both up.
//
// Codex-mandated safety: every fixture / reset helper calls assertTestDatabase
// (tests/setup/assertTestDatabase.js) which refuses to run unless
// WCF_TEST_DATABASE=1 AND URL doesn't match the prod project ref.
//
// CI deferred (was Phase A9). Local-only for now.
// ============================================================================

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.js'],
  // Pasture Map browser specs run in their OWN focused lane via
  // playwright.pasture.config.js (CI: pasture-e2e.yml, path-gated). Exclude them
  // from the root verify e2e so it stays fast and never double-runs them.
  testIgnore: ['**/pasture_map_*.spec.js'],
  // Specs share the test database via a global truncate-and-reseed strategy.
  // Parallel + sharded specs would race the reset. Keep workers=1 until we
  // adopt a per-worker schema isolation pattern (out of scope for A2).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.js/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/admin.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev:test',
    url: 'http://localhost:5173',
    // Codex-mandated for A2: never reuse. A reused PROD-mode dev server on
    // 5173 (e.g. left running from `npm run dev`) would silently serve the
    // app pointed at production Supabase and the smoke spec would fail with
    // "Invalid credentials" instead of a loud "wrong backend" error.
    // dev:test now uses --strictPort so a port conflict fails fast instead
    // of falling back to 5174.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
