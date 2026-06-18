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

// expandedPasture persists across reloads/tab switches, so only expand the row
// if its lifecycle actions are not already showing.
async function expandTemp(page) {
  const actions = page.locator(`[data-pasture-archive="${T_ID}"], [data-pasture-restore="${T_ID}"]`);
  if ((await actions.count()) === 0) await page.locator(`[data-pasture-expand="${T_ID}"]`).click();
  await expect(actions.first()).toBeVisible({timeout: 10_000});
}

test('Setup: temp paddock archive/restore, occupied block, admin hard delete', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Setup'}).click();
  const tempRow = page.locator(`[data-pasture-area="${T_ID}"]`);
  await expect(tempRow).toBeVisible({timeout: 25_000});
  await expect(tempRow).toContainText('Temp paddock'); // designation chip

  // Archive the temp paddock -> tagged "Archived temp".
  await expandTemp(page);
  await expect(page.locator(`[data-pasture-archive="${T_ID}"]`)).toContainText('Archive temp paddock');
  await page.locator(`[data-pasture-archive="${T_ID}"]`).click();
  await expect(tempRow).toContainText('Archived temp', {timeout: 15_000});

  // Restore it -> active again (no Archived tag).
  await expandTemp(page);
  await page.locator(`[data-pasture-restore="${T_ID}"]`).click();
  await expect(tempRow).not.toContainText('Archived temp', {timeout: 15_000});

  // Occupied-archive block: move Mommas onto the temp paddock, then archiving is
  // blocked with the exact copy.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await page.locator(`[data-pasture-area-select="${T_ID}"]`).first().click();
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);
  await page.locator('.pm-tabs button', {hasText: 'Setup'}).click();
  await expandTemp(page);
  await page.locator(`[data-pasture-archive="${T_ID}"]`).click();
  await expect(page.locator('.pm-error')).toContainText('Move animals out of this temp paddock before archiving it.', {
    timeout: 15_000,
  });

  // Admin hard delete uses an inline confirm; move the group away first so it is
  // not blocked, then hard-delete and confirm the area leaves the list.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);
  await page.locator('.pm-tabs button', {hasText: 'Setup'}).click();
  await expandTemp(page);
  await page.locator(`[data-pasture-hard-delete="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-hard-delete-confirm="${T_ID}"]`)).toContainText(
    'Hard delete this area permanently?',
  );
  await page.locator(`[data-pasture-hard-delete-yes="${T_ID}"]`).click();
  await expect(page.locator(`[data-pasture-area="${T_ID}"]`)).toHaveCount(0, {timeout: 15_000});
});
