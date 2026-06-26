// Pasture Map CP5 - offline vector fallback + queued move replay.
// Uses a real online load to populate the vector cache, then aborts pasture RPCs
// to prove cached outlines still render and move logging queues on this device.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-cp5-a';
const MOMMA_ID = 'pm-cp5-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';

async function cleanAndSeedPastureTables() {
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
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'CP5 Offline Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

      PERFORM public._land_area_add_version(
        '${A_ID}',
        extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),
        'drawn',
        '{}'::jsonb,
        v_profile
      );
    END $$;

    -- Deterministic real planner group so the roster yields cattle "Mommas"
    -- (cattle load is not aborted offline, so the roster still populates).
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMCP5-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);

    INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids)
    VALUES ('cattle_herd', 'mommas', '["${A_ID}"]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture CP5: ' + error.message);
}

async function abortPastureRpcs(page) {
  await page.route('**/rest/v1/rpc/list_land_areas', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_moves', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_rest_report', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_stocking_report', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/record_pasture_move', (route) => route.abort('failed'));
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test('uses cached vectors and queues a move while pasture RPCs are offline', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  // Area polygon renders (the Land areas list was removed).
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});

  await abortPastureRpcs(page);
  await page.reload();
  await expect(page.locator('[data-pasture-offline-panel]')).toBeVisible({timeout: 25_000});
  // Cached vectors still render the polygon offline.
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible();

  // Record a move from the group record page while offline -> it queues.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await hideMapOverlays(page);
  await page.locator('[data-pasture-group-row="mommas"]').click();
  const card = page.locator('[data-pasture-group-move="mommas"]');
  await expect(card).toBeVisible({timeout: 15_000});
  await expect(card.locator('.pm-group-move-cell').nth(1).locator('strong')).toHaveText('CP5 Offline Paddock');
  await card.locator('[data-pasture-move]').click();
  await expect(page.locator('[data-pasture-offline-queued]')).toContainText('1 queued', {timeout: 15_000});

  await page.unroute('**/rest/v1/rpc/list_land_areas');
  await page.unroute('**/rest/v1/rpc/list_pasture_moves');
  await page.unroute('**/rest/v1/rpc/list_pasture_rest_report');
  await page.unroute('**/rest/v1/rpc/list_pasture_stocking_report');
  await page.unroute('**/rest/v1/rpc/record_pasture_move');

  // After reconnect + reload, the queued move syncs and the area shows occupied
  // (the Mommas occupant marker renders on the map).
  await page.reload();
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 25_000});
});
