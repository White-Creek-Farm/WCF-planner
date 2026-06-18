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

test('Map tab: current groups, locations, group->location select, area detail', async ({page}) => {
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

  // Recording lives in the Plan tab now (Map is read-only). Single flat Group
  // picker; pick "Mommas" and record Mommas -> Paddock A.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(1000);

  // Back on the Map: the occupied paddock shows an animal-type group marker, and
  // the legend reflects animal-type occupancy.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  // The occupant marker is a 0x0 Leaflet divIcon whose pill overflows visibly,
  // so assert presence (it renders) rather than box-visibility.
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});
  await expect(page.locator('.pm-legend-body')).toContainText('Occupied - Cattle');

  // Clear any carried selection to see the Current Groups panel.
  const clearBtn = page.locator('[data-pasture-selected-panel]').getByRole('button', {name: 'Clear selection'});
  if (await clearBtn.count()) await clearBtn.click();

  // The current-group row now shows the location (placed chip -> Paddock A).
  await expect(mommaRow.locator(`[data-pasture-group-location="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(mommaRow).toContainText('P2 Paddock A');

  // Clicking the group selects + zooms its current location -> read-only Area detail.
  await mommaRow.click();
  await expect(page.locator('[data-pasture-selected-panel]')).toBeVisible();
  await expect(page.locator(`[data-pasture-area-detail="${A_ID}"]`)).toBeVisible();
  await expect(page.locator('[data-pasture-selected-panel]')).toContainText('Area detail');
  await expect(page.locator(`[data-pasture-area-detail="${A_ID}"]`)).toContainText('Paddock');
  // Occupancy is still shown read-only; no editing in the Map tab.
  await expect(page.locator(`[data-pasture-occupancy="${A_ID}"]`)).toContainText('Mommas');
  await expect(page.locator('[data-pasture-move-form]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-plan-form]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-style-panel]')).toHaveCount(0);

  // Area Detail for the temp paddock reads "Temp paddock" with a Temp chip.
  await page.locator('[data-pasture-selected-panel]').getByRole('button', {name: 'Clear selection'}).click();
  await page.locator(`[data-pasture-area-select="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-area-detail="${T_ID}"]`)).toContainText('Temp paddock', {timeout: 15_000});
  await expect(page.locator(`[data-pasture-area-detail="${T_ID}"] .pm-chip-temp`)).toBeVisible();
});
