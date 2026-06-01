// ============================================================================
// Broiler timeline scenario seed — for tests/broiler_timeline.spec.js
// ============================================================================
// Single parameterized seed used across all four A7 tests.
//
//   seedBroilerTimeline(supabaseAdmin, { withActiveLayer = false,
//                                         withRetirement = false } = {})
//
// Date strategy: option (d) per Codex review — wide-range seed dates
// computed RELATIVE to the seed-side equivalent of todayISO() so the
// tests stay stable regardless of when they're run. Both the seed
// (Node-side) and the component (browser-side) reach the same `today`
// value because they both use new Date().toISOString().slice(0, 10).
//
// Bound math (BroilerTimelineView.jsx:6-10 contract):
//   tlStart = today - 90d
//   tlEnd   = max(today + 30d, latest rendered end + 30d)
//
// Seed shape:
//   1 broiler batch — processingDate = today + 60d. Latest broiler-side
//     contribution is +60d, so tlEnd = today + 90d when broiler-only.
//   1 active layer (when withActiveLayer)  — schooner_exit_date = today
//     + 180d. Dominates the broiler when included; tlEnd = today + 210d.
//   1 Retirement Home (when withRetirement) — schooner_exit_date = today
//     + 240d. SHOULD BE EXCLUDED by the timeline. The active-layer end
//     date is set lower than Retirement so the assertion `tlEnd ===
//     today + 210d` (NOT today + 270d) proves the exclusion is real,
//     not just incidentally invisible.
//
// Returns the precomputed expected bounds so the spec doesn't have to
// recompute them from offsets.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`broilerTimelineSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

// Same semantics as src/lib/dateUtils.js todayISO() and addDays(iso, n).
// Reimplemented here to avoid depending on browser-side imports from a
// Node-side seed.
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysISO(isoOrDays, days) {
  // Two call shapes for ergonomic reuse: addDaysISO(0)=today,
  // addDaysISO(n)=today+n, addDaysISO(iso, n)=iso+n.
  if (typeof isoOrDays === 'number' && days === undefined) {
    days = isoOrDays;
    isoOrDays = todayISO();
  }
  const d = new Date(isoOrDays + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const BROILER_BATCH_ID = 'br-test-b2601';
const ACTIVE_LAYER_ID = 'lb-test-active';
const RETIREMENT_LAYER_ID = 'lb-test-retirement';

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('broilerTimelineSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`broilerTimelineSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(`broilerTimelineSeed: test admin user "${adminEmail}" missing.`);
  }
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
}

export async function seedBroilerTimeline(supabaseAdmin, {withActiveLayer = false, withRetirement = false} = {}) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  await ensureAdminProfile(supabaseAdmin);

  const today = todayISO();

  // Broiler batch — `breed` and `hatchDate` deliberately omitted so
  // calcTimeline's "live" derivation guard (`if (b.hatchDate && b.breed)`)
  // short-circuits. Latest contribution is the explicit processingDate.
  const broilerBatch = {
    id: BROILER_BATCH_ID,
    name: 'B-26-01',
    breed: '',
    hatchDate: '',
    brooderIn: addDaysISO(-240),
    brooderOut: addDaysISO(-180),
    schoonerIn: addDaysISO(-180),
    schoonerOut: addDaysISO(-60),
    processingDate: addDaysISO(60),
    status: 'active',
  };
  must(
    await supabaseAdmin.from('app_store').upsert({
      key: 'ppp-v4',
      data: [broilerBatch],
    }),
    'app_store ppp-v4 upsert',
  );

  // Layer batches (optional). Both rows are status='active' and the
  // active-vs-retirement distinction is by NAME — that's the contract
  // BroilerTimelineView.jsx:47 reads.
  const layerRows = [];
  if (withActiveLayer) {
    layerRows.push({
      id: ACTIVE_LAYER_ID,
      name: 'L-26-01',
      status: 'active',
      brooder_entry_date: addDaysISO(-60),
      brooder_exit_date: addDaysISO(-30),
      schooner_entry_date: addDaysISO(-30),
      schooner_exit_date: addDaysISO(180),
    });
  }
  if (withRetirement) {
    // Retirement Home's projected end is set LATER than the active layer
    // intentionally — if the exclusion ever breaks, tlEnd will jump from
    // today+210 to today+270 and Test 2 will catch it.
    layerRows.push({
      id: RETIREMENT_LAYER_ID,
      name: 'Retirement Home',
      status: 'active',
      brooder_entry_date: null,
      brooder_exit_date: null,
      schooner_entry_date: addDaysISO(1),
      schooner_exit_date: addDaysISO(240),
    });
  }
  if (layerRows.length > 0) {
    must(await supabaseAdmin.from('layer_batches').upsert(layerRows, {onConflict: 'id'}), 'layer_batches insert');
  }

  // Compute expected bounds so the spec asserts against pre-derived
  // strings rather than recomputing from offsets at assert time. Latest
  // is the LARGEST end-date that should contribute (Retirement excluded).
  const broilerLatest = broilerBatch.processingDate;
  const activeLayerLatest = withActiveLayer ? addDaysISO(180) : null;
  const latestEnd = activeLayerLatest && activeLayerLatest > broilerLatest ? activeLayerLatest : broilerLatest;
  const tlStart = addDaysISO(today, -90);
  const tlEnd = addDaysISO(latestEnd, 30);

  return {
    today,
    tlStart,
    tlEnd,
    latestEnd,
    broilerBatch,
    activeLayer: withActiveLayer ? layerRows.find((r) => r.id === ACTIVE_LAYER_ID) : null,
    retirementLayer: withRetirement ? layerRows.find((r) => r.id === RETIREMENT_LAYER_ID) : null,
  };
}
