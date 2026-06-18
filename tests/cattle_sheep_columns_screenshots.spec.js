import {test} from './fixtures.js';
import fs from 'node:fs';

// ============================================================================
// Cattle Herds + Sheep Flocks controls redesign — UI preview capture (NOT a CI
// assertion). Captures the always-flat list, the program-color active tool
// buttons (cattle = maroon/red, sheep = green), and the new column/display
// picker (every field) open + applied, desktop + mobile.
// Screenshots -> C:/Users/Ronni/cc-research/cattle-sheep/.
// ============================================================================

const SHOT = 'C:/Users/Ronni/cc-research/cattle-sheep';
const DESKTOP = {width: 1280, height: 1000};
const MOBILE = {width: 390, height: 900};

async function settle(page) {
  await page.waitForSelector('#wcf-boot-loader', {state: 'detached', timeout: 20_000}).catch(() => {});
  await page.waitForTimeout(800);
}

test.describe('Cattle + Sheep controls redesign preview', () => {
  test('cattle herds: flat list + column picker', async ({page, cattleHerdFiltersScenario}) => {
    test.setTimeout(180_000);
    void cattleHerdFiltersScenario;
    fs.mkdirSync(SHOT, {recursive: true});

    await page.setViewportSize(DESKTOP);
    await page.goto('/cattle/herds');
    await settle(page);
    await page.screenshot({path: `${SHOT}/cattle-01-default-desktop.png`, fullPage: true});

    // Open the column/display picker (program-color active button).
    await page.locator('[data-cattle-herds-columns-toggle="1"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/cattle-02-columns-open-desktop.png`, fullPage: true});

    // Turn on a few extra fields to show the picker drives the table.
    for (const key of ['sireTag', 'purchaseAmount', 'breedingStatus']) {
      await page.locator(`[data-cattle-column-toggle="${key}"]`).click();
    }
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/cattle-03-columns-applied-desktop.png`, fullPage: true});

    await page.setViewportSize(MOBILE);
    await page.goto('/cattle/herds');
    await settle(page);
    await page.screenshot({path: `${SHOT}/cattle-04-default-mobile.png`, fullPage: true});
    await page.locator('[data-cattle-herds-columns-toggle="1"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/cattle-05-columns-open-mobile.png`, fullPage: true});
  });

  test('sheep flocks: flat list + column picker', async ({page, sheepSoftDeleteScenario}) => {
    test.setTimeout(180_000);
    void sheepSoftDeleteScenario;
    fs.mkdirSync(SHOT, {recursive: true});

    await page.setViewportSize(DESKTOP);
    await page.goto('/sheep/flocks');
    await settle(page);
    await page.screenshot({path: `${SHOT}/sheep-01-default-desktop.png`, fullPage: true});

    await page.locator('[data-sheep-flocks-columns-toggle="1"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/sheep-02-columns-open-desktop.png`, fullPage: true});

    for (const key of ['lastWeighed', 'breedingStatus', 'damTag']) {
      await page.locator(`[data-sheep-column-toggle="${key}"]`).click();
    }
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/sheep-03-columns-applied-desktop.png`, fullPage: true});

    await page.setViewportSize(MOBILE);
    await page.goto('/sheep/flocks');
    await settle(page);
    await page.screenshot({path: `${SHOT}/sheep-04-default-mobile.png`, fullPage: true});
    await page.locator('[data-sheep-flocks-columns-toggle="1"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({path: `${SHOT}/sheep-05-columns-open-mobile.png`, fullPage: true});
  });
});
