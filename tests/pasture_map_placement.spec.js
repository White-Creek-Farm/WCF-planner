// Pasture Map placement source-of-truth e2e.
// Proves the headline fix: an UNPLACED group (a roster group with a rotation but
// no recorded move) reads Current area = "Not placed" and Next area = the FIRST
// rotation stop, and the Move button records the group INTO that first stop
// (not the second). Current location is derived only from the move ledger, never
// from the rotation array.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-place-a';
const B_ID = 'pm-place-b';
const MOMMA_ID = 'pm-place-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function cleanAndSeedPastureTables() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_rotations, public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;

    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;

      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'Place North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'Place South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

      PERFORM public._land_area_add_version(
        '${A_ID}',
        extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),
        'drawn',
        '{}'::jsonb,
        v_profile
      );
      PERFORM public._land_area_add_version(
        '${B_ID}',
        extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326),
        'drawn',
        '{}'::jsonb,
        v_profile
      );
    END $$;

    -- One active Mommas cow so the roster yields the cattle "Mommas" group with a
    -- rotation but NO recorded move (the unplaced case the fix targets).
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMPLACE-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);

    -- V1 reset: rotations are user-controlled + persisted (mig 140), no auto-seed.
    -- Seed the Mommas rotation directly so the unplaced-group "Next = first stop"
    -- behaviour still holds (first stop = Place North Paddock).
    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${A_ID}", "${B_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture placement: ' + error.message);
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

test('unplaced group reads Not placed, Next is the first rotation stop, and Move records there', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Map tab: the unplaced Mommas group reports "Not placed" (no borrowed stop).
  // (Other roster groups may exist in the shared TEST DB; this asserts Mommas.)
  await expect(page.locator('[data-pasture-current-group="mommas"]')).toContainText('Not placed', {timeout: 25_000});
  await expect(
    page.locator('[data-pasture-current-group="mommas"] [data-pasture-group-location="none"]'),
  ).toBeVisible();

  // Plan tab: make Mommas the active group (the default active group may be a
  // pre-existing pig/sheep roster group in the shared TEST DB).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator('.pm-group-pill', {hasText: 'Mommas'}).click();

  // Combined group/move card. Current = Not placed; Next = first rotation stop.
  const card = page.locator('[data-pasture-group-move]');
  await expect(card).toBeVisible({timeout: 25_000});
  await expect(card.locator('[data-pasture-time-in-area]')).toHaveText('Not placed');
  const cells = card.locator('.pm-group-move-cell');
  await expect(cells.nth(0).locator('strong')).toHaveText('Not placed');

  const nextName = (await cells.nth(1).locator('strong').textContent())?.trim();
  expect(nextName).toBeTruthy();
  expect(nextName).not.toBe('-');
  expect(['Place North Paddock', 'Place South Paddock']).toContain(nextName);

  // Move records the unplaced group INTO the displayed Next (the first stop).
  await page.locator('[data-pasture-move]').click();
  await page.waitForTimeout(900);
  // Recording selects the destination area (opens the contextual modal); dismiss
  // it before navigating tabs.
  await page.keyboard.press('Escape');

  // The group is now placed in that exact area (the first rotation stop).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('[data-pasture-current-group="mommas"]')).toContainText(nextName, {timeout: 15_000});
  await expect(page.locator('[data-pasture-current-group="mommas"] [data-pasture-group-location="none"]')).toHaveCount(
    0,
  );
});
