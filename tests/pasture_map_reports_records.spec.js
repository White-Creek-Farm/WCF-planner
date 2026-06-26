// Pasture Map Reports = every-area grazing records. The Reports tab lists every
// area in the canonical table and drills into a per-area record.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const P_ID = 'pm-rec-pasture';
const C_ID = 'pm-rec-paddock';
const MOMMA_ID = 'pm-rec-momma';

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
        ('${P_ID}', 'pasture', 'Record Pasture', NULL, 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${C_ID}', 'paddock', 'Record Paddock 1', '${P_ID}', 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${P_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_P}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${C_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_C}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'REC-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${C_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed reports records: ' + error.message);
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-legend,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Reports lists every area and drills into a per-area grazing record', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${C_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('[data-pasture-group-row="mommas"]').click();
  const moveCard = page.locator('[data-pasture-group-move="mommas"]');
  await expect(moveCard.locator('.pm-group-move-cell').nth(1).locator('strong')).toHaveText('Record Paddock 1', {
    timeout: 15_000,
  });
  await moveCard.locator('[data-pasture-move]').click();
  await page.waitForTimeout(1200);

  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await expect(page.locator(`[data-pasture-report-area-row="${P_ID}"]`)).toBeVisible();
  const paddockRow = page.locator(`[data-pasture-report-area-row="${C_ID}"]`);
  await expect(paddockRow).toBeVisible();

  await paddockRow.click();
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-report-status]')).toContainText('In use by Mommas');
  const totals = page.locator('[data-pasture-report-totals]');
  await expect(totals).toContainText('times grazed');
  await expect(totals).toContainText('animal-days');
  await expect(totals).toContainText('avg head/ac');

  const stay = page.locator('[data-pasture-report-stay]').first();
  await expect(stay).toContainText('Mommas');
  await expect(stay).toContainText('head');
  await expect(stay).toContainText('head/ac');
  await expect(stay).toContainText('Still here');

  await page.locator('[data-pasture-report-back]').click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 10_000});
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toHaveCount(0);
});
