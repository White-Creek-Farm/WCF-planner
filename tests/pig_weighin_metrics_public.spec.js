import {test, expect} from './fixtures.js';
import {waitForAppReady} from './helpers/appReady.js';

// ============================================================================
// Public WeighInsWebform pig metrics + descending sort smoke
// ============================================================================
// Codex-required public-form integration smoke for commit 3. The admin spec
// (tests/pig_weighin_metrics_admin.spec.js) covers RPC correctness across
// scopes; this spec proves the UNIQUE public-form parts:
//   - the metrics block resolves via the RPC EXECUTE path on the public form
//   - the metrics block sits ABOVE the "Recent entries (N)" header
//   - the four documented labels render in the public layout
//   - the operator-facing #N tags stay stable across the descending-by-
//     weight render
//   - sessionIsFresh gate does NOT suppress metrics for an existing draft
//     reached through resume
//
// Scope: this is a smoke; it does not duplicate every RPC case from the
// admin spec.
//
// Runs authenticated (default admin storageState) — the /weighins form is now
// login-required, so an anonymous context lands on the LoginScreen. The
// metrics block, descending sort, and #N stability render identically when
// authed; the resumed draft is a service-role seed, not a form submission.
// ============================================================================

const SUB_NAME = 'P-26-09A';
const SUB_SLUG = 'p-26-09a';
const SUB_ID = 'sub-public-09a';
const PARENT_ID = 'group-public-09';
const CYCLE_ID = 'cy-public-09';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seedActiveDraftSession(supabaseAdmin) {
  // Active draft is timestamped TODAY so the public form's 7-day cutoff
  // includes it in the resume list.
  const sessionDate = todayISO();
  // Cycle exposureStart 200 days ago so the farrowing window opens around
  // -84d and closes around -40d. Farrow record at -100d falls inside the
  // window with a 14-day buffer.
  const exposureStart = isoDaysAgo(200);
  const farrowDate = isoDaysAgo(100);

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
    batchName: 'P-26-09',
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

  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-breeding-v1',
      data: [{id: CYCLE_ID, group: '1', exposureStart, sowCount: 5}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert(
    {
      key: 'ppp-farrowing-v1',
      data: [{id: 'f-public-09', group: '1', farrowingDate: farrowDate}],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('app_store').upsert({key: 'ppp-breeders-v1', data: []}, {onConflict: 'key'});

  // webform_config so the public picker has the active groups.
  await supabaseAdmin.from('webform_config').upsert({key: 'active_groups', data: [SUB_NAME]}, {onConflict: 'key'});

  // Draft session with five entries, deliberately scrambled by weight.
  // Entered_at order is the load order (#N tags); display will sort DESC
  // by weight (282 > 263 > 250 > 244 > 221).
  const sessionId = 's-public-current';
  const sessionResult = await supabaseAdmin.from('weigh_in_sessions').upsert(
    {
      id: sessionId,
      species: 'pig',
      herd: null,
      date: sessionDate,
      batch_id: SUB_SLUG,
      broiler_week: null,
      started_at: `${sessionDate}T08:00:00.000Z`,
      completed_at: null,
      team_member: 'BMAN',
      status: 'draft',
      notes: null,
      client_submission_id: null,
    },
    {onConflict: 'id'},
  );
  if (sessionResult.error) throw new Error(`weigh_in_sessions upsert: ${sessionResult.error.message}`);
  // Insert in a known order so #N tags are stable: 221 first → #1, etc.
  // Avg weight = 252, so the metrics row's "Avg weight" cell shows 252 lb;
  // pick entry weights that don't equal 252 to avoid filter collisions in
  // assertions.
  const weights = [221, 282, 244, 263, 250];
  const weighInsResult = await supabaseAdmin.from('weigh_ins').upsert(
    weights.map((w, i) => ({
      id: `${sessionId}-e${i + 1}`,
      session_id: sessionId,
      tag: null,
      weight: w,
      note: null,
      new_tag_flag: false,
      entered_at: `${sessionDate}T08:00:${String(i).padStart(2, '0')}.000Z`,
      client_submission_id: null,
      sent_to_trip_id: null,
      sent_to_group_id: null,
      send_to_processor: false,
      target_processing_batch_id: null,
      transferred_to_breeding: false,
      transfer_breeder_id: null,
      feed_allocation_lbs: null,
      prior_herd_or_flock: null,
    })),
    {onConflict: 'id'},
  );
  if (weighInsResult.error) throw new Error(`weigh_ins upsert: ${weighInsResult.error.message}`);
}

test('public form: metrics block renders above Recent entries with stable #N descending sort', async ({
  supabaseAdmin,
  resetDb,
  page,
}) => {
  await resetDb();
  await seedActiveDraftSession(supabaseAdmin);

  await page.goto('/weighins');
  await waitForAppReady(page);

  // Pick Pig species. The species picker renders a "Pig" tile.
  await page.getByText('Pig', {exact: true}).click();

  // Resume the seeded draft. The "Resume a draft session" card lists the
  // seeded session with its batch_id slug.
  const resumeTile = page.locator('text=' + SUB_SLUG).first();
  await expect(resumeTile).toBeVisible({timeout: 15_000});
  await resumeTile.click();

  // Wait for the metrics block to appear (post-RPC). The four labels are
  // exposed via data-pig-metric on each cell.
  const metricsBlock = page.locator('[data-pig-metric="age"]').first();
  await expect(metricsBlock).toBeVisible({timeout: 15_000});

  // All four documented labels render.
  await expect(page.locator('[data-pig-metric="age"]').first()).toContainText('Age at weigh-in');
  await expect(page.locator('[data-pig-metric="feed"]').first()).toContainText('Feed/pig');
  await expect(page.locator('[data-pig-metric="adg"]').first()).toContainText('Group ADG');
  // No prior session for this batch_id slug → ADG falls back.
  await expect(page.locator('[data-pig-metric="adg"]').first()).toContainText('— no prior weigh-in');
  await expect(page.locator('[data-pig-metric="avg"]').first()).toContainText('Avg weight');
  await expect(page.locator('[data-pig-metric="avg"]').first()).toContainText('252 lb');

  // Metrics block precedes the "Recent entries (N)" header in DOM order.
  const metricsRect = await page.locator('[data-pig-metric="age"]').first().boundingBox();
  const recentHeader = page.locator('text=/^Recent entries \\(5\\)$/').first();
  await expect(recentHeader).toBeVisible();
  const recentRect = await recentHeader.boundingBox();
  expect(metricsRect.y).toBeLessThan(recentRect.y);

  // Recent entries render in DESC weight order with stable #N tags. The
  // public form prints "#1, #2 ..." pinned to insertion order.
  // Pull all #N + weight rows from the recent-entries section by reading
  // the full text of each entry row.
  const entryRows = page.locator('text=/^#\\d+$/');
  const rendered = await entryRows.allTextContents();
  // Rendered order should be: heaviest first. Insertion order was
  // [221=#1, 282=#2, 244=#3, 263=#4, 250=#5]. DESC by weight =
  // [282=#2, 263=#4, 250=#5, 244=#3, 221=#1].
  expect(rendered.slice(0, 5)).toEqual(['#2', '#4', '#5', '#3', '#1']);
});
