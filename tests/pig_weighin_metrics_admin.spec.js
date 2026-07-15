import {test, expect} from './fixtures.js';

// ============================================================================
// Admin /pig/weighins metrics row + descending-by-weight display lock
// ============================================================================
// The pig_session_metrics RPC (mig 049) feeds the admin
// LivestockWeighInsView, where the pig session DataTable carries the four
// metrics as COLUMNS (Age at weigh-in, Feed/pig, Group ADG, Avg weight,
// plus Rank-matched pig ADG). Clicking a session row navigates to the
// session record page, which renders entries by descending weight while
// the persisted entered_at order stays unchanged.
//
// This spec seeds a complete pig session via supabaseAdmin (direct inserts
// into weigh_in_sessions + weigh_ins + app_store), navigates to
// /pig/weighins, and verifies:
//   1. The pig session row renders the four metric column values.
//   2. The legacy standalone "avg N lb" badge does NOT appear for pig
//      (Codex W3 — single source of truth; the pig Avg weight column
//      renders the bare "<N> lb" value instead).
//   3. The session record page orders entries by weight descending.
//
// Public-form coverage: the W1 gating + RPC wiring + descending sort all
// exercise the same code paths through the formatter helpers (unit tested
// in src/lib/pigForecast.test.js) and the static-shape lock in
// tests/static/pig_weighin_metrics_static.test.js. Adding a public-form
// e2e would duplicate the offline_queue_weigh_ins.spec.js fresh-session
// machinery; deferring per Codex's "focused Playwright" guidance.
// ============================================================================

const PARENT_BATCH = 'P-26-09';
const SUB_NAME = 'P-26-09A';
const SUB_SLUG = 'p-26-09a';
const SUB_ID = 'sub-admin-09a';
const PARENT_ID = 'group-admin-09';
const CYCLE_ID = 'cy-admin-09';

async function seedFeederGraph(supabaseAdmin) {
  const sub = {
    id: SUB_ID,
    name: SUB_NAME,
    giltCount: 5,
    boarCount: 5,
    originalPigCount: 10,
    legacyFeedLbs: 50,
  };
  const group = {
    id: PARENT_ID,
    batchName: PARENT_BATCH,
    cycleId: CYCLE_ID,
    giltCount: 5,
    boarCount: 5,
    originalPigCount: 10,
    startDate: '2026-06-01',
    legacyFeedLbs: 0,
    status: 'active',
    subBatches: [sub],
    processingTrips: [],
    pigMortalities: [],
  };
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-feeders-v1', data: [group]}, {onConflict: 'key'});

  // Cycle exposureStart 2025-12-20 → farrowing window 2026-04-15–2026-05-29.
  // Farrowing record at 2026-04-15. Session at 2026-08-04 → 111 days.
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-breeding-v1',
      data: [{id: CYCLE_ID, group: '1', exposureStart: '2025-12-20', sowCount: 5}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-farrowing-v1',
      data: [{id: 'f-admin-09', group: '1', farrowingDate: '2026-04-15'}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-breeders-v1', data: []}, {onConflict: 'key'});
}

async function seedPigSession(supabaseAdmin, {sessionId, date, status, weights}) {
  const startedAt = `${date}T08:00:00.000Z`;
  const completedAt = status === 'complete' ? `${date}T08:30:00.000Z` : null;
  const sessionResult = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: sessionId,
      species: 'pig',
      herd: null,
      date,
      batch_id: SUB_SLUG,
      broiler_week: null,
      started_at: startedAt,
      completed_at: completedAt,
      team_member: 'BMAN',
      status,
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  if (sessionResult.error) throw new Error(`weigh_in_sessions upsert: ${sessionResult.error.message}`);
  if (weights.length > 0) {
    const rows = weights.map((w, i) => ({
      id: `${sessionId}-e${i + 1}`,
      session_id: sessionId,
      tag: null,
      weight: w,
      note: null,
      new_tag_flag: false,
      entered_at: `${date}T08:00:${String(i).padStart(2, '0')}.000Z`,
      client_submission_id: null,
      sent_to_trip_id: null,
      sent_to_group_id: null,
      send_to_processor: false,
      target_processing_batch_id: null,
      transferred_to_breeding: false,
      transfer_breeder_id: null,
      feed_allocation_lbs: null,
      prior_herd_or_flock: null,
    }));
    const {error} = await supabaseAdmin.from('weigh_ins').upsert(rows, {onConflict: 'id'});
    if (error) throw new Error(`weigh_ins upsert: ${error.message}`);
  }
}

test('pig session row renders the four metric columns; admin avg badge is absent for pig', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin);
  await seedPigSession(supabaseAdmin, {
    sessionId: 's-admin-current',
    date: '2026-08-04',
    status: 'complete',
    weights: [240, 250, 260, 270, 280], // mean 260
  });

  await page.goto('/pig/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // The pig list is a DataTable whose header carries the metric labels.
  for (const label of ['Age at weigh-in', 'Feed/pig', 'Group ADG', 'Avg weight', 'Rank-matched pig ADG']) {
    await expect(page.getByRole('columnheader', {name: label})).toBeVisible({timeout: 15_000});
  }

  // The session row carries the metric VALUES (RPC fan-out is async, so
  // wait on the avg value rather than the row shell).
  const sessionRow = page.locator('tr[data-weighin-session-tile="s-admin-current"]');
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  // 111 days → daysToMWD: floor(111/30)=3 months, floor((111-90)/7)=3 weeks.
  await expect(sessionRow).toContainText('3m 3w', {timeout: 15_000});
  // No prior session seeded → Group ADG falls back to the no-prior label.
  await expect(sessionRow).toContainText('— no prior weigh-in');
  // Feed/pig: 50 legacy lbs across 10 pigs → 5 lb.
  await expect(sessionRow).toContainText('5 lb');
  await expect(sessionRow).toContainText('260 lb');

  // Codex W3: pig rows must NOT show the legacy standalone "avg <N> lb"
  // badge — the Avg weight column renders the bare value instead
  // (cattle/sheep/broiler tables still render the badge; this test only
  // seeds pig sessions).
  const pageText = await page.textContent('body');
  expect(pageText).not.toMatch(/\bavg\s+260\s+lb\b/);
});

test('pig group ADG returns from the RPC when a prior pig session exists for the same batch_id slug', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin);
  // Prior session 30 days back, mean 200; current at mean 230 → +30/30 = 1.0 lb/day.
  await seedPigSession(supabaseAdmin, {
    sessionId: 's-admin-prior',
    date: '2026-07-05',
    status: 'complete',
    weights: [180, 190, 200, 210, 220], // mean 200
  });
  await seedPigSession(supabaseAdmin, {
    sessionId: 's-admin-current2',
    date: '2026-08-04',
    status: 'complete',
    weights: [210, 220, 230, 240, 250], // mean 230 — paired-rank ADG +30/30 = 1.0
  });

  await page.goto('/pig/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  const sessionRow = page.locator('tr[data-weighin-session-tile="s-admin-current2"]');
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  // Group ADG column value from the RPC (mean 200 → 230 over 30 days).
  await expect(sessionRow).toContainText('+1.00 lb/day', {timeout: 15_000});
});

test('session record page sorts entries by weight DESC while persisted order stays entered_at ASC', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedFeederGraph(supabaseAdmin);
  // Insert in a deliberately scrambled weight order. Persisted entered_at
  // ASC is the load order; the display must rearrange to descending weight.
  await seedPigSession(supabaseAdmin, {
    sessionId: 's-admin-sort',
    date: '2026-08-04',
    status: 'complete',
    weights: [221, 282, 244, 263, 250], // sum 1260, avg 252
  });

  await page.goto('/pig/weighins');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Open the session record page through the list row (row IS the target).
  const sessionRow = page.locator('tr[data-weighin-session-tile="s-admin-sort"]');
  await expect(sessionRow).toBeVisible({timeout: 15_000});
  await sessionRow.click();
  await expect(page).toHaveURL(/\/weigh-in-sessions\/s-admin-sort$/, {timeout: 10_000});

  // The dense pig entry table renders unsent rows with an editable weight
  // input (placeholder "lb"); read the values in DOM order. No row is
  // sent/transferred here, so every seeded entry renders the input path.
  const entryRows = page.locator('tr[data-pig-entry-row]');
  await expect(entryRows).toHaveCount(5, {timeout: 15_000});
  const weightInputs = page.locator('tr[data-pig-entry-row] input[placeholder="lb"]');
  await expect(weightInputs).toHaveCount(5);
  const rendered = [];
  for (const input of await weightInputs.all()) {
    rendered.push(parseFloat(await input.inputValue()));
  }
  expect(rendered).toEqual([282, 263, 250, 244, 221]);

  // DB persistence stayed in insertion order.
  const {data: dbEntries} = await supabaseAdmin
    .from('weigh_ins')
    .select('weight,entered_at')
    .eq('session_id', 's-admin-sort')
    .order('entered_at', {ascending: true});
  const dbOrder = dbEntries.map((e) => Number(e.weight));
  expect(dbOrder).toEqual([221, 282, 244, 263, 250]);
});
