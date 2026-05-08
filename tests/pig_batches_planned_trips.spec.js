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
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

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
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

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
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

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
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

  const band = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(band).toBeVisible({timeout: 15_000});
  await expect(band).toContainText('Link a breeding cycle');
  await expect(band.locator('[data-planned-trip-id]')).toHaveCount(0);
});

test('Admin date edit: changing a planned trip date updates the projection', async ({supabaseAdmin, resetDb, page}) => {
  await resetDb();
  // Two manual planned trips at +30 and +90 days, 6 gilts each.
  const today = new Date();
  const inDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  await seedFeederGraph(supabaseAdmin, {
    plannedProcessingTrips: [
      {id: 'pt-edit-1', date: inDays(30), sex: 'gilt', subBatchId: SUB_GILTS_ID, plannedCount: 6, order: 0},
      {id: 'pt-edit-2', date: inDays(90), sex: 'gilt', subBatchId: SUB_GILTS_ID, plannedCount: 6, order: 1},
    ],
  });
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

  const editCard = page.locator('[data-planned-trip-id="pt-edit-1"]');
  await expect(editCard).toBeVisible({timeout: 15_000});
  // Capture initial avg text. Format: "~NNN lb avg".
  const beforeText = await editCard.textContent();
  const beforeMatch = beforeText.match(/~(\d+) lb avg/);
  expect(beforeMatch, 'expected ~NNN lb avg in initial card').not.toBeNull();
  const beforeAvg = parseInt(beforeMatch[1]);

  // Open the inline date editor and push the date 90 days further out.
  await editCard.locator('[data-planned-trip-edit-date="pt-edit-1"]').click();
  const dateInput = editCard.locator('input[type="date"]');
  await dateInput.fill(inDays(120));
  await editCard.locator('[data-planned-trip-save-date="pt-edit-1"]').click();

  // Projection must increase: more days × ADG → heavier projected avg.
  const afterText = await page.locator('[data-planned-trip-id="pt-edit-1"]').textContent();
  const afterMatch = afterText.match(/~(\d+) lb avg/);
  const afterAvg = parseInt(afterMatch[1]);
  expect(afterAvg).toBeGreaterThan(beforeAvg);
});

test('Admin count move: −1 → next preserves total and toggles the under-5 chip', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  const today = new Date();
  const inDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // 6 + 6 starts within bounds (no Under 5 chip on either).
  await seedFeederGraph(supabaseAdmin, {
    plannedProcessingTrips: [
      {id: 'pt-mv-1', date: inDays(30), sex: 'gilt', subBatchId: SUB_GILTS_ID, plannedCount: 6, order: 0},
      {id: 'pt-mv-2', date: inDays(60), sex: 'gilt', subBatchId: SUB_GILTS_ID, plannedCount: 6, order: 1},
    ],
  });
  await seedManualGlobalAdg(supabaseAdmin, 1.5);

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

  const card1 = page.locator('[data-planned-trip-id="pt-mv-1"]');
  const card2 = page.locator('[data-planned-trip-id="pt-mv-2"]');
  await expect(card1).toBeVisible({timeout: 15_000});
  await expect(card1).toContainText('6 gilts');
  await expect(card2).toContainText('6 gilts');
  // Neither card has the under-5 chip.
  await expect(card1).not.toContainText('Under 5');
  await expect(card2).not.toContainText('Under 5');

  // Pig planned trips lane: forward = current → next (lightest pig from
  // current's rank window). First trip has forward only.
  await card1.locator('[data-planned-trip-move-forward="pt-mv-1"]').click();
  await expect(card1).toContainText('5 gilts'); // 6 - 1
  await page.locator('[data-planned-trip-id="pt-mv-1"]').locator('[data-planned-trip-move-forward="pt-mv-1"]').click();
  await expect(page.locator('[data-planned-trip-id="pt-mv-1"]')).toContainText('4 gilts'); // 5 - 1
  await expect(page.locator('[data-planned-trip-id="pt-mv-2"]')).toContainText('8 gilts'); // 6 + 2
  // Total preserved.
  // Under-5 chip now on card 1.
  await expect(page.locator('[data-planned-trip-id="pt-mv-1"]')).toContainText('Under 5');

  // Pig planned trips lane: back = current → previous (heaviest pig from
  // current's rank window). Last trip has back only. Move 1 from card 2
  // back to card 1 via card 2's back button. Sum still 12.
  await page.locator('[data-planned-trip-id="pt-mv-2"]').locator('[data-planned-trip-move-back="pt-mv-2"]').click();
  await expect(page.locator('[data-planned-trip-id="pt-mv-1"]')).toContainText('5 gilts');
  await expect(page.locator('[data-planned-trip-id="pt-mv-2"]')).toContainText('7 gilts');
  // Under-5 chip cleared from card 1.
  await expect(page.locator('[data-planned-trip-id="pt-mv-1"]')).not.toContainText('Under 5');
});

test('Add Batch dropdown hides breeding cycles already linked to an existing pig batch (commit 5)', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  // Seed two breeding cycles. cy-linked is wired to the existing P-26-09
  // batch via feederGroup.cycleId; cy-free has no link. The dropdown
  // filter should hide cy-linked from the Add Batch options and show
  // cy-free.
  const linkedCycle = {id: 'cy-linked', group: '1', exposureStart: '2025-12-20', sowCount: 5};
  const freeCycle = {id: 'cy-free', group: '2', exposureStart: '2026-01-15', sowCount: 4};
  // Override the seedFeederGraph defaults to point the existing batch
  // at cy-linked (matches the seed's CYCLE_ID by switching to
  // cy-linked here).
  const giltSub = {
    id: SUB_GILTS_ID,
    name: SUB_GILTS_NAME,
    giltCount: 12,
    boarCount: 0,
    originalPigCount: 12,
    legacyFeedLbs: 0,
    status: 'active',
  };
  const group = {
    id: PARENT_ID,
    batchName: PARENT_BATCH,
    cycleId: 'cy-linked',
    giltCount: 12,
    boarCount: 0,
    originalPigCount: 12,
    startDate: '2026-06-01',
    legacyFeedLbs: 0,
    status: 'active',
    subBatches: [giltSub],
    processingTrips: [],
    pigMortalities: [],
    plannedProcessingTrips: [],
  };
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: [group]}, {onConflict: 'key'});
  await supabaseAdmin
    .from('app_store')
    .upsert({key: 'ppp-breeding-v1', data: [linkedCycle, freeCycle]}, {onConflict: 'key'});
  await supabaseAdmin.from('app_store').upsert(
    {key: 'ppp-farrowing-v1', data: [{id: 'f-pt-09', group: '1', farrowingDate: FARROW_DATE}]},
    {
      onConflict: 'key',
    },
  );
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-breeders-v1', data: []}, {onConflict: 'key'});

  await page.goto('/pig/batches');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

  // Open the Add Batch modal. The button is rendered in the existing
  // PigBatchesView header area.
  await page
    .getByRole('button', {name: /add batch/i})
    .first()
    .click();

  const cycleSelect = page.locator('select[data-feeder-cycle-select]');
  await expect(cycleSelect).toBeVisible({timeout: 5_000});
  // Read the option values exposed by the select.
  const optionValues = await cycleSelect
    .locator('option')
    .evaluateAll((els) => els.map((el) => el.getAttribute('value')));
  // Includes the placeholder "" and only the unlinked cycle.
  expect(optionValues).toEqual(['', 'cy-free']);
  // Empty-state hint must NOT appear (cy-free is available).
  await expect(page.locator('[data-feeder-cycle-empty-hint]')).toHaveCount(0);
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
  // Wait for the parent batch tile to render before any band/card checks.
  // This is the deterministic signal that feederGroups loaded and the
  // sub-row map ran (the planned-trip band is a sibling of the sub-row).
  // Without this gate, the band-visibility assertion can race the
  // PigContext load on first navigation after resetDb.
  await expect(page.locator(`text=${PARENT_BATCH}`).first()).toBeVisible({timeout: 15_000});

  const band = page.locator(`[data-planned-trips-sub="${SUB_GILTS_ID}"]`);
  await expect(band).toBeVisible({timeout: 15_000});
  // Exactly 1 card (the seeded one); auto-allocation kept hands off.
  const cards = band.locator('[data-planned-trip-id]');
  await expect(cards).toHaveCount(1, {timeout: 10_000});
  await expect(cards.first()).toContainText('4 gilts');
  // 4 < min 5 → undersized chip visible.
  await expect(cards.first()).toContainText(`Under ${5}`);
});
