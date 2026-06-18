import {test} from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Design-Law Compliance review — SCREENSHOT CAPTURE UTILITY (not a regression
// spec). Captures the screens most changed by the CP0 compliance pass into
// audit-review-shots/ for Ronnie's visual review.
//   Run alone (workers=1, shared TEST DB; clear port 5173 first):
//     npx playwright test tests/audit_review_screenshots.spec.js
// Each test pulls a scenario fixture (resets + seeds that area) then shoots.
// No assertions — shots are taken before anything that could throw.
// ============================================================================

const SHOT_DIR = path.resolve(process.cwd(), 'audit-review-shots');
const DESKTOP = {width: 1366, height: 900};
const MOBILE = {width: 390, height: 844};

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, {recursive: true});
  await page.screenshot({path: path.join(SHOT_DIR, `${name}.png`), fullPage: false});
}

// goto + settle: domcontentloaded then a generous pause for async data load.
async function show(page, url, ms = 2600) {
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  // Cold boot shows a "Loading your farm data..." splash — wait it out so we
  // never screenshot the loader.
  await page
    .locator('text=Loading your farm data')
    .waitFor({state: 'detached', timeout: 20000})
    .catch(() => {});
  await page.waitForTimeout(ms);
}

test('home dashboard', async ({homeDashboardEquipmentScenario, page}) => {
  void homeDashboardEquipmentScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/');
  await shot(page, '01-home-desktop');
  await page.setViewportSize(MOBILE);
  await shot(page, '02-home-mobile');
});

test('cattle dashboard + herds (maroon tabs, herd dot+label, black numbers)', async ({
  cattleHerdFiltersScenario,
  page,
}) => {
  void cattleHerdFiltersScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/cattle');
  await shot(page, '10-cattle-dashboard-desktop');
  await show(page, '/cattle/herds');
  await shot(page, '11-cattle-herds-desktop');
  await page.setViewportSize(MOBILE);
  await shot(page, '12-cattle-herds-mobile');
});

test('cattle weigh-ins (program-color accent)', async ({cattleSendToProcessorScenario, page}) => {
  void cattleSendToProcessorScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/cattle/weighins');
  await shot(page, '13-cattle-weighins-desktop');
});

test('cattle forecast', async ({cattleForecastScenario, page}) => {
  void cattleForecastScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/cattle/forecast');
  await shot(page, '14-cattle-forecast-desktop');
});

test('broiler dashboard + batches (PROCESSED now a table) + timeline', async ({broilerTimelineScenario, page}) => {
  void broilerTimelineScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/broiler');
  await shot(page, '20-broiler-dashboard-desktop');
  await show(page, '/broiler/batches');
  await shot(page, '21-broiler-batches-desktop');
  await show(page, '/broiler/timeline');
  await shot(page, '22-broiler-timeline-desktop');
});

test('broiler weigh-ins (program-color accent)', async ({broilerWeighInSchoonersScenario, page}) => {
  void broilerWeighInSchoonersScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/broiler/weighins');
  await shot(page, '23-broiler-weighins-desktop');
});

test('pig dailys (clean rows, dot+label, black comments) + batches', async ({pigDailysOfflineScenario, page}) => {
  void pigDailysOfflineScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/pig/dailys');
  await shot(page, '30-pig-dailys-desktop');
  await page.setViewportSize(MOBILE);
  await shot(page, '31-pig-dailys-mobile');
});

test('pig batches', async ({pigFCRScenario, page}) => {
  void pigFCRScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/pig/batches');
  await shot(page, '32-pig-batches-desktop');
});

test('sheep dashboard + weigh-ins (program-color accent)', async ({sheepSendToProcessorScenario, page}) => {
  void sheepSendToProcessorScenario;
  await page.setViewportSize(DESKTOP);
  await show(page, '/sheep');
  await shot(page, '40-sheep-dashboard-desktop');
  await show(page, '/sheep/weighins');
  await shot(page, '41-sheep-weighins-desktop');
});
