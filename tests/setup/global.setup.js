import {test as setup, expect} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {getTestAdminClient} from './reset.js';

// ============================================================================
// One-time auth setup — runs as the 'setup' project before any spec.
// Signs in as the test admin user, persists localStorage + cookies into
// tests/.auth/admin.json. The 'chromium' project uses storageState: that
// file so authenticated specs skip the login UI.
//
// Selectors target LoginScreen.jsx — labels lack `for=` attributes so we use
// placeholder + role queries.
// ============================================================================

const authDir = path.resolve('tests/.auth');
const authFile = path.join(authDir, 'admin.json');

setup('authenticate as admin', async ({page}) => {
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, {recursive: true});

  const email = process.env.VITE_TEST_ADMIN_EMAIL;
  const password = process.env.VITE_TEST_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'global.setup: VITE_TEST_ADMIN_EMAIL + VITE_TEST_ADMIN_PASSWORD must ' +
        'be set in .env.test.local (gitignored). The Phase A1 setup ' +
        'instructions list both values.',
    );
  }

  // Cold-start tolerance: reuseExistingServer is false (Codex-mandated), so
  // every run boots a fresh vite server whose FIRST transform of the large
  // module graph can exceed the default 20s navigation timeout on a busy
  // machine. 90s only lengthens the failure deadline; a healthy boot is
  // unaffected.
  await page.goto('/', {timeout: 90_000});

  // Backend sentinel (Codex-mandated): assert the loaded app is actually
  // pointed at the test Supabase project before attempting login. If a
  // reused PROD dev server is serving us, this fires loudly instead of
  // letting login fail with "Invalid credentials" downstream.
  const testUrl = process.env.VITE_SUPABASE_URL || '';
  const expectedRef = testUrl.match(/https?:\/\/([^.]+)\./)?.[1];
  if (!expectedRef) {
    throw new Error('global.setup: VITE_SUPABASE_URL missing or unparseable. Check .env.test.');
  }
  const loadedUrl = await page.evaluate(() => window.__WCF_SUPABASE_URL);
  if (!loadedUrl || !loadedUrl.includes(expectedRef)) {
    throw new Error(
      `global.setup: dev server is serving the wrong backend. ` +
        `Expected URL containing "${expectedRef}" but got "${loadedUrl}". ` +
        `Likely cause: a PROD-mode \`npm run dev\` is running on port 5173. ` +
        `Kill it and re-run.`,
    );
  }

  await page.getByPlaceholder('your@email.com').first().fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', {name: /^sign in$/i}).click();

  // After successful sign-in, LoginScreen unmounts and the dashboard renders.
  // The data-login-screen marker on LoginScreen's outer container is the
  // stable readiness signal — branding-text changes won't break it.
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});

  await page.context().storageState({path: authFile});
});

// ---------------------------------------------------------------------------
// Storage harness hardening (Codex A8a review): ensure the `fuel-bills`
// bucket exists on the test project. Migration 026 also creates this via
// `INSERT ... ON CONFLICT DO NOTHING` and attaches the storage.objects
// policies, so a fresh bootstrap should already be ready. This call is
// defense-in-depth — if a developer's test project hasn't run the bootstrap
// yet, the spec fails on bucket-missing rather than on a confusing upload
// RLS error mid-test. RLS-policy gaps are NOT papered over here; if mig 026
// didn't run, uploads will still fail and surface the bootstrap problem.
// ---------------------------------------------------------------------------
setup('ensure storage buckets', async () => {
  const admin = getTestAdminClient();
  // createBucket is idempotent in practice: returns an "already exists"
  // error we can safely ignore; any other error surfaces as a test failure.
  const {error} = await admin.storage.createBucket('fuel-bills', {public: false});
  if (error && !/already exists|duplicate/i.test(error.message || '')) {
    throw new Error(`global.setup [createBucket fuel-bills]: ${error.message}`);
  }
  // daily-photos bucket — created by mig 031. READ-ONLY check, deliberately:
  // mig 031 creates the bucket AND the storage RLS policies (anon INSERT +
  // authenticated SELECT). createBucket() here would silently produce a
  // bucket WITHOUT the policies and let specs run against half-applied
  // migration state. Failing loudly on a fresh test project keeps the
  // "mig 031 is a hard gate" rule honest — Ronnie applies it via Supabase
  // SQL Editor (the DO-block + EXECUTE incompatibility means apply_test_*
  // scripts can't run it through exec_sql).
  const {data: dpBucket, error: dpErr} = await admin.storage.getBucket('daily-photos');
  if (dpErr || !dpBucket) {
    throw new Error(
      'global.setup: daily-photos bucket missing; apply migration 031 to the ' +
        'test project via Supabase SQL Editor before running daily photo specs. ' +
        (dpErr ? `(getBucket error: ${dpErr.message})` : ''),
    );
  }
});
