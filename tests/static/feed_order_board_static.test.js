import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const pigSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigFeedView.jsx'), 'utf8');
const broilerSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerFeedView.jsx'), 'utf8');

describe('Feed order board — uses feedPlanner helper, not duplicated math', () => {
  it('PigFeedView imports the snapshot helpers from feedPlanner.js', () => {
    expect(pigSrc).toMatch(/from '\.\.\/lib\/feedPlanner\.js'/);
    expect(pigSrc).toMatch(/\bpigDailyBurnLbs\b/);
    expect(pigSrc).toMatch(/\bonHandFromSnapshot\b/);
    expect(pigSrc).toMatch(/\bsuggestOrder\b/);
    expect(pigSrc).toMatch(/\bisSnapshotStale\b/);
  });

  it('BroilerFeedView imports the snapshot helpers from feedPlanner.js', () => {
    expect(broilerSrc).toMatch(/from '\.\.\/lib\/feedPlanner\.js'/);
    expect(broilerSrc).toMatch(/\bpoultryDailyBurnLbs\b/);
    expect(broilerSrc).toMatch(/\bonHandFromSnapshot\b/);
    expect(broilerSrc).toMatch(/\bsuggestOrder\b/);
    expect(broilerSrc).toMatch(/\bisSnapshotStale\b/);
  });

  it('PigFeedView renders the order board header above the legacy ledger', () => {
    expect(pigSrc).toMatch(/Feed order/);
    expect(pigSrc).toMatch(/showPigLegacyLedger/);
    expect(pigSrc).toMatch(/Show monthly ledger/);
    const boardIdx = pigSrc.indexOf('Feed order');
    const legacyIdx = pigSrc.indexOf('showPigLegacyLedger &&');
    expect(boardIdx).toBeGreaterThan(0);
    expect(legacyIdx).toBeGreaterThan(boardIdx);
  });

  it('BroilerFeedView renders the order board header above the legacy ledger', () => {
    expect(broilerSrc).toMatch(/Feed order/);
    expect(broilerSrc).toMatch(/showPoultryLegacyLedger/);
    expect(broilerSrc).toMatch(/Show monthly ledger/);
    const boardIdx = broilerSrc.indexOf('Feed order');
    const legacyIdx = broilerSrc.indexOf('showPoultryLegacyLedger &&');
    expect(boardIdx).toBeGreaterThan(0);
    expect(legacyIdx).toBeGreaterThan(boardIdx);
  });

  it('Pig "Use suggested" writes to ppp-feed-orders-v1 via savePigOrder(thisYM, suggestion)', () => {
    expect(pigSrc).toMatch(/applyPigSuggestion/);
    expect(pigSrc).toMatch(/savePigOrder\(thisYM, String\(pigSuggestion\.suggestedOrderLbs\)\)/);
    expect(pigSrc).toMatch(/sbSave\('ppp-feed-orders-v1'/);
  });

  it('Poultry "Use suggested" writes to ppp-feed-orders-v1 via savePoultryOrder(type, thisYM, suggestion)', () => {
    expect(broilerSrc).toMatch(/applyPoultrySuggestion/);
    expect(broilerSrc).toMatch(/savePoultryOrder\(row\.ordKey, thisYM, String\(row\.suggestion\.suggestedOrderLbs\)\)/);
    expect(broilerSrc).toMatch(/sbSave\('ppp-feed-orders-v1'/);
  });

  it('Both views require a two-tap confirm when overwriting an existing current-month order', () => {
    expect(pigSrc).toMatch(/confirmPigSuggested/);
    expect(pigSrc).toMatch(/setConfirmPigSuggested\(true\)/);
    expect(broilerSrc).toMatch(/confirmPoultrySuggested/);
    expect(broilerSrc).toMatch(/setConfirmPoultrySuggested\(row\.key\)/);
  });

  it('Pig burn uses ledger-derived feeder counts (no stored currentCount reads)', () => {
    expect(pigSrc).toMatch(/pigDailyBurnLbs\(dateISO, \{feederGroups, breedingCycles, breeders, farrowingRecs\}\)/);
    expect(pigSrc).not.toMatch(/sub\.currentCount/);
  });

  it('Poultry burn ties to the existing broiler/layer schedule helpers via poultryDailyBurnLbs', () => {
    expect(broilerSrc).toMatch(/poultryDailyBurnLbs\(dateISO, \{[\s\S]*?batches:\s*activeBroilers/);
    expect(broilerSrc).toMatch(/layerHousings: layerHousings/);
    expect(broilerSrc).toMatch(/layerDailys: allLayerDailys/);
  });

  it('Legacy includesCurrentMonthDelivery read tolerance is preserved on persisted rows', () => {
    // Reconciliation math still has to handle old inventory rows that were
    // saved with this flag = true. The reads below cover that branch.
    expect(pigSrc).toMatch(/inv\.includesCurrentMonthDelivery/);
    expect(broilerSrc).toMatch(/pInv2\.includesCurrentMonthDelivery/);
  });

  it('Operator-facing physical-count input must NOT expose the Includes-current-month-delivery checkbox', () => {
    expect(pigSrc).not.toMatch(/Includes this month's feed delivery/);
    expect(broilerSrc).not.toMatch(/Includes this month's feed delivery/);
    expect(pigSrc).not.toMatch(/pig-feed-count-includes-delivery/);
    expect(broilerSrc).not.toMatch(/poultry-feed-count-includes-delivery/);
  });

  it('New save handlers do NOT take or pass the legacy flag, and do NOT write it into new inventory rows', () => {
    // Signature: third arg is gone.
    expect(pigSrc).toMatch(/function savePigFeedCount\(count, date\)/);
    expect(broilerSrc).toMatch(/function savePoultryFeedCount\(type, count, date\)/);
    // Call sites no longer pass a third arg (true OR false).
    expect(pigSrc).not.toMatch(/savePigFeedCount\([^)]*,\s*(?:true|false)\s*\)/);
    expect(broilerSrc).not.toMatch(/savePoultryFeedCount\([^)]*,\s*(?:true|false)\s*\)/);
    // The new inventory objects assembled by the save handlers must not
    // include the legacy flag as a written key.
    expect(pigSrc).not.toMatch(/includesCurrentMonthDelivery:\s*!!includesCurrentMonthDelivery/);
    expect(broilerSrc).not.toMatch(/includesCurrentMonthDelivery:\s*!!includesCurrentMonthDelivery/);
  });

  it('Legacy operator-facing labels for the delivery-in-count concept are gone', () => {
    expect(pigSrc).not.toMatch(/Delivery included in count/);
    expect(pigSrc).not.toMatch(/'\(in count\)'/);
    expect(broilerSrc).not.toMatch(/Delivery included in count/);
    expect(broilerSrc).not.toMatch(/'\(in count\)'/);
    // The internal-only ledger field that only fed those labels is also gone.
    expect(pigSrc).not.toMatch(/deliveryInCount/);
    expect(broilerSrc).not.toMatch(/deliveryInCount/);
  });

  it('No-snapshot state still surfaces a suggestion (estimated), per Codex direction', () => {
    expect(pigSrc).toMatch(/onHandLbs: pigOnHand == null \? 0 : pigOnHand/);
    expect(broilerSrc).toMatch(/onHandLbs: onHand == null \? 0 : onHand/);
    expect(pigSrc).toMatch(/estimated — enter count/);
    expect(broilerSrc).toMatch(/enter count/);
  });
});
