// Global Activity Log API — reads farm-wide activity through the
// list_global_activity SECDEF RPC. Does not query activity_events
// or activity_mentions directly.

export async function loadGlobalActivity(sb, {limit = 50, before, entityType, eventType, search} = {}) {
  if (!sb) return [];
  const params = {p_limit: limit};
  if (before) params.p_before = before;
  if (entityType) params.p_entity_type = entityType;
  if (eventType) params.p_event_type = eventType;
  if (search) params.p_search = search;
  const {data, error} = await sb.rpc('list_global_activity', params);
  if (error) throw new Error(`loadGlobalActivity: ${error.message}`);
  return data || [];
}
