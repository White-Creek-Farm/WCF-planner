// Carcass-yield summary — ONE pure helper for every Processing Source
// details yield block (cattle batches, sheep batches, actual pig trips).
// Mirrors the source planners' established math exactly for VALID values:
//   - cattle/sheep batch pages: totals are sums of positive detail
//     weights; yield = Math.round((hang / live) * 1000) / 10, shown only
//     when both totals are > 0;
//   - pig planner tripYield (src/lib/pig.js): the identical formula over
//     the trip's summed live weights + its single hangingWeight.
// Weights are summed FIRST and divided once — never an average of
// per-animal percentages.
//
// STRICT validation (review fix 2026-07-18): no permissive parseFloat
// semantics. A value counts ONLY when it is a finite number > 0, or a
// string that is entirely a plain decimal number ("120", "120.5") parsing
// to a finite value > 0. "120junk", "1,200", whitespace-only, NaN,
// Infinity, zero, and negatives contribute nothing. Any missing side
// yields null fields (callers render "Not recorded") — never 0%, NaN, or
// Infinity.
function toValidWeight(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export function summarizeCarcassYield({liveValues = [], hangingValues = [], hangingTotal = null} = {}) {
  const sumValid = (vals) =>
    (Array.isArray(vals) ? vals : []).reduce((s, v) => {
      const n = toValidWeight(v);
      return n != null ? s + n : s;
    }, 0);
  const live = sumValid(liveValues);
  const hangDirect = toValidWeight(hangingTotal);
  const hang = hangDirect != null ? hangDirect : sumValid(hangingValues);
  return {
    totalLive: live > 0 ? live : null,
    totalHang: hang > 0 ? hang : null,
    yieldPct: live > 0 && hang > 0 ? Math.round((hang / live) * 1000) / 10 : null,
  };
}
