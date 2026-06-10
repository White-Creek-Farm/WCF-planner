import {test, expect} from './fixtures.js';
import {waitForPigFeedersLoaded} from './helpers/pigReady.js';

// CP4 — record-page sequence navigation for pig.batch (/pig/batches/<group id>).
// Feeder groups live in app_store key ppp-feeders-v1; ids are plain so the
// encoded route equals the id.

function group(id, batchName) {
  return {
    id,
    batchName,
    cycleId: '',
    giltCount: 5,
    boarCount: 5,
    originalPigCount: 10,
    startDate: '2026-01-01',
    status: 'active',
    notes: '',
    perLbFeedCost: 0.3,
    legacyFeedLbs: 0,
    feedAllocatedToTransfers: 0,
    pigMortalities: [],
    processingTrips: [],
    subBatches: [],
  };
}

async function seedFeeders(supabaseAdmin, groups) {
  const r1 = await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: groups}, {onConflict: 'key'});
  if (r1.error) throw new Error('seed ppp-feeders-v1: ' + r1.error.message);
  const r2 = await supabaseAdmin.from('app_store').upsert({key: 'ppp-breeders-v1', data: []}, {onConflict: 'key'});
  if (r2.error) throw new Error('seed ppp-breeders-v1: ' + r2.error.message);
}

test.describe('Pig batch record-page sequence navigation', () => {
  test('hub tile opens with Prev/Next; Next advances within the visible newest-first sequence', async ({
    page,
    supabaseAdmin,
    resetDb,
  }) => {
    await resetDb();
    await seedFeeders(supabaseAdmin, [group('pig-a', 'P-A'), group('pig-b', 'P-B'), group('pig-c', 'P-C')]);

    await page.goto('/pig/batches');
    await waitForPigFeedersLoaded(page);
    await expect(page.locator('[data-pig-batch-tile]').first()).toBeVisible({timeout: 15_000});
    await page.locator('[data-pig-batch-tile]').first().click();

    await expect(page).toHaveURL(/\/pig\/batches\/pig-c$/, {timeout: 10_000});
    await waitForPigFeedersLoaded(page);
    await expect(page.locator('[data-record-seq-nav="1"]')).toBeVisible();
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeDisabled();

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    const nextAria = await nextBtn.getAttribute('aria-label');
    expect(nextAria).toMatch(/^Next record: /);
    const nextLabel = nextAria.replace(/^Next record: /, '');
    expect(nextLabel).toBe('P-B');

    await nextBtn.click();
    await expect(page).toHaveURL(/\/pig\/batches\/pig-b$/, {timeout: 10_000});
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 3');
    await expect(page.locator('[data-record-seq-prev="1"]')).toBeEnabled();
  });

  test('direct URL open hides the sequence controls', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedFeeders(supabaseAdmin, [group('pig-a', 'P-A'), group('pig-b', 'P-B')]);

    await page.goto('/pig/batches/pig-a');
    await waitForPigFeedersLoaded(page);
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);
  });
});
