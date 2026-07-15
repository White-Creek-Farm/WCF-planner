// ============================================================================
// Cattle Herd filters/sort scenario seed — for tests/cattle_herd_filters.spec.js
// ============================================================================
// Builds a representative cattle population that covers the filter + sort
// dimensions exercised by the spec:
//
//   herd / sex / age / calving status / blacklist / weight tier / breed
//   (active + historical) / lineage / outcome herd visibility / weigh-in
//   freshness for stale/no/has-weight tiers.
//
// Age-bearing dates are RUNTIME-RELATIVE (offsets from wall-clock now), not
// fixed. A fixed birth_date rots: it eventually crosses an age-filter
// threshold as real time advances (B203's fixed 2025-01-15 birth date crossed
// ageMonths >= 18 on 2026-07-08 and broke the sex+age compose test). Calving
// dates stay fixed because the spec compares them against fixed cutoff dates,
// never against now.
// Stale-weight threshold default is 90 days; STALE_DATE is set ~150 days ago.
// ============================================================================

import {assertTestDatabase} from '../setup/assertTestDatabase.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`cattleHerdFiltersSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('cattleHerdFiltersSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`cattleHerdFiltersSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(
      `cattleHerdFiltersSeed: test admin user "${adminEmail}" missing from auth.users. ` +
        'Re-create via Supabase Auth dashboard.',
    );
  }
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
  return adminEmail;
}

// Reference dates are computed from wall-clock now so seeded ages and
// weigh-in freshness never rot. The age sort direction test reads birth_date
// strings directly, and relative offsets preserve the strict ordering, so it
// stays timezone-stable. UTC keeps the date strings host-timezone-independent.
const NOW = new Date();

function isoDaysAgo(days) {
  return new Date(NOW.getTime() - days * 86400000).toISOString().slice(0, 10);
}

// Approximate calendar months; the product ageMonths metric is
// floor(days / 30), so every offset below keeps >= 2 months of margin from
// the age thresholds the spec filters on (18mo min, 30mo maturity).
function isoMonthsAgo(months) {
  const d = new Date(NOW.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const TODAY_ISO = NOW.toISOString().slice(0, 10);
const FRESH_DATE = isoDaysAgo(7) + 'T12:00:00Z'; // ~7 days ago — within stale threshold
const STALE_DATE = isoDaysAgo(150) + 'T12:00:00Z'; // ~150 days ago — beyond 90-day default

const COWS = [
  // ── mommas — calving-status spread ─────────────────────────────────────
  {
    id: 'cow-mom-calved-current',
    tag: 'M001',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: isoMonthsAgo(73), // ~6yr — old momma
    dam_tag: 'D-001',
    sire_tag: 'S-001',
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-mom-calved-last-year',
    tag: 'M002',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: isoMonthsAgo(61),
    dam_tag: 'D-002',
    sire_tag: null, // sire missing
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-mom-never-calved',
    tag: 'M003',
    sex: 'heifer', // heifer in mommas — never-calved
    herd: 'mommas',
    breed: 'Hereford',
    breeding_blacklist: false,
    origin: 'Jones Ranch',
    birth_date: isoMonthsAgo(23), // ~23mo — over the 18mo filter floor, under 30mo maturity
    dam_tag: null, // both parents missing
    sire_tag: null,
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-mom-blacklist',
    tag: 'M004',
    sex: 'cow',
    herd: 'mommas',
    breed: 'Angus',
    breeding_blacklist: true,
    origin: 'Smith Ranch',
    birth_date: isoMonthsAgo(87),
    dam_tag: 'D-004',
    sire_tag: 'S-004',
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-mom-historical-breed',
    tag: 'M005',
    sex: 'cow',
    herd: 'mommas',
    // 'Heritage Wagyu' is not present in cattle_breeds — proves the breed
    // filter dropdown still surfaces observed historical values.
    breed: 'Heritage Wagyu',
    breeding_blacklist: false,
    origin: 'Smith Ranch',
    birth_date: isoMonthsAgo(44),
    pct_wagyu: 75,
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  // ── backgrounders — weight-tier spread ─────────────────────────────────
  {
    id: 'cow-bg-fresh',
    tag: 'B201',
    sex: 'heifer',
    herd: 'backgrounders',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(20), // ~20mo — over the 18mo filter floor
    dam_tag: 'D-201',
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-bg-stale',
    tag: 'B202',
    sex: 'heifer',
    herd: 'backgrounders',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(21), // ~21mo — over the 18mo filter floor
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-bg-noweight',
    tag: 'B203',
    sex: 'heifer',
    herd: 'backgrounders',
    breed: 'Hereford',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(16), // ~16mo — stays under the 18mo filter floor
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  // ── finishers ──────────────────────────────────────────────────────────
  {
    id: 'cow-fin-fresh',
    tag: 'F301',
    sex: 'steer',
    herd: 'finishers',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(27), // ~27mo
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  // ── bulls ──────────────────────────────────────────────────────────────
  {
    id: 'cow-bull-001',
    tag: 'BL401',
    sex: 'bull',
    herd: 'bulls',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(60), // ~5yr
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  // ── outcome herds ───────────────────────────────────────────────────────
  {
    id: 'cow-processed-001',
    tag: 'P501',
    sex: 'steer',
    herd: 'processed',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(52),
    old_tags: [],
    // Explicit resets so an upsert overwrites a stale worker row's mutable
    // state into the exact intended (active, unattached) shape.
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-sold-001',
    tag: 'S601',
    sex: 'cow',
    herd: 'sold',
    breed: 'Angus',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(75),
    sale_date: '2026-04-10',
    old_tags: [],
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
  {
    id: 'cow-deceased-001',
    tag: 'D701',
    sex: 'cow',
    herd: 'deceased',
    breed: 'Hereford',
    breeding_blacklist: false,
    birth_date: isoMonthsAgo(88),
    death_date: '2026-03-15',
    old_tags: [],
    deleted_at: null,
    deleted_by: null,
    processing_batch_id: null,
  },
];

const CALVING_RECS = [
  // M001 — 3 calves spread over years (most recent THIS year)
  {id: 'cr-m001-a', dam_tag: 'M001', calving_date: '2024-03-10', total_born: 1, deaths: 0},
  {id: 'cr-m001-b', dam_tag: 'M001', calving_date: '2025-04-12', total_born: 2, deaths: 0}, // twins
  {id: 'cr-m001-c', dam_tag: 'M001', calving_date: '2026-04-22', total_born: 1, deaths: 0},
  // M002 — calved LAST year only (matches calvingWindow.noneSince this year)
  {id: 'cr-m002-a', dam_tag: 'M002', calving_date: '2025-05-15', total_born: 1, deaths: 0},
  // M004 — calved long ago, then blacklisted
  {id: 'cr-m004-a', dam_tag: 'M004', calving_date: '2023-06-01', total_born: 1, deaths: 0},
  // M005 — has calved
  {id: 'cr-m005-a', dam_tag: 'M005', calving_date: '2024-09-01', total_born: 1, deaths: 0},
  // M003 — NO calving record (never-calved heifer in mommas)
];

const WEIGH_INS = [
  // Fresh weigh-ins (within 90-day stale threshold)
  {tag: 'B201', weight: 800, entered_at: FRESH_DATE},
  {tag: 'F301', weight: 1300, entered_at: FRESH_DATE},
  // Stale weigh-in (older than 90 days)
  {tag: 'B202', weight: 700, entered_at: STALE_DATE},
  // (B203 has no weigh-in — exercises noWeight tier)
];

const BREEDS_ACTIVE = [
  {id: 'br-angus', label: 'Angus', active: true},
  {id: 'br-hereford', label: 'Hereford', active: true},
  // Heritage Wagyu intentionally absent so the merge-with-observed test passes.
];

const ORIGINS_ACTIVE = [
  {id: 'or-smith', label: 'Smith Ranch', active: true},
  {id: 'or-jones', label: 'Jones Ranch', active: true},
];

export async function seedCattleHerdFilters(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  await ensureAdminProfile(supabaseAdmin);

  // cattle_breeds + cattle_origins are NOT in the test reset whitelist (other
  // specs don't touch them). Upsert so re-runs don't trip the PK constraint.
  must(await supabaseAdmin.from('cattle_breeds').upsert(BREEDS_ACTIVE, {onConflict: 'id'}), 'cattle_breeds upsert');
  must(await supabaseAdmin.from('cattle_origins').upsert(ORIGINS_ACTIVE, {onConflict: 'id'}), 'cattle_origins upsert');

  must(await supabaseAdmin.from('cattle').upsert(COWS, {onConflict: 'id'}), 'cattle insert');

  must(
    await supabaseAdmin.from('cattle_calving_records').upsert(CALVING_RECS, {onConflict: 'id'}),
    'cattle_calving_records insert',
  );

  // Weigh-ins live on shared sessions table — synthesize a single session so
  // the cattle helper's two-query loader sees them. Session itself is
  // metadata-only for this spec.
  must(
    await supabaseAdmin.from('weigh_in_sessions').upsert(
      {
        id: 'wsess-cattle-herd-filters-seed',
        species: 'cattle',
        date: TODAY_ISO,
        team_member: process.env.VITE_TEST_ADMIN_EMAIL,
        herd: 'finishers',
        status: 'complete',
        started_at: STALE_DATE,
        completed_at: FRESH_DATE,
      },
      {onConflict: 'id'},
    ),
    'weigh_in_sessions insert',
  );

  must(
    await supabaseAdmin.from('weigh_ins').upsert(
      WEIGH_INS.map((w, i) => ({
        id: `wi-cattle-herd-filters-${i}`,
        session_id: 'wsess-cattle-herd-filters-seed',
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
    'weigh_ins insert',
  );

  return {
    cows: COWS,
    breeds: BREEDS_ACTIVE,
    origins: ORIGINS_ACTIVE,
    counts: {
      mommas: COWS.filter((c) => c.herd === 'mommas').length,
      backgrounders: COWS.filter((c) => c.herd === 'backgrounders').length,
      finishers: COWS.filter((c) => c.herd === 'finishers').length,
      bulls: COWS.filter((c) => c.herd === 'bulls').length,
      processed: COWS.filter((c) => c.herd === 'processed').length,
      deceased: COWS.filter((c) => c.herd === 'deceased').length,
      sold: COWS.filter((c) => c.herd === 'sold').length,
    },
  };
}
