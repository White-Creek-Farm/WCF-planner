import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

test.use({storageState: {cookies: [], origins: []}});

function cachedShellFor(pathname) {
  if (pathname.startsWith('/equipment') || pathname.startsWith('/fueling')) return '/equipment.html';
  if (pathname.startsWith('/dailys') || pathname.startsWith('/webforms')) return '/dailys.html';
  if (pathname.startsWith('/pasture-map')) return '/pasture-map.html';
  return '/index.html';
}

function expectedManifestFor(pathname) {
  if (pathname.startsWith('/equipment') || pathname.startsWith('/fueling')) return '/manifest-equipment.webmanifest';
  if (pathname.startsWith('/dailys') || pathname.startsWith('/webforms')) return '/manifest-dailys.webmanifest';
  if (pathname.startsWith('/pasture-map')) return '/manifest-pasture.webmanifest';
  return '/manifest.webmanifest';
}

async function waitForServiceWorkerControl(page) {
  await page.waitForFunction(() => 'serviceWorker' in navigator, null, {timeout: 10_000});
  await page.waitForFunction(
    async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return true;

      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 10_000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          {once: true},
        );
      });
    },
    null,
    {timeout: 15_000},
  );
}

async function warmAppShell(page, pathname) {
  await page.goto(pathname);
  await waitForAppReady(page);
  await waitForServiceWorkerControl(page);

  // Reload while controlled so Vite dev modules are captured in the runtime
  // cache. Production builds get their hashed /assets bundle from install-time
  // HTML parsing, but the focused test server serves the source module graph.
  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForAppReady(page);

  const shellUrl = cachedShellFor(pathname);
  await expect
    .poll(() => page.evaluate(async (url) => Boolean(await caches.match(url)), shellUrl), {
      timeout: 10_000,
      message: `${shellUrl} should be cached after online warm-up`,
    })
    .toBe(true);
}

async function expectOfflineColdOpen(context, page, pathname) {
  await context.setOffline(true);
  try {
    await page.goto(pathname, {waitUntil: 'domcontentloaded'});
    await waitForAppReady(page);
    await expect(page.locator('[data-login-screen]')).toBeVisible({timeout: 15_000});
    await expect(page).toHaveURL(new RegExp(`${pathname}/?$`));
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', expectedManifestFor(pathname));
  } finally {
    await context.setOffline(false);
  }
}

test('daily reports icon can cold-open /dailys after one online warm-up', async ({page, context}) => {
  await warmAppShell(page, '/dailys');
  await expectOfflineColdOpen(context, page, '/dailys');
});

test('equipment icon can cold-open /equipment after one online warm-up', async ({page, context}) => {
  await warmAppShell(page, '/equipment');
  await expectOfflineColdOpen(context, page, '/equipment');
});

test('pasture-map icon can cold-open /pasture-map after one online warm-up', async ({page, context}) => {
  await warmAppShell(page, '/pasture-map');
  await expectOfflineColdOpen(context, page, '/pasture-map');
});
