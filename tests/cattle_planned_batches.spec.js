import {test, expect} from './fixtures.js';

// ============================================================================
// Consolidated cattle Planned pipeline + projected rosters
// ============================================================================
// One canonical Planned section on /cattle/batches (virtual forecast rows +
// persisted scheduled rows, chronological), a route-backed forecast-only
// batch detail keyed by stable monthKey, the PROJECTED roster on scheduled
// batch record pages (cows_detail still empty), and the same projected
// tags/weights inside the Processing Calendar's cattle Source details — all
// derived from ONE projection source (buildForecast → projectPlannedRoster).
//
// Tests:
//   1 — admin schedules the first forecast row; the scheduled row re-renders
//       in place chronologically with the Scheduled chip; DB row is correct.
//   2 — scheduled record page shows the Projected roster (count/total match
//       the list row); moving the planned date recomputes the cohort through
//       the canonical math.
//   3 — farm_team: no Schedule controls; planned rows still render.
//   4 — forecast-only detail: opens from the row, shows the projected
//       roster, survives direct reload; invalid + empty months fail closed.
//   5 — scheduled month's forecast URL points at the persisted record.
//   6 — Processing Drawer cattle Source details show the same projected
//       tags/weights for the scheduled batch.
//   7 — active batch (actuals attached): page shows cows_detail, never the
//       projected roster — projections and actuals cannot mix.
//   8 — fail-closed: a failed forecast-input read renders the explicit
//       unavailable state, never zero/fabricated weights.
//   9 — mobile: planned rows + roster table readable and tappable.
//
// Serial (workers=1 root config). Run this file on its own — never bundled
// with other TEST-backed specs (shared resetDb).
// ============================================================================

async function openBatchesHub(page) {
  await page.goto('/cattle/batches');
  await expect(page.locator('[data-cattle-batches-loaded="true"]')).toBeVisible({timeout: 15_000});
}

// First virtual forecast row + its parsed display facts.
async function readFirstForecastRow(page) {
  const row = page.locator('[data-planned-row="forecast"]').first();
  await expect(row).toBeVisible({timeout: 10_000});
  const name = await row.getAttribute('data-virtual-batch');
  const monthKey = await row.getAttribute('data-virtual-batch-month');
  const text = await row.innerText();
  const countMatch = text.match(/(\d+) cows? forecast/);
  const totalMatch = text.match(/([\d,]+) lb projected/);
  return {
    row,
    name,
    monthKey,
    count: countMatch ? Number(countMatch[1]) : null,
    totalText: totalMatch ? totalMatch[1] : null,
  };
}

// Schedule the given forecast row for <monthKey>-20 and wait for the record
// page; returns the created batch id (from the URL).
async function scheduleFirstForecastRow(page) {
  const first = await readFirstForecastRow(page);
  const date = first.monthKey + '-20';
  await page.locator(`[data-virtual-batch-schedule-date="${first.name}"]`).fill(date);
  await page.locator(`[data-virtual-batch-schedule="${first.name}"]`).click();
  await expect(page).toHaveURL(/\/cattle\/batches\/cpb-/, {timeout: 10_000});
  await expect(page.locator('[data-cattle-batch-record-loaded="true"]')).toBeVisible({timeout: 10_000});
  const batchId = page.url().split('/cattle/batches/')[1];
  return {...first, date, batchId};
}

async function setRoleOverride(page, role) {
  await page.addInitScript((r) => {
    if (r) window.localStorage.setItem('wcf-test-role-override', r);
    else window.localStorage.removeItem('wcf-test-role-override');
  }, role);
}

// --------------------------------------------------------------------------
// Test 1 — Schedule keeps the row in ONE chronological Planned list
// --------------------------------------------------------------------------
test('scheduling a forecast row yields a Scheduled row in place; chronology and DB row correct', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await openBatchesHub(page);
  const scheduled = await scheduleFirstForecastRow(page);

  // DB: the exact displayed name, scheduled status, chosen date, no cattle.
  const {data: dbRow} = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('name, status, planned_process_date, cows_detail')
    .eq('id', scheduled.batchId)
    .single();
  expect(dbRow.name).toBe(scheduled.name);
  expect(dbRow.status).toBe('scheduled');
  expect(dbRow.planned_process_date).toBe(scheduled.date);
  expect(dbRow.cows_detail).toEqual([]);

  // Back on the hub: same position in ONE list, now as a Scheduled row with
  // count + projected weight; remaining forecast rows follow chronologically.
  await openBatchesHub(page);
  const states = await page
    .locator('[data-planned-row]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-planned-row')));
  expect(states.length).toBeGreaterThan(0);
  expect(states[0]).toBe('scheduled');
  expect(states.slice(1).every((s) => s === 'forecast')).toBe(true);

  const schedRow = page.locator(`[data-scheduled-batch="${scheduled.name}"]`);
  await expect(schedRow).toBeVisible();
  await expect(schedRow).toContainText('Scheduled');
  await expect(schedRow).toContainText(`${scheduled.count} ${scheduled.count === 1 ? 'cow' : 'cows'} forecast`);
  await expect(schedRow).toContainText(`${scheduled.totalText} lb projected`);
  const schedText = await schedRow.innerText();
  expect(schedText.toUpperCase()).not.toContain('PLANNED');
});

// --------------------------------------------------------------------------
// Test 2 — Scheduled record page: projected roster + date-move recompute
// --------------------------------------------------------------------------
test('scheduled record page shows Projected roster matching the list; date move recomputes cohort', async ({
  page,
  cattleForecastScenario,
}) => {
  await openBatchesHub(page);
  // Capture the SECOND forecast month before scheduling the first (its
  // cohort becomes the expected roster after the date move).
  const forecastRows = page.locator('[data-planned-row="forecast"]');
  await expect(forecastRows.first()).toBeVisible({timeout: 10_000});
  const monthCount = await forecastRows.count();
  let secondMonth = null;
  let secondCount = null;
  if (monthCount > 1) {
    secondMonth = await forecastRows.nth(1).getAttribute('data-virtual-batch-month');
    const secondText = await forecastRows.nth(1).innerText();
    const m = secondText.match(/(\d+) cows? forecast/);
    secondCount = m ? Number(m[1]) : null;
  }

  const scheduled = await scheduleFirstForecastRow(page);

  // Projected roster card renders with the Projected label while
  // cows_detail is empty, and its count/total match the list row exactly.
  const card = page.locator(`[data-scheduled-projected-roster="${scheduled.batchId}"]`);
  await expect(card).toBeVisible({timeout: 10_000});
  await expect(card).toContainText('Projected roster');
  await expect(card).toContainText('until cattle are actually sent from WeighIns');
  const table = card.locator('[data-projected-roster]');
  await expect(table).toBeVisible({timeout: 10_000});
  await expect(card.locator('[data-projected-roster-row]')).toHaveCount(scheduled.count);
  await expect(card).toContainText(`${scheduled.count} ${scheduled.count === 1 ? 'cow' : 'cows'} projected`);
  await expect(card).toContainText(`${scheduled.totalText} lb projected`);

  // Age at processing column: one age cell per row, compact years/months
  // (or the canonical Not recorded), anchored to the batch's planned date.
  await expect(card).toContainText('Age at processing');
  const ageCells = await card
    .locator('[data-projected-roster-age]')
    .evaluateAll((els) => els.map((el) => (el.textContent || '').trim()));
  expect(ageCells.length).toBe(scheduled.count);
  for (const age of ageCells) {
    expect(age).toMatch(/^(\d+y \d+m|Not recorded)$/);
  }
  // Every seed cow carries a DOB — at least one real age must render.
  expect(ageCells.some((a) => /\d+y \d+m/.test(a))).toBe(true);

  // Move the planned date to the SECOND forecast month — the roster must
  // recompute through the canonical forecast math for the new month.
  if (secondMonth && secondCount != null) {
    const dateInput = page.locator(`[data-scheduled-batch-date="${scheduled.batchId}"]`);
    await dateInput.fill(secondMonth + '-20');
    await dateInput.blur();
    // The new cohort is the second month's forecast cohort (plus the first
    // month's original cattle only if they also project there — the seed
    // months are disjoint, so expect exactly the second month's count).
    await expect(card.locator('[data-projected-roster-row]')).toHaveCount(secondCount, {timeout: 10_000});
  }
});

// --------------------------------------------------------------------------
// Test 3 — farm_team cannot schedule; planned rows still render
// --------------------------------------------------------------------------
test('farm_team: planned rows visible, no Schedule controls', async ({page, cattleForecastScenario}) => {
  await setRoleOverride(page, 'farm_team');
  await openBatchesHub(page);
  const row = page.locator('[data-planned-row="forecast"]').first();
  await expect(row).toBeVisible({timeout: 10_000});
  await expect(page.locator('[data-virtual-batch-schedule]')).toHaveCount(0);
  const dateInputs = await page.locator('input[data-virtual-batch-schedule-date]').count();
  expect(dateInputs).toBe(0);
  await expect(row).toContainText('Created when sent to processor at WeighIns');
});

// --------------------------------------------------------------------------
// Test 4 — Forecast-only detail: real route, live reconstruction, fail-closed
// --------------------------------------------------------------------------
test('forecast-only detail opens from the row, survives reload, and fails closed on bad months', async ({
  page,
  cattleForecastScenario,
}) => {
  await openBatchesHub(page);
  const first = await readFirstForecastRow(page);
  await first.row.click();

  await expect(page).toHaveURL(new RegExp('/cattle/batches/forecast/' + first.monthKey));
  const body = page.locator('[data-forecast-batch-loaded="true"]');
  await expect(body).toBeVisible({timeout: 10_000});
  await expect(body).toContainText(first.name);
  await expect(body).toContainText('Forecast');
  await expect(body).toContainText('not a saved record');
  await expect(body.locator('[data-projected-roster-row]')).toHaveCount(first.count);
  await expect(body).toContainText(`${first.totalText} lb projected`);

  // Direct refresh reconstructs the same live projection.
  await page.reload();
  const bodyAfter = page.locator('[data-forecast-batch-loaded="true"]');
  await expect(bodyAfter).toBeVisible({timeout: 15_000});
  await expect(bodyAfter).toContainText(first.name);
  await expect(bodyAfter.locator('[data-projected-roster-row]')).toHaveCount(first.count);

  // Empty month (in horizon shape but no cohort) fails closed.
  await page.goto('/cattle/batches/forecast/2099-01');
  await expect(page.locator('[data-forecast-batch-empty="1"]')).toBeVisible({timeout: 15_000});
  // Invalid month key fails closed.
  await page.goto('/cattle/batches/forecast/not-a-month');
  await expect(page.locator('[data-forecast-batch-invalid-month="1"]')).toBeVisible({timeout: 15_000});
});

// --------------------------------------------------------------------------
// Test 5 — A scheduled month's forecast URL points at the persisted record
// --------------------------------------------------------------------------
test('forecast detail for a now-scheduled month points at the persisted record', async ({
  page,
  cattleForecastScenario,
}) => {
  await openBatchesHub(page);
  const scheduled = await scheduleFirstForecastRow(page);

  await page.goto('/cattle/batches/forecast/' + scheduled.monthKey);
  const pointer = page.locator(`[data-forecast-batch-scheduled-pointer="${scheduled.batchId}"]`);
  await expect(pointer).toBeVisible({timeout: 15_000});
  await expect(pointer).toContainText(scheduled.name);
  await page.locator(`[data-forecast-batch-open-scheduled="${scheduled.batchId}"]`).click();
  await expect(page).toHaveURL(new RegExp('/cattle/batches/' + scheduled.batchId));
  await expect(page.locator('[data-cattle-batch-record-loaded="true"]')).toBeVisible({timeout: 10_000});
});

// --------------------------------------------------------------------------
// Test 6 — Processing Drawer cattle Source details show the SAME projection
// --------------------------------------------------------------------------
test('Processing Source details show the same projected tags/weights for a scheduled cattle batch', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(90_000);
  await openBatchesHub(page);
  const scheduled = await scheduleFirstForecastRow(page);

  // Capture the record page's projected tags + total for comparison.
  const card = page.locator(`[data-scheduled-projected-roster="${scheduled.batchId}"]`);
  await expect(card.locator('[data-projected-roster]')).toBeVisible({timeout: 10_000});
  const pageTags = await card
    .locator('[data-projected-roster-row]')
    .evaluateAll((els) => els.map((el) => (el.textContent || '').match(/#(\S+)/)?.[1]).filter(Boolean));
  expect(pageTags.length).toBe(scheduled.count);
  // Row-ordered age strings for cross-surface equality below.
  const pageAges = await card
    .locator('[data-projected-roster-age]')
    .evaluateAll((els) => els.map((el) => (el.textContent || '').trim()));
  expect(pageAges.length).toBe(scheduled.count);
  const pageTotalAttr = await card.locator('[data-projected-roster-total]').getAttribute('data-projected-roster-total');

  // Best-effort force of the planner→Processing reconcile (the /processing
  // page load also calls ensure_processing_freshness before listing — this
  // direct call just defeats the debounce window if a recent reconcile ran).
  try {
    await supabaseAdmin.rpc('ensure_processing_freshness', {p_max_age_seconds: 0});
  } catch {
    /* best-effort — the page load repeats the call */
  }

  // Open the Processing Calendar (its load reconciles then lists) and find
  // the scheduled batch's record.
  await page.goto('/processing');
  await page.waitForSelector('[data-processing-loaded="1"]', {timeout: 20_000});
  let recordId = null;
  const findRecordId = async () => {
    const r = await supabaseAdmin
      .from('processing_records')
      .select('id')
      .eq('source_kind', 'cattle')
      .eq('source_id', scheduled.batchId)
      .maybeSingle();
    return r.data?.id || null;
  };
  try {
    await expect.poll(findRecordId, {timeout: 8_000}).not.toBeNull();
  } catch {
    // Debounced first pass — reload retriggers the freshness call.
    await page.reload();
    await page.waitForSelector('[data-processing-loaded="1"]', {timeout: 20_000});
    await expect
      .poll(findRecordId, {timeout: 15_000, message: 'planner reconcile never produced the Processing record'})
      .not.toBeNull();
    await page.reload();
    await page.waitForSelector('[data-processing-loaded="1"]', {timeout: 20_000});
  }
  recordId = await findRecordId();
  const row = page.locator(`[data-processing-row="${recordId}"]`);
  await expect(row).toBeVisible({timeout: 15_000});
  await row.click();
  const drawer = page.locator(`[data-processing-drawer="${recordId}"]`);
  await expect(drawer).toBeVisible({timeout: 10_000});

  // Source details render the PROJECTED roster — same tags, same total.
  const sourceSection = drawer.locator('[data-processing-source-section="cattle"]');
  await expect(sourceSection).toBeVisible({timeout: 10_000});
  const projected = sourceSection.locator(`[data-processing-projected-roster="${scheduled.count}"]`);
  await expect(projected).toBeVisible({timeout: 15_000});
  await expect(projected).toContainText('Projected');
  await expect(projected).toContainText('live forecast until cattle are sent from WeighIns');
  for (const tag of pageTags) {
    await expect(projected).toContainText(tag);
  }
  await expect(projected).toContainText(`${Number(pageTotalAttr).toLocaleString()} lb projected`);

  // Age at processing: the drawer row for each tag carries EXACTLY the age
  // string the batch page showed for that cow (same shared formatter, same
  // planned date — the two surfaces can never disagree).
  await expect(projected).toContainText('Age at processing');
  const drawerRows = await projected
    .locator('[data-processing-animals-table] > div')
    .evaluateAll((els) => els.slice(1).map((el) => (el.textContent || '').trim()));
  for (let i = 0; i < pageTags.length; i++) {
    const row = drawerRows.find((t) => t.startsWith(pageTags[i]));
    expect(row, 'drawer row for tag ' + pageTags[i]).toBeTruthy();
    expect(row).toContain(pageAges[i]);
  }
});

// --------------------------------------------------------------------------
// Test 7 — Actuals replace projections: active batch never shows Projected
// --------------------------------------------------------------------------
test('active batch page shows actual cows_detail and no projected roster', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  const batchId = 'b-planned-actual-1';
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-95',
      status: 'active',
      actual_process_date: '2026-05-04',
      planned_process_date: '2026-05-04',
      cows_detail: [{cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: null}],
      total_live_weight: 1100,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('cattle').update({herd: 'processed', processing_batch_id: batchId}).eq('id', 'F1');

  await page.goto('/cattle/batches/' + batchId);
  await expect(page.locator('[data-cattle-batch-record-loaded="true"]')).toBeVisible({timeout: 15_000});
  // Actual roster renders; the projected card does not exist on active pages.
  await expect(page.locator('[data-batch-cow-row="F1"]')).toBeVisible();
  await expect(page.locator('[data-scheduled-projected-roster]')).toHaveCount(0);
  await expect(page.locator('[data-projected-roster]')).toHaveCount(0);
  await expect(page.getByText('Projected roster')).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 8 — Fail closed: broken forecast inputs → explicit unavailable state
// --------------------------------------------------------------------------
test('scheduled page renders the unavailable state when forecast inputs cannot load', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  const batchId = 'cpb-planned-failclosed-1';
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-01',
      status: 'scheduled',
      planned_process_date: tomorrow,
      cows_detail: [],
      documents: [],
    },
    {onConflict: 'id'},
  );

  // Break ONLY the forecast-settings read (a bundle input); the record page's
  // own loads (batch + cattle) stay healthy.
  await page.route('**/rest/v1/cattle_forecast_settings*', (route) => route.abort('failed'));
  await page.goto('/cattle/batches/' + batchId);
  await expect(page.locator('[data-cattle-batch-record-loaded="true"]')).toBeVisible({timeout: 15_000});

  const card = page.locator(`[data-scheduled-projected-roster="${batchId}"]`);
  await expect(card).toBeVisible({timeout: 10_000});
  await expect(card.locator('[data-projected-roster-unavailable="1"]')).toBeVisible({timeout: 15_000});
  // No roster rows, no zero totals — fail closed means NOTHING numeric.
  await expect(card.locator('[data-projected-roster-row]')).toHaveCount(0);
  await expect(card.locator('[data-projected-roster-total]')).toHaveCount(0);
  await page.unroute('**/rest/v1/cattle_forecast_settings*');
});

// --------------------------------------------------------------------------
// Test 9 — Mobile: planned rows + roster table readable and tappable
// --------------------------------------------------------------------------
test.describe('mobile', () => {
  test.use({hasTouch: true, viewport: {width: 390, height: 844}});

  test('planned rows render and the projected roster table stays usable', async ({page, cattleForecastScenario}) => {
    await openBatchesHub(page);
    const first = await readFirstForecastRow(page);
    const box = await first.row.boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(40);

    const scheduled = await scheduleFirstForecastRow(page);
    const card = page.locator(`[data-scheduled-projected-roster="${scheduled.batchId}"]`);
    await expect(card).toBeVisible({timeout: 10_000});
    await expect(card.locator('[data-projected-roster]')).toBeVisible({timeout: 10_000});
    const rows = card.locator('[data-projected-roster-row]');
    await expect(rows.first()).toBeVisible();
    // The table never forces the page wider than the viewport.
    const cardBox = await card.boundingBox();
    expect(cardBox.width).toBeLessThanOrEqual(390);
  });
});
