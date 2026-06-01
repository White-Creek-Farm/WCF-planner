// Shared order-recommendation basis math for the feed-order boards (broiler +
// pig). This is the single source of truth for the "Order for [active]" tile.
//
// A current-month physical count is ground truth for "on hand now" and
// supersedes the previous-month ending ESTIMATE as the subtraction basis: the
// estimate (endOfPrevEst) is computed before the current-month count corrects
// the month, so subtracting it ignores the physical reality the operator just
// entered (the original bug — recommendations used the stale prev-month
// estimate even after a fresh count).
//
// actualOnHand is already count-aware: it folds in orders that arrived after
// the count, feed consumed since the count, and the "count includes current
// order" checkbox — so subtracting it never double-counts the current-month
// order. When there is no current-month count, the previous-month estimate
// remains the basis.

// The lbs value the recommendation subtracts from Need-Thru-next.
export function feedOrderBasis({hasCurrentCount, actualOnHand, endOfPrevEst}) {
  return hasCurrentCount && actualOnHand != null ? actualOnHand : endOfPrevEst;
}

// Recommended order = max(0, Need Thru next − basis). Returns null when no
// basis is available (no count and no previous-month ledger end).
export function recommendedFeedOrder({needThruNext, hasCurrentCount, actualOnHand, endOfPrevEst}) {
  const basis = feedOrderBasis({hasCurrentCount, actualOnHand, endOfPrevEst});
  if (basis == null) return null;
  return Math.max(0, needThruNext - basis);
}
