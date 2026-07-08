import {describe, expect, it} from 'vitest';

import {feedDryMatterLbs, feedNutritionContribution} from './cattleNutrition.js';

describe('cattle nutrition dry-matter math', () => {
  it('converts as-fed pounds to dry matter using moisture percentage', () => {
    expect(feedDryMatterLbs(1000, {moisture_pct: 50})).toBeCloseTo(500);
    expect(feedDryMatterLbs(1000, {moisture_pct: 12.5})).toBeCloseTo(875);
  });

  it('calculates CP and NFC from dry matter pounds, not as-fed pounds', () => {
    const out = feedNutritionContribution({
      lbs_as_fed: 1000,
      nutrition_snapshot: {
        moisture_pct: 50,
        protein_pct: 20,
        nfc_pct: 30,
      },
    });

    expect(out.asFedLbs).toBeCloseTo(1000);
    expect(out.dryMatterLbs).toBeCloseTo(500);
    expect(out.crudeProteinLbs).toBeCloseTo(100);
    expect(out.nfcLbs).toBeCloseTo(150);
  });

  it('falls back to zero moisture when old feed snapshots do not have moisture', () => {
    const out = feedNutritionContribution({
      lbs_as_fed: 750,
      nutrition_snapshot: {
        protein_pct: 10,
        nfc_pct: 40,
      },
    });

    expect(out.dryMatterLbs).toBeCloseTo(750);
    expect(out.crudeProteinLbs).toBeCloseTo(75);
    expect(out.nfcLbs).toBeCloseTo(300);
  });

  it('clamps invalid moisture percentages so one bad snapshot cannot invert the math', () => {
    expect(feedDryMatterLbs(1000, {moisture_pct: 150})).toBeCloseTo(0);
    expect(feedDryMatterLbs(1000, {moisture_pct: -20})).toBeCloseTo(1000);
  });
});
