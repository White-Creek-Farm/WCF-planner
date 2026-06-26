// Pasture Map: the old "Clear current area" affordance is intentionally gone.
// Placement changes now happen through the rotation-backed Move box only.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-clr-a';
const MOMMA_ID = 'pm-clr-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_rotations, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches,
      public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES ('${A_ID}', 'paddock', 'Clear Test Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'CLR-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${A_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed clear placement: ' + error.message);
}

test.beforeAll(seed);

test('group record exposes Move, not a clear-placement shortcut', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});

  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('[data-pasture-group-row="mommas"]').click();

  const card = page.locator('[data-pasture-group-move="mommas"]');
  await expect(card).toBeVisible({timeout: 15_000});
  await expect(card.locator('.pm-group-move-cell').nth(0).locator('strong')).toHaveText('Not placed');
  await expect(card.locator('.pm-group-move-cell').nth(1).locator('strong')).toHaveText('Clear Test Paddock');
  await expect(card.getByRole('button', {name: 'Move', exact: true})).toBeVisible();
  await expect(page.locator('[data-pasture-clear-placement]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Clear selection');
});
