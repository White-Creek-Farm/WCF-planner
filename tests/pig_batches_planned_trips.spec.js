import {test, expect} from './fixtures.js';

// ============================================================================
// Pig Batches planned-trip forecast UI (commit 4a, read-only)
// ============================================================================
// 4a covers: Global ADG control (admin edit + system-estimate display),
// auto-allocation of plannedProcessingTrips for sex-clean subs with linked
// breeding cycles, and read-only card render with projections + warnings.
// Date/count edit controls land in commit 4b and are NOT exercised here.
//
// Auto-allocation is gated and idempotent (Codex Q2):
//   - linked breeding cycle
//   - usable global/manual ADG
//   - usable cycle age
//   - positive remaining count
//   - sexed subgroup (no auto for mixed gilt+boar subs)
//   - no existing plannedProcessingTrips for that (subBatchId, sex) pair
// ============================================================================

const PARENT_BATCH = 'P-26-09';
const SUB_GILTS_NAME = 'P-26-09A';
const SUB_GILTS_ID = 'sub-pt-09a';
const SUB_MIXED_NAME = 'P-26-09M';
const SUB_MIXED_ID = 'sub-pt-09m';
const PARENT_ID = 'group-pt-09';
const CYCLE_ID = 'cy-pt-09';
const FARROW_DATE = '2026-04-15';

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seedFeederGraph(supabaseAdmin, opts = {}) {
  const giltSub = {
    id: SUB_GILTS_ID,
    name: SUB_GILTS_NAME,
    giltCount: 12,
    boarCount: 0,
    originalPigCount: 12,
    legacyFeedLbs: 0,
    status: 'active',
  };
  const mixedSub = {
    id: SUB_MIXED_ID,
    name: SUB_MIXED_NAME,
    giltCount: 6,
    boarCount: 4,
    originalPigCount: 10,
    legacyFeedLbs: 0,
    status: 'active',
  };
  const subs = opts.includeMixed ? [giltSub, mixedSub] : [giltSub];
  const group = {
    id: PARENT_ID,
    batchName: PARENT_BATCH,
    cycleId: opts.cycleId === undefined ? CYCLE_ID : opts.cycleId,
    giltCount: giltSub.giltCount + (opts.includeMixed ? mixedSub.giltCount : 0),
    boarCount: opts.includeMixed ? mixedSub.boarCount : 0,
    originalPigCount: giltSub.originalPigCount + (opts.includeMixed ? mixedSub.originalPigCount : 0),
    startDate: '2026-06-01',
    legacyFeedLbs: 0,
    status: 'active',
    subBatches: subs,
    processingTrips: [],
    pigMortalities: [],
    plannedProcessingTrips: opts.plannedProcessingTrips || [],
  };
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: [group]}, {onConflict: 'key'});

  // Cycle exposureStart 2025-12-20 → farrowing window 2026-04-15..2026-05-29.
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-breeding-v1',
      data: opts.cycleId === null ? [] : [{id: CYCLE_ID, group: '1', exposureStart: '2025-12-20', sowCount: 5}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-farrowing-v1',
      data: [{id: 'f-pt-09', group: '1', farrowingDate: FARROW_DATE}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-breeders-v1', data: []}, {onConflict: 'key'});
}

async function seedManualGlobalAdg(supabaseAdmin, value) {
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-pig-global-adg-v1',
      data: {manualValue: value, updatedAt: new Date().toISOString(), updatedBy: null},
    },
    {onConflict: 'key'},
  );
}

test('Global ADG control: admin sees edit affordance; manual value displays the override badge', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin);
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Manual ADG value visible.
  await expect(page.locator('text=1.50 lb/day').first()).toBeVisible({timeout: 15_000});
  await expect(page.locator('text=MANUAL').first()).toBeVisible();
  // Admin sees the Edit button.
  await expect(page.getByRole('button', {name: 'Edit'}).first()).toBeVisible();
});

test('Pre-weigh-in: planned trips render from cycle age + Global ADG when no weights exist', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin);
  await seedManualGlobalAdg(supabaseAdmin, 1.2);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The auto-allocation effect writes plannedProcessingTrips on first
  // render. Wait for the planned trips band to appear for the gilt sub.
  const band = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(band).toBeVisible({timeout: 15_000});
  // 12 gilts at maxSize 12 → exactly 1 trip card.
  const cards = band.locator('[data-planned-trip-id]');
  await expect(cards).toHaveCount(1, {timeout: 10_000});
  await expect(cards.first()).toContainText('12 gilts');
  // The card surfaces a projected weight range and an avg.
  await expect(cards.first()).toContainText(/\d+\s+–\s+\d+\s+lb/);
});

test('Mixed-sex sub renders the split warning and does NOT auto-allocate', async ({supabaseAdmin, resetDb, page}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin, {includeMixed: true});
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const mixedBand = page.locator(`[data-planned-trips-sub="${SUB_MIXED_ID}"]`);
  await expect(mixedBand).toBeVisible({timeout: 15_000});
  await expect(mixedBand).toContainText('Mixed sex sub');
  // No trip cards on the mixed sub.
  await expect(mixedBand.locator('[data-planned-trip-id]')).toHaveCount(0);

  // Confirm the gilt sub on the same parent still got its allocation.
  const giltBand = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(giltBand.locator('[data-planned-trip-id]')).toHaveCount(1, {timeout: 10_000});
});

test('No cycle linkage renders the link-cycle hint and does NOT auto-allocate', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  // Pass null cycleId via group override so feederGroup.cycleId is unset.
  // seedFeederGraph creates the feederGroup with cycleId=null when we
  // pass cycleId:null.
  await seedFeederGraph(supabaseAdmin, {cycleId: null});
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const band = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(band).toBeVisible({timeout: 15_000});
  await expect(band).toContainText('Link a breeding cycle');
  await expect(band.locator('[data-planned-trip-id]')).toHaveCount(0);
});

test('Existing plannedProcessingTrips are NOT regenerated by auto-allocation', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  // Seed with a single manual planned trip already in place: 4 gilts on a
  // specific date. Auto-allocation should NOT add more for this (sub, sex)
  // pair since trips already exist. The under-5 warning chip should fire.
  const manualPlanned = [
    {
      id: 'pt-manual-1',
      date: isoDaysAgo(-90), // 90 days from today
      sex: 'gilt',
      subBatchId: SUB_GILTS_ID,
      plannedCount: 4,
      order: 0,
    },
  ];
  await seedFeederGraph(supabaseAdmin, {plannedProcessingTrips: manualPlanned});
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const band = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(band).toBeVisible({timeout: 15_000});
  // Exactly 1 card (the seeded one); auto-allocation kept hands off.
  const cards = band.locator('[data-planned-trip-id]');
  await expect(cards).toHaveCount(1, {timeout: 10_000});
  await expect(cards.first()).toContainText('4 gilts');
  // 4 < min 5 → undersized chip visible.
  await expect(cards.first()).toContainText(`Under ${5}`);
});
