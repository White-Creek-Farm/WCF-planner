// Processing-detach RPC client wrappers for authenticated workflows.
//
// These call the transactional SECDEF RPCs added in migration
// 081_processing_detach_activity_rpcs.sql, which atomically remove an animal
// from a processing batch, revert its herd/flock, write the undo transfer
// audit row, clear the matching weigh-ins, AND log the field.updated Activity
// event in one transaction. They replace the best-effort client detach +
// separate logEvent on every processing-batch and cattle/sheep weigh-in detach
// path, including the login-gated /weighins form. Migration 170 preserves
// admin/management access and admits farm_team only for its allowed program.
// Light, equipment_tech, inactive, anon, and unauthenticated callers remain
// denied by the server.
//
// Both wrappers return the RPC's jsonb result unchanged on success and on
// business-rule blocks (e.g. {ok:false, reason:'no_prior_herd'}), so callers
// can branch on r.ok / r.reason without knowing transport details.
// On a transport/permission error they return {ok:false, reason:'rpc_error',
// error} rather than throwing, so the page detach handlers (which do not wrap
// the call in try/catch) keep their existing control flow.
//
// teamMember remains a compatibility argument for the stable migration-081
// signature. Migration 170 ignores that client-owned value and stamps transfer
// and Activity attribution from the authenticated caller's profile.

export async function detachCattleFromProcessingBatch(sb, {cattleId, batchId, teamMember = null} = {}) {
  const {data, error} = await sb.rpc('detach_cattle_from_processing_batch', {
    p_cattle_id: cattleId,
    p_batch_id: batchId,
    p_team_member: teamMember,
  });
  if (error) return {ok: false, reason: 'rpc_error', error: error.message || String(error)};
  return data || {ok: false, reason: 'no_result'};
}

export async function detachSheepFromProcessingBatch(sb, {sheepId, batchId, teamMember = null} = {}) {
  const {data, error} = await sb.rpc('detach_sheep_from_processing_batch', {
    p_sheep_id: sheepId,
    p_batch_id: batchId,
    p_team_member: teamMember,
  });
  if (error) return {ok: false, reason: 'rpc_error', error: error.message || String(error)};
  return data || {ok: false, reason: 'no_result'};
}
