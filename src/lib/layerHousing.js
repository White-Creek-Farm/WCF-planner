// ============================================================================
// Layer housing helpers — Phase 2.1 (extracted ahead of Round 1 modals)
// ============================================================================
// setHousingAnchorFromReport : after a layer daily with a hen count lands,
//                              update the housing anchor (current_count +
//                              current_count_date) that projected-count math
//                              is derived from. Used by WebformHub,
//                              AdminAddReportModal, LayerDailysView.
// computeProjectedCount      : projected = anchor - mortalities since anchor.
//                              Used everywhere the layer dashboards render
//                              live hen counts.
// computeLayerFeedCost       : snapshot-based cost helper — takes the batch's
//                              frozen per-lb rates, returns total $.
//
// Verbatim extraction from main.jsx lines 592–675. Behavior unchanged; only
// the file they live in moves.
// ============================================================================

export async function setHousingAnchorFromReport(sb, housingOrBatchName, newCount, reportDate) {
  if (!housingOrBatchName || newCount == null || isNaN(parseInt(newCount))) return {ok: false, reason: 'no-input'};
  const trimmed = String(housingOrBatchName).toLowerCase().trim();
  if (!trimmed) return {ok: false, reason: 'empty-name'};
  const newC = Math.max(0, parseInt(newCount));
  // Step 1 — try direct housing_name match
  const {data: housings, error: selErr} = await sb
    .from('layer_housings')
    .select('id,current_count,current_count_date,status,housing_name,batch_id')
    .eq('status', 'active');
  if (selErr || !housings) return {ok: false, reason: 'db-error'};
  let target = housings.find(
    (h) =>
      String(h.housing_name || '')
        .toLowerCase()
        .trim() === trimmed,
  );
  // Step 2 — fall back to batch-name match if no housing matched directly
  // (e.g. report's batch_label is "L-26-01" not "Eggmobile 2")
  if (!target) {
    const {data: batches} = await sb.from('layer_batches').select('id,name');
    const matchingBatch = (batches || []).find(
      (b) =>
        String(b.name || '')
          .toLowerCase()
          .trim() === trimmed,
    );
    if (matchingBatch) {
      const batchHousings = housings.filter((h) => h.batch_id === matchingBatch.id);
      if (batchHousings.length === 1) {
        target = batchHousings[0];
      } else if (batchHousings.length > 1) {
        return {
          ok: false,
          reason: 'ambiguous-batch',
          batchName: matchingBatch.name,
          housingNames: batchHousings.map((h) => h.housing_name),
        };
      }
    }
  }
  if (!target) return {ok: false, reason: 'no-match', name: housingOrBatchName};
  const {error: updErr} = await sb
    .from('layer_housings')
    .update({current_count: newC, current_count_date: reportDate || null})
    .eq('id', target.id);
  if (updErr) return {ok: false, reason: 'update-failed', error: updErr.message};
  return {ok: true, id: target.id, housingName: target.housing_name, newCount: newC, newDate: reportDate};
}

// Compute projected count for a housing.
// projected = anchor - sum(mortalities reported between anchorDate and today)
// Anchor is current_count when positive; falls back to the latest matching
// layer_dailys.layer_count when current_count is null, or when current_count
// is 0 without a credible date (or with a date older than the latest daily).
// Returns {anchor, anchorDate, projected, mortSince} or null if no anchor.
export function computeProjectedCount(housing, layerDailys) {
  if (!housing) return null;
  let anchor = housing.current_count;
  let anchorDate = housing.current_count_date || housing.start_date || null;

  const hName = String(housing.housing_name || '')
    .toLowerCase()
    .trim();

  function latestDailyAnchor() {
    if (!hName) return null;
    const matches = (layerDailys || [])
      .filter(
        (d) =>
          d &&
          d.batch_label &&
          d.layer_count != null &&
          parseInt(d.layer_count) > 0 &&
          String(d.batch_label).toLowerCase().trim() === hName,
      )
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (matches.length === 0) return null;
    const count = parseInt(matches[0].layer_count);
    if (isNaN(count)) return null;
    return {count, date: matches[0].date || null};
  }

  if (anchor == null || (anchor === 0 && !housing.current_count_date)) {
    const daily = latestDailyAnchor();
    if (!daily) {
      if (anchor == null) return null;
    } else {
      anchor = daily.count;
      anchorDate = daily.date;
    }
  } else if (anchor === 0 && housing.current_count_date) {
    const daily = latestDailyAnchor();
    if (daily && daily.date && daily.date > housing.current_count_date) {
      anchor = daily.count;
      anchorDate = daily.date;
    }
  }

  if (!anchorDate) {
    return {anchor, anchorDate: null, projected: anchor, mortSince: 0};
  }
  const todayStr = new Date().toISOString().split('T')[0];
  const mortSince = (layerDailys || [])
    .filter((d) => {
      if (!d || !d.date || !d.batch_label) return false;
      if (String(d.batch_label).toLowerCase().trim() !== String(housing.housing_name).toLowerCase().trim())
        return false;
      if (d.date <= anchorDate) return false;
      if (d.date > todayStr) return false;
      return true;
    })
    .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
  const projected = Math.max(0, anchor - mortSince);
  return {anchor, anchorDate, projected, mortSince};
}

// ── Layer feed cost helper ─────────────────────────────────────────────────
// Computes total feed cost for a layer batch using the batch's frozen rates.
// Returns null if no rates are set.
export function computeLayerFeedCost(starterLbs, growerLbs, layerLbs, batch) {
  if (!batch) return null;
  const sR = parseFloat(batch.per_lb_starter_cost);
  const gR = parseFloat(batch.per_lb_grower_cost);
  const lR = parseFloat(batch.per_lb_layer_cost);
  if ((!sR || sR === 0) && (!gR || gR === 0) && (!lR || lR === 0)) return null;
  const cost =
    (parseFloat(starterLbs) || 0) * (sR || 0) +
    (parseFloat(growerLbs) || 0) * (gR || 0) +
    (parseFloat(layerLbs) || 0) * (lR || 0);
  return cost;
}
