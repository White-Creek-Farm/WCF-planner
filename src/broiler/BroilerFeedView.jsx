// ============================================================================
// src/broiler/BroilerFeedView.jsx
// ----------------------------------------------------------------------------
// Minimal poultry feed ledger — same shape as PigFeedView, three feed types.
//
// Top of screen:
//   • Four tiles: Actual On Hand · End of [current] Est. · Order for [active] ·
//     Need Thru [active+1]. Big number = total lbs; small subtext shows the
//     per-type split (Starter · Grower · Layer).
//   • Physical-count row right below. Feed-type selector + lbs input + a
//     "Count includes [today's month] order" checkbox. No editable date —
//     count saves stamp today.
//   • Monthly cards: exactly one calendar-pinned order month. Each active
//     row reads as Start − Consumed + Ordered = End per feed type. A saved
//     pinned month renders plain text values with an Edit action.
//   • Existing per-batch broiler + layer reference sections kept at the
//     bottom.
//
// Saved-vs-active rule:
//   A month is "fully saved" only when starter, grower, AND layerfeed
//   orders are all present (including explicit 0). Active month is the
//   current calendar month and does not advance early when saved.
//
// Save behavior (single month-level button):
//   • For each feed type, either the operator typed a value OR the
//     recommendation for that type is exactly 0 (a "Save 0 row").
//   • Save Order writes all three feedOrders.{starter|grower|layerfeed}
//     [activeYM] in one sbSave call; the active month stays pinned until
//     the calendar month flips.
//   • Button reads "Save 0" only when all three drafts are blank AND all
//     three recommendations are 0. Otherwise reads "Save Order" and is
//     disabled if any blank type still has a non-zero recommendation.
//
// Math source-of-truth:
//   Poultry burn flows through poultryDailyBurnLbs (which internally
//   uses getFeedSchedule + LAYER_FEED_SCHEDULE + LAYER_FEED_PER_DAY +
//   computeProjectedCount) and the existing monthly helpers
//   calcBatchFeedForMonth + calcLayerFeedForMonth. No duplicated feed-rate
//   constants. Physical count is ground truth per feed type and avoids
//   double-counting the count-month order when the operator's checkbox
//   says the count already absorbed it.
// ============================================================================
import React, {useState} from 'react';
import {fmt, todayISO} from '../lib/dateUtils.js';
import {openableProps} from '../shared/openable.js';
import {S, getReadableText} from '../lib/styles.js';
import {getProgramColor} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import {
  calcBatchFeedForMonth,
  calcLayerFeedForMonth,
  calcBatchFeed,
  calcBroilerStatsFromDailys,
  calcPoultryStatus,
  getBatchColor,
  breedLabel,
  LAYER_FEED_SCHEDULE,
  LAYER_FEED_PER_DAY,
} from '../lib/broiler.js';
import {computeProjectedCount} from '../lib/layerHousing.js';
import {poultryDailyBurnLbs} from '../lib/feedPlanner.js';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {calendarOrderYM, recommendedFeedOrder} from '../lib/feedOrderBasis.js';

export default function BroilerFeedView({
  Header,
  feedOrders,
  setFeedOrders,
  poultryFeedInventory,
  setPoultryFeedInventory,
  collapsedBatches,
  setCollapsedBatches,
  sbSave,
}) {
  const {batches} = useBatches();
  const {layerBatches, layerHousings, allLayerDailys} = useLayer();
  const {broilerDailys} = useDailysRecent();
  const [countType, setCountType] = useState('starter');
  const [editingMonthYM, setEditingMonthYM] = useState(null);
  const [activeOrderDrafts, setActiveOrderDrafts] = useState({starter: '', grower: '', layerfeed: ''});

  const today = new Date();
  const todayDate = todayISO();

  function addMonthsYM(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function ymLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
  }
  function ymShort(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month: 'short'});
  }

  // ── Calendar window ──────────────────────────────────────────────────────
  const months = [];
  for (let i = -12; i <= 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const thisYM = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');

  const activeBroilers = batches.filter((b) => b.hatchDate);
  const activeLayerBatchesForFeed = (layerBatches || []).filter(
    (b) => b.status === 'active' && b.name !== 'Retirement Home',
  );
  const activeHousings = (layerHousings || []).filter((h) => h.status === 'active');

  // ── Actual consumption by month + feed type ───────────────────────────────
  const actualByMonth = {};
  months.forEach((ym) => {
    actualByMonth[ym] = {starter: 0, grower: 0, layer: 0};
  });
  (broilerDailys || []).forEach((d) => {
    if (!d.date) return;
    const ym = d.date.substring(0, 7);
    if (!actualByMonth[ym]) return;
    const lbs = parseFloat(d.feed_lbs) || 0;
    if (d.feed_type === 'STARTER') actualByMonth[ym].starter += lbs;
    else if (d.feed_type === 'GROWER') actualByMonth[ym].grower += lbs;
  });
  (allLayerDailys || []).forEach((d) => {
    if (!d.date) return;
    const ym = d.date.substring(0, 7);
    if (!actualByMonth[ym]) return;
    const lbs = parseFloat(d.feed_lbs) || 0;
    if (d.feed_type === 'STARTER') actualByMonth[ym].starter += lbs;
    else if (d.feed_type === 'GROWER') actualByMonth[ym].grower += lbs;
    else if (d.feed_type === 'LAYER') actualByMonth[ym].layer += lbs;
  });

  // Per-month per-type projected totals via existing schedule helpers.
  const monthlyData = months.map((ym) => {
    const p = ym.split('-').map(Number);
    const daysInMonth = new Date(p[0], p[1], 0).getDate();
    const isFuture = ym > thisYM;
    const isCurrent = ym === thisYM;
    let bStarter = 0;
    let bGrover = 0;
    activeBroilers.forEach((b) => {
      const f = calcBatchFeedForMonth(b, ym);
      bStarter += f.starter;
      bGrover += f.grower;
    });
    let lStarter = 0;
    let lGrover = 0;
    let lLayer = 0;
    activeLayerBatchesForFeed.forEach((b) => {
      const f = calcLayerFeedForMonth(b, layerHousings || [], allLayerDailys || [], ym);
      lStarter += f.starter;
      lGrover += f.grower;
      lLayer += f.layer;
    });
    const starter = Math.round(bStarter + lStarter);
    const grower = Math.round(bGrover + lGrover);
    const layerFeed = Math.round(lLayer);
    const act = actualByMonth[ym] || {starter: 0, grower: 0, layer: 0};
    const ordS = (feedOrders.starter || {})[ym];
    const ordG = (feedOrders.grower || {})[ym];
    const ordL = (feedOrders.layerfeed || {})[ym];
    return {
      ym,
      daysInMonth,
      isFuture,
      isCurrent,
      starter,
      grower,
      layerFeed,
      actualStarter: Math.round(act.starter),
      actualGrover: Math.round(act.grower),
      actualLayer: Math.round(act.layer),
      ordS: ordS != null ? ordS : null,
      ordG: ordG != null ? ordG : null,
      ordL: ordL != null ? ordL : null,
    };
  });

  // ── Persistence wrappers ─────────────────────────────────────────────────
  function savePoultryFeedCount(type, count, date, includesCurrentMonthDelivery) {
    // Physical count is "what is on site now." The save call below
    // stamps today; this signature retains the date param so we never
    // silently lose the operator's intent if a future caller passes one
    // (the UI itself no longer offers a date input).
    const inv = {...(poultryFeedInventory || {})};
    inv[type] = {
      count: parseFloat(count) || 0,
      date: date || todayDate,
      includesCurrentMonthDelivery: !!includesCurrentMonthDelivery,
    };
    setPoultryFeedInventory(inv);
    sbSave('ppp-poultry-feed-inventory-v1', inv);
  }

  // ── Active-month resolution ──────────────────────────────────────────────
  // A month is "fully saved" only when all three feed-type orders are
  // present (including explicit 0). Active month = the first month at or
  // after today's month that is NOT fully saved.
  function isMonthFullySaved(ym) {
    return (
      (feedOrders.starter || {})[ym] != null &&
      (feedOrders.grower || {})[ym] != null &&
      (feedOrders.layerfeed || {})[ym] != null
    );
  }
  const autoActiveYM = calendarOrderYM(today);
  const activeYM = editingMonthYM != null ? editingMonthYM : autoActiveYM;
  const isActiveEditMode = editingMonthYM != null;
  const prevYM = addMonthsYM(activeYM, -1);
  const nextYM = addMonthsYM(activeYM, 1);
  const prevLabel = ymShort(prevYM);
  const activeLabel = ymShort(activeYM);
  const nextLabel = ymShort(nextYM);

  // One visible order card only. Saving the pinned month never advances this
  // section; it moves when the calendar month moves.

  // ── Running ledger per feed type ─────────────────────────────────────────
  // Anchored by the per-type physical count when present; otherwise by
  // the first month where that type has a saved order. Walks forward
  // through all months in the window so prev/active/next all have a
  // valid Start/Consumed/Ordered/End triple.
  const allDailys = (broilerDailys || []).concat(allLayerDailys || []);
  const pDaysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();

  // Rest-of-current-month burn per feed type via feedPlanner. Sums daily
  // burn for every remaining day in the current month so the ledger's
  // pRem/pRoj values respect each batch's age-by-day instead of a flat
  // proportional split.
  const currentMonthRemainingBurnByType = (() => {
    if (pDaysLeft <= 0) return {starter: 0, grower: 0, layer: 0};
    let starter = 0;
    let grower = 0;
    let layer = 0;
    for (let i = 1; i <= pDaysLeft; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const iso =
        d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const out = poultryDailyBurnLbs(iso, {
        batches: activeBroilers,
        layerBatches: activeLayerBatchesForFeed,
        layerHousings: layerHousings || [],
        layerDailys: allLayerDailys || [],
      });
      starter += out.starterLbs;
      grower += out.growerLbs;
      layer += out.layerLbs;
    }
    return {starter: Math.round(starter), grower: Math.round(grower), layer: Math.round(layer)};
  })();

  const pLedger = {starter: {}, grower: {}, layer: {}};
  ['starter', 'grower', 'layer'].forEach((type) => {
    const orderKey = type === 'layer' ? 'layerfeed' : type;
    const ftKey = type === 'starter' ? 'STARTER' : type === 'grower' ? 'GROWER' : 'LAYER';
    const projKey = type === 'starter' ? 'starter' : type === 'grower' ? 'grower' : 'layerFeed';
    const actualKey = type === 'starter' ? 'actualStarter' : type === 'grower' ? 'actualGrover' : 'actualLayer';
    const orderedKey = type === 'starter' ? 'ordS' : type === 'grower' ? 'ordG' : 'ordL';
    const typeOrderMonths = Object.keys(feedOrders[orderKey] || {})
      .filter((k) => (parseFloat((feedOrders[orderKey] || {})[k]) || 0) > 0)
      .sort();
    const firstOrderYM = typeOrderMonths.length > 0 ? typeOrderMonths[0] : '9999-99';
    const inv = poultryFeedInventory && poultryFeedInventory[type];
    const invYM = inv && inv.date ? inv.date.substring(0, 7) : null;
    let runBal = 0;
    let countApplied = false;
    const sorted = monthlyData.slice().sort((a, b) => a.ym.localeCompare(b.ym));
    for (let i = 0; i < sorted.length; i++) {
      const md = sorted[i];
      if (md.ym < firstOrderYM && (!invYM || md.ym < invYM)) {
        pLedger[type][md.ym] = null;
        continue;
      }
      let lgStart = runBal;
      let isCountMonth = false;
      let countAdj = null;
      if (inv && invYM && !countApplied) {
        if (invYM === md.ym) {
          const thisMonthOrderForAdj = parseFloat(md[orderedKey]) || 0;
          const systemEstThisMonth = runBal + (inv.includesCurrentMonthDelivery ? thisMonthOrderForAdj : 0);
          countAdj = Math.round(inv.count - systemEstThisMonth);
          lgStart = inv.count;
          isCountMonth = true;
          countApplied = true;
          let cAfter = 0;
          allDailys.forEach((d) => {
            if (d.date && d.date > inv.date && d.date.startsWith(md.ym) && d.feed_type === ftKey)
              cAfter += parseFloat(d.feed_lbs) || 0;
          });
          let pRem = 0;
          if (md.isCurrent && pDaysLeft > 0) pRem = currentMonthRemainingBurnByType[type];
          const cons = Math.round(cAfter + pRem);
          const ord = inv.includesCurrentMonthDelivery ? 0 : thisMonthOrderForAdj;
          const en = Math.round(lgStart - cons + ord);
          pLedger[type][md.ym] = {
            start: lgStart,
            consumed: cons,
            actualCons: Math.round(cAfter),
            projCons: Math.round(pRem),
            ordered: ord,
            rawOrdered: thisMonthOrderForAdj,
            end: en,
            countMonth: true,
            countAdj,
          };
          runBal = en;
          continue;
        } else if (invYM < md.ym) {
          lgStart = inv.count;
          countApplied = true;
        }
      }
      let aCtual = md[actualKey];
      let pRoj = 0;
      if (md.isCurrent && pDaysLeft > 0) pRoj = currentMonthRemainingBurnByType[type];
      else if (md.isFuture) {
        pRoj = md[projKey];
        aCtual = 0;
      }
      const cons2 = Math.round(aCtual + pRoj);
      const ord2 = parseFloat(md[orderedKey]) || 0;
      const en2 = Math.round(lgStart - cons2 + ord2);
      pLedger[type][md.ym] = {
        start: Math.round(lgStart),
        consumed: cons2,
        actualCons: Math.round(aCtual),
        projCons: Math.round(pRoj),
        ordered: ord2,
        end: en2,
        countMonth: isCountMonth,
        countAdj,
      };
      runBal = en2;
    }
  });

  // ── Top-tile derived numbers ─────────────────────────────────────────────
  const TYPE_KEYS = ['starter', 'grower', 'layer'];
  // Actual On Hand per type — count + arrived-after-count − consumed-since-count.
  const actualOnHand = {};
  TYPE_KEYS.forEach((type) => {
    const orderKey = type === 'layer' ? 'layerfeed' : type;
    const inv = poultryFeedInventory && poultryFeedInventory[type];
    if (!inv || !inv.date) {
      actualOnHand[type] = null;
      return;
    }
    const invYM = inv.date.substring(0, 7);
    const ftKey = type === 'starter' ? 'STARTER' : type === 'grower' ? 'GROWER' : 'LAYER';
    const ordersArrivedAfterCount = Object.entries(feedOrders[orderKey] || {}).reduce((s, e) => {
      const ym = e[0];
      const v = parseFloat(e[1]) || 0;
      if (ym > invYM && ym < thisYM) return s + v;
      if (ym === invYM && !inv.includesCurrentMonthDelivery && ym < thisYM) return s + v;
      return s;
    }, 0);
    const consumedSinceCount = allDailys
      .filter((d) => d.date && d.date > inv.date && d.feed_type === ftKey)
      .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    actualOnHand[type] = Math.round(inv.count + ordersArrivedAfterCount - consumedSinceCount);
  });
  const endOfPrev = {};
  TYPE_KEYS.forEach((type) => {
    const lg = pLedger[type][prevYM];
    endOfPrev[type] = lg ? lg.end : null;
  });
  const needThruNext = {};
  TYPE_KEYS.forEach((type) => {
    const projKey = type === 'starter' ? 'starter' : type === 'grower' ? 'grower' : 'layerFeed';
    const a = monthlyData.find((m) => m.ym === activeYM);
    const n = monthlyData.find((m) => m.ym === nextYM);
    needThruNext[type] = (a ? a[projKey] : 0) + (n ? n[projKey] : 0);
  });
  // Order basis per type. A current-month physical count is ground truth for
  // "on hand now" and supersedes the previous-month ending ESTIMATE: the
  // estimate (endOfPrev) is computed before the count corrects the month, so
  // using it ignores the physical reality the operator just entered. When a
  // current-month count exists we subtract the count-aware Actual On Hand
  // (which already folds in arrived-after-count orders / consumed-since and
  // the "count includes current order" semantics, so nothing is double-counted).
  // With no current-month count we keep the previous-month estimate basis.
  const basisIsCount = {};
  const recommendedOrder = {};
  TYPE_KEYS.forEach((type) => {
    const inv = poultryFeedInventory && poultryFeedInventory[type];
    const invYM = inv && inv.date ? inv.date.substring(0, 7) : null;
    const hasCurrentCount = invYM === thisYM && actualOnHand[type] != null;
    basisIsCount[type] = hasCurrentCount;
    recommendedOrder[type] = recommendedFeedOrder({
      needThruNext: needThruNext[type],
      hasCurrentCount,
      actualOnHand: actualOnHand[type],
      endOfPrevEst: endOfPrev[type],
    });
  });
  const anyCurrentCount = TYPE_KEYS.some((type) => basisIsCount[type]);
  const allCurrentCount = TYPE_KEYS.every((type) => basisIsCount[type]);
  // Caption must reflect the REAL per-type basis. In a mixed state (only some
  // feed types counted this month) a tile-wide "vs Actual On Hand" would
  // misrepresent the still-estimated types.
  const orderBasisCaption = allCurrentCount
    ? 'vs Actual On Hand'
    : anyCurrentCount
      ? 'vs Actual On Hand where counted; otherwise End of ' + prevLabel + ' Est.'
      : 'vs End of ' + prevLabel + ' Est.';
  // Second summary tile stays pinned to the current calendar month. The order
  // workflow can advance activeYM when the calendar month flips, but this
  // summary still shows the current month-end estimate per type. Saved order
  // only -- updates on save, not while typing an unsaved draft.
  const estTileYM = thisYM;
  const endOfCurrent = {};
  TYPE_KEYS.forEach((type) => {
    const lg = pLedger[type][estTileYM];
    endOfCurrent[type] = lg ? lg.end : null;
  });
  const estTileValues = endOfCurrent;
  const estTileLabel = 'End of ' + ymShort(estTileYM) + ' Est.';

  // Top tiles render three stacked per-type rows so each feed type's
  // value scans on its own. The order matches the active card's per-type
  // row order. WI-2e: feed-type words are categories, not colors → black labels.
  const TILE_TYPE_ROWS = [
    {key: 'starter', label: 'Starter'},
    {key: 'grower', label: 'Grower'},
    {key: 'layer', label: 'Layer Feed'},
  ];
  function renderTileRows(perType, valueColorFn) {
    return TILE_TYPE_ROWS.map((row) => {
      const val = perType[row.key];
      const missing = val == null;
      return (
        <div
          key={row.key}
          data-feed-order-row={row.key}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '3px 0',
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-primary)',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            {row.label}
          </span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: missing ? 'var(--ink-faint)' : valueColorFn(val),
            }}
          >
            {missing ? '—' : val.toLocaleString() + ' lbs'}
          </span>
        </div>
      );
    });
  }

  // ── Active-card live overrides for End-of-Month while typing ────────────
  // For each feed type, splice the operator's typed draft (or the
  // recommendation-zero implicit save) into the active ledger entry so
  // the equation's End updates as they type. Top tiles (incl. the count-aware
  // Est. tile) still derive from the persisted-only ledger.
  function activeDraftEnd(type) {
    const orderKey = type === 'layer' ? 'layerfeed' : type;
    const lg = pLedger[type][activeYM];
    if (!lg) return null;
    const draftKey = orderKey;
    const draft = (activeOrderDrafts[draftKey] || '').trim();
    let val = parseFloat(draft);
    if (!Number.isFinite(val)) val = lg.ordered;
    return Math.round(lg.start - lg.consumed + val);
  }

  // ── Partial-month awareness ──────────────────────────────────────────────
  // A YM can be partially saved (e.g., starter saved but grower / layerfeed
  // missing). The active card must NOT overwrite the persisted value or
  // force the operator to retype it.
  //   • In auto-active mode (editingMonthYM == null), rows whose persisted
  //     value exists for activeYM render as plain text and pass through
  //     unchanged on save. Only the missing rows accept input.
  //   • In edit mode (operator clicked Edit on the pinned fully-saved month),
  //     all three rows become editable so the operator can change
  //     any of them. Drafts are pre-loaded with the persisted values.
  //   (isActiveEditMode is declared earlier so a pinned saved month can
  //   switch from read-only values into editable inputs.)
  function persistedValueForActive(orderKey) {
    return (feedOrders[orderKey] || {})[activeYM];
  }
  function isRowPersistedForActive(orderKey) {
    return persistedValueForActive(orderKey) != null;
  }
  // Treat persisted-for-active as locked plain text ONLY when not in edit mode.
  function rowLocksToPersisted(orderKey) {
    return !isActiveEditMode && isRowPersistedForActive(orderKey);
  }

  // ── Save handler ─────────────────────────────────────────────────────────
  function commitActiveOrder() {
    function decideFromDraft(raw, rec) {
      if (raw === '') {
        if (rec !== 0) return null;
        return 0;
      }
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    }
    function decideRow(orderKey, draftKey, rec) {
      // Persisted rows in non-edit mode pass through unchanged so we never
      // overwrite an existing saved value.
      if (rowLocksToPersisted(orderKey)) {
        return parseFloat(persistedValueForActive(orderKey)) || 0;
      }
      const raw = (activeOrderDrafts[draftKey] || '').trim();
      return decideFromDraft(raw, rec);
    }
    const sVal = decideRow('starter', 'starter', recommendedOrder.starter);
    const gVal = decideRow('grower', 'grower', recommendedOrder.grower);
    const lVal = decideRow('layerfeed', 'layerfeed', recommendedOrder.layer);
    if (sVal == null || gVal == null || lVal == null) return;
    // Single sbSave covering all three feed-type maps. Persisted rows
    // re-write their existing value verbatim so the persisted shape is
    // preserved exactly.
    const next = {
      ...feedOrders,
      starter: {...(feedOrders.starter || {}), [activeYM]: sVal},
      grower: {...(feedOrders.grower || {}), [activeYM]: gVal},
      layerfeed: {...(feedOrders.layerfeed || {}), [activeYM]: lVal},
    };
    setFeedOrders(next);
    sbSave('ppp-feed-orders-v1', next);
    setEditingMonthYM(null);
    setActiveOrderDrafts({starter: '', grower: '', layerfeed: ''});
  }
  function editMonth(ym) {
    setEditingMonthYM(ym);
    setActiveOrderDrafts({
      starter: (feedOrders.starter || {})[ym] != null ? String((feedOrders.starter || {})[ym]) : '',
      grower: (feedOrders.grower || {})[ym] != null ? String((feedOrders.grower || {})[ym]) : '',
      layerfeed: (feedOrders.layerfeed || {})[ym] != null ? String((feedOrders.layerfeed || {})[ym]) : '',
    });
  }

  // Save-button state derived from drafts + recommendations + persistence.
  const drafts = activeOrderDrafts;
  const hasDraftStarter = (drafts.starter || '').trim() !== '';
  const hasDraftGrower = (drafts.grower || '').trim() !== '';
  const hasDraftLayer = (drafts.layerfeed || '').trim() !== '';
  const anyDraftHasValue = hasDraftStarter || hasDraftGrower || hasDraftLayer;
  const anyTypePersistedForActive =
    isRowPersistedForActive('starter') || isRowPersistedForActive('grower') || isRowPersistedForActive('layerfeed');
  function rowSaveValid(type, orderKey, hasDraft) {
    // Persisted rows are auto-valid in non-edit mode (they pass through).
    if (rowLocksToPersisted(orderKey)) return true;
    if (hasDraft) return true;
    return recommendedOrder[type] === 0;
  }
  const saveEnabled =
    rowSaveValid('starter', 'starter', hasDraftStarter) &&
    rowSaveValid('grower', 'grower', hasDraftGrower) &&
    rowSaveValid('layer', 'layerfeed', hasDraftLayer);
  // "Save 0" only when committing a wholly fresh all-zero month. Any
  // persisted row in non-edit mode disqualifies the label.
  const allZeroPath =
    !anyDraftHasValue &&
    !anyTypePersistedForActive &&
    recommendedOrder.starter === 0 &&
    recommendedOrder.grower === 0 &&
    recommendedOrder.layer === 0;
  const saveButtonLabel = allZeroPath ? 'Save 0' : 'Save Order';

  // ── Count-includes-month checkbox ────────────────────────────────────────
  // Always reads from today's month — no editable date input.
  const countLbsState = useState('');
  const countLbsInput = countLbsState[0];
  const setCountLbsInput = countLbsState[1];
  const countIncludesState = useState(false);
  const countIncludesInput = countIncludesState[0];
  const setCountIncludesInput = countIncludesState[1];
  const [countNotice, setCountNotice] = useState(null);
  const countMonthShort = (() => {
    const [y, m] = todayDate.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month: 'short'});
  })();

  // Reset the count-input checkbox when the operator switches feed type so
  // the visible state matches the per-type persisted flag.
  React.useEffect(() => {
    const inv = poultryFeedInventory && poultryFeedInventory[countType];
    setCountIncludesInput(!!(inv && inv.includesCurrentMonthDelivery));
  }, [countType, poultryFeedInventory, setCountIncludesInput]);

  const tileShellS = {
    background: 'white',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
  };
  const tileLabelS = {
    fontSize: 11,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  };

  // ── Monthly card renderer ────────────────────────────────────────────────
  function renderMonthCard(ym) {
    const md = monthlyData.find((m) => m.ym === ym);
    if (!md) return null;
    const isActive = ym === activeYM;
    const isActiveSavedCard = isActive && isMonthFullySaved(ym) && !isActiveEditMode;
    // WI-5: ledger card uses a standard 1px gray border (no green 2px accent) and
    // a plain white header (no green tint). Active state is shown by the pill.
    const cardBorder = '1px solid var(--border)';
    const cardHeaderBg = 'white';

    // WI-2e: feed-type words are categories, not colors → black labels.
    const rowDefs = [
      {key: 'starter', label: 'Starter', orderKey: 'starter', draftKey: 'starter'},
      {key: 'grower', label: 'Grower', orderKey: 'grower', draftKey: 'grower'},
      {key: 'layer', label: 'Layer Feed', orderKey: 'layerfeed', draftKey: 'layerfeed'},
    ];

    return (
      <div
        key={ym}
        style={{
          background: 'white',
          border: cardBorder,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: cardHeaderBg,
          }}
        >
          <span style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>{ymLabel(ym)}</span>
          {isActive && (
            <Badge variant="ok" style={{borderRadius: 10}}>
              ACTIVE
            </Badge>
          )}
        </div>

        {/* Per-type equation rows */}
        <div style={{padding: '4px 16px 8px'}}>
          {rowDefs.map((row) => {
            const lg = pLedger[row.key][ym];
            const savedVal = (feedOrders[row.orderKey] || {})[ym];
            const isSaved = savedVal != null && savedVal !== '';
            const draft = activeOrderDrafts[row.draftKey];
            // In auto-active mode, a row whose value is already persisted
            // renders as plain text (no input) and the operator's save
            // carries it through unchanged. In edit mode (operator clicked
            // Edit on a fully-saved month) all three rows are editable.
            const rowShowsInput = isActive && (isActiveEditMode || !isSaved);
            const liveEnd = isActive && lg ? activeDraftEnd(row.key) : lg ? lg.end : null;
            return (
              <div
                key={row.key}
                data-mobile-stack-equation="1"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr 14px 1fr 14px 1fr 14px 1fr',
                  gap: 8,
                  alignItems: 'end',
                  padding: '6px 0',
                  borderTop: '1px solid var(--divider)',
                }}
              >
                <div style={{fontSize: 12, fontWeight: 700, color: 'var(--text-primary)'}}>{row.label}</div>
                <div style={{textAlign: 'right'}}>
                  <div style={{fontSize: 9, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 0.5}}>
                    Start
                  </div>
                  <div
                    style={{fontSize: 13, fontWeight: 600, color: lg && lg.start >= 0 ? 'var(--ink)' : 'var(--danger)'}}
                  >
                    {lg ? lg.start.toLocaleString() : '—'}
                  </div>
                </div>
                <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>{'−'}</div>
                <div style={{textAlign: 'right'}}>
                  <div style={{fontSize: 9, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 0.5}}>
                    Consumed
                  </div>
                  <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink)'}}>
                    {lg ? lg.consumed.toLocaleString() : '—'}
                  </div>
                </div>
                <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>{'+'}</div>
                {/* Ordered cell: label sits directly above the value/input
                    (both right-aligned) so saved values like 4,000 read as
                    being IN the Ordered column rather than floating. */}
                <div style={{textAlign: 'right'}}>
                  <div
                    style={{
                      fontSize: 9,
                      color: 'var(--ink-faint)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      marginBottom: 2,
                    }}
                  >
                    Ordered
                  </div>
                  {rowShowsInput ? (
                    <input
                      type="number"
                      min="0"
                      step="100"
                      value={draft}
                      onChange={(e) => setActiveOrderDrafts((d) => ({...d, [row.draftKey]: e.target.value}))}
                      style={{
                        width: '100%',
                        fontSize: 13,
                        padding: '4px 8px',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 10,
                        textAlign: 'right',
                        fontFamily: 'inherit',
                        fontWeight: 600,
                        boxSizing: 'border-box',
                      }}
                    />
                  ) : (
                    <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink)'}}>
                      {isSaved ? Number(savedVal).toLocaleString() : '—'}
                    </div>
                  )}
                </div>
                <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>{'='}</div>
                <div style={{textAlign: 'right'}}>
                  <div style={{fontSize: 9, color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 0.5}}>
                    End
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: liveEnd != null ? (liveEnd > 0 ? 'var(--ok-ink)' : 'var(--danger)') : 'var(--ink-faint)',
                    }}
                  >
                    {liveEnd != null ? liveEnd.toLocaleString() : '—'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active-card save row; fully saved pinned month exposes Edit. */}
        {isActiveSavedCard ? (
          <div
            style={{
              padding: '8px 16px 12px',
              display: 'flex',
              justifyContent: 'flex-end',
              borderTop: '1px solid var(--divider)',
            }}
          >
            <button
              type="button"
              onClick={() => editMonth(ym)}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
                background: 'white',
                color: 'var(--ink-muted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Edit
            </button>
          </div>
        ) : isActive ? (
          <div
            style={{
              padding: '8px 16px 12px',
              display: 'flex',
              justifyContent: 'flex-end',
              borderTop: '1px solid var(--divider)',
            }}
          >
            <button
              type="button"
              onClick={commitActiveOrder}
              disabled={!saveEnabled}
              style={{
                padding: '8px 18px',
                borderRadius: 10,
                border: 'none',
                // WI-2d: broiler primary action re-tinted to the program accent.
                background: saveEnabled ? getProgramColor('broiler') : '#9ca3af',
                color: saveEnabled ? getReadableText(getProgramColor('broiler')) : 'white',
                fontWeight: 700,
                fontSize: 13,
                cursor: saveEnabled ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {saveButtonLabel}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <Header />
      <div
        style={{
          padding: '1rem',
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        {/* 4 top tiles — three per-type rows stacked inside each tile so
            each feed type's number scans on its own. No big totals. */}
        <div data-mobile-2col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10}}>
          {/* Actual On Hand — on-hand vs short is a genuine good/bad signal. */}
          <div style={tileShellS}>
            <div style={tileLabelS}>Actual On Hand</div>
            {renderTileRows(actualOnHand, (v) => (v > 0 ? 'var(--ok-ink)' : 'var(--danger)'))}
          </div>

          {/* Est. tile — active-month end for counted types, else prev-month end */}
          <div style={tileShellS}>
            <div style={tileLabelS}>{estTileLabel}</div>
            {renderTileRows(estTileValues, (v) => (v > 0 ? 'var(--ok-ink)' : 'var(--danger)'))}
          </div>

          {/* Order for [active] — genuine warn-notice panel (rule 3): warn ink on
              soft warn bg with a standard 1px border. */}
          <div
            data-feed-order-tile="poultry-order"
            style={{...tileShellS, background: 'var(--warn-soft)', border: '1px solid var(--border)'}}
          >
            <div style={{...tileLabelS, color: 'var(--warn-ink)'}}>{'Order for ' + activeLabel}</div>
            {renderTileRows(recommendedOrder, () => 'var(--warn-ink)')}
            <div style={{fontSize: 10, color: 'var(--warn-ink)', opacity: 0.85, marginTop: 3}}>{orderBasisCaption}</div>
          </div>

          {/* Need Thru [next] */}
          <div style={tileShellS}>
            <div style={tileLabelS}>{'Need Thru ' + nextLabel}</div>
            {renderTileRows(needThruNext, () => 'var(--ink)')}
          </div>
        </div>

        {/* Physical count input — no editable date */}
        <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 20px'}}>
          <div style={{display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap'}}>
            <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', alignSelf: 'center'}}>
              {poultryFeedInventory && poultryFeedInventory[countType]
                ? 'Update Physical Count'
                : 'Enter Physical Count'}
            </div>
            <div>
              <label style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3}}>
                Feed type
              </label>
              <select
                id="poultry-feed-count-type"
                value={countType}
                onChange={(e) => setCountType(e.target.value)}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  fontFamily: 'inherit',
                }}
              >
                <option value="starter">Starter</option>
                <option value="grower">Grower</option>
                <option value="layer">Layer Feed</option>
              </select>
            </div>
            <div>
              <label style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3}}>
                Lbs on hand
              </label>
              <input
                id="poultry-feed-count-input"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 2000"
                value={countLbsInput}
                onChange={(e) => setCountLbsInput(e.target.value)}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  width: 100,
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                border: '1px solid var(--border-strong)',
                borderRadius: 10,
                background: 'var(--surface-2)',
                fontSize: 12,
                color: '#000',
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                lineHeight: 1.2,
              }}
            >
              <input
                id="poultry-feed-count-includes-delivery"
                type="checkbox"
                checked={countIncludesInput}
                onChange={(e) => setCountIncludesInput(e.target.checked)}
                style={{cursor: 'pointer', margin: 0, accentColor: '#000'}}
              />
              {'Count includes ' + countMonthShort + ' order'}
            </label>
            <button
              onClick={() => {
                if (!countLbsInput) {
                  setCountNotice({kind: 'error', message: 'Enter the lbs on hand.'});
                  return;
                }
                setCountNotice(null);
                // Physical count is "what is on site right now" — always
                // stamps today's date. No backdating from the UI.
                savePoultryFeedCount(countType, countLbsInput, todayDate, countIncludesInput);
                setCountLbsInput('');
              }}
              style={{
                padding: '7px 16px',
                borderRadius: 10,
                border: 'none',
                // WI-2d: broiler primary action re-tinted to the program accent.
                background: getProgramColor('broiler'),
                color: getReadableText(getProgramColor('broiler')),
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Save Count
            </button>
            {poultryFeedInventory && poultryFeedInventory[countType] && (
              <div style={{fontSize: 10, color: 'var(--ink-faint)', alignSelf: 'center'}}>
                {'Last: ' + fmt(poultryFeedInventory[countType].date)}
              </div>
            )}
          </div>
          {countNotice && (
            <div style={{marginTop: 10}}>
              <InlineNotice notice={countNotice} onDismiss={() => setCountNotice(null)} />
            </div>
          )}
        </div>

        {/* Monthly cards: one calendar-pinned order month */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div style={{fontSize: 14, fontWeight: 700, color: 'var(--text-primary)'}}>Monthly Poultry Feed Ledger</div>
          {renderMonthCard(activeYM)}
        </div>

        {/* Per-batch breakdown - Broiler: Active expanded, Processed collapsible, Planned collapsible */}
        {(function () {
          function renderBroilerBatchFeed(b) {
            var feed = calcBatchFeed(b);
            var schedule = feed.schedule;
            var starter = feed.starter;
            var grower = feed.grower;
            var total = feed.total;
            var C = getBatchColor(b.name);
            var bStats = calcBroilerStatsFromDailys(b, broilerDailys);
            var actStarter = bStats.starterFeed;
            var actGrower = bStats.growerFeed;
            var actTotal = actStarter + actGrower;
            return React.createElement(
              'div',
              {key: b.id, style: {borderBottom: '1px solid var(--border)'}},
              React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 16px',
                    background: 'var(--surface-2)',
                    flexWrap: 'wrap',
                  },
                },
                React.createElement('span', {
                  // WI-5: keep ONE small batch-identity swatch but drop the colored border.
                  style: {
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    borderRadius: 3 /* radius-allow: 12px legend swatch */,
                    background: C.bg,
                  },
                }),
                React.createElement(
                  'div',
                  {style: {fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', minWidth: 100}},
                  b.name,
                ),
                // WI-2b/WI-4: breed is a category, not a status badge → plain text.
                React.createElement(
                  'span',
                  {style: {fontSize: 12, fontWeight: 600, color: 'var(--text-primary)'}},
                  breedLabel(b.breed),
                ),
                React.createElement('span', {style: S.badge('#f3f4f6', '#374151')}, 'Schooner ' + b.schooner),
                React.createElement(
                  'span',
                  {style: {fontSize: 12, color: 'var(--ink-muted)'}},
                  'Hatch: ' + fmt(b.hatchDate),
                ),
                (function () {
                  var autoSt2 = calcPoultryStatus(b);
                  var endDate = autoSt2 === 'processed' ? b.processingDate : todayISO();
                  if (!b.hatchDate || !endDate) return null;
                  var days = Math.round(
                    (new Date(endDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                  );
                  var w2 = Math.floor(days / 7);
                  var d2 = days % 7;
                  return React.createElement(
                    'span',
                    {
                      style: {
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        background: 'var(--surface-2)',
                        padding: '2px 8px',
                        borderRadius: 10,
                      },
                    },
                    w2 + 'w ' + d2 + 'd' + (autoSt2 === 'processed' ? ' total' : ''),
                  );
                })(),
                parseInt(b.totalToProcessor) > 0
                  ? React.createElement(
                      'span',
                      {
                        style: {
                          fontSize: 11,
                          fontWeight: 600,
                          color: '#374151',
                          background: '#f3f4f6',
                          padding: '2px 8px',
                          borderRadius: 10,
                        },
                      },
                      parseInt(b.totalToProcessor).toLocaleString() + ' processed',
                    )
                  : null,
                React.createElement(
                  'div',
                  {style: {marginLeft: 'auto', display: 'flex', gap: 20, flexWrap: 'wrap'}},
                  [
                    // WI-2a: projected/actual feed lbs are raw metrics → black.
                    {label: 'Starter', proj: starter, act: actStarter},
                    {label: 'Grower', proj: grower, act: actGrower},
                    {label: 'Total', proj: total, act: actTotal},
                  ].map(function (col) {
                    var diff = col.act - col.proj;
                    return React.createElement(
                      'div',
                      {key: col.label, style: {textAlign: 'center'}},
                      React.createElement(
                        'div',
                        {
                          style: {
                            fontSize: 10,
                            color: 'var(--ink-faint)',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5,
                          },
                        },
                        col.label,
                      ),
                      React.createElement(
                        'div',
                        {style: {display: 'flex', gap: 6, alignItems: 'baseline', justifyContent: 'center'}},
                        React.createElement(
                          'span',
                          {style: {fontSize: 13, fontWeight: 700, color: 'var(--text-primary)'}},
                          col.proj.toLocaleString(),
                        ),
                        React.createElement('span', {style: {fontSize: 10, color: 'var(--ink-faint)'}}, '/'),
                        React.createElement(
                          'span',
                          {
                            style: {
                              fontSize: 13,
                              fontWeight: 700,
                              color: col.act > 0 ? 'var(--ink)' : 'var(--ink-faint)',
                            },
                          },
                          col.act > 0 ? col.act.toLocaleString() : '—',
                        ),
                      ),
                      // The (+/-) delta vs projection is a genuine good/bad signal.
                      col.act > 0 &&
                        React.createElement(
                          'div',
                          {style: {fontSize: 10, fontWeight: 600, color: diff > 0 ? 'var(--danger)' : 'var(--ok-ink)'}},
                          (diff > 0 ? '+' : '') + diff.toLocaleString(),
                        ),
                    );
                  }),
                ),
              ),
              React.createElement(
                'div',
                {style: {overflowX: 'auto'}},
                React.createElement(
                  'table',
                  {style: {width: '100%', borderCollapse: 'collapse', fontSize: 11}},
                  React.createElement(
                    'thead',
                    null,
                    React.createElement(
                      'tr',
                      {style: {background: 'var(--surface-2)'}},
                      React.createElement(
                        'th',
                        {
                          style: {
                            padding: '5px 12px',
                            textAlign: 'left',
                            fontWeight: 600,
                            color: 'var(--ink-muted)',
                            whiteSpace: 'nowrap',
                          },
                        },
                        'Week',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '5px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-muted)'}},
                        'Phase',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '5px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-muted)'}},
                        'Location',
                      ),
                      React.createElement(
                        'th',
                        {
                          style: {
                            padding: '5px 12px',
                            textAlign: 'right',
                            fontWeight: 600,
                            color: 'var(--ink-muted)',
                            whiteSpace: 'nowrap',
                          },
                        },
                        'Lbs/Bird',
                      ),
                      React.createElement(
                        'th',
                        {
                          style: {
                            padding: '5px 12px',
                            textAlign: 'right',
                            fontWeight: 600,
                            color: 'var(--ink-muted)',
                            whiteSpace: 'nowrap',
                          },
                        },
                        'Total Lbs',
                      ),
                    ),
                  ),
                  React.createElement(
                    'tbody',
                    null,
                    schedule.map(function (w, i) {
                      return React.createElement(
                        'tr',
                        {
                          key: i,
                          // WI-2c/WI-5: drop the blue/green phase-tinted row backgrounds.
                          style: {
                            borderTop: '1px solid var(--border)',
                            background: 'var(--bg-card)',
                          },
                        },
                        React.createElement('td', {style: {padding: '5px 12px', fontWeight: 500}}, 'Week ' + w.week),
                        // WI-2e/WI-4: feed phase is a category, not a status chip → plain black text.
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px', color: 'var(--text-primary)', fontWeight: 600, fontSize: 10}},
                          w.phase === 'starter' ? 'Starter' : 'Grower',
                        ),
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px', color: 'var(--ink-muted)'}},
                          i < 2 ? 'Brooder ' + b.brooder : 'Schooner ' + b.schooner,
                        ),
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px', textAlign: 'right'}},
                          w.lbsPerBird.toFixed(2),
                        ),
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px', textAlign: 'right', fontWeight: 500}},
                          w.totalLbs.toLocaleString(),
                        ),
                      );
                    }),
                    React.createElement(
                      'tr',
                      {style: {borderTop: '1px solid var(--border)', background: 'var(--surface-2)', fontWeight: 600}},
                      React.createElement(
                        'td',
                        {colSpan: 4, style: {padding: '6px 12px', textAlign: 'right', color: 'var(--ink-muted)'}},
                        'Total',
                      ),
                      React.createElement(
                        'td',
                        {style: {padding: '6px 12px', textAlign: 'right'}},
                        total.toLocaleString() + ' lbs',
                      ),
                    ),
                  ),
                ),
              ),
            );
          }
          var activeBrFeed = activeBroilers.filter(function (b) {
            return calcPoultryStatus(b) === 'active';
          });
          var plannedBrFeed = activeBroilers.filter(function (b) {
            return calcPoultryStatus(b) === 'planned';
          });
          var processedBrFeed = batches
            .filter(function (b) {
              return calcPoultryStatus(b) === 'processed' && b.hatchDate;
            })
            .sort(function (a, b) {
              return (b.processingDate || b.hatchDate || '').localeCompare(a.processingDate || a.hatchDate || '');
            });
          var secT = collapsedBatches;
          function togBr(key) {
            setCollapsedBatches(function (s) {
              var n = new Set(s);
              n.has(key) ? n.delete(key) : n.add(key);
              return n;
            });
          }
          return React.createElement(
            'div',
            {style: {...S.card}},
            React.createElement(
              'div',
              {style: {padding: '12px 16px', borderBottom: '1px solid var(--border)'}},
              React.createElement(
                'div',
                {style: {fontWeight: 600, fontSize: 14, color: 'var(--text-primary)'}},
                '🐔 Broiler Feed Estimate Per Batch',
              ),
            ),
            // Active — always expanded
            activeBrFeed.length > 0 &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    style: {
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      background: 'var(--surface-2)',
                      borderBottom: '1px solid var(--border)',
                    },
                  },
                  'ACTIVE (' + activeBrFeed.length + ')',
                ),
                activeBrFeed.map(renderBroilerBatchFeed),
              ),
            activeBrFeed.length === 0 &&
              React.createElement(
                'div',
                {style: {padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}},
                'No active broiler batches',
              ),
            // Processed — collapsible, newest first
            processedBrFeed.length > 0 &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    ...openableProps(function () {
                      togBr('proc');
                    }),
                    className: 'hoverable-tile',
                    style: {
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      background: 'var(--surface-2)',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: 'var(--ink-faint)'}},
                    secT.has('proc') ? '▼' : '▶',
                  ),
                  'PROCESSED (' + processedBrFeed.length + ')',
                ),
                secT.has('proc') && processedBrFeed.map(renderBroilerBatchFeed),
              ),
            // Planned — collapsible
            plannedBrFeed.length > 0 &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    ...openableProps(function () {
                      togBr('planned');
                    }),
                    className: 'hoverable-tile',
                    style: {
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      background: 'var(--surface-2)',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: 'var(--ink-faint)'}},
                    secT.has('planned') ? '▼' : '▶',
                  ),
                  'PLANNED (' + plannedBrFeed.length + ')',
                ),
                secT.has('planned') && plannedBrFeed.map(renderBroilerBatchFeed),
              ),
          );
        })()}

        {/* Per-batch breakdown - Layer COLLAPSIBLE */}
        <div style={{...S.card}}>
          <div
            className="hoverable-tile"
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
            {...openableProps(() =>
              setCollapsedBatches((s) => {
                const n = new Set(s);
                n.has('layers') ? n.delete('layers') : n.add('layers');
                return n;
              }),
            )}
          >
            <div style={{fontWeight: 600, fontSize: 14, color: 'var(--text-primary)'}}>
              {'🐓 Layer Feed Estimate Per Batch'}
            </div>
            <span style={{fontSize: 12, color: 'var(--ink-faint)'}}>
              {collapsedBatches.has('layers') ? '▶ expand' : '▼ collapse'}
            </span>
          </div>
          {!collapsedBatches.has('layers') && (
            <>
              {activeLayerBatchesForFeed.length === 0 && (
                <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
                  No active layer batches
                </div>
              )}
              {activeLayerBatchesForFeed.map(function (b) {
                var startDate = b.brooder_entry_date || b.arrival_date;
                var birdCount = parseInt(b.original_count) || 0;
                var batchHousings = activeHousings.filter(function (h) {
                  return h.batch_id === b.id;
                });
                var hens = 0;
                batchHousings.forEach(function (h) {
                  var proj = computeProjectedCount(h, allLayerDailys || [], layerHousings);
                  hens += proj ? proj.projected : parseInt(h.current_count) || 0;
                });
                if (hens === 0) hens = birdCount;
                var totalStarter = 0,
                  totalGrover = 0,
                  totalLayer = 0;
                LAYER_FEED_SCHEDULE.forEach(function (w) {
                  if (w.phase === 'starter') totalStarter += w.lbsPerBird * birdCount;
                  else totalGrover += w.lbsPerBird * birdCount;
                });
                // Cap starter at 1500
                if (totalStarter > 1500) totalStarter = 1500;
                // Layer feed: estimate 365 days/year at 0.25/bird/day
                totalLayer = hens * LAYER_FEED_PER_DAY * 365;
                var ageMs = startDate ? new Date() - new Date(startDate + 'T12:00:00') : 0;
                var ageWeeks = ageMs > 0 ? Math.floor(ageMs / 86400000 / 7) : 0;
                var phase = ageWeeks < 6 ? 'Starter' : ageWeeks < 20 ? 'Grower' : 'Layer Feed';
                return (
                  <div key={b.id} style={{borderBottom: '1px solid var(--border)'}}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 16px',
                        background: 'var(--surface-2)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontSize: 14}}>{'🐓'}</span>
                      <div style={{fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', minWidth: 100}}>
                        {b.name}
                      </div>
                      {/* Feed phase is a category, not a status badge → plain text (WI-2e/WI-4). */}
                      <span style={{fontSize: 12, fontWeight: 600, color: 'var(--text-primary)'}}>{phase}</span>
                      {startDate && (
                        <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Started: {fmt(startDate)}</span>
                      )}
                      <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                        {birdCount > 0 ? birdCount + ' birds' : 'no bird count'}
                      </span>
                      {hens !== birdCount && (
                        <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>{'→ ' + hens + ' projected hens'}</span>
                      )}
                      <div style={{marginLeft: 'auto', display: 'flex', gap: 16, flexWrap: 'wrap'}}>
                        <div style={{textAlign: 'center'}}>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--ink-faint)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            Starter
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: 'var(--text-primary)'}}>
                            {Math.round(totalStarter).toLocaleString()} lbs
                          </div>
                        </div>
                        <div style={{textAlign: 'center'}}>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--ink-faint)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            Grower
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: 'var(--text-primary)'}}>
                            {Math.round(totalGrover).toLocaleString()} lbs
                          </div>
                        </div>
                        <div style={{textAlign: 'center'}}>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--ink-faint)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            }}
                          >
                            Layer / Year
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: 'var(--text-primary)'}}>
                            {Math.round(totalLayer).toLocaleString()} lbs
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
