// Pasture Map — Light = farm_team-level access (V1 reset, migration 139).
// A REAL light auth user logs in through the LoginScreen (not the admin
// storageState, not the DEV role override), so the pasture RPC role checks run
// as 'light'. Proves the two-sided V1 contract: light now sees all four tabs and
// can record a move through the real UI/RPC path (mig 139 widening), but light
// still does NOT get the management-only boundary tools.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

// Opt out of the shared admin storageState so we drive a genuine light login.
test.use({storageState: {cookies: [], origins: []}});

const LIGHT_EMAIL = 'test-light-pasture@wcfplanner.test';
const LIGHT_PASSWORD = 'LightPasture123!';

const A_ID = 'pm-light-a';
const B_ID = 'pm-light-b';
const MOMMA_ID = 'pm-light-momma';

const SQUARE_A =
  '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.435,30.84],[-86.435,30.845],[-86.44,30.845],[-86.44,30.84]]]}';
const SQUARE_B =
  '{"type":"Polygon","coordinates":[[[-86.43,30.84],[-86.425,30.84],[-86.425,30.845],[-86.43,30.845],[-86.43,30.84]]]}';

// Create-or-reuse a REAL light user via the service-role admin client (the
// pasture lane's harness — no fixtures.js). profiles is never truncated.
async function ensureLightUser() {
  const c = getTestAdminClient();
  const existing = await c.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === LIGHT_EMAIL);
  if (!user) {
    const created = await c.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: LIGHT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create light user: ${created.error.message}`);
    user = created.data?.user;
  } else {
    // Keep the password/confirmation deterministic across re-runs.
    await c.auth.admin.updateUserById(user.id, {password: LIGHT_PASSWORD, email_confirm: true});
  }
  const {error} = await c
    .from('profiles')
    .upsert({id: user.id, email: LIGHT_EMAIL, full_name: 'Light Field User', role: 'light'}, {onConflict: 'id'});
  if (error) throw new Error('upsert light profile: ' + error.message);
  return user;
}

// Clean only the isolated pasture tables, then seed two paddocks through the
// append-only geometry helper plus one real Mommas cow so the roster yields the
// cattle "Mommas" group the move form selects.
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
        ('${A_ID}', 'paddock', 'Light North Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile),
        ('${B_ID}', 'paddock', 'Light South Paddock', 'active', 'reviewed', 'none', true, 'drawn', v_profile);

      PERFORM public._land_area_add_version(
        '${A_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_A}'),4326), 'drawn', '{}'::jsonb, v_profile);
      PERFORM public._land_area_add_version(
        '${B_ID}', extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE_B}'),4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;

    DELETE FROM public.cattle WHERE id = '${MOMMA_ID}';
    INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
    VALUES ('${MOMMA_ID}', 'PMLIGHT-MOMMA', 'cow', 'mommas', false, '[]'::jsonb);
  `;
  const {error} = await c.rpc('exec_sql', {sql});
  if (error) throw new Error('seed pasture light: ' + error.message);
}

async function loginAsLight(page) {
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill(LIGHT_EMAIL);
  await page.getByPlaceholder('••••••••').fill(LIGHT_PASSWORD);
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

// Corner overlays can intercept polygon clicks; hide them (not under test here).
async function hideMapOverlays(page) {
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
}

// Build a stable, non-self-intersecting paddock WITHOUT drag physics. The Drop
// point button seeds a vertex at the deterministic map centre (the bbox centre
// falls in the empty gap between the two seeded paddocks); two tap-to-place corners
// in the empty band ABOVE the paddocks -- clear of the crosshair and the bottom
// draw bar -- complete a simple triangle. Fixed screen fractions => identical
// geometry locally and in CI (the old drag-traced square self-intersected
// intermittently under CI timing, leaving Save disabled).
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

test.beforeAll(async () => {
  await ensureLightUser();
  await cleanAndSeedPastureTables();
});

test('light sees all tabs and can record a move (mig 139), but gets no manager boundary tools', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await loginAsLight(page);
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Every tab renders for light (was Map-only before mig 139; Plan is now folded
  // into Map, so the tabs are Map / Field / Reports).
  for (const label of ['Map', 'Field', 'Reports']) {
    await expect(page.locator('.pm-tabs button', {hasText: label})).toBeVisible({timeout: 15_000});
  }

  await expect(page.locator(`.pm-area-${A_ID}`).first()).toBeVisible({timeout: 25_000});
  await hideMapOverlays(page);

  // Plan: light gets the actionable workspace but NOT the management-only
  // boundary tools (light == farm_team, not manager).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('[data-pasture-boundary-tools-toggle]')).toHaveCount(0);

  // Light records a Mommas move via the Plan Area inspector — the server
  // record_pasture_move RPC runs as 'light' and is allowed by mig 139.
  await page.locator(`.pm-area-${A_ID}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${A_ID}"]`)).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-move-form]').first()).toBeVisible({timeout: 15_000});
  await page.locator('[data-pasture-move-group]').selectOption({label: 'Mommas'});
  await page.locator('[data-pasture-move-save]').click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');

  // Map: the move landed — occupant marker shows Mommas in the destination.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('.pm-occupant-marker').filter({hasText: 'Mommas'})).toHaveCount(1, {timeout: 15_000});

  // Reports: light has read access — open the area's grazing record; its timeline
  // lists Mommas (mig 139 widened list_pasture_history_report to light).
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await page.locator(`[data-pasture-report-area-row="${A_ID}"]`).click();
  await expect(page.locator('[data-pasture-report-timeline]')).toContainText('Mommas', {timeout: 15_000});
});

test('light can draw + SAVE a Field temp paddock (drawIsTemp form is allowed for canCreateTrack)', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await loginAsLight(page);
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Field "Draw paddock" -> custom drop-point mode (enabled because light has
  // canCreateTrack).
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toBeVisible({timeout: 15_000});

  // Build a stable temp paddock via deterministic tap-to-place (no drag physics).
  await dropStableShape(page);

  // Save -> the temp paddock draw form now appears for a LIGHT user (the fix:
  // renderDrawForm was manager-only and silently dropped the form).
  await page.locator('[data-pasture-drop-save]').click();
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-pasture-drawform-temp]')).toBeVisible();

  const NAME = 'Light Field Temp ' + Date.now();
  await page.locator('[data-pasture-drawform-name]').fill(NAME);
  // Wait for Save to ENABLE (proves the polygon is valid / not self-intersecting)
  // before clicking, instead of racing a disabled button.
  const saveBtn = page.locator('[data-pasture-drawform-save]');
  await expect(saveBtn).toBeEnabled({timeout: 10_000});
  await saveBtn.click();

  // Form closes with no error, and a REAL temp paddock exists server-side
  // (the light user's UI drove the create_temp_area RPC end to end).
  await expect(page.locator('[data-pasture-drawform]')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('.pm-error')).toHaveCount(0);
  const c = getTestAdminClient();
  const {data, error} = await c.from('land_areas').select('id,name,kind,permanence').eq('name', NAME).limit(1);
  expect(error).toBeFalsy();
  expect(data && data.length).toBe(1);
  expect(data[0].kind).toBe('paddock');
  expect(data[0].permanence).toBe('temporary');
});
