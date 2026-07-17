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

// ── Canonical housing ↔ layer-daily matching ───────────────────────────────
// One shared rule for every surface that assigns a layer_dailys row to a
// housing (Animals on Farm history, Home snapshot, layer dashboards, feed
// planning):
//   1. An exact normalized batch_label ↔ housing_name match wins.
//   2. A label that names a DIFFERENT housing never matches this one, even
//      when both housings share a batch_id (Eggmobile 2 and Layer Schooner
//      both live under l-26-01; a Layer Schooner row is not Eggmobile 2's).
//   3. A row with no housing-specific label (blank, or a batch-level label
//      such as the batch name) may fall back to batch_id ONLY when the batch
//      has exactly one known housing. An ambiguous multi-housing batch fails
//      closed instead of guessing.
// Pass the full housing roster so sibling ambiguity is visible. Without a
// roster the housing itself is the only known housing, which preserves the
// legacy single-housing batch fallback.

function normHousingName(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function sameHousing(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.id != null && b.id != null && String(a.id) === String(b.id);
}

export function createLayerDailyHousingMatcher(allHousings) {
  const roster = (Array.isArray(allHousings) ? allHousings : []).filter(Boolean);
  const nameOwners = new Map(); // normalized housing_name -> housings claiming it
  const batchHousings = new Map(); // String(batch_id) -> non-deleted housings
  for (const h of roster) {
    const name = normHousingName(h.housing_name);
    if (name) {
      if (!nameOwners.has(name)) nameOwners.set(name, []);
      nameOwners.get(name).push(h);
    }
    if (h.batch_id != null && !h.deleted_at) {
      const key = String(h.batch_id);
      if (!batchHousings.has(key)) batchHousings.set(key, []);
      batchHousings.get(key).push(h);
    }
  }
  return function matchesHousing(daily, housing) {
    if (!daily || !housing) return false;
    const label = normHousingName(daily.batch_label);
    const housingName = normHousingName(housing.housing_name);
    if (label && housingName && label === housingName) return true;
    // Housing-specific label owned by another housing: never reassign it.
    if (label && (nameOwners.get(label) || []).some((h) => !sameHousing(h, housing))) return false;
    // Batch-id fallback only when this housing is the batch's only housing.
    if (housing.batch_id == null || daily.batch_id == null) return false;
    if (String(daily.batch_id) !== String(housing.batch_id)) return false;
    const siblings = batchHousings.get(String(housing.batch_id)) || [];
    return !siblings.some((h) => !sameHousing(h, housing));
  };
}

export function layerDailyMatchesHousing(daily, housing, allHousings) {
  const roster = Array.isArray(allHousings) && allHousings.length > 0 ? allHousings : [housing];
  return createLayerDailyHousingMatcher(roster)(daily, housing);
}

// Resolve the display hen count for a housing — positive current_count when
// present, otherwise the latest positive matching layer_dailys.layer_count.
// NO mortality subtraction. Use this for dashboard totals, chips, and any
// surface labeled "hens" or "current count". Pass allHousings so a sibling
// housing's daily rows cannot be claimed through the shared batch_id.
export function computeHousingDisplayCount(housing, layerDailys, allHousings) {
  if (!housing) return 0;
  const parsed = housing.current_count != null ? parseInt(housing.current_count) : NaN;
  if (parsed > 0) return parsed;

  const matchesHousing = createLayerDailyHousingMatcher(
    Array.isArray(allHousings) && allHousings.length > 0 ? allHousings : [housing],
  );
  const matches = (layerDailys || [])
    .filter((d) => d && d.layer_count != null && parseInt(d.layer_count) > 0 && matchesHousing(d, housing))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (matches.length === 0) return parsed >= 0 ? parsed : 0;
  const count = parseInt(matches[0].layer_count);
  return isNaN(count) ? 0 : count;
}

// Compute projected count for a housing.
// projected = anchor - sum(mortalities reported between anchorDate and today)
// Use this only where mortality-adjusted counts are explicitly intended.
// Pass allHousings so the daily-anchor fallback uses the shared matching rule.
// Returns {anchor, anchorDate, projected, mortSince} or null if no anchor.
export function computeProjectedCount(housing, layerDailys, allHousings) {
  if (!housing) return null;
  const parsed = housing.current_count != null ? parseInt(housing.current_count) : NaN;
  let anchor = isNaN(parsed) ? null : parsed;
  let anchorDate = housing.current_count_date || housing.start_date || null;

  const matchesHousing = createLayerDailyHousingMatcher(
    Array.isArray(allHousings) && allHousings.length > 0 ? allHousings : [housing],
  );

  function latestDailyAnchor() {
    const matches = (layerDailys || [])
      .filter((d) => d && d.layer_count != null && parseInt(d.layer_count) > 0 && matchesHousing(d, housing))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (matches.length === 0) return null;
    const count = parseInt(matches[0].layer_count);
    if (isNaN(count)) return null;
    return {count, date: matches[0].date || null};
  }

  if (!(anchor > 0)) {
    const daily = latestDailyAnchor();
    if (daily) {
      if (
        anchor === 0 &&
        housing.status !== 'active' &&
        housing.current_count_date &&
        housing.current_count_date > daily.date
      ) {
        // Intentional zero on a retired/inactive housing with a date newer than the daily
      } else {
        anchor = daily.count;
        anchorDate = daily.date;
      }
    } else if (anchor == null) {
      return null;
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
