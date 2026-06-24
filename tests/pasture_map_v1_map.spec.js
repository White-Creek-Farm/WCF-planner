// Pasture Map — V1 reset Map tab: read-only inspection.
// Desktop is hover-only (rich readout tooltip; clicking an area opens NO side
// inspector). Touch taps an area to open a read-only popover. The right panel is
// groups + a status strip that now includes Unplaced groups and Queued items.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-v1map-a';
const B_ID = 'pm-v1map-b';
const COW_ID = 'pm-v1map-cow';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches,
      public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'V1 North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'V1 South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${COW_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${COW_ID}', 'V1MAP-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 map: ' + error.message);
}

async function hideOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test.describe('desktop (hover)', () => {
  test('Map is hover-only: hover shows the readout, clicking opens no side inspector; status strip has Unplaced + Queued', async ({
    page,
  }) => {
    await page.setViewportSize({width: 1280, height: 900});
    await page.goto('/pasture-map', {timeout: 90_000});
    await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
    await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
    await hideOverlays(page);

    // Hover an area -> rich read-only readout carrying the area name.
    await page.locator(`.pm-area-${A_ID}`).first().hover();
    const tip = page.locator('.pm-area-hover-tip');
    await expect(tip).toBeVisible({timeout: 10_000});
    await expect(tip).toContainText('V1 North Paddock');

    // Desktop click is a no-op: no side inspector, no popover.
    await page.locator(`.pm-area-${A_ID}`).first().click();
    await expect(page.locator('[data-pasture-selected-panel]')).toHaveCount(0);
    await expect(page.locator('[data-pasture-map-popover]')).toHaveCount(0);

    // Right panel = groups + status strip including Unplaced + Queued.
    await expect(page.locator('[data-pasture-current-groups]')).toBeVisible();
    await expect(page.locator('[data-pasture-status-unplaced]')).toBeVisible();
    await expect(page.locator('[data-pasture-status-queued]')).toBeVisible();
  });
});

test.describe('mobile (touch)', () => {
  test.use({hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}});

  test('Map tap opens a read-only popover (no full inspector), and Clear dismisses it', async ({page}) => {
    await page.goto('/pasture-map', {timeout: 90_000});
    await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
    await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
    await hideOverlays(page);

    // Tap the area -> read-only popover over the map with the area detail.
    await page.locator(`.pm-area-${A_ID}`).first().click();
    const pop = page.locator('[data-pasture-map-popover]');
    await expect(pop).toBeVisible({timeout: 10_000});
    await expect(pop).toContainText('V1 North Paddock');
    await expect(pop.locator('[data-pasture-selected-panel]')).toBeVisible();

    // Clear dismisses the popover.
    await pop.locator('[data-pasture-clear-selection]').click();
    await expect(page.locator('[data-pasture-map-popover]')).toHaveCount(0);
  });

  test('Plan workflow is a bottom-sheet anchored to the lower viewport (touch)', async ({page}) => {
    await page.goto('/pasture-map', {timeout: 90_000});
    await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
    await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
    const panel = page.locator('.pm-side-panel');
    await expect(panel).toBeVisible({timeout: 15_000});
    // Bottom-sheet: the panel starts in the lower part of the viewport (not a
    // full-height rail starting at the top) and bottoms out at the viewport edge.
    const box = await panel.boundingBox();
    const vp = page.viewportSize();
    expect(box.y).toBeGreaterThan(vp.height * 0.25);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 2);
  });
});
