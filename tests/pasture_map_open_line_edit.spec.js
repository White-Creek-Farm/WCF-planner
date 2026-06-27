// Pasture Map open-line edit (mig 150): a saved Track / Line (outline_candidate)
// can be reshaped IN PLACE via Leaflet-Geoman and saved through the new
// update_land_area_track RPC. The edit is line-aware (HUD shows Distance, not
// acreage; the bar reads "Save line") and preserves Tracks / Lines semantics —
// the area stays an outline candidate with no acreage and no polygon promotion.
// A polygon area keeps Redraw (boundary edit) and never gets an Edit-line
// affordance. RPC-level behaviour (reshape persists, polygon geometry/target
// rejected, role gating) is covered by scripts/apply_test_mig_150.cjs + the
// static guard; this spec locks the UI wiring end to end.
import {test, expect} from '@playwright/test';
import {getTestAdminClient} from './setup/reset.js';

const TRACK_ID = 'pm-ole-track';
const POLY_ID = 'pm-ole-poly';
// A straight 2-point diagonal: the rendered path midpoint equals its bounding-box
// center, so a plain .click() on the SVG path reliably lands on the stroke and
// selects the line (an unfilled line only hit-tests on its stroke).
const LINE = '{"type":"LineString","coordinates":[[-86.44,30.84],[-86.42,30.845]]}';
const POLY =
  '{"type":"Polygon","coordinates":[[[-86.45,30.85],[-86.445,30.85],[-86.445,30.855],[-86.45,30.855],[-86.45,30.85]]]}';

async function seed() {
  const c = getTestAdminClient();
  const sql = `
    TRUNCATE TABLE public.pasture_rotations, public.pasture_move_impacts,
      public.pasture_move_events, public.land_area_geometry_versions,
      public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
    DO $$
    DECLARE v_profile uuid;
    BEGIN
      SELECT id INTO v_profile FROM public.profiles LIMIT 1;
      INSERT INTO public.land_areas
        (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, raw_geometry, source, created_by)
      VALUES
        ('${TRACK_ID}', 'outline_candidate', 'OLE Track', NULL, 'active', 'pending_review', 'outline_candidate', true,
          extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${LINE}'), 4326), 'drawn', v_profile);
      INSERT INTO public.land_areas
        (id, kind, name, permanence, status, review_status, geometry_status, baseline_no_history, source, created_by)
      VALUES
        ('${POLY_ID}', 'paddock', 'OLE Polygon', 'permanent', 'active', 'reviewed', 'none', true, 'drawn', v_profile);
      PERFORM public._land_area_add_version('${POLY_ID}',
        extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${POLY}'), 4326), 'drawn', '{}'::jsonb, v_profile);
    END $$;
  `;
  // Retry the seed a few times to ride out transient TEST-Supabase "fetch failed"
  // network blips (the shared TEST DB occasionally drops a connection).
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const {error} = await c.rpc('exec_sql', {sql});
      if (!error) return;
      lastErr = error;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('seed open-line edit: ' + (lastErr && (lastErr.message || lastErr)));
}

async function openMap(page, {hideOverlays = true} = {}) {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  // The Boundaries panel + banner overlay the map top-left and can intercept a
  // click on an area that renders under them; hide them unless the test needs them.
  if (hideOverlays) {
    await page.addStyleTag({
      content: '.pm-control-rail,.pm-map-banner{display:none!important}',
    });
  }
}

test.beforeAll(seed);

test('a saved Track / Line shows Edit line and enters line-aware edit mode', async ({page}) => {
  await openMap(page);

  // Select the track line -> Area modal opens with the Edit-line affordance.
  await expect(page.locator(`.pm-area-${TRACK_ID}`).first()).toBeVisible({timeout: 25_000});
  await page.locator(`.pm-area-${TRACK_ID}`).first().click();
  await expect(page.locator(`[data-pasture-area-modal="${TRACK_ID}"]`)).toBeVisible({timeout: 15_000});

  const editLine = page.locator(`[data-pasture-edit-line="${TRACK_ID}"]`);
  await expect(editLine).toBeVisible();
  await expect(editLine).toBeEnabled();

  // Enter edit: the modal yields to the map, the edit bar reads "Save line", and
  // the HUD reports Distance (line-aware) rather than Acres.
  await editLine.click();
  await expect(page.locator(`[data-pasture-area-modal="${TRACK_ID}"]`)).toHaveCount(0);
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-editbar-save]')).toHaveText(/Save line/);
  const hud = page.locator('[data-pasture-hud]');
  await expect(hud).toBeVisible({timeout: 10_000});
  await expect(hud).toContainText('Distance');
  await expect(hud).not.toContainText('Acres');
});

test('reshaping a Track / Line in place persists through the line RPC', async ({page}) => {
  await openMap(page);
  await expect(page.locator(`.pm-area-${TRACK_ID}`).first()).toBeVisible({timeout: 25_000});
  await page.locator(`.pm-area-${TRACK_ID}`).first().click();
  await page.locator(`[data-pasture-edit-line="${TRACK_ID}"]`).click();
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 15_000});

  // Drag a Geoman vertex so an edit is captured, then save it.
  const marker = page.locator('.leaflet-marker-pane .leaflet-marker-icon').first();
  await expect(marker).toBeVisible({timeout: 10_000});
  const box = await marker.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, {steps: 12});
  await page.mouse.up();

  await page.locator('[data-pasture-editbar-save]').click();
  // The edit bar closes only on a successful save (an RPC error keeps it open).
  await expect(page.locator('[data-pasture-editbar]')).toHaveCount(0, {timeout: 15_000});

  // Semantics preserved: still an outline candidate, no acreage, no polygon version.
  const c = getTestAdminClient();
  const {data, error} = await c
    .from('land_areas')
    .select('kind, geometry_status, computed_acres')
    .eq('id', TRACK_ID)
    .single();
  if (error) throw new Error('read back track: ' + error.message);
  expect(data.kind).toBe('outline_candidate');
  expect(data.geometry_status).toBe('outline_candidate');
  expect(data.computed_acres).toBeNull();
});

test('a Track / Line record hides grazing history (draft geometry only)', async ({page}) => {
  await openMap(page);
  await expect(page.locator(`.pm-area-${TRACK_ID}`).first()).toBeVisible({timeout: 25_000});
  await page.locator(`.pm-area-${TRACK_ID}`).first().click();
  await expect(page.locator(`[data-pasture-area-modal="${TRACK_ID}"]`)).toBeVisible({timeout: 15_000});
  const modal = page.locator(`[data-pasture-area-modal="${TRACK_ID}"]`);
  // Draft line: no Grazing History card, no rest/acreage rows; the Edit-line action stays.
  await expect(modal.getByText('Grazing History')).toHaveCount(0);
  await expect(modal.locator('[data-pasture-use-facts]')).toHaveCount(0);
  await expect(page.locator(`[data-pasture-edit-line="${TRACK_ID}"]`)).toBeVisible();
});

test('the Map Layers Lines toggle hides and shows draft lines', async ({page}) => {
  await openMap(page, {hideOverlays: false});
  await expect(page.locator(`.pm-area-${TRACK_ID}`).first()).toBeVisible({timeout: 25_000});
  // The boundary overlays live inside the Layers popover now — open it first.
  await page.locator('[data-pasture-layers-toggle]').click();
  const linesToggle = page.locator('[data-pasture-boundary="line"]');
  await expect(linesToggle).toBeVisible();
  // Toggle off -> the draft line is removed from the map; toggle on -> it returns.
  await linesToggle.click();
  await expect(page.locator(`.pm-area-${TRACK_ID}`)).toHaveCount(0, {timeout: 10_000});
  await linesToggle.click();
  await expect(page.locator(`.pm-area-${TRACK_ID}`).first()).toBeVisible({timeout: 10_000});
});

test('a track is editable from the Reports Tracks / Lines list', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  // Wait for the track's Reports row (attached even inside a collapsed <details>),
  // force-open the collapsed sections, then use its Edit line action.
  await page.locator(`[data-pasture-track-line="${TRACK_ID}"]`).first().waitFor({timeout: 20_000, state: 'attached'});
  await page.locator('details').evaluateAll((els) => els.forEach((d) => (d.open = true)));
  const editFromReports = page.locator(`[data-pasture-track-line-edit="${TRACK_ID}"]`).first();
  await editFromReports.scrollIntoViewIfNeeded();
  await editFromReports.click();
  // Switches to the Map in line-edit mode.
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-hud]')).toContainText('Distance', {timeout: 10_000});
});

test('a polygon area keeps Redraw and never gets an Edit-line affordance', async ({page}) => {
  await openMap(page);
  await expect(page.locator(`.pm-area-${POLY_ID}`).first()).toBeVisible({timeout: 25_000});
  await page.locator(`.pm-area-${POLY_ID}`).first().click();
  await expect(page.locator(`[data-pasture-area-modal="${POLY_ID}"]`)).toBeVisible({timeout: 15_000});

  // Polygons edit their boundary through Redraw; the line-only affordance is absent.
  await expect(page.locator(`[data-pasture-redraw="${POLY_ID}"]`)).toBeEnabled();
  await expect(page.locator(`[data-pasture-edit-line="${POLY_ID}"]`)).toHaveCount(0);
});
