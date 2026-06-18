// Pasture Map CP1 — ISOLATED Playwright config. Runs on a NON-5173 port and a
// single spec that NEVER calls resetTestDatabase, so it cannot collide with the
// active Home-parity lane (different port; only the isolated pasture tables are
// touched). Reuses the shared global.setup.js admin auth (read-only on profiles).
import {defineConfig, devices} from '@playwright/test';
import {loadEnv} from 'vite';

const env = loadEnv('test', process.cwd(), '');
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: [
    '**/pasture_map_p2_map.spec.js',
    '**/pasture_map_setup.spec.js',
    '**/pasture_map_import.spec.js',
    '**/pasture_map_cp2.spec.js',
    '**/pasture_map_cp3.spec.js',
    '**/pasture_map_cp4.spec.js',
    '**/pasture_map_cp5.spec.js',
    '**/pasture_map_cp6.spec.js',
    '**/pasture_map_cp7.spec.js',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {name: 'setup', testMatch: /global\.setup\.js/},
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome'], storageState: 'tests/.auth/admin.json'},
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: `vite --mode=test --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
