// ============================================================================
// Cattle Forecast scenario seed — for tests/cattle_forecast.spec.js
// ============================================================================
// Builds a representative cattle population covering every dimension the
// Forecast spec exercises:
//
//   - F1, F2, F3 finishers with different ADG/projection trajectories
//   - F-AT-MAX finisher already at 1450 lb (regression for past-month bug)
//   - F-HIDE-CANDIDATE finisher we'll hide in tests
//   - momma steer (auto-included via mommas-steer rule)
//   - momma heifer (excluded by default; included via the modal in one test)
//   - momma cow (NEVER forecasted — adult cow rule)
//   - processed cow (NEVER forecasted)
//   - 1 backgrounder
//
// Weigh-ins are anchored to TODAY (2026-05-04 spec time) so the rolling 3-week
// ADG ladder picks up F1/F2/F-AT-MAX cleanly. F3 has older weigh-ins so it
// falls back to two-most-recent and projects further out.
//
// cattle_forecast_settings is left at table-default so the helper's fallback
// path uses 1200/1500/1.18/64/3.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';
import {ensureTestAdminProfile} from '../setup/testAdminIdentity.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`cattleForecastSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

const TODAY_ISO = '2026-05-04';
const FOURTEEN_DAYS_AGO = '2026-04-20';
const NINETY_DAYS_AGO = '2026-02-03';
const SESSION_ID = 'wsess-cattle-forecast-seed';

const COWS = [
  // Finishers — projections drive the spec's month assignments.
  {
    id: 'F1',
    tag: '1001',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2024-08-01',
    old_tags: [],
  },
  // F-AT-MAX is already inside the display window (1200..1500). Without the
  // monthsForAssignment fix it would land in 2026-01.
  {
    id: 'F-AT-MAX',
    tag: '1002',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2024-04-01',
    old_tags: [],
  },
  // F-HIDE-CANDIDATE — used by the hide/unhide cycle test.
  {
    id: 'F-HIDE',
    tag: '1003',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Jones Ranch',
    birth_date: '2024-09-01',
    old_tags: [],
  },
  // F3 — projects further out (no recent weigh-ins, falls back to two-most-recent).
  {
    id: 'F3',
    tag: '1004',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Hereford',
    breeding_blacklist: false,
    origin: 'Jones Ranch',
    birth_date: '2025-01-15',
    old_tags: [],
  },
  // Momma cow — adult, NEVER forecasted.
  {
    id: 'M-COW',
    tag: '2001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2020-04-01',
    old_tags: [],
  },
  // Momma steer — auto-included with global ADG only.
  {
    id: 'M-STEER',
    tag: '2002',
    sex: 'steer',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2025-04-01',
    old_tags: [],
  },
  // Momma heifer — default-excluded; one test includes via modal.
  // DOB 2025-08-01 keeps her under the 15-month modal cap at TODAY=2026-05-04
  // (≈9 months old). The Forecast/Heifers modal filters out heifers older
  // than 15 months and PREGNANT heifers — see isHeiferEligibleForInclude.
  {
    id: 'M-HEIFER',
    tag: '2003',
    sex: 'heifer',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2025-08-01',
    old_tags: [],
  },
  // Backgrounder.
  {
    id: 'B1',
    tag: '3001',
    sex: 'heifer',
    herd: 'backgrounders',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Jones Ranch',
    birth_date: '2025-01-15',
    old_tags: [],
  },
  // Processed — NEVER forecasted.
  {
    id: 'P1',
    tag: '4001',
    sex: 'steer',
    herd: 'processed',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: '2022-01-01',
    old_tags: [],
  },
];

const WEIGH_INS = [
  // F1 — rolling ADG ~2 lb/day, anchor 1100 lb today
  {tag: '1001', weight: 1100, entered_at: TODAY_ISO + 'T12:00:00Z'},
  {tag: '1001', weight: 1072, entered_at: FOURTEEN_DAYS_AGO + 'T12:00:00Z'},
  // F-AT-MAX — at 1450 lb today, ADG ~2/d
  {tag: '1002', weight: 1450, entered_at: TODAY_ISO + 'T12:00:00Z'},
  {tag: '1002', weight: 1422, entered_at: FOURTEEN_DAYS_AGO + 'T12:00:00Z'},
  // F-HIDE — rolling ADG, lighter, projects ~3-4 months out
  {tag: '1003', weight: 950, entered_at: TODAY_ISO + 'T12:00:00Z'},
  {tag: '1003', weight: 922, entered_at: FOURTEEN_DAYS_AGO + 'T12:00:00Z'},
  // F3 — old weigh-ins only, two-most-recent fallback at slow ADG
  {tag: '1004', weight: 700, entered_at: NINETY_DAYS_AGO + 'T12:00:00Z'},
  {tag: '1004', weight: 670, entered_at: '2025-12-01T12:00:00Z'},
  // M-STEER — global ADG only; one weigh-in is fine (single-anchor projection).
  {tag: '2002', weight: 800, entered_at: TODAY_ISO + 'T12:00:00Z'},
  // B1 — rolling ADG
  {tag: '3001', weight: 700, entered_at: TODAY_ISO + 'T12:00:00Z'},
  {tag: '3001', weight: 680, entered_at: FOURTEEN_DAYS_AGO + 'T12:00:00Z'},
];

const BREEDS = [
  {id: 'br-angus', label: 'Angus', active: true},
  {id: 'br-hereford', label: 'Hereford', active: true},
];

const ORIGINS = [
  {id: 'or-smith', label: 'Smith Ranch', active: true},
  {id: 'or-jones', label: 'Jones Ranch', active: true},
];

// Every insert here uses a fixed id and upsert(onConflict:'id') rather than a
// plain insert. resetTestDatabase TRUNCATEs cattle before this runs, so the
// table is normally empty — but Playwright starts a fresh worker process after
// any test failure (its default clean-state behavior), and that worker handoff
// can race the shared single test DB: a dying worker's in-flight cattle.insert
// can land AFTER the new worker's TRUNCATE, leaving stale seed rows that made a
// plain insert trip cattle_pkey intermittently. Upsert makes the seed
// idempotent against that race without retries, sleeps, or masking assertions
// (the rows carry identical data, so re-writing them is a no-op).
export async function seedCattleForecast(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');

  // Barrier 1 — independent reference + profile rows. cattle_breeds/origins
  // are not FK-referenced by the cattle rows (breed/origin are text labels),
  // and the admin profile is independent of both, so all three run together.
  // cattle_breeds + cattle_origins aren't in the test reset whitelist; upsert
  // so re-runs don't trip the PK constraint.
  await Promise.all([
    ensureTestAdminProfile(supabaseAdmin),
    supabaseAdmin
      .from('cattle_breeds')
      .upsert(BREEDS, {onConflict: 'id'})
      .then((r) => must(r, 'cattle_breeds upsert')),
    supabaseAdmin
      .from('cattle_origins')
      .upsert(ORIGINS, {onConflict: 'id'})
      .then((r) => must(r, 'cattle_origins upsert')),
  ]);

  // Barrier 2 — animal rows.
  must(await supabaseAdmin.from('cattle').upsert(COWS, {onConflict: 'id'}), 'cattle upsert');

  // Barrier 3 — session row (weigh_ins FK session_id → weigh_in_sessions).
  // Synthesize a cattle weigh-in session so the cattle cache returns the
  // weigh-ins via its two-query loader.
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: SESSION_ID,
        species: 'cattle',
        date: TODAY_ISO,
        team_member: process.env.VITE_TEST_ADMIN_EMAIL,
        herd: 'finishers',
        status: 'complete',
        started_at: NINETY_DAYS_AGO + 'T08:00:00Z',
        completed_at: TODAY_ISO + 'T12:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions upsert',
  );

  // Barrier 4 — dependent weigh-ins.
  must(
    await supabaseAdmin.from('weigh_ins').upsert(
      WEIGH_INS.map((w, i) => ({
        id: 'wi-cattle-forecast-' + i,
        session_id: SESSION_ID,
        tag: w.tag,
        weight: w.weight,
        note: null,
        new_tag_flag: false,
        send_to_processor: false,
        target_processing_batch_id: null,
        prior_herd_or_flock: null,
        entered_at: w.entered_at,
      })),
      {onConflict: 'id'},
    ),
    'weigh_ins upsert',
  );

  return {
    cows: COWS,
    sessionId: SESSION_ID,
    today: TODAY_ISO,
  };
}

// Send-to-Processor scenario: an open finisher session with multiple flagged
// entries the spec uses to drive the modal's gate + name-match cases.
export async function seedCattleForecastSendFlow(supabaseAdmin) {
  const base = await seedCattleForecast(supabaseAdmin);

  // Convert seed-session to a draft + flag F1 + F-AT-MAX as send_to_processor.
  // F-HIDE is also flagged so the spec's "block by hide" test can hide it
  // and verify the gate rejects when its tag is outside the allowed set.
  const drafSessionId = 'wsess-cattle-forecast-send-draft';
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: drafSessionId,
        species: 'cattle',
        date: base.today,
        team_member: process.env.VITE_TEST_ADMIN_EMAIL,
        herd: 'finishers',
        status: 'draft',
        started_at: base.today + 'T08:00:00Z',
      },
      {onConflict: 'id'},
    ),
    'send-flow draft session upsert',
  );
  must(
    await supabaseAdmin.from('weigh_ins').upsert(
      [
        {
          id: 'wi-send-F1',
          session_id: drafSessionId,
          tag: '1001',
          weight: 1100,
          send_to_processor: true,
          new_tag_flag: false,
          entered_at: base.today + 'T08:00:00Z',
        },
        {
          id: 'wi-send-F-AT-MAX',
          session_id: drafSessionId,
          tag: '1002',
          weight: 1450,
          send_to_processor: true,
          new_tag_flag: false,
          entered_at: base.today + 'T08:01:00Z',
        },
        {
          id: 'wi-send-F-HIDE',
          session_id: drafSessionId,
          tag: '1003',
          weight: 950,
          send_to_processor: true,
          new_tag_flag: false,
          entered_at: base.today + 'T08:02:00Z',
        },
      ],
      {onConflict: 'id'},
    ),
    'send-flow weigh_ins upsert',
  );

  return {...base, draftSessionId: drafSessionId};
}
