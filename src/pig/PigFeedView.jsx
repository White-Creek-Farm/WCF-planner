// ============================================================================
// src/pig/PigFeedView.jsx
// ----------------------------------------------------------------------------
// Minimal pig feed ledger. Answers two questions:
//   1. How much feed do I have right now?
//   2. How much do I need to order for the current calendar order month?
//
// Layout:
//   • Four top tiles: Actual On Hand · End of [current] Est. · Order for
//     [active] · Need Thru [active+1].
//   • Physical-count input directly below, with a "Count includes [month]
//     order" checkbox derived from the count date's month.
//   • Exactly one monthly order card: current calendar month. Saved history
//     stays out of this order-entry surface.
//   • Each monthly card reads as an equation: Start − Consumed + Ordered
//     = End.
//   • Feed Rate Reference at the bottom.
//
// Math contracts:
//   • Daily projected pig burn comes from feedPlanner.pigDailyBurnLbs so
//     feeder counts are ledger-correct (transfers + mortality subtracted
//     via pigFeederSubCurrentCount).
//   • Per-group breakdown uses pigFeederSubCurrentCount and
//     pigFeederLbsPerDayAtAge directly so the table matches reality.
//   • Recommended Order for [active] = max(0, Need Thru [active+1] − End
//     of [prev] Est.). No carryover subtext, no hidden formula.
//   • Top tiles do NOT track the active draft — they update only on Save
//     Order. The active card's End-of-Month estimate updates live while
//     typing for that card only.
//   • Physical count is ground truth. Actual On Hand = latest count +
//     orders that actually arrived after the count − feed consumed after
//     the count. The "Count includes [month] order" checkbox avoids
//     double-count when the count was taken after that month's delivery.
//
// Active-month workflow:
//   • activeOrderYM is pinned to the current calendar month. Saving does not
//     advance it; the calendar month flip does.
//   • editingMonthYM lets the operator edit the pinned saved month. Edit
//     pre-loads the draft locally; the persisted value is unchanged until
//     Save Order writes again.
//
// Helpers from src/lib/feedPlanner.js are intentionally retained as the
// load-bearing source of pig burn + ledger-derived counts; the visual
// layer is simple but the count source is correct.
// ============================================================================
import React from 'react';
import {fmt, todayISO} from '../lib/dateUtils.js';
import {calcBreedingTimeline, pigTransfersForBatch, pigMortalityForBatch} from '../lib/pig.js';
import {getReadableText} from '../lib/styles.js';
import {getProgramColor} from '../lib/programColors.js';
import {pigDailyBurnLbs, pigFeederSubCurrentCount, pigFeederLbsPerDayAtAge} from '../lib/feedPlanner.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import {calendarOrderYM, recommendedFeedOrder} from '../lib/feedOrderBasis.js';

export default function PigFeedView({
  Header,
  loadUsers,
  feedOrders,
  setFeedOrders,
  pigFeedInventory,
  setPigFeedInventory,
  sbSave,
}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {breeders, feederGroups, farrowingRecs, breedingCycles} = usePig();
  const {pigDailys} = useDailysRecent();
  const {feedCosts} = useFeedCosts();
  const {setView} = useUI();

  // Operator draft for the active editable month + optional "edit the pinned
  // saved month" rewind. The persisted feedOrders map is
  // not touched until Save Order runs.
  const [editingMonthYM, setEditingMonthYM] = React.useState(null);
  const [activeOrderDraft, setActiveOrderDraft] = React.useState('');

  // ── Date utilities ────────────────────────────────────────────────────────
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

  // ── Ledger-correct daily burn via feedPlanner ─────────────────────────────
  function projectedDailyFeed(dateISO) {
    return pigDailyBurnLbs(dateISO, {feederGroups, breedingCycles, breeders, farrowingRecs});
  }

  // ── Calendar window ───────────────────────────────────────────────────────
  // Wider than the visible range so the running ledger has plenty of
  // anchor room behind today + the active month.
  const now = new Date();
  const months = [];
  for (let i = -12; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const thisYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const todayDate = todayISO();

  const monthlyData = months.map((ym) => {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const midDate = ym + '-15';
    const proj = projectedDailyFeed(midDate);
    const projTotal = proj.totalLbs * daysInMonth;
    const actual = pigDailys
      .filter((d) => d.date && d.date.startsWith(ym))
      .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    const orderedRaw = (feedOrders.pig || {})[ym];
    const ordered = orderedRaw != null ? orderedRaw : null;
    const isFuture = ym > thisYM;
    const isCurrent = ym === thisYM;
    return {
      ym,
      daysInMonth,
      proj,
      projTotal: Math.round(projTotal),
      actual: Math.round(actual),
      ordered,
      isFuture,
      isCurrent,
    };
  });

  const curProj = projectedDailyFeed(todayDate);

  // ── Active-month resolution ──────────────────────────────────────────────
  const autoActiveYM = calendarOrderYM(now);
  const activeYM = editingMonthYM != null ? editingMonthYM : autoActiveYM;
  const isActiveEditMode = editingMonthYM != null;
  const prevYM = addMonthsYM(activeYM, -1);
  const nextYM = addMonthsYM(activeYM, 1);
  const prevLabel = ymShort(prevYM);
  const activeLabel = ymShort(activeYM);
  const nextLabel = ymShort(nextYM);

  // ── Persistence wrappers ─────────────────────────────────────────────────
  function savePigOrder(ym, val) {
    // Empty string = clear. Any number (including 0) = save as decision made.
    const pigOrders = {...(feedOrders.pig || {})};
    if (val === '' || val == null) {
      delete pigOrders[ym];
    } else {
      pigOrders[ym] = parseFloat(val) || 0;
    }
    const next = {...feedOrders, pig: pigOrders};
    setFeedOrders(next);
    sbSave('ppp-feed-orders-v1', next);
  }
  function savePigFeedCount(count, date, includesCurrentMonthDelivery) {
    // includesCurrentMonthDelivery is the operator's "count was taken
    // after this month's order had arrived" toggle. Stored so the ledger
    // doesn't double-count that order. Helpers below also tolerate old
    // persisted rows that already carry the flag.
    const inv = {
      count: parseFloat(count) || 0,
      date: date || todayDate,
      includesCurrentMonthDelivery: !!includesCurrentMonthDelivery,
    };
    setPigFeedInventory(inv);
    sbSave('ppp-pig-feed-inventory-v1', inv);
  }

  function commitActiveOrder() {
    const raw = (activeOrderDraft || '').trim();
    // Two valid commit paths:
    //   1. Operator typed a value — save the typed number (including 0).
    //   2. Operator left the input blank AND the recommendation is exactly
    //      0 — explicit "Save 0" path so the current month is marked
    //      decided without forcing the operator to type "0".
    let valueToSave;
    if (raw === '') {
      if (recommendedOrder !== 0) return;
      valueToSave = 0;
    } else {
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n < 0) return;
      valueToSave = n;
    }
    savePigOrder(activeYM, String(valueToSave));
    setEditingMonthYM(null);
    setActiveOrderDraft('');
  }
  function editMonth(ym) {
    setEditingMonthYM(ym);
    const cur = (feedOrders.pig || {})[ym];
    setActiveOrderDraft(cur != null ? String(cur) : '');
  }

  // ── Running ledger ───────────────────────────────────────────────────────
  // Start − Consumed + Ordered = End, anchored either by the physical count
  // (if present) or the first saved order month.
  const inv = pigFeedInventory;
  const pigOrderMonths = Object.keys(feedOrders.pig || {})
    .filter((k) => (parseFloat((feedOrders.pig || {})[k]) || 0) > 0)
    .sort();
  const firstPigOrderYM = pigOrderMonths.length > 0 ? pigOrderMonths[0] : '9999-99';
  const invYMConst = inv && inv.date ? inv.date.substring(0, 7) : null;

  const pigLedger = {};
  let runBal = 0;
  const allMonthsSorted = monthlyData.slice().sort((a, b) => a.ym.localeCompare(b.ym));
  let countApplied = false;
  for (let i = 0; i < allMonthsSorted.length; i++) {
    const md = allMonthsSorted[i];
    // Pre-anchor: no count, no orders yet for this month → leave null.
    if (md.ym < firstPigOrderYM && (!invYMConst || md.ym < invYMConst)) {
      pigLedger[md.ym] = null;
      continue;
    }
    let lgStart = runBal;
    let lgCountMonth = false;
    let lgCountAdj = null;
    if (inv && !countApplied && invYMConst) {
      if (invYMConst === md.ym) {
        const thisMonthOrderForAdj = parseFloat(md.ordered) || 0;
        const systemEstThisMonth = runBal + (inv.includesCurrentMonthDelivery ? thisMonthOrderForAdj : 0);
        lgCountAdj = Math.round(inv.count - systemEstThisMonth);
        lgStart = inv.count;
        lgCountMonth = true;
        countApplied = true;
        const cAfter = pigDailys
          .filter((d) => d.date && d.date > inv.date && d.date.startsWith(md.ym))
          .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
        let pRem = 0;
        if (md.isCurrent) {
          const dl = md.daysInMonth - now.getDate();
          if (dl > 0) pRem = Math.round(curProj.totalLbs * dl);
        }
        const lgCons = Math.round(cAfter + pRem);
        const lgOrd = inv.includesCurrentMonthDelivery ? 0 : parseFloat(md.ordered) || 0;
        const lgEnd = Math.round(lgStart - lgCons + lgOrd);
        pigLedger[md.ym] = {
          start: lgStart,
          consumed: lgCons,
          actualCons: Math.round(cAfter),
          projCons: Math.round(pRem),
          ordered: lgOrd,
          rawOrdered: parseFloat(md.ordered) || 0,
          end: lgEnd,
          countMonth: true,
          countAdj: lgCountAdj,
        };
        runBal = lgEnd;
        continue;
      } else if (invYMConst < md.ym) {
        lgStart = inv.count;
        countApplied = true;
      }
    }
    let lgActual = md.actual;
    let lgProj = 0;
    if (md.isCurrent) {
      const dl = md.daysInMonth - now.getDate();
      if (dl > 0) lgProj = Math.round(curProj.totalLbs * dl);
    } else if (md.isFuture) {
      lgProj = md.projTotal;
      lgActual = 0;
    }
    const lgCons2 = Math.round(lgActual + lgProj);
    const lgOrd2 = parseFloat(md.ordered) || 0;
    const lgEnd2 = Math.round(lgStart - lgCons2 + lgOrd2);
    pigLedger[md.ym] = {
      start: Math.round(lgStart),
      consumed: lgCons2,
      actualCons: Math.round(lgActual),
      projCons: Math.round(lgProj),
      ordered: lgOrd2,
      end: lgEnd2,
      countMonth: lgCountMonth,
      countAdj: lgCountAdj,
    };
    runBal = lgEnd2;
  }

  // ── Actual On Hand (top tile) ────────────────────────────────────────────
  // Only orders that actually arrived after the count, with the count-
  // month order excluded if the operator's checkbox says it was already
  // absorbed into the count.
  let feedOnHand = null;
  let physCountAdjustment = null;
  if (inv && invYMConst) {
    const ordersArrivedAfterCount = Object.entries(feedOrders.pig || {}).reduce((s, e) => {
      const ym = e[0];
      const v = parseFloat(e[1]) || 0;
      if (ym > invYMConst && ym < thisYM) return s + v;
      if (ym === invYMConst && !inv.includesCurrentMonthDelivery && ym < thisYM) return s + v;
      return s;
    }, 0);
    const consumedSinceCount = pigDailys
      .filter((d) => d.date && d.date > inv.date)
      .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    feedOnHand = Math.round(inv.count + ordersArrivedAfterCount - consumedSinceCount);
    const adjOrdersAtCount = Object.entries(feedOrders.pig || {}).reduce((s, e) => {
      const ym = e[0];
      const v = parseFloat(e[1]) || 0;
      if (ym < firstPigOrderYM) return s;
      if (ym < invYMConst) return s + v;
      if (ym === invYMConst && inv.includesCurrentMonthDelivery) return s + v;
      return s;
    }, 0);
    const systemEstAtCount = Math.round(
      adjOrdersAtCount -
        pigDailys
          .filter((d) => d.date && d.date.substring(0, 7) >= firstPigOrderYM && d.date <= inv.date)
          .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
    );
    physCountAdjustment = Math.round(inv.count - systemEstAtCount);
  } else if (firstPigOrderYM !== '9999-99') {
    const ordersArrived = Object.entries(feedOrders.pig || {}).reduce((s, e) => {
      return e[0] < thisYM && e[0] >= firstPigOrderYM ? s + (parseFloat(e[1]) || 0) : s;
    }, 0);
    const totalPigConsumed = pigDailys
      .filter((d) => d.date && d.date.substring(0, 7) >= firstPigOrderYM)
      .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
    feedOnHand = Math.round(ordersArrived - totalPigConsumed);
  }

  // ── Top-tile derived numbers ─────────────────────────────────────────────
  const endOfPrevLg = pigLedger[prevYM];
  const endOfPrevEst = endOfPrevLg ? endOfPrevLg.end : null;
  const activeMd = monthlyData.find((m) => m.ym === activeYM);
  const nextMd = monthlyData.find((m) => m.ym === nextYM);
  const needThruNext = (activeMd ? activeMd.projTotal : 0) + (nextMd ? nextMd.projTotal : 0);
  // A current-month physical count is ground truth for "on hand now" and
  // supersedes the previous-month ending estimate as the order basis (the
  // estimate is computed before the count corrects the month). Actual On Hand
  // already folds in arrived-after-count orders / consumed-since and the
  // "count includes current order" checkbox, so nothing is double-counted.
  const hasCurrentCount = invYMConst === thisYM && feedOnHand != null;
  const recommendedOrder = recommendedFeedOrder({
    needThruNext,
    hasCurrentCount,
    actualOnHand: feedOnHand,
    endOfPrevEst,
  });
  const activeSavedOrder = (feedOrders.pig || {})[activeYM];
  const activeHasSavedOrder = activeSavedOrder != null && activeSavedOrder !== '';
  const orderTileValue =
    activeHasSavedOrder && !isActiveEditMode ? parseFloat(activeSavedOrder) || 0 : recommendedOrder;
  const orderTileCaption =
    activeHasSavedOrder && !isActiveEditMode
      ? 'Saved order'
      : hasCurrentCount
        ? 'vs Actual On Hand'
        : 'vs End of ' + prevLabel + ' Est.';
  // Live End-of-Month estimate for the active card only, splicing the
  // typed draft into the ledger's saved value.
  const activeLg = pigLedger[activeYM];
  const activeDraftN = parseFloat(activeOrderDraft);
  const activeCardLg =
    activeLg && Number.isFinite(activeDraftN) && activeDraftN >= 0
      ? {
          ...activeLg,
          ordered: Math.round(activeDraftN),
          end: Math.round(activeLg.start - activeLg.consumed + activeDraftN),
        }
      : activeLg;

  // Second tile stays pinned to the current calendar month. The order card
  // uses the same current-month pin, while this summary keeps showing the
  // current month-end estimate. Saved order only -- updates on save, not while
  // typing an unsaved draft.
  const estTileYM = thisYM;
  const estTileLg = pigLedger[estTileYM];
  const estTileValue = estTileLg ? estTileLg.end : null;
  const estTileLabel = 'End of ' + ymShort(estTileYM) + ' Est.';

  // ── Per-group breakdown via feedPlanner helpers ──────────────────────────
  function projectedFeedByGroup(ym) {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const midDate = ym + '-15';
    const proj = projectedDailyFeed(midDate);
    const groups = [
      {label: 'SOWS', projected: Math.round((proj.sowLbs || 0) * daysInMonth)},
      {label: 'BOARS', projected: Math.round((proj.boarLbs || 0) * daysInMonth)},
    ];
    if ((proj.farrowingPiglets || 0) > 0) {
      groups.push({label: 'NURSING PIGLETS', projected: Math.round((proj.farrowingPigletLbs || 0) * daysInMonth)});
    }
    feederGroups
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const cycle = breedingCycles.find((c) => c.id === g.cycleId);
        const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
        const birthDate = tl ? tl.farrowingStart : g.startDate || null;
        if (!birthDate) return;
        const ageDays = Math.floor((new Date(midDate + 'T12:00:00') - new Date(birthDate + 'T12:00:00')) / 86400000);
        if (ageDays < 0) return;
        const ratePerPig = pigFeederLbsPerDayAtAge(ageDays);
        const subs = Array.isArray(g.subBatches) ? g.subBatches : [];
        let pigCount = 0;
        if (subs.length === 0) {
          // Legacy parent-only batch: mirror pigDailyBurnLbs' parent path
          // exactly (started − trips − transfers − mortality) so the visible
          // group row matches the top-tile burn.
          const giltCount = parseInt(g.giltCount) || parseInt(g.originalPigCount) || 0;
          const boarCount = parseInt(g.boarCount) || 0;
          const started = giltCount + boarCount;
          const tripPigs = (g.processingTrips || []).reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
          const transfers = pigTransfersForBatch(breeders, g.batchName);
          const mortality = pigMortalityForBatch(g);
          pigCount = Math.max(0, started - tripPigs - transfers.count - mortality);
        } else {
          subs
            .filter((s2) => s2.status !== 'processed')
            .forEach((sub) => {
              pigCount += pigFeederSubCurrentCount(g, sub, breeders);
            });
        }
        const feed = pigCount * ratePerPig * daysInMonth;
        const activeSubs = (g.subBatches || []).filter((s2) => s2.status === 'active');
        const label = activeSubs.length > 0 ? activeSubs.map((s2) => s2.name).join(', ') : g.batchName;
        groups.push({
          label,
          projected: Math.round(feed),
          batchName: g.batchName,
          subNames: activeSubs.map((s2) => (s2.name || '').toLowerCase().trim()),
          mainName: (g.batchName || '').toLowerCase().trim(),
        });
      });
    return groups;
  }

  function actualFeedByGroup(ym) {
    const monthDailys = pigDailys.filter((d) => d.date && d.date.startsWith(ym));
    const byLabel = {};
    monthDailys.forEach((d) => {
      const lbl = d.batch_label || 'Unknown';
      byLabel[lbl] = (byLabel[lbl] || 0) + (parseFloat(d.feed_lbs) || 0);
    });
    return byLabel;
  }

  // ── Visible monthly cards ────────────────────────────────────────────────
  // One visible order card only. Saving the pinned month never advances this
  // section; it moves when the calendar month moves.

  // ── Count-includes-current-month checkbox ────────────────────────────────
  // Physical count is "what is on site now," not a backdated bookkeeping
  // tool — the save handler always uses today's date. The checkbox label
  // therefore reads from today's month, not from an editable date input.
  const [countLbsInput, setCountLbsInput] = React.useState(inv && inv.count != null ? String(inv.count) : '');
  const [countIncludesInput, setCountIncludesInput] = React.useState(!!(inv && inv.includesCurrentMonthDelivery));
  const [countNotice, setCountNotice] = React.useState(null);
  const countMonthShort = (() => {
    const [y, m] = todayDate.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month: 'short'});
  })();

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

  return (
    <div>
      <Header />
      <div
        style={{
          padding: '1rem',
          maxWidth: 1100,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        {/* 4 top tiles */}
        <div data-mobile-2col="1" style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10}}>
          {/* Actual On Hand */}
          <div style={tileShellS}>
            <div style={tileLabelS}>Actual On Hand</div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: feedOnHand != null ? (feedOnHand > 0 ? 'var(--text-primary)' : 'var(--danger)') : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {feedOnHand != null ? feedOnHand.toLocaleString() + ' lbs' : '—'}
            </div>
            {inv && (
              <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 6}}>{'Count: ' + fmt(inv.date)}</div>
            )}
            {inv && physCountAdjustment != null && physCountAdjustment !== 0 && (
              <div
                style={{
                  fontSize: 10,
                  color: physCountAdjustment > 0 ? 'var(--ok-ink)' : 'var(--danger)',
                  marginTop: 2,
                }}
              >
                {'Adj ' + (physCountAdjustment > 0 ? '+' : '') + physCountAdjustment.toLocaleString() + ' vs system'}
              </div>
            )}
          </div>

          {/* Est. tile — active-month end after a current-month count, else prev-month end */}
          <div style={tileShellS}>
            <div style={tileLabelS}>{estTileLabel}</div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: estTileValue != null ? (estTileValue > 0 ? 'var(--text-primary)' : 'var(--danger)') : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {estTileValue != null ? estTileValue.toLocaleString() + ' lbs' : '—'}
            </div>
          </div>

          {/* Order for [active] — amber treatment regardless of value so the
              tile keeps its visual weight even when recommendation is 0 lbs. */}
          <div
            data-feed-order-tile="pig-order"
            style={{
              ...tileShellS,
              background: 'var(--warn-soft)',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{...tileLabelS, color: 'var(--warn-ink)'}}>{'Order for ' + activeLabel}</div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: orderTileValue != null ? 'var(--warn-ink)' : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {orderTileValue != null ? orderTileValue.toLocaleString() + ' lbs' : '—'}
            </div>
            <div style={{fontSize: 10, color: 'var(--warn-ink)', opacity: 0.85, marginTop: 3}}>{orderTileCaption}</div>
          </div>

          {/* Need Thru [next] */}
          <div style={tileShellS}>
            <div style={tileLabelS}>{'Need Thru ' + nextLabel}</div>
            <div style={{fontSize: 28, fontWeight: 700, color: 'var(--ink)', lineHeight: 1}}>
              {needThruNext.toLocaleString() + ' lbs'}
            </div>
            <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 6}}>
              {(activeMd ? activeMd.projTotal.toLocaleString() : '0') +
                ' (' +
                activeLabel +
                ') + ' +
                (nextMd ? nextMd.projTotal.toLocaleString() : '0') +
                ' (' +
                nextLabel +
                ')'}
            </div>
          </div>
        </div>

        {/* Physical count input */}
        <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 20px'}}>
          <div style={{display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap'}}>
            <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', alignSelf: 'center'}}>
              {inv ? 'Update Physical Count' : 'Enter Physical Count'}
            </div>
            <div>
              <label style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3}}>
                Lbs on hand
              </label>
              <input
                id="pig-feed-count-input"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 5000"
                value={countLbsInput}
                onChange={(e) => setCountLbsInput(e.target.value)}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  width: 120,
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
                id="pig-feed-count-includes-delivery"
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
                // stamps today's date. No backdated bookkeeping.
                savePigFeedCount(countLbsInput, todayDate, countIncludesInput);
              }}
              style={{
                padding: '7px 16px',
                borderRadius: 10,
                border: 'none',
                background: getProgramColor('pig'),
                color: getReadableText(getProgramColor('pig')),
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Save Count
            </button>
            {inv && (
              <div style={{fontSize: 10, color: 'var(--ink-faint)', alignSelf: 'center'}}>Last: {fmt(inv.date)}</div>
            )}
          </div>
          {countNotice && (
            <div style={{marginTop: 10}}>
              <InlineNotice notice={countNotice} onDismiss={() => setCountNotice(null)} />
            </div>
          )}
        </div>

        {/* Monthly cards: active first, then last saved, then older behind a collapse */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div style={{fontSize: 14, fontWeight: 700, color: 'var(--text-primary)'}}>Monthly Pig Feed Ledger</div>
          {(() => {
            function renderCard(ym) {
              const md = monthlyData.find((m) => m.ym === ym);
              if (!md) return null;
              const isActive = ym === activeYM;
              const lg = isActive ? activeCardLg : pigLedger[ym];
              const savedVal = (feedOrders.pig || {})[ym];
              const isSaved = savedVal != null && savedVal !== '';
              const projGroups = projectedFeedByGroup(ym);
              const actualGroups = actualFeedByGroup(ym);
              const isActiveSavedCard = isActive && isSaved && !isActiveEditMode;
              const cardBorder = '1px solid var(--border)';
              const cardHeaderBg = 'white';
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
                    {isActive && <Badge variant="ok">ACTIVE</Badge>}
                  </div>

                  {/* Equation row: Start − Consumed + Ordered = End.
                      data-mobile-stack-equation flips the 7-col grid into a
                      vertical flex stack at narrow widths so each value
                      reads on its own line — the prior compressed grid
                      was unreadable at 390px even with horizontal scroll. */}
                  <div
                    data-mobile-stack-equation="1"
                    style={{
                      padding: '8px 16px 6px',
                      display: 'grid',
                      gridTemplateColumns: '1fr 14px 1.2fr 14px 1.4fr 14px 1fr',
                      gap: 8,
                      alignItems: 'end',
                    }}
                  >
                    {/* Start */}
                    <div>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 2,
                        }}
                      >
                        Start of Month
                      </div>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: lg && lg.start >= 0 ? 'var(--text-primary)' : 'var(--danger)',
                        }}
                      >
                        {lg ? lg.start.toLocaleString() : '—'}
                      </div>
                    </div>
                    <div style={{fontSize: 18, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>
                      {'−'}
                    </div>
                    {/* Consumed */}
                    <div>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 2,
                        }}
                      >
                        Consumed
                      </div>
                      <div style={{fontSize: 16, fontWeight: 600, color: 'var(--ink)'}}>
                        {lg ? lg.consumed.toLocaleString() : '—'}
                      </div>
                      {lg && md.isCurrent && lg.projCons > 0 && (
                        <div style={{fontSize: 10, color: 'var(--ink-faint)', marginTop: 1}}>
                          {lg.actualCons.toLocaleString() + ' actual + ' + lg.projCons.toLocaleString() + ' proj'}
                        </div>
                      )}
                      {lg && md.isFuture && (
                        <div style={{fontSize: 10, color: 'var(--ink-faint)', marginTop: 1}}>projected</div>
                      )}
                    </div>
                    <div style={{fontSize: 18, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>
                      {'+'}
                    </div>
                    {/* Ordered */}
                    <div>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 2,
                        }}
                      >
                        Ordered
                      </div>
                      {isActive && (!isSaved || isActiveEditMode) ? (
                        (() => {
                          // Button rules:
                          //   • Draft has a number → "Save Order" enabled, saves the typed value.
                          //   • Draft blank AND recommendation === 0 → "Save 0" enabled, saves 0.
                          //   • Otherwise disabled (operator must type a number).
                          const draftHasValue = (activeOrderDraft || '').trim() !== '';
                          const zeroSavePath = !draftHasValue && recommendedOrder === 0;
                          const saveEnabled = draftHasValue || zeroSavePath;
                          const buttonLabel = zeroSavePath ? 'Save 0' : 'Save Order';
                          return (
                            <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                              <input
                                type="number"
                                min="0"
                                step="100"
                                value={activeOrderDraft}
                                onChange={(e) => setActiveOrderDraft(e.target.value)}
                                style={{
                                  width: '100%',
                                  fontSize: 14,
                                  padding: '4px 8px',
                                  border: '1px solid var(--border-strong)',
                                  borderRadius: 10,
                                  textAlign: 'right',
                                  fontFamily: 'inherit',
                                  fontWeight: 600,
                                  boxSizing: 'border-box',
                                }}
                              />
                              <button
                                onClick={commitActiveOrder}
                                disabled={!saveEnabled}
                                style={{
                                  padding: '5px 10px',
                                  borderRadius: 10,
                                  border: 'none',
                                  background: saveEnabled ? getProgramColor('pig') : '#9ca3af',
                                  color: 'white',
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: saveEnabled ? 'pointer' : 'not-allowed',
                                  fontFamily: 'inherit',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {buttonLabel}
                              </button>
                            </div>
                          );
                        })()
                      ) : (
                        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
                          <div style={{fontSize: 16, fontWeight: 600, color: 'var(--ink)'}}>
                            {isSaved ? Number(savedVal).toLocaleString() : '—'}
                          </div>
                          {isActiveSavedCard && (
                            <button
                              onClick={() => editMonth(ym)}
                              style={{
                                fontSize: 11,
                                padding: '3px 8px',
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
                          )}
                        </div>
                      )}
                      <div style={{fontSize: 10, color: 'var(--ink-faint)', marginTop: 1}}>arrives end of mo.</div>
                    </div>
                    <div style={{fontSize: 18, fontWeight: 700, color: 'var(--ink-faint)', textAlign: 'center'}}>
                      {'='}
                    </div>
                    {/* End */}
                    <div>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 2,
                        }}
                      >
                        End of Month
                      </div>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: lg && lg.end > 0 ? 'var(--text-primary)' : 'var(--danger)',
                        }}
                      >
                        {lg ? lg.end.toLocaleString() : '—'}
                      </div>
                    </div>
                  </div>

                  {/* Variance: Proj vs Actual daily rates */}
                  {(() => {
                    const projDaily = Math.round(md.projTotal / md.daysInMonth);
                    const daysElapsed = md.isFuture ? 0 : md.isCurrent ? now.getDate() : md.daysInMonth;
                    const actualDaily = daysElapsed > 0 ? Math.round(md.actual / daysElapsed) : 0;
                    const dailyVar = daysElapsed > 0 ? actualDaily - projDaily : null;
                    let moVar = null;
                    if (!md.isFuture && daysElapsed > 0) {
                      if (md.isCurrent) moVar = Math.round(actualDaily * md.daysInMonth) - md.projTotal;
                      else moVar = md.actual - md.projTotal;
                    }
                    return (
                      <div
                        style={{
                          padding: '2px 16px 8px',
                          display: 'flex',
                          gap: 16,
                          fontSize: 11,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        <span>
                          {'Proj: ' + projDaily.toLocaleString() + '/day (' + md.projTotal.toLocaleString() + ' mo)'}
                        </span>
                        {!md.isFuture && (
                          <span>
                            {'Actual: ' +
                              actualDaily.toLocaleString() +
                              '/day' +
                              (md.isCurrent
                                ? ' (' + md.actual.toLocaleString() + ' so far)'
                                : ' (' + md.actual.toLocaleString() + ' mo)')}
                          </span>
                        )}
                        {dailyVar != null && dailyVar !== 0 && (
                          <span style={{fontWeight: 600, color: dailyVar > 0 ? 'var(--danger)' : 'var(--ok-ink)'}}>
                            {(dailyVar > 0 ? '+' : '') + dailyVar.toLocaleString() + '/day'}
                          </span>
                        )}
                        {moVar != null && moVar !== 0 && (
                          <span style={{fontWeight: 600, color: moVar > 0 ? 'var(--danger)' : 'var(--ok-ink)'}}>
                            {(moVar > 0 ? '+' : '') + moVar.toLocaleString() + ' mo' + (md.isCurrent ? ' est.' : '')}
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  {/* Per-group breakdown — always visible */}
                  <div style={{borderTop: '1px solid var(--divider)', padding: '8px 16px 10px'}}>
                    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11}}>
                      <thead>
                        <tr style={{borderBottom: '1px solid var(--border)'}}>
                          <th
                            style={{padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--ink-muted)'}}
                          >
                            Group
                          </th>
                          <th
                            style={{
                              padding: '4px 10px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: 'var(--ink-muted)',
                            }}
                          >
                            Proj/day
                          </th>
                          <th
                            style={{
                              padding: '4px 10px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: 'var(--ink-muted)',
                            }}
                          >
                            Actual/day
                          </th>
                          <th
                            style={{
                              padding: '4px 10px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: 'var(--ink-muted)',
                            }}
                          >
                            Variance/day
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const gDaysElapsed = md.isFuture ? 0 : md.isCurrent ? now.getDate() : md.daysInMonth;
                          return projGroups.map((pg, gi) => {
                            let actualLbs = 0;
                            if (pg.label === 'SOWS') actualLbs = actualGroups['SOWS'] || 0;
                            else if (pg.label === 'BOARS') actualLbs = actualGroups['BOARS'] || 0;
                            else {
                              Object.entries(actualGroups).forEach((e2) => {
                                const low = e2[0].toLowerCase().trim();
                                if (pg.subNames && pg.subNames.length > 0) {
                                  if (pg.subNames.includes(low)) actualLbs += e2[1];
                                } else if (pg.mainName && low === pg.mainName) {
                                  actualLbs += e2[1];
                                }
                              });
                            }
                            actualLbs = Math.round(actualLbs);
                            const projDay = Math.round(pg.projected / md.daysInMonth);
                            const actualDay = gDaysElapsed > 0 ? Math.round(actualLbs / gDaysElapsed) : 0;
                            const gVar = md.isFuture ? null : gDaysElapsed > 0 ? actualDay - projDay : null;
                            return (
                              <tr key={gi} style={{borderBottom: '1px solid #f0f0f0'}}>
                                <td style={{padding: '4px 10px', fontWeight: 500, color: 'var(--ink)'}}>{pg.label}</td>
                                <td style={{padding: '4px 10px', textAlign: 'right', color: 'var(--ink-muted)'}}>
                                  {projDay.toLocaleString()}
                                </td>
                                <td
                                  style={{
                                    padding: '4px 10px',
                                    textAlign: 'right',
                                    fontWeight: 600,
                                    color: md.isFuture ? 'var(--ink-faint)' : 'var(--ink)',
                                  }}
                                >
                                  {md.isFuture ? '—' : actualDay.toLocaleString()}
                                </td>
                                <td
                                  style={{
                                    padding: '4px 10px',
                                    textAlign: 'right',
                                    fontWeight: 600,
                                    color:
                                      gVar == null ? 'var(--ink-faint)' : gVar > 0 ? 'var(--danger)' : 'var(--ok-ink)',
                                  }}
                                >
                                  {gVar == null ? '—' : (gVar > 0 ? '+' : '') + gVar.toLocaleString()}
                                </td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            }
            return <>{renderCard(activeYM)}</>;
          })()}
        </div>

        {/* Feed rates reference */}
        <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 20px'}}>
          <div style={{fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 8}}>
            Feed Rate Reference
          </div>
          <div style={{display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--ink-muted)'}}>
            <span>
              Sows (non-nursing): <strong>5 lbs/day</strong>
            </span>
            <span>
              Nursing sows: <strong>15 lbs/day</strong>
            </span>
            <span>
              Boars: <strong>5 lbs/day</strong>
            </span>
            <span>
              Feeder pigs: <strong>1 lb/day per month of age</strong>
            </span>
            {feedCosts.pig > 0 && (
              <span>
                Cost: <strong>{'$' + feedCosts.pig.toFixed(3) + '/lb'}</strong>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
