import {test, expect} from './fixtures.js';
import {seedFeedOrderBasisScenario} from './scenarios/feed_order_basis_seed.js';

function lbs(value) {
  return `${value.toLocaleString()} lbs`;
}

async function waitForAppReady(page) {
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
}

test.describe('feed-order count-aware basis', () => {
  test.beforeEach(async ({resetDb}) => {
    await resetDb();
  });

  test('pig feed order tile uses current physical count as the recommendation basis', async ({page, supabaseAdmin}) => {
    const scenario = await seedFeedOrderBasisScenario(supabaseAdmin);

    await page.goto('/pig/feed');
    await waitForAppReady(page);

    const orderTile = page.locator('[data-feed-order-tile="pig-order"]');
    await expect(orderTile).toBeVisible({timeout: 15_000});
    await expect(orderTile).toContainText(`Order for ${scenario.activeLabel}`);
    await expect(orderTile).toContainText(lbs(scenario.pig.expectedOrder));
    await expect(orderTile).toContainText('vs Actual On Hand');
    await expect(orderTile).not.toContainText(lbs(scenario.pig.staleEstimateOrder));
  });

  test('poultry feed order tile uses per-type current counts and labels mixed bases', async ({page, supabaseAdmin}) => {
    const scenario = await seedFeedOrderBasisScenario(supabaseAdmin);

    await page.goto('/broiler/feed');
    await waitForAppReady(page);

    const orderTile = page.locator('[data-feed-order-tile="poultry-order"]');
    const starterRow = orderTile.locator('[data-feed-order-row="starter"]');
    await expect(orderTile).toBeVisible({timeout: 15_000});
    await expect(orderTile).toContainText(`Order for ${scenario.activeLabel}`);
    await expect(starterRow).toContainText('Starter');
    await expect(starterRow).toContainText(lbs(scenario.poultry.starterExpectedOrder));
    await expect(starterRow).not.toContainText(lbs(scenario.poultry.starterStaleEstimateOrder));
    await expect(orderTile).toContainText(
      `vs Actual On Hand where counted; otherwise End of ${scenario.prevLabel} Est.`,
    );
  });
});
