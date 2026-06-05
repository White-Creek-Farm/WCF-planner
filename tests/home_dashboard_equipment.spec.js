import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// HomeDashboard equipment-attention regression spec
// ============================================================================
// Locks the THREE alert kinds the EQUIPMENT ATTENTION section renders
// (overdue / fillup_streak / warranty) and the TWO seed shapes that must
// NOT generate a row (near-due-but-not-overdue services, and old-fueling-
// by-calendar-time). Equipment maintenance is hour/km-based, not calendar-
// based — animal daily reports are the calendar workflow, equipment is not.
//
// Production hooks on the wrapping <div> of each attention row in
// src/dashboard/HomeDashboard.jsx:
//   data-attention-kind="overdue|fillup_streak|warranty"
//   data-equipment-slug="<slug>"
//
// Selectors anchor on BOTH attrs (defensive — protects against future
// seed evolution where multiple pieces of equipment might land in the
// test DB). Per Codex's review, text assertions use toContainText (not
// exact text) so midnight-crossing day counts don't flake.
// ============================================================================

function attentionRow(page, kind, slug) {
  return page.locator(`[data-attention-kind="${kind}"][data-equipment-slug="${slug}"]`);
}

async function gotoHome(page, kind, slug) {
  await page.goto('/');
  // EQUIPMENT ATTENTION section renders after the equipment + fuelings
  // useEffect resolves (loaded defensively per the comment at HomeDashboard.jsx:48).
  await expect(attentionRow(page, kind, slug)).toBeVisible({timeout: 15_000});
}

async function gotoHomeAndWaitLoaded(page) {
  await page.goto('/');
  // Boot-loader fades after the first paint and the auth + data effects
  // resolve. Same load gate the smoke spec uses. Guarantees the dashboard
  // had a chance to render before we assert absence of a row.
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
}

// --------------------------------------------------------------------------
// Test 1 — overdue (positive)
// --------------------------------------------------------------------------
test('overdue: 100hr service past next_due renders data-attention-kind="overdue"', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'overdue'});
  await gotoHome(page, seed.kind, seed.slug);

  const row = attentionRow(page, seed.kind, seed.slug);
  for (const substr of seed.expectedSubstrings) {
    await expect(row).toContainText(substr);
  }
});

// --------------------------------------------------------------------------
// Test 2 — near-due service (negative lock)
// --------------------------------------------------------------------------
// Equipment is hour/km-based, not calendar-based. A near-due service
// (within ~50h of next_due but not overdue) used to render as kind:
// 'upcoming'. Per Ronnie 2026-04-28 (eve+), that surfacing was noise —
// admins watch overdue, not "due in 40 hours" forecasts. This spec
// regression-locks that no row appears for a near-due seed.
test('near-due service does NOT render an Equipment Attention row (negative lock)', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'upcoming'});
  await gotoHomeAndWaitLoaded(page);
  await expect(page.locator(`[data-equipment-slug="${seed.slug}"]`)).toHaveCount(0);
  await expect(page.locator('[data-home-equipment-maintenance-caught-up="1"]')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 3 — old-fueling-by-calendar-time (negative lock)
// --------------------------------------------------------------------------
// Equipment fueling cadence is operator-driven, not calendar-driven. A
// piece of equipment that hasn't been fueled in 14+ days used to render
// as kind: 'missed_fueling'. Per Ronnie 2026-04-28 (eve+), that surfacing
// confused two distinct workflows (animal dailys = calendar; equipment
// = hour/km usage). This spec regression-locks that no row appears for a
// stale-fueling seed.
test('old fueling date does NOT render an Equipment Attention row (negative lock)', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'missed_fueling'});
  await gotoHomeAndWaitLoaded(page);
  await expect(page.locator(`[data-equipment-slug="${seed.slug}"]`)).toHaveCount(0);
  await expect(page.locator('[data-home-equipment-maintenance-caught-up="1"]')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 4 — fillup_streak (positive)
// --------------------------------------------------------------------------
test('fillup_streak: never-ticked every-fillup item across 2 fuelings renders data-attention-kind="fillup_streak"', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'fillup_streak'});
  await gotoHome(page, seed.kind, seed.slug);

  const row = attentionRow(page, seed.kind, seed.slug);
  for (const substr of seed.expectedSubstrings) {
    await expect(row).toContainText(substr);
  }
});

// --------------------------------------------------------------------------
// Test 5 — warranty (positive)
// --------------------------------------------------------------------------
test('warranty: expiration within WARRANTY_WINDOW_DAYS renders data-attention-kind="warranty"', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'warranty'});
  await gotoHome(page, seed.kind, seed.slug);

  const row = attentionRow(page, seed.kind, seed.slug);
  for (const substr of seed.expectedSubstrings) {
    await expect(row).toContainText(substr);
  }
});

// --------------------------------------------------------------------------
// Test 6 — sort order across mixed kinds (positive)
// --------------------------------------------------------------------------
// HomeDashboard.jsx locks KIND_ORDER = {overdue: 0, fillup_streak: 1,
// warranty: 2} with alphabetical-within-kind tiebreak (see the comment block
// above the sort call). The previous 5 tests each seed one kind in
// isolation, so the cross-kind ordering has never been asserted. This test
// seeds one of each positive kind (mix scenario) and asserts the rendered
// EQUIPMENT ATTENTION rows come back in priority order.
test('sort order: mixed overdue + fillup_streak + warranty render overdue → fillup_streak → warranty', async ({
  page,
  homeDashboardEquipmentMixScenario,
}) => {
  const {items} = homeDashboardEquipmentMixScenario;

  await page.goto('/');
  // Wait for the first expected row before reading positions; same gating
  // pattern the single-kind tests use.
  await expect(attentionRow(page, items[0].kind, items[0].slug)).toBeVisible({timeout: 15_000});

  const rows = page.locator('[data-attention-kind][data-equipment-slug^="eq-attention-mix-"]');
  await expect(rows).toHaveCount(items.length);

  const rendered = await rows.evaluateAll((els) =>
    els.map((el) => ({
      kind: el.getAttribute('data-attention-kind'),
      slug: el.getAttribute('data-equipment-slug'),
    })),
  );
  expect(rendered).toEqual(items);
});

// --------------------------------------------------------------------------
// Test 7 — auto-clear via public fueling RPC (positive)
// --------------------------------------------------------------------------
// Seeds an overdue piece, asserts the row is present on /home, then drives
// the same anon path public /equipment/<slug> submissions hit
// (submit_equipment_fueling, mig 047) with a service_intervals_completed
// entry for the 100hr service. Reload and assert the overdue row no longer
// renders for that slug.
//
// total_tasks=0 with items_completed=[] is the empty-checklist completion
// shape: aggregateCompletionsByMilestone in src/lib/equipment.js reads
// total_tasks from the CURRENT equipment config (tasks=[] -> 0) and
// virtually-fully-satisfies the milestone when the union of items_completed
// reaches that count. hours_reading=110 snaps to milestone 100 (10 closer
// than 200), satisfying it; next_due then becomes 200 and current_hours
// stays 110 via the RPC's GREATEST guard, so until_due=90 -> not overdue.
//
// RPC return shape is already covered by tests/equipment_fueling_rpc.spec.js
// — this test only asserts the dashboard outcome.
test('auto-clear: anon fueling RPC ticking the 100hr service clears the overdue row after reload', async ({
  page,
  homeDashboardEquipmentScenario,
}) => {
  const seed = await homeDashboardEquipmentScenario({kind: 'overdue'});
  await gotoHome(page, seed.kind, seed.slug);

  // Seed factory creates the equipment row with id = 'eq-attention-' + kind
  // (see tests/scenarios/home_dashboard_equipment_seed.js). The RPC keys on
  // equipment.id, not slug, so use the deterministic id directly here.
  const equipmentId = `eq-attention-${seed.kind}`;

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const today = new Date().toISOString().slice(0, 10);
  const parent_in = {
    id: 'fuel-autoclear-1',
    client_submission_id: 'csid-autoclear-1',
    equipment_id: equipmentId,
    date: today,
    team_member: 'BMAN',
    fuel_type: 'diesel',
    gallons: 10,
    hours_reading: 110,
    km_reading: null,
    every_fillup_check: [],
    service_intervals_completed: [
      // Completion shape mirrors EquipmentFuelingWebform.jsx — note that the
      // top-level interval key is `interval`, not `hours_or_km`. The
      // aggregator in src/lib/equipment.js groups by c.interval and skips
      // entries without it.
      {interval: 100, kind: 'hours', label: '100hr service', completed_at: today, items_completed: [], total_tasks: 0},
    ],
    photos: [],
    comments: null,
    source: 'fuel_log_webform',
    podio_source_app: null,
  };
  const {error} = await anonClient.rpc('submit_equipment_fueling', {parent_in});
  expect(error).toBeNull();

  await page.reload();
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator(`[data-equipment-slug="${seed.slug}"]`)).toHaveCount(0);
});
