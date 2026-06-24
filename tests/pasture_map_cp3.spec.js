// Pasture Map CP3 - move ledger / occupancy / rest e2e (NON-resetting). Cleans
// only the isolated pasture tables, seeds two paddocks through the existing
// append-only geometry helper, then records moves through the real UI/RPC path.
// Post-reconciliation: there is no Land areas list and no modal. Areas are
// selected by clicking their polygon (pm-area-<id>); recording happens in the
// Plan Area inspector; occupancy/rest are read from the map marker + inspector.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-cp3-a';
const B_ID = 'pm-cp3-b';
const MOMMA_ID = 'pm-cp3-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

async function cleanAndSeedPastureTables() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches,
      public.land_areas RESTART IDENTITY CASCADE;

    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;

      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${A_ID}', 'paddock', 'CP3 North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'CP3 South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

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
    -- yields the cattle "Mommas" group the move form now selects (no demo
    -- presets). cattle is not in the truncate set, so delete-by-id is the clean.
    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMCP3-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture CP3: ' + error.message);
}

// Corner map overlays (boundary toggle / legend / controls) can sit over a
// polygon and intercept clicks. They are not under test here, so hide them so
// the polygon center is always clickable.
async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

// Select an area by clicking its polygon (corner overlays are hidden so the
// path is not intercepted).
async function clickArea(page, areaId) {
  await page.locator(`.pm-area-${areaId}`).first().click();
}

// Record a Mommas move into an area by clicking its polygon (opens the Plan Area
// inspector), then using the inspector's move form. No list, no modal.
async function recordMommasMoveTo(page, areaId) {
  await page.locator('.pm-tabs button', {hasText: 'Plan'}).click();
  await clickArea(page, areaId);
  await expect(page.locator(`[data-pasture-plan-inspector="${areaId}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
}

test.beforeAll(async () => {
  await cleanAndSeedPastureTables();
});

test('records moves and derives occupied/resting state', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  // Area polygons render and are clickable (no side-panel list anymore).
  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${B_ID}`).first()).toBeVisible();
  await hideMapOverlays(page);

  // Move Mommas -> A, then Mommas -> B (vacating A).
  await recordMommasMoveTo(page, A_ID);
  await recordMommasMoveTo(page, B_ID);

  // Map: B is occupied (animal-type marker carries the group).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});
  // Farm status explains the occupied area.
  await expect(page.locator('[data-pasture-occupied-explain]')).toContainText('CP3 South Paddock', {timeout: 15_000});

  // Inspect B (occupied) and A (resting) on the Map via HOVER - read-only readout
  // (V1: the Map no longer opens a click inspector on desktop).
  await page.locator(`.pm-area-${B_ID}`).first().hover();
  await expect(page.locator('.pm-area-hover-tip').filter({hasText: 'Occupied'})).toBeVisible({timeout: 15_000});
  await page.locator(`.pm-area-${A_ID}`).first().hover();
  await expect(page.locator('.pm-area-hover-tip').filter({hasText: 'Resting'})).toBeVisible({timeout: 15_000});

  // Reports tab grazing-days log records the Mommas moves.
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-recent-moves]')).toContainText('Mommas', {timeout: 15_000});

  // Mobile: the view still loads and area polygons render.
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await expect(page.locator(`.pm-area-${B_ID}`).first()).toBeVisible({timeout: 25_000});
});
