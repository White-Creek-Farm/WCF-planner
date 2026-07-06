// Fuel-bill DELETE RPC client wrapper for the ADMIN Bills tab (FuelBillsView).
//
// Calls the transactional SECDEF RPC introduced in migration
// 107_delete_fuel_bill_rpc.sql and re-scoped in migration
// 154_fuel_bill_activity_entity.sql, which replaces the last direct client
// hard-delete of a fuel-bill root. The RPC, in one transaction:
//   * deletes the fuel_bills root (WHERE id = p_bill_id),
//   * cascades the child fuel_bill_lines rows away via the bill_id
//     ON DELETE CASCADE FK,
//   * writes ONE record.deleted Activity event (scoped to the dedicated
//     equipment.fuel_bill entity as of mig 154 — was equipment.item in mig 107;
//     entity_id = the bill id) carrying the invoice/supplier/delivery + the
//     count of lines deleted. The equipment.fuel_bill read gate is admin-only
//     and existence-free, so the tombstone stays visible after the row is gone.
//
// p_bill_id is the fuel bill's TEXT id (e.g. 'fb-1718000000000-ab12cd'),
// matching the fuel_bills.id column — NOT a uuid (see the migration header for
// the full rationale).
//
// The storage PDF removal is intentionally NOT done here — the caller runs it as
// a best-effort step AFTER this RPC succeeds, so a failed delete never
// orphan-removes the PDF.
//
// Returns the RPC's jsonb result unchanged on success and on business-rule
// blocks (e.g. {ok:false, reason:'no_bill'}), so callers branch on r.ok /
// r.reason. On a transport/permission error it returns
// {ok:false, reason:'rpc_error', error} rather than throwing, matching the
// layer-batch + processing-batch delete wrappers.

export async function deleteFuelBill(sb, billId) {
  const {data, error} = await sb.rpc('delete_fuel_bill', {p_bill_id: billId});
  if (error) return {ok: false, reason: 'rpc_error', error: error.message || String(error)};
  return data || {ok: false, reason: 'no_result'};
}
