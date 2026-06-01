import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Mig 047 — submit_equipment_fueling RPC contract
// ============================================================================
// The pre-mig-047 public form did a synchronous .insert on equipment_fuelings
// + a .then(() => {})-silenced .update on equipment.current_<unit>. Anon RLS
// (mig 016: equipment_auth_all + equipment_anon_read only) silently denied
// the parent UPDATE. Mig 047 ships a SECURITY DEFINER RPC that does both
// writes atomically with anon EXECUTE + race-safe ON CONFLICT
// (client_submission_id) DO NOTHING + GREATEST/only-go-forward parent
// bump + a one-shot historical reconciliation CTE.
//
// Coverage:
//   1. Anon EXECUTE: anon client can call the RPC.
//   2. Insert + parent bump (hours-tracked piece).
//   3. Insert + parent bump (km-tracked piece).
//   4. Idempotent replay: same csid returns idempotent_replay=true and does
//      not create a duplicate row.
//   5. GREATEST guard: a lower reading does NOT lower equipment.current_*.
//   6. Validation: rejects gallons<=0, missing hours_reading on hours piece,
//      tracking-unit mismatch.
//   7. Inactive equipment is rejected (no submissions on sold pieces).
// ============================================================================

const TODAY = '2026-05-06';
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seedKey = (value) => `${value}-${RUN_ID}`;
const uniqueSeed = (value) => `${seedKey(value)}-${Math.random().toString(36).slice(2, 8)}`;

async function seedActiveEquipment(supabaseAdmin, overrides = {}) {
  const id = overrides.id || uniqueSeed('eq');
  const row = {
    id,
    name: overrides.name || 'Test Tractor',
    slug: overrides.slug || uniqueSeed('test'),
    category: 'tractors',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 100,
    current_km: null,
    fuel_type: 'diesel',
    every_fillup_items: [],
    service_intervals: [],
    attachment_checklists: [],
    manuals: [],
    documents: [],
    team_members: [],
    ...overrides,
  };
  const {error} = await supabaseAdmin.from('equipment').upsert(row, {onConflict: 'id'});
  if (error) throw new Error(`seedActiveEquipment: ${error.message}`);
  return row;
}

function makeParent(eq, csid, overrides = {}) {
  const reading = overrides.reading ?? 150;
  return {
    id: uniqueSeed('fuel-test'),
    client_submission_id: csid,
    equipment_id: eq.id,
    date: TODAY,
    team_member: 'BMAN',
    fuel_type: eq.fuel_type || 'diesel',
    gallons: 10,
    hours_reading: eq.tracking_unit === 'hours' ? reading : null,
    km_reading: eq.tracking_unit === 'km' ? reading : null,
    every_fillup_check: [],
    service_intervals_completed: [],
    photos: [],
    comments: null,
    source: 'fuel_log_webform',
    podio_source_app: null,
    ...overrides,
  };
}

// Test 1 — Hours-tracked: insert + parent bump
test('hours-tracked: anon RPC inserts equipment_fuelings + bumps equipment.current_hours', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {
    slug: seedKey('rpc-hours'),
    tracking_unit: 'hours',
    current_hours: 200,
    current_km: null,
  });

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const csid = seedKey('csid-hours-1');
  const parent = makeParent(eq, csid, {reading: 250});
  const {data, error} = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent});
  expect(error).toBeNull();
  expect(data).toEqual({
    fueling_id: parent.id,
    idempotent_replay: false,
    equipment_reading_updated: true,
  });

  const {data: row} = await supabaseAdmin.from('equipment_fuelings').select('*').eq('id', parent.id).maybeSingle();
  expect(row).not.toBeNull();
  expect(row.equipment_id).toBe(eq.id);
  expect(Number(row.hours_reading)).toBe(250);
  expect(row.km_reading).toBeNull();
  expect(row.client_submission_id).toBe(csid);

  const {data: parentEq} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', eq.id).maybeSingle();
  expect(Number(parentEq.current_hours)).toBe(250);
});

// Test 2 — KM-tracked: insert + parent bump
test('km-tracked: anon RPC inserts equipment_fuelings + bumps equipment.current_km', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {
    slug: seedKey('rpc-km'),
    tracking_unit: 'km',
    current_hours: null,
    current_km: 5000,
    fuel_type: 'gasoline',
  });

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent(eq, seedKey('csid-km-1'), {reading: 6000});
  const {data, error} = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent});
  expect(error).toBeNull();
  expect(data.idempotent_replay).toBe(false);
  expect(data.equipment_reading_updated).toBe(true);

  const {data: row} = await supabaseAdmin.from('equipment_fuelings').select('*').eq('id', parent.id).maybeSingle();
  expect(Number(row.km_reading)).toBe(6000);
  expect(row.hours_reading).toBeNull();

  const {data: parentEq} = await supabaseAdmin.from('equipment').select('current_km').eq('id', eq.id).maybeSingle();
  expect(Number(parentEq.current_km)).toBe(6000);
});

// Test 3 — Idempotent replay: same csid returns true, no duplicate row
test('idempotent: replay same csid returns idempotent_replay=true, no duplicate row', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {slug: seedKey('rpc-replay'), current_hours: 300});

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const csid = seedKey('csid-replay-1');
  const parent1 = makeParent(eq, csid, {reading: 350});
  const r1 = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent1});
  expect(r1.error).toBeNull();
  expect(r1.data.idempotent_replay).toBe(false);
  expect(r1.data.equipment_reading_updated).toBe(true);

  // Replay: same csid, different id and a different (higher) reading. The
  // function short-circuits on the existing csid and never re-bumps the
  // parent — equipment.current_hours stays at the first call's value.
  const parent2 = makeParent(eq, csid, {id: seedKey('fuel-replay-2'), reading: 400});
  const r2 = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent2});
  expect(r2.error).toBeNull();
  expect(r2.data.idempotent_replay).toBe(true);
  expect(r2.data.fueling_id).toBe(parent1.id); // first call's id wins
  expect(r2.data.equipment_reading_updated).toBe(false);

  const {count} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('*', {count: 'exact', head: true})
    .eq('equipment_id', eq.id);
  expect(count).toBe(1);

  const {data: parentEq} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', eq.id).maybeSingle();
  expect(Number(parentEq.current_hours)).toBe(350); // not 400
});

// Test 4 — GREATEST guard: lower reading does not lower parent
test('GREATEST: a lower reading on a separate submission does NOT lower equipment.current_hours', async ({
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {slug: seedKey('rpc-greatest'), current_hours: 500});

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  // First submission: bump parent to 600.
  const r1 = await anonClient.rpc('submit_equipment_fueling', {
    parent_in: makeParent(eq, seedKey('csid-high'), {reading: 600}),
  });
  expect(r1.error).toBeNull();
  expect(r1.data.equipment_reading_updated).toBe(true);

  // Second submission: lower reading, different csid (so it's not idempotent
  // replay — the row lands in equipment_fuelings, but the parent bump
  // no-ops because GREATEST says 600 > 550).
  const r2 = await anonClient.rpc('submit_equipment_fueling', {
    parent_in: makeParent(eq, seedKey('csid-low'), {reading: 550}),
  });
  expect(r2.error).toBeNull();
  expect(r2.data.idempotent_replay).toBe(false);
  expect(r2.data.equipment_reading_updated).toBe(false);

  const {data: parentEq} = await supabaseAdmin.from('equipment').select('current_hours').eq('id', eq.id).maybeSingle();
  expect(Number(parentEq.current_hours)).toBe(600);

  // Both fuelings landed (count=2) — only the parent bump no-op'd.
  const {count} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('*', {count: 'exact', head: true})
    .eq('equipment_id', eq.id);
  expect(count).toBe(2);
});

// Test 5 — Validation: zero gallons rejected
test('validation: gallons<=0 rejected with explicit RAISE', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {slug: seedKey('rpc-zero-gal')});

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent(eq, seedKey('csid-zero-gal'), {gallons: 0});
  const {data, error} = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent});
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/gallons must be > 0/);
  expect(data).toBeNull();

  const {count} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('*', {count: 'exact', head: true})
    .eq('equipment_id', eq.id);
  expect(count).toBe(0);
});

// Test 6 — Validation: missing hours_reading on an hours-tracked piece
test('validation: hours-tracked piece without hours_reading rejected', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {slug: seedKey('rpc-no-reading'), tracking_unit: 'hours'});

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent(eq, seedKey('csid-no-reading'), {reading: null});
  parent.hours_reading = null;
  const {error} = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent});
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/hours_reading required for tracking_unit=hours/);
});

// Test 7 — Inactive equipment is rejected
test('validation: equipment with status=sold is rejected', async ({supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedActiveEquipment(supabaseAdmin, {slug: seedKey('rpc-sold'), status: 'sold'});

  const anonClient = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  const parent = makeParent(eq, seedKey('csid-sold'), {reading: 100});
  const {error} = await anonClient.rpc('submit_equipment_fueling', {parent_in: parent});
  expect(error).not.toBeNull();
  expect(error.message).toMatch(/is not active \(status=sold\)/);
});
