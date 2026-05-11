// ============================================================================
// src/broiler/BroilerFeedView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Poultry feed planning view. Mixes broiler + layer data to project feed
// needs per month and compare against actuals + orders. feedOrders /
// poultryFeedInventory and sbSave still live in App (Round 0 left them
// out of contexts) and come in as props.
// ============================================================================
import React, {useState} from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcBatchFeedForMonth,
  calcLayerFeedForMonth,
  calcBatchFeed,
  calcBroilerStatsFromDailys,
  calcPoultryStatus,
  getBatchColor,
  breedLabel,
  BREED_STYLE,
  LAYER_FEED_SCHEDULE,
  LAYER_FEED_PER_DAY,
} from '../lib/broiler.js';
import {computeProjectedCount} from '../lib/layerHousing.js';
import {
  poultryDailyBurnLbs,
  onHandFromSnapshot,
  isSnapshotStale,
  suggestOrder,
  STALE_SNAPSHOT_DAYS,
  LEAD_TIME_DAYS,
  RESERVE_DAYS,
} from '../lib/feedPlanner.js';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';

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
  const [poultryFeedExpandedMonths, setPoultryFeedExpandedMonths] = useState(new Set());
  const [showPoultryLegacyLedger, setShowPoultryLegacyLedger] = useState(false);
  const [confirmPoultrySuggested, setConfirmPoultrySuggested] = useState(null);
  const {batches} = useBatches();
  const {layerBatches, layerHousings, allLayerDailys} = useLayer();
  const {broilerDailys} = useDailysRecent();
  const [countType, setCountType] = useState('starter');
  const today = new Date();
  const todayDate = todayISO();
  const months = [];
  for (var mi2 = -6; mi2 <= 6; mi2++) {
    var d2 = new Date(today.getFullYear(), today.getMonth() + mi2, 1);
    months.push(d2.getFullYear() + '-' + String(d2.getMonth() + 1).padStart(2, '0'));
  }
  var thisYM = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  function fmtMonth(ym) {
    var p = ym.split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
  }

  var activeBroilers = batches.filter(function (b) {
    return b.hatchDate;
  });
  var activeLayerBatchesForFeed = (layerBatches || []).filter(function (b) {
    return b.status === 'active' && b.name !== 'Retirement Home';
  });
  var activeHousings = (layerHousings || []).filter(function (h) {
    return h.status === 'active';
  });

  // Pre-compute actual consumption by month and feed type
  var actualByMonth = {};
  months.forEach(function (ym) {
    actualByMonth[ym] = {starter: 0, grower: 0, layer: 0};
  });
  (broilerDailys || []).forEach(function (d) {
    if (!d.date) return;
    var ym = d.date.substring(0, 7);
    if (!actualByMonth[ym]) return;
    var lbs = parseFloat(d.feed_lbs) || 0;
    if (d.feed_type === 'STARTER') actualByMonth[ym].starter += lbs;
    else if (d.feed_type === 'GROWER') actualByMonth[ym].grower += lbs;
  });
  (allLayerDailys || []).forEach(function (d) {
    if (!d.date) return;
    var ym = d.date.substring(0, 7);
    if (!actualByMonth[ym]) return;
    var lbs = parseFloat(d.feed_lbs) || 0;
    if (d.feed_type === 'STARTER') actualByMonth[ym].starter += lbs;
    else if (d.feed_type === 'GROWER') actualByMonth[ym].grower += lbs;
    else if (d.feed_type === 'LAYER') actualByMonth[ym].layer += lbs;
  });

  var monthlyData = months
    .map(function (ym) {
      var p = ym.split('-').map(Number);
      var daysInMonth = new Date(p[0], p[1], 0).getDate();
      var isFuture = ym > thisYM;
      var isCurrent = ym === thisYM;
      // Broiler projected
      var bStarter = 0,
        bGrover = 0;
      activeBroilers.forEach(function (b) {
        var f = calcBatchFeedForMonth(b, ym);
        bStarter += f.starter;
        bGrover += f.grower;
      });
      // Layer projected
      var lStarter = 0,
        lGrover = 0,
        lLayer = 0;
      activeLayerBatchesForFeed.forEach(function (b) {
        var f = calcLayerFeedForMonth(b, layerHousings || [], allLayerDailys || [], ym);
        lStarter += f.starter;
        lGrover += f.grower;
        lLayer += f.layer;
      });
      var starter = Math.round(bStarter + lStarter);
      var grower = Math.round(bGrover + lGrover);
      var layerFeed = Math.round(lLayer);
      var total = starter + grower + layerFeed;
      var act = actualByMonth[ym] || {starter: 0, grower: 0, layer: 0};
      var actualTotal = Math.round(act.starter + act.grower + act.layer);
      var ordS = (feedOrders.starter || {})[ym] || 0;
      var ordG = (feedOrders.grower || {})[ym] || 0;
      var ordL = (feedOrders.layerfeed || {})[ym] || 0;
      var ordered = Math.round((parseFloat(ordS) || 0) + (parseFloat(ordG) || 0) + (parseFloat(ordL) || 0));
      return {
        ym: ym,
        daysInMonth: daysInMonth,
        starter: starter,
        grower: grower,
        layerFeed: layerFeed,
        total: total,
        actualStarter: Math.round(act.starter),
        actualGrover: Math.round(act.grower),
        actualLayer: Math.round(act.layer),
        actualTotal: actualTotal,
        ordS: ordS,
        ordG: ordG,
        ordL: ordL,
        ordered: ordered,
        isFuture: isFuture,
        isCurrent: isCurrent,
        bStarter: Math.round(bStarter),
        bGrover: Math.round(bGrover),
        lStarter: Math.round(lStarter),
        lGrover: Math.round(lGrover),
        lLayer: Math.round(lLayer),
      };
    })
    .filter(function (m) {
      return m.total > 0 || m.actualTotal > 0 || m.ordered > 0 || m.isCurrent;
    });

  // Save helpers
  function savePoultryOrder(type, ym, val) {
    // Empty string = clear the order (delete key). Any number (including 0) = save as decision made.
    var typeOrders = {...(feedOrders[type] || {})};
    if (val === '' || val == null) {
      delete typeOrders[ym];
    } else {
      typeOrders[ym] = parseFloat(val) || 0;
    }
    var next = {...feedOrders, [type]: typeOrders};
    setFeedOrders(next);
    sbSave('ppp-feed-orders-v1', next);
  }
  function savePoultryFeedCount(type, count, date) {
    // New count writes are flat {count, date} per feed type. The legacy
    // includesCurrentMonthDelivery flag is no longer operator-facing;
    // helpers below still tolerate it on old persisted rows.
    var inv = {...(poultryFeedInventory || {})};
    inv[type] = {
      count: parseFloat(count) || 0,
      date: date || todayDate,
    };
    setPoultryFeedInventory(inv);
    sbSave('ppp-poultry-feed-inventory-v1', inv);
  }

  // Find earliest month with ANY poultry feed order — this is when tracking starts
  var allPoultryOrderMonths = []
    .concat(
      Object.keys(feedOrders.starter || {}).filter(function (k) {
        return (parseFloat((feedOrders.starter || {})[k]) || 0) > 0;
      }),
      Object.keys(feedOrders.grower || {}).filter(function (k) {
        return (parseFloat((feedOrders.grower || {})[k]) || 0) > 0;
      }),
      Object.keys(feedOrders.layerfeed || {}).filter(function (k) {
        return (parseFloat((feedOrders.layerfeed || {})[k]) || 0) > 0;
      }),
    )
    .sort();
  var firstPoultryOrderYM = allPoultryOrderMonths.length > 0 ? allPoultryOrderMonths[0] : '9999-99';

  // ── Build poultry running ledger per feed type ──
  var pAllDailys = (broilerDailys || []).concat(allLayerDailys || []);
  var pLedger = {starter: {}, grower: {}, layer: {}};
  var pDaysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
  ['starter', 'grower', 'layer'].forEach(function (type) {
    var orderKey = type === 'layer' ? 'layerfeed' : type;
    var ftKey = type === 'starter' ? 'STARTER' : type === 'grower' ? 'GROWER' : 'LAYER';
    var projKey = type === 'starter' ? 'starter' : type === 'grower' ? 'grower' : 'layerFeed';
    var actualKey = type === 'starter' ? 'actualStarter' : type === 'grower' ? 'actualGrover' : 'actualLayer';
    var runBal2 = 0;
    var pInv2 = poultryFeedInventory && poultryFeedInventory[type];
    var countApplied2 = false;
    var allSorted = monthlyData.slice().sort(function (a, b) {
      return a.ym.localeCompare(b.ym);
    });
    for (var mi4 = 0; mi4 < allSorted.length; mi4++) {
      var md4 = allSorted[mi4];
      if (md4.ym < firstPoultryOrderYM) {
        pLedger[type][md4.ym] = null;
        continue;
      }
      var st = runBal2;
      var isCM = false;
      var cAdj = null;
      if (pInv2 && !countApplied2) {
        var iYM = pInv2.date.substring(0, 7);
        if (iYM === md4.ym) {
          // Type's current-month order. When count says delivery is included, the system-side
          // estimate must include that order too (else a perfect count shows a phantom Adj).
          var thisMonthOrderForAdj = parseFloat((feedOrders[orderKey] || {})[md4.ym]) || 0;
          var systemEstThisMonth = runBal2 + (pInv2.includesCurrentMonthDelivery ? thisMonthOrderForAdj : 0);
          cAdj = Math.round(pInv2.count - systemEstThisMonth);
          st = pInv2.count;
          isCM = true;
          countApplied2 = true;
          var cA = 0;
          pAllDailys.forEach(function (d) {
            if (d.date && d.date > pInv2.date && d.date.startsWith(md4.ym) && d.feed_type === ftKey)
              cA += parseFloat(d.feed_lbs) || 0;
          });
          var pR = 0;
          if (md4.isCurrent && pDaysLeft > 0) pR = Math.round(md4[projKey] * (pDaysLeft / md4.daysInMonth));
          // When delivery is already absorbed into the count value, don't add this month's order again.
          var cons = Math.round(cA + pR);
          var ord = pInv2.includesCurrentMonthDelivery ? 0 : thisMonthOrderForAdj;
          var en = Math.round(st - cons + ord);
          pLedger[type][md4.ym] = {
            start: st,
            consumed: cons,
            actualCons: Math.round(cA),
            projCons: Math.round(pR),
            ordered: ord,
            rawOrdered: thisMonthOrderForAdj,
            end: en,
            countMonth: true,
            countAdj: cAdj,
            proj: md4[projKey],
            actual: md4[actualKey],
          };
          runBal2 = en;
          continue;
        } else if (iYM < md4.ym) {
          st = pInv2.count;
          countApplied2 = true;
        }
      }
      var aCtual = md4[actualKey];
      var pRoj = 0;
      if (md4.isCurrent && pDaysLeft > 0) pRoj = Math.round(md4[projKey] * (pDaysLeft / md4.daysInMonth));
      else if (md4.isFuture) {
        pRoj = md4[projKey];
        aCtual = 0;
      }
      var cons2 = Math.round(aCtual + pRoj);
      var ord2 = parseFloat((feedOrders[orderKey] || {})[md4.ym]) || 0;
      var en2 = Math.round(st - cons2 + ord2);
      pLedger[type][md4.ym] = {
        start: Math.round(st),
        consumed: cons2,
        actualCons: Math.round(aCtual),
        projCons: Math.round(pRoj),
        ordered: ord2,
        end: en2,
        countMonth: isCM,
        countAdj: cAdj,
        proj: md4[projKey],
        actual: md4[actualKey],
      };
      runBal2 = en2;
    }
  });

  // Top-level aggregates for cards
  var pInv = poultryFeedInventory;
  var curLgS = pLedger.starter[thisYM];
  var curLgG = pLedger.grower[thisYM];
  var curLgL = pLedger.layer[thisYM];
  var pActualOnHand = null;
  var pEndOfMonth = null;
  if (curLgS || curLgG || curLgL) {
    // Actual on hand = start of month - actual consumed so far (no projected, no current month order)
    var aohS = curLgS ? Math.round(curLgS.start - curLgS.actualCons) : null;
    var aohG = curLgG ? Math.round(curLgG.start - curLgG.actualCons) : null;
    var aohL = curLgL ? Math.round(curLgL.start - curLgL.actualCons) : null;
    pActualOnHand = {starter: aohS, grower: aohG, layer: aohL, total: (aohS || 0) + (aohG || 0) + (aohL || 0)};
    pEndOfMonth = {
      starter: curLgS ? curLgS.end : null,
      grower: curLgG ? curLgG.end : null,
      layer: curLgL ? curLgL.end : null,
      total: (curLgS ? curLgS.end : 0) + (curLgG ? curLgG.end : 0) + (curLgL ? curLgL.end : 0),
    };
  }
  // Suggested order — auto-detect: all 3 types must have current month order before cycling to next
  var pCurHasAllOrders =
    (feedOrders.starter || {})[thisYM] != null &&
    (feedOrders.grower || {})[thisYM] != null &&
    (feedOrders.layerfeed || {})[thisYM] != null;
  var pOrderOffset = pCurHasAllOrders ? 1 : 0;
  var pOrderTarget = new Date(today.getFullYear(), today.getMonth() + pOrderOffset, 1);
  var pOrderTargetYM = pOrderTarget.getFullYear() + '-' + String(pOrderTarget.getMonth() + 1).padStart(2, '0');
  var pOrderTargetLabel = pOrderTarget.toLocaleDateString('en-US', {month: 'short'});
  var pOrderTargetMD = monthlyData.find(function (m) {
    return m.ym === pOrderTargetYM;
  });
  var pNextMonth = new Date(today.getFullYear(), today.getMonth() + pOrderOffset, 1);
  var pMonthAfter = new Date(today.getFullYear(), today.getMonth() + pOrderOffset + 1, 1);
  var pMonthAfterYM = pMonthAfter.getFullYear() + '-' + String(pMonthAfter.getMonth() + 1).padStart(2, '0');
  var pMonthAfterMD = monthlyData.find(function (m) {
    return m.ym === pMonthAfterYM;
  });
  var pSugOrder = null;
  if (pEndOfMonth || !pCurHasAllOrders) {
    var pBase = pEndOfMonth || {starter: 0, grower: 0, layer: 0};
    // If ordering for current month, base is previous month end (start of current month)
    if (!pCurHasAllOrders && curLgS) {
      pBase = {starter: curLgS ? curLgS.start : 0, grower: curLgG ? curLgG.start : 0, layer: curLgL ? curLgL.start : 0};
    }
    var sNeed = (pOrderTargetMD ? pOrderTargetMD.starter : 0) + (pMonthAfterMD ? pMonthAfterMD.starter : 0);
    var gNeed = (pOrderTargetMD ? pOrderTargetMD.grower : 0) + (pMonthAfterMD ? pMonthAfterMD.grower : 0);
    var lNeed = (pOrderTargetMD ? pOrderTargetMD.layerFeed : 0) + (pMonthAfterMD ? pMonthAfterMD.layerFeed : 0);
    pSugOrder = {
      starter: Math.max(0, sNeed - (pBase.starter || 0)),
      grower: Math.max(0, gNeed - (pBase.grower || 0)),
      layer: Math.max(0, lNeed - (pBase.layer || 0)),
      sNeed: sNeed,
      gNeed: gNeed,
      lNeed: lNeed,
    };
    pSugOrder.total = pSugOrder.starter + pSugOrder.grower + pSugOrder.layer;
  }

  var expandedMonths2 = poultryFeedExpandedMonths;
  function toggleMonth2(ym) {
    setPoultryFeedExpandedMonths(function (s) {
      var n = new Set(s);
      n.has(ym) ? n.delete(ym) : n.add(ym);
      return n;
    });
  }

  // ── Snapshot-anchored order board (feedPlanner.js) ──
  // First-screen answer to "How much feed do I need to order?" for each
  // poultry feed type. Burn is per-type from poultryDailyBurnLbs, which
  // uses the same broiler/layer schedule helpers as the legacy monthly
  // projection (no rate-formula change). On-hand is snapshot − consumed-
  // since-snapshot from broiler_dailys + layer_dailys filtered by feed_type.
  function poultryBurnFnFor(type) {
    return function (dateISO) {
      var out = poultryDailyBurnLbs(dateISO, {
        batches: activeBroilers,
        layerBatches: activeLayerBatchesForFeed,
        layerHousings: layerHousings || [],
        layerDailys: allLayerDailys || [],
      });
      if (type === 'starter') return out.starterLbs;
      if (type === 'grower') return out.growerLbs;
      return out.layerLbs;
    };
  }
  function poultryConsumedFnFor(type) {
    var match = type === 'starter' ? 'STARTER' : type === 'grower' ? 'GROWER' : 'LAYER';
    return function (fromISO, toISO_) {
      var sum = 0;
      var src = (broilerDailys || []).concat(allLayerDailys || []);
      for (var i = 0; i < src.length; i++) {
        var d = src[i];
        if (!d.date || d.date <= fromISO || d.date > toISO_) continue;
        if (d.feed_type !== match) continue;
        sum += parseFloat(d.feed_lbs) || 0;
      }
      return sum;
    };
  }
  var orderBoardRowDefs = [
    {key: 'starter', label: 'Starter', invKey: 'starter', ordKey: 'starter', color: '#1d4ed8'},
    {key: 'grower', label: 'Grower', invKey: 'grower', ordKey: 'grower', color: '#085041'},
    {key: 'layer', label: 'Layer Feed', invKey: 'layer', ordKey: 'layerfeed', color: '#78350f'},
  ];
  var orderBoardRows = orderBoardRowDefs.map(function (row) {
    var inv = poultryFeedInventory && poultryFeedInventory[row.invKey];
    var hasSnapshot = !!(inv && inv.date);
    var burnFn = poultryBurnFnFor(row.key);
    var consumedFn = poultryConsumedFnFor(row.key);
    var onHand = hasSnapshot
      ? onHandFromSnapshot({
          snapshotLbs: parseFloat(inv.count) || 0,
          snapshotDateISO: inv.date,
          todayISO: todayDate,
          consumedLbsFn: consumedFn,
          burnRateFn: burnFn,
        })
      : null;
    var stale = hasSnapshot ? isSnapshotStale({snapshotDateISO: inv.date, todayISO: todayDate}) : false;
    var suggestion = suggestOrder({
      onHandLbs: onHand == null ? 0 : onHand,
      todayISO: todayDate,
      burnRateFn: burnFn,
    });
    var curOrder = (feedOrders[row.ordKey] || {})[thisYM];
    var curHasOrder = curOrder != null && curOrder !== '';
    return Object.assign({}, row, {
      inv: inv,
      hasSnapshot: hasSnapshot,
      onHand: onHand,
      stale: stale,
      suggestion: suggestion,
      curOrder: curOrder,
      curHasOrder: curHasOrder,
    });
  });
  function applyPoultrySuggestion(row) {
    if (!row.suggestion || row.suggestion.suggestedOrderLbs <= 0) return;
    if (row.curHasOrder && confirmPoultrySuggested !== row.key) {
      setConfirmPoultrySuggested(row.key);
      return;
    }
    savePoultryOrder(row.ordKey, thisYM, String(row.suggestion.suggestedOrderLbs));
    setConfirmPoultrySuggested(null);
  }
  var thisMonthLabel = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
  var anyPoultryStale = orderBoardRows.some(function (r) {
    return r.stale;
  });
  var anyPoultryMissingSnapshot = orderBoardRows.some(function (r) {
    return !r.hasSnapshot;
  });

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
        {/* Snapshot-anchored order board — first-screen "How much feed do I need to order?" */}
        <div style={{background: 'white', border: '2px solid #085041', borderRadius: 12, padding: '14px 18px'}}>
          <div
            style={{
              fontSize: 11,
              color: '#085041',
              textTransform: 'uppercase',
              letterSpacing: 0.8,
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            Feed order
          </div>
          <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 13}}>
            <thead>
              <tr style={{borderBottom: '1px solid #e5e7eb'}}>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Type
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Est on hand
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Runway
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Order by
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Suggested
                </th>
                <th
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#6b7280',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {orderBoardRows.map(function (r) {
                var sug = r.suggestion;
                var late = sug && sug.orderIsLate;
                var sugLbs = sug ? sug.suggestedOrderLbs : 0;
                var confirmThis = confirmPoultrySuggested === r.key;
                return (
                  <tr key={r.key} style={{borderBottom: '1px solid #f3f4f6'}}>
                    <td style={{padding: '10px 8px', fontWeight: 700, color: r.color}}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: r.color,
                          marginRight: 8,
                        }}
                      />
                      {r.label}
                    </td>
                    <td style={{padding: '10px 8px', textAlign: 'right'}}>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 700,
                          color: r.hasSnapshot ? '#111827' : '#9ca3af',
                          fontStyle: r.hasSnapshot ? 'normal' : 'italic',
                        }}
                      >
                        {r.onHand != null ? Math.round(r.onHand).toLocaleString() + ' lbs' : 'No count'}
                      </div>
                      <div style={{fontSize: 9, color: '#9ca3af'}}>
                        {r.hasSnapshot ? 'Counted ' + fmt(r.inv.date) : 'estimated'}
                      </div>
                    </td>
                    <td style={{padding: '10px 8px', textAlign: 'right'}}>
                      <div style={{fontSize: 15, fontWeight: 700, color: late ? '#b91c1c' : '#111827'}}>
                        {sug ? sug.daysOfRunway + 'd' : '—'}
                      </div>
                    </td>
                    <td style={{padding: '10px 8px', textAlign: 'right'}}>
                      <div style={{fontSize: 13, fontWeight: 600, color: late ? '#b91c1c' : '#111827'}}>
                        {sug ? fmt(sug.orderByDateISO) : '—'}
                      </div>
                      {late && <div style={{fontSize: 9, color: '#b91c1c', fontWeight: 600}}>Late</div>}
                    </td>
                    <td style={{padding: '10px 8px', textAlign: 'right'}}>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: sugLbs > 0 ? '#92400e' : '#065f46',
                          fontStyle: r.hasSnapshot ? 'normal' : 'italic',
                        }}
                      >
                        {sug ? (sugLbs > 0 ? sugLbs.toLocaleString() : 'Surplus') : '—'}
                      </div>
                      <div style={{fontSize: 9, color: '#9ca3af'}}>
                        {r.hasSnapshot
                          ? r.stale
                            ? 'Recount soon (>' + STALE_SNAPSHOT_DAYS + 'd)'
                            : LEAD_TIME_DAYS + 'd + ' + RESERVE_DAYS.default + 'd horizon'
                          : 'enter count'}
                      </div>
                    </td>
                    <td style={{padding: '10px 8px', textAlign: 'right'}}>
                      <button
                        type="button"
                        onClick={function () {
                          applyPoultrySuggestion(r);
                        }}
                        disabled={!sug || sugLbs <= 0}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 7,
                          border: 'none',
                          background: confirmThis ? '#b91c1c' : '#085041',
                          color: 'white',
                          fontWeight: 700,
                          fontSize: 12,
                          cursor: sug && sugLbs > 0 ? 'pointer' : 'not-allowed',
                          opacity: sug && sugLbs > 0 ? 1 : 0.5,
                          fontFamily: 'inherit',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {!sug || sugLbs <= 0
                          ? 'None'
                          : confirmThis
                            ? 'Confirm: ' +
                              (parseFloat(r.curOrder) || 0).toLocaleString() +
                              ' → ' +
                              sugLbs.toLocaleString()
                            : r.curHasOrder
                              ? 'Use (replace ' + (parseFloat(r.curOrder) || 0).toLocaleString() + ')'
                              : 'Use suggested'}
                      </button>
                      <div style={{fontSize: 9, color: '#9ca3af', marginTop: 3}}>{'→ ' + thisMonthLabel}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(anyPoultryStale || anyPoultryMissingSnapshot) && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 12px',
                background: anyPoultryMissingSnapshot ? '#f3f4f6' : '#fef3c7',
                border: anyPoultryMissingSnapshot ? '1px dashed #d1d5db' : '1px solid #fde68a',
                borderRadius: 8,
                fontSize: 12,
                color: anyPoultryMissingSnapshot ? '#4b5563' : '#92400e',
              }}
            >
              {anyPoultryMissingSnapshot
                ? 'One or more feed types have no physical count — those suggestions are estimated. Enter the lbs on hand below for precise orders.'
                : 'A snapshot is more than ' + STALE_SNAPSHOT_DAYS + ' days old — recount recommended for accuracy.'}
            </div>
          )}
        </div>

        {/* Show/hide legacy monthly ledger */}
        <button
          type="button"
          onClick={function () {
            setShowPoultryLegacyLedger(function (s) {
              return !s;
            });
          }}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            background: 'transparent',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            fontSize: 12,
            color: '#4b5563',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {showPoultryLegacyLedger ? '▼ Hide monthly ledger' : '▶ Show monthly ledger'}
        </button>

        {/* Compact feed summary table — one row per type (legacy ledger) */}
        {showPoultryLegacyLedger && (
          <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 13}}>
              <thead>
                <tr style={{borderBottom: '1px solid #e5e7eb', background: '#f9fafb'}}>
                  <th
                    style={{
                      padding: '8px 16px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: '#6b7280',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Feed Type
                  </th>
                  <th
                    style={{
                      padding: '8px 12px',
                      textAlign: 'right',
                      fontWeight: 600,
                      color: '#6b7280',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    On Hand
                  </th>
                  <th
                    style={{
                      padding: '8px 12px',
                      textAlign: 'right',
                      fontWeight: 600,
                      color: '#6b7280',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    End of Mo Est.
                  </th>
                  <th
                    style={{
                      padding: '8px 12px',
                      textAlign: 'right',
                      fontWeight: 600,
                      color: pSugOrder && pSugOrder.total > 0 ? '#92400e' : '#6b7280',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {'Order for ' + pOrderTargetLabel}
                  </th>
                  <th
                    style={{
                      padding: '8px 12px',
                      textAlign: 'right',
                      fontWeight: 600,
                      color: '#6b7280',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {'Need thru ' + pMonthAfter.toLocaleDateString('en-US', {month: 'short'})}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: 'Starter',
                    key: 'starter',
                    color: '#1d4ed8',
                    aoh: pActualOnHand ? pActualOnHand.starter : null,
                    eom: pEndOfMonth ? pEndOfMonth.starter : null,
                    sug: pSugOrder ? pSugOrder.starter : null,
                    need: pSugOrder ? pSugOrder.sNeed : null,
                    m1: pOrderTargetMD ? pOrderTargetMD.starter : 0,
                    m2: pMonthAfterMD ? pMonthAfterMD.starter : 0,
                    countAdj: curLgS && curLgS.countMonth ? curLgS.countAdj : null,
                    countDate: pInv && pInv.starter ? pInv.starter.date : null,
                  },
                  {
                    label: 'Grower',
                    key: 'grower',
                    color: '#085041',
                    aoh: pActualOnHand ? pActualOnHand.grower : null,
                    eom: pEndOfMonth ? pEndOfMonth.grower : null,
                    sug: pSugOrder ? pSugOrder.grower : null,
                    need: pSugOrder ? pSugOrder.gNeed : null,
                    m1: pOrderTargetMD ? pOrderTargetMD.grower : 0,
                    m2: pMonthAfterMD ? pMonthAfterMD.grower : 0,
                    countAdj: curLgG && curLgG.countMonth ? curLgG.countAdj : null,
                    countDate: pInv && pInv.grower ? pInv.grower.date : null,
                  },
                  {
                    label: 'Layer Feed',
                    key: 'layer',
                    color: '#78350f',
                    aoh: pActualOnHand ? pActualOnHand.layer : null,
                    eom: pEndOfMonth ? pEndOfMonth.layer : null,
                    sug: pSugOrder ? pSugOrder.layer : null,
                    need: pSugOrder ? pSugOrder.lNeed : null,
                    m1: pOrderTargetMD ? pOrderTargetMD.layerFeed : 0,
                    m2: pMonthAfterMD ? pMonthAfterMD.layerFeed : 0,
                    countAdj: curLgL && curLgL.countMonth ? curLgL.countAdj : null,
                    countDate: pInv && pInv.layer ? pInv.layer.date : null,
                  },
                ].map(function (ft) {
                  return React.createElement(
                    'tr',
                    {key: ft.label, style: {borderBottom: '1px solid #f3f4f6'}},
                    React.createElement(
                      'td',
                      {style: {padding: '10px 16px', fontWeight: 700, color: ft.color, fontSize: 13}},
                      React.createElement('span', {
                        style: {
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: ft.color,
                          marginRight: 8,
                        },
                      }),
                      ft.label,
                    ),
                    React.createElement(
                      'td',
                      {style: {padding: '10px 12px', textAlign: 'right'}},
                      React.createElement(
                        'div',
                        {
                          style: {
                            fontSize: 15,
                            fontWeight: 700,
                            color: ft.aoh != null ? (ft.aoh > 0 ? '#065f46' : '#b91c1c') : '#9ca3af',
                          },
                        },
                        ft.aoh != null ? ft.aoh.toLocaleString() : '\u2014',
                      ),
                      ft.countDate &&
                        React.createElement(
                          'div',
                          {style: {fontSize: 9, color: '#9ca3af'}},
                          'Count: ' + fmt(ft.countDate),
                        ),
                      ft.countAdj != null &&
                        ft.countAdj !== 0 &&
                        React.createElement(
                          'div',
                          {style: {fontSize: 9, color: ft.countAdj > 0 ? '#065f46' : '#b91c1c'}},
                          'Adj ' + (ft.countAdj > 0 ? '+' : '') + ft.countAdj.toLocaleString(),
                        ),
                    ),
                    React.createElement(
                      'td',
                      {
                        style: {
                          padding: '10px 12px',
                          textAlign: 'right',
                          fontSize: 15,
                          fontWeight: 700,
                          color: ft.eom != null ? (ft.eom > 0 ? '#065f46' : '#b91c1c') : '#9ca3af',
                        },
                      },
                      ft.eom != null ? ft.eom.toLocaleString() : '\u2014',
                    ),
                    React.createElement(
                      'td',
                      {
                        style: {
                          padding: '10px 12px',
                          textAlign: 'right',
                          fontSize: 15,
                          fontWeight: 700,
                          color: ft.sug > 0 ? '#92400e' : '#065f46',
                          background: ft.sug > 0 ? '#fffbeb' : 'transparent',
                        },
                      },
                      ft.sug != null ? (ft.sug > 0 ? ft.sug.toLocaleString() : '\u2713 Surplus') : '\u2014',
                    ),
                    React.createElement(
                      'td',
                      {style: {padding: '10px 12px', textAlign: 'right'}},
                      React.createElement(
                        'div',
                        {style: {fontSize: 12, color: '#6b7280', fontWeight: 600}},
                        ft.need != null ? ft.need.toLocaleString() : '\u2014',
                      ),
                      React.createElement(
                        'div',
                        {style: {fontSize: 10, color: '#9ca3af'}},
                        ft.m1.toLocaleString() +
                          ' (' +
                          pOrderTargetLabel +
                          ') + ' +
                          ft.m2.toLocaleString() +
                          ' (' +
                          pMonthAfter.toLocaleDateString('en-US', {month: 'short'}) +
                          ')',
                      ),
                    ),
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Physical count input */}
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '12px 20px'}}>
          <div style={{display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap'}}>
            <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563', alignSelf: 'center'}}>
              {pInv && (pInv.starter || pInv.grower || pInv.layer) ? 'Update Physical Count' : 'Enter Physical Count'}
            </div>
            <div>
              <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>Feed type</label>
              <select
                id="poultry-feed-count-type"
                value={countType}
                onChange={(e) => setCountType(e.target.value)}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                }}
              >
                <option value="starter">Starter</option>
                <option value="grower">Grower</option>
                <option value="layer">Layer Feed</option>
              </select>
            </div>
            <div>
              <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>Lbs on hand</label>
              <input
                id="poultry-feed-count-input"
                type="number"
                min="0"
                step="100"
                placeholder="e.g. 2000"
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  width: 100,
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <div>
              <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>Date</label>
              <input
                id="poultry-feed-count-date"
                type="date"
                defaultValue={todayDate}
                style={{
                  fontSize: 13,
                  padding: '7px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <button
              onClick={function () {
                var el = document.getElementById('poultry-feed-count-input');
                var dl = document.getElementById('poultry-feed-count-date');
                if (!el || !el.value) {
                  alert('Enter the lbs on hand.');
                  return;
                }
                savePoultryFeedCount(countType, el.value, dl ? dl.value : todayDate);
                el.value = '';
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
          </div>
        </div>

        {/* Monthly summary — current first, then future, then past by year (legacy ledger) */}
        {showPoultryLegacyLedger &&
          (function () {
            // Render a single month card — ledger format
            function renderMonthCard(md) {
              var lgS = pLedger.starter[md.ym];
              var lgG = pLedger.grower[md.ym];
              var lgL = pLedger.layer[md.ym];
              var types = [
                {
                  key: 'starter',
                  label: 'Starter',
                  color: '#1d4ed8',
                  ordKey: 'starter',
                  lg: lgS,
                  proj: md.starter,
                  actual: md.actualStarter,
                },
                {
                  key: 'grower',
                  label: 'Grower',
                  color: '#085041',
                  ordKey: 'grower',
                  lg: lgG,
                  proj: md.grower,
                  actual: md.actualGrover,
                },
                {
                  key: 'layer',
                  label: 'Layer Feed',
                  color: '#78350f',
                  ordKey: 'layerfeed',
                  lg: lgL,
                  proj: md.layerFeed,
                  actual: md.actualLayer,
                },
              ];
              var daysElapsed = md.isFuture ? 0 : md.isCurrent ? today.getDate() : md.daysInMonth;
              return React.createElement(
                'div',
                {
                  key: md.ym,
                  style: {
                    background: 'white',
                    border: md.isCurrent ? '2px solid #085041' : '1px solid #e5e7eb',
                    borderRadius: 12,
                    overflow: 'hidden',
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      padding: '10px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: md.isCurrent ? '#ecfdf5' : md.isFuture ? '#f8fafc' : 'white',
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 14, fontWeight: 700, color: '#111827'}},
                    fmtMonth(md.ym),
                  ),
                  md.isCurrent &&
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
                  md.isFuture && React.createElement('span', {style: {fontSize: 10, color: '#9ca3af'}}, 'projected'),
                ),
                // Ledger table per feed type
                React.createElement(
                  'div',
                  {style: {padding: '0 16px 8px'}},
                  React.createElement(
                    'table',
                    {style: {width: '100%', borderCollapse: 'collapse', fontSize: 12}},
                    React.createElement(
                      'thead',
                      null,
                      React.createElement(
                        'tr',
                        {style: {borderBottom: '1px solid #e5e7eb'}},
                        React.createElement(
                          'th',
                          {
                            style: {
                              padding: '6px 0',
                              textAlign: 'left',
                              fontWeight: 600,
                              color: '#6b7280',
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              width: 90,
                            },
                          },
                          'Feed Type',
                        ),
                        React.createElement(
                          'th',
                          {
                            style: {
                              padding: '6px 8px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: '#6b7280',
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            },
                          },
                          'Start',
                        ),
                        React.createElement(
                          'th',
                          {
                            style: {
                              padding: '6px 8px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: '#6b7280',
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            },
                          },
                          'Consumed',
                        ),
                        React.createElement(
                          'th',
                          {
                            style: {
                              padding: '6px 8px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: '#6b7280',
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              width: 90,
                            },
                          },
                          'Ordered',
                        ),
                        React.createElement(
                          'th',
                          {
                            style: {
                              padding: '6px 8px',
                              textAlign: 'right',
                              fontWeight: 600,
                              color: '#6b7280',
                              fontSize: 10,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                            },
                          },
                          'End of Mo',
                        ),
                      ),
                    ),
                    React.createElement(
                      'tbody',
                      null,
                      types.map(function (t) {
                        var lg = t.lg;
                        var ordRaw = (feedOrders[t.ordKey] || {})[md.ym];
                        var ordVal = ordRaw != null && ordRaw !== '' ? ordRaw : '';
                        return React.createElement(
                          'tr',
                          {key: t.key, style: {borderBottom: '1px solid #f3f4f6'}},
                          React.createElement(
                            'td',
                            {style: {padding: '7px 0', fontWeight: 600, color: t.color, fontSize: 12}},
                            t.label,
                          ),
                          React.createElement(
                            'td',
                            {style: {padding: '7px 8px', textAlign: 'right', color: lg ? '#374151' : '#9ca3af'}},
                            lg ? lg.start.toLocaleString() : '\u2014',
                          ),
                          React.createElement(
                            'td',
                            {style: {padding: '7px 8px', textAlign: 'right', color: '#111827'}},
                            lg
                              ? React.createElement(
                                  'span',
                                  null,
                                  lg.consumed.toLocaleString(),
                                  md.isCurrent && lg.projCons > 0
                                    ? React.createElement(
                                        'span',
                                        {style: {fontSize: 10, color: '#9ca3af', marginLeft: 4}},
                                        '(' +
                                          lg.actualCons.toLocaleString() +
                                          '+' +
                                          lg.projCons.toLocaleString() +
                                          'p)',
                                      )
                                    : null,
                                )
                              : '\u2014',
                          ),
                          React.createElement(
                            'td',
                            {
                              style: {padding: '7px 8px', textAlign: 'right'},
                              onClick: function (e) {
                                e.stopPropagation();
                              },
                            },
                            React.createElement('input', {
                              type: 'number',
                              min: '0',
                              step: '100',
                              value: ordVal,
                              onChange: function (e) {
                                savePoultryOrder(t.ordKey, md.ym, e.target.value);
                              },
                              placeholder: '0',
                              style: {
                                width: 80,
                                fontSize: 12,
                                padding: '4px 8px',
                                border: '1px solid #d1d5db',
                                borderRadius: 6,
                                textAlign: 'right',
                                fontFamily: 'inherit',
                              },
                            }),
                          ),
                          React.createElement(
                            'td',
                            {
                              style: {
                                padding: '7px 8px',
                                textAlign: 'right',
                                fontWeight: 700,
                                color: lg ? (lg.end > 0 ? '#065f46' : '#b91c1c') : '#9ca3af',
                              },
                            },
                            lg ? lg.end.toLocaleString() : '\u2014',
                          ),
                        );
                      }),
                    ),
                  ),
                ),
                null,
              );
            }

            // Split months into current, future, past
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
              .reverse(); // newest first

            // Group past months by year
            var pastByYear = {};
            pastMonths.forEach(function (m) {
              var yr = m.ym.substring(0, 4);
              if (!pastByYear[yr]) pastByYear[yr] = [];
              pastByYear[yr].push(m);
            });
            var pastYears = Object.keys(pastByYear).sort().reverse(); // newest year first

            var secToggle = poultryFeedExpandedMonths;
            function togSec(key) {
              setPoultryFeedExpandedMonths(function (s) {
                var n = new Set(s);
                n.has(key) ? n.delete(key) : n.add(key);
                return n;
              });
            }

            return React.createElement(
              'div',
              {style: {display: 'flex', flexDirection: 'column', gap: '1.25rem'}},
              // Section header
              React.createElement(
                'div',
                {style: {fontSize: 14, fontWeight: 700, color: '#085041'}},
                'Monthly Poultry Feed Summary',
              ),

              // Current month — always visible
              currentMonth.length > 0 && React.createElement('div', null, currentMonth.map(renderMonthCard)),

              // Future months — collapsible
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
                      futureMonths.map(renderMonthCard),
                    ),
                ),

              // Past months — collapsible, grouped by year
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
                    React.createElement(
                      'span',
                      {style: {fontSize: 11, color: '#9ca3af'}},
                      '(' + pastMonths.length + ')',
                    ),
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
                              React.createElement(
                                'span',
                                {style: {fontSize: 12, fontWeight: 600, color: '#6b7280'}},
                                yr,
                              ),
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
                              yearMonths.map(renderMonthCard),
                            ),
                        );
                      }),
                    ),
                ),
            );
          })()}

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
            var autoSt = calcPoultryStatus(b);
            return React.createElement(
              'div',
              {key: b.id, style: {borderBottom: '1px solid #e5e7eb'}},
              React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 16px',
                    background: '#f9fafb',
                    flexWrap: 'wrap',
                  },
                },
                React.createElement('span', {
                  style: {
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: C.bg,
                    border: '1px solid ' + C.bd,
                  },
                }),
                React.createElement(
                  'div',
                  {style: {fontWeight: 600, fontSize: 13, color: '#1a1a1a', minWidth: 100}},
                  b.name,
                ),
                React.createElement(
                  'span',
                  {
                    style: S.badge(
                      (BREED_STYLE[b.breed] || BREED_STYLE.CC).bg,
                      (BREED_STYLE[b.breed] || BREED_STYLE.CC).tx,
                    ),
                  },
                  breedLabel(b.breed),
                ),
                React.createElement('span', {style: S.badge('#f3f4f6', '#374151')}, 'Schooner ' + b.schooner),
                React.createElement('span', {style: {fontSize: 12, color: '#4b5563'}}, 'Hatch: ' + fmt(b.hatchDate)),
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
                        color: '#085041',
                        background: '#ecfdf5',
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
                    {label: 'Starter', proj: starter, act: actStarter, color: '#1d4ed8'},
                    {label: 'Grower', proj: grower, act: actGrower, color: '#085041'},
                    {label: 'Total', proj: total, act: actTotal, color: '#1a1a1a'},
                  ].map(function (col) {
                    var diff = col.act - col.proj;
                    return React.createElement(
                      'div',
                      {key: col.label, style: {textAlign: 'center'}},
                      React.createElement(
                        'div',
                        {style: {fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5}},
                        col.label,
                      ),
                      React.createElement(
                        'div',
                        {style: {display: 'flex', gap: 6, alignItems: 'baseline', justifyContent: 'center'}},
                        React.createElement(
                          'span',
                          {style: {fontSize: 13, fontWeight: 700, color: col.color}},
                          col.proj.toLocaleString(),
                        ),
                        React.createElement('span', {style: {fontSize: 10, color: '#9ca3af'}}, '/'),
                        React.createElement(
                          'span',
                          {style: {fontSize: 13, fontWeight: 700, color: col.act > 0 ? '#111827' : '#9ca3af'}},
                          col.act > 0 ? col.act.toLocaleString() : '\u2014',
                        ),
                      ),
                      col.act > 0 &&
                        React.createElement(
                          'div',
                          {style: {fontSize: 10, fontWeight: 600, color: diff > 0 ? '#b91c1c' : '#065f46'}},
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
                      {style: {background: '#ecfdf5'}},
                      React.createElement(
                        'th',
                        {
                          style: {
                            padding: '5px 12px',
                            textAlign: 'left',
                            fontWeight: 600,
                            color: '#4b5563',
                            whiteSpace: 'nowrap',
                          },
                        },
                        'Week',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '5px 12px', textAlign: 'left', fontWeight: 600, color: '#4b5563'}},
                        'Phase',
                      ),
                      React.createElement(
                        'th',
                        {style: {padding: '5px 12px', textAlign: 'left', fontWeight: 600, color: '#4b5563'}},
                        'Location',
                      ),
                      React.createElement(
                        'th',
                        {
                          style: {
                            padding: '5px 12px',
                            textAlign: 'right',
                            fontWeight: 600,
                            color: '#4b5563',
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
                            color: '#4b5563',
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
                          style: {
                            borderTop: '1px solid #e5e7eb',
                            background: w.phase === 'starter' ? '#f0f7ff' : '#f0faf5',
                          },
                        },
                        React.createElement('td', {style: {padding: '5px 12px', fontWeight: 500}}, 'Week ' + w.week),
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px'}},
                          React.createElement(
                            'span',
                            {
                              style: {
                                padding: '2px 7px',
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 600,
                                background: w.phase === 'starter' ? '#E6F1FB' : '#EAF3DE',
                                color: w.phase === 'starter' ? '#185FA5' : '#27500A',
                              },
                            },
                            w.phase === 'starter' ? 'Starter' : 'Grower',
                          ),
                        ),
                        React.createElement(
                          'td',
                          {style: {padding: '5px 12px', color: '#4b5563'}},
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
                      {style: {borderTop: '2px solid #ddd', background: '#ecfdf5', fontWeight: 600}},
                      React.createElement(
                        'td',
                        {colSpan: 4, style: {padding: '6px 12px', textAlign: 'right', color: '#4b5563'}},
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
              {style: {padding: '12px 16px', borderBottom: '1px solid #e5e7eb'}},
              React.createElement(
                'div',
                {style: {fontWeight: 600, fontSize: 14, color: '#085041'}},
                '\ud83d\udc14 Broiler Feed Estimate Per Batch',
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
                      color: '#065f46',
                      background: '#ecfdf5',
                      borderBottom: '1px solid #d1fae5',
                    },
                  },
                  'ACTIVE (' + activeBrFeed.length + ')',
                ),
                activeBrFeed.map(renderBroilerBatchFeed),
              ),
            activeBrFeed.length === 0 &&
              React.createElement(
                'div',
                {style: {padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: 13}},
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
                    onClick: function () {
                      togBr('proc');
                    },
                    style: {
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#4b5563',
                      background: '#f9fafb',
                      borderBottom: '1px solid #e5e7eb',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: '#9ca3af'}},
                    secT.has('proc') ? '\u25bc' : '\u25b6',
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
                    onClick: function () {
                      togBr('planned');
                    },
                    style: {
                      padding: '8px 16px',
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#4b5563',
                      background: '#f8fafc',
                      borderBottom: '1px solid #e5e7eb',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    },
                  },
                  React.createElement(
                    'span',
                    {style: {fontSize: 10, color: '#9ca3af'}},
                    secT.has('planned') ? '\u25bc' : '\u25b6',
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
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid #e5e7eb',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
            onClick={() =>
              setCollapsedBatches((s) => {
                const n = new Set(s);
                n.has('layers') ? n.delete('layers') : n.add('layers');
                return n;
              })
            }
          >
            <div style={{fontWeight: 600, fontSize: 14, color: '#78350f'}}>
              {'\ud83d\udc13 Layer Feed Estimate Per Batch'}
            </div>
            <span style={{fontSize: 12, color: '#9ca3af'}}>
              {collapsedBatches.has('layers') ? '\u25b6 expand' : '\u25bc collapse'}
            </span>
          </div>
          {!collapsedBatches.has('layers') && (
            <>
              {activeLayerBatchesForFeed.length === 0 && (
                <div style={{padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
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
                  var proj = computeProjectedCount(h, allLayerDailys || []);
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
                  <div key={b.id} style={{borderBottom: '1px solid #e5e7eb'}}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 16px',
                        background: '#fffbeb',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontSize: 14}}>{'\ud83d\udc13'}</span>
                      <div style={{fontWeight: 600, fontSize: 13, color: '#92400e', minWidth: 100}}>{b.name}</div>
                      <span style={S.badge('#fef3c7', '#92400e')}>{phase}</span>
                      {startDate && <span style={{fontSize: 11, color: '#6b7280'}}>Started: {fmt(startDate)}</span>}
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        {birdCount > 0 ? birdCount + ' birds' : 'no bird count'}
                      </span>
                      {hens !== birdCount && (
                        <span style={{fontSize: 11, color: '#6b7280'}}>{'\u2192 ' + hens + ' projected hens'}</span>
                      )}
                      <div style={{marginLeft: 'auto', display: 'flex', gap: 16, flexWrap: 'wrap'}}>
                        <div style={{textAlign: 'center'}}>
                          <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5}}>
                            Starter
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: '#1d4ed8'}}>
                            {Math.round(totalStarter).toLocaleString()} lbs
                          </div>
                        </div>
                        <div style={{textAlign: 'center'}}>
                          <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5}}>
                            Grower
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: '#085041'}}>
                            {Math.round(totalGrover).toLocaleString()} lbs
                          </div>
                        </div>
                        <div style={{textAlign: 'center'}}>
                          <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5}}>
                            Layer / Year
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: '#78350f'}}>
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
