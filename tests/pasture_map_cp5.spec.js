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
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture CP5: ' + error.message);
}

async function abortPastureRpcs(page) {
  await page.route('**/rest/v1/rpc/list_land_areas', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_moves', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_planned_moves', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_rest_report', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/list_pasture_stocking_report', (route) => route.abort('failed'));
  await page.route('**/rest/v1/rpc/record_pasture_move', (route) => route.abort('failed'));
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

test('uses cached vectors and queues a move while pasture RPCs are offline', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator(`[data-pasture-area="${A_ID}"]`)).toContainText('CP5 Offline Paddock', {timeout: 25_000});

  await abortPastureRpcs(page);
  await page.reload();
  await expect(page.locator('[data-pasture-offline-panel]')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`[data-pasture-area="${A_ID}"]`)).toContainText('CP5 Offline Paddock');

  // Recording lives in the Plan tab now; flat group picker, locked count.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await expect(page.locator('[data-pasture-offline-queued]')).toContainText('1 queued', {timeout: 15_000});

  await page.unroute('**/rest/v1/rpc/list_land_areas');
  await page.unroute('**/rest/v1/rpc/list_pasture_moves');
  await page.unroute('**/rest/v1/rpc/list_pasture_planned_moves');
  await page.unroute('**/rest/v1/rpc/list_pasture_rest_report');
  await page.unroute('**/rest/v1/rpc/list_pasture_stocking_report');
  await page.unroute('**/rest/v1/rpc/record_pasture_move');

  await page.reload();
  await expect(page.locator(`[data-pasture-area="${A_ID}"]`)).toContainText('Occupied now', {timeout: 25_000});
});
