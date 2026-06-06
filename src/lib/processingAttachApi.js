// Processing-attach RPC client wrappers for the authenticated app.
//
// These call the transactional SECDEF RPCs added in migration
// 096_processing_attach_activity_rpcs.sql. The public WeighInsWebform anon
// path can still use the legacy client helpers through the shared modals; the
// authenticated weigh-in session record page opts into these RPCs.

function requireOk(data, label) {
  if (!data) throw new Error(label + ': no result');
  if (data.ok !== true) {
    const reason = data.reason || data.error || 'not_ok';
    throw new Error(label + ': ' + reason);
  }
  return data;
}

export async function attachCattleToProcessingBatch(
  sb,
  {sessionId, entryIds, targetBatchId = null, batchName = null, processingDate = null, teamMember = null} = {},
) {
  const {data, error} = await sb.rpc('attach_cattle_to_processing_batch', {
    p_session_id: sessionId,
    p_entry_ids: entryIds || [],
    p_target_batch_id: targetBatchId || null,
    p_batch_name: batchName || null,
    p_processing_date: processingDate || null,
    p_team_member: teamMember || null,
  });
  if (error) throw new Error('attachCattleToProcessingBatch: ' + (error.message || String(error)));
  return requireOk(data, 'attachCattleToProcessingBatch');
}

export async function attachSheepToProcessingBatch(
  sb,
  {sessionId, entryIds, targetBatchId = null, batchName = null, plannedDate = null, teamMember = null} = {},
) {
  const {data, error} = await sb.rpc('attach_sheep_to_processing_batch', {
    p_session_id: sessionId,
    p_entry_ids: entryIds || [],
    p_target_batch_id: targetBatchId || null,
    p_batch_name: batchName || null,
    p_planned_date: plannedDate || null,
    p_team_member: teamMember || null,
  });
  if (error) throw new Error('attachSheepToProcessingBatch: ' + (error.message || String(error)));
  return requireOk(data, 'attachSheepToProcessingBatch');
}
