import {test, expect} from './fixtures.js';
import {createClient} from '@supabase/supabase-js';

// ============================================================================
// detach_cattle_from_processing_batch / detach_sheep_from_processing_batch
// — audit-grade transactional processing-detach RPCs (migration 081).
// ============================================================================
// These move the authenticated CattleBatchPage / SheepBatchPage detach from a
// best-effort client helper + separate logEvent to a SECDEF RPC that reverts
// the animal, writes the undo transfer audit row, clears the weigh-ins, AND
// logs the field.updated Activity event in ONE transaction.
//
// Coverage (each test resets + re-seeds the shared TEST DB; run this file
// ALONE — bundling specs spawns concurrent resetDb that pollutes TEST):
//   cattle: admin detach success + Activity row written
//   cattle: anon caller rejected (REVOKE from anon), animal untouched
//   cattle: no prior herd -> blocks with no_prior_herd, animal untouched
//   sheep:  admin detach success + Activity row written
//   sheep:  anon caller rejected, animal untouched
//   sheep:  no prior flock -> blocks with no_prior_flock, animal untouched
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
  if (error) throw new Error(`admin signIn failed: ${error.message}`);
  return sb;
}

// ── Cattle ──────────────────────────────────────────────────────────────────

test('cattle: admin detach reverts the cow, audits, clears weigh-ins, logs Activity', async ({
  cattleMultiCowPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, batchName, cows} = cattleMultiCowPreAttachedScenario;
  const cow = cows[0]; // id cow-test-2001, tag 2001
  const entryId = `wi-test-cattle-${cow.tag}`;
  await supabaseAdmin.from('activity_events').delete().eq('entity_id', batchId);

  const adminSb = await newAdminAuthedClient();
  const res = await adminSb.rpc('detach_cattle_from_processing_batch', {
    p_cattle_id: cow.id,
    p_batch_id: batchId,
    p_team_member: 'Test',
  });
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: true, reason: 'detached', prior_herd: 'finishers', batch_id: batchId});
  expect(res.data.event_id).toBeTruthy();
  expect(res.data.transfer_id).toBeTruthy();

  // Cow reverted off 'processed'.
  const {data: cowRow} = await supabaseAdmin
    .from('cattle')
    .select('herd,processing_batch_id')
    .eq('id', cow.id)
    .maybeSingle();
  expect(cowRow.herd).toBe('finishers');
  expect(cowRow.processing_batch_id).toBeNull();

  // Removed from cows_detail; the other two cows remain.
  const {data: batchRow} = await supabaseAdmin
    .from('cattle_processing_batches')
    .select('cows_detail')
    .eq('id', batchId)
    .maybeSingle();
  const ids = (batchRow.cows_detail || []).map((r) => r.cattle_id);
  expect(ids).not.toContain(cow.id);
  expect(ids).toHaveLength(2);

  // Weigh-in cleared: link dropped AND processor flag cleared.
  const {data: wi} = await supabaseAdmin
    .from('weigh_ins')
    .select('target_processing_batch_id,send_to_processor')
    .eq('id', entryId)
    .maybeSingle();
  expect(wi.target_processing_batch_id).toBeNull();
  expect(wi.send_to_processor).toBe(false);

  // Undo transfer audit row.
  const {data: undo} = await supabaseAdmin
    .from('cattle_transfers')
    .select('from_herd,to_herd,reason,reference_id')
    .eq('cattle_id', cow.id)
    .eq('reason', 'processing_batch_undo');
  expect(undo).toHaveLength(1);
  expect(undo[0]).toMatchObject({from_herd: 'processed', to_herd: 'finishers', reference_id: batchId});

  // Exactly one field.updated Activity event on the batch entity.
  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('entity_type,event_type,body,payload')
    .eq('entity_id', batchId);
  expect(events).toHaveLength(1);
  expect(events[0].entity_type).toBe('cattle.processing');
  expect(events[0].event_type).toBe('field.updated');
  expect(events[0].body).toBe(`Detached #${cow.tag} from batch`);
  expect(events[0].payload.entity_label).toBe(batchName);
  expect(events[0].payload.tag).toBe(cow.tag);
});

test('cattle: anon caller is rejected and the cow is untouched', async ({
  cattleMultiCowPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cows} = cattleMultiCowPreAttachedScenario;
  const cow = cows[0];
  const anon = newAnonClient();
  const res = await anon.rpc('detach_cattle_from_processing_batch', {p_cattle_id: cow.id, p_batch_id: batchId});
  expect(res.error).not.toBeNull();

  const {data: cowRow} = await supabaseAdmin
    .from('cattle')
    .select('herd,processing_batch_id')
    .eq('id', cow.id)
    .maybeSingle();
  expect(cowRow.herd).toBe('processed');
  expect(cowRow.processing_batch_id).toBe(batchId);
});

test('cattle: no prior herd blocks with no_prior_herd and does not revert', async ({
  cattlePreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, cowId} = await cattlePreAttachedScenario('no_audit_row');
  const adminSb = await newAdminAuthedClient();
  const res = await adminSb.rpc('detach_cattle_from_processing_batch', {p_cattle_id: cowId, p_batch_id: batchId});
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: false, reason: 'no_prior_herd'});

  const {data: cowRow} = await supabaseAdmin
    .from('cattle')
    .select('herd,processing_batch_id')
    .eq('id', cowId)
    .maybeSingle();
  expect(cowRow.herd).toBe('processed');
  expect(cowRow.processing_batch_id).toBe(batchId);
});

// ── Sheep ─────────────────────────────────────────────────────────────────

test('sheep: admin detach reverts the sheep, audits, clears weigh-ins, logs Activity', async ({
  sheepBatchPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, batchName, sheep} = sheepBatchPreAttachedScenario;
  const animal = sheep[0]; // id sheep-test-3001, tag 3001
  const entryId = `wi-test-sheep-${animal.tag}`;
  await supabaseAdmin.from('activity_events').delete().eq('entity_id', batchId);

  const adminSb = await newAdminAuthedClient();
  const res = await adminSb.rpc('detach_sheep_from_processing_batch', {
    p_sheep_id: animal.id,
    p_batch_id: batchId,
    p_team_member: 'Test',
  });
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: true, reason: 'detached', prior_flock: 'feeders', batch_id: batchId});
  expect(res.data.event_id).toBeTruthy();
  expect(res.data.transfer_id).toBeTruthy();

  const {data: sheepRow} = await supabaseAdmin
    .from('sheep')
    .select('flock,processing_batch_id')
    .eq('id', animal.id)
    .maybeSingle();
  expect(sheepRow.flock).toBe('feeders');
  expect(sheepRow.processing_batch_id).toBeNull();

  const {data: batchRow} = await supabaseAdmin
    .from('sheep_processing_batches')
    .select('sheep_detail')
    .eq('id', batchId)
    .maybeSingle();
  const ids = (batchRow.sheep_detail || []).map((r) => r.sheep_id);
  expect(ids).not.toContain(animal.id);
  expect(ids).toHaveLength(2);

  const {data: wi} = await supabaseAdmin
    .from('weigh_ins')
    .select('target_processing_batch_id,send_to_processor')
    .eq('id', entryId)
    .maybeSingle();
  expect(wi.target_processing_batch_id).toBeNull();
  expect(wi.send_to_processor).toBe(false);

  const {data: undo} = await supabaseAdmin
    .from('sheep_transfers')
    .select('from_flock,to_flock,reason,reference_id')
    .eq('sheep_id', animal.id)
    .eq('reason', 'processing_batch_undo');
  expect(undo).toHaveLength(1);
  expect(undo[0]).toMatchObject({from_flock: 'processed', to_flock: 'feeders', reference_id: batchId});

  const {data: events} = await supabaseAdmin
    .from('activity_events')
    .select('entity_type,event_type,body,payload')
    .eq('entity_id', batchId);
  expect(events).toHaveLength(1);
  expect(events[0].entity_type).toBe('sheep.processing');
  expect(events[0].event_type).toBe('field.updated');
  expect(events[0].body).toBe(`Detached #${animal.tag} from batch`);
  expect(events[0].payload.entity_label).toBe(batchName);
  expect(events[0].payload.tag).toBe(animal.tag);
});

test('sheep: anon caller is rejected and the sheep is untouched', async ({
  sheepBatchPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheep} = sheepBatchPreAttachedScenario;
  const animal = sheep[0];
  const anon = newAnonClient();
  const res = await anon.rpc('detach_sheep_from_processing_batch', {p_sheep_id: animal.id, p_batch_id: batchId});
  expect(res.error).not.toBeNull();

  const {data: sheepRow} = await supabaseAdmin
    .from('sheep')
    .select('flock,processing_batch_id')
    .eq('id', animal.id)
    .maybeSingle();
  expect(sheepRow.flock).toBe('processed');
  expect(sheepRow.processing_batch_id).toBe(batchId);
});

test('sheep: no prior flock blocks with no_prior_flock and does not revert', async ({
  sheepPreAttachedScenario,
  supabaseAdmin,
}) => {
  const {batchId, sheepId} = await sheepPreAttachedScenario('no_audit_row');
  const adminSb = await newAdminAuthedClient();
  const res = await adminSb.rpc('detach_sheep_from_processing_batch', {p_sheep_id: sheepId, p_batch_id: batchId});
  expect(res.error).toBeNull();
  expect(res.data).toMatchObject({ok: false, reason: 'no_prior_flock'});

  const {data: sheepRow} = await supabaseAdmin
    .from('sheep')
    .select('flock,processing_batch_id')
    .eq('id', sheepId)
    .maybeSingle();
  expect(sheepRow.flock).toBe('processed');
  expect(sheepRow.processing_batch_id).toBe(batchId);
});
