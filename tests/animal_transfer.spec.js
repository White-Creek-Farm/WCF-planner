import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// Manual animal transfer — migration 075 transactional RPCs
// ============================================================================
// Exercises transfer_cattle_animal / transfer_sheep_animal (the RPC the
// record-page transfer control calls) end to end against TEST:
//
//   1  Cattle move updates cattle, writes cattle_transfers, logs status.changed
//   2  Cattle no-op (same herd) returns noop and writes nothing
//   3  Cattle move to deceased sets death_date
//   4  Sheep move updates sheep, writes sheep_transfers, logs status.changed
//   5  Anon/unauth caller is rejected (REVOKE from anon)
//   6  Deleted source row is rejected
//   7  status.changed transfer events surface in global Activity
// ============================================================================

const TEST_ADMIN_EMAIL = process.env.VITE_TEST_ADMIN_EMAIL;
const TEST_ADMIN_PASSWORD = process.env.VITE_TEST_ADMIN_PASSWORD;

function newAnonClient() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY, {
    auth: {autoRefreshToken: false, persistSession: false},
  });
}

async function newAdminAuthedClient() {
  const sb = newAnonClient();
  const {error} = await sb.auth.signInWithPassword({email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD});
  if (error) throw new Error(`admin signInWithPassword failed: ${error.message}`);
  return sb;
}

// --------------------------------------------------------------------------
// Test 1 — Cattle move updates row + audit + status.changed Activity
// --------------------------------------------------------------------------
test('cattle transfer: updates herd, writes audit, logs status.changed', async ({
  supabaseAdmin,
  animalTransferScenario,
}) => {
  const ids = animalTransferScenario;
  const adminSb = await newAdminAuthedClient();

  const res = await adminSb.rpc('transfer_cattle_animal', {
    p_entity_id: ids.cowId,
    p_to_herd: 'finishers',
    p_team_member: 'Test',
  });
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: true, noop: false});
  expect(res.data.transfer_id).toBeTruthy();

  const {data: row} = await supabaseAdmin.from('cattle').select('herd').eq('id', ids.cowId).single();
  expect(row.herd).toBe('finishers');

  const {data: audit} = await supabaseAdmin
    .from('cattle_transfers')
    .select('from_herd,to_herd,reason')
    .eq('cattle_id', ids.cowId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({from_herd: 'mommas', to_herd: 'finishers', reason: 'manual'});

  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('event_type,entity_type,payload')
    .eq('entity_id', ids.cowId);
  expect(events).toHaveLength(1);
  expect(events[0].event_type).toBe('status.changed');
  expect(events[0].entity_type).toBe('cattle.animal');
  expect(events[0].payload).toMatchObject({field: 'herd', from: 'mommas', to: 'finishers'});
});

// --------------------------------------------------------------------------
// Test 2 — Cattle no-op writes nothing
// --------------------------------------------------------------------------
test('cattle transfer no-op: same herd returns noop and writes no audit', async ({
  supabaseAdmin,
  animalTransferScenario,
}) => {
  const ids = animalTransferScenario;
  const adminSb = await newAdminAuthedClient();

  const res = await adminSb.rpc('transfer_cattle_animal', {p_entity_id: ids.cowId, p_to_herd: 'mommas'});
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: true, noop: true});

  const {data: audit} = await supabaseAdmin.from('cattle_transfers').select('id').eq('cattle_id', ids.cowId);
  expect(audit).toHaveLength(0);
  const {data: events} = await supabaseAdmin.from('activity_events').select('id').eq('entity_id', ids.cowId);
  expect(events).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Test 3 — Move to deceased sets death_date
// --------------------------------------------------------------------------
test('cattle transfer to deceased sets death_date when missing', async ({supabaseAdmin, animalTransferScenario}) => {
  const ids = animalTransferScenario;
  const adminSb = await newAdminAuthedClient();

  const res = await adminSb.rpc('transfer_cattle_animal', {p_entity_id: ids.cowId, p_to_herd: 'deceased'});
  expect(res.error).toBeNull();
  const {data: row} = await supabaseAdmin.from('cattle').select('herd,death_date').eq('id', ids.cowId).single();
  expect(row.herd).toBe('deceased');
  expect(row.death_date).not.toBeNull();
});

// --------------------------------------------------------------------------
// Test 4 — Sheep move updates row + audit + status.changed Activity
// --------------------------------------------------------------------------
test('sheep transfer: updates flock, writes audit, logs status.changed', async ({
  supabaseAdmin,
  animalTransferScenario,
}) => {
  const ids = animalTransferScenario;
  const adminSb = await newAdminAuthedClient();

  const res = await adminSb.rpc('transfer_sheep_animal', {
    p_entity_id: ids.eweId,
    p_to_flock: 'feeders',
    p_team_member: 'Test',
  });
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: true, noop: false});

  const {data: row} = await supabaseAdmin.from('sheep').select('flock').eq('id', ids.eweId).single();
  expect(row.flock).toBe('feeders');

  const {data: audit} = await supabaseAdmin
    .from('sheep_transfers')
    .select('from_flock,to_flock,reason')
    .eq('sheep_id', ids.eweId);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({from_flock: 'ewes', to_flock: 'feeders', reason: 'manual'});

  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('event_type,entity_type,payload')
    .eq('entity_id', ids.eweId);
  expect(events).toHaveLength(1);
  expect(events[0].event_type).toBe('status.changed');
  expect(events[0].entity_type).toBe('sheep.animal');
  expect(events[0].payload).toMatchObject({field: 'flock', from: 'ewes', to: 'feeders'});
});

// --------------------------------------------------------------------------
// Test 5 — Anon/unauth caller rejected
// --------------------------------------------------------------------------
test('transfer RPCs reject anon/unauth callers', async ({animalTransferScenario}) => {
  const ids = animalTransferScenario;
  const anon = newAnonClient();
  const c = await anon.rpc('transfer_cattle_animal', {p_entity_id: ids.cowId, p_to_herd: 'finishers'});
  expect(c.error).not.toBeNull();
  const s = await anon.rpc('transfer_sheep_animal', {p_entity_id: ids.eweId, p_to_flock: 'feeders'});
  expect(s.error).not.toBeNull();
});

// --------------------------------------------------------------------------
// Test 6 — Deleted source row rejected
// --------------------------------------------------------------------------
test('transfer rejects a soft-deleted source row', async ({supabaseAdmin, animalTransferScenario}) => {
  const ids = animalTransferScenario;
  await supabaseAdmin.from('sheep').update({deleted_at: new Date().toISOString()}).eq('id', ids.eweId);
  const adminSb = await newAdminAuthedClient();
  const res = await adminSb.rpc('transfer_sheep_animal', {p_entity_id: ids.eweId, p_to_flock: 'feeders'});
  expect(res.error).not.toBeNull();
  expect(res.error.message).toMatch(/not found or deleted/);
});

// --------------------------------------------------------------------------
// Test 7 — status.changed transfer events surface in global Activity
// --------------------------------------------------------------------------
test('Activity: transfer status.changed events visible in global Activity', async ({page, animalTransferScenario}) => {
  const ids = animalTransferScenario;
  const adminSb = await newAdminAuthedClient();
  await adminSb.rpc('transfer_cattle_animal', {p_entity_id: ids.cowId, p_to_herd: 'finishers', p_team_member: 'T'});
  await adminSb.rpc('transfer_sheep_animal', {p_entity_id: ids.eweId, p_to_flock: 'feeders', p_team_member: 'T'});

  // Global Activity log fails closed on a transient cold-load read error right
  // after the mid-test DB reset; mirror the real Retry UX with a bounded reload.
  await page.goto('/activity');
  const firstRow = page.locator('[data-activity-log-row]').first();
  for (let i = 0; i < 6; i++) {
    if (await firstRow.isVisible().catch(() => false)) break;
    await page.waitForTimeout(1000);
    await page.reload();
  }
  await expect(firstRow).toBeVisible({timeout: 15_000});

  await expect(page.getByText(/Moved XF-100 from mommas to finishers/)).toBeVisible({timeout: 10_000});
  await expect(page.getByText(/Moved XF-200 from ewes to feeders/)).toBeVisible({timeout: 10_000});
});
