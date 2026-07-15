// Pasture Map — V1 reset: SAVED distance measurements (mig 141). Measure a line,
// save it as a named distance layer, see it listed, and delete it. Measurements
// are layers only -- never a land area / destination / report.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-meas-a';
const MEAS_ID = 'pm-meas-saved';
const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const MEASURE_LINE = '{"type":"LineString","coordinates":[[-86.439,30.841],[-86.437,30.843],[-86.434,30.844]]}';

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
      INSERT INTO public.pasture_measurements (id, name, geometry, distance_ft, line_color, created_by)
      VALUES ('${MEAS_ID}', 'North fence length', '${MEASURE_LINE}'::jsonb, 880, '#7c3aed', v_profile);
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 measure: ' + error.message);
}

// Two-point distance ruler: click point A, then point B. The measurement freezes
// automatically after exactly two points — no third point, no double-click finish.
test.beforeAll(seed);

test('a saved measurement line opens, edits, and deletes from the Map', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();

  // The saved line itself is a wide click target. Click eight pixels away from
  // its visible centerline: outside the old 3px stroke but inside the new 24px
  // interaction stroke.
  const hitTarget = page.locator(`path.pm-measurement-hit-${MEAS_ID}`).first();
  await hitTarget.waitFor({state: 'attached', timeout: 10_000});
  const point = await hitTarget.evaluate((path) => {
    const length = path.getTotalLength();
    const matrix = path.getScreenCTM();
    const toScreen = (at) => {
      const p = path.getPointAtLength(at);
      return new DOMPoint(p.x, p.y).matrixTransform(matrix);
    };
    const before = toScreen(Math.max(0, length / 2 - 2));
    const after = toScreen(Math.min(length, length / 2 + 2));
    const middle = toScreen(length / 2);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    return {x: middle.x - (dy / magnitude) * 8, y: middle.y + (dx / magnitude) * 8};
  });
  await page.mouse.click(point.x, point.y);

  const modal = page.locator('[data-pasture-measurement-modal]');
  await expect(modal).toBeVisible({timeout: 10_000});

  // Rename and recolor from the clicked line record.
  await modal.locator('[data-pasture-measurement-edit-name]').fill('North run');
  await modal.locator('[data-pasture-measurement-edit-color]').fill('#ff0000');
  await modal.locator('[data-pasture-measurement-edit-save]').click();
  await expect(page.locator('.pm-modal-title')).toHaveText('North run', {timeout: 10_000});
  await expect(page.locator('path.pm-measurement-line').first()).toHaveAttribute('stroke', '#ff0000');

  // Delete from the same line record.
  await modal.locator('[data-pasture-measurement-modal-delete]').click();
  await modal.locator('[data-pasture-measurement-delete-yes]').click();
  await expect(modal).toHaveCount(0, {timeout: 10_000});
  await expect(page.locator(`path.pm-measurement-hit-${MEAS_ID}`)).toHaveCount(0);
});
