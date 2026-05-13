import {test, expect} from './fixtures.js';

// ============================================================================
// Route-wide mobile audit spec
// ============================================================================
// Phase 2 of the mobile UX hardening lane. Covers every route listed in
// PROJECT.md at 390x844 (iPhone 13/14 portrait) and a subset at 430x932
// (iPhone 14 Plus) for visual comparison. Two assertions per route:
//   1. No page-level horizontal overflow (documentElement / body
//      scrollWidth ≤ clientWidth + 1px tolerance).
//   2. No visible element escapes the viewport right edge by more than
//      a small tolerance. Containers that legitimately scroll horizontally
//      (data-mobile-hscroll, data-header-subnav) and their descendants
//      are allowlisted.
//
// Screenshots are captured to test-results/mobile-audit/ for manual review.
// Adjacent specs reset the test DB; this one is observational and seeds
// nothing, so it runs against whatever the global setup left behind.
// ============================================================================

const MOBILE_PORTRAIT = {width: 390, height: 844};
const MOBILE_LARGE = {width: 430, height: 932};

const AUTH_ROUTES = [
  {path: '/', slug: 'home'},
  {path: '/broiler', slug: 'broiler'},
  {path: '/broiler/timeline', slug: 'broiler-timeline'},
  {path: '/broiler/batches', slug: 'broiler-batches'},
  {path: '/broiler/feed', slug: 'broiler-feed'},
  {path: '/broiler/dailys', slug: 'broiler-dailys'},
  {path: '/broiler/weighins', slug: 'broiler-weighins'},
  {path: '/pig', slug: 'pig'},
  {path: '/pig/breeding', slug: 'pig-breeding'},
  {path: '/pig/farrowing', slug: 'pig-farrowing'},
  {path: '/pig/sows', slug: 'pig-sows'},
  {path: '/pig/batches', slug: 'pig-batches'},
  {path: '/pig/feed', slug: 'pig-feed'},
  {path: '/pig/dailys', slug: 'pig-dailys'},
  {path: '/pig/weighins', slug: 'pig-weighins'},
  {path: '/layer', slug: 'layer'},
  {path: '/layer/groups', slug: 'layer-groups'},
  {path: '/layer/batches', slug: 'layer-batches'},
  {path: '/layer/dailys', slug: 'layer-dailys'},
  {path: '/layer/eggs', slug: 'layer-eggs'},
  {path: '/cattle', slug: 'cattle'},
  {path: '/cattle/herds', slug: 'cattle-herds'},
  {path: '/cattle/forecast', slug: 'cattle-forecast'},
  {path: '/cattle/breeding', slug: 'cattle-breeding'},
  {path: '/cattle/batches', slug: 'cattle-batches'},
  {path: '/cattle/dailys', slug: 'cattle-dailys'},
  {path: '/cattle/weighins', slug: 'cattle-weighins'},
  {path: '/sheep', slug: 'sheep'},
  {path: '/sheep/flocks', slug: 'sheep-flocks'},
  {path: '/sheep/batches', slug: 'sheep-batches'},
  {path: '/sheep/dailys', slug: 'sheep-dailys'},
  {path: '/sheep/weighins', slug: 'sheep-weighins'},
  {path: '/fleet', slug: 'fleet'},
  {path: '/fleet/fuel-log', slug: 'fleet-fuel-log'},
  {path: '/fleet/materials', slug: 'fleet-materials'},
  {path: '/admin', slug: 'admin'},
  {path: '/tasks', slug: 'tasks'},
];

const PUBLIC_ROUTES = [
  {path: '/dailys', slug: 'dailys-hub'},
  {path: '/dailys/broiler', slug: 'dailys-broiler'},
  {path: '/dailys/layer', slug: 'dailys-layer'},
  {path: '/dailys/pig', slug: 'dailys-pig'},
  {path: '/dailys/cattle', slug: 'dailys-cattle'},
  {path: '/dailys/egg', slug: 'dailys-egg'},
  {path: '/dailys/sheep', slug: 'dailys-sheep'},
  {path: '/dailys/tasks', slug: 'dailys-tasks'},
  {path: '/addfeed', slug: 'addfeed'},
  {path: '/weighins', slug: 'weighins'},
  {path: '/equipment', slug: 'equipment'},
  {path: '/equipment/supply', slug: 'equipment-supply'},
  {path: '/webform-pigs', slug: 'webform-pigs'},
  {path: '/fuel-supply', slug: 'fuel-supply'},
];

async function waitForRoute(page, isAuth) {
  // Boot loader is the same gate other specs use.
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  if (isAuth) {
    // Authenticated routes always paint the dark header bar.
    await expect(page.locator('[data-header-bar="1"]')).toBeVisible({timeout: 15_000});
  }
  // networkidle catches Supabase round-trips that hydrate list bodies
  // before we measure layout. Soft-fail because some pages don't quiesce.
  await page.waitForLoadState('networkidle', {timeout: 10_000}).catch(() => {});
}

async function pageOverflow(page) {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const widest = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    return {scrollWidth: widest, clientWidth: root.clientWidth, overflow: widest - root.clientWidth};
  });
}

async function escapingElements(page) {
  return await page.evaluate(() => {
    const vw = window.innerWidth;
    const tolerance = 2;
    // An element doesn't count as "escaping" if any ancestor is
    // scrollable horizontally — that ancestor contains the overflow
    // and the user reads it via local scroll. Recognizes both the
    // data-* hooks this lane added and any ancestor with
    // overflowX:auto/scroll set inline or by class.
    function inScrollableAncestor(el) {
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (cur.getAttribute('data-mobile-hscroll') === '1') return true;
        if (cur.getAttribute('data-header-subnav') === '1') return true;
        const s = window.getComputedStyle(cur);
        if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true;
        cur = cur.parentElement;
      }
      return false;
    }
    const offenders = [];
    const all = document.body.querySelectorAll('*');
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + tolerance) {
        // Only the scrollable-ancestor allowlist is permitted to suppress
        // an offender — width-based skips accidentally hide the exact
        // small clipped badges/buttons/chips this audit is here to catch.
        if (inScrollableAncestor(el)) continue;
        offenders.push({
          tag: el.tagName.toLowerCase(),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          classes: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        });
      }
      if (offenders.length >= 8) break;
    }
    return {viewport: vw, offenders};
  });
}

function runAuditSuite(routes, isAuth, viewport, sizeLabel, strict) {
  test.describe(`mobile audit — ${sizeLabel} — ${isAuth ? 'auth' : 'public'}`, () => {
    test.use({viewport});
    for (const route of routes) {
      test(`${route.path}`, async ({page}) => {
        await page.goto(route.path);
        await waitForRoute(page, isAuth);
        await page.screenshot({
          path: `test-results/mobile-audit/${sizeLabel}-${route.slug}.png`,
          fullPage: true,
        });
        const overflow = await pageOverflow(page);
        expect(
          overflow.overflow,
          `${route.path}: page-level horizontal overflow ${overflow.overflow}px (scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth})`,
        ).toBeLessThanOrEqual(1);
        if (strict) {
          const escapes = await escapingElements(page);
          expect(
            escapes.offenders,
            `${route.path}: ${escapes.offenders.length} element(s) extend past viewport ${escapes.viewport}px right edge — first: ${JSON.stringify(escapes.offenders[0] || null)}`,
          ).toEqual([]);
        }
      });
    }
  });
}

// Hard overflow check at 390 (strict) and 430 (loose) for screenshots.
runAuditSuite(AUTH_ROUTES, true, MOBILE_PORTRAIT, '390x844', true);
runAuditSuite(PUBLIC_ROUTES, false, MOBILE_PORTRAIT, '390x844', true);
runAuditSuite(AUTH_ROUTES, true, MOBILE_LARGE, '430x932', false);
runAuditSuite(PUBLIC_ROUTES, false, MOBILE_LARGE, '430x932', false);
