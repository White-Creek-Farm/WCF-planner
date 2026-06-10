import {test, expect} from './fixtures.js';
import {waitForPigFeedersLoaded} from './helpers/pigReady.js';

// ============================================================================
// CP3+CP4 smoke: pig.batch hub (nav-only tiles) -> record-page navigation.
// Verifies the URL-branch restructure end to end — hub tiles render with the
// ledger current count, a tile click routes to /pig/batches/<id> and mounts the
// full workspace card, and an unknown id shows the not-found state. Detailed
// workspace coverage (planned trips, FCR, batch math) lives in the sibling
// pig_batches_planned_trips / pig_fcr_cache / pig_batch_math specs.
// ============================================================================

const G1 = 'cp3-smoke-g1';
const G2 = 'cp3-smoke-g2';

const groups = [
  {
    id: G1,
    batchName: 'P-26-91',
    cycleId: '',
    giltCount: 10,
    boarCount: 6,
    originalPigCount: 16,
    startDate: '2026-01-10',
    status: 'active',
    perLbFeedCost: 0.3,
    legacyFeedLbs: 0,
    feedAllocatedToTransfers: 0,
    pigMortalities: [
      {
        id: 'm1',
        date: '2026-02-01',
        sub_batch_id: 'cp3a',
        sub_batch_name: 'P-26-91A',
        count: 1,
        comment: '',
        team_member: 'test',
      },
    ],
    processingTrips: [],
    subBatches: [
      {
        id: 'cp3a',
        name: 'P-26-91A',
        status: 'active',
        giltCount: 10,
        boarCount: 0,
        originalPigCount: 10,
        legacyFeedLbs: 0,
      },
      {
        id: 'cp3b',
        name: 'P-26-91B',
        status: 'active',
        giltCount: 0,
        boarCount: 6,
        originalPigCount: 6,
        legacyFeedLbs: 0,
      },
    ],
  },
  {
    id: G2,
    batchName: 'P-26-92',
    cycleId: '',
    giltCount: 8,
    boarCount: 0,
    originalPigCount: 8,
    startDate: '2026-02-20',
    status: 'active',
    perLbFeedCost: 0.3,
    legacyFeedLbs: 0,
    feedAllocatedToTransfers: 0,
    pigMortalities: [],
    processingTrips: [],
    subBatches: [],
  },
];

async function seed(supabaseAdmin) {
  const {error} = await supabaseAdmin
    .from('app_store')
    .upsert({key: 'ppp-feeders-v1', data: groups}, {onConflict: 'key'});
  if (error) throw new Error(`seed ppp-feeders-v1: ${error.message}`);
}

test('pig.batch hub tiles navigate to the record page; unknown id is not-found', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seed(supabaseAdmin);

  // Hub: nav-only tiles with the ledger current count (G1 = 10 + 6 − 1 = 15).
  await page.goto('/pig/batches');
  await waitForPigFeedersLoaded(page);
  const tile1 = page.locator(`[data-pig-batch-tile="${G1}"]`);
  await expect(tile1).toBeVisible({timeout: 15_000});
  await expect(page.locator(`[data-pig-batch-tile="${G2}"]`)).toBeVisible();
  // Unified-grid redesign: metric labels live once in the header row, so a
  // batch row no longer repeats "Current:" inline — the grid header carries the
  // label and the row shows the ledger current count (15) in the Current column.
  await expect(page.locator('[data-pig-batch-grid="1"]')).toContainText('Current');
  await expect(tile1).toContainText('15');

  // Tile click routes to the record page and mounts the full workspace card.
  await tile1.click();
  await expect(page).toHaveURL(new RegExp(`/pig/batches/${G1}$`));
  await expect(page.locator('text=P-26-91').first()).toBeVisible({timeout: 15_000});
  await expect(page.getByRole('button', {name: /Back to Pig Batches/})).toBeVisible();
  // Sub-batch rows render on the record page (workspace moved here).
  await expect(page.locator('text=P-26-91A').first()).toBeVisible();
  // CP5: Comments + collapsed Activity collaboration section renders here.
  await expect(page.locator('[data-record-collaboration-section]').first()).toBeVisible({timeout: 15_000});

  // Mobile viewport still renders the record workspace.
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(`/pig/batches/${G1}`);
  await waitForPigFeedersLoaded(page);
  await expect(page.locator('text=P-26-91').first()).toBeVisible({timeout: 15_000});

  // Unknown id → not-found state.
  await page.goto('/pig/batches/does-not-exist');
  await waitForPigFeedersLoaded(page);
  await expect(page.locator('text=Batch not found').first()).toBeVisible({timeout: 15_000});
});
