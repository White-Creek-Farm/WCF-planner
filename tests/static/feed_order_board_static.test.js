import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const pigSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigFeedView.jsx'), 'utf8');
const broilerSrc = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerFeedView.jsx'), 'utf8');

// ============================================================================
// Pig feed ledger — minimal screen contract (post snapshot-board removal)
// ============================================================================

describe('PigFeedView — minimal ledger contract', () => {
  it('does not render the snapshot-anchored "Feed order" board on pig', () => {
    // No card header, no suggestOrder-style "Order by / Days runway" path,
    // no "Use suggested" action, no STALE_SNAPSHOT_DAYS chip.
    expect(pigSrc).not.toMatch(/Snapshot-anchored order board/);
    expect(pigSrc).not.toMatch(/applyPigSuggestion/);
    expect(pigSrc).not.toMatch(/Days runway/);
    expect(pigSrc).not.toMatch(/Order by/);
    expect(pigSrc).not.toMatch(/Use suggested/);
    expect(pigSrc).not.toMatch(/Recount soon/);
    expect(pigSrc).not.toMatch(/STALE_SNAPSHOT_DAYS/);
    // Runway language is out of the minimal-ledger contract — no
    // "days remaining" subtext anywhere on the screen.
    expect(pigSrc).not.toMatch(/days remaining/);
  });

  it('Order tile renders the lbs number only — no "Surplus" or other word swaps', () => {
    expect(pigSrc).not.toMatch(/'Surplus'/);
    // Zero-or-positive recommendation always renders as "<N> lbs". Falls back
    // to em-dash only when the ledger has no anchor at all.
    expect(pigSrc).toMatch(/recommendedOrder != null \? recommendedOrder\.toLocaleString\(\) \+ ' lbs' : '—'/);
  });

  it('active order input has no recommendation placeholder', () => {
    // The recommendation lives in the Order-for tile. The input itself
    // must start visually blank.
    expect(pigSrc).not.toMatch(/placeholder=\{[\s\S]*?recommendedOrder/);
  });

  it('monthly card has no Count adj chip — adjustment line stays on Actual On Hand only', () => {
    expect(pigSrc).not.toMatch(/Count adj /);
    // The Actual On Hand adjustment line remains.
    expect(pigSrc).toMatch(/Adj ' \+ \(physCountAdjustment/);
  });

  it('monthly ledger is visible — no collapse toggle on pig', () => {
    expect(pigSrc).not.toMatch(/showPigLegacyLedger/);
    expect(pigSrc).not.toMatch(/Show monthly ledger/);
    expect(pigSrc).not.toMatch(/Hide monthly ledger/);
  });

  it('Carryover subtext is absent from the Order tile', () => {
    expect(pigSrc).not.toMatch(/Carryover:/);
  });

  it('renders the four contract top tiles', () => {
    expect(pigSrc).toMatch(/Actual On Hand/);
    expect(pigSrc).toMatch(/End of ' \+ prevLabel \+ ' Est\./);
    expect(pigSrc).toMatch(/Order for ' \+ activeLabel/);
    expect(pigSrc).toMatch(/Need Thru ' \+ nextLabel/);
  });

  it('pig burn + group breakdown remain ledger-correct via feedPlanner helpers', () => {
    // Burn helper for both daily-total and per-group projections.
    expect(pigSrc).toMatch(/pigDailyBurnLbs\([^)]*\{feederGroups, breedingCycles, breeders, farrowingRecs\}/);
    // Per-group breakdown uses pigFeederSubCurrentCount (transfers +
    // mortality subtracted), not the legacy originalPigCount − processed
    // approximation.
    expect(pigSrc).toMatch(/pigFeederSubCurrentCount\(g, sub, breeders\)/);
    expect(pigSrc).toMatch(/pigFeederLbsPerDayAtAge\(ageDays\)/);
    // Parent-only (legacy, no sub-batches) batches must subtract transfers
    // + mortality the same way pigDailyBurnLbs' parent path does, so the
    // visible row matches the top-tile burn.
    expect(pigSrc).toMatch(/pigTransfersForBatch\(breeders, g\.batchName\)/);
    expect(pigSrc).toMatch(/pigMortalityForBatch\(g\)/);
    expect(pigSrc).toMatch(/started - tripPigs - transfers\.count - mortality/);
  });

  it('recommended order math = max(0, Need Thru next − End of prev Est.)', () => {
    expect(pigSrc).toMatch(
      /needThruNext\s*=\s*\(activeMd \? activeMd\.projTotal : 0\)\s*\+\s*\(nextMd \? nextMd\.projTotal : 0\)/,
    );
    expect(pigSrc).toMatch(/recommendedOrder\s*=[\s\S]*?Math\.max\(0, needThruNext - endOfPrevEst\)/);
    // No alternate hidden orderBaseEst.
    expect(pigSrc).not.toMatch(/orderBaseEst/);
  });

  it('Actual On Hand counts only orders that arrived after the count', () => {
    // Adds count + arrived-after-count − consumed-since-count. Count-month
    // order is included only when includesCurrentMonthDelivery is FALSE
    // (otherwise it was already absorbed into the count).
    expect(pigSrc).toMatch(/inv\.count \+ ordersArrivedAfterCount - consumedSinceCount/);
    expect(pigSrc).toMatch(/ym === invYMConst && !inv\.includesCurrentMonthDelivery/);
  });

  it('physical-count input exposes a "Count includes <month> order" checkbox', () => {
    expect(pigSrc).toMatch(/id="pig-feed-count-includes-delivery"/);
    expect(pigSrc).toMatch(/'Count includes ' \+ countMonthShort \+ ' order'/);
  });

  it('savePigFeedCount takes 3 args and writes includesCurrentMonthDelivery again', () => {
    expect(pigSrc).toMatch(/function savePigFeedCount\(count, date, includesCurrentMonthDelivery\)/);
    expect(pigSrc).toMatch(/includesCurrentMonthDelivery:\s*!!includesCurrentMonthDelivery/);
  });

  it('active editable month exposes a Save Order button, blank input, no auto-save on keystroke', () => {
    expect(pigSrc).toMatch(/Save Order/);
    expect(pigSrc).toMatch(/commitActiveOrder/);
    // Active draft lives in local state; only commitActiveOrder writes via savePigOrder.
    expect(pigSrc).toMatch(/savePigOrder\(activeYM, raw\)/);
    expect(pigSrc).not.toMatch(/onChange:\s*function\s*\(e\)\s*\{\s*savePigOrder/);
  });

  it('active month advances by deriving activeYM from "first unsaved month at or after thisYM"', () => {
    expect(pigSrc).toMatch(/firstUnsavedFrom\(thisYM\)/);
    expect(pigSrc).toMatch(/while \(\(feedOrders\.pig \|\| \{\}\)\[cur\] != null\)/);
  });

  it('only the most-recently-saved month exposes an Edit button', () => {
    expect(pigSrc).toMatch(/isMostRecentSavedNonActive/);
    expect(pigSrc).toMatch(/ym === mostRecentSavedYM/);
    // Edit is only rendered when isMostRecentSavedNonActive is truthy.
    expect(pigSrc).toMatch(/isMostRecentSavedNonActive\s*&&[\s\S]*?Edit/);
  });

  it('clicking Edit pre-loads the persisted value into the draft (no DB write until Save Order)', () => {
    expect(pigSrc).toMatch(/function editMonth\(ym\)/);
    expect(pigSrc).toMatch(/setEditingMonthYM\(ym\)/);
    expect(pigSrc).toMatch(/setActiveOrderDraft\(cur != null \? String\(cur\) : ''\)/);
  });

  it('monthly card equation row renders the operator glyphs Start − Consumed + Ordered = End', () => {
    // Equation operators sit between the four cells.
    expect(pigSrc).toMatch(/'−'/);
    expect(pigSrc).toMatch(/'\+'/);
    expect(pigSrc).toMatch(/'='/);
    expect(pigSrc).toMatch(/Start of Month[\s\S]*?Consumed[\s\S]*?Ordered[\s\S]*?End of Month/);
  });

  it('only the last 6 saved months + the active card render — no future or collapsed months', () => {
    expect(pigSrc).toMatch(/savedOrderYMs\.slice\(-6\)/);
    expect(pigSrc).toMatch(/visibleCardYMs/);
    // No collapse / expand groups, no separate past/future sections.
    expect(pigSrc).not.toMatch(/UPCOMING MONTHS/);
    expect(pigSrc).not.toMatch(/PAST MONTHS/);
    expect(pigSrc).not.toMatch(/pigFeedExpandedMonths/);
  });
});

// ============================================================================
// Poultry feed order board — unchanged this lane (pig-only rebuild)
// ============================================================================

describe('BroilerFeedView — snapshot order board (unchanged this lane)', () => {
  it('still imports the snapshot helpers from feedPlanner.js', () => {
    expect(broilerSrc).toMatch(/from '\.\.\/lib\/feedPlanner\.js'/);
    expect(broilerSrc).toMatch(/\bpoultryDailyBurnLbs\b/);
    expect(broilerSrc).toMatch(/\bonHandFromSnapshot\b/);
    expect(broilerSrc).toMatch(/\bsuggestOrder\b/);
    expect(broilerSrc).toMatch(/\bisSnapshotStale\b/);
  });

  it('renders the order board header above the legacy ledger', () => {
    expect(broilerSrc).toMatch(/Feed order/);
    expect(broilerSrc).toMatch(/showPoultryLegacyLedger/);
    expect(broilerSrc).toMatch(/Show monthly ledger/);
    const boardIdx = broilerSrc.indexOf('Feed order');
    const legacyIdx = broilerSrc.indexOf('showPoultryLegacyLedger &&');
    expect(boardIdx).toBeGreaterThan(0);
    expect(legacyIdx).toBeGreaterThan(boardIdx);
  });

  it('"Use suggested" writes to ppp-feed-orders-v1 via savePoultryOrder(type, thisYM, suggestion)', () => {
    expect(broilerSrc).toMatch(/applyPoultrySuggestion/);
    expect(broilerSrc).toMatch(/savePoultryOrder\(row\.ordKey, thisYM, String\(row\.suggestion\.suggestedOrderLbs\)\)/);
    expect(broilerSrc).toMatch(/sbSave\('ppp-feed-orders-v1'/);
  });

  it('two-tap confirm when overwriting an existing current-month order', () => {
    expect(broilerSrc).toMatch(/confirmPoultrySuggested/);
    expect(broilerSrc).toMatch(/setConfirmPoultrySuggested\(row\.key\)/);
  });

  it('poultry burn ties to the broiler/layer schedule helpers via poultryDailyBurnLbs', () => {
    expect(broilerSrc).toMatch(/poultryDailyBurnLbs\(dateISO, \{[\s\S]*?batches:\s*activeBroilers/);
    expect(broilerSrc).toMatch(/layerHousings: layerHousings/);
    expect(broilerSrc).toMatch(/layerDailys: allLayerDailys/);
  });

  it('legacy includesCurrentMonthDelivery read tolerance is preserved on poultry too', () => {
    expect(broilerSrc).toMatch(/pInv2\.includesCurrentMonthDelivery/);
  });

  it('operator-facing physical-count input must NOT expose the legacy delivery checkbox', () => {
    expect(broilerSrc).not.toMatch(/Includes this month's feed delivery/);
    expect(broilerSrc).not.toMatch(/poultry-feed-count-includes-delivery/);
  });

  it('legacy delivery-in-count operator labels are gone', () => {
    expect(broilerSrc).not.toMatch(/Delivery included in count/);
    expect(broilerSrc).not.toMatch(/'\(in count\)'/);
    expect(broilerSrc).not.toMatch(/deliveryInCount/);
  });

  it('no-snapshot state still surfaces a suggestion (estimated), per Codex direction', () => {
    expect(broilerSrc).toMatch(/onHandLbs: onHand == null \? 0 : onHand/);
    expect(broilerSrc).toMatch(/enter count/);
  });
});
