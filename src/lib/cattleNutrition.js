function numberOrZero(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function clampPercent(value) {
  const n = numberOrZero(value);
  return Math.max(0, Math.min(100, n));
}

export function feedDryMatterLbs(lbsAsFed, nutritionSnapshot = {}) {
  const lbs = numberOrZero(lbsAsFed);
  const moisturePct = clampPercent(nutritionSnapshot?.moisture_pct);
  return lbs * ((100 - moisturePct) / 100);
}

export function feedNutritionContribution(feed = {}) {
  const nutritionSnapshot = feed.nutrition_snapshot || {};
  const asFedLbs = numberOrZero(feed.lbs_as_fed);
  const dryMatterLbs = feedDryMatterLbs(asFedLbs, nutritionSnapshot);
  return {
    asFedLbs,
    dryMatterLbs,
    crudeProteinLbs: dryMatterLbs * (numberOrZero(nutritionSnapshot.protein_pct) / 100),
    nfcLbs: dryMatterLbs * (numberOrZero(nutritionSnapshot.nfc_pct) / 100),
  };
}
