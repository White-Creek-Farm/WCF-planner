// Pasture Map tweak lane #2 e2e (NON-resetting; cleans only the isolated pasture
// tables). Covers: selection dismissal (X / Escape / empty-background click), the
// Setup "open outlines - needs closing" surface (count / zoom / close), and that
// animal occupancy survives toggling the boundary overlay off.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-tw2-a';
const B_ID = 'pm-tw2-b';
const OUT_ID = 'pm-tw2-outline';
const MOMMA_ID = 'pm-tw2-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.40,30.865],[-86.395,30.865],[-86.395,30.87],[-86.40,30.87],[-86.40,30.865]]]}';
// An OPEN line (4 corners, not closed) -> outline candidate that can be closed.
const OPEN_LINE =
  '{"type":"LineString","coordinates":[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845]]}';

async function exec(sql) {
  const {error} = await getTestAdminClient().rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture tweaks2: ' + error.message);
}

const TRUNCATE = `
  TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts, public.pasture_move_events,
    public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
`;

async function seedTwoAreas() {
  await exec(`
    ${TRUNCATE}
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by) VALUES
        ('${A_ID}','paddock','TW2 Paddock A','active','reviewed','none',true,'drawn',v_profile),
        ('${B_ID}','paddock','TW2 Paddock B','active','reviewed','none',true,'drawn',v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),'drawn','{}'::jsonb,v_profile);
      PERFORM public._land_area_add_version('${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326),'drawn','{}'::jsonb,v_profile);
    END $$;
  `);
}

test('area modal dismissal: X button, Escape, and backdrop click', async ({page}) => {
  await seedTwoAreas();
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  const modal = page.locator('[data-pasture-area-modal]');

  // X button.
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(modal).toBeVisible();
  await page.locator('[data-pasture-clear-selection]').click();
  await expect(modal).toHaveCount(0);

  // Escape key.
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // Backdrop click (outside the dialog) dismisses.
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(modal).toBeVisible();
  await page.locator('[data-pasture-area-modal-backdrop]').click({position: {x: 8, y: 8}});
  await expect(modal).toHaveCount(0);
});

test('Setup Tracks / Lines: lists draft lines, not on Map, closes into a temp paddock', async ({page}) => {
  // Outline candidates keep their LineString in raw_geometry (the versions table
  // is polygon-only), mirroring create_land_area_track.
  await exec(`
    ${TRUNCATE}
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, raw_geometry, source, raw_notes, created_by)
      VALUES
        ('${OUT_ID}','outline_candidate','TW2 Open Trace','active','pending_review','outline_candidate',true,
         extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${OPEN_LINE}'),4326),'drawn','created_via=field_track',v_profile);
    END $$;
  `);
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Draft line is NOT offered as a grazing area on the Map (no area-select row).
  await expect(page.locator(`[data-pasture-area-select="${OUT_ID}"]`)).toHaveCount(0);

  // It lives in the Plan Tracks / Lines section.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  const card = page.locator('[data-pasture-tracks-lines]');
  await expect(card).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-tracks-lines-count]')).toHaveText('1');
  await expect(page.locator(`[data-pasture-track-line="${OUT_ID}"]`)).toBeVisible();
  // Zoom selects the line (opens its modal); close the modal to use the row's close action.
  await page.locator(`[data-pasture-track-line-zoom="${OUT_ID}"]`).click();
  await expect(page.locator('[data-pasture-area-modal]')).toBeVisible({timeout: 15_000});
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pasture-area-modal]')).toHaveCount(0);

  // Close into a temp paddock -> leaves the Tracks/Lines surface and becomes a
  // kind=paddock + permanence=temporary area.
  await page.locator(`[data-pasture-track-line-close="${OUT_ID}"]`).click();
  await expect(card).toHaveCount(0, {timeout: 15_000});
  await expect
    .poll(
      async () => {
        const {data} = await getTestAdminClient()
          .from('land_areas')
          .select('kind,permanence')
          .eq('id', OUT_ID)
          .single();
        return data;
      },
      {timeout: 15_000},
    )
    .toEqual({kind: 'paddock', permanence: 'temporary'});
});

test('animal occupancy survives toggling the boundary overlay off', async ({page}) => {
  await exec(`
    ${TRUNCATE}
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by) VALUES
        ('${A_ID}','paddock','TW2 Occupied A','active','reviewed','none',true,'drawn',v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),'drawn','{}'::jsonb,v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id='${MOMMA_ID}';
    INSERT INTO public.cattle (id,tag,sex,herd,breeding_blacklist,old_tags) VALUES ('${MOMMA_ID}','PMTW2-MOMMA','cow','mommas',false,'[]'::jsonb);
  `);
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Record Mommas -> Paddock A via the contextual modal (carries the move form).
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(page.locator('[data-pasture-area-modal]')).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');

  // The occupant marker is present on the Map.
  const marker = page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'});
  await expect(marker).toHaveCount(1, {timeout: 15_000});

  // Toggle the Paddocks boundary overlay OFF -> occupancy marker must remain.
  await page.locator('[data-pasture-boundary="paddock"]').click();
  await expect(page.locator('[data-pasture-boundary="paddock"]')).toHaveAttribute('data-pasture-boundary-on', '0');
  await expect(marker).toHaveCount(1);
});

test('Plan tab: one combined group/move card, no area list, move in the area modal', async ({page}) => {
  await exec(`
    ${TRUNCATE}
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by) VALUES
        ('${A_ID}','paddock','TW2 Plan A','active','reviewed','none',true,'drawn',v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),'drawn','{}'::jsonb,v_profile);
    END $$;
    DELETE FROM public.cattle WHERE id='${MOMMA_ID}';
    INSERT INTO public.cattle (id,tag,sex,herd,breeding_blacklist,old_tags) VALUES ('${MOMMA_ID}','PMTW2-MOMMA','cow','mommas',false,'[]'::jsonb);
  `);
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();

  // One combined group/move card with a plain "Move" button.
  const card = page.locator('[data-pasture-group-move]');
  await expect(card).toBeVisible({timeout: 15_000});
  await expect(card.getByRole('button', {name: 'Move', exact: true})).toBeVisible();
  await expect(card.locator('[data-pasture-time-in-area]')).toBeVisible();
  // No abbreviation / day badge / progress copy.
  await expect(card).not.toContainText('Day 1/1');
  await expect(card).not.toContainText('Move due now');

  // No full area list in Plan, and no manual-move card in the Plan body.
  await expect(page.locator('[data-pasture-area-select]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-manual-move]')).toHaveCount(0);

  // The move form lives in the area modal, opened by selecting an area on the Map.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.locator(`[data-pasture-area-select="${A_ID}"]`).first().click();
  await expect(page.locator('[data-pasture-area-modal]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible();
});

async function drawMeasure(page) {
  const box = await page.locator('.pm-map').boundingBox();
  const pts = [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.6, 0.6],
    [0.4, 0.6],
  ];
  for (const [fx, fy] of pts) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(160);
  }
  await page.mouse.click(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.waitForTimeout(350);
}

test('Measure is transient: HUD with Clear + Done, and Escape/Map-Pan dismiss it', async ({page}) => {
  await seedTwoAreas();
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await page.locator('[data-pasture-boundary-tools-toggle]').click();

  // Measure -> draw -> HUD with lifecycle controls.
  await page.locator('[data-mode="measure"]').click();
  await drawMeasure(page);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 8000});
  await expect(page.locator('[data-pasture-measure-actions]')).toBeVisible();

  // Clear measurement removes the HUD (transient; nothing saved).
  await page.locator('[data-pasture-measure-clear]').click();
  await expect(page.locator('[data-pasture-hud]')).toHaveCount(0, {timeout: 8000});

  // Measure again, then Done exits the tool.
  await drawMeasure(page);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 8000});
  await page.locator('[data-pasture-measure-done]').click();
  await expect(page.locator('[data-pasture-hud]')).toHaveCount(0, {timeout: 8000});

  // Measure again, then Escape clears/exits.
  await page.locator('[data-mode="measure"]').click();
  await drawMeasure(page);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 8000});
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pasture-hud]')).toHaveCount(0, {timeout: 8000});

  // Measurement never created a land area (still just the two seeded paddocks).
  const {count} = await getTestAdminClient()
    .from('land_areas')
    .select('id', {count: 'exact', head: true})
    .is('deleted_at', null);
  expect(count).toBe(2);
});

test('Archived areas have a recovery surface in Plan', async ({page}) => {
  await exec(`
    ${TRUNCATE}
    DO $$ DECLARE v_profile uuid; BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by) VALUES
        ('${A_ID}','paddock','TW2 Archived Temp','temporary','retired','reviewed','none',true,'drawn',v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326),'drawn','{}'::jsonb,v_profile);
    END $$;
  `);
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Archived area is NOT on the Map active list.
  await expect(page.locator(`[data-pasture-area-select="${A_ID}"]`)).toHaveCount(0);

  // It is recoverable from the Plan "Archived areas" section.
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await expect(page.locator('[data-pasture-archived]')).toBeVisible({timeout: 15_000});
  await expect(page.locator(`[data-pasture-archived-row="${A_ID}"]`)).toBeVisible();
  await page.locator(`[data-pasture-archived-restore="${A_ID}"]`).click();

  // Restored -> active again (back on the Map list, gone from Archived).
  await expect(page.locator(`[data-pasture-archived-row="${A_ID}"]`)).toHaveCount(0, {timeout: 15_000});
  await expect
    .poll(
      async () => {
        const {data} = await getTestAdminClient().from('land_areas').select('status').eq('id', A_ID).single();
        return data?.status;
      },
      {timeout: 15_000},
    )
    .toBe('active');
});
