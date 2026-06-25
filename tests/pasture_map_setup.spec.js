// Pasture Map Setup - temp-paddock lifecycle e2e via the P0 RPCs: archive/
// restore, occupied-archive block (exact copy), and admin hard-delete (inline
// confirm). NON-resetting; cleans only the isolated pasture tables.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-setup-a';
const T_ID = 'pm-setup-temp';
const MOMMA_ID = 'pm-setup-momma';
const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_T =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function cleanAndSeed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts, public.pasture_move_events,
      public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by) VALUES
        ('${A_ID}','paddock','Setup Paddock A', NULL,'active','reviewed','none',true,'drawn',v_profile),
        ('${T_ID}','paddock','Setup Temp','temporary','active','reviewed','none',true,'drawn',v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),'drawn','{}'::jsonb,v_profile);
      PERFORM public._land_area_add_version('${T_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_T}'),4326),'drawn','{}'::jsonb,v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id='${MOMMA_ID}';
    INSERT INTO public.cattle (id,tag,sex,herd,breeding_blacklist,old_tags) VALUES ('${MOMMA_ID}','PMSU-MOMMA','cow','mommas',false,'[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture setup: ' + error.message);
}

test.beforeAll(async () => {
  await cleanAndSeed();
});

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

// Open an area's Plan Area inspector by clicking its polygon (no list, no modal).
async function openArea(page, areaId) {
  await page.keyboard.press('Escape');
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator(`.pm-area-${areaId}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${areaId}"]`)).toBeVisible({timeout: 15_000});
}

// Record a group move onto an area via the Plan inspector's move form.
async function recordMove(page, areaId, groupLabel) {
  await openArea(page, areaId);
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: groupLabel});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
}

test('Temp paddock archive/restore, occupied block, admin hard delete (via Plan inspector)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${T_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Per-area lifecycle lives in the contextual modal now. Archived areas leave the
  // active Map list, so archive -> restore is exercised within one open modal.
  await openArea(page, T_ID);
  await expect(page.locator(`[data-pasture-area-detail="${T_ID}"]`)).toContainText('Temp paddock');
  await expect(page.locator(`[data-pasture-archive="${T_ID}"]`)).toContainText('Archive temp paddock');
  await page.locator(`[data-pasture-archive="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-area-detail="${T_ID}"]`)).toContainText('Archived temp', {timeout: 15_000});
  await page.locator(`[data-pasture-restore="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-area-detail="${T_ID}"]`)).not.toContainText('Archived temp', {
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');

  // Occupied-archive block: move Mommas onto the temp paddock, then archiving is
  // blocked with the exact copy.
  await recordMove(page, T_ID, 'Mommas');
  await openArea(page, T_ID);
  await page.locator(`[data-pasture-archive="${T_ID}"]`).click();
  await expect(page.locator('.pm-error')).toContainText('Move animals out of this temp paddock before archiving it.', {
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');

  // Admin hard delete renders directly in the Area modal (admin-only, no "Danger
  // zone" disclosure). Move the group away first so it is not blocked, then
  // hard-delete + confirm, and verify the area's polygon is gone.
  await recordMove(page, A_ID, 'Mommas');
  await openArea(page, T_ID);
  await page.locator(`[data-pasture-hard-delete="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-hard-delete-confirm="${T_ID}"]`)).toContainText('Permanently hard delete');
  await page.locator(`[data-pasture-hard-delete-yes="${T_ID}"]`).click();
  await expect(page.locator(`.pm-area-${T_ID}`)).toHaveCount(0, {timeout: 15_000});
});
