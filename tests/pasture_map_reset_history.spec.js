// Pasture Map — reset grazing history (mig 143). A management/admin action in the
// Reports area record wipes ONE area's grazing history so it reads "no move
// history" again (e.g. a paddock that only carries test moves but shows resting).
// Seeds the move ledger directly (service role cannot call the auth.uid()-gated
// record RPC), then drives the UI reset as the admin user.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const P_ID = 'pm-rst-pasture';
const C_ID = 'pm-rst-paddock';
const MV_ID = 'pm-rst-move-1';

const POLY_P =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.43,30.84],[-86.43,30.85],[-86.44,30.85],[-86.44,30.84]]]}';
const POLY_C =
  '{"type":"Polygon","coordinates":[[[-86.438,30.842],[-86.434,30.842],[-86.434,30.846],[-86.438,30.846],[-86.438,30.842]]]}';

async function seed() {
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
        (id, kind, name, parent_id, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${P_ID}', 'pasture', 'Reset Pasture', NULL, 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${C_ID}', 'paddock', 'Reset Paddock 1', '${P_ID}', 'permanent', 'active', 'reviewed', 'none', false, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${P_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_P}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version('${C_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY_C}'),4326), 'drawn', '{}'::jsonb, v_profile);
      -- A test move INTO the paddock: a destination impact makes it read "occupied".
      INSERT INTO public.pasture_move_events
        (id, animal_type, group_key, group_label, to_land_area_id, moved_at, animal_count, created_by)
      VALUES
        ('${MV_ID}', 'cattle_herd', 'reset-test', 'Reset Test Group', '${C_ID}', now() - interval '2 days', 10, v_profile);
      INSERT INTO public.pasture_move_impacts (move_id, land_area_id, impact_kind, impacted_at)
      VALUES ('${MV_ID}', '${C_ID}', 'destination', now() - interval '2 days');
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed reset history: ' + error.message);
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-map-controls,.pm-legend,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

test.beforeAll(seed);

test('Reports: reset grazing history clears a paddock back to no-history', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${C_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Reports -> expand the pasture -> open the paddock record. It shows the test stay.
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-report-pasture="${P_ID}"] > summary`).click();
  await page.locator(`[data-pasture-report-area-row="${C_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${C_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-report-stay]').first()).toContainText('Reset Test Group');

  // Reset grazing history: confirm, then the timeline empties and the status reads
  // no-history.
  await page.locator(`[data-pasture-report-reset-history="${C_ID}"]`).click();
  await page.locator(`[data-pasture-report-reset-yes="${C_ID}"]`).click();
  await expect(page.locator('[data-pasture-report-stay]')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('[data-pasture-report-status]')).toContainText('No grazing history');

  // The ledger is cleared server-side (impacts gone for this area).
  await expect
    .poll(
      async () => {
        const c = getTestAdminClient();
        const {data} = await c.from('pasture_move_impacts').select('move_id').eq('land_area_id', C_ID);
        return (data || []).length;
      },
      {timeout: 15_000},
    )
    .toBe(0);
});
