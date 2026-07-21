import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Mobile layout regression spec
// ============================================================================
// Runs against the authenticated app at narrow viewport (390x844 / iPhone
// 13-14) and asserts no page-level horizontal overflow on the routes that
// the mobile stabilization lane touched. Captures screenshots for manual
// review at the standard 390x844 and the wider 430x932 (iPhone 14 Plus).
//
// Layout-only — does not exercise mutation paths or data flows, so it can
// run against whatever the global setup left in the test DB without any
// reset/seed. Adjacent specs that DO reset/seed continue to do so on their
// own beforeEach hooks; this spec is observational.
// ============================================================================

const MOBILE_VIEWPORT = {width: 390, height: 844};
const MOBILE_LARGE_VIEWPORT = {width: 430, height: 932};

const ROUTES = [
  {path: '/', slug: 'home'},
  {path: '/broiler/dailys', slug: 'broiler-dailys'},
  {path: '/pig/dailys', slug: 'pig-dailys'},
  {path: '/layer/dailys', slug: 'layer-dailys'},
  {path: '/layer/eggs', slug: 'layer-eggs'},
  {path: '/cattle/dailys', slug: 'cattle-dailys'},
  {path: '/sheep/dailys', slug: 'sheep-dailys'},
  {path: '/pig/feed', slug: 'pig-feed'},
  {path: '/broiler/feed', slug: 'broiler-feed'},
];

async function waitForBoot(page) {
  // The boot loader is the same gate other specs use (see
  // home_dashboard_equipment.spec.js). Then wait for the authenticated
  // header bar — the early data-loading "Loading…" splash does not render
  // it, so requiring it ensures we're asserting against the real app
  // chrome and not the loading screen.
  await waitForAppReady(page);
  await expect(page.locator('[data-header-bar="1"]')).toBeVisible({timeout: 15_000});
  // Give layout one more frame to settle after async data hydrates the
  // page below the header. networkidle catches the Supabase round-trips
  // that populate the daily lists / feed ledger before we measure.
  await page.waitForLoadState('networkidle', {timeout: 15_000}).catch(() => {});
}

async function pageHorizontalOverflow(page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const widest = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const visible = root.clientWidth;
    return {scrollWidth: widest, clientWidth: visible, overflow: widest - visible};
  });
}

test.describe('mobile layout — narrow viewport', () => {
  test.use({viewport: MOBILE_VIEWPORT});

  for (const route of ROUTES) {
    test(`${route.path} fits at 390x844 with no horizontal page overflow`, async ({page}) => {
      await page.goto(route.path);
      await waitForBoot(page);

      const metrics = await pageHorizontalOverflow(page);
      await page.screenshot({
        path: `test-results/mobile-layout/390x844-${route.slug}.png`,
        fullPage: true,
      });

      // 1px tolerance covers sub-pixel rounding seen on retina-scaled headless
      // Chrome. Anything beyond that means real content is forcing the page
      // wider than the viewport — which is exactly what Codex's mobile lane
      // is asserting we no longer do.
      expect(
        metrics.overflow,
        `${route.path}: page-level horizontal overflow ${metrics.overflow}px (scrollWidth ${metrics.scrollWidth} vs clientWidth ${metrics.clientWidth})`,
      ).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('mobile layout — large-phone viewport screenshots', () => {
  test.use({viewport: MOBILE_LARGE_VIEWPORT});

  for (const route of ROUTES) {
    test(`${route.path} 430x932 screenshot`, async ({page}) => {
      await page.goto(route.path);
      await waitForBoot(page);
      await page.screenshot({
        path: `test-results/mobile-layout/430x932-${route.slug}.png`,
        fullPage: true,
      });
    });
  }
});
