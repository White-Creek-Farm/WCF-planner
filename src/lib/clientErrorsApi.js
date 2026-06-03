// Admin read API for client_error_events (Runtime Observability Phase 2).
// Reads through the admin-only list_client_errors SECDEF RPC — never queries
// the client_error_events table directly (that path is boundary-locked).

export async function loadClientErrors(sb, {limit = 100, before} = {}) {
  if (!sb) throw new Error('loadClientErrors: sb required');
  const params = {p_limit: limit};
  if (before) params.p_before = before;
  const {data, error} = await sb.rpc('list_client_errors', params);
  if (error) throw new Error(`loadClientErrors: ${error.message || String(error)}`);
  return data || [];
}
