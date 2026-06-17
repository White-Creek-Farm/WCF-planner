// Pasture Map CP1 — import + classify e2e (NON-resetting). Cleans ONLY the
// isolated pasture tables (land_areas / land_area_geometry_versions /
// pasture_import_batches — none in the reset.js shared whitelist), imports the
// real OnX export, classifies, closes an outline candidate, and captures
// desktop/mobile + GPS screenshots for UI sign-off. Run via
// playwright.pasture.config.js on port 5199 so it cannot collide with the
// active Home-parity lane.
import {test, expect} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {getTestAdminClient} from './setup/reset.js';

const KML_PATH = 'C:\\Users\\Ronni\\OneDrive\\Desktop\\onx-markups-06152026.kml';
const SHOTS = path.resolve('pasture-map-shots');

async function cleanPastureTables() {
  const c = getTestAdminClient();
  const {error} = await c.rpc('exec_sql', {
    sql: 'TRUNCATE TABLE public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;',
  });
  if (error) throw new Error('clean pasture tables: ' + error.message);
}

test.beforeAll(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, {recursive: true});
  if (!fs.existsSync(KML_PATH)) throw new Error('sample KML not found at ' + KML_PATH);
  await cleanPastureTables();
});

test('import OnX KML, classify, close outline, capture screenshots', async ({page}) => {
  // ── Empty state ──
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-title')).toHaveText('Pasture Map');
  await expect(page.locator('.pm-empty')).toBeVisible({timeout: 20_000});
  await page.waitForTimeout(2000); // let NAIP tiles paint
  await page.screenshot({path: path.join(SHOTS, '01-empty-desktop.png'), fullPage: true});

  // ── Import preview ──
  await page.locator('[data-pasture-import-input]').setInputFiles(KML_PATH);
  await expect(page.locator('[data-pasture-import-preview]')).toBeVisible();
  await page.screenshot({path: path.join(SHOTS, '02-import-preview-desktop.png'), fullPage: true});

  // ── Import (10 placemarks -> 10 land areas) ──
  await page.getByRole('button', {name: /^Import \d+$/}).click();
  await expect(page.locator('.pm-item')).toHaveCount(10, {timeout: 25_000});
  await page.waitForTimeout(2500); // tiles + polygons
  await page.screenshot({path: path.join(SHOTS, '03-post-import-desktop.png'), fullPage: true});

  // 4 polygons import valid (HUB/SHOP/FP 4/Area...), 6 lines as outline candidates.
  await expect(page.locator('.pm-item[data-kind="unclassified"]')).toHaveCount(4);
  await expect(page.locator('.pm-item[data-kind="outline_candidate"]')).toHaveCount(6);

  // ── Classify HUB (a polygon) as Infrastructure ──
  const hub = page.locator('.pm-item', {hasText: 'HUB'}).first();
  await hub.getByRole('button', {name: 'Infra'}).click();
  await expect(hub.locator('.pm-chip-infrastructure')).toBeVisible({timeout: 10_000});
  await page.screenshot({path: path.join(SHOTS, '04-classified-desktop.png'), fullPage: true});

  // ── Close an outline candidate (FP2 is a traced line) ──
  const fp2 = page.locator('.pm-item', {hasText: 'FP2'}).first();
  await fp2.getByRole('button', {name: 'Close outline'}).click();
  // FP2 is no longer an outline candidate -> 5 remain.
  await expect(page.locator('.pm-item[data-kind="outline_candidate"]')).toHaveCount(5, {timeout: 10_000});
  await page.waitForTimeout(1500);
  await page.screenshot({path: path.join(SHOTS, '05-outline-closed-desktop.png'), fullPage: true});

  // ── GPS "you are here" (mocked geolocation; best-effort) ──
  try {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({latitude: 30.84175, longitude: -86.43686, accuracy: 8});
    await page.getByRole('button', {name: /You are here/}).click();
    await expect(page.locator('.pm-gps-msg')).toBeVisible({timeout: 10_000});
    await page.waitForTimeout(1500);
    await page.screenshot({path: path.join(SHOTS, '06-gps-locate-desktop.png'), fullPage: true});
  } catch (e) {
    console.warn('GPS screenshot skipped:', e.message);
  }

  // ── Mobile ──
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-item').first()).toBeVisible({timeout: 25_000});
  await page.waitForTimeout(2500);
  await page.screenshot({path: path.join(SHOTS, '07-post-import-mobile.png'), fullPage: true});
});
