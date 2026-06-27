// Pasture Map CP2 — draw / edit / measure e2e (NON-resetting). Cleans ONLY the
// isolated pasture tables, then exercises the real auth + RPC path through the
// UI on port 5199 (cannot collide with other lanes). Drawing uses real Geoman
// map clicks; metrics/validation correctness is also proven by the mig 127
// authenticated RPC smoke, so this focuses on the UI flow + CP1 regression.
//
// Updated for the planner-group redesign: the boundary tools (move / track /
// measure / draw / edit), the import flow, classification, and the draw/edit
// forms now live in the Setup tab. The in-panel .pm-title was replaced by the
// shared header, and area rows are surfaced via data-pasture-area.
import {test, expect} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {getTestAdminClient} from './setup/reset.js';

const KML_PATH = path.resolve('tests/fixtures/pasture_map_onx_sample.kml');
const SHOTS = path.resolve('pasture-cp2-shots');

async function cleanPastureTables() {
  const c = getTestAdminClient();
  // Seed one cattle in the 'bulls' herd so a planner group exists -> the Map rotation
  // editor (and its "Draw temp paddock" entry) renders. Using 'bulls' (a valid herd
  // per cattle_herd_check) keeps the shared 'mommas' roster group other specs assert
  // on clean. The Geoman draw/edit tools are reached from the rotation editor now
  // (the standalone boundary-tools grid was removed in the Area-modal lane).
  const {error} = await c.rpc('exec_sql', {
    sql: `TRUNCATE TABLE public.pasture_move_impacts, public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;
      DELETE FROM public.cattle WHERE id = 'pm-cp2-bull';
      INSERT INTO public.cattle (id, tag, sex, herd, breeding_blacklist, old_tags)
      VALUES ('pm-cp2-bull', 'CP2-BULL', 'bull', 'bulls', false, '[]'::jsonb);`,
  });
  if (error) throw new Error('clean pasture tables: ' + error.message);
}

async function areaIdByName(name) {
  const {data, error} = await getTestAdminClient().from('land_areas').select('id').eq('name', name).single();
  if (error) throw new Error(`lookup area "${name}": ` + error.message);
  return data.id;
}

async function hideMapOverlays(page) {
  await page.addStyleTag({
    content: '.pm-control-rail,.pm-map-banner{display:none!important}',
  });
}

async function mapClick(page, box, fx, fy) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(180);
}
// Draw a polygon by clicking fractional map positions, finishing on the first vertex.
async function drawPolygon(page, points) {
  const box = await page.locator('.pm-map').boundingBox();
  for (const [fx, fy] of points) await mapClick(page, box, fx, fy);
  await mapClick(page, box, points[0][0], points[0][1]); // click first vertex to close
  await page.waitForTimeout(400);
}

async function tapDropShape(page, points) {
  const box = await page.locator('.pm-map').boundingBox();
  for (const [fx, fy] of points) await mapClick(page, box, fx, fy);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 10_000});
}

async function dropStableShape(page) {
  await page.locator('[data-pasture-drop-point]').click();
  await tapDropShape(page, [
    [0.3, 0.22],
    [0.7, 0.22],
  ]);
}

async function startFieldDraw(page) {
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-drawbar]')).toBeVisible();
}

async function openBullsRecord(page) {
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  if ((await page.locator('[data-pasture-draw-temp]').count()) === 0) {
    await page.locator('[data-pasture-group-row="bulls"]').click();
  }
  await expect(page.locator('[data-pasture-rotation-chips="bulls"]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-pasture-draw-temp]')).toBeVisible({timeout: 15_000});
}

async function closeAreaModal(page) {
  const closeButton = page.locator('[data-pasture-area-modal-close]');
  await expect(closeButton).toBeVisible({timeout: 15_000});
  await closeButton.click();
  await expect(page.locator('[data-pasture-area-modal]')).toHaveCount(0, {timeout: 15_000});
}

test.beforeAll(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, {recursive: true});
  if (!fs.existsSync(KML_PATH)) throw new Error('sample KML not found at ' + KML_PATH);
  await cleanPastureTables();
});

test('CP1 regression + CP2 draw/measure/edit/cancel', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // ── CP1 regression: import; 6 lines -> Reports Tracks / Lines ──
  await page.locator('[data-pasture-import-input]').setInputFiles(KML_PATH);
  await expect(page.locator('[data-pasture-import-preview]')).toBeVisible();
  await page.getByRole('button', {name: /^Import \d+$/}).click();
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  await expect(page.locator('[data-pasture-report-review]')).toBeVisible({timeout: 25_000});
  await expect(page.locator('[data-pasture-track-line]')).toHaveCount(6, {timeout: 25_000});
  await page.screenshot({path: path.join(SHOTS, '01-cp1-import.png'), fullPage: true});

  // ── CP2 measure (a Field tool now): HUD appears (transient measurement) ──
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-measure]').click();
  await page.waitForTimeout(400);
  await drawPolygon(page, [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.6, 0.6],
    [0.4, 0.6],
  ]);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 8000});
  await page.screenshot({path: path.join(SHOTS, '02-measure-hud.png'), fullPage: true});
  await page.locator('[data-pasture-measure-done]').click();
  await expect(page.locator('[data-pasture-hud]')).toHaveCount(0);

  // ── CP2 draw: rotation editor exposes temp draw; Field drop-point path saves a TEMP paddock ──
  await openBullsRecord(page);
  await expect(page.locator('[data-pasture-draw-temp]')).toBeVisible();
  await hideMapOverlays(page);
  await startFieldDraw(page);
  await dropStableShape(page);
  await page.locator('[data-pasture-drop-save]').click();
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 10_000});
  // New drawn land is always a TEMP paddock (no Type select).
  await expect(page.locator('[data-pasture-drawform-save]')).toBeDisabled();
  await expect(page.locator('[data-pasture-drawform-temp]')).toBeVisible();
  await page.locator('[data-pasture-drawform-name]').fill('CP2 Test Paddock');
  await page.screenshot({path: path.join(SHOTS, '03-draw-form.png'), fullPage: true});
  await page.locator('[data-pasture-drawform-save]').click();
  await page.waitForTimeout(800);
  const drawnId = await areaIdByName('CP2 Test Paddock');
  // It saved as a temp paddock.
  const {data: drawn} = await getTestAdminClient()
    .from('land_areas')
    .select('kind,permanence')
    .eq('id', drawnId)
    .single();
  expect(drawn).toEqual({kind: 'paddock', permanence: 'temporary'});
  await page.screenshot({path: path.join(SHOTS, '04-after-draw-save.png'), fullPage: true});

  // ── CP2 invalid: self-intersecting bowtie flags + disables save ──
  await startFieldDraw(page);
  await tapDropShape(page, [
    [0.32, 0.32],
    [0.52, 0.52],
    [0.52, 0.32],
    [0.32, 0.52],
  ]); // bowtie
  await page.locator('[data-pasture-drop-save]').click();
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 10_000});
  await expect(page.locator('.pm-drawform-warn')).toBeVisible();
  await expect(page.locator('[data-pasture-drawform-save]')).toBeDisabled();
  await page.locator('.pm-drawform').getByRole('button', {name: 'Cancel'}).click();
  await expect(page.locator('[data-pasture-drawform]')).toHaveCount(0);

  // ── CP2 edit: select the drawn paddock polygon -> Area modal -> Redraw -> edit bar ──
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator(`.pm-area-${drawnId}`).first()).toBeVisible({timeout: 15_000});
  await page.locator(`.pm-area-${drawnId}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${drawnId}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-redraw="${drawnId}"]`).click();
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 8000});
  await page.screenshot({path: path.join(SHOTS, '05-edit-bar.png'), fullPage: true});
  await page.locator('[data-pasture-editbar-exit]').click();
  await expect(page.locator('[data-pasture-editbar]')).toHaveCount(0);
  // Exiting edit re-opens the Area modal (selection persists); clear it.
  await closeAreaModal(page);
  await expect(page.locator(`[data-pasture-plan-inspector="${drawnId}"]`)).toHaveCount(0);

  // ── Mobile: draw a temp paddock from the rotation editor ──
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Field'}).click();
  await page.locator('[data-pasture-field-draw]').click();
  await expect(page.locator('[data-pasture-crosshair]')).toBeVisible({timeout: 15_000});
  await page.waitForTimeout(800);
  await page.screenshot({path: path.join(SHOTS, '06-mobile-draw-mode.png'), fullPage: true});
});
