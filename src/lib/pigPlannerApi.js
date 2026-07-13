// ============================================================================
// src/lib/pigPlannerApi.js — transactional Pig planned/actual trip mutations
// ----------------------------------------------------------------------------
// Thin wrappers over the SECURITY DEFINER RPCs from
// supabase-migrations/176_processing_lifecycle_reconcile.sql. These replace the
// former client-side app_store JSON surgery for pig PLANNED-TRIP changes, the
// weigh-in Send-to-Trip fulfillment, undo-send, and actual-trip edit/delete:
// the database locks the ppp-feeders-v1 row + the touched weigh_ins in ONE
// transaction, performs the JSON surgery preserving unrelated fields, and
// re-syncs that group's Processing records — no client dual-writes.
//
// Role model (server-enforced): management/admin only, matching the previous
// client gating on these flows. Deterministic failures carry the
// 'PROCESSING_VALIDATION:' prefix (see processingApi.js error helpers).
//
// The planned-trip LOCK sidecar (ppp-pig-planned-trip-locks-v1) stays
// client-owned in usePigPlannedTrips: a lock is the "scheduled with the
// processor" soft signal, and the RPCs refuse date-edit/move/delete/chain-add
// on locked trips server-side as well.
//
// Every wrapper throws Error(`<fn>: <message>`) on rpc error. After any of
// these mutations the caller must RELOAD feeder groups from app_store (the
// server changed them); fcrCached remains a client-maintained display cache
// recomputed on the trip-edit/delete paths as before.
// ============================================================================

export async function pigAddPlannedTrip(sb, {groupId, subBatchId, sex, date, plannedCount} = {}) {
  const {data, error} = await sb.rpc('pig_add_planned_trip', {
    p_group_id: groupId,
    p_sub_batch_id: subBatchId,
    p_sex: sex,
    p_date: date,
    p_count: plannedCount ?? 0,
  });
  if (error) throw new Error(`pigAddPlannedTrip: ${error.message || String(error)}`);
  return data;
}

export async function pigSetPlannedTripDate(sb, {groupId, tripId, date} = {}) {
  const {data, error} = await sb.rpc('pig_set_planned_trip_date', {
    p_group_id: groupId,
    p_trip_id: tripId,
    p_date: date,
  });
  if (error) throw new Error(`pigSetPlannedTripDate: ${error.message || String(error)}`);
  return data;
}

export async function pigMovePlannedPigs(sb, {groupId, fromTripId, toTripId, count} = {}) {
  const {data, error} = await sb.rpc('pig_move_planned_pigs', {
    p_group_id: groupId,
    p_from_trip_id: fromTripId,
    p_to_trip_id: toTripId,
    p_count: count,
  });
  if (error) throw new Error(`pigMovePlannedPigs: ${error.message || String(error)}`);
  return data;
}

export async function pigDeletePlannedTrip(sb, {groupId, tripId} = {}) {
  const {data, error} = await sb.rpc('pig_delete_planned_trip', {
    p_group_id: groupId,
    p_trip_id: tripId,
  });
  if (error) throw new Error(`pigDeletePlannedTrip: ${error.message || String(error)}`);
  return data;
}

// Fulfillment: sends the given draft weigh-in entries to the processor. The
// server consumes the planned chain (reconcile semantics), PROMOTES the target
// planned trip id into processingTrips unchanged (the Processing record keeps
// its identity), stamps weigh_ins.sent_to_trip_id/sent_to_group_id, and moves
// any under-send remainder to the next planned trip or a NEW planned trip id.
// Returns {ok, trip_id, trip_date, sent, remainder, remainder_trip_id}.
export async function pigSendToTrip(sb, {groupId, subBatchId, sex, weighInIds} = {}) {
  const {data, error} = await sb.rpc('pig_send_to_trip', {
    p_group_id: groupId,
    p_sub_batch_id: subBatchId,
    p_sex: sex,
    p_weigh_in_ids: Array.isArray(weighInIds) ? weighInIds : [],
  });
  if (error) throw new Error(`pigSendToTrip: ${error.message || String(error)}`);
  return data;
}

// Undo one sent entry: clears its stamps, decrements the actual trip, and
// returns the pig to the planned chain. When the last entry is undone the
// actual trip reverts to a PLANNED trip with the SAME id (record identity and
// local work preserved; its Processing record flips back to Planned).
export async function pigUndoSend(sb, weighInId) {
  const {data, error} = await sb.rpc('pig_undo_send', {p_weigh_in_id: weighInId});
  if (error) throw new Error(`pigUndoSend: ${error.message || String(error)}`);
  return data;
}

// Edit an actual trip's planner-owned facts (date / hangingWeight / notes; for
// legacy trips with no linked weigh-ins also pigCount/liveWeights — linked
// trips recompute those from the weigh-ins server-side).
export async function pigUpdateProcessingTrip(
  sb,
  {groupId, tripId, date = null, hangingWeight = null, notes = null, pigCount = null, liveWeights = null} = {},
) {
  const {data, error} = await sb.rpc('pig_update_processing_trip', {
    p_group_id: groupId,
    p_trip_id: tripId,
    p_date: date ?? null,
    p_hanging_weight: hangingWeight ?? null,
    p_notes: notes ?? null,
    p_pig_count: pigCount ?? null,
    p_live_weights: liveWeights ?? null,
  });
  if (error) throw new Error(`pigUpdateProcessingTrip: ${error.message || String(error)}`);
  return data;
}

// Delete an actual trip. The server clears dangling weigh-in stamps in the
// same transaction; the trip's Processing record follows the worked-archive vs
// empty-remove rule.
export async function pigDeleteProcessingTrip(sb, {groupId, tripId} = {}) {
  const {data, error} = await sb.rpc('pig_delete_processing_trip', {
    p_group_id: groupId,
    p_trip_id: tripId,
  });
  if (error) throw new Error(`pigDeleteProcessingTrip: ${error.message || String(error)}`);
  return data;
}
