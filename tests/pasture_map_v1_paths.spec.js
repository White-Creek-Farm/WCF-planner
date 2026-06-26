// Pasture Map: Map draws every group's manual rotation path on one screen.
// The old "Next only" toggle was removed; paths are always shown in steps.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-path-a';
const B_ID = 'pm-path-b';
const MOMMA_ID = 'pm-path-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

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
      VALUES
        ('${A_ID}', 'paddock', 'Path North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'Path South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMPATH-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${A_ID}", "${B_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 paths: ' + error.message);
}

async function hideOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Map draws the full rotation path in steps', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideOverlays(page);

  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('[data-pasture-group-row="mommas"]').click();
  await expect(page.locator('.pm-rotation-marker')).toHaveCount(2, {timeout: 15_000});
  await expect(page.getByRole('button', {name: 'Next only'})).toHaveCount(0);
});
