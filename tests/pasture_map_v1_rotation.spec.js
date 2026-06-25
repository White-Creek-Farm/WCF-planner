// Pasture Map — V1 reset: rotations are user-controlled + persisted (mig 140).
// A user builds a rotation stop from the map; it lands in pasture_rotations and
// survives a full reload (proving the upsert -> list round-trip through the real
// UI/RPC path). There is no auto-seed: the editor starts empty.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-rot-a';
const B_ID = 'pm-rot-b';
const MOMMA_ID = 'pm-rot-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_rotations, public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches,
      public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'Rot North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'Rot South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMROT-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 rotation: ' + error.message);
}

async function hideOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

async function activateMommas(page) {
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('.pm-group-pill', {hasText: 'Mommas'}).click();
}

test.beforeAll(seed);

test('a user builds a rotation from the map; it persists across reload (mig 140, no auto-seed)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideOverlays(page);

  await activateMommas(page);
  // The rotation editor is present and starts EMPTY (no generated default).
  await expect(page.locator('.pm-card-title', {hasText: 'Rotation editor'})).toBeVisible({timeout: 15_000});
  await expect(page.locator('.pm-rot-chip')).toHaveCount(0);

  // Build a stop from the map: "Add from map" -> tap an area.
  await page.getByRole('button', {name: 'Add from map'}).click();
  await page.locator(`.pm-area-${A_ID}`).first().click();

  // The stop appears immediately (optimistic) and lands in pasture_rotations.
  await expect(page.locator('.pm-rot-chip').filter({hasText: 'Rot North Paddock'})).toBeVisible({timeout: 15_000});
  await expect
    .poll(
      async () => {
        const {data} = await getTestAdminClient()
          .from('pasture_rotations')
          .select('area_ids')
          .eq('animal_type', 'cattle_herd')
          .eq('group_key', 'mommas')
          .maybeSingle();
        return data ? data.area_ids : null;
      },
      {timeout: 15_000},
    )
    .toEqual([A_ID]);

  // Reload: the rotation is re-loaded from the server and the stop persists.
  await page.reload();
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await hideOverlays(page);
  await activateMommas(page);
  await expect(page.locator('.pm-rot-chip').filter({hasText: 'Rot North Paddock'})).toBeVisible({timeout: 15_000});
});
