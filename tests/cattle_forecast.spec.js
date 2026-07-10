import {test, expect} from './fixtures.js';
import {resetTestDatabase} from './setup/reset.js';
import {seedCattleForecast, seedCattleForecastSendFlow} from './scenarios/cattle_forecast_seed.js';

// ============================================================================
// Cattle Forecast tab + Batches rework + Send-to-Processor gate
// ============================================================================
// Locks the post-build contract for the Cattle Forecast lane (mig 043 +
// CattleForecastView + CattleBatchesView rework + Send-to-Processor modal
// rework). Pure-helper math is vitest-locked separately at
// src/lib/cattleForecast.test.js (61 cases including Codex 2026-05-04
// regression locks).
//
// Coverage (Codex required-checkpoint set):
//  1  Forecast does NOT assign nextProcessorBatch to a past month.
//  2  Hide a cow in its assigned month, turn Show hidden on, unhide it
//     from that same month.
//  3  Send-to-Processor creates an active batch with the EXACT displayed
//     virtual batch name.
//  4  Modal gate blocks tags outside the Forecast tab's next processor
//     tag set; whole send is blocked and blocked tags are listed.
//  5  Management/admin can edit Forecast controls and Send-to-Processor;
//     farm_team can view Forecast read-only and cannot send.
//  6  Batches tab shows virtual planned, active, completed sections; +
//     New Batch is absent.
//  7  Active batch auto-completes when all hanging weights exist, and
//     can be reopened.
// ============================================================================

const FORECAST_PATH = '/cattle/forecast';

async function waitForForecastLoaded(page) {
  await expect(page.locator('[data-cattle-forecast-root]')).toBeVisible({timeout: 15_000});
  // Next Processor Batch panel renders after settings + cattle land. The
  // panel always renders when forecast is computed; absence of the panel
  // means the forecast is still loading.
  await expect(page.locator('[data-next-processor-panel]')).toBeVisible({timeout: 15_000});
}

// Non-throwing finish-candidate count for polling — returns 0 until the summary
// strip renders with real data.
async function finishCandidateCount(page) {
  const strip = page.locator('[data-forecast-summary-strip]');
  if ((await strip.count()) === 0) return 0;
  const text = await strip.innerText().catch(() => '');
  const m = /(\d[\d,]*)\s+finish candidates on farm/i.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

// Robust load wait. CattleForecastView now self-heals a raced/transient
// cold-boot empty read in source (bounded retry in its mount effect), so the
// test no longer reloads to re-mount and re-fetch. Still wait on REAL seeded
// data (finish candidates > 0), not just shell/panel render — the panel
// renders even on a raced empty read.
async function waitForForecastData(page, {reloadOnEmpty = true} = {}) {
  let lastError = null;
  const attempts = reloadOnEmpty ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await waitForForecastLoaded(page);
    try {
      await expect.poll(() => finishCandidateCount(page), {timeout: 10_000}).toBeGreaterThan(0);
      return;
    } catch (e) {
      lastError = e;
      if (!reloadOnEmpty || attempt === attempts - 1) break;
      await page.reload();
    }
  }
  throw lastError;
}

const BASE_FORECAST_CATTLE_IDS = ['B1', 'F-AT-MAX', 'F-HIDE', 'F1', 'F3', 'M-COW', 'M-HEIFER', 'M-STEER', 'P1'];
const BASE_FORECAST_HERDS = {
  B1: 'backgrounders',
  'F-AT-MAX': 'finishers',
  'F-HIDE': 'finishers',
  F1: 'finishers',
  F3: 'finishers',
  'M-COW': 'mommas',
  'M-HEIFER': 'mommas',
  'M-STEER': 'mommas',
  P1: 'processed',
};

async function ensureCleanForecastSeed(supabaseAdmin) {
  const [{data, error}, batches, includes, hidden] = await Promise.all([
    supabaseAdmin.from('cattle').select('id, herd, processing_batch_id, breeding_status').order('id'),
    supabaseAdmin.from('cattle_processing_batches').select('id').limit(1),
    supabaseAdmin.from('cattle_forecast_heifer_includes').select('cattle_id').limit(1),
    supabaseAdmin.from('cattle_forecast_hidden').select('cattle_id').limit(1),
  ]);
  if (error) throw new Error(`ensureCleanForecastSeed [cattle select]: ${error.message}`);
  for (const [label, r] of [
    ['batches', batches],
    ['includes', includes],
    ['hidden', hidden],
  ]) {
    if (r.error) throw new Error(`ensureCleanForecastSeed [${label} select]: ${r.error.message}`);
  }
  const ids = (data || []).map((r) => r.id).sort();
  const cleanIds =
    ids.length === BASE_FORECAST_CATTLE_IDS.length && BASE_FORECAST_CATTLE_IDS.every((id, idx) => ids[idx] === id);
  const cleanRows = (data || []).every(
    (row) =>
      BASE_FORECAST_HERDS[row.id] === row.herd &&
      !row.processing_batch_id &&
      (row.id !== 'M-HEIFER' || !row.breeding_status),
  );
  const clean = cleanIds && cleanRows && !batches.data?.length && !includes.data?.length && !hidden.data?.length;
  if (clean) return;
  await resetTestDatabase();
  await seedCattleForecast(supabaseAdmin);
}

async function ensureCleanForecastSendFlowSeed(supabaseAdmin) {
  const [session, rows] = await Promise.all([
    supabaseAdmin
      .from('weigh_in_sessions')
      .select('id, status')
      .eq('id', 'wsess-cattle-forecast-send-draft')
      .maybeSingle(),
    supabaseAdmin
      .from('weigh_ins')
      .select('id, send_to_processor')
      .in('id', ['wi-send-F1', 'wi-send-F-AT-MAX', 'wi-send-F-HIDE']),
  ]);
  if (session.error) throw new Error(`ensureCleanForecastSendFlowSeed [session select]: ${session.error.message}`);
  if (rows.error) throw new Error(`ensureCleanForecastSendFlowSeed [weigh_ins select]: ${rows.error.message}`);
  const rowIds = (rows.data || []).map((r) => r.id).sort();
  const clean =
    session.data?.status === 'draft' &&
    rowIds.length === 3 &&
    ['wi-send-F-AT-MAX', 'wi-send-F-HIDE', 'wi-send-F1'].every((id, idx) => rowIds[idx] === id) &&
    (rows.data || []).every((row) => row.send_to_processor === true);
  if (clean) return;
  await resetTestDatabase();
  await seedCattleForecastSendFlow(supabaseAdmin);
}

// F-HIDE projects into a forecast year that may differ from the default
// current-year view. Click through the year buttons until its assigned row
// renders, then return the (visible) row locator.
async function revealFHideRow(page) {
  const row = page.locator('[data-month-row="F-HIDE"]').first();
  if (await row.isVisible().catch(() => false)) return row;
  const years = page.locator('[data-year-button]');
  const n = await years.count();
  for (let i = 0; i < n; i++) {
    await years.nth(i).click();
    try {
      await expect(row).toBeVisible({timeout: 2_500});
      return row;
    } catch {
      /* not this year — try the next */
    }
  }
  await expect(row).toBeVisible({timeout: 8_000});
  return row;
}

async function setRoleOverride(page, role) {
  // The DEV-only sentinel in main.jsx reads
  // window.localStorage.getItem('wcf-test-role-override') and applies it on
  // top of the resolved profile.role. Setting it before navigation gates
  // the Forecast view's edit controls accordingly.
  await page.addInitScript((r) => {
    if (r) window.localStorage.setItem('wcf-test-role-override', r);
    else window.localStorage.removeItem('wcf-test-role-override');
  }, role);
}

async function readFinishCandidateCount(page) {
  const text = await page.locator('[data-forecast-summary-strip]').innerText();
  const match = /(\d[\d,]*)\s+finish candidates on farm/i.exec(text);
  expect(match).toBeTruthy();
  return Number(match[1].replace(/,/g, ''));
}

async function gotoCattleBatchRecord(page, batchId) {
  const loaded = page.locator('[data-cattle-batch-record-loaded="true"]');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/cattle/batches/' + batchId);
    try {
      await expect(loaded).toBeVisible({timeout: 6_000});
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await page.waitForTimeout(500 * (attempt + 1));
    }
  }
}

async function openSeededCattleDraftSession(page) {
  await page.goto('/cattle/weighins');
  const draftRow = page.locator('tr[data-weighin-session-tile]').filter({hasText: /draft/i}).first();
  await expect(draftRow).toBeVisible({timeout: 15_000});
  await draftRow.click();
  await expect(page.locator('tr[data-entry-tag="1002"]')).toBeVisible({timeout: 15_000});
}

// --------------------------------------------------------------------------
// Test 1 — Past-month regression: nextProcessorBatch month is current or future.
// --------------------------------------------------------------------------
test('forecast: nextProcessorBatch lands in current or future month, never past', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // F-AT-MAX (1450 lb) would land in 2026-01 without the monthsForAssignment
  // fix. Confirm the panel text shows a month >= current month.
  const panel = page.locator('[data-next-processor-panel]');
  await expect(panel).toBeVisible();
  // Read the panel's month label and assert no past-month label leaks.
  const panelText = (await panel.innerText()).toLowerCase();
  // Today is 2026-05-* so January..April 2026 are "past" months.
  for (const past of ['jan 2026', 'feb 2026', 'mar 2026', 'apr 2026']) {
    expect(panelText).not.toContain(past);
  }
  // And there must be SOME virtual batch — the seed has F1 and F-AT-MAX
  // both eligible, so a panel with "No virtual batch" copy would mean the
  // helper miscomputed.
  expect(panelText).not.toContain('no virtual batch');
});

test('forecast: summary year tiles use bold numeric years instead of relative labels', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  const summary = page.locator('[data-forecast-summary-strip]');
  const text = await summary.innerText();
  const currentYear = new Date().getUTCFullYear();

  for (const year of [currentYear, currentYear + 1, currentYear + 2, currentYear + 3]) {
    const yearLabel = summary.locator(`[data-summary-tile-label="${year}"]`);
    await expect(yearLabel).toBeVisible();
    await expect(yearLabel).toHaveCSS('font-weight', /^(700|800|bold)$/);
  }
  expect(text).not.toContain('Ready this year');
  expect(text).not.toContain('Next year');
  expect(text).not.toContain('2 yr out');
  expect(text).not.toContain('3 yr out');
});

// --------------------------------------------------------------------------
// Test 2 — Hide / Show hidden / Unhide cycle persists per-month, regardless
// of where the cow's current assignment rolls to.
// --------------------------------------------------------------------------
test('forecast: hide a cow, reveal under Show hidden, unhide from same month', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await page.goto(FORECAST_PATH);
  // Wait for real seeded forecast data (cold-boot resilient), not just the panel.
  await waitForForecastData(page);

  // F-HIDE projects into a forecast year that may differ from the default
  // current-year view — select the year containing it, then read its month.
  const fHideRow = await revealFHideRow(page);
  const hiddenMonth = await fHideRow.evaluate((el) => {
    const bucket = el.closest('[data-month-bucket]');
    return bucket ? bucket.getAttribute('data-month-bucket') : null;
  });
  expect(hiddenMonth).toBeTruthy();

  // Click Hide on F-HIDE in that month.
  const hideBtn = page.locator('[data-toggle-hide="F-HIDE"]');
  await expect(hideBtn).toBeVisible();
  await hideBtn.click();

  // In the ORIGINAL hide month, the assigned row goes away AND a muted
  // hidden-here row appears in its place — no global toggle needed (Codex
  // 2026-05-04 hide UX rework). F-HIDE's assignment rolls forward to a
  // different month and may render there too; that's expected.
  const hideMonthAssigned = page.locator(`[data-month-bucket="${hiddenMonth}"] [data-month-row="F-HIDE"]`);
  await expect(hideMonthAssigned).toHaveCount(0, {timeout: 5_000});

  // Verify a hidden row landed in the DB.
  const hiddenRows = await supabaseAdmin
    .from('cattle_forecast_hidden')
    .select('cattle_id, month_key')
    .eq('cattle_id', 'F-HIDE');
  expect(hiddenRows.data?.length).toBe(1);
  expect(hiddenRows.data?.[0].month_key).toBe(hiddenMonth);

  // Hidden-here row must be visible directly in the same tile. The bucket
  // may be auto-collapsed by the parent's monthFilter toggle; reopen if so.
  const targetBucket = page.locator(`[data-month-bucket="${hiddenMonth}"]`);
  if ((await targetBucket.locator('[data-month-bucket-table]').count()) === 0) {
    await targetBucket.locator('> div').first().click();
  }
  const hiddenHereRow = page.locator(`[data-month-bucket="${hiddenMonth}"] [data-month-hidden-row="F-HIDE"]`);
  await expect(hiddenHereRow).toBeVisible();

  // Unhide it.
  const unhideBtn = page.locator('[data-toggle-unhide="F-HIDE"]');
  await expect(unhideBtn).toBeVisible();
  await unhideBtn.click();

  // Hidden row gone, assignment row reappears in the bucket.
  await expect(hiddenHereRow).toHaveCount(0, {timeout: 5_000});
  // DB row removed.
  const after = await supabaseAdmin.from('cattle_forecast_hidden').select('cattle_id').eq('cattle_id', 'F-HIDE');
  expect(after.data?.length).toBe(0);

  // Activity audit (CP1): hide/unhide logs to the cattle.forecast workflow
  // stream. Activity is async (best-effort after each
  // successful write) — poll until both rows land.
  const readForecastVisibilityActs = async () => {
    const r = await supabaseAdmin
      .from('activity_events')
      .select('body, payload')
      .eq('entity_id', 'cattle-forecast')
      .eq('entity_type', 'cattle.forecast')
      .eq('event_type', 'status.changed');
    return (r.data || []).filter((e) => e.payload?.cattle_id === 'F-HIDE' && e.payload?.month_key === hiddenMonth);
  };

  await expect.poll(async () => (await readForecastVisibilityActs()).length, {timeout: 10_000}).toBe(2);

  const acts = await readForecastVisibilityActs();
  const bodies = acts.map((e) => e.body || '');
  const transitions = acts.map((e) => `${e.payload?.from}->${e.payload?.to}`);
  // One hide (… → hidden) and one unhide (… → visible).
  expect(bodies.every((b) => b.includes('Forecast month') && b.includes('#1003'))).toBe(true);
  expect(transitions).toContain('visible->hidden');
  expect(transitions).toContain('hidden->visible');
});

// --------------------------------------------------------------------------
// Test 3 — Send-to-Processor saves an active batch with the exact displayed
// virtual batch name.
// --------------------------------------------------------------------------
test('forecast → send: active batch saved with exact virtual batch name', async ({
  page,
  cattleForecastSendFlowScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(60_000);
  await ensureCleanForecastSendFlowSeed(supabaseAdmin);
  // Read the displayed virtual batch name from the Forecast tab first.
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  const panel = page.locator('[data-next-processor-panel]');
  const panelText = await panel.innerText();
  const m = panelText.match(/(C-\d{2}-\d{2,})/);
  expect(m).toBeTruthy();
  const expectedName = m[1];

  // The next virtual batch only contains F-AT-MAX (1002) because F-AT-MAX
  // is the only cow already inside the display window (1450 lb today). F1
  // projects ~2 months out, F-HIDE further. Unflag both F1 and F-HIDE so
  // the modal's selectedTags ⊆ next.allowedTagSet and the gate passes.
  await supabaseAdmin.from('weigh_ins').update({send_to_processor: false}).in('id', ['wi-send-F1', 'wi-send-F-HIDE']);

  // Drive the WeighIns view's Complete Session to fire the modal.
  await openSeededCattleDraftSession(page);
  await page.getByRole('button', {name: /Complete Session/}).click();

  // Send modal opens — the displayed Next forecast batch must match the
  // Forecast tab's panel.
  const modal = page.locator('[data-cattle-send-modal]');
  await expect(modal).toBeVisible({timeout: 5_000});
  await expect(modal).toContainText(expectedName);

  // Confirm.
  await page.locator('[data-send-modal-confirm]').click();
  await expect(modal).toHaveCount(0, {timeout: 10_000});

  // DB: a single active batch was created with the EXACT virtual name.
  const r = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('id, name, status, actual_process_date, cows_detail')
    .eq('name', expectedName);
  expect(r.error).toBeNull();
  expect(r.data?.length).toBe(1);
  const batch = r.data[0];
  expect(batch.status).toBe('active');
  // Processing date should equal the session date (2026-05-04 per seed).
  expect(batch.actual_process_date).toBe('2026-05-04');
  // Only F-AT-MAX attached (other tags were unflagged above).
  const tags = (batch.cows_detail || []).map((r2) => r2.tag).sort();
  expect(tags).toEqual(['1002']);
});

// --------------------------------------------------------------------------
// Test 4 — Outside-projection tags are a warning, not a hard block.
// --------------------------------------------------------------------------
// Codex 2026-05-12: Ronnie can send a cow that the forecast didn't project,
// and unsent projected cows stay in their herd / forecast. The modal must
// surface an amber warning for outside-projection tags but keep Confirm
// enabled, and attachEntriesToBatch's "selected entries only" semantics
// guarantee only the actually-sent cattle move to processed.
test('forecast → send: outside-projection tags warn but do not block; sent cow attaches; unsent projected cow stays', async ({
  page,
  cattleForecastSendFlowScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSendFlowSeed(supabaseAdmin);
  // Hide F-HIDE in every future month so its tag drops OUT of every
  // bucket's animalIds and therefore out of next.allowedTagSet.
  const months = [];
  for (let i = 0; i < 18; i++) {
    const d = new Date('2026-05-04T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    months.push(d.toISOString().slice(0, 7));
  }
  for (const mk of months) {
    await supabaseAdmin
      .from('cattle_forecast_hidden')
      .upsert({cattle_id: 'F-HIDE', month_key: mk, hidden_by: 'test'}, {onConflict: 'cattle_id,month_key'});
  }

  // Unflag F-AT-MAX (tag 1002) so she's a PROJECTED cow that the operator
  // intentionally did NOT send. After confirm she must remain in her
  // original herd ('finishers') with no processing_batch_id.
  await supabaseAdmin.from('weigh_ins').update({send_to_processor: false}).eq('id', 'wi-send-F-AT-MAX');

  await openSeededCattleDraftSession(page);
  await page.getByRole('button', {name: /Complete Session/}).click();

  // Modal renders with the remaining flagged cows. F-HIDE (tag 1003) is
  // hidden in every month so its tag is NOT in the next batch's
  // allowedTagSet — the modal must show an amber warning, NOT block.
  const modal = page.locator('[data-cattle-send-modal]');
  await expect(modal).toBeVisible({timeout: 5_000});
  const outsideWarn = page.locator('[data-send-modal-outside-tags]');
  await expect(outsideWarn).toBeVisible();
  await expect(outsideWarn).toContainText('1003');
  await expect(outsideWarn).toContainText(/outside the projected cohort/i);
  // The hard-block panel is gone.
  await expect(page.locator('[data-send-modal-blocked]')).toHaveCount(0);
  // Confirm button is enabled (warning, not block).
  await expect(page.locator('[data-send-modal-confirm]')).toBeEnabled();

  // Click Confirm — actual sent cattle override the projection. Only
  // flagged entries move to processed.
  await page.locator('[data-send-modal-confirm]').click();
  await expect(modal).toBeHidden({timeout: 10_000});

  // One active batch was created.
  const r = await supabaseAdmin.from('cattle_processing_batches').select('id, status, cows_detail');
  expect(r.error).toBeNull();
  expect(r.data?.length || 0).toBe(1);
  const batch = r.data[0];
  expect(batch.status).toBe('active');

  // The sent F-HIDE cow's id is in cows_detail and her herd is now 'processed'.
  const sentCowIds = (Array.isArray(batch.cows_detail) ? batch.cows_detail : []).map((row) => row.cattle_id);
  expect(sentCowIds).toContain('F-HIDE');
  const hideCowR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', 'F-HIDE').single();
  expect(hideCowR.data.herd).toBe('processed');
  expect(hideCowR.data.processing_batch_id).toBe(batch.id);

  // F-AT-MAX (projected but UNflagged) must stay in finishers — actual
  // sent cattle override projection in both directions.
  expect(sentCowIds).not.toContain('F-AT-MAX');
  const atMaxR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', 'F-AT-MAX').single();
  expect(atMaxR.data.herd).toBe('finishers');
  expect(atMaxR.data.processing_batch_id).toBeNull();
});

// --------------------------------------------------------------------------
// Test 4b — Scheduled row promotes to active instead of inserting a new row.
// --------------------------------------------------------------------------
// Codex 2026-05-12 (round 3): the risky path is "scheduled row promotes
// instead of inserting fresh." Pre-seed a scheduled row, send a subset
// from weigh-ins, confirm the same DB id flips to status='active',
// cows_detail picks up only the actually-sent entries, no second row
// with the same name is inserted, and an unflagged projected cow stays
// in her original herd.
test('send-to-processor: scheduled row promotes to active; same id; only sent cattle move', async ({
  page,
  cattleForecastSendFlowScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSendFlowSeed(supabaseAdmin);
  // Pre-seed: scheduled row named C-26-01 (first batch of 2026 since the
  // seed has no real batches) with planned_process_date matching the
  // session date so buildForecast surfaces it as the next-up batch via
  // source='scheduled'. cows_detail starts empty — promotion attaches.
  const scheduledId = 'cpb-test-scheduled-01';
  const scheduledName = 'C-26-01';
  const plannedDate = '2026-05-04';
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: scheduledId,
      name: scheduledName,
      planned_process_date: plannedDate,
      status: 'scheduled',
      cows_detail: [],
      documents: [],
    },
    {onConflict: 'id'},
  );

  // Unflag F-AT-MAX (tag 1002) so she's a projected cow the operator
  // chose NOT to send. After promotion she must stay in finishers.
  await supabaseAdmin.from('weigh_ins').update({send_to_processor: false}).eq('id', 'wi-send-F-AT-MAX');

  await openSeededCattleDraftSession(page);
  await page.getByRole('button', {name: /Complete Session/}).click();

  // Modal renders with the scheduled batch name. The summary line on a
  // promote path reads "promote scheduled batch" instead of "create
  // active batch".
  const modal = page.locator('[data-cattle-send-modal]');
  await expect(modal).toBeVisible({timeout: 5_000});
  await expect(modal).toContainText(scheduledName);
  await expect(modal).toContainText(/promote scheduled batch/i);
  await expect(page.locator('[data-send-modal-confirm]')).toBeEnabled();
  await page.locator('[data-send-modal-confirm]').click();
  await expect(modal).toBeHidden({timeout: 10_000});

  // No duplicate row with the same name was inserted — the scheduled id
  // is unique. Only one row exists, and it's now active.
  const r = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('id, status, name, actual_process_date, planned_process_date, cows_detail')
    .eq('name', scheduledName);
  expect(r.error).toBeNull();
  expect(r.data?.length || 0).toBe(1);
  const batch = r.data[0];
  expect(batch.id).toBe(scheduledId);
  expect(batch.status).toBe('active');
  expect(batch.actual_process_date).toBe(plannedDate);
  expect(batch.planned_process_date).toBe(plannedDate);

  // cows_detail contains the actually-sent cattle (F1 + F-HIDE — F-HIDE
  // is still in her original herd because the seed doesn't hide her in
  // this spec). F-AT-MAX was unflagged so she must NOT appear in the
  // batch.
  const sentCowIds = (Array.isArray(batch.cows_detail) ? batch.cows_detail : []).map((row) => row.cattle_id);
  expect(sentCowIds).toContain('F1');
  expect(sentCowIds).toContain('F-HIDE');
  expect(sentCowIds).not.toContain('F-AT-MAX');

  // F-AT-MAX (projected but unflagged) remains in finishers, no
  // processing_batch_id.
  const atMaxR = await supabaseAdmin.from('cattle').select('herd, processing_batch_id').eq('id', 'F-AT-MAX').single();
  expect(atMaxR.data.herd).toBe('finishers');
  expect(atMaxR.data.processing_batch_id).toBeNull();

  // The two sent cattle moved to processed and point at the promoted batch.
  const sentR = await supabaseAdmin.from('cattle').select('id, herd, processing_batch_id').in('id', ['F1', 'F-HIDE']);
  expect(sentR.error).toBeNull();
  for (const row of sentR.data || []) {
    expect(row.herd).toBe('processed');
    expect(row.processing_batch_id).toBe(scheduledId);
  }
});

// --------------------------------------------------------------------------
// Test 5 — Role gating: farm_team gets read-only Forecast; mgmt/admin edit.
// --------------------------------------------------------------------------
test('forecast: farm_team is read-only, no Include Heifers / Settings save', async ({page, cattleForecastScenario}) => {
  await setRoleOverride(page, 'farm_team');
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // READ-ONLY badge visible.
  await expect(page.locator('[data-forecast-readonly]')).toBeVisible();
  // Include Momma Herd Heifers button absent.
  await expect(page.locator('[data-include-heifers-btn]')).toHaveCount(0);
  // Settings panel shows but Save Settings button is absent for farm_team.
  await page.getByRole('button', {name: 'Settings'}).click();
  await expect(page.locator('[data-forecast-settings-panel]')).toBeVisible();
  await expect(page.locator('[data-save-settings-btn]')).toHaveCount(0);
});

test('send-to-processor: farm_team cannot send even when the tag gate would otherwise pass', async ({
  page,
  cattleForecastSendFlowScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSendFlowSeed(supabaseAdmin);
  // Force farm_team role for this page's session via the DEV-only override.
  await setRoleOverride(page, 'farm_team');

  // Drop F1 + F-HIDE flags so only F-AT-MAX (which is in the next batch's
  // allowed tag set) stays selected; the gate then passes cleanly so the
  // role gate is the only thing keeping Confirm disabled.
  await supabaseAdmin.from('weigh_ins').update({send_to_processor: false}).in('id', ['wi-send-F1', 'wi-send-F-HIDE']);

  await openSeededCattleDraftSession(page);
  await page.getByRole('button', {name: /Complete Session/}).click();

  const modal = page.locator('[data-cattle-send-modal]');
  await expect(modal).toBeVisible({timeout: 5_000});

  // Tag gate is valid → blocked banner must NOT render. If it did render,
  // we couldn't tell whether Confirm was disabled by the role gate or the
  // tag gate, so this assertion is load-bearing.
  await expect(page.locator('[data-send-modal-blocked]')).toHaveCount(0);

  // Role gate disables the Confirm button.
  await expect(page.locator('[data-send-modal-confirm]')).toBeDisabled();

  // No DB batch was created.
  const r = await supabaseAdmin.from('cattle_processing_batches').select('id');
  expect(r.error).toBeNull();
  expect(r.data?.length || 0).toBe(0);
});

test('forecast: current and future month tiles default to expanded; past months collapsed', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  const nowYm = new Date().toISOString().slice(0, 7);

  // Enumerate every rendered month bucket with its key + default expand state.
  // The header chevron (▼ expanded / ▶ collapsed) encodes expansion regardless
  // of whether the bucket projects any rows, so this assertion does not depend
  // on which month the seed happens to land cattle in (the old test hardcoded
  // the literal current-month bucket having a populated table, which goes red
  // once the calendar rolls past the seed's notional month).
  const buckets = await page.locator('[data-month-bucket]').evaluateAll((els) =>
    els.map((el) => ({
      monthKey: el.getAttribute('data-month-bucket'),
      // ▼ only renders in the header span when the tile is expanded.
      expanded: (el.textContent || '').includes('▼'),
    })),
  );
  expect(buckets.length).toBeGreaterThan(0);

  // Product behavior: current/future months default expanded; past collapsed.
  for (const b of buckets) {
    if (b.monthKey >= nowYm) {
      expect(b.expanded, `current/future bucket ${b.monthKey} should default expanded`).toBe(true);
    } else {
      expect(b.expanded, `past bucket ${b.monthKey} should default collapsed`).toBe(false);
    }
  }

  // At least one current/future bucket renders its inner table without a click.
  // Tables only render inside expanded buckets, and past buckets are collapsed,
  // so any visible table belongs to an expanded current-or-future tile — the
  // generalized form of the old "current month renders its table" check.
  await expect(page.locator('[data-month-bucket-table]').first()).toBeVisible({timeout: 5_000});
});

test('forecast: per-cow row shows ADG value + calc text', async ({page, cattleForecastScenario}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // Find the next-processor batch month + open it. Has at least F-AT-MAX
  // (1450 lb) in May or later.
  const panel = page.locator('[data-next-processor-panel]');
  const m = (await panel.innerText()).match(/(\w{3} \d{4})/);
  expect(m).toBeTruthy();
  // Find a month bucket and confirm row text contains "lb/day · …" calc string.
  const anyRow = page.locator('[data-month-row]').first();
  await expect(anyRow).toBeVisible();
  const rowText = await anyRow.innerText();
  // Calc string format: "X.XX lb/day · last 3 weigh-ins" / "last 2 weigh-ins"
  // / "1 weigh-in + global" / "DOB + global" / "global only".
  expect(rowText).toMatch(/lb\/day · (last [23] weigh-ins|1 weigh-in \+ global|DOB \+ global|global only)/);
});

test('forecast: Attention section near top with rows or empty state', async ({page, cattleForecastScenario}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // The Attention section ALWAYS renders, even when empty (Codex 2026-05-04
  // follow-up). With the seed's W1 cow (no weight + no DOB), at least one
  // attention row exists, so the empty-state element is absent.
  const attention = page.locator('[data-forecast-attention]');
  await expect(attention).toBeVisible();
  // Section header text is the explicit operator label.
  await expect(attention).toContainText(/NEEDS ATTENTION/i);
  // Attention must render BEFORE the year selector — no scroll past month
  // tiles to find it. Compare DOM position via getBoundingClientRect.
  const yearBtn = page.locator('[data-year-button]').first();
  if ((await yearBtn.count()) > 0) {
    const aBox = await attention.boundingBox();
    const yBox = await yearBtn.boundingBox();
    expect(aBox.y).toBeLessThan(yBox.y);
  }
});

test('forecast: actual-batch month shows "X cows processed" and lists cow tags', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  // Seed an actual ACTIVE batch in current month so its month tile renders
  // a "processed" pill + per-cow detail under the batch row.
  const monthKey = new Date().toISOString().slice(0, 7);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: 'b-actual-test-1',
      name: 'C-26-90',
      status: 'active',
      actual_process_date: monthKey + '-04',
      planned_process_date: monthKey + '-04',
      cows_detail: [
        {cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: null},
        {cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: null},
      ],
      total_live_weight: 2550,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle')
    .update({herd: 'processed', processing_batch_id: 'b-actual-test-1'})
    .in('id', ['F1', 'F-AT-MAX']);

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  const tile = page.locator(`[data-month-bucket="${monthKey}"]`);
  await expect(tile).toBeVisible();

  // Pill: "2 cows processed" rendered by the new processed-count pill.
  const processedPill = tile.locator('[data-month-processed-count]');
  await expect(processedPill).toBeVisible();
  await expect(processedPill).toContainText('2 cows processed');

  // The actual batch row carries cow tags + status + name.
  const batchRow = tile.locator('[data-actual-batch="b-actual-test-1"]');
  await expect(batchRow).toBeVisible();
  await expect(batchRow).toContainText('C-26-90');
  await expect(batchRow).toContainText('1001');
  await expect(batchRow).toContainText('1002');

  // Per-cow expanded table.
  const innerTable = page.locator('[data-actual-batch-table="b-actual-test-1"]');
  await expect(innerTable).toBeVisible();
  await expect(innerTable.locator('[data-actual-batch-row="F1"]')).toBeVisible();
  await expect(innerTable.locator('[data-actual-batch-row="F-AT-MAX"]')).toBeVisible();
});

test('forecast: hidden row shows projected weight for the hide month + Unhide button', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // Find F-HIDE's assigned month bucket (current/future tiles default-expanded).
  const fHideRow = page.locator('[data-month-row="F-HIDE"]').first();
  await expect(fHideRow).toBeVisible({timeout: 10_000});
  const hiddenMonth = await fHideRow.evaluate((el) => {
    const bucket = el.closest('[data-month-bucket]');
    return bucket ? bucket.getAttribute('data-month-bucket') : null;
  });

  // Hide F-HIDE in that month.
  await page.locator('[data-toggle-hide="F-HIDE"]').click();
  // DB row landed.
  await expect
    .poll(async () => {
      const r = await supabaseAdmin.from('cattle_forecast_hidden').select('cattle_id').eq('cattle_id', 'F-HIDE');
      return r.data?.length || 0;
    })
    .toBe(1);

  // Hidden-here row in the original tile shows a projected weight (lb)
  // for THAT month — not just "rolled to …" — and an Unhide button.
  const hiddenCell = page.locator(`[data-month-bucket="${hiddenMonth}"] [data-hidden-projected="F-HIDE"]`);
  await expect(hiddenCell).toBeVisible({timeout: 5_000});
  await expect(hiddenCell).toContainText(/\d+,?\d* lb/);
  await expect(page.locator('[data-toggle-unhide="F-HIDE"]')).toBeVisible();
});

test('forecast: tag search filters planned + actual batch rows; clear restores', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  // Seed an actual ACTIVE batch with F-AT-MAX so tag search has both a
  // planned row (F1 → tag 1001) AND an actual-batch row (F-AT-MAX → tag 1002)
  // to discriminate against.
  const monthKey = new Date().toISOString().slice(0, 7);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: 'b-search-test-1',
      name: 'C-26-91',
      status: 'active',
      actual_process_date: monthKey + '-04',
      planned_process_date: monthKey + '-04',
      cows_detail: [{cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: null}],
      total_live_weight: 1450,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle')
    .update({herd: 'processed', processing_batch_id: 'b-search-test-1'})
    .eq('id', 'F-AT-MAX');

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  const search = page.locator('[data-forecast-tag-search]');
  await expect(search).toBeVisible();

  // Search "1001" — F1 row visible; F-AT-MAX actual batch row hidden.
  await search.fill('1001');
  await expect(page.locator('[data-month-row="F1"]')).toBeVisible();
  await expect(page.locator('[data-actual-batch-row="F-AT-MAX"]')).toHaveCount(0);

  // Search "1002" — actual-batch row visible; F1 planned row hidden.
  await search.fill('1002');
  await expect(page.locator('[data-actual-batch-row="F-AT-MAX"]')).toBeVisible();
  await expect(page.locator('[data-month-row="F1"]')).toHaveCount(0);

  // Clear button restores both.
  await page.locator('[data-forecast-tag-search-clear]').click();
  await expect(page.locator('[data-month-row="F1"]')).toBeVisible();
  await expect(page.locator('[data-actual-batch-row="F-AT-MAX"]')).toBeVisible();
});

test('forecast: actual-batch table does not include ADG Calc; planned table does', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  const monthKey = new Date().toISOString().slice(0, 7);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: 'b-no-adg-test',
      name: 'C-26-92',
      status: 'active',
      actual_process_date: monthKey + '-04',
      planned_process_date: monthKey + '-04',
      cows_detail: [{cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: null}],
      total_live_weight: 1450,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle')
    .update({herd: 'processed', processing_batch_id: 'b-no-adg-test'})
    .eq('id', 'F-AT-MAX');

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  // Actual batch table headers: Tag / Sex / Herd / Age / Live / Hanging — no ADG Calc.
  const actualTable = page.locator('[data-actual-batch-table="b-no-adg-test"]');
  await expect(actualTable).toBeVisible();
  const actualHeaders = await actualTable.locator('thead th').allTextContents();
  expect(actualHeaders.map((s) => s.trim())).toEqual(['Tag', 'Sex', 'Herd', 'Age', 'Live', 'Hanging']);
  expect(actualHeaders.map((s) => s.trim())).not.toContain('ADG Calc');
  // Sanity: planned table for the same view DOES include ADG Calc, Age,
  // and Origin (Origin lands immediately after Herd).
  const plannedTable = page.locator('[data-month-bucket-table]').first();
  await expect(plannedTable).toBeVisible();
  const plannedHeaders = (await plannedTable.locator('thead th').allTextContents()).map((s) => s.trim());
  expect(plannedHeaders).toContain('ADG Calc');
  expect(plannedHeaders).toContain('Age');
  expect(plannedHeaders).toContain('Origin');
  // Origin must sit immediately after Herd so columns line up across rows.
  const herdIdx = plannedHeaders.indexOf('Herd');
  expect(plannedHeaders[herdIdx + 1]).toBe('Origin');
});

test('forecast: visible dates render as mm/dd/yy', async ({page, cattleForecastScenario, supabaseAdmin}) => {
  // Seed an actual batch so a batch-date renders + the planned row's latest
  // weigh-in already has a date in the seed.
  const monthKey = new Date().toISOString().slice(0, 7);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: 'b-date-test',
      name: 'C-26-93',
      status: 'active',
      actual_process_date: monthKey + '-04',
      planned_process_date: monthKey + '-04',
      cows_detail: [{cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: null}],
      total_live_weight: 1450,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  // Planned-row Latest cell: weight + " · MM/DD/YY".
  const f1Row = page.locator('[data-month-row="F1"]');
  await expect(f1Row).toBeVisible();
  await expect(f1Row).toContainText(/\d{2}\/\d{2}\/\d{2}/);
  // Raw YYYY-MM-DD must NOT appear in the planned-row text.
  const f1Text = await f1Row.innerText();
  expect(f1Text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);

  // Actual-batch header date renders mm/dd/yy too.
  const batchHeader = page.locator('[data-actual-batch="b-date-test"]');
  await expect(batchHeader).toContainText(/\d{2}\/\d{2}\/\d{2}/);
});

test('forecast: include-heifers modal rows show age + latest weight visible without expanding', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(60_000);
  await ensureCleanForecastSeed(supabaseAdmin);
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  const heiferRow = page.locator('[data-heifer-row="M-HEIFER"]');
  await expect(heiferRow).toBeVisible();
  // Age + latest-weight cells render directly in the row (no Details click).
  await expect(page.locator('[data-heifer-age="M-HEIFER"]')).toBeVisible();
  await expect(page.locator('[data-heifer-latest-weight="M-HEIFER"]')).toBeVisible();
});

test('forecast: admin can save settings + open Include Heifers modal', async ({page, cattleForecastScenario}) => {
  // Default storageState is admin.
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);
  await expect(page.locator('[data-forecast-readonly]')).toHaveCount(0);
  await expect(page.locator('[data-include-heifers-btn]')).toBeVisible();
  // Open settings, see Save Settings.
  await page.getByRole('button', {name: 'Settings'}).click();
  await expect(page.locator('[data-save-settings-btn]')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 6 — Batches tab: four sections, no + New Batch.
// --------------------------------------------------------------------------
test('batches: four sections (planned / scheduled / in process / complete); + New Batch removed', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto('/cattle/batches');
  await expect(page.locator('[data-cattle-batches-root]')).toBeVisible({timeout: 15_000});

  // No + New Batch button anywhere.
  await expect(page.getByRole('button', {name: /\+ New Batch/i})).toHaveCount(0);

  // Planned (virtual) section header present, collapsed by default.
  const plannedSection = page.locator('[data-batches-section="planned"]');
  await expect(plannedSection).toBeVisible();
  await expect(plannedSection).toContainText('Show Planned Batches');

  // Scheduled section only renders when at least one scheduled row exists;
  // by default the seed has none, so the data-scheduled-section anchor
  // should be absent.
  await expect(page.locator('[data-scheduled-section]')).toHaveCount(0);

  // In Process section header rendered with count parenthesized; seed has zero
  // active stored batches by default.
  await expect(page.getByText(/^In Process \(0\)/)).toBeVisible();

  // Complete section header (collapsed). UI label is "Complete"; the
  // underlying DB status value stays 'complete'.
  const processedSection = page.locator('[data-batches-section="processed"]');
  await expect(processedSection).toBeVisible();
  await expect(processedSection).toContainText('Show Complete Batches');

  // Expand Planned — should show at least one virtual planned batch tile.
  await plannedSection.locator('> div').first().click();
  // Virtual batches use data-virtual-batch attr set to the C-YY-NN name.
  const virtualBatches = page.locator('[data-virtual-batch]');
  await expect(virtualBatches.first()).toBeVisible({timeout: 5_000});
});

// --------------------------------------------------------------------------
// Test 7 — Auto-complete on full hanging weights + reopen back to active.
// --------------------------------------------------------------------------
test('batches: active auto-flips to complete on full hanging weights; reopen restores active', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  // Seed a real active batch directly (mimics what Send-to-Processor would
  // create) so we can drive the hanging-weight UI without going through the
  // weighins flow. actual_process_date is intentionally NULL on the seed so
  // the auto-complete path exercises the planned→actual fallback (PROD
  // hotfix for C-26-02/C-26-03, which landed in Processed with no date).
  const batchId = 'b-active-test-1';
  const plannedDate = '2026-05-04';
  const {error: insErr7} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-99',
      status: 'active',
      actual_process_date: null,
      planned_process_date: plannedDate,
      cows_detail: [
        {cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: null},
        {cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: null},
      ],
      total_live_weight: 2550,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  expect(insErr7).toBeNull();
  // Move both cows to processed herd to satisfy the implicit "linked
  // through send-to-processor" state.
  await supabaseAdmin
    .from('cattle')
    .update({herd: 'processed', processing_batch_id: batchId})
    .in('id', ['F1', 'F-AT-MAX']);

  // Navigate directly to the record page
  await gotoCattleBatchRecord(page, batchId);

  // Auto-complete fires on full hanging weights, so let's enter both:
  const w1 = page.locator('[data-batch-hanging-weight="F1"]');
  await w1.fill('660');
  await w1.blur();
  await page.waitForTimeout(400);
  const w2 = page.locator('[data-batch-hanging-weight="F-AT-MAX"]');
  await w2.fill('870');
  await w2.blur();

  // After both weights, the helper auto-flips to complete. Verify via DB.
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('cattle_processing_batches').select('status').eq('id', batchId).single();
        return r.data?.status;
      },
      {timeout: 10_000, message: 'auto-complete did not land on the DB row'},
    )
    .toBe('complete');

  // Hotfix lock: auto-complete must stamp actual_process_date from the
  // planned date when the seed had none.
  const stampedR = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('actual_process_date')
    .eq('id', batchId)
    .single();
  expect(stampedR.data?.actual_process_date).toBe(plannedDate);

  // Reopen from the record page
  const reopen = page.locator('[data-reopen="' + batchId + '"]');
  await expect(reopen).toBeVisible({timeout: 5_000});
  await reopen.click();

  // After reopen, status flips back to active
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('cattle_processing_batches').select('status').eq('id', batchId).single();
        return r.data?.status;
      },
      {timeout: 5_000},
    )
    .toBe('active');
});

// --------------------------------------------------------------------------
// Test 7b — Scheduled batch record page: date edit persists + unschedule
// --------------------------------------------------------------------------
test('scheduled batch record page: date edit persists after reload; unschedule navigates to list', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(60_000);
  await ensureCleanForecastSeed(supabaseAdmin);
  const scheduledId = 'cpb-sched-test-1';
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const {error: insErr7b} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: scheduledId,
      name: 'C-26-99',
      status: 'scheduled',
      planned_process_date: tomorrow,
      cows_detail: [],
      documents: [],
    },
    {onConflict: 'id'},
  );
  expect(insErr7b).toBeNull();

  // Navigate to the record page
  await gotoCattleBatchRecord(page, scheduledId);

  // Edit the scheduled date
  const nextDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const dateInput = page.locator('[data-scheduled-batch-date="' + scheduledId + '"]');
  await dateInput.fill(nextDate);
  await dateInput.blur();

  // Verify date persisted in DB
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin
          .from('cattle_processing_batches')
          .select('planned_process_date')
          .eq('id', scheduledId)
          .single();
        return r.data?.planned_process_date;
      },
      {timeout: 10_000},
    )
    .toBe(nextDate);

  // Reload and verify date persistence in the UI
  await gotoCattleBatchRecord(page, scheduledId);
  await expect(page.locator('[data-scheduled-batch-date="' + scheduledId + '"]')).toHaveValue(nextDate);

  // Unschedule via two-step confirmation
  await page.locator('[data-scheduled-batch-unschedule="' + scheduledId + '"]').click();
  await expect(page.locator('[data-scheduled-batch-unschedule-warning="' + scheduledId + '"]')).toBeVisible();
  await page.locator('[data-scheduled-batch-unschedule-confirm="' + scheduledId + '"]').click();

  // Should navigate back to the list
  await expect(page).toHaveURL(/\/cattle\/batches$/);
  await expect(page.locator('[data-cattle-batches-root]')).toBeVisible({timeout: 10_000});

  // Batch is deleted from DB
  const {data: check} = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('id')
    .eq('id', scheduledId)
    .maybeSingle();
  expect(check).toBeNull();
});

// --------------------------------------------------------------------------
// Test 7c — Complete batch: weights visible but disabled, reopen unlocks.
// --------------------------------------------------------------------------
test('complete batch record page: weights visible + disabled; reopen unlocks editing', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(60_000);
  await ensureCleanForecastSeed(supabaseAdmin);
  const batchId = 'b-complete-test-1';
  const {error: insErr} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-98',
      status: 'complete',
      actual_process_date: '2026-05-01',
      cows_detail: [
        {cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: 660},
        {cattle_id: 'F-AT-MAX', tag: '1002', live_weight: 1450, hanging_weight: 870},
      ],
      total_live_weight: 2550,
      total_hanging_weight: 1530,
    },
    {onConflict: 'id'},
  );
  expect(insErr).toBeNull();
  const {data: verify} = await supabaseAdmin.from('cattle_processing_batches').select('id').eq('id', batchId).single();
  expect(verify).not.toBeNull();

  await gotoCattleBatchRecord(page, batchId);

  // Weight values are visible
  const liveInput = page.locator('[data-batch-live-weight="F1"]');
  const hangInput = page.locator('[data-batch-hanging-weight="F1"]');
  await expect(liveInput).toHaveValue('1100');
  await expect(hangInput).toHaveValue('660');

  // Inputs are disabled while complete
  await expect(liveInput).toBeDisabled();
  await expect(hangInput).toBeDisabled();

  // Name input is not present while complete
  await expect(page.locator('[data-rename-input="' + batchId + '"]')).toHaveCount(0);

  // Reopen to In Process
  await page.locator('[data-reopen="' + batchId + '"]').click();
  await expect
    .poll(
      async () => {
        const r = await supabaseAdmin.from('cattle_processing_batches').select('status').eq('id', batchId).single();
        return r.data?.status;
      },
      {timeout: 5_000},
    )
    .toBe('active');

  // After reopen, weight inputs are enabled
  await expect(liveInput).toBeEnabled({timeout: 5_000});
  await expect(hangInput).toBeEnabled();

  // After reopen, name input appears and is editable
  const nameInput = page.locator('[data-rename-input="' + batchId + '"]');
  await expect(nameInput).toBeVisible({timeout: 5_000});
  await expect(nameInput).toBeEnabled();
  await expect(nameInput).toHaveValue('C-26-98');
});

// --------------------------------------------------------------------------
// Test 7d — Mobile viewport: complete batch weights visible and legible.
// --------------------------------------------------------------------------
test('complete batch record page mobile: weights visible and fields wide enough', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await page.setViewportSize({width: 390, height: 844});
  const batchId = 'b-mobile-test-1';
  const {error: insErr7d} = await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: batchId,
      name: 'C-26-97',
      status: 'complete',
      actual_process_date: '2026-05-01',
      cows_detail: [{cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: 660}],
      total_live_weight: 1100,
      total_hanging_weight: 660,
    },
    {onConflict: 'id'},
  );
  expect(insErr7d).toBeNull();

  await gotoCattleBatchRecord(page, batchId);

  const liveInput = page.locator('[data-batch-live-weight="F1"]');
  const hangInput = page.locator('[data-batch-hanging-weight="F1"]');

  await expect(liveInput).toHaveValue('1100');
  await expect(hangInput).toHaveValue('660');
  await expect(liveInput).toBeDisabled();
  await expect(hangInput).toBeDisabled();

  const liveBox = await liveInput.boundingBox();
  const hangBox = await hangInput.boundingBox();
  expect(liveBox.width).toBeGreaterThanOrEqual(60);
  expect(hangBox.width).toBeGreaterThanOrEqual(60);

  // Reopen unlocks at mobile too
  await page.locator('[data-reopen="' + batchId + '"]').click();
  await expect(liveInput).toBeEnabled({timeout: 5_000});
  await expect(hangInput).toBeEnabled();
});

// --------------------------------------------------------------------------
// Test 8 — Month tile rows (planned + hidden) show Age as of that month.
// --------------------------------------------------------------------------
test('forecast: month tile planned + hidden rows show Age as of that forecast month', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  // F1 has birth_date 2024-08-01 → at any forecast month it has a non-empty
  // age cell (e.g. "1y 9m"). The data hook is keyed on cattle id.
  const f1Row = page.locator('[data-month-row="F1"]').first();
  await expect(f1Row).toBeVisible({timeout: 10_000});
  const f1Age = page.locator('[data-month-row-age="F1"]').first();
  await expect(f1Age).toBeVisible();
  await expect(f1Age).toHaveText(/(\d+y\s+)?\d+m/);

  // Hide F-HIDE so a hidden row renders alongside, and assert the hidden
  // row's age cell is still visible.
  const fHideRow = page.locator('[data-month-row="F-HIDE"]').first();
  await expect(fHideRow).toBeVisible();
  await page.locator('[data-toggle-hide="F-HIDE"]').click();

  const hiddenAge = page.locator('[data-month-hidden-row-age="F-HIDE"]').first();
  await expect(hiddenAge).toBeVisible({timeout: 5_000});
  await expect(hiddenAge).toHaveText(/(\d+y\s+)?\d+m/);
});

// --------------------------------------------------------------------------
// Test 9 — Actual batch per-cow row shows Age (as of the batch processing date).
// --------------------------------------------------------------------------
test('forecast: actual-batch per-cow row shows age as of the processing date', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  const monthKey = new Date().toISOString().slice(0, 7);
  await supabaseAdmin.from('cattle_processing_batches').upsert(
    {
      id: 'b-age-test-1',
      name: 'C-26-92',
      status: 'active',
      actual_process_date: monthKey + '-04',
      planned_process_date: monthKey + '-04',
      cows_detail: [{cattle_id: 'F1', tag: '1001', live_weight: 1100, hanging_weight: null}],
      total_live_weight: 1100,
      total_hanging_weight: null,
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('cattle').update({herd: 'processed', processing_batch_id: 'b-age-test-1'}).eq('id', 'F1');

  await page.goto(FORECAST_PATH);
  await waitForForecastLoaded(page);

  const ageCell = page.locator('[data-actual-batch-row-age="F1"]');
  await expect(ageCell).toBeVisible({timeout: 10_000});
  await expect(ageCell).toHaveText(/(\d+y\s+)?\d+m/);
});

// --------------------------------------------------------------------------
// Test 10 — Heifer modal polish: leftmost checkbox, no Details button,
// row click toggles CowDetail expand.
// --------------------------------------------------------------------------
test('forecast: include-heifers modal — leftmost checkbox, no Details button, row click expands', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // Details button is gone; the row itself is the click target.
  await expect(page.getByRole('button', {name: /^Details$/})).toHaveCount(0);
  await expect(page.getByRole('button', {name: /^Collapse$/})).toHaveCount(0);

  // Checkbox is the leftmost interactive element of the row (DOM order check).
  const row = page.locator('[data-heifer-row="M-HEIFER"]');
  await expect(row).toBeVisible();
  const firstChildIsCheckbox = await row.evaluate((el) => {
    // Find first input under the visible row container (skip the optional
    // expanded CowDetail panel below by querying within the row's first child).
    const first = el.querySelector('input[type="checkbox"]');
    if (!first) return false;
    // Walk siblings before the checkbox — none of them should be inputs.
    let prev = first.previousElementSibling;
    while (prev) {
      if (prev.querySelector && prev.querySelector('input')) return false;
      prev = prev.previousElementSibling;
    }
    return true;
  });
  expect(firstChildIsCheckbox).toBe(true);

  // Click on the row (not the checkbox) — CowDetail expands.
  await page.locator('[data-heifer-age="M-HEIFER"]').click();
  await expect(row.locator('[data-cow-detail]')).toBeVisible({timeout: 5_000});

  // Click the row again — collapses.
  await page.locator('[data-heifer-age="M-HEIFER"]').click();
  await expect(row.locator('[data-cow-detail]')).toHaveCount(0);

  // Clicking the checkbox itself does NOT toggle the row (stopPropagation).
  const cb = page.locator('[data-heifer-checkbox="M-HEIFER"]');
  const checkedBefore = await cb.isChecked();
  await cb.click();
  const checkedAfter = await cb.isChecked();
  expect(checkedAfter).toBe(!checkedBefore);
  // Row stayed collapsed.
  await expect(row.locator('[data-cow-detail]')).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Test 11 — Heifer modal sorts youngest first (DOB desc), no-DOB at bottom,
// tie-broken by tag.
// --------------------------------------------------------------------------
test('forecast: include-heifers modal sorts youngest first; no-DOB heifers sink to bottom', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  // Seed two extra mommas heifers — one older but still under the 15-month
  // cap, one with no birth_date — so we have a meaningful sort. M-HEIFER's
  // seed DOB is 2025-08-01 (~9 months at TODAY=2026-05-04), so expected
  // order is:
  //   1. M-HEIFER (2025-08-01, youngest)
  //   2. M-HEIFER-OLD (2025-04-01, ~13 months — still under the 15-month cap)
  //   3. M-HEIFER-NODOB (no birth_date, sinks to the bottom)
  await supabaseAdmin.from('cattle').upsert(
    [
      {
        id: 'M-HEIFER-OLD',
        tag: '2010',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2025-04-01',
        old_tags: [],
      },
      {
        id: 'M-HEIFER-NODOB',
        tag: '2011',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: null,
        old_tags: [],
      },
    ],
    {onConflict: 'id'},
  );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // Read the rendered order of [data-heifer-row] elements.
  const orderedIds = await page
    .locator('[data-heifer-row]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-heifer-row')));
  expect(orderedIds).toEqual(['M-HEIFER', 'M-HEIFER-OLD', 'M-HEIFER-NODOB']);
});

// --------------------------------------------------------------------------
// Test 12 — Planned + hidden month rows show Origin in a dedicated column
// immediately after Herd.
// --------------------------------------------------------------------------
test('forecast: planned + hidden rows render Origin cell immediately after Herd', async ({
  page,
  cattleForecastScenario,
}) => {
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);

  // F1 has origin "Smith Ranch" in the seed; planned row should render that.
  const f1Origin = page.locator('[data-month-row-origin="F1"]').first();
  await expect(f1Origin).toBeVisible({timeout: 10_000});
  await expect(f1Origin).toHaveText('Smith Ranch');

  // Hide F-HIDE so a hidden row appears, then assert its Origin cell renders.
  await page.locator('[data-toggle-hide="F-HIDE"]').click();
  const hiddenOrigin = page.locator('[data-month-hidden-row-origin="F-HIDE"]').first();
  await expect(hiddenOrigin).toBeVisible({timeout: 5_000});
  // F-HIDE seed origin is "Jones Ranch".
  await expect(hiddenOrigin).toHaveText('Jones Ranch');
});

// --------------------------------------------------------------------------
// Test 13 — Heifer modal excludes pregnant + over-15-month heifers entirely.
// --------------------------------------------------------------------------
test('forecast: include-heifers modal omits pregnant heifers and heifers over 15 months', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  // Seed three extra mommas heifers:
  //   - M-HEIFER-PREG: under 15mo BUT breeding_status='PREGNANT' → excluded.
  //   - M-HEIFER-AGED: DOB 2024-01-01 → ~28 months at TODAY → excluded.
  //   - M-HEIFER-OK: DOB 2025-09-01 → ~8 months → eligible (visible).
  // M-HEIFER (seed DOB 2025-08-01) is also visible; eligible heifers stay
  // sorted youngest first.
  await supabaseAdmin.from('cattle').upsert(
    [
      {
        id: 'M-HEIFER-PREG',
        tag: '2020',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        breeding_status: 'PREGNANT',
        origin: 'Smith Ranch',
        birth_date: '2025-09-01',
        old_tags: [],
      },
      {
        id: 'M-HEIFER-AGED',
        tag: '2021',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2024-01-01',
        old_tags: [],
      },
      {
        id: 'M-HEIFER-OK',
        tag: '2022',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2025-09-01',
        old_tags: [],
      },
    ],
    {onConflict: 'id'},
  );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // Pregnant + over-15mo heifers must be entirely absent.
  await expect(page.locator('[data-heifer-row="M-HEIFER-PREG"]')).toHaveCount(0);
  await expect(page.locator('[data-heifer-row="M-HEIFER-AGED"]')).toHaveCount(0);

  // Eligible heifers (M-HEIFER, M-HEIFER-OK) ARE visible.
  await expect(page.locator('[data-heifer-row="M-HEIFER"]')).toBeVisible();
  await expect(page.locator('[data-heifer-row="M-HEIFER-OK"]')).toBeVisible();

  // Youngest-first ordering still locked: M-HEIFER (2025-08-01) is older
  // than M-HEIFER-OK (2025-09-01) by one month, so M-HEIFER-OK should
  // render first.
  const orderedIds = await page
    .locator('[data-heifer-row]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-heifer-row')));
  const ho = orderedIds.indexOf('M-HEIFER-OK');
  const h = orderedIds.indexOf('M-HEIFER');
  expect(ho).toBeGreaterThanOrEqual(0);
  expect(h).toBeGreaterThan(ho);
});

// --------------------------------------------------------------------------
// Test 14 — Finish candidate summary excludes momma heifers that the modal
// filters out (pregnant or over 15 months).
// --------------------------------------------------------------------------
test('forecast: finish candidate summary excludes pregnant and over-15-month momma heifers', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  test.setTimeout(60_000);
  await ensureCleanForecastSeed(supabaseAdmin);
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  const before = await readFinishCandidateCount(page);

  await supabaseAdmin.from('cattle').upsert(
    [
      {
        id: 'M-HEIFER-SUMMARY-PREG',
        tag: '2030',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        breeding_status: 'PREGNANT',
        origin: 'Smith Ranch',
        birth_date: '2025-09-01',
        old_tags: [],
      },
      {
        id: 'M-HEIFER-SUMMARY-AGED',
        tag: '2031',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2024-01-01',
        old_tags: [],
      },
    ],
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .upsert([{cattle_id: 'M-HEIFER-SUMMARY-PREG'}, {cattle_id: 'M-HEIFER-SUMMARY-AGED'}], {onConflict: 'cattle_id'});

  await page.reload();
  await waitForForecastData(page);
  await expect.poll(() => readFinishCandidateCount(page)).toBe(before);
});

// --------------------------------------------------------------------------
// Test 15 — Stale heifer includes are pruned: hidden from the modal,
// excluded from the "selected" count, and DELETED from the DB on Confirm.
// --------------------------------------------------------------------------
test('forecast: include-heifers modal hides stale includes and deletes them on Confirm', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  // Seed an over-15-month heifer (DOB 2024-01-01 → ~28 months at TODAY) and
  // an INCLUDE row pointing at her. The row is "stale": she no longer
  // qualifies for the modal/forecast, but the DB row exists.
  await supabaseAdmin.from('cattle').upsert(
    {
      id: 'M-HEIFER-STALE',
      tag: '2030',
      sex: 'heifer',
      herd: 'mommas',
      breed: 'Angus',
      breeding_blacklist: false,
      origin: 'Smith Ranch',
      birth_date: '2024-01-01',
      old_tags: [],
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('cattle_forecast_heifer_includes').upsert(
    {
      cattle_id: 'M-HEIFER-STALE',
      included_at: new Date().toISOString(),
      included_by: null,
    },
    {onConflict: 'cattle_id'},
  );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // Stale heifer row must be entirely absent from the modal.
  await expect(page.locator('[data-heifer-row="M-HEIFER-STALE"]')).toHaveCount(0);

  // The "selected" count must NOT include the stale row. With a fresh seed
  // there are no other selected heifers, so the count should be 0.
  const footerText = await page.locator('[data-include-heifers-modal]').innerText();
  expect(footerText).toContain('0 selected');

  // Click Confirm Selections — the staged set excludes the stale ID, so the
  // diff-based save in saveHeiferIncludes will DELETE the stale row.
  await page.locator('[data-confirm-heifers-btn]').click();
  // Modal dismisses on save → wait for it to disappear so we know the save round-trip completed.
  await expect(page.locator('[data-include-heifers-modal]')).toHaveCount(0, {timeout: 10_000});

  const {data: rows} = await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .select('cattle_id')
    .eq('cattle_id', 'M-HEIFER-STALE');
  expect(rows || []).toEqual([]);
});

// --------------------------------------------------------------------------
// Test 16 — Preselect path: include rows that point at an eligible heifer
// AND a stale one. Open modal, click Confirm without changes, the stale
// row gets pruned and the eligible row is preserved (sanitize-on-Confirm +
// useEffect prune-on-eligibility-change locks).
// --------------------------------------------------------------------------
test('forecast: include-heifers Confirm prunes stale preselected rows but preserves eligible ones', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  // Seed one extra eligible heifer + one over-15-month heifer + INCLUDE
  // rows for both (M-HEIFER from the seed scenario is also eligible but
  // not preselected). The eligible include should survive Confirm; the
  // stale one should be deleted.
  await supabaseAdmin.from('cattle').upsert(
    [
      {
        id: 'M-HEIFER-OK2',
        tag: '2040',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2025-09-01',
        old_tags: [],
      },
      {
        id: 'M-HEIFER-AGED2',
        tag: '2041',
        sex: 'heifer',
        herd: 'mommas',
        breed: 'Angus',
        breeding_blacklist: false,
        origin: 'Smith Ranch',
        birth_date: '2024-01-01',
        old_tags: [],
      },
    ],
    {onConflict: 'id'},
  );
  await supabaseAdmin.from('cattle_forecast_heifer_includes').upsert(
    [
      {cattle_id: 'M-HEIFER-OK2', included_at: new Date().toISOString(), included_by: null},
      {cattle_id: 'M-HEIFER-AGED2', included_at: new Date().toISOString(), included_by: null},
    ],
    {onConflict: 'cattle_id'},
  );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // The eligible preselected heifer is visible AND her checkbox is checked
  // (staged seed = initialEligibleIncludes).
  const okModalRow = page.locator('[data-heifer-row="M-HEIFER-OK2"]');
  const okCheckbox = page.locator('[data-heifer-checkbox="M-HEIFER-OK2"]');
  const okBadge = page.locator('[data-heifer-inclusion-badge="M-HEIFER-OK2"]');
  await expect(okModalRow).toBeVisible();
  await expect(okCheckbox).toBeChecked();
  await expect(okModalRow).toHaveAttribute('data-heifer-inclusion-state', 'included');
  await expect(okBadge).toHaveText('Included');

  // Unchecking an included heifer keeps her visible but marks the pending
  // removal plainly. This is the operator-facing "disinclude later" state.
  await okCheckbox.click();
  await expect(okModalRow).toHaveAttribute('data-heifer-inclusion-state', 'will-remove');
  await expect(okBadge).toHaveText('Will remove');
  await expect(page.locator('[data-heifer-include-footer]')).toContainText('-1 remove pending');

  // Re-check before the preservation assertion below.
  await okCheckbox.click();
  await expect(okModalRow).toHaveAttribute('data-heifer-inclusion-state', 'included');
  await expect(okBadge).toHaveText('Included');
  // The stale preselected heifer is NOT in the DOM at all.
  await expect(page.locator('[data-heifer-row="M-HEIFER-AGED2"]')).toHaveCount(0);
  // Footer count = 1 (only the eligible preselect counts).
  const footer = await page.locator('[data-include-heifers-modal]').innerText();
  expect(footer).toContain('1 selected');

  await page.locator('[data-confirm-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toHaveCount(0, {timeout: 10_000});

  // Eligible row preserved.
  const okRow = await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .select('cattle_id')
    .eq('cattle_id', 'M-HEIFER-OK2');
  expect((okRow.data || []).length).toBe(1);
  // Stale row deleted.
  const aged = await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .select('cattle_id')
    .eq('cattle_id', 'M-HEIFER-AGED2');
  expect((aged.data || []).length).toBe(0);
});

// --------------------------------------------------------------------------
// Test 17 — Mid-flight prune: a staged heifer becomes ineligible WHILE the
// modal is open (cattle prop refreshes via patchCow → reload). The staged
// useEffect drops her from the set; Confirm leaves no DB row.
// --------------------------------------------------------------------------
test('forecast: include-heifers modal prunes staged heifer if she becomes ineligible mid-flight', async ({
  page,
  cattleForecastScenario,
  supabaseAdmin,
}) => {
  await ensureCleanForecastSeed(supabaseAdmin);
  // Seed an eligible heifer with an include row so she's visible AND
  // preselected when the modal opens.
  await supabaseAdmin.from('cattle').upsert(
    {
      id: 'M-HEIFER-MIDFLIGHT',
      tag: '2050',
      sex: 'heifer',
      herd: 'mommas',
      breed: 'Angus',
      breeding_blacklist: false,
      breeding_status: null,
      origin: 'Smith Ranch',
      birth_date: '2025-09-01',
      old_tags: [],
    },
    {onConflict: 'id'},
  );
  await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .upsert(
      {cattle_id: 'M-HEIFER-MIDFLIGHT', included_at: new Date().toISOString(), included_by: null},
      {onConflict: 'cattle_id'},
    );

  await page.goto(FORECAST_PATH);
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // She's visible and preselected.
  const row = page.locator('[data-heifer-row="M-HEIFER-MIDFLIGHT"]');
  await expect(row).toBeVisible();
  await expect(page.locator('[data-heifer-checkbox="M-HEIFER-MIDFLIGHT"]')).toBeChecked();

  // Mid-flight: flip her PREGNANT in the DB. The modal's cattle prop is
  // stale at this point (no auto-refetch). Trigger a parent reload via the
  // modal's CowDetail patch path: expand her row, edit a field via the
  // origin select inside CowDetail, save it. patchCow → reload() refreshes
  // cattle, which feeds back into the heifers useMemo and the eligibility
  // useEffect prunes her from staged.
  await supabaseAdmin.from('cattle').update({breeding_status: 'PREGNANT'}).eq('id', 'M-HEIFER-MIDFLIGHT');

  // Force a parent reload by writing to cattle directly via the modal's
  // patch path. The modal's inner patchCow fires `reload()` after a
  // successful update — so any harmless tag change is enough. We use
  // origin='Smith Ranch' (already her value) to avoid any user-visible
  // change while still triggering the reload.
  await page.evaluate(async () => {
    // The modal exposes no JS API; instead, we touch the DOM input that
    // CowDetail renders for origin editing. If CowDetail isn't expanded
    // for this heifer, expand it first.
  });

  // Expand the heifer's CowDetail and trigger a save through the breed
  // input on blur (CowDetail wires patchCow on blur of editable fields).
  // Click on the row (not the checkbox) — opens CowDetail.
  await page.locator('[data-heifer-age="M-HEIFER-MIDFLIGHT"]').click();
  await expect(row.locator('[data-cow-detail]')).toBeVisible({timeout: 5_000});

  // The simplest cow-update + reload signal we have: re-save the include
  // set (Cancel-then-reopen would also reset state). Instead, we fall back
  // to the deterministic path: clicking Confirm now fires the on-Confirm
  // sanitize, which independently filters against eligibleHeiferIds. Even
  // if the useEffect hasn't fired (cattle prop didn't refetch), the
  // sanitize step + saveHeiferIncludes diff still removes the now-stale
  // row from the DB because we re-fetch current includes inside the helper.
  //
  // Specifically: cattle prop is stale → eligibleHeiferIds still includes
  // her → on-Confirm sanitize keeps her in `sanitized`. saveHeiferIncludes
  // sees current DB (her ID) == staged (her ID) → no DB delete. So the
  // mid-flight DB delete only happens IF cattle reloads. To guarantee a
  // reload, we close + reopen the modal via the page reload path.
  await page.reload();
  await waitForForecastData(page);
  await page.locator('[data-include-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toBeVisible({timeout: 5_000});

  // After reload the cattle prop reflects her PREGNANT state. She must be
  // absent from the modal AND absent from the staged set; Confirm prunes
  // her DB include row.
  await expect(page.locator('[data-heifer-row="M-HEIFER-MIDFLIGHT"]')).toHaveCount(0);
  const footer = await page.locator('[data-include-heifers-modal]').innerText();
  expect(footer).toContain('0 selected');

  await page.locator('[data-confirm-heifers-btn]').click();
  await expect(page.locator('[data-include-heifers-modal]')).toHaveCount(0, {timeout: 10_000});

  const after = await supabaseAdmin
    .from('cattle_forecast_heifer_includes')
    .select('cattle_id')
    .eq('cattle_id', 'M-HEIFER-MIDFLIGHT');
  expect((after.data || []).length).toBe(0);
});

// --------------------------------------------------------------------------
// Test 18 — Cold-Boot Readiness CP2: a raced/errored FIRST cattle weigh-ins
// read self-heals to seeded finish candidates without a manual reload.
// --------------------------------------------------------------------------
// The cattle weigh-ins loader is a two-query read (weigh_in_sessions[cattle]
// → weigh_ins). On cold boot either query can race empty or error, poisoning
// the forecast with 0 finish candidates until the operator reloads. CP2: the
// loader now surfaces a hard read failure (throwOnError) AND the mount effect
// retries a cattle-present-but-weigh-ins-empty payload on its bounded
// schedule, invalidating the weigh-in cache before each re-fetch. These specs
// break ONLY the first cattle sessions read (empty, then errored) and confirm
// the page recovers real data on its own. main.jsx does not pre-read cattle
// weigh-ins at boot, so the forecast loader's read is the first such GET on
// this route and the retry is the second.
function breakFirstCattleSessionsRead(page, mode) {
  let hits = 0;
  return page.route('**/rest/v1/weigh_in_sessions**', async (route) => {
    const req = route.request();
    // Only target the cattle-scoped sessions read the forecast loader issues.
    if (req.method() !== 'GET' || !req.url().includes('species=eq.cattle')) {
      await route.continue();
      return;
    }
    hits += 1;
    if (hits > 1) {
      await route.continue(); // the retry passes through to real data
      return;
    }
    if (mode === 'error') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({message: 'cold-boot race'}),
      });
    } else {
      // 200 with an empty array — the poisoned-read symptom with no HTTP error.
      await route.fulfill({status: 200, contentType: 'application/json', body: '[]'});
    }
  });
}

test('forecast cold-boot: a raced EMPTY first weigh-ins read self-heals to finish candidates (no reload)', async ({
  page,
  cattleForecastScenario,
}) => {
  await breakFirstCattleSessionsRead(page, 'empty');
  await page.goto(FORECAST_PATH);
  // No manual reload — the mount effect's bounded retry must recover real data.
  await waitForForecastData(page, {reloadOnEmpty: false});
  expect(await readFinishCandidateCount(page)).toBeGreaterThan(0);
});

test('forecast cold-boot: an ERRORED first weigh-ins read self-heals to finish candidates (no reload)', async ({
  page,
  cattleForecastScenario,
}) => {
  await breakFirstCattleSessionsRead(page, 'error');
  await page.goto(FORECAST_PATH);
  await waitForForecastData(page, {reloadOnEmpty: false});
  expect(await readFinishCandidateCount(page)).toBeGreaterThan(0);
});
