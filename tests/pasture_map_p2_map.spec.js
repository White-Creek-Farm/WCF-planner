// Pasture Map P2 - Map tab: current-groups roster + locations, group->location
// select/zoom, and Area Detail designation (paddock vs temp paddock).
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
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
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

test('Map tab: current groups, hover preview, no-op group click, read-only area inspector', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Tab renamed View -> Map, and it is the default active tab.
  await expect(page.locator('.pm-tabs button.is-active')).toContainText('Map');
  await expect(page.locator('[data-pasture-map-header]')).toContainText('Current groups');

  // Roster-backed Current Groups panel: Mommas is present and starts "Not placed".
  await expect(page.locator('[data-pasture-current-groups="1"]')).toBeVisible({timeout: 25_000});
  const mommaRow = page.locator('[data-pasture-current-group="mommas"]');
  await expect(mommaRow).toContainText('Mommas');
  await expect(mommaRow).toContainText('Not placed');
  await expect(mommaRow.locator('[data-pasture-group-location="none"]')).toBeVisible();

  await hideClickBlockers(page);

  // Map has no move form: record Mommas -> Paddock A via the Plan Area inspector.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await clickArea(page, A_ID);
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();

  // On the Map, the occupied paddock shows an animal-type group marker, and the
  // legend (collapsed by default) reflects animal-type occupancy.
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});
  await page.locator('.pm-legend-head').click();
  await expect(page.locator('.pm-legend-body')).toContainText('Occupied - Cattle');

  // The current-group row now shows the location (placed chip -> Paddock A).
  await expect(mommaRow.locator(`[data-pasture-group-location="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(mommaRow).toContainText('P2 Paddock A');

  // Hover/focus a placed group row PREVIEWS its area on the map (amber overlay),
  // without selecting anything; mouse-leave clears it.
  await mommaRow.hover();
  await expect(page.locator('path[stroke="#f59e0b"]')).toHaveCount(1, {timeout: 5000});
  await page.locator('[data-pasture-map-header]').hover();
  await expect(page.locator('path[stroke="#f59e0b"]')).toHaveCount(0);

  // Clicking a Current group row in Map mode does NOTHING (no inspector, no select).
  await mommaRow.click();
  await expect(page.locator('[data-pasture-selected-panel]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-current-groups="1"]')).toBeVisible();

  // Hide the legend too so it cannot block the eastern polygon, then INSPECT an
  // area on the Map via HOVER -> read-only desktop readout (V1: no click inspect).
  await page.addStyleTag({content: '.pm-legend{display:none!important}'});
  await page.locator(`.pm-area-${A_ID}`).first().hover();
  const tip = page.locator('.pm-area-hover-tip');
  await expect(tip).toBeVisible({timeout: 10_000});
  await expect(tip).toContainText('Paddock');
  await expect(tip).toContainText('Mommas');
  await expect(tip).toContainText('ac');
  // Desktop Map has no clickable inspector: clicking opens none, and there are no
  // manage / move / danger workflows on the Map.
  await clickArea(page, A_ID);
  await expect(page.locator('[data-pasture-selected-panel]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-area-manage]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-move-form]')).toHaveCount(0);

  // The temp paddock readout reads "Temp paddock".
  await page.locator(`.pm-area-${T_ID}`).first().hover();
  await expect(page.locator('.pm-area-hover-tip').filter({hasText: 'Temp paddock'})).toBeVisible({timeout: 15_000});
});
