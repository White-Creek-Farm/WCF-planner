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
  const {error} = await c.rpc('exec_sql', {
    sql: 'TRUNCATE TABLE public.pasture_planned_moves, public.pasture_move_impacts, public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;',
  });
  if (error) throw new Error('clean pasture tables: ' + error.message);
}

async function areaIdByName(name) {
  const {data, error} = await getTestAdminClient().from('land_areas').select('id').eq('name', name).single();
  if (error) throw new Error(`lookup area "${name}": ` + error.message);
  return data.id;
}

async function firstOutlineCandidateId() {
  const {data, error} = await getTestAdminClient()
    .from('land_areas')
    .select('id')
    .eq('kind', 'outline_candidate')
    .limit(1);
  if (error) throw new Error('lookup outline candidate: ' + error.message);
  if (!data.length) throw new Error('no outline candidate found');
  return data[0].id;
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

test.beforeAll(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, {recursive: true});
  if (!fs.existsSync(KML_PATH)) throw new Error('sample KML not found at ' + KML_PATH);
  await cleanPastureTables();
});

test('CP1 regression + CP2 draw/measure/edit/cancel', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});

  // Boundary tools live in the Setup tab for managers/admins.
  await page.locator('.pm-tabs button', {hasText: 'Setup'}).click();
  for (const m of ['move', 'track', 'measure', 'draw', 'edit']) {
    await expect(page.locator(`[data-mode="${m}"]`)).toBeVisible();
  }
  await page.waitForTimeout(2000);

  // ── CP1 regression: import + classify (import auto-stays on the Setup tab) ──
  await page.locator('[data-pasture-import-input]').setInputFiles(KML_PATH);
  await expect(page.locator('[data-pasture-import-preview]')).toBeVisible();
  await page.getByRole('button', {name: /^Import \d+$/}).click();
  await expect(page.locator('[data-pasture-area]')).toHaveCount(10, {timeout: 25_000});

  // Classify an unclassified import as a paddock via the Setup designation control.
  const unclassifiedRow = page.locator('[data-pasture-area][data-kind="unclassified"]').first();
  const classifyId = await unclassifiedRow.getAttribute('data-pasture-area');
  await page.locator(`[data-pasture-expand="${classifyId}"]`).click();
  await page.locator(`[data-pasture-designation="${classifyId}"]`).selectOption('paddock');
  await expect(page.locator(`[data-pasture-area="${classifyId}"]`)).toHaveAttribute('data-kind', 'paddock', {
    timeout: 10_000,
  });
  await page.screenshot({path: path.join(SHOTS, '01-cp1-import-classify.png'), fullPage: true});

  // ── CP2 measure: HUD appears ──
  await page.locator('[data-mode="measure"]').click();
  await page.waitForTimeout(400);
  await drawPolygon(page, [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.6, 0.6],
    [0.4, 0.6],
  ]);
  await expect(page.locator('[data-pasture-hud]')).toBeVisible({timeout: 8000});
  await page.screenshot({path: path.join(SHOTS, '02-measure-hud.png'), fullPage: true});

  // ── CP2 draw: form requires name, save creates an area (10 -> 11) ──
  await page.locator('[data-mode="draw"]').click();
  await page.waitForTimeout(400);
  await drawPolygon(page, [
    [0.3, 0.3],
    [0.5, 0.3],
    [0.5, 0.5],
    [0.3, 0.5],
  ]);
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 8000});
  // Save disabled until a name is entered. New drawn land is a TEMP paddock now
  // (permanent areas come from promotion), so the draw form shows no Type select.
  await expect(page.locator('[data-pasture-drawform-save]')).toBeDisabled();
  await expect(page.locator('[data-pasture-drawform-temp]')).toBeVisible();
  await page.locator('[data-pasture-drawform-name]').fill('CP2 Test Paddock');
  await page.screenshot({path: path.join(SHOTS, '03-draw-form.png'), fullPage: true});
  await page.locator('[data-pasture-drawform-save]').click();
  await expect(page.locator('[data-pasture-area]')).toHaveCount(11, {timeout: 15_000});
  const drawnId = await areaIdByName('CP2 Test Paddock');
  await expect(page.locator(`[data-pasture-area="${drawnId}"]`)).toBeVisible();
  await page.screenshot({path: path.join(SHOTS, '04-after-draw-save.png'), fullPage: true});

  // ── CP2 invalid: self-intersecting bowtie flags + disables save ──
  await page.locator('[data-mode="draw"]').click();
  await page.waitForTimeout(400);
  await drawPolygon(page, [
    [0.32, 0.32],
    [0.52, 0.52],
    [0.52, 0.32],
    [0.32, 0.52],
  ]); // bowtie
  await expect(page.locator('[data-pasture-drawform]')).toBeVisible({timeout: 8000});
  await expect(page.locator('.pm-drawform-warn')).toBeVisible();
  await expect(page.locator('[data-pasture-drawform-save]')).toBeDisabled();
  await page.locator('.pm-drawform').getByRole('button', {name: 'Cancel'}).click();
  await expect(page.locator('[data-pasture-drawform]')).toHaveCount(0);

  // ── CP2 edit: select the drawn polygon, enter edit, edit bar appears, cancel ──
  // The left map column keeps reflowing as imagery tiles load, so the Setup row
  // controls jitter; force the selection clicks (the targets are stable buttons).
  await page.locator(`[data-pasture-expand="${drawnId}"]`).click();
  await page
    .locator(`[data-pasture-area="${drawnId}"]`)
    .getByRole('button', {name: 'Select', exact: true})
    .click({force: true});
  await page.locator('[data-mode="edit"]').click();
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 8000});
  await page.screenshot({path: path.join(SHOTS, '05-edit-bar.png'), fullPage: true});
  await page.locator('[data-pasture-editbar-exit]').click();
  await expect(page.locator('[data-pasture-editbar]')).toHaveCount(0);

  // ── Edit is disabled for an outline candidate (no polygon yet) ──
  const outlineId = await firstOutlineCandidateId();
  await page.locator(`[data-pasture-expand="${outlineId}"]`).click();
  await page
    .locator(`[data-pasture-area="${outlineId}"]`)
    .getByRole('button', {name: 'Select', exact: true})
    .click({force: true});
  await expect(page.locator('[data-mode="edit"]')).toBeDisabled();

  // ── Mobile ──
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  await page.locator('.pm-tabs button', {hasText: 'Setup'}).click();
  await page.locator('[data-mode="draw"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({path: path.join(SHOTS, '06-mobile-draw-mode.png'), fullPage: true});
});
