import {test, expect} from './fixtures.js';

// ============================================================================
// Cattle Herd filters/sort + organized groups + saved views
// ============================================================================
// Locks the post-build contract for the composable filter chips, ordered sort
// rules, always-visible organized filter groups, the column/display picker, the
// maternal-issue UI retirement, and surface_key=cattle.herds saved views.
// Default view is grouped by herd. An active filter/search switches to one flat
// matched-results table; a non-default sort re-orders cattle within the herd
// groups (it does not collapse them).
// Pure module helpers in src/lib/cattleHerdFilters.js are vitest-locked
// separately.
// ============================================================================

async function waitForLoaded(page) {
  // Wait for both visibility AND a non-zero match count so the seed-vs-render
  // race doesn't leave us reading "0 cattle match" before cattle data lands.
  // Anchored regex — "10 cattle match" trivially contains "0 cattle match"
  // as a substring, so a plain not.toContainText would never settle.
  await expect(page.locator('[data-cattle-match-count]')).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-cattle-match-count]')).not.toHaveText(/^0 /, {timeout: 15_000});
}

function flatRows(page) {
  return page.locator('[data-cattle-flat-list] tr[id^="cow-"]');
}

function cattleRows(page) {
  return page.locator('tr[id^="cow-"]');
}

async function readTagsInOrder(locator) {
  return locator.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-cow-row-tag') || ''));
}

// Compact-controls model: Saved views / Filters / Sort / Columns each live
// behind a single-open toggle panel (only one open at a time). Helpers below
// ensure the relevant panel is open before interacting with its controls.
const TOOL_PANEL_TOGGLE = {
  savedViews: '[data-cattle-herds-saved-views-toggle="1"]',
  filters: '[data-cattle-herds-filters-toggle="1"]',
  sort: '[data-cattle-herds-sort-toggle="1"]',
  columns: '[data-cattle-herds-columns-toggle="1"]',
};

async function ensureToolPanel(page, name) {
  const btn = page.locator(TOOL_PANEL_TOGGLE[name]);
  await expect(btn).toBeVisible();
  if ((await btn.getAttribute('aria-expanded')) !== 'true') {
    await btn.click();
  }
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
}

async function openFilter(page, key) {
  await ensureToolPanel(page, 'filters');
  const chip = page.locator(`[data-filter-chip="${key}"]`);
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(`[data-filter-popover="${key}"]`)).toBeVisible();
}

async function pickHerd(page, label) {
  await openFilter(page, 'herdSet');
  await page.locator(`[data-filter-popover="herdSet"] >> text=${label}`).click();
  await page.locator('[data-filter-popover="herdSet"] >> text=Close').click();
}

// Herd tiles default to collapsed — click each collapsed toggle until all open.
async function expandAllHerds(page) {
  const collapsed = page.locator('[data-cattle-herd-toggle][data-cattle-herd-collapsed="1"]');
  for (let n = await collapsed.count(); n > 0; n = await collapsed.count()) {
    await collapsed.first().click();
  }
}

// --------------------------------------------------------------------------
// Test 1 — Default load: herd tiles, collapsed by default
// --------------------------------------------------------------------------
test('default load: herd tiles collapsed by default; expand reveals grouped cattle', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // No filter selection: grouped-by-herd tiles (collapsed by default); the old
  // manual grouped/flat toggle is still gone.
  await expect(page.locator('[data-cattle-grouped-herds="1"]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-results="1"]')).toHaveCount(0);
  await expect(page.locator('[data-cattle-herds-view-toggle="1"]')).toHaveCount(0);

  // Every herd tile is present (incl. outcome herds) and starts collapsed, so
  // no cow rows are mounted yet.
  for (const herd of ['mommas', 'backgrounders', 'finishers', 'bulls', 'processed', 'deceased', 'sold']) {
    await expect(page.locator(`[data-cattle-herd-section="${herd}"]`)).toBeVisible();
    await expect(page.locator(`[data-cattle-herd-toggle="${herd}"]`)).toHaveAttribute(
      'data-cattle-herd-collapsed',
      '1',
    );
  }
  await expect(cattleRows(page)).toHaveCount(0);

  // Expanding the tiles reveals every seeded cow under its herd.
  await expandAllHerds(page);
  const tags = await readTagsInOrder(cattleRows(page));
  for (const t of [
    'M001',
    'M002',
    'M003',
    'M004',
    'M005',
    'B201',
    'B202',
    'B203',
    'BL401',
    'F301',
    'P501',
    'S601',
    'D701',
  ]) {
    expect(tags).toContain(t);
  }
});

// --------------------------------------------------------------------------
// Test 2 — Sold herd filter switches to one flat result table
// --------------------------------------------------------------------------
test('sold herd filter shows only sold cattle in a flat table', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await pickHerd(page, 'Sold');

  await expect(page.locator('[data-cattle-flat-results="1"]')).toBeVisible();
  await expect(page.locator('[data-cattle-grouped-herds="1"]')).toHaveCount(0);
  await expect(page.locator('[data-cattle-herd-section="processed"]')).toHaveCount(0);
  await expect(page.locator('[data-cattle-herd-section="deceased"]')).toHaveCount(0);
  await expect(flatRows(page)).toHaveCount(1);
  await expect(flatRows(page).first()).toContainText('#S601');
});

// --------------------------------------------------------------------------
// Test 3 — A non-default sort keeps the grouped herd sections
// --------------------------------------------------------------------------
test('non-default sort keeps cattle grouped by herd (orders within groups)', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await ensureToolPanel(page, 'sort');
  await page.locator('select[data-sort-add]').selectOption('age');

  // A sort alone must NOT collapse the grouping: grouped stays, flat stays
  // absent. Expand the (default-collapsed) tiles to confirm every cow is still
  // present, re-ordered within its herd section.
  await expect(page.locator('[data-cattle-grouped-herds="1"]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-results="1"]')).toHaveCount(0);
  await expect(page.locator('[data-cattle-herd-section="mommas"]')).toBeVisible();
  await expandAllHerds(page);
  await expect(cattleRows(page)).toHaveCount(13);
});

// --------------------------------------------------------------------------
// Test 4 — Last Activity sort uses record-page Activity timestamps
// --------------------------------------------------------------------------
test('last activity sort shows date/time and orders by newest activity first', async ({
  page,
  supabaseAdmin,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  const {error} = await supabaseAdmin.from('activity_events').upsert(
    [
      {
        id: 'ae-cattle-herd-last-activity-b201',
        entity_type: 'cattle.animal',
        entity_id: 'cow-bg-fresh',
        event_type: 'field.updated',
        body: 'Updated test field',
        payload: {entity_label: '#B201'},
        created_at: '2026-06-03T10:00:00Z',
      },
      {
        id: 'ae-cattle-herd-last-activity-m001',
        entity_type: 'cattle.animal',
        entity_id: 'cow-mom-calved-current',
        event_type: 'field.updated',
        body: 'Updated test field',
        payload: {entity_label: '#M001'},
        created_at: '2026-06-01T10:00:00Z',
      },
      {
        id: 'ae-cattle-herd-last-activity-p501',
        entity_type: 'cattle.animal',
        entity_id: 'cow-processed-001',
        event_type: 'field.updated',
        body: 'Updated test field',
        payload: {entity_label: '#P501'},
        created_at: '2026-05-01T10:00:00Z',
      },
    ],
    {onConflict: 'id'},
  );
  expect(error).toBeNull();

  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // A sort alone now keeps the herd groups, so filter to the three herds that
  // have seeded activity to get the flat matched-results table, then sort by
  // Last Activity (newest first across the filtered set).
  await pickHerd(page, 'Backgrounders');
  await pickHerd(page, 'Mommas');
  await pickHerd(page, 'Processed');

  await ensureToolPanel(page, 'sort');
  await page.locator('select[data-sort-add]').selectOption('lastActivity');

  await expect(page.locator('[data-cattle-flat-results="1"]')).toBeVisible();
  await expect(page.locator('[data-cattle-flat-list] th', {hasText: 'Last Activity'})).toHaveCount(1);
  await expect(page.locator('#cow-cow-bg-fresh')).toContainText(/06\/03\/26/, {timeout: 15_000});
  await expect(page.locator('#cow-cow-mom-calved-current')).toContainText(/06\/01\/26/, {timeout: 15_000});
  await expect(page.locator('#cow-cow-processed-001')).toContainText(/05\/01\/26/, {timeout: 15_000});
  await expect(flatRows(page).first()).toContainText('#B201', {timeout: 15_000});
  expect((await readTagsInOrder(flatRows(page))).slice(0, 3)).toEqual(['B201', 'M001', 'P501']);
  await expect(flatRows(page).first()).toContainText(/06\/03\/26/);

  await flatRows(page).first().click();
  await expect(page.locator('[data-cattle-animal-page="1"]')).toBeVisible({timeout: 15_000});
  await page.getByRole('button', {name: 'Back to Herds'}).click();
  await expect(page.locator('[data-cattle-flat-results="1"]')).toBeVisible({timeout: 5_000});
  await expect(page.locator('[data-cattle-last-activity-loading="1"]')).toHaveCount(0);
  await expect(flatRows(page).first()).toContainText('#B201', {timeout: 1_000});
});

// --------------------------------------------------------------------------
// Test 2 — Age sort youngest-first orders newest birth_date first
// --------------------------------------------------------------------------
test('age sort youngest-first orders newest birth_date first', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Constrain to mommas so the ordering assertion is exact.
  await pickHerd(page, 'Mommas');

  // Add age sort. Adding a non-tag sort replaces the default Tag sort so the
  // visible chip order matches the actual primary sort.
  await ensureToolPanel(page, 'sort');
  await page.locator('select[data-sort-add]').selectOption('age');
  const sortRules = page.locator('[data-sort-rule]');
  await expect(sortRules.nth(0)).toHaveAttribute('data-sort-rule', 'age');
  await expect(sortRules).toHaveCount(1);
  const ageRule = page.locator('[data-sort-rule="age"]');
  await expect(ageRule).toHaveAttribute('data-sort-dir', 'asc');

  // Mommas seed ages (runtime-relative): M001 ~73mo, M002 ~61mo,
  // M003 ~23mo (youngest), M004 ~87mo (oldest), M005 ~44mo.
  // Youngest-first asc order: M003, M005, M002, M001, M004.
  await expect(flatRows(page)).toHaveCount(5);
  expect(await readTagsInOrder(flatRows(page))).toEqual(['M003', 'M005', 'M002', 'M001', 'M004']);

  // Flip to desc — oldest first.
  await ageRule.locator('button').first().click();
  await expect(ageRule).toHaveAttribute('data-sort-dir', 'desc');
  expect(await readTagsInOrder(flatRows(page))).toEqual(['M004', 'M001', 'M002', 'M005', 'M003']);
});

// --------------------------------------------------------------------------
// Test 3 — sex=heifer + age >= 18mo compose in the flat list
// --------------------------------------------------------------------------
test('sex + age compose to the expected survivors', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
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

  // Survivors per seed: heifers >=18mo → M003, B201, B202 (B203 ~16mo excluded).
  await expect(page.locator('[data-cattle-match-count]')).toContainText('3');
  await expect(flatRows(page)).toHaveCount(3);
  expect(new Set(await readTagsInOrder(flatRows(page)))).toEqual(new Set(['M003', 'B201', 'B202']));
});

// --------------------------------------------------------------------------
// Test 4 — Sex popover option alignment
// --------------------------------------------------------------------------
test('choice filter popovers align controls and labels in clean rows', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
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
// Test 5 — calved=no in mommas surfaces only the never-calved heifer
// --------------------------------------------------------------------------
test('calved=no in mommas surfaces only the never-calved heifer', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await pickHerd(page, 'Mommas');

  await openFilter(page, 'calvedStatus');
  await page.locator('[data-filter-popover="calvedStatus"] >> text=Never calved').click();
  await page.locator('[data-filter-popover="calvedStatus"] >> text=Close').click();

  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 ');
  await expect(flatRows(page)).toHaveCount(1);
  await expect(flatRows(page).first()).toContainText('#M003');
});

// --------------------------------------------------------------------------
// Test 6 — blacklist filter surfaces only the blacklisted cow
// --------------------------------------------------------------------------
test('blacklist filter surfaces only the blacklisted cow', async ({page, cattleHerdFiltersScenario}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await openFilter(page, 'breedingBlacklist');
  await page.locator('[data-filter-popover="breedingBlacklist"] >> text=Only blacklisted').click();
  await page.locator('[data-filter-popover="breedingBlacklist"] >> text=Close').click();

  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 ');
  await expect(flatRows(page)).toHaveCount(1);
  await expect(flatRows(page).first()).toContainText('#M004');
});

// --------------------------------------------------------------------------
// Test 7 — save a cattle herd view (filters + sort + columns), clear, re-apply
// --------------------------------------------------------------------------
test('saves a cattle herd view and re-applies filters/sort/columns from the picker', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Build a distinctive state: backgrounders only (3 cows).
  await pickHerd(page, 'Backgrounders');
  await expect(flatRows(page)).toHaveCount(3);

  // Save it as a public view.
  const viewName = 'BG ' + Date.now();
  await ensureToolPanel(page, 'savedViews');
  await page.locator('[data-saved-view-save-open]').click();
  await expect(page.locator('[data-saved-view-form]')).toBeVisible();
  await page.locator('[data-saved-view-name]').fill(viewName);
  await page.locator('[data-saved-view-visibility="public"]').check();
  await page.locator('[data-saved-view-save]').click();

  // The new view becomes the selected option and the form closes.
  await expect(page.locator('[data-saved-view-form]')).toHaveCount(0);
  const optionLabel = viewName + ' · public';
  await expect(page.locator('[data-saved-view-select] option', {hasText: viewName})).toHaveCount(1);

  // Reset to a different state: clear filters (back to all active).
  await ensureToolPanel(page, 'filters');
  await page.locator('text=Clear all filters').click();
  await expect(page.locator('[data-cattle-match-count]')).not.toContainText(/^3 /);

  // Re-apply: deselect, then pick the saved view by label. Selecting restores
  // the backgrounders filter → 3 cows in the flat list.
  await ensureToolPanel(page, 'savedViews');
  await page.locator('[data-saved-view-select]').selectOption('');
  await page.locator('[data-saved-view-select]').selectOption({label: optionLabel});
  await expect(flatRows(page)).toHaveCount(3);

  // Owner controls (update/delete) are available for an owned view.
  await ensureToolPanel(page, 'savedViews');
  await expect(page.locator('[data-saved-view-update]')).toBeVisible();
  await expect(page.locator('[data-saved-view-delete]')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 8 — column/display picker drives which fields the flat list shows
// --------------------------------------------------------------------------
test('column picker toggles fields on the flat list and resets to default', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await pickHerd(page, 'Mommas');

  // Sire Tag is off by default — its header is absent.
  await expect(page.locator('[data-cattle-flat-list] th', {hasText: 'Sire Tag'})).toHaveCount(0);

  await ensureToolPanel(page, 'columns');
  await page.locator('[data-cattle-column-toggle="sireTag"]').click();
  await expect(page.locator('[data-cattle-flat-list] th', {hasText: 'Sire Tag'})).toHaveCount(1);

  // Reset restores the default column set (Sire Tag off again).
  await page.locator('[data-cattle-columns-reset]').click();
  await expect(page.locator('[data-cattle-flat-list] th', {hasText: 'Sire Tag'})).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 9 — maternal-issue UI absence regression
// --------------------------------------------------------------------------
test('maternal-issue text absent from herd view, record page, and Add modal', async ({
  page,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  // Page-level scrub.
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.toLowerCase()).not.toContain('maternal');

  // Cow record page — herd tiles are collapsed by default, so expand first,
  // then a cow-row click routes to the record page.
  await expandAllHerds(page);
  await cattleRows(page).first().click();
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
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await openFilter(page, 'breed');
  const popover = page.locator('[data-filter-popover="breed"]');
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
  void cattleHerdFiltersScenario;
  await page.goto('/cattle/herds');
  await waitForLoaded(page);

  await openFilter(page, 'nonCalving');
  await expect(page.locator('[data-cattle-special-filter-checkbox="nonCalvingCows"]')).toHaveCount(0);
  await page.locator('[data-cattle-noncalving-cutoff]').fill('2026-01-01');
  await page.locator('[data-filter-popover="nonCalving"] >> text=Close').click();

  // Mature cattle whose last calving is missing or before 2026-01-01:
  //   D701 and S601 are outcome-herd cows with no calving record.
  //   M002 (calved 2025-05), M004 (calved 2023-06), M005 (calved 2024-09).
  //   M001 calved 2026-04 (after cutoff) excluded; M003 heifer not yet 30mo.
  await expect(page.locator('[data-cattle-match-count]')).toContainText('5 cattle match');
});

// --------------------------------------------------------------------------
// Test 12 — Unmatched Calves checkbox (Lineage/Other) still filters correctly
// --------------------------------------------------------------------------
test('Unmatched Calves checkbox filters to calves missing a dam', async ({
  page,
  supabaseAdmin,
  cattleHerdFiltersScenario,
}) => {
  void cattleHerdFiltersScenario;
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

  // Checkbox-style filter in Lineage/Other (not a pill chip) — inside Filters panel.
  await ensureToolPanel(page, 'filters');
  await page.locator('[data-cattle-special-filter-checkbox="unmatchedCalves"]').check();
  await expect(page.locator('[data-cattle-match-count]')).toContainText('1 match');

  await expect(flatRows(page)).toHaveCount(1);
  await expect(flatRows(page).first()).toContainText('#UC900');
});
