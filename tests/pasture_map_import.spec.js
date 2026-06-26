// Pasture Map CP1 — import + classify e2e (NON-resetting). Cleans ONLY the
// isolated pasture tables (land_areas / land_area_geometry_versions /
// pasture_import_batches — none in the reset.js shared whitelist), imports the
// real OnX export, classifies, closes an outline candidate, and captures
// desktop/mobile + GPS screenshots for UI sign-off. Run via
// playwright.pasture.config.js on port 5199 so it cannot collide with the
// active Home-parity lane.
//
// Updated for the planner-group redesign: the shared header replaced the
// in-panel .pm-title; the area list rows are .pm-area-row (was .pm-item);
// classification + close-outline now live in the Setup tab pasture editor; the
// locate control is labeled "My Location".
import {test, expect} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {getTestAdminClient} from './setup/reset.js';

const KML_PATH = path.resolve('tests/fixtures/pasture_map_onx_sample.kml');
const SHOTS = path.resolve('pasture-map-shots');

async function cleanPastureTables() {
  const c = getTestAdminClient();
  const {error} = await c.rpc('exec_sql', {
    sql: 'TRUNCATE TABLE public.pasture_move_impacts, public.pasture_move_events, public.land_area_geometry_versions, public.pasture_import_batches, public.land_areas RESTART IDENTITY CASCADE;',
  });
  if (error) throw new Error('clean pasture tables: ' + error.message);
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

test('import OnX KML, classify, close outline, capture screenshots', async ({page}) => {
  // ── Empty state ──
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/pasture-map', {timeout: 90_000});
  await expect(page.locator('.pm-tabs')).toBeVisible({timeout: 25_000});
  // Empty pasture: the map canvas renders with no area polygons (the Land areas
  // list - and its empty message - was removed from Map).
  await expect(page.locator('[data-pasture-map-canvas]')).toBeVisible({timeout: 20_000});
  await expect(page.locator('.pm-area-path')).toHaveCount(0);
  await page.waitForTimeout(2000); // let NAIP tiles paint
  await page.screenshot({path: path.join(SHOTS, '01-empty-desktop.png'), fullPage: true});

  // ── Import preview ── (choosing a KML auto-switches to the Plan tab, which owns
  // classification + tracks/lines; the preview banner renders above the tabs.)
  await page.locator('[data-pasture-import-input]').setInputFiles(KML_PATH);
  await expect(page.locator('[data-pasture-import-preview]')).toBeVisible();
  await page.screenshot({path: path.join(SHOTS, '02-import-preview-desktop.png'), fullPage: true});

  // ── Import: 4 polygons -> unclassified grazing areas, 6 lines -> Tracks / Lines ──
  await page.getByRole('button', {name: /^Import \d+$/}).click();
  // The 6 draft lines surface in the Reports Tracks / Lines section now.
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  const reviewCard = page.locator('[data-pasture-report-review]');
  await expect(reviewCard).toBeVisible({timeout: 25_000});
  await expect(page.locator('[data-pasture-track-line]')).toHaveCount(6, {timeout: 25_000});
  await page.waitForTimeout(1500);
  await page.screenshot({path: path.join(SHOTS, '03-post-import-plan.png'), fullPage: true});

  // On the merged Map the 4 imported polygons AND the 6 draft lines render as area
  // paths (draft lines now show on the working Map). There is no Land areas list.
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await expect(page.locator('.pm-area-path')).toHaveCount(10, {timeout: 15_000});

  // Classify a standalone polygon as a pasture via its Area inspector (Manage section).
  const {data: unclassified} = await getTestAdminClient()
    .from('land_areas')
    .select('id')
    .eq('kind', 'unclassified')
    .limit(1)
    .single();
  const classifyId = unclassified.id;
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  await page.addStyleTag({
    content:
      '.pm-boundary-toggle,.pm-legend,.pm-map-controls,.pm-draftlines-toggle,.pm-map-banner{display:none!important}',
  });
  await page.locator(`.pm-area-${classifyId}`).first().click();
  await expect(page.locator(`[data-pasture-plan-inspector="${classifyId}"]`)).toBeVisible({timeout: 15_000});
  await page.locator(`[data-pasture-designation="${classifyId}"]`).selectOption('pasture');
  await expect
    .poll(
      async () => {
        const {data} = await getTestAdminClient().from('land_areas').select('kind').eq('id', classifyId).single();
        return data?.kind;
      },
      {timeout: 15_000},
    )
    .toBe('pasture');
  await closeAreaModal(page);
  await page.screenshot({path: path.join(SHOTS, '04-classified-desktop.png'), fullPage: true});

  // Close a draft line into a temp paddock from the Reports Tracks / Lines section.
  await page.locator('.pm-tabs button', {hasText: 'Reports'}).click();
  const outlineId = await page.locator('[data-pasture-track-line]').first().getAttribute('data-pasture-track-line');
  await page.locator(`[data-pasture-track-line-close="${outlineId}"]`).click();
  await expect(page.locator('[data-pasture-track-line]')).toHaveCount(5, {timeout: 15_000});
  await page.waitForTimeout(1000);
  await page.screenshot({path: path.join(SHOTS, '05-outline-closed-desktop.png'), fullPage: true});

  // ── GPS "you are here" (mocked geolocation; best-effort) ──
  // Back to the Map (the GPS locate control lives on the map canvas).
  await page.locator('.pm-tabs button', {hasText: 'Map'}).click();
  // Re-show the map controls hidden during the classification polygon click.
  await page.addStyleTag({content: '.pm-map-controls{display:flex!important}'});
  try {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({latitude: 30.84175, longitude: -86.43686, accuracy: 8});
    await page.getByRole('button', {name: /My Location/}).click();
    await expect(page.locator('.pm-gps-msg')).toBeVisible({timeout: 10_000});
    await page.waitForTimeout(1500);
    await page.screenshot({path: path.join(SHOTS, '06-gps-locate-desktop.png'), fullPage: true});
  } catch (e) {
    console.warn('GPS screenshot skipped:', e.message);
  }

  // ── Mobile ──
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('.pm-area-path').first()).toBeVisible({timeout: 25_000});
  await page.waitForTimeout(2500);
  await page.screenshot({path: path.join(SHOTS, '07-post-import-mobile.png'), fullPage: true});
});
