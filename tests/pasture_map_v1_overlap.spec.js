// Pasture Map — V1 reset: the Map must not make one canonical group look placed in
// two areas. When a group is moved into paddock A and paddock B geometrically
// OVERLAPS A, the move ledger records a destination impact on A and an overlap
// impact on B. The Map must render exactly ONE current-location marker (on the
// destination, A) and NOT a second "Mommas" marker on the overlapped B.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-ovl-a';
const B_ID = 'pm-ovl-b';
const MOMMA_ID = 'pm-ovl-momma';

// A and B overlap in the [-86.434, -86.433] strip (real ~90 m intersection), but
// A's centroid (-86.4365) sits well left of B, so clicking A's path always hits A.
const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.433,30.84],[-86.433,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.434,30.84],[-86.427,30.84],[-86.427,30.845],[-86.434,30.845],[-86.434,30.84]]]}';

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
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'Overlap Paddock A', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'Overlap Paddock B', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

      PERFORM public._land_area_add_version(
        '${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version(
        '${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;

    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMOVL-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture overlap: ' + error.message);
}

async function hideClickBlockers(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner,.pm-legend{display:none!important}',
  });
}

test.beforeAll(cleanAndSeed);

test('overlap impact does not produce a duplicate occupant marker for the same group', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideClickBlockers(page);

  // Record Mommas -> Paddock A via the Plan Area inspector (A's centroid is clear of B).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator(`.pm-area-${A_ID}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');

  // Back on the Map: Mommas appears as a current-location marker EXACTLY once (on the
  // destination A), never a second time on the overlapped B.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});
  // No other occupant markers exist either (the overlap impact draws no marker).
  await expect(page.locator('.pm-occupant-marker')).toHaveCount(1);
});
