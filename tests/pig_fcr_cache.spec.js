import {test, expect} from './fixtures.js';

// ============================================================================
// Pig FCR cache spec — Phase A9
// ============================================================================
// Closes the §7 contract A4 explicitly deferred:
//
//   `parent.fcrCached` clear-on-null contract. computePigBatchFCR returns
//   null when no valid trips remain or rawFeed ≤ credits. Both
//   persistTrip and deleteTrip MUST `delete next.fcrCached` (not leave
//   the previous value, not assign null) when the helper returns null,
//   so the transfer flow's `parent.fcrCached || 3.5` falls back to the
//   default rather than a stale ratio.
//
// 3 tests, all driving the contract through the UI:
//
//   1  Edit Trip → close populates parent.fcrCached when helper returns
//      a number. Also asserts the spread-then-merge path at
//      PigBatchesView.jsx:396-397 preserves non-empty subAttributions
//      metadata (Codex review: empty arrays trivially "preserve"
//      themselves; non-empty seed actually exercises the spread).
//
//   2  Edit Trip → close DELETES the key (Object.hasOwn=false, not null)
//      when adjFeed ≤ credits. Pre-seeds a deliberately-stale 9.99 cached
//      value so a regression that assigns null instead of deleting fails
//      with a precise diff against 9.99.
//
//   3  Delete Trip → confirm DELETES the key when no valid trips remain.
//      Drives the real DeleteModal because PigBatchesView's deleteTrip
//      uses the confirmDelete prop directly (not window._wcfConfirmDelete),
//      so a window stub wouldn't intercept.
// ============================================================================

// Pig batch tiles on /pig/batches don't use .hoverable-tile and don't
// click-to-expand — trips render unconditionally inside the always-open
// batch tile (PigBatchesView.jsx:836+). The trip row contains the
// formatted date + "N pigs" + an Edit button (line 1125). The batch
// header ALSO has an Edit button (line 861), so selectors must scope
// to the trip-row container.
function tripRow(page, formattedDate, pigCount) {
  return page
    .locator('div')
    .filter({hasText: new RegExp(formattedDate.replace(/\//g, '\\/'))})
    .filter({hasText: `${pigCount} pigs`})
    .filter({has: page.getByRole('button', {name: 'Edit', exact: true})})
    .last(); // deepest = the trip-row div itself
}

// Edit Trip modal — scope by combining title + Delete-in-footer; the
// title-only locator lands on the title <div> which doesn't contain
// the footer's Delete button.
function tripEditModal(page) {
  return page
    .locator('div')
    .filter({hasText: 'Edit Processing Trip'})
    .filter({has: page.getByRole('button', {name: 'Delete', exact: true})})
    .last();
}

async function readSeededBatch(supabaseAdmin) {
  const r = await supabaseAdmin.from('app_store').select('data').eq('key', 'ppp-feeders-v1').single();
  if (r.error) throw new Error(`readSeededBatch: ${r.error.message}`);
  return (r.data?.data || [])[0];
}

// --------------------------------------------------------------------------
// Test 1 — Edit → close populates fcrCached, preserves subAttributions
// --------------------------------------------------------------------------
test('persistTrip populates fcrCached on close, preserves subAttributions', async ({
  page,
  pigFCRScenario,
  supabaseAdmin,
}) => {
  const {batchName, tripId, seededSubAttributions, expected} = await pigFCRScenario({
    withCredits: false,
    withCachedValue: false,
  });

  // Sanity: pre-condition is fcrCached UNSET (key absent).
  const before = await readSeededBatch(supabaseAdmin);
  expect(Object.hasOwn(before, 'fcrCached')).toBe(false);
  expect(before.processingTrips[0].subAttributions).toEqual(seededSubAttributions);

  await page.goto('/pig/batches/fg-test-fcr-01');

  // Trip row visible = batch loaded. Date is fmt('2026-04-01') = '04/01/26'.
  const row = tripRow(page, '04/01/26', 3);
  await expect(row).toBeVisible({timeout: 15_000});
  await row.getByRole('button', {name: 'Edit', exact: true}).click();

  // Edit modal opens. Title is 'Edit Processing Trip' (PigBatchesView.jsx:1056).
  const modalTitle = page.getByText(/Edit Processing Trip/);
  await expect(modalTitle).toBeVisible({timeout: 5_000});

  // Close via × button (PigBatchesView.jsx:1057). closeTripForm flushes
  // through persistTrip when tripForm.date is set (it is — populated from
  // the existing trip).
  await page.getByRole('button', {name: '×'}).click();
  await expect(modalTitle).toHaveCount(0, {timeout: 5_000});

  // Poll for fcrCached to populate.
  await expect
    .poll(
      async () => {
        const b = await readSeededBatch(supabaseAdmin);
        return b.fcrCached;
      },
      {timeout: 10_000, message: 'fcrCached did not populate after Edit Trip close'},
    )
    .toBe(expected.fcrPopulated);

  // Stronger assertions:
  const after = await readSeededBatch(supabaseAdmin);
  expect(Object.hasOwn(after, 'fcrCached')).toBe(true);
  expect(after.fcrCached).toBe(2.0); // 600 raw / 300 live, no credits

  // The spread-then-merge contract: subAttributions on the existing trip
  // must survive the edit-close round-trip even though they aren't a form
  // field (PigBatchesView.jsx:396-397 spreads `existing` first).
  const trip = after.processingTrips.find((t) => t.id === tripId);
  expect(trip).toBeTruthy();
  expect(trip.subAttributions).toEqual(seededSubAttributions);
});

// --------------------------------------------------------------------------
// Test 2 — Edit → close DELETES key when adjFeed ≤ credits
// --------------------------------------------------------------------------
test('persistTrip deletes fcrCached (not null) when adjFeed reaches zero via credits', async ({
  page,
  pigFCRScenario,
  supabaseAdmin,
}) => {
  await pigFCRScenario({withCredits: true, withCachedValue: true});

  // Sanity: pre-condition has the stale value present.
  const before = await readSeededBatch(supabaseAdmin);
  expect(Object.hasOwn(before, 'fcrCached')).toBe(true);
  expect(before.fcrCached).toBe(9.99);

  await page.goto('/pig/batches/fg-test-fcr-01');

  const row = tripRow(page, '04/01/26', 3);
  await expect(row).toBeVisible({timeout: 15_000});
  await row.getByRole('button', {name: 'Edit', exact: true}).click();

  await expect(page.getByText(/Edit Processing Trip/)).toBeVisible({timeout: 5_000});
  await page.getByRole('button', {name: '×'}).click();
  await expect(page.getByText(/Edit Processing Trip/)).toHaveCount(0, {timeout: 5_000});

  // Poll for the key to disappear. Object.hasOwn covers the key-DELETED
  // contract specifically — `fcrCached === null` would still pass an
  // `=== undefined` test under JSON round-trip, but Object.hasOwn would
  // return true for a null-assigned key.
  await expect
    .poll(
      async () => {
        const b = await readSeededBatch(supabaseAdmin);
        return Object.hasOwn(b, 'fcrCached');
      },
      {timeout: 10_000, message: 'fcrCached key was not deleted (still in object)'},
    )
    .toBe(false);

  // Belt-and-braces. A regression that assigned `null` instead of
  // deleting would fail all three of the next assertions: hasOwn=true,
  // `in` returns true, and `null !== undefined`. hasOwn is the most
  // contract-aligned because it tests the JSON shape directly — the
  // §7 rule is specifically about the key's presence, not its value.
  const after = await readSeededBatch(supabaseAdmin);
  expect(Object.hasOwn(after, 'fcrCached')).toBe(false);
  expect('fcrCached' in after).toBe(false);
  expect(after.fcrCached).toBeUndefined();
  // Confirm the regression-distinct stale value is genuinely gone (not
  // hiding under a typo or shadowed key).
  expect(after.fcrCached).not.toBe(9.99);
});

// --------------------------------------------------------------------------
// Test 3 — Delete Trip clears the key (real DeleteModal)
// --------------------------------------------------------------------------
test('deleteTrip deletes fcrCached when last trip is removed', async ({page, pigFCRScenario, supabaseAdmin}) => {
  const {tripId} = await pigFCRScenario({
    withCredits: false,
    withCachedValue: true, // pre-seed cached so we can verify the delete
  });

  // Pre-condition: cached value present, 1 trip exists.
  const before = await readSeededBatch(supabaseAdmin);
  expect(Object.hasOwn(before, 'fcrCached')).toBe(true);
  expect(before.processingTrips).toHaveLength(1);
  expect(before.processingTrips[0].id).toBe(tripId);

  await page.goto('/pig/batches/fg-test-fcr-01');

  const row = tripRow(page, '04/01/26', 3);
  await expect(row).toBeVisible({timeout: 15_000});

  // Open Edit Trip modal first — the modal footer's red Delete is the
  // path Codex specified for driving the real DeleteModal. (The trip-row
  // Delete button at PigBatchesView.jsx:1126 hits the same deleteTrip
  // handler, but the modal-footer path is the canonical edit-flow exit.)
  await row.getByRole('button', {name: 'Edit', exact: true}).click();
  await expect(page.getByText(/Edit Processing Trip/)).toBeVisible({timeout: 5_000});

  // Click Delete in the modal footer. Multiple "Delete" buttons exist
  // on the page (modal footer + trip-row Delete in the background +
  // soon, the DeleteModal's own red Delete). Scope by combining title +
  // Delete-button-descendant — title-only would land on the title div
  // which doesn't contain the footer.
  const modal = tripEditModal(page);
  await modal.getByRole('button', {name: 'Delete', exact: true}).click();

  // Real DeleteModal — PigBatchesView's deleteTrip calls the confirmDelete
  // prop directly, not window._wcfConfirmDelete, so a window stub wouldn't
  // intercept. Drive the actual modal: type "delete" + Enter (per
  // DeleteModal.jsx:22 keyboard handler).
  await expect(page.getByText('Are you sure?')).toBeVisible({timeout: 5_000});
  await page.getByPlaceholder('delete').fill('delete');
  await page.keyboard.press('Enter');

  // Poll for the trip to be removed AND the cache key to be deleted.
  // Both happen in the same setNextFeeders call, but polling on the
  // composite gives a single clear failure message if either side fails.
  await expect
    .poll(
      async () => {
        const b = await readSeededBatch(supabaseAdmin);
        return {
          tripCount: b.processingTrips?.length ?? null,
          hasFcr: Object.hasOwn(b, 'fcrCached'),
        };
      },
      {timeout: 10_000, message: 'deleteTrip did not remove trip and clear fcrCached'},
    )
    .toEqual({tripCount: 0, hasFcr: false});

  // Final state assertions for clarity in failure output.
  const after = await readSeededBatch(supabaseAdmin);
  expect(after.processingTrips).toEqual([]);
  expect(Object.hasOwn(after, 'fcrCached')).toBe(false);
  expect(after.fcrCached).toBeUndefined();
});
