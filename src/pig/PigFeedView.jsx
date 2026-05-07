// ============================================================================
// src/pig/PigFeedView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Pig feed planning view. Pig entity arrays come from usePig(); the feed-
// cost rates come from useFeedCosts(). Feed-inventory state + the sbSave
// persistence helper still live in App and come in as props (these
// weren't lifted to a context in Round 0).
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {calcBreedingTimeline} from '../lib/pig.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function PigFeedView({
  Header,
  loadUsers,
  feedOrders,
  setFeedOrders,
  pigFeedInventory,
  setPigFeedInventory,
  sbSave,
}) {
  const [pigFeedExpandedMonths, setPigFeedExpandedMonths] = React.useState(new Set());
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {breeders, feederGroups, farrowingRecs, breedingCycles} = usePig();
  const {pigDailys} = useDailysRecent();
  const {feedCosts} = useFeedCosts();
  const {setView} = useUI();
  // ── PIG FEED PLANNING ──
  // Compute nursing sow count for a given date
  function nursingSowsOnDate(dateISO) {
    let count = 0;
    breedingCycles.forEach((c) => {
      const tl = calcBreedingTimeline(c.exposureStart);
      if (!tl) return;
      // Check each farrowing record for this cycle
      farrowingRecs.forEach((r) => {
        if (r.group !== c.group || !r.farrowingDate) return;
        const rd = new Date(r.farrowingDate + 'T12:00:00');
        const wStart = new Date(tl.farrowingStart + 'T12:00:00');
        const wEnd = addDays(tl.farrowingEnd, 14);
        if (rd >= wStart && rd <= wEnd) {
          // This record belongs to this cycle
          if (r.farrowingDate <= dateISO && tl.weaningEnd >= dateISO) count++;
        }
      });
    });
    return count;
  }

  // Compute projected daily feed for a given date
  function projectedDailyFeed(dateISO) {
    const totalActiveSows = breeders.filter((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt')).length;
    const totalBoars = breeders.filter((b) => !b.archived && b.sex === 'Boar').length;
    const nursing = nursingSowsOnDate(dateISO);
    const nonNursing = Math.max(0, totalActiveSows - nursing);
    const sowFeed = nonNursing * 5 + nursing * 12;
    const boarFeed = totalBoars * 5;
    // Feeder pigs: use active batches with age on that date
    let feederFeed = 0;
    feederGroups
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const cycle = breedingCycles.find((c) => c.id === g.cycleId);
        const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
        const birthDate = tl ? tl.farrowingStart : g.startDate || null;
        if (!birthDate) return;
        const ageMs = new Date(dateISO + 'T12:00:00') - new Date(birthDate + 'T12:00:00');
        if (ageMs < 0) return;
        const ageMonths = ageMs / 86400000 / 30.44;
        const processed = (g.processingTrips || []).reduce(function (s, t) {
          return s + (parseInt(t.pigCount) || 0);
        }, 0);
        const pigCount = Math.max(0, (parseInt(g.originalPigCount) || 0) - processed);
        feederFeed += pigCount * Math.max(1, ageMonths);
      });
    return {
      sowFeed: Math.round(sowFeed),
      boarFeed: Math.round(boarFeed),
      feederFeed: Math.round(feederFeed),
      total: Math.round(sowFeed + boarFeed + feederFeed),
      nursing,
      nonNursing,
    };
  }

  // Build monthly data for past 6 months + next 3 months
  const now = new Date();
  const months = [];
  for (let i = -6; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const thisYM = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const monthlyData = months.map((ym) => {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const midDate = ym + '-15';
    const proj = projectedDailyFeed(midDate);
    const projTotal = proj.total * daysInMonth;
    // Actual consumption from pig_dailys
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

  // Current month snapshot
  const curProj = projectedDailyFeed(todayISO());

  function savePigOrder(ym, val) {
    // Empty string = clear the order (delete key). Any number (including 0) = save as decision made.
    var pigOrders = {...(feedOrders.pig || {})};
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
    const inv = {
      count: parseFloat(count) || 0,
      date: date || todayISO(),
      includesCurrentMonthDelivery: !!includesCurrentMonthDelivery,
    };
    setPigFeedInventory(inv);
    sbSave('ppp-pig-feed-inventory-v1', inv);
  }

  // ── Feed on Hand calculation ──
  // Orders arrive at END of month — current month's order hasn't arrived yet.
  // Actual On Hand = orders arrived (past months) - consumption since tracking started
  // End of Month Est = orders through current month - consumption through end of month (actual + projected)
  const inv = pigFeedInventory; // {count, date} or null
  const todayDate = todayISO();
  var pigOrderMonths = Object.keys(feedOrders.pig || {})
    .filter(function (k) {
      return (parseFloat((feedOrders.pig || {})[k]) || 0) > 0;
    })
    .sort();
  var firstPigOrderYM = pigOrderMonths.length > 0 ? pigOrderMonths[0] : '9999-99';
  // Only count consumption from when tracking started
  var totalPigConsumed = pigDailys
    .filter(function (d) {
      return d.date && d.date.substring(0, 7) >= firstPigOrderYM;
    })
    .reduce(function (s, d) {
      return s + (parseFloat(d.feed_lbs) || 0);
    }, 0);
  // Orders that have ARRIVED = past months only (current month arrives at end of month)
  var ordersArrived = Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
    if (e[0] < thisYM && e[0] >= firstPigOrderYM) return s + (parseFloat(e[1]) || 0);
    return s;
  }, 0);
  // All orders through current month (including current month's pending delivery)
  var ordersThroughCurrent = Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
    if (e[0] <= thisYM) return s + (parseFloat(e[1]) || 0);
    return s;
  }, 0);
  // Projected remaining consumption for rest of current month
  var curMonthDaysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
  var projRemainingThisMonth = curMonthDaysLeft > 0 ? Math.round(curProj.total * curMonthDaysLeft) : 0;
  // End of month estimate (current month's order arrives, minus all consumption including projected)
  var endOfMonthEst =
    firstPigOrderYM !== '9999-99' ? Math.round(ordersThroughCurrent - totalPigConsumed - projRemainingThisMonth) : null;
  // Suggested order — auto-detect: if current month has no order yet, show current month; otherwise show next
  var curMonthHasOrder = (feedOrders.pig || {})[thisYM] != null;
  var orderTargetOffset = curMonthHasOrder ? 1 : 0;
  var orderTargetMonth = new Date(now.getFullYear(), now.getMonth() + orderTargetOffset, 1);
  var orderTargetYM = orderTargetMonth.getFullYear() + '-' + String(orderTargetMonth.getMonth() + 1).padStart(2, '0');
  var orderTargetLabel = orderTargetMonth.toLocaleDateString('en-US', {month: 'short'});
  // Need covers target month + month after (order arrives end of target month, must last through month after)
  var nextMonth2 = new Date(now.getFullYear(), now.getMonth() + orderTargetOffset + 1, 1);
  var nextYM = nextMonth2.getFullYear() + '-' + String(nextMonth2.getMonth() + 1).padStart(2, '0');
  var orderTargetData = monthlyData.find(function (m) {
    return m.ym === orderTargetYM;
  });
  var nextMonthData = monthlyData.find(function (m) {
    return m.ym === nextYM;
  });
  var monthAfterNext0 = new Date(now.getFullYear(), now.getMonth() + orderTargetOffset + 1, 1);
  var monthAfterNextYM0 = monthAfterNext0.getFullYear() + '-' + String(monthAfterNext0.getMonth() + 1).padStart(2, '0');
  var monthAfterNextData0 = monthlyData.find(function (m) {
    return m.ym === monthAfterNextYM0;
  });
  // Base for suggested order: if ordering for current month, use previous month end; if ordering for next month, use current month end
  var orderBaseEst = curMonthHasOrder
    ? endOfMonthEst
    : (function () {
        // End of previous month = start of current month in ledger terms (before current month consumption/orders)
        var prevEnd =
          Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
            if (e[0] < thisYM) return s + (parseFloat(e[1]) || 0);
            return s;
          }, 0) -
          pigDailys
            .filter(function (d) {
              return d.date && d.date.substring(0, 7) >= firstPigOrderYM && d.date.substring(0, 7) < thisYM;
            })
            .reduce(function (s, d) {
              return s + (parseFloat(d.feed_lbs) || 0);
            }, 0);
        return firstPigOrderYM !== '9999-99' ? Math.round(prevEnd) : null;
      })();
  var twoMonthNeed0 =
    (orderTargetData ? orderTargetData.projTotal : 0) + (monthAfterNextData0 ? monthAfterNextData0.projTotal : 0);
  var suggestedOrder = orderBaseEst != null ? Math.max(0, twoMonthNeed0 - orderBaseEst) : null;

  var feedOnHand = null;
  var physCountAdjustment = null;
  if (inv) {
    // Physical count path — orders arrived since count (exclude current month)
    var invYM = inv.date.substring(0, 7);
    var ordersSinceCount = Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
      if (e[0] > invYM && e[0] < thisYM) return s + (parseFloat(e[1]) || 0);
      return s;
    }, 0);
    var consumedSinceCount = pigDailys
      .filter(function (d) {
        return d.date && d.date > inv.date;
      })
      .reduce(function (s, d) {
        return s + (parseFloat(d.feed_lbs) || 0);
      }, 0);
    feedOnHand = Math.round(inv.count + ordersSinceCount - consumedSinceCount);
    // Calculate what system estimated at time of count vs what was actually counted.
    // Orders that had arrived by inv.date = months strictly before invYM (those arrived
    // end-of-prior-month), plus invYM's own order only if the count says delivery is included.
    // Mirrors the ledger's lgCountAdj logic so past-dated counts compare apples-to-apples.
    var adjOrdersAtCount = Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
      if (e[0] < firstPigOrderYM) return s;
      if (e[0] < invYM) return s + (parseFloat(e[1]) || 0);
      if (e[0] === invYM && inv.includesCurrentMonthDelivery) return s + (parseFloat(e[1]) || 0);
      return s;
    }, 0);
    var systemEstAtCount = Math.round(
      adjOrdersAtCount -
        pigDailys
          .filter(function (d) {
            return d.date && d.date.substring(0, 7) >= firstPigOrderYM && d.date <= inv.date;
          })
          .reduce(function (s, d) {
            return s + (parseFloat(d.feed_lbs) || 0);
          }, 0),
    );
    physCountAdjustment = Math.round(inv.count - systemEstAtCount);
    // Recalculate end of month est anchored from physical count
    // Include current month's order — it arrives end of month (after any mid-month count)
    // ...UNLESS the count already absorbed this month's delivery (skip count's own month)
    var ordSinceCountThruMonth = Object.entries(feedOrders.pig || {}).reduce(function (s, e) {
      if (e[0] < invYM || e[0] > thisYM) return s;
      if (e[0] === invYM && inv.includesCurrentMonthDelivery) return s;
      return s + (parseFloat(e[1]) || 0);
    }, 0);
    endOfMonthEst = Math.round(inv.count + ordSinceCountThruMonth - consumedSinceCount - projRemainingThisMonth);
    // Recalculate suggested order — must cover next TWO months (order arrives end of next month, need to last through month after)
    var monthAfterNext = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    var monthAfterNextYM = monthAfterNext.getFullYear() + '-' + String(monthAfterNext.getMonth() + 1).padStart(2, '0');
    var monthAfterNextData = monthlyData.find(function (m) {
      return m.ym === monthAfterNextYM;
    });
    var twoMonthNeed =
      (nextMonthData ? nextMonthData.projTotal : 0) + (monthAfterNextData ? monthAfterNextData.projTotal : 0);
    suggestedOrder = endOfMonthEst != null ? Math.max(0, twoMonthNeed - endOfMonthEst) : null;
  } else if (firstPigOrderYM !== '9999-99') {
    feedOnHand = Math.round(ordersArrived - totalPigConsumed);
  }

  // Per-group projected feed for a given month
  function projectedFeedByGroup(ym) {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const midDate = ym + '-15';
    const totalActiveSows = breeders.filter((b) => !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt')).length;
    const totalBoars = breeders.filter((b) => !b.archived && b.sex === 'Boar').length;
    const nursing = nursingSowsOnDate(midDate);
    const nonNursing = Math.max(0, totalActiveSows - nursing);
    const sowFeed = (nonNursing * 5 + nursing * 12) * daysInMonth;
    const boarFeed = totalBoars * 5 * daysInMonth;
    const groups = [
      {label: 'SOWS', projected: Math.round(sowFeed)},
      {label: 'BOARS', projected: Math.round(boarFeed)},
    ];
    feederGroups
      .filter((g) => g.status === 'active')
      .forEach((g) => {
        const cycle = breedingCycles.find((c) => c.id === g.cycleId);
        const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
        const birthDate = tl ? tl.farrowingStart : g.startDate || null;
        if (!birthDate) return;
        const ageMs = new Date(midDate + 'T12:00:00') - new Date(birthDate + 'T12:00:00');
        if (ageMs < 0) return;
        const ageMonths = ageMs / 86400000 / 30.44;
        const processed2 = (g.processingTrips || []).reduce(function (s, t) {
          return s + (parseInt(t.pigCount) || 0);
        }, 0);
        const pigCount = Math.max(0, (parseInt(g.originalPigCount) || 0) - processed2);
        const feed = pigCount * Math.max(1, ageMonths) * daysInMonth;
        // Use sub-batch names if available, otherwise main batch name
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

  // Actual feed by group for a month from pig_dailys
  function actualFeedByGroup(ym) {
    const monthDailys = pigDailys.filter((d) => d.date && d.date.startsWith(ym));
    const byLabel = {};
    monthDailys.forEach((d) => {
      const lbl = d.batch_label || 'Unknown';
      byLabel[lbl] = (byLabel[lbl] || 0) + (parseFloat(d.feed_lbs) || 0);
    });
    return byLabel;
  }

  // Expandable month rows — uses top-level state (React hooks can't be inside conditionals)
  const expandedMonths = pigFeedExpandedMonths;
  function toggleMonth(ym) {
    setPigFeedExpandedMonths((s) => {
      const n = new Set(s);
      n.has(ym) ? n.delete(ym) : n.add(ym);
      return n;
    });
  }

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
        {/* 4 top tiles — big numbers */}
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10}}>
          {/* Actual On Hand */}
          <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px'}}>
            <div
              style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4}}
            >
              Actual On Hand
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: feedOnHand != null ? (feedOnHand > 0 ? '#065f46' : '#b91c1c') : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {feedOnHand != null ? feedOnHand.toLocaleString() + ' lbs' : '\u2014'}
            </div>
            {inv && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 6}}>{'Count: ' + fmt(inv.date)}</div>}
            {inv && physCountAdjustment != null && physCountAdjustment !== 0 && (
              <div style={{fontSize: 10, color: physCountAdjustment > 0 ? '#065f46' : '#b91c1c', marginTop: 2}}>
                {'Adj ' + (physCountAdjustment > 0 ? '+' : '') + physCountAdjustment.toLocaleString() + ' vs system'}
              </div>
            )}
            {!inv && feedOnHand != null && curProj.total > 0 && (
              <div style={{fontSize: 11, color: '#065f46', fontWeight: 600, marginTop: 4}}>
                {'~' + Math.max(0, Math.round(feedOnHand / curProj.total)) + ' days remaining'}
              </div>
            )}
          </div>
          {/* End of Month Est */}
          <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px'}}>
            <div
              style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4}}
            >
              End of Month Est.
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: endOfMonthEst != null ? (endOfMonthEst > 0 ? '#065f46' : '#b91c1c') : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {endOfMonthEst != null ? endOfMonthEst.toLocaleString() + ' lbs' : '\u2014'}
            </div>
            <div style={{fontSize: 11, color: '#6b7280', marginTop: 6}}>
              {inv && inv.includesCurrentMonthDelivery && inv.date && inv.date.substring(0, 7) === thisYM
                ? 'Delivery included in count'
                : 'Incl. ' + ((feedOrders.pig || {})[thisYM] || 0).toLocaleString() + ' arriving'}
            </div>
          </div>
          {/* Suggested Order */}
          <div
            style={{
              background: suggestedOrder > 0 ? '#fffbeb' : 'white',
              border: suggestedOrder > 0 ? '2px solid #fde68a' : '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: suggestedOrder > 0 ? '#92400e' : '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                marginBottom: 4,
              }}
            >
              {'Order for ' + orderTargetLabel}
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: suggestedOrder != null ? (suggestedOrder > 0 ? '#92400e' : '#065f46') : '#9ca3af',
                lineHeight: 1,
              }}
            >
              {suggestedOrder != null
                ? suggestedOrder > 0
                  ? suggestedOrder.toLocaleString() + ' lbs'
                  : 'Surplus'
                : '\u2014'}
            </div>
            <div style={{fontSize: 11, color: '#6b7280', marginTop: 6}}>
              {'Carryover: ' + (orderBaseEst != null ? orderBaseEst.toLocaleString() : '\u2014') + ' lbs'}
            </div>
          </div>
          {/* Need thru */}
          <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px'}}>
            <div
              style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4}}
            >
              {'Need thru ' + monthAfterNext0.toLocaleDateString('en-US', {month: 'short'})}
            </div>
            <div style={{fontSize: 28, fontWeight: 700, color: '#111827', lineHeight: 1}}>
              {twoMonthNeed0.toLocaleString() + ' lbs'}
            </div>
            <div style={{fontSize: 11, color: '#9ca3af', marginTop: 6}}>
              {(orderTargetData ? orderTargetData.projTotal.toLocaleString() : '0') +
                ' (' +
                orderTargetLabel +
                ') + ' +
                (monthAfterNextData0 ? monthAfterNextData0.projTotal.toLocaleString() : '0') +
                ' (' +
                monthAfterNext0.toLocaleDateString('en-US', {month: 'short'}) +
                ')'}
            </div>
          </div>
        </div>

        {/* Physical count input */}
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 20px'}}>
          <div style={{display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap'}}>
            <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', alignSelf: 'center'}}>
              {inv ? 'Update Physical Count' : 'Enter Physical Count'}
            </div>
            <div>
              <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>Lbs on hand</label>
              <input
                id="pig-feed-count-input"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 5000"
                defaultValue={inv ? inv.count : ''}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  width: 120,
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <div>
              <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>Date</label>
              <input
                id="pig-feed-count-date"
                type="date"
                defaultValue={inv ? inv.date : todayDate}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
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
                border: '1px solid #d1d5db',
                borderRadius: 6,
                background: '#f9fafb',
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
                defaultChecked={!!(inv && inv.includesCurrentMonthDelivery)}
                style={{cursor: 'pointer', margin: 0, accentColor: '#000'}}
              />
              Includes this month's feed delivery
            </label>
            <button
              onClick={() => {
                const el = document.getElementById('pig-feed-count-input');
                const dl = document.getElementById('pig-feed-count-date');
                const cb = document.getElementById('pig-feed-count-includes-delivery');
                if (!el || !el.value) {
                  alert('Enter the lbs on hand.');
                  return;
                }
                savePigFeedCount(el.value, dl ? dl.value : todayDate, cb ? cb.checked : false);
              }}
              style={{
                padding: '7px 16px',
                borderRadius: 7,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              Save Count
            </button>
            {inv && <div style={{fontSize: 10, color: '#9ca3af', alignSelf: 'center'}}>Last: {fmt(inv.date)}</div>}
          </div>
        </div>

        {/* Monthly summary — card per month, current first, collapsible past/future */}
        {(function () {
          function fmtMonth2(ym) {
            var p = ym.split('-').map(Number);
            return new Date(p[0], p[1] - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
          }

          // ── Build running inventory ledger ──
          // START → CONSUMED → ORDERED (arrives end of month) → END
          var pigLedger = {};
          var runBal = 0;
          var allMonthsSorted = monthlyData.slice().sort(function (a, b) {
            return a.ym.localeCompare(b.ym);
          });
          var countApplied = false;
          for (var mi3 = 0; mi3 < allMonthsSorted.length; mi3++) {
            var md3 = allMonthsSorted[mi3];
            if (md3.ym < firstPigOrderYM) {
              pigLedger[md3.ym] = null;
              continue;
            }
            var lgStart = runBal;
            var lgCountMonth = false;
            var lgCountAdj = null;
            // Physical count override
            if (inv && !countApplied) {
              var invYM3 = inv.date.substring(0, 7);
              if (invYM3 === md3.ym) {
                // When count includes this month's delivery, the system-side comparison must
                // include that order too (else a perfect count shows a phantom adjustment).
                var thisMonthOrderForAdj = parseFloat(md3.ordered) || 0;
                var systemEstThisMonth = runBal + (inv.includesCurrentMonthDelivery ? thisMonthOrderForAdj : 0);
                lgCountAdj = Math.round(inv.count - systemEstThisMonth);
                lgStart = inv.count;
                lgCountMonth = true;
                countApplied = true;
                var cAfter = pigDailys
                  .filter(function (d) {
                    return d.date && d.date > inv.date && d.date.startsWith(md3.ym);
                  })
                  .reduce(function (s, d) {
                    return s + (parseFloat(d.feed_lbs) || 0);
                  }, 0);
                var pRem = 0;
                if (md3.isCurrent) {
                  var dl4 = md3.daysInMonth - now.getDate();
                  if (dl4 > 0) pRem = Math.round(curProj.total * dl4);
                }
                var lgCons = Math.round(cAfter + pRem);
                // When delivery is already absorbed into the count value, don't add this month's order again.
                var lgOrd = inv.includesCurrentMonthDelivery ? 0 : parseFloat(md3.ordered) || 0;
                var lgEnd = Math.round(lgStart - lgCons + lgOrd);
                pigLedger[md3.ym] = {
                  start: lgStart,
                  consumed: lgCons,
                  actualCons: Math.round(cAfter),
                  projCons: Math.round(pRem),
                  ordered: lgOrd,
                  rawOrdered: parseFloat(md3.ordered) || 0,
                  end: lgEnd,
                  countMonth: true,
                  countAdj: lgCountAdj,
                  deliveryInCount: !!inv.includesCurrentMonthDelivery,
                };
                runBal = lgEnd;
                continue;
              } else if (invYM3 < md3.ym) {
                lgStart = inv.count;
                countApplied = true;
              }
            }
            var lgActual = md3.actual;
            var lgProj = 0;
            if (md3.isCurrent) {
              var dl5 = md3.daysInMonth - now.getDate();
              if (dl5 > 0) lgProj = Math.round(curProj.total * dl5);
            } else if (md3.isFuture) {
              lgProj = md3.projTotal;
              lgActual = 0;
            }
            var lgCons2 = Math.round(lgActual + lgProj);
            var lgOrd2 = parseFloat(md3.ordered) || 0;
            var lgEnd2 = Math.round(lgStart - lgCons2 + lgOrd2);
            pigLedger[md3.ym] = {
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

          function renderPigMonthCard(md2) {
            var lg = pigLedger[md2.ym];
            if (!lg) return null;
            var projGroups = projectedFeedByGroup(md2.ym);
            var actualGroups = actualFeedByGroup(md2.ym);
            var variance = !md2.isFuture && md2.actual > 0 ? md2.actual - md2.projTotal : null;
            return React.createElement(
              'div',
              {
                key: md2.ym,
                style: {
                  background: 'white',
                  border: md2.isCurrent ? '2px solid #085041' : '1px solid #e5e7eb',
                  borderRadius: 12,
                  overflow: 'hidden',
                },
              },
              // Header
              React.createElement(
                'div',
                {
                  style: {
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: md2.isCurrent ? '#ecfdf5' : md2.isFuture ? '#f8fafc' : 'white',
                  },
                },
                React.createElement(
                  'span',
                  {style: {fontSize: 14, fontWeight: 700, color: '#111827'}},
                  fmtMonth2(md2.ym),
                ),
                md2.isCurrent &&
                  React.createElement(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#065f46',
                        background: '#d1fae5',
                        padding: '1px 8px',
                        borderRadius: 10,
                      },
                    },
                    'NOW',
                  ),
                md2.isFuture && React.createElement('span', {style: {fontSize: 10, color: '#9ca3af'}}, 'projected'),
                lg.countMonth &&
                  lg.countAdj != null &&
                  lg.countAdj !== 0 &&
                  React.createElement(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        fontWeight: 600,
                        color: lg.countAdj > 0 ? '#065f46' : '#b91c1c',
                        background: lg.countAdj > 0 ? '#ecfdf5' : '#fef2f2',
                        padding: '1px 8px',
                        borderRadius: 10,
                      },
                    },
                    'Count adj ' + (lg.countAdj > 0 ? '+' : '') + lg.countAdj.toLocaleString(),
                  ),
              ),
              // Ledger row — START / CONSUMED / ORDERED / END
              React.createElement(
                'div',
                {style: {padding: '8px 16px 6px', display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr 1fr', gap: 10}},
                // START
                React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 10,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 2,
                      },
                    },
                    'Start of Month',
                  ),
                  React.createElement(
                    'div',
                    {style: {fontSize: 16, fontWeight: 600, color: lg.start >= 0 ? '#374151' : '#b91c1c'}},
                    lg.start.toLocaleString(),
                  ),
                ),
                // CONSUMED
                React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 10,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 2,
                      },
                    },
                    'Consumed',
                  ),
                  React.createElement(
                    'div',
                    {style: {fontSize: 16, fontWeight: 600, color: '#111827'}},
                    lg.consumed.toLocaleString(),
                  ),
                  md2.isCurrent && lg.projCons > 0
                    ? React.createElement(
                        'div',
                        {style: {fontSize: 10, color: '#9ca3af', marginTop: 1}},
                        lg.actualCons.toLocaleString() + ' actual + ' + lg.projCons.toLocaleString() + ' proj',
                      )
                    : null,
                  md2.isFuture
                    ? React.createElement('div', {style: {fontSize: 10, color: '#9ca3af', marginTop: 1}}, 'projected')
                    : null,
                ),
                // ORDERED (input)
                React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 10,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 2,
                      },
                    },
                    'Ordered',
                  ),
                  React.createElement('input', {
                    type: 'number',
                    min: '0',
                    step: '100',
                    value: md2.ordered != null && md2.ordered !== '' ? md2.ordered : '',
                    onChange: function (e) {
                      savePigOrder(md2.ym, e.target.value);
                    },
                    onClick: function (e) {
                      e.stopPropagation();
                    },
                    placeholder: '0',
                    style: {
                      width: '100%',
                      fontSize: 14,
                      padding: '4px 8px',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      textAlign: 'right',
                      fontFamily: 'inherit',
                      fontWeight: 600,
                      boxSizing: 'border-box',
                    },
                  }),
                  React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 10,
                        color: lg.deliveryInCount ? '#065f46' : '#9ca3af',
                        marginTop: 1,
                        fontStyle: lg.deliveryInCount ? 'italic' : 'normal',
                      },
                    },
                    lg.deliveryInCount ? '(in count)' : 'arrives end of mo.',
                  ),
                ),
                // END OF MONTH
                React.createElement(
                  'div',
                  null,
                  React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 10,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 2,
                      },
                    },
                    'End of Month',
                  ),
                  React.createElement(
                    'div',
                    {style: {fontSize: 16, fontWeight: 700, color: lg.end > 0 ? '#065f46' : '#b91c1c'}},
                    lg.end.toLocaleString(),
                  ),
                ),
              ),
              // Projected vs Actual — daily rates + extrapolated monthly variance
              (function () {
                var projDaily = Math.round(md2.projTotal / md2.daysInMonth);
                var daysElapsed = md2.isFuture ? 0 : md2.isCurrent ? now.getDate() : md2.daysInMonth;
                var actualDaily = daysElapsed > 0 ? Math.round(md2.actual / daysElapsed) : 0;
                var dailyVar = daysElapsed > 0 ? actualDaily - projDaily : null;
                // Monthly variance: for completed months use actual totals, for current month extrapolate daily rate to full month
                var moVar = null;
                if (!md2.isFuture && daysElapsed > 0) {
                  if (md2.isCurrent) moVar = Math.round(actualDaily * md2.daysInMonth) - md2.projTotal;
                  else moVar = md2.actual - md2.projTotal;
                }
                return React.createElement(
                  'div',
                  {style: {padding: '2px 16px 8px', display: 'flex', gap: 16, fontSize: 11, color: '#6b7280'}},
                  React.createElement(
                    'span',
                    null,
                    'Proj: ' + projDaily.toLocaleString() + '/day (' + md2.projTotal.toLocaleString() + ' mo)',
                  ),
                  !md2.isFuture &&
                    React.createElement(
                      'span',
                      null,
                      'Actual: ' +
                        actualDaily.toLocaleString() +
                        '/day' +
                        (md2.isCurrent
                          ? ' (' + md2.actual.toLocaleString() + ' so far)'
                          : ' (' + md2.actual.toLocaleString() + ' mo)'),
                    ),
                  dailyVar != null &&
                    dailyVar !== 0 &&
                    React.createElement(
                      'span',
                      {style: {fontWeight: 600, color: dailyVar > 0 ? '#b91c1c' : '#065f46'}},
                      (dailyVar > 0 ? '+' : '') + dailyVar.toLocaleString() + '/day',
                    ),
                  moVar != null &&
                    moVar !== 0 &&
                    React.createElement(
                      'span',
                      {style: {fontWeight: 600, color: moVar > 0 ? '#b91c1c' : '#065f46'}},
                      (moVar > 0 ? '+' : '') + moVar.toLocaleString() + ' mo' + (md2.isCurrent ? ' est.' : ''),
                    ),
                );
              })(),
              // Per-group breakdown
              React.createElement(
                'div',
                {style: {borderTop: '1px solid #f3f4f6', padding: '8px 16px 10px'}},
                React.createElement(
                  'table',
                  {style: {width: '100%', borderCollapse: 'collapse', fontSize: 11}},
                  React.createElement(
                    'thead',
                    null,
                    React.createElement(
                      'tr',
                      {style: {borderBottom: '1px solid #e5e7eb'}},
                      React.createElement(
                        'th',
                        {style: {padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: '#6b7280'}},
                        'Group',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '4px 10px', textAlign: 'right', fontWeight: 600, color: '#6b7280'}},
                        'Proj/day',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '4px 10px', textAlign: 'right', fontWeight: 600, color: '#6b7280'}},
                        'Actual/day',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '4px 10px', textAlign: 'right', fontWeight: 600, color: '#6b7280'}},
                        'Variance/day',
                      ),
                    ),
                  ),
                  React.createElement(
                    'tbody',
                    null,
                    (function () {
                      var gDaysElapsed = md2.isFuture ? 0 : md2.isCurrent ? now.getDate() : md2.daysInMonth;
                      return projGroups.map(function (pg, gi) {
                        var actualLbs = 0;
                        if (pg.label === 'SOWS') actualLbs = actualGroups['SOWS'] || 0;
                        else if (pg.label === 'BOARS') actualLbs = actualGroups['BOARS'] || 0;
                        else {
                          Object.entries(actualGroups).forEach(function (e2) {
                            var low = e2[0].toLowerCase().trim();
                            if (pg.subNames && pg.subNames.length > 0) {
                              if (pg.subNames.includes(low)) actualLbs += e2[1];
                            } else if (pg.mainName && low === pg.mainName) {
                              actualLbs += e2[1];
                            }
                          });
                        }
                        actualLbs = Math.round(actualLbs);
                        var projDay = Math.round(pg.projected / md2.daysInMonth);
                        var actualDay = gDaysElapsed > 0 ? Math.round(actualLbs / gDaysElapsed) : 0;
                        var gVar = md2.isFuture ? null : gDaysElapsed > 0 ? actualDay - projDay : null;
                        return React.createElement(
                          'tr',
                          {key: gi, style: {borderBottom: '1px solid #f0f0f0'}},
                          React.createElement(
                            'td',
                            {style: {padding: '4px 10px', fontWeight: 500, color: '#374151'}},
                            pg.label,
                          ),
                          React.createElement(
                            'td',
                            {style: {padding: '4px 10px', textAlign: 'right', color: '#6b7280'}},
                            projDay.toLocaleString(),
                          ),
                          React.createElement(
                            'td',
                            {
                              style: {
                                padding: '4px 10px',
                                textAlign: 'right',
                                fontWeight: 600,
                                color: md2.isFuture ? '#9ca3af' : '#111827',
                              },
                            },
                            md2.isFuture ? '\u2014' : actualDay.toLocaleString(),
                          ),
                          React.createElement(
                            'td',
                            {
                              style: {
                                padding: '4px 10px',
                                textAlign: 'right',
                                fontWeight: 600,
                                color: gVar == null ? '#9ca3af' : gVar > 0 ? '#b91c1c' : '#065f46',
                              },
                            },
                            gVar == null ? '\u2014' : (gVar > 0 ? '+' : '') + gVar.toLocaleString(),
                          ),
                        );
                      });
                    })(),
                  ),
                ),
              ),
            );
          }

          var currentMonth = monthlyData.filter(function (m) {
            return m.isCurrent;
          });
          var futureMonths = monthlyData.filter(function (m) {
            return m.isFuture;
          });
          var pastMonths = monthlyData
            .filter(function (m) {
              return !m.isCurrent && !m.isFuture;
            })
            .reverse();
          var pastByYear = {};
          pastMonths.forEach(function (m) {
            var yr = m.ym.substring(0, 4);
            if (!pastByYear[yr]) pastByYear[yr] = [];
            pastByYear[yr].push(m);
          });
          var pastYears = Object.keys(pastByYear).sort().reverse();

          var secToggle = pigFeedExpandedMonths;
          function togSec(key) {
            setPigFeedExpandedMonths(function (s) {
              var n = new Set(s);
              n.has(key) ? n.delete(key) : n.add(key);
              return n;
            });
          }

          return React.createElement(
            'div',
            {style: {display: 'flex', flexDirection: 'column', gap: '1.25rem'}},
            React.createElement(
              'div',
              {style: {fontSize: 14, fontWeight: 700, color: '#085041'}},
              'Monthly Pig Feed Summary',
            ),
            currentMonth.length > 0 && React.createElement('div', null, currentMonth.map(renderPigMonthCard)),
            futureMonths.length > 0 &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    onClick: function () {
                      togSec('future');
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      padding: '8px 0',
                      marginBottom: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: '#9ca3af'}},
                    secToggle.has('future') ? '\u25bc' : '\u25b6',
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 13, fontWeight: 600, color: '#4b5563'}},
                    'UPCOMING MONTHS',
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 11, color: '#9ca3af'}},
                    '(' + futureMonths.length + ')',
                  ),
                ),
                secToggle.has('future') &&
                  React.createElement(
                    'div',
                    {style: {display: 'flex', flexDirection: 'column', gap: 10}},
                    futureMonths.map(renderPigMonthCard),
                  ),
              ),
            pastYears.length > 0 &&
              React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  {
                    onClick: function () {
                      togSec('past');
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      padding: '8px 0',
                      marginBottom: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: '#9ca3af'}},
                    secToggle.has('past') ? '\u25bc' : '\u25b6',
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 13, fontWeight: 600, color: '#4b5563'}},
                    'PAST MONTHS',
                  ),
                  React.createElement('span', {style: {fontSize: 11, color: '#9ca3af'}}, '(' + pastMonths.length + ')'),
                ),
                secToggle.has('past') &&
                  React.createElement(
                    'div',
                    {style: {display: 'flex', flexDirection: 'column', gap: 14}},
                    pastYears.map(function (yr) {
                      var yearMonths = pastByYear[yr];
                      var yearKey = 'past-' + yr;
                      return React.createElement(
                        'div',
                        {key: yr},
                        pastYears.length > 1 &&
                          React.createElement(
                            'div',
                            {
                              onClick: function () {
                                togSec(yearKey);
                              },
                              style: {
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                cursor: 'pointer',
                                padding: '4px 0',
                                marginBottom: 6,
                              },
                            },
                            React.createElement(
                              'span',
                              {style: {fontSize: 10, color: '#9ca3af'}},
                              secToggle.has(yearKey) ? '\u25bc' : '\u25b6',
                            ),
                            React.createElement('span', {style: {fontSize: 12, fontWeight: 600, color: '#6b7280'}}, yr),
                            React.createElement(
                              'span',
                              {style: {fontSize: 11, color: '#9ca3af'}},
                              '(' + yearMonths.length + ' months)',
                            ),
                          ),
                        (pastYears.length === 1 || secToggle.has(yearKey)) &&
                          React.createElement(
                            'div',
                            {style: {display: 'flex', flexDirection: 'column', gap: 10}},
                            yearMonths.map(renderPigMonthCard),
                          ),
                      );
                    }),
                  ),
              ),
          );
        })()}

        {/* Feed rates reference */}
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', marginBottom: 8}}>Feed Rate Reference</div>
          <div style={{display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: '#6b7280'}}>
            <span>
              Sows (non-nursing): <strong>5 lbs/day</strong>
            </span>
            <span>
              Nursing sows: <strong>12 lbs/day</strong>
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
