// Pasture Map CP4 - planned moves / history / rest / stocking reports e2e.
// Cleans only pasture-owned tables, seeds two paddocks, then drives the UI
// through plan -> use plan -> same-day second move -> reports.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-cp4-a';
const B_ID = 'pm-cp4-b';
const MOMMA_ID = 'pm-cp4-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

function localDateTimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

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
        ('${A_ID}', 'paddock', 'CP4 North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'CP4 South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

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

    -- Deterministic real planner group: one active Mommas cow so the roster
    -- yields the cattle "Mommas" group the plan/move forms now select.
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMCP4-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture CP4: ' + error.message);
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

// Corner map overlays can intercept polygon clicks; hide them (not under test).
async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}
async function clickArea(page, areaId) {
  await page.locator(`.pm-area-${areaId}`).first().click();
}

test('plans a move and renders history/rest/stocking reports', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Plan a future move from the side-panel Plan-a-move form (free-form: group +
  // destination area + date).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('[data-pasture-plan-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-plan-area]').selectOption({value: A_ID});
  await page.locator('[data-pasture-plan-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-plan-at]').fill(localDateTimeValue());
  await page.locator('[data-pasture-plan-save]').click();
  await page.waitForTimeout(500);

  // Planned moves render in the side panel.
  await expect(page.locator('[data-pasture-planned-moves]')).toContainText('Mommas', {timeout: 15_000});
  await expect(page.locator('[data-pasture-planned-moves]')).toContainText('CP4 North Paddock');

  // Record the actual move for the same group/area from the side-panel move form.
  await page.locator('[data-pasture-move-area]').selectOption({value: A_ID});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);

  // Reports tab: the every-area list -> open this paddock's grazing record.
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-areas]')).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-report-area-row="${A_ID}"]`).click();
  await expect(page.locator(`[data-pasture-report-record="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  // Occupied now -> the status line names the group; the timeline shows Mommas + the
  // computed metrics (animal-days), all from the move history (no rest/stocking RPCs).
  await expect(page.locator('[data-pasture-report-status]')).toContainText('In use by Mommas');
  await expect(page.locator('[data-pasture-report-timeline]')).toContainText('Mommas', {timeout: 15_000});
  await expect(page.locator('[data-pasture-report-totals]')).toContainText('animal-days');
});
