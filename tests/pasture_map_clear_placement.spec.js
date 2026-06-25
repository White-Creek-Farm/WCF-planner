// Pasture Map "Clear current area": a group's current placement can be cleared by
// recording a normal pasture move with NO destination (to_land_area_id null), so the
// group becomes Not placed and its prior area starts resting via the existing move
// ledger. Reuses record_pasture_move — no new RPC/migration, no undo.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-clr-a';
const MOMMA_ID = 'pm-clr-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';

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
      VALUES ('${A_ID}', 'paddock', 'Clear Test Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'CLR-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed clear placement: ' + error.message);
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-legend,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Clear current area moves a placed group to Not placed via a no-destination move', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Place Mommas -> Clear Test Paddock via the Plan Area inspector.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator(`.pm-area-${A_ID}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');

  // Make Mommas the active group -> its card shows Current area + the Clear control.
  await page.locator('.pm-group-pill', {hasText: 'Mommas'}).click();
  const card = page.locator('[data-pasture-group-move]');
  await expect(card).toContainText('Clear Test Paddock', {timeout: 15_000});
  const clearBtn = page.locator('[data-pasture-clear-placement]');
  await expect(clearBtn).toBeVisible();

  // Clear current area.
  await clearBtn.click();
  await page.waitForTimeout(1200);

  // The group reads Not placed and the Clear control is gone (hidden when unplaced).
  await expect(card).toContainText('Not placed');
  await expect(page.locator('[data-pasture-clear-placement]')).toHaveCount(0);

  // Map: the current-groups row now reads Not placed, and the occupant marker for
  // Mommas is gone (the area is no longer occupied by it).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('[data-pasture-current-group="mommas"] [data-pasture-group-location="none"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(0, {timeout: 15_000});

  // Reports: the area record stays coherent -> a recorded stay (not "In use"), and the
  // status line is now "Last grazed ..." rather than "In use by Mommas".
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await page.locator(`[data-pasture-report-area-row="${A_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-report-status]')).toContainText('Last grazed');
  await expect(page.locator('[data-pasture-report-timeline]')).toContainText('Mommas');
  await expect(page.locator('[data-pasture-report-timeline]')).not.toContainText('Still here');
});
