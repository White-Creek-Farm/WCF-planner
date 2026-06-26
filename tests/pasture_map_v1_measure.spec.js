// Pasture Map — V1 reset: SAVED distance measurements (mig 141). Measure a line,
// save it as a named distance layer, see it listed, and delete it. Measurements
// are layers only -- never a land area / destination / report.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-meas-a';
const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_measurements, public.pasture_rotations, public.pasture_move_impacts, public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES ('${A_ID}', 'paddock', 'Measure North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 measure: ' + error.message);
}

// Two-point distance ruler: click point A, then point B. The measurement freezes
// automatically after exactly two points — no third point, no double-click finish.
async function drawMeasure(page) {
  const box = await page.locator('.pm-map').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
  await page.waitForTimeout(160);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.45);
  await page.waitForTimeout(320);
}

test.beforeAll(seed);

test('measure -> save a named distance measurement -> it lists and deletes', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-measure]').click();
  await drawMeasure(page);

  // The frozen measure HUD offers a Save button.
  await expect(page.locator('[data-pasture-measure-save]')).toBeVisible({timeout: 10_000});
  await page.locator('[data-pasture-measure-save]').click();

  // Name the measurement and save it.
  await expect(page.locator('[data-pasture-measure-form]')).toBeVisible({timeout: 10_000});
  await page.locator('[data-pasture-measure-name]').fill('North fence length');
  await page.locator('[data-pasture-measure-save-confirm]').click();
  await page.waitForTimeout(900);

  // Open Field Layers -> the saved measurement is listed.
  await page.locator('[data-pasture-field-layers]').click();
  await expect(page.locator('[data-pasture-measurements]')).toContainText('North fence length', {timeout: 10_000});

  // Delete it -> the list empties.
  await page.locator('[data-pasture-measurement-delete]').first().click();
  await page.waitForTimeout(900);
  await expect(page.locator('[data-pasture-measurements]')).toHaveCount(0);
});
