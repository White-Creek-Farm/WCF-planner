// Pasture Map P2 - Map tab: Animal Groups table rows open inline group records,
// and Area Detail designation (paddock vs temp) stays in the Area modal.
// NON-resetting: cleans only the isolated pasture tables, seeds a permanent
// paddock, a temp paddock, and one real Mommas cow (so the roster yields a
// cattle "Mommas" group), then drives the roster-backed Map UI.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-p2-a';
const T_ID = 'pm-p2-temp';
const MOMMA_ID = 'pm-p2-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_T =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function cleanAndSeed() {
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
        (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'P2 Paddock A', NULL, 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${T_ID}', 'paddock', 'P2 Temp Paddock', 'temporary', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

      PERFORM public._land_area_add_version(
        '${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version(
        '${T_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_T}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;

    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMP2-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);

    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${A_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture P2: ' + error.message);
}

test.beforeAll(async () => {
  await cleanAndSeed();
});

// Hide corner overlays that can intercept polygon clicks (legend kept until its
// own assertion runs).
async function hideClickBlockers(page) {
  await page.addStyleTag({
    content: '.pm-boundary-toggle,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}
async function clickArea(page, areaId) {
  await page.locator(`.pm-area-${areaId}`).first().click();
}

test('Map tab: group table opens inline records and area clicks open the area modal', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Tab renamed View -> Map, and it is the default active tab.
  await expect(page.locator('.pm-tabs button.is-active')).toContainText('Map');
  await expect(page.locator('[data-pasture-map-header]')).toContainText('Current groups');

  // Roster-backed Animal Groups table: Mommas is present and starts "Not placed".
  const mommaRow = page.locator('[data-pasture-group-row="mommas"]');
  await expect(mommaRow).toBeVisible({timeout: 25_000});
  await expect(mommaRow).toContainText('Mommas');
  await expect(mommaRow).toContainText('Not placed');

  await hideClickBlockers(page);

  // Hovering a group row keeps the effect on the table itself; it does not paint
  // a map preview or open a modal.
  await mommaRow.hover();
  await expect(page.locator('[data-pasture-group-history-modal]')).toHaveCount(0);
  await expect(page.locator('.pm-area-hover-tip')).toHaveCount(0);

  // Clicking the row opens the inline group record page beside the map.
  await mommaRow.click();
  await expect(page.locator('[data-pasture-group-record-details="mommas"]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-pasture-group-history-modal]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-area-modal]')).toHaveCount(0);

  // Record Mommas -> Paddock A via the inline current-area -> next-area move box.
  const card = page.locator('[data-pasture-group-move="mommas"]');
  await expect(card.locator('.pm-group-move-cell').nth(1).locator('strong')).toHaveText('P2 Paddock A');
  await card.locator('[data-pasture-move]').click();
  await page.waitForTimeout(1000);

  // On the Map, the occupied paddock shows an animal-type group marker, and the
  // legend (collapsed by default) reflects animal-type occupancy.
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});
  await page.locator('[data-pasture-legend-toggle]').click();
  await expect(page.locator('.pm-legend-body')).toContainText('Occupied - Cattle');

  // The inline record now shows the placed area.
  await expect(page.locator('[data-pasture-group-record-details="mommas"]')).toContainText('P2 Paddock A', {
    timeout: 15_000,
  });

  // Hide the legend too so it cannot block the eastern polygon, then read an area via
  // HOVER -> desktop readout.
  await page.addStyleTag({content: '.pm-control-rail{display:none!important}'});
  await page.locator(`.pm-area-${A_ID}`).first().hover();
  const tip = page.locator('.pm-area-hover-tip');
  await expect(tip).toBeVisible({timeout: 10_000});
  await expect(tip).toContainText('Paddock');
  await expect(tip).toContainText('Mommas');
  await expect(tip).toContainText('ac');
  // Clicking an area opens the Area modal (area detail + manage). Move/animal
  // placement lives in the side panel, NOT the modal.
  await clickArea(page, A_ID);
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-area-modal] [data-pasture-move-form]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The temp paddock readout reads "Temp paddock".
  await page.locator(`.pm-area-${T_ID}`).first().hover();
  await expect(page.locator('.pm-area-hover-tip').filter({hasText: 'Temp paddock'})).toBeVisible({timeout: 15_000});
});
