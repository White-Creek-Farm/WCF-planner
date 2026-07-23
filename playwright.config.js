import {defineConfig, devices} from '@playwright/test';
import {loadEnv} from 'vite';

// Load .env.test + .env.test.local into process.env so Node-side fixtures
// (tests/setup/reset.js, global.setup.js) see VITE_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, WCF_TEST_DATABASE, etc. The webServer (vite
// dev server) loads them itself via --mode test; this is for the runner
// process. Empty prefix = load every env var, not just VITE_*.
//
// PW_ENVDIR / PW_PORT are OPTIONAL overrides used only by the local isolated
// fleet browser pilots (scripts/fleet) to run several projects concurrently on
// different ports with per-project env dirs. Unset (CI, ordinary local runs) =>
// identical behavior to before: envDir = cwd, port 5173, webServer =
// `npm run dev:test`. process.env still wins over file values.
const PW_ENVDIR = process.env.PW_ENVDIR || process.cwd();
const PW_PORT = process.env.PW_PORT || '5173';
const PW_CUSTOM = !!(process.env.PW_ENVDIR || process.env.PW_PORT);
const env = loadEnv('test', PW_ENVDIR, '');
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const cliArgs = process.argv.slice(2);
const hasExplicitSpecArg = cliArgs.some((arg) => {
  const normalized = arg.replaceAll('\\', '/');
  return normalized.endsWith('.spec.js') || normalized.startsWith('tests/') || normalized.includes('/tests/');
});

const rootRunUtilityIgnores = hasExplicitSpecArg
  ? []
  : [
      '**/audit_review_screenshots.spec.js',
      '**/broiler_batches_redesign_screenshots.spec.js',
      '**/cattle_log_screenshots.spec.js',
      '**/cattle_sheep_columns_screenshots.spec.js',
      '**/daily_redesign_screenshots.spec.js',
      '**/production_redesign_screenshots.spec.js',
      '**/todo_screenshots.spec.js',
      '**/mobile_audit.spec.js',
      '**/ux_audit.spec.js',
    ];

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
// CI: .github/workflows/ci.yml (verify quality gate + sharded root e2e jobs +
// the path-gated pasture lane).
// ============================================================================

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/*.spec.js'],
  // Pasture Map browser specs run in their OWN focused lane via
  // playwright.pasture.config.js (CI: the path-gated pasture-e2e job in
  // .github/workflows/ci.yml). Exclude them from the root e2e (CI jobs
  // e2e-shard-1 / e2e-shard-2) so it stays fast and never double-runs them.
  //
  // Screenshot packets and route-wide audit sweeps are local capture utilities,
  // not the regression floor. They are ignored only for broad root runs; passing
  // an explicit spec path still runs them for Ronnie's review packets.
  testIgnore: ['**/pasture_map_*.spec.js', ...rootRunUtilityIgnores],
  // Specs share the test database via a global truncate-and-reseed strategy.
  // Parallel + sharded specs would race the reset. Keep workers=1 until we
  // adopt a per-worker schema isolation pattern (out of scope for A2).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: `http://localhost:${PW_PORT}`,
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
        storageState: process.env.PW_STORAGE || 'tests/.auth/admin.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    // CI + ordinary local runs: unchanged (`npm run dev:test`). Fleet pilots
    // set PW_PORT to run vite on a per-project port; the per-project backend
    // creds arrive via process.env.VITE_SUPABASE_URL/ANON_KEY, which vite's
    // loadEnv overlays on top of the root .env.test with priority (verified in
    // node_modules/vite loadEnv: it loops process.env for VITE_* last). So no
    // --envDir is needed (and vite's CLI has no such flag). PW_ENVDIR only
    // scopes the RUNNER-side loadEnv (below) to an isolated dir per pilot.
    command: PW_CUSTOM ? `npx vite --mode=test --host 127.0.0.1 --port ${PW_PORT} --strictPort` : 'npm run dev:test',
    url: `http://localhost:${PW_PORT}`,
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
