// Pasture Map — V1 reset Field: stateful My Location button (off -> center+follow
// -> heading -> off) driven by the geolocation watch. The map stays north-up.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const A_ID = 'pm-field-a';
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
      VALUES ('${A_ID}', 'paddock', 'Field North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed v1 field: ' + error.message);
}

// Emulate a GPS fix near the WCF farm so watchPosition resolves.
test.use({
  geolocation: {latitude: 30.84175, longitude: -86.43686, accuracy: 12},
  permissions: ['geolocation'],
});

test.beforeAll(seed);

test('stateful My Location cycles off -> follow -> heading -> off and acquires a GPS fix', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  const btn = page.locator('[data-pasture-locate]');
  await expect(btn).toHaveAttribute('data-pasture-locate-state', 'off');

  // Tap 1 -> follow; the geolocation watch resolves and the GPS readout appears.
  await btn.click();
  await expect(btn).toHaveAttribute('data-pasture-locate-state', 'follow');
  await expect(page.locator('.pm-gps-msg')).toContainText('GPS', {timeout: 15_000});

  // Tap 2 -> heading mode.
  await btn.click();
  await expect(btn).toHaveAttribute('data-pasture-locate-state', 'heading');

  // Tap 3 -> off (north reset); the readout clears.
  await btn.click();
  await expect(btn).toHaveAttribute('data-pasture-locate-state', 'off');
  await expect(page.locator('.pm-gps-msg')).toHaveCount(0);
});

// Build a stable, non-self-intersecting paddock WITHOUT drag physics: the Drop
// point button seeds a vertex at the deterministic map centre, then two tap-to-place
// corners complete a simple triangle. Fixed screen fractions => identical geometry
// locally and in CI (the old drag-traced square self-intersected intermittently
// under CI timing, leaving Save disabled).
async function dropStableShape(page) {
  const box = await page.locator('.pm-map').boundingBox();
  const tap = async (fx, fy) => {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(140);
  };
  await page.locator('[data-pasture-drop-point]').click();
  await tap(0.3, 0.22);
  await tap(0.7, 0.22);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 10_000});
}

test('Drop Point builds a temp paddock in Field (drop + tap-to-place + Save)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Enter Field draw mode -> the fixed-center crosshair + bottom thumb-zone bar.
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible();

  // Drop point (centre) + tap-to-place corners build a stable, non-self-intersecting
  // shape (deterministic screen points; no drag physics). The live HUD proves it.
  await dropStableShape(page);

  // Save finishes the shape -> the temp paddock draw form opens.
  await page.locator('[data-pasture-drop-save]').click();
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 10_000});
});

test('Walk tracker records, pauses, resumes, and shows a live duration', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Field "Walk paddock" starts recording immediately (GPS watch).
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-walk]').click();
  await expect(page.locator('[data-pasture-track-state]')).toHaveAttribute('data-pasture-track-state', 'recording');
  await expect(page.locator('[data-pasture-track-duration]')).toBeVisible();

  // Pause -> the state freezes; Resume -> back to recording (same track).
  await page.locator('[data-pasture-track-pause]').click();
  await expect(page.locator('[data-pasture-track-state]')).toHaveAttribute('data-pasture-track-state', 'paused');
  await page.locator('[data-pasture-track-resume]').click();
  await expect(page.locator('[data-pasture-track-state]')).toHaveAttribute('data-pasture-track-state', 'recording');
});

test('Field draw Cancel exits the drop-point mode', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-drop-cancel]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toHaveCount(0);
  await expect(page.locator('[data-pasture-drawbar]')).toHaveCount(0);
});
