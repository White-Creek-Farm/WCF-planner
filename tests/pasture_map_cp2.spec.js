// Pasture Map CP2 — draw / edit / measure e2e (NON-resetting). Cleans ONLY the
// isolated pasture tables, then exercises the real auth + RPC path through the
// UI on port 5199 (cannot collide with other lanes). Drawing uses real Geoman
// map clicks; metrics/validation correctness is also proven by the mig 127
// authenticated RPC smoke, so this focuses on the UI flow + CP1 regression.
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
  await expect(page.locator('.pm-title')).toHaveText('Pasture Map');
  // Toolbar modes present for admin.
  for (const m of ['move', 'select', 'measure', 'draw', 'edit']) {
    await expect(page.locator(`[data-mode="${m}"]`)).toBeVisible();
  }
  await page.waitForTimeout(2000);

  // ── CP1 regression: import + classify ──
  await page.locator('[data-pasture-import-input]').setInputFiles(KML_PATH);
  await expect(page.locator('[data-pasture-import-preview]')).toBeVisible();
  await page.getByRole('button', {name: /^Import \d+$/}).click();
  await expect(page.locator('.pm-item')).toHaveCount(10, {timeout: 25_000});
  const hub = page.locator('.pm-item', {hasText: 'HUB'}).first();
  await hub.getByRole('button', {name: 'Infra'}).click();
  await expect(hub.locator('.pm-chip-infrastructure')).toBeVisible({timeout: 10_000});
  await page.waitForTimeout(1500);
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
  // Save disabled until a name is entered.
  await expect(page.locator('[data-pasture-drawform-save]')).toBeDisabled();
  await page.locator('[data-pasture-drawform-name]').fill('CP2 Test Paddock');
  await page.locator('[data-pasture-drawform-kind]').selectOption('paddock');
  await page.screenshot({path: path.join(SHOTS, '03-draw-form.png'), fullPage: true});
  await page.locator('[data-pasture-drawform-save]').click();
  await expect(page.locator('.pm-item')).toHaveCount(11, {timeout: 15_000});
  await expect(page.locator('.pm-item', {hasText: 'CP2 Test Paddock'})).toBeVisible();
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
  await page.locator('[data-pasture-area-select]', {hasText: 'CP2 Test Paddock'}).first().click();
  await page.locator('[data-mode="edit"]').click();
  await expect(page.locator('[data-pasture-editbar]')).toBeVisible({timeout: 8000});
  await page.screenshot({path: path.join(SHOTS, '05-edit-bar.png'), fullPage: true});
  await page.locator('[data-pasture-editbar]').getByRole('button', {name: 'Exit edit'}).click();
  await expect(page.locator('[data-pasture-editbar]')).toHaveCount(0);

  // ── Edit is disabled for an outline candidate (no polygon yet) ──
  const outline = page.locator('.pm-item[data-kind="outline_candidate"] [data-pasture-area-select]').first();
  await outline.click();
  await expect(page.locator('[data-mode="edit"]')).toBeDisabled();

  // ── Mobile ──
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-item').first()).toBeVisible({timeout: 25_000});
  await page.locator('[data-mode="draw"]').click();
  await page.waitForTimeout(800);
  await page.screenshot({path: path.join(SHOTS, '06-mobile-draw-mode.png'), fullPage: true});
});
