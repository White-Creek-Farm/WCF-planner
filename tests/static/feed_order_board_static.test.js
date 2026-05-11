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
    expect(pigSrc).toMatch(/savePigOrder\(activeYM, String\(valueToSave\)\)/);
    expect(pigSrc).not.toMatch(/onChange:\s*function\s*\(e\)\s*\{\s*savePigOrder/);
  });

  it('active month advances by deriving activeYM from "first unsaved month at or after thisYM"', () => {
    expect(pigSrc).toMatch(/firstUnsavedFrom\(thisYM\)/);
    expect(pigSrc).toMatch(/while \(\(feedOrders\.pig \|\| \{\}\)\[cur\] != null\)/);
  });

  it('only the most-recently-saved month exposes an Edit button', () => {
    expect(pigSrc).toMatch(/isMostRecentSavedCard/);
    expect(pigSrc).toMatch(/ym === mostRecentSavedNonActiveYM/);
    // Edit is only rendered when isMostRecentSavedCard is truthy.
    expect(pigSrc).toMatch(/isMostRecentSavedCard\s*&&[\s\S]*?Edit/);
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

  it('active card renders before saved history; older cards live behind Show older months', () => {
    // renderCard(activeYM) is the first slot emitted; mostRecentSaved is
    // second; older saved months sit behind a Show older months toggle.
    expect(pigSrc).toMatch(/renderCard\(activeYM\)/);
    expect(pigSrc).toMatch(/mostRecentSavedNonActiveYM && renderCard\(mostRecentSavedNonActiveYM\)/);
    expect(pigSrc).toMatch(/showOlderMonths && olderSavedYMs\.map\(\(ym\) => renderCard\(ym\)\)/);
    // The active card slot appears in the JSX before the most-recent-saved slot.
    const activeIdx = pigSrc.indexOf('renderCard(activeYM)');
    const mostRecentIdx = pigSrc.indexOf('mostRecentSavedNonActiveYM && renderCard');
    const olderIdx = pigSrc.indexOf('showOlderMonths && olderSavedYMs.map');
    expect(activeIdx).toBeGreaterThan(0);
    expect(mostRecentIdx).toBeGreaterThan(activeIdx);
    expect(olderIdx).toBeGreaterThan(mostRecentIdx);
  });

  it('Show older months toggle is rendered between the most-recent-saved card and older cards', () => {
    expect(pigSrc).toMatch(/Show older months/);
    expect(pigSrc).toMatch(/Hide older months/);
    expect(pigSrc).toMatch(/setShowOlderMonths/);
    // The toggle is only rendered when there are older months to show.
    expect(pigSrc).toMatch(/olderSavedYMs\.length > 0 &&[\s\S]*?Show older months/);
  });

  it('saved month cap (last 6) and older newest-first selection are preserved', () => {
    // Up to 5 older saved months render newest-first when expanded
    // (mostRecentSaved + 5 older = 6 total saved on screen).
    expect(pigSrc).toMatch(/savedExcludingActive\.slice\(0, -1\)\.slice\(-5\)\.reverse\(\)/);
    // No legacy collapse / expand groups, no separate past/future sections.
    expect(pigSrc).not.toMatch(/UPCOMING MONTHS/);
    expect(pigSrc).not.toMatch(/PAST MONTHS/);
    expect(pigSrc).not.toMatch(/pigFeedExpandedMonths/);
  });

  it('most-recent-saved card has its own visual treatment (distinct from older cards)', () => {
    // Stronger border + lighter green header background for the
    // most-recent-saved card; older cards stay plain grey.
    expect(pigSrc).toMatch(/isMostRecentSavedCard/);
    expect(pigSrc).toMatch(/'2px solid #a7f3d0'/);
    expect(pigSrc).toMatch(/'#f0fdf4'/);
    // LAST SAVED chip on the most-recent-saved card header.
    expect(pigSrc).toMatch(/LAST SAVED/);
  });

  it('Order for tile keeps amber styling even when recommendation is 0 lbs', () => {
    // Amber background + amber border are not gated on a positive value.
    expect(pigSrc).toMatch(
      /\{\s*\/\* Order for \[active\][\s\S]*?background: '#fffbeb'[\s\S]*?border: '2px solid #fde68a'/,
    );
    expect(pigSrc).not.toMatch(/background:\s*recommendedOrder[\s\S]*?'#fffbeb'\s*:\s*'white'/);
  });

  it('zero-recommendation Save 0 path is enabled with a blank input', () => {
    // commitActiveOrder accepts an empty draft when recommendedOrder === 0.
    expect(pigSrc).toMatch(/if \(recommendedOrder !== 0\) return;[\s\S]*?valueToSave = 0;/);
    // Button label flips to "Save 0" in that state.
    expect(pigSrc).toMatch(/zeroSavePath\s*=\s*!draftHasValue && recommendedOrder === 0/);
    expect(pigSrc).toMatch(/buttonLabel\s*=\s*zeroSavePath \? 'Save 0' : 'Save Order'/);
    expect(pigSrc).toMatch(/saveEnabled\s*=\s*draftHasValue \|\| zeroSavePath/);
  });

  it('active Ordered input is never prefilled from the recommendation', () => {
    // No JSX attribute (placeholder=, value=, defaultValue=) on any element
    // pulls from recommendedOrder. The recommendation lives only in the
    // top Order-for tile; the input itself starts visually blank.
    expect(pigSrc).not.toMatch(/placeholder=\{[^{}]*recommendedOrder/);
    expect(pigSrc).not.toMatch(/value=\{[^{}]*recommendedOrder/);
    expect(pigSrc).not.toMatch(/defaultValue=\{[^{}]*recommendedOrder/);
    // The active input's value attribute is literally `activeOrderDraft`,
    // confirming the operator's typed string is the only source.
    expect(pigSrc).toMatch(/value=\{activeOrderDraft\}/);
  });

  it('physical-count form does NOT expose an editable date input', () => {
    // The "what is on site now" rule — no backdated count saves.
    expect(pigSrc).not.toMatch(/id="pig-feed-count-date"/);
    expect(pigSrc).not.toMatch(/countDateInput/);
  });

  it('save count handler stamps today (not a user-provided date) and labels the checkbox by today month', () => {
    expect(pigSrc).toMatch(/savePigFeedCount\(countLbsInput, todayDate, countIncludesInput\)/);
    // countMonthShort derives from todayDate, not from a count date input.
    expect(pigSrc).toMatch(
      /const \[y, m\] = todayDate\.split\('-'\)\.map\(Number\);[\s\S]*?return new Date\(y, m - 1, 1\)\.toLocaleDateString\('en-US', \{month: 'short'\}\)/,
    );
  });
});

// ============================================================================
// Poultry feed ledger — minimal-ledger contract matching pig
// ============================================================================

describe('BroilerFeedView — minimal ledger contract', () => {
  it('does not render the snapshot-anchored Feed order board on poultry', () => {
    expect(broilerSrc).not.toMatch(/Snapshot-anchored order board/);
    expect(broilerSrc).not.toMatch(/applyPoultrySuggestion/);
    expect(broilerSrc).not.toMatch(/Days runway/);
    expect(broilerSrc).not.toMatch(/Order by/);
    expect(broilerSrc).not.toMatch(/Use suggested/);
    expect(broilerSrc).not.toMatch(/Recount soon/);
    expect(broilerSrc).not.toMatch(/showPoultryLegacyLedger/);
    expect(broilerSrc).not.toMatch(/confirmPoultrySuggested/);
    expect(broilerSrc).not.toMatch(/Show monthly ledger/);
    expect(broilerSrc).not.toMatch(/Hide monthly ledger/);
    // No suggestOrder path imported or used.
    expect(broilerSrc).not.toMatch(/\bsuggestOrder\b/);
    expect(broilerSrc).not.toMatch(/STALE_SNAPSHOT_DAYS/);
  });

  it('renders the four contract top tiles with three stacked per-type rows (no big total)', () => {
    expect(broilerSrc).toMatch(/Actual On Hand/);
    expect(broilerSrc).toMatch(/'End of ' \+ prevLabel \+ ' Est\.'/);
    expect(broilerSrc).toMatch(/'Order for ' \+ activeLabel/);
    expect(broilerSrc).toMatch(/'Need Thru ' \+ nextLabel/);
    // Each tile renders three stacked per-type rows via the shared
    // renderTileRows helper. The helper drives off TILE_TYPE_ROWS so
    // Starter / Grower / Layer Feed each scan on their own line.
    expect(broilerSrc).toMatch(/const TILE_TYPE_ROWS\s*=\s*\[/);
    expect(broilerSrc).toMatch(/\{key:\s*'starter',\s*label:\s*'Starter'/);
    expect(broilerSrc).toMatch(/\{key:\s*'grower',\s*label:\s*'Grower'/);
    expect(broilerSrc).toMatch(/\{key:\s*'layer',\s*label:\s*'Layer Feed'/);
    expect(broilerSrc).toMatch(/function renderTileRows\(perType, valueColorFn\)/);
    expect(broilerSrc).toMatch(/renderTileRows\(actualOnHand,/);
    expect(broilerSrc).toMatch(/renderTileRows\(endOfPrev,/);
    expect(broilerSrc).toMatch(/renderTileRows\(recommendedOrder, \(\) => '#92400e'\)/);
    expect(broilerSrc).toMatch(/renderTileRows\(needThruNext,/);
  });

  it('no big-total-first display or compressed split string in poultry tiles', () => {
    // No total intermediates feeding the tiles.
    expect(broilerSrc).not.toMatch(/actualOnHandTotal/);
    expect(broilerSrc).not.toMatch(/endOfPrevTotal/);
    expect(broilerSrc).not.toMatch(/recommendedOrderTotal/);
    expect(broilerSrc).not.toMatch(/needThruNextTotal/);
    expect(broilerSrc).not.toMatch(/actualOnHandHasAny/);
    expect(broilerSrc).not.toMatch(/endOfPrevHasAny/);
    expect(broilerSrc).not.toMatch(/recommendedOrderHasAny/);
    // No compressed "Starter · Grower · Layer" split string.
    expect(broilerSrc).not.toMatch(/fmtSplit/);
    expect(broilerSrc).not.toMatch(/'Starter ' \+/);
    expect(broilerSrc).not.toMatch(/' · Grower '/);
    expect(broilerSrc).not.toMatch(/' · Layer '/);
  });

  it('Ordered label/value/input are grouped in the same right-aligned column', () => {
    // The Ordered cell wrapper itself owns textAlign right so the
    // ORDERED label sits directly above its value/input rather than
    // hanging off to the left.
    expect(broilerSrc).toMatch(
      /\{\/\* Ordered cell[\s\S]*?<div style=\{\{textAlign: 'right'\}\}>[\s\S]*?Ordered[\s\S]*?rowShowsInput \?/,
    );
    // The Ordered column is now the same width as the other equation
    // cells so the saved value (e.g. 4,000) doesn't strand far from the
    // ORDERED label above it.
    expect(broilerSrc).toMatch(/gridTemplateColumns: '90px 1fr 14px 1fr 14px 1fr 14px 1fr'/);
    expect(broilerSrc).not.toMatch(/gridTemplateColumns: '90px 1fr 14px 1fr 14px 1\.4fr 14px 1fr'/);
  });

  it('Order for tile keeps amber styling regardless of recommended total', () => {
    // Amber bg + amber border on the Order-for tile are not gated on a positive value.
    expect(broilerSrc).toMatch(/Order for \[active\][\s\S]*?background: '#fffbeb'[\s\S]*?border: '2px solid #fde68a'/);
  });

  it('recommended order per type = max(0, needThruNext[type] − endOfPrev[type])', () => {
    expect(broilerSrc).toMatch(/Math\.max\(0, needThruNext\[type\] - endOfPrev\[type\]\)/);
    // No carryover/runway language.
    expect(broilerSrc).not.toMatch(/Carryover:/);
    expect(broilerSrc).not.toMatch(/days remaining/);
  });

  it('active card renders before saved history; older months are behind Show older months', () => {
    expect(broilerSrc).toMatch(/renderMonthCard\(activeYM\)/);
    expect(broilerSrc).toMatch(/mostRecentSavedNonActiveYM && renderMonthCard\(mostRecentSavedNonActiveYM\)/);
    expect(broilerSrc).toMatch(/showOlderMonths && olderSavedYMs\.map\(\(ym\) => renderMonthCard\(ym\)\)/);
    expect(broilerSrc).toMatch(/Show older months/);
    expect(broilerSrc).toMatch(/Hide older months/);
    const activeIdx = broilerSrc.indexOf('renderMonthCard(activeYM)');
    const mostRecentIdx = broilerSrc.indexOf('mostRecentSavedNonActiveYM && renderMonthCard');
    const olderIdx = broilerSrc.indexOf('showOlderMonths && olderSavedYMs.map');
    expect(activeIdx).toBeGreaterThan(0);
    expect(mostRecentIdx).toBeGreaterThan(activeIdx);
    expect(olderIdx).toBeGreaterThan(mostRecentIdx);
  });

  it('a month is fully saved only when all three feed-type orders are present', () => {
    expect(broilerSrc).toMatch(/function isMonthFullySaved\(ym\)/);
    expect(broilerSrc).toMatch(
      /\(feedOrders\.starter \|\| \{\}\)\[ym\] != null &&[\s\S]*?\(feedOrders\.grower \|\| \{\}\)\[ym\] != null &&[\s\S]*?\(feedOrders\.layerfeed \|\| \{\}\)\[ym\] != null/,
    );
    expect(broilerSrc).toMatch(/savedOrderYMs\s*=\s*\[\.\.\.allOrderYMs\]\.filter\(isMonthFullySaved\)/);
  });

  it('active card has three feed-type rows (Starter / Grower / Layer Feed) with editable inputs', () => {
    expect(broilerSrc).toMatch(/\{key: 'starter', label: 'Starter'/);
    expect(broilerSrc).toMatch(/\{key: 'grower', label: 'Grower'/);
    expect(broilerSrc).toMatch(/\{key: 'layer', label: 'Layer Feed'/);
    // Per-row Ordered input value is the local draft, not the recommendation.
    expect(broilerSrc).toMatch(/value=\{draft\}/);
    expect(broilerSrc).toMatch(/setActiveOrderDrafts\(\(d\) => \(\{\.\.\.d, \[row\.draftKey\]: e\.target\.value\}\)\)/);
  });

  it('inputs are blank — no recommendation prefill or placeholder', () => {
    // No placeholder/value/defaultValue attribute pulls from recommendedOrder.
    expect(broilerSrc).not.toMatch(/placeholder=\{[^{}]*recommendedOrder/);
    expect(broilerSrc).not.toMatch(/value=\{[^{}]*recommendedOrder/);
    expect(broilerSrc).not.toMatch(/defaultValue=\{[^{}]*recommendedOrder/);
  });

  it('single month-level Save Order writes all three feed-order keys atomically', () => {
    expect(broilerSrc).toMatch(/function commitActiveOrder\(\)/);
    expect(broilerSrc).toMatch(/starter:\s*\{\.\.\.\(feedOrders\.starter \|\| \{\}\),\s*\[activeYM\]:\s*sVal\}/);
    expect(broilerSrc).toMatch(/grower:\s*\{\.\.\.\(feedOrders\.grower \|\| \{\}\),\s*\[activeYM\]:\s*gVal\}/);
    expect(broilerSrc).toMatch(/layerfeed:\s*\{\.\.\.\(feedOrders\.layerfeed \|\| \{\}\),\s*\[activeYM\]:\s*lVal\}/);
    expect(broilerSrc).toMatch(/sbSave\('ppp-feed-orders-v1'/);
  });

  it('Save 0 path exists for the all-zero-recommendation case', () => {
    // Button label flips to "Save 0" only when all three drafts are blank
    // AND all three recommendations are 0; otherwise it stays "Save Order".
    expect(broilerSrc).toMatch(
      /allZeroPath\s*=\s*!anyDraftHasValue &&[\s\S]*?recommendedOrder\.starter === 0 &&[\s\S]*?recommendedOrder\.grower === 0 &&[\s\S]*?recommendedOrder\.layer === 0/,
    );
    expect(broilerSrc).toMatch(/saveButtonLabel\s*=\s*allZeroPath \? 'Save 0' : 'Save Order'/);
    // Save is disabled when any blank type still has a non-zero recommendation.
    expect(broilerSrc).toMatch(/function rowSaveValid\(type, orderKey, hasDraft\)/);
    expect(broilerSrc).toMatch(/recommendedOrder\[type\] === 0/);
  });

  it('only the most-recently-saved month exposes an Edit button', () => {
    expect(broilerSrc).toMatch(/isMostRecentSavedCard/);
    expect(broilerSrc).toMatch(/ym === mostRecentSavedNonActiveYM/);
    expect(broilerSrc).toMatch(/isMostRecentSavedCard && \(/);
    expect(broilerSrc).toMatch(/function editMonth\(ym\)/);
    // Edit preloads all three drafts from persisted values.
    expect(broilerSrc).toMatch(/starter:\s*\(feedOrders\.starter \|\| \{\}\)\[ym\]/);
    expect(broilerSrc).toMatch(/grower:\s*\(feedOrders\.grower \|\| \{\}\)\[ym\]/);
    expect(broilerSrc).toMatch(/layerfeed:\s*\(feedOrders\.layerfeed \|\| \{\}\)\[ym\]/);
  });

  it('edit mode hides LAST SAVED / Edit on older months — only the edited month is active', () => {
    // "Once a later month is saved, older months cannot be edited." When
    // editingMonthYM is set, the edited month is the active card; every
    // saved month before it must sit in the Show older months collapse
    // with no LAST SAVED chip and no Edit button.
    expect(broilerSrc).toMatch(/mostRecentSavedNonActiveYM\s*=\s*!isActiveEditMode && savedExcludingActive\.length/);
    // In edit mode, olderSavedYMs takes all of savedExcludingActive (not
    // .slice(0, -1)) so no month is held back as the LAST SAVED candidate.
    expect(broilerSrc).toMatch(
      /olderSavedYMs\s*=\s*isActiveEditMode\s*\?\s*savedExcludingActive\.slice\(-5\)\.reverse\(\)\s*:\s*savedExcludingActive\.slice\(0, -1\)\.slice\(-5\)\.reverse\(\)/,
    );
  });

  it('older saved months cap at 5 + most-recent-saved (newest-first when expanded)', () => {
    expect(broilerSrc).toMatch(/savedExcludingActive\.slice\(0, -1\)\.slice\(-5\)\.reverse\(\)/);
  });

  it('most-recent-saved card has its own visual treatment distinct from older cards', () => {
    expect(broilerSrc).toMatch(/'2px solid #a7f3d0'/);
    expect(broilerSrc).toMatch(/'#f0fdf4'/);
    expect(broilerSrc).toMatch(/LAST SAVED/);
  });

  it('monthly card equation row renders the operator glyphs Start − Consumed + Ordered = End', () => {
    expect(broilerSrc).toMatch(/'−'/);
    expect(broilerSrc).toMatch(/'\+'/);
    expect(broilerSrc).toMatch(/'='/);
  });

  it('physical-count form does NOT expose an editable date input', () => {
    expect(broilerSrc).not.toMatch(/id="poultry-feed-count-date"/);
    expect(broilerSrc).not.toMatch(/countDateInput/);
  });

  it('save count handler stamps today and labels the checkbox by today month', () => {
    expect(broilerSrc).toMatch(/savePoultryFeedCount\(countType, countLbsInput, todayDate, countIncludesInput\)/);
    expect(broilerSrc).toMatch(
      /const \[y, m\] = todayDate\.split\('-'\)\.map\(Number\);[\s\S]*?return new Date\(y, m - 1, 1\)\.toLocaleDateString\('en-US', \{month: 'short'\}\)/,
    );
    expect(broilerSrc).toMatch(/'Count includes ' \+ countMonthShort \+ ' order'/);
  });

  it('savePoultryFeedCount writes includesCurrentMonthDelivery on the selected feed-type inventory', () => {
    expect(broilerSrc).toMatch(/function savePoultryFeedCount\(type, count, date, includesCurrentMonthDelivery\)/);
    expect(broilerSrc).toMatch(/includesCurrentMonthDelivery:\s*!!includesCurrentMonthDelivery/);
  });

  it('Actual On Hand counts only orders that arrived after the count, per feed type', () => {
    expect(broilerSrc).toMatch(/inv\.count \+ ordersArrivedAfterCount - consumedSinceCount/);
    expect(broilerSrc).toMatch(/ym === invYM && !inv\.includesCurrentMonthDelivery && ym < thisYM/);
  });

  it('poultry burn still routes through the broiler/layer schedule helpers', () => {
    // The minimal-ledger UI relies on the existing monthly projection
    // helpers + the layer schedule + the layer housing projected-count
    // helper. No duplicated feed-rate constants in the view itself.
    expect(broilerSrc).toMatch(/from '\.\.\/lib\/broiler\.js'/);
    expect(broilerSrc).toMatch(/\bcalcBatchFeedForMonth\b/);
    expect(broilerSrc).toMatch(/\bcalcLayerFeedForMonth\b/);
    expect(broilerSrc).toMatch(/\bLAYER_FEED_SCHEDULE\b/);
    expect(broilerSrc).toMatch(/\bLAYER_FEED_PER_DAY\b/);
    expect(broilerSrc).toMatch(/from '\.\.\/lib\/layerHousing\.js'/);
    expect(broilerSrc).toMatch(/\bcomputeProjectedCount\b/);
  });

  it('feedPlanner.poultryDailyBurnLbs drives the rest-of-current-month burn per feed type', () => {
    // PROJECT.md "new feed order logic must use feedPlanner.js" —
    // satisfied here by routing the in-month remaining-burn through
    // poultryDailyBurnLbs (broiler batches + layer batches + layer
    // housings + layer dailys) rather than a flat proportional split.
    expect(broilerSrc).toMatch(/from '\.\.\/lib\/feedPlanner\.js'/);
    expect(broilerSrc).toMatch(/\bpoultryDailyBurnLbs\b/);
    expect(broilerSrc).toMatch(
      /poultryDailyBurnLbs\(iso,\s*\{[\s\S]*?batches:\s*activeBroilers[\s\S]*?layerBatches:\s*activeLayerBatchesForFeed[\s\S]*?layerHousings:[\s\S]*?layerDailys:[\s\S]*?\}\)/,
    );
    // The pLedger consumes the per-type per-day burn rather than the
    // legacy md.proj × pDaysLeft / daysInMonth proportional approximation.
    expect(broilerSrc).toMatch(/pRem = currentMonthRemainingBurnByType\[type\]/);
    expect(broilerSrc).toMatch(/pRoj = currentMonthRemainingBurnByType\[type\]/);
    expect(broilerSrc).not.toMatch(/md\[projKey\] \* \(pDaysLeft \/ md\.daysInMonth\)/);
  });

  it('partial-saved active month preserves existing saved values', () => {
    // A real-world poultry month can have starter saved but grower /
    // layerfeed missing. The view must:
    //   1. Render the saved type(s) as plain text in the active card,
    //      not as editable inputs.
    //   2. Carry the persisted value through commitActiveOrder unchanged
    //      so it cannot be overwritten by blank/zero logic.
    //   3. Only require operator input for the missing type(s).
    expect(broilerSrc).toMatch(/function rowLocksToPersisted\(orderKey\)/);
    expect(broilerSrc).toMatch(/!isActiveEditMode && isRowPersistedForActive\(orderKey\)/);
    // Render branch: rowShowsInput = isActive && (isActiveEditMode || !isSaved).
    expect(broilerSrc).toMatch(/rowShowsInput\s*=\s*isActive && \(isActiveEditMode \|\| !isSaved\)/);
    expect(broilerSrc).toMatch(/\{rowShowsInput \?/);
    // Save branch: persisted row passes through unchanged.
    expect(broilerSrc).toMatch(/function decideRow\(orderKey, draftKey, rec\)/);
    expect(broilerSrc).toMatch(
      /if \(rowLocksToPersisted\(orderKey\)\)\s*\{[\s\S]*?return parseFloat\(persistedValueForActive\(orderKey\)\) \|\| 0;/,
    );
    // Save-button validity treats persisted rows as auto-valid (no draft needed).
    expect(broilerSrc).toMatch(
      /function rowSaveValid\(type, orderKey, hasDraft\)\s*\{[\s\S]*?if \(rowLocksToPersisted\(orderKey\)\) return true;/,
    );
    // "Save 0" label only applies to a wholly-fresh all-zero month —
    // never when any feed-type for activeYM is already persisted.
    expect(broilerSrc).toMatch(/!anyTypePersistedForActive/);
    // Edit mode bypasses the lock so all three rows become editable for
    // the most-recently-saved month.
    expect(broilerSrc).toMatch(/isActiveEditMode\s*=\s*editingMonthYM != null/);
  });

  it('per-batch broiler + layer reference sections are still rendered at the bottom', () => {
    expect(broilerSrc).toMatch(/Broiler Feed Estimate Per Batch/);
    expect(broilerSrc).toMatch(/Layer Feed Estimate Per Batch/);
    expect(broilerSrc).toMatch(/renderBroilerBatchFeed/);
  });
});
