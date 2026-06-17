import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Herd filters/sort + organized groups + saved views
// ============================================================================
// Locks the post-build contract for the composable filter chips, ordered sort
// rules, explicit grouped/flat toggle, always-visible organized filter groups,
// the maternal-issue UI retirement, and surface_key=cattle.herds saved views.
// The plain-English "smart filter" assistant was removed (PROJECT.md queue).
// Pure module helpers in src/lib/cattleHerdFilters.js are vitest-locked
// separately.
//
// Coverage:
//   1  default load = grouped view, all 4 active herd tiles visible
//   2  age sort youngest-first orders newest-birth-date cow first within tile
//   3  sex=heifer + age >= 18mo compose; same survivors in grouped + flat
//   4  calved=no in mommas — only the never-calved heifer matches
//   5  blacklist filter — only blacklisted cow matches
//   6  grouped/flat toggle parity — same survivors after a filter
//   7  save a cattle herd view, clear state, re-apply it from the picker
//   9  maternal-issue absence regression — zero /maternal/i text anywhere
//  10  breed chip (always-visible Core group) surfaces historical "Heritage
//      Wagyu" (Codex amend 3)
// ============================================================================

async function waitForLoaded(page) {
  // Wait for both visibility AND a non-zero match count so the seed-vs-render
  // race doesn't leave us reading "0 cattle match" before cattle data lands.
  // Anchored regex — "10 cattle match" trivially contains "0 cattle match"
  // as a substring, so a plain not.toContainText would never settle.
  await expect(page.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-cattle-match-count]')).not.toHaveText(/^0 /, {timeout: 15_000});
}

async function readTagsInOrder(locator) {
  return locator.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-cow-row-tag') || ''));
}

async function expandHerd(page, herd) {
  const tile = page.locator(`[data-herd-tile="${herd}"]`);
  await expect(tile).toBeVisible();
  if ((await tile.getAttribute('data-herd-open')) !== '1') {
    await tile.click();
  }
  await expect(tile).toHaveAttribute('data-herd-open', '1');
}

async function openFilter(page, key) {
  const chip = page.locator(`[data-filter-chip="${key}"]`);
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(`[data-filter-popover="${key}"]`)).toBeVisible();
}

// --------------------------------------------------------------------------
// Test 1 — Default load shows grouped view + 4 active herd tiles
// --------------------------------------------------------------------------
test('default load: grouped view with 4 active herd tiles', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Grouped radio is selected by default.
  await expect(page.locator('input[data-view-mode="grouped"]')).toBeChecked();
  await expect(page.locator('input[data-view-mode="flat"]')).not.toBeChecked();

  // 4 active herd tiles render.
  for (const h of ['mommas', 'backgrounders', 'finishers', 'bulls']) {
    await expect(page.locator(`[data-herd-tile="${h}"]`)).toBeVisible();
  }

  // Outcome herds NOT rendered as expanded tiles by default — they live in
  // the CollapsibleOutcomeSections at the bottom.
  await expect(page.locator('[data-herd-tile="processed"]')).toHaveCount(0);

  // Ensure data is loaded — Mommas has 5 cows in the seed.
  const mommasTile = page.locator('[data-herd-tile="mommas"]');
  await expect(mommasTile).toContainText('5 cows');
});

// --------------------------------------------------------------------------
// Test 2 — Age sort youngest-first orders newest birth_date first
// --------------------------------------------------------------------------
test('age sort youngest-first orders newest birth_date first inside tile', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Add age sort. Adding a non-tag sort replaces the default Tag sort so
  // the visible chip order matches the actual primary sort.
  await page.locator('select[data-sort-add]').selectOption('age');
  const sortRules = page.locator('[data-sort-rule]');
  await expect(sortRules.nth(0)).toHaveAttribute('data-sort-rule', 'age');
  await expect(sortRules).toHaveCount(1);
  // Default dir is asc = youngest first. Verify chip badge.
  const ageRule = page.locator('[data-sort-rule="age"]');
  await expect(ageRule).toBeVisible();
  await expect(ageRule).toHaveAttribute('data-sort-dir', 'asc');

  await expandHerd(page, 'mommas');

  // Mommas seed: M001 (2020-04), M002 (2021-03), M003 (2024-06 — youngest),
  // M004 (2019-02 — oldest), M005 (2022-08).
  // Youngest-first asc order: M003, M005, M002, M001, M004.
  const mommasTile = page.locator('[data-herd-tile="mommas"]').locator('..');
  const cowRows = mommasTile.locator('tr[id^="cow-"]');
  await expect(cowRows).toHaveCount(5);

  // Read tag via data attribute (sibling spans have no whitespace separator
  // so textContent regex would concatenate tag with neighbor cells).
  const tags = await readTagsInOrder(cowRows);
  expect(tags).toEqual(['M003', 'M005', 'M002', 'M001', 'M004']);

  // Flip to desc — oldest first.
  const dirBtn = ageRule.locator('button').first(); // direction button is the first child <button>
  await dirBtn.click();
  await expect(ageRule).toHaveAttribute('data-sort-dir', 'desc');
  const tagsDesc = await readTagsInOrder(cowRows);
  expect(tagsDesc).toEqual(['M004', 'M001', 'M002', 'M005', 'M003']);
});

// --------------------------------------------------------------------------
// Test 3 — sex=heifer + age >= 18mo compose; same survivors in grouped + flat
// --------------------------------------------------------------------------
test('sex + age compose; same survivors across grouped and flat modes', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Open Sex filter; check Heifer.
  await openFilter(page, 'sex');
  await page.locator('[data-filter-popover="sex"] >> text=Heifer').click();
  await page.locator('[data-filter-popover="sex"] >> text=Close').click();

  // Open Age; min 18.
  await openFilter(page, 'ageMonthsRange');
  await page.locator('[data-filter-popover="ageMonthsRange"] input[type="number"]').first().fill('18');
  await page.locator('[data-filter-popover="ageMonthsRange"] >> text=Close').click();

  // Survivors per seed: heifers >=18mo
  //   M003 (~23mo, mommas) ✓
  //   B201 (~20mo, backgrounders) ✓
  //   B202 (~21mo, backgrounders) ✓
  //   B203 (~16mo) ✗
  // Match-count chip:
  await expect(page.locator('[data-cattle-match-count]')).toContainText('3');

  // Verify in grouped tiles.
  await expandHerd(page, 'mommas');
  await expandHerd(page, 'backgrounders');
  const groupedRows = page.locator('tr[id^="cow-"][data-cow-row-tag]');
  const groupedTags = await readTagsInOrder(groupedRows);
  expect(new Set(groupedTags)).toEqual(new Set(['M003', 'B201', 'B202']));

  // Switch to flat.
  await page.locator('input[data-view-mode="flat"]').click();
  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible();
  const flatRows = page.locator('[data-cattle-flat-list] tr[id^="cow-"]');
  await expect(flatRows).toHaveCount(3);
  const flatTags = await readTagsInOrder(flatRows);
  expect(new Set(flatTags)).toEqual(new Set(['M003', 'B201', 'B202']));
});

// --------------------------------------------------------------------------
// Test 4 — Sex popover option alignment
// --------------------------------------------------------------------------
test('choice filter popovers align controls and labels in clean rows', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  async function assertChoiceRows(filterKey, inputType, labels) {
    await openFilter(page, filterKey);
    const popover = page.locator(`[data-filter-popover="${filterKey}"]`);
    const inputBoxes = [];
    const labelBoxes = [];
    for (const [i, label] of labels.entries()) {
      const inputBox = await popover.locator(`input[type="${inputType}"]`).nth(i).boundingBox();
      const labelBox = await popover.getByText(label, {exact: true}).boundingBox();
      expect(inputBox).toBeTruthy();
      expect(labelBox).toBeTruthy();
      inputBoxes.push(inputBox);
      labelBoxes.push(labelBox);
    }

    for (let i = 1; i < inputBoxes.length; i += 1) {
      expect(Math.abs(inputBoxes[i].x - inputBoxes[0].x)).toBeLessThan(1);
      expect(Math.abs(labelBoxes[i].x - labelBoxes[0].x)).toBeLessThan(1);
      expect(labelBoxes[i].height).toBeLessThan(22);
    }
    expect(labelBoxes[0].x - inputBoxes[0].x).toBeLessThan(36);
    await popover.getByText('Close', {exact: true}).click();
  }

  await assertChoiceRows('sex', 'checkbox', ['Cow', 'Heifer', 'Bull', 'Steer']);
  await assertChoiceRows('weightTier', 'radio', [
    'Has weight',
    'No weight',
    'Stale weight (>90 days)',
    'Stale or no weight',
  ]);
});

// --------------------------------------------------------------------------
// Test 5 — calved=no in mommas
// --------------------------------------------------------------------------
test('calved=no in mommas surfaces only the never-calved heifer', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Constrain to mommas explicitly (default already shows active including
  // mommas, but pinning the chip makes the assertion exact).
  await openFilter(page, 'herdSet');
  await page.locator('[data-filter-popover="herdSet"] >> text=Mommas').click();
  await page.locator('[data-filter-popover="herdSet"] >> text=Close').click();

  await openFilter(page, 'calvedStatus');
  await page.locator('[data-filter-popover="calvedStatus"] >> text=Never calved').click();
  await page.locator('[data-filter-popover="calvedStatus"] >> text=Close').click();

  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 ');

  await expandHerd(page, 'mommas');
  const visibleRows = page.locator('[data-herd-tile="mommas"]').locator('..').locator('tr[id^="cow-"]');
  await expect(visibleRows).toHaveCount(1);
  await expect(visibleRows.first()).toContainText('#M003');
});

// --------------------------------------------------------------------------
// Test 5 — blacklist filter
// --------------------------------------------------------------------------
test('blacklist filter surfaces only the blacklisted cow', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await openFilter(page, 'breedingBlacklist');
  await page.locator('[data-filter-popover="breedingBlacklist"] >> text=Only blacklisted').click();
  await page.locator('[data-filter-popover="breedingBlacklist"] >> text=Close').click();

  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 ');

  // Switch to flat to check the single survivor without expanding tiles.
  await page.locator('input[data-view-mode="flat"]').click();
  const flatRows = page.locator('[data-cattle-flat-list] tr[id^="cow-"]');
  await expect(flatRows).toHaveCount(1);
  await expect(flatRows.first()).toContainText('#M004');
});

// --------------------------------------------------------------------------
// Test 6 — grouped/flat toggle parity
// --------------------------------------------------------------------------
test('grouped/flat toggle yields same filtered survivors', async ({page, cattleHerdFiltersScenario}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Apply herd=backgrounders filter.
  await openFilter(page, 'herdSet');
  await page.locator('[data-filter-popover="herdSet"] >> text=Backgrounders').click();
  await page.locator('[data-filter-popover="herdSet"] >> text=Close').click();

  // Grouped: 3 cows under backgrounders tile.
  await expandHerd(page, 'backgrounders');
  const groupedRows = page.locator('[data-herd-tile="backgrounders"]').locator('..').locator('tr[id^="cow-"]');
  await expect(groupedRows).toHaveCount(3);

  // Switch to flat — same 3.
  await page.locator('input[data-view-mode="flat"]').click();
  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-list] tr[id^="cow-"]')).toHaveCount(3);
});

// --------------------------------------------------------------------------
// Test 7 — save a cattle herd view, clear state, re-apply from the picker
// --------------------------------------------------------------------------
test('saves a cattle herd view and re-applies filters/sort/viewMode from the picker', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Build a distinctive state: backgrounders only (3 cows) + flat view.
  await openFilter(page, 'herdSet');
  await page.locator('[data-filter-popover="herdSet"] >> text=Backgrounders').click();
  await page.locator('[data-filter-popover="herdSet"] >> text=Close').click();
  await page.locator('input[data-view-mode="flat"]').click();
  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-list] tr[id^="cow-"]')).toHaveCount(3);

  // Save it as a public view.
  const viewName = 'BG Flat ' + Date.now();
  await page.locator('[data-saved-view-save-open]').click();
  await expect(page.locator('[data-saved-view-form]')).toBeVisible();
  await page.locator('[data-saved-view-name]').fill(viewName);
  await page.locator('[data-saved-view-visibility="public"]').check();
  await page.locator('[data-saved-view-save]').click();

  // The new view becomes the selected option and the form closes.
  await expect(page.locator('[data-saved-view-form]')).toHaveCount(0);
  const optionLabel = viewName + ' · public';
  await expect(page.locator('[data-saved-view-select] option', {hasText: viewName})).toHaveCount(1);

  // Reset to a different state: clear filters + back to grouped.
  await page.locator('input[data-view-mode="grouped"]').click();
  await page.locator('text=Clear all filters').click();
  await expect(page.locator('[data-cattle-match-count]')).not.toContainText(/^3 /);
  await expect(page.locator('input[data-view-mode="grouped"]')).toBeChecked();

  // Re-apply: deselect, then pick the saved view by label. Selecting restores
  // filters (backgrounders → 3) and viewMode (flat).
  await page.locator('[data-saved-view-select]').selectOption('');
  await page.locator('[data-saved-view-select]').selectOption({label: optionLabel});
  await expect(page.locator('input[data-view-mode="flat"]')).toBeChecked();
  await expect(page.locator('[data-cattle-flat-list]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-list] tr[id^="cow-"]')).toHaveCount(3);

  // Owner controls (update/delete) are available for an owned view.
  await expect(page.locator('[data-saved-view-update]')).toBeVisible();
  await expect(page.locator('[data-saved-view-delete]')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 9 — maternal-issue UI absence regression
// --------------------------------------------------------------------------
test('maternal-issue text absent from herd view, expanded cow detail, and Add modal', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Page-level scrub.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.toLowerCase()).not.toContain('maternal');

  // Cow record page — a cow-row click now routes to the record page (record
  // extraction). Open one and re-scan.
  await expandHerd(page, 'mommas');
  const firstCow = page.locator('[data-herd-tile="mommas"]').locator('..').locator('tr[id^="cow-"]').first();
  await firstCow.click();
  await expect(page).toHaveURL(/\/cattle\/herds\/.+/);
  const recordText = await page.locator('body').innerText();
  expect(recordText.toLowerCase()).not.toContain('maternal');

  // Back on the list, open the Add Cow modal and scan it.
  await page.goto('/cattle/herds');
  await waitForLoaded(page);
  await page.getByRole('button', {name: '+ Add Cow'}).click();
  const modalText = await page.locator('body').innerText();
  expect(modalText.toLowerCase()).not.toContain('maternal');
});

// --------------------------------------------------------------------------
// Test 10 — historical breed surfaces in filter dropdown
// --------------------------------------------------------------------------
test('breed filter dropdown includes historical "Heritage Wagyu" present on cow but not in cattle_breeds', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Breed lives in the always-visible Core group now (no More-filters toggle).
  await page.locator('[data-filter-chip="breed"]').click();
  const popover = page.locator('[data-filter-popover="breed"]');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Heritage Wagyu');
  await expect(popover).toContainText('(historical)');
});

// --------------------------------------------------------------------------
// Test 11 — Non-calving "No calf since" date is the only control (no checkbox)
// --------------------------------------------------------------------------
test('No calf since date filters mature cows incl. those that calved before the cutoff', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // The non-calving control is a single "No calf since" date — no checkbox.
  await openFilter(page, 'nonCalving');
  await expect(page.locator('[data-cattle-special-filter-checkbox="nonCalvingCows"]')).toHaveCount(0);
  await page.locator('[data-cattle-noncalving-cutoff]').fill('2026-01-01');
  await page.locator('[data-filter-popover="nonCalving"] >> text=Close').click();

  // Mature mommas whose last calving is missing or before 2026-01-01:
  //   M002 (calved 2025-05), M004 (calved 2023-06 — past, before cutoff),
  //   M005 (calved 2024-09). M001 calved 2026-04 (after cutoff) is excluded;
  //   M003 heifer is not yet 30 months old.
  await expect(page.locator('[data-cattle-match-count]')).toContainText('3 cattle match');
});

// --------------------------------------------------------------------------
// Test 12 — Unmatched Calves checkbox (Lineage/Other) still filters correctly
// --------------------------------------------------------------------------
test('Unmatched Calves checkbox filters to calves missing a dam', async ({
  page,
  supabaseAdmin,
  cattleHerdFiltersScenario,
}) => {
  // Seed one unmatched calf: no dam, born within the last 4 months.
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  await supabaseAdmin.from('cattle').upsert(
    {
      id: 'cow-unmatched-uc900',
      tag: 'UC900',
      sex: 'heifer',
      herd: 'backgrounders',
      breed: 'Angus',
      breeding_blacklist: false,
      birth_date: recent,
      dam_tag: null,
      old_tags: [],
      deleted_at: null,
      deleted_by: null,
      processing_batch_id: null,
    },
    {onConflict: 'id'},
  );

  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Checkbox-style filter in Lineage/Other (not a pill chip).
  await page.locator('[data-cattle-special-filter-checkbox="unmatchedCalves"]').check();
  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 match');

  await page.locator('input[data-view-mode="flat"]').click();
  await expect(page.locator('[data-cattle-flat-list] tr[id^="cow-"]')).toHaveCount(1);
  await expect(page.locator('[data-cattle-flat-list] tr[id^="cow-"]').first()).toContainText('#UC900');
});
