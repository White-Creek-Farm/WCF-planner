// Pasture Map pop-out tiles: the Map Animal-groups switcher and the two Reports
// lists (Areas, Animal groups) are shared .hoverable-tile openables that POP OUT
// (lift + chevron reveal) on hover/focus like the Home tiles, and open the record
// on click / keyboard Enter. This locks the hover/focus affordance Ronnie required.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const P_ID = 'pm-tile-pasture';
const C_ID = 'pm-tile-paddock';
const MOMMA_ID = 'pm-tile-momma';
const POLY_P =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.43,30.84],[-86.43,30.85],[-86.44,30.85],[-86.44,30.84]]]}';
const POLY_C =
  '{"type":"Polygon","coordinates":[[[-86.438,30.842],[-86.434,30.842],[-86.434,30.846],[-86.438,30.846],[-86.438,30.842]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_rotations, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, parent_id, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${P_ID}', 'pasture', 'Tile Pasture', NULL, 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${C_ID}', 'paddock', 'Tile Paddock 1', '${P_ID}', 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${P_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_P}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${C_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_C}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'TILE-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${C_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed tile hover: ' + error.message);
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-legend,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Map Animal-groups tiles are openable pop-out tiles (hover chevron + keyboard open)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();

  const tile = page.locator('[data-surface="pasture-group-table"] [data-pasture-group-row="mommas"]');
  await expect(tile).toBeVisible({timeout: 20_000});
  // Shared openable affordance: hoverable-tile + role/button + keyboard tab stop.
  await expect(tile).toHaveClass(/hoverable-tile/);
  await expect(tile).toHaveAttribute('role', 'button');
  await expect(tile).toHaveAttribute('tabindex', '0');

  // Chevron is hidden at rest and revealed on hover (the pop affordance).
  const chev = tile.locator('.chev');
  expect(await chev.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await tile.hover();
  await page.waitForTimeout(420);
  expect(await chev.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  // Keyboard open: focus the tile and press Enter -> the group record opens.
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pasture-group-move="mommas"]')).toBeVisible({timeout: 15_000});
});

test('Reports Areas + Animal-groups render as openable pop-out tiles', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();

  // Areas table -> tiles
  const areaTile = page.locator(`[data-surface="pasture-report-area-table"] [data-pasture-report-area-row="${C_ID}"]`);
  await expect(areaTile).toBeVisible({timeout: 20_000});
  await expect(areaTile).toHaveClass(/hoverable-tile/);
  await expect(areaTile).toHaveAttribute('role', 'button');
  const areaChev = areaTile.locator('.chev');
  await areaTile.hover();
  await page.waitForTimeout(420);
  expect(await areaChev.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  // Animal groups table -> tiles
  const grpTile = page.locator('[data-surface="pasture-report-group-table"] [data-pasture-report-group-row="mommas"]');
  await expect(grpTile).toBeVisible({timeout: 15_000});
  await expect(grpTile).toHaveClass(/hoverable-tile/);
  await expect(grpTile).toHaveAttribute('role', 'button');

  // Click an area tile -> opens the per-area record (with the inline name editor).
  await areaTile.click();
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-area-name-edit]').first()).toBeVisible();
});
