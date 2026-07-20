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
    TRUNCATE TABLE public.pasture_rotations, public.pasture_move_impacts,
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

// Build a stable, non-self-intersecting paddock WITHOUT drag physics: tap-to-place
// corners at fixed screen fractions => identical geometry locally and in CI (the
// old drag-traced square self-intersected intermittently under CI timing, leaving
// Save disabled). Each tap drops a vertex at the cursor; >=3 corners give acreage.
async function dropStableShape(page) {
  const box = await page.locator('.pm-map').boundingBox();
  const tap = async (fx, fy) => {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(140);
  };
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible({timeout: 10_000});
  const acres = page.locator('[data-pasture-hud] .pm-hud-v').first();
  for (const [fx, fy] of [
    [0.5, 0.55],
    [0.3, 0.25],
    [0.7, 0.25],
    [0.68, 0.62],
    [0.36, 0.62],
  ]) {
    await tap(fx, fy);
    if (((await acres.textContent()) || '').trim() !== '-') break;
  }
  await expect(acres).not.toHaveText('-', {timeout: 10_000});
}

test('Drop Point builds a temp paddock in Field (drop + tap-to-place + Save)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Enter Field draw mode -> the bottom thumb-zone draw bar (cursor crosshair on
  // the map; no fixed-center crosshair overlay).
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible({timeout: 15_000});

  // Tap-to-place corners build a stable, non-self-intersecting shape (deterministic
  // screen points; no drag physics). The live HUD proves it.
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

test('Field draw Cancel exits the draw mode', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-drop-cancel]').click();
  await expect(page.locator('[data-pasture-drawbar]')).toHaveCount(0);
});

test('rapid Field map mount/unmount does not emit Leaflet _leaflet_pos teardown noise', async ({page}) => {
  const teardownNoise = [];
  const collect = (text) => {
    if (/_leaflet_pos|Cannot read properties of undefined.*Leaflet/i.test(String(text || ''))) {
      teardownNoise.push(String(text));
    }
  };
  page.on('console', (msg) => collect(msg.text()));
  page.on('pageerror', (err) => collect(err && err.message ? err.message : err));

  await page.setViewportSize({width: 1280, height: 900});
  for (let i = 0; i < 3; i += 1) {
    await page.goto('/pasture-map', {timeout: 90_000});
    await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
    await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
    await expect(page.locator('[data-pasture-field-draw]')).toBeVisible({timeout: 15_000});
    await page.locator('[data-pasture-field-measure]').click();
    await page.waitForTimeout(100);
    await page.goto('/', {timeout: 90_000});
    await page.waitForTimeout(100);
  }

  expect(teardownNoise).toEqual([]);
});

async function areaByName(name) {
  const {data, error} = await getTestAdminClient()
    .from('land_areas')
    .select('kind,permanence')
    .eq('name', name)
    .single();
  if (error) throw new Error(`lookup area "${name}": ` + error.message);
  return data;
}

test('mobile Field: toolbar exposes "Draw temp paddock" and it builds a temp paddock', async ({page}) => {
  // Phone-first hotfix: the Field toolbar must make it obvious that Draw creates a
  // TEMP paddock (the label used to read the ambiguous "Draw paddock", which led
  // Ronnie to conclude there was no way to create one).
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();

  const drawBtn = page.locator('[data-pasture-field-draw]');
  await expect(drawBtn).toBeVisible({timeout: 15_000});
  await expect(drawBtn).toContainText('Draw temp paddock');
  // The old ambiguous visible label is gone from the toolbar.
  await expect(page.locator('[data-pasture-field-toolbar]').getByText('Draw paddock', {exact: true})).toHaveCount(0);
  // Walk + Measure remain available alongside it.
  await expect(page.locator('[data-pasture-field-walk]')).toContainText('Walk paddock');
  await expect(page.locator('[data-pasture-field-measure]')).toContainText('Measure');

  // The whole Field action toolbar must sit INSIDE the phone viewport at the two
  // tightest widths, BEFORE any click/auto-scroll. Regression guard for the mobile
  // 900px .pm-layout min-height that pushed the absolute bottom toolbar below the
  // fold: toBeVisible() and click() both accept/scroll to off-screen elements, so
  // this asserts viewport containment (position), not just render + no-overflow.
  const toolbar = page.locator('[data-pasture-field-toolbar]');
  const status = page.locator('[data-pasture-field-status]');
  const walkBtn = page.locator('[data-pasture-field-walk]');
  const measureBtn = page.locator('[data-pasture-field-measure]');
  for (const [w, h] of [
    [390, 844],
    [360, 800],
  ]) {
    await page.setViewportSize({width: w, height: h});
    await expect(drawBtn).toContainText('Draw temp paddock');

    // 1. The toolbar intersects the viewport at all...
    await expect(toolbar).toBeInViewport();
    // 2. ...and is fully within it vertically (top >= 0, bottom edge <= viewport
    //    height, allowing 2px rounding).
    const tb = await toolbar.boundingBox();
    expect(tb.y).toBeGreaterThanOrEqual(0);
    expect(tb.y + tb.height).toBeLessThanOrEqual(h + 2);
    // 3. The top Field status and the bottom toolbar are on-screen simultaneously.
    await expect(status).toBeInViewport();
    await expect(toolbar).toBeInViewport();
    // 4. All three tools are visible AND in the viewport (not rendered off-screen).
    for (const b of [walkBtn, drawBtn, measureBtn]) {
      await expect(b).toBeVisible();
      await expect(b).toBeInViewport();
    }
    await expect(walkBtn).toContainText('Walk paddock');
    await expect(measureBtn).toContainText('Measure');

    // 5. Existing guards: no horizontal overflow; the longer "Draw temp paddock"
    //    label may wrap but the toolbar keeps its height (clears the action card at
    //    bottom 96px and the draw form at bottom 104px).
    const btn = await drawBtn.boundingBox();
    expect(btn.x).toBeGreaterThanOrEqual(0);
    expect(btn.x + btn.width).toBeLessThanOrEqual(w + 0.5);
    expect(tb.height).toBeLessThanOrEqual(96);
  }

  // Tapping the control enters draw mode (the bottom draw bar appears).
  await drawBtn.click();
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible({timeout: 15_000});

  // Completing the polygon opens the draw form disclosing "New area = Temp paddock".
  await dropStableShape(page);
  await page.locator('[data-pasture-drop-save]').click();
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 10_000});
  const tempNote = page.locator('[data-pasture-drawform-temp]');
  await expect(tempNote).toBeVisible();
  await expect(tempNote).toHaveText(/New area = Temp paddock/i);

  // Saving persists a real TEMP paddock (kind=paddock, permanence=temporary) via
  // the existing createTempLandArea path.
  await page.locator('[data-pasture-drawform-name]').fill('Mobile Temp Paddock');
  await page.locator('[data-pasture-drawform-save]').click();
  await page.waitForTimeout(800);
  expect(await areaByName('Mobile Temp Paddock')).toEqual({kind: 'paddock', permanence: 'temporary'});
});
