import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {recordFieldRowClass, recordFieldLabel, recordControl, recordTextarea} from '../shared/recordPageControls.jsx';
import {
  PIG_GROUP_COLORS,
  getReadableText,
  buildCycleSeqMap,
  cycleLabel,
  calcBreedingTimeline,
  pigTransfersForSub,
  pigTransfersForBatch,
  pigTripPigsForSub,
  pigMortalityForSub,
  pigMortalityForBatch,
  calcAgeRange as libCalcAgeRange,
  parseLiveWeights,
  tripTotalLive,
  tripYield,
  computeSubLedgerCurrent,
  computeSubCurrentCount,
  computeBatchCurrentCount,
} from '../lib/pig.js';
import {
  PLANNED_TRIP_MIN_SIZE,
  PLANNED_TRIP_TARGET_WEIGHT_LBS,
  PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
  buildFarrowingAgeDistribution,
  projectFarrowingAgeWindow,
  recalculateProjections,
} from '../lib/pigForecast.js';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import PlannerIcon from '../components/PlannerIcon.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';

// PigBatchPage — the single-batch record workspace (CP11 file extraction from
// PigBatchesView). Pure relocation: the card JSX, mortality modal, and the
// RecordCollaborationSection mount are byte-identical to the prior inline
// render. Workflow logic still lives in the hooks (called by PigBatchesView and
// threaded in via the `view` bundle); shared PigContext is consumed directly
// here. PigBatchesView remains the hub/router and renders this only when
// recordGroup exists.
export default function PigBatchPage({group, view}) {
  const {authState} = useAuth();
  const {
    breedingCycles,
    breeders,
    farrowingRecs,
    feederGroups,
    setFeederForm,
    setOriginalFeederForm,
    setShowFeederForm,
    setEditFeederId,
    activeTripBatchId,
    setActiveTripBatchId,
    tripForm,
    setTripForm,
    editTripId,
    setEditTripId,
    boarNames,
  } = usePig();
  const {
    subAutoSaveTimer,
    isManager,
    notice,
    setNotice,
    effectiveAdgLbsPerDay,
    dailysForName,
    archiveBatch,
    unarchiveBatch,
    // mortality
    mortalityModal,
    setMortalityModal,
    mortalityForm,
    setMortalityForm,
    mortalityBusy,
    expandedMortality,
    setExpandedMortality,
    openMortalityModal,
    saveMortality,
    deleteMortality,
    // sub-batches
    showSubForm,
    setShowSubForm,
    subForm,
    setSubForm,
    editSubId,
    setEditSubId,
    archiveSubBatch,
    unarchiveSubBatch,
    updSub,
    closeSubForm,
    deleteSubBatch,
    // planned trips
    editingPlannedTripId,
    setEditingPlannedTripId,
    editingPlannedTripDate,
    setEditingPlannedTripDate,
    addingTripFor,
    setAddingTripFor,
    addingTripDate,
    setAddingTripDate,
    addingTripCount,
    setAddingTripCount,
    addingTripError,
    setAddingTripError,
    plannedTripLocks,
    unlockingTripId,
    setUnlockingTripId,
    isChainLocked,
    lockPlannedTrip,
    unlockPlannedTrip,
    setPlannedTripDateById,
    shiftPlannedTripDateById,
    movePlannedTripPigsById,
    addPlannedTripById,
    deletePlannedTripById,
    // processing trips
    tripSourceCounts,
    updTrip,
    closeTripForm,
    deleteTrip,
  } = view;

  // Local view-scoped derivations (were inline in PigBatchesView).
  const statusColors = {active: {bg: '#085041', tx: 'white'}, processed: {bg: '#4b5563', tx: 'white'}};
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);
  function calcAgeRange(cycleId, asOfDate) {
    return libCalcAgeRange(cycleId, asOfDate, breedingCycles, farrowingRecs);
  }

  return (
    <>
      {/* Mortality entry modal — overlay across the page */}
      {mortalityModal &&
        (() => {
          const target = feederGroups.find((g) => g.id === mortalityModal.batchId);
          if (!target) return null;
          const subs = (target.subBatches || []).filter((s) => s.status === 'active');
          return (
            <div
              onClick={() => {
                setNotice(null);
                setMortalityModal(null);
              }}
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,.45)',
                zIndex: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'white',
                  borderRadius: 12,
                  width: '100%',
                  maxWidth: 480,
                  boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                }}
              >
                <div
                  style={{
                    padding: '14px 20px',
                    borderBottom: '1px solid #e5e7eb',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div style={{fontSize: 15, fontWeight: 600, color: '#b91c1c'}}>
                    {'💀 Record Mortality — ' + target.batchName}
                  </div>
                  <button
                    onClick={() => {
                      setNotice(null);
                      setMortalityModal(null);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: 22,
                      cursor: 'pointer',
                      color: '#9ca3af',
                      lineHeight: 1,
                    }}
                  >
                    {'×'}
                  </button>
                </div>
                <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12}}>
                  <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
                  <div className={recordFieldRowClass}>
                    <span style={recordFieldLabel}>Sub-batch (optional)</span>
                    <select
                      value={mortalityForm.sub_batch_id}
                      onChange={(e) => setMortalityForm({...mortalityForm, sub_batch_id: e.target.value})}
                      style={recordControl}
                    >
                      <option value="">{'— Whole batch (no sub) —'}</option>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={recordFieldRowClass}>
                    <span style={recordFieldLabel}>{'Count *'}</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={mortalityForm.count}
                      onChange={(e) => setMortalityForm({...mortalityForm, count: e.target.value})}
                      placeholder="e.g. 1"
                      style={recordControl}
                    />
                  </div>
                  <div className={recordFieldRowClass}>
                    <span style={recordFieldLabel}>Comment / cause (optional)</span>
                    <textarea
                      value={mortalityForm.comment}
                      onChange={(e) => setMortalityForm({...mortalityForm, comment: e.target.value})}
                      rows={2}
                      placeholder="e.g. found dead in pen, suspected respiratory"
                      style={recordTextarea}
                    />
                  </div>
                  <div style={{fontSize: 11, color: '#6b7280'}}>
                    {'Stamped: ' +
                      todayISO() +
                      ' · ' +
                      ((authState && authState.user && authState.user.email) || 'unknown')}
                  </div>
                </div>
                <div
                  style={{
                    padding: '12px 20px',
                    borderTop: '1px solid #e5e7eb',
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    onClick={() => setMortalityModal(null)}
                    disabled={mortalityBusy}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 7,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: mortalityBusy ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveMortality}
                    disabled={mortalityBusy || !mortalityForm.count}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 7,
                      border: 'none',
                      background: mortalityBusy || !mortalityForm.count ? '#9ca3af' : '#b91c1c',
                      color: 'white',
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: mortalityBusy || !mortalityForm.count ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {mortalityBusy ? 'Saving…' : 'Save Mortality'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      {[group].map((g) => {
        const cycle = breedingCycles.find((c) => c.id === g.cycleId);
        const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
        const sc = statusColors[g.status] || statusColors.active;
        const C = cycle ? PIG_GROUP_COLORS[cycle.group] : null;
        const trips = g.processingTrips || [];
        const totalLive = trips.reduce((s, t) => s + tripTotalLive(t), 0);
        const totalHang = trips.reduce((s, t) => s + (parseFloat(t.hangingWeight) || 0), 0);
        // Carcass yield % only counts trips that have a hanging weight
        // entered. Otherwise a trip with no hanging data drags the
        // denominator (live wt) down without contributing to the
        // numerator, making the % look artificially low.
        const tripsWithHang = trips.filter((t) => (parseFloat(t.hangingWeight) || 0) > 0);
        const yieldHang = tripsWithHang.reduce((s, t) => s + (parseFloat(t.hangingWeight) || 0), 0);
        const yieldLive = tripsWithHang.reduce((s, t) => s + tripTotalLive(t), 0);
        const overallYield = yieldLive > 0 && yieldHang > 0 ? Math.round((yieldHang / yieldLive) * 1000) / 10 : null;
        // Sub-batches
        const subBatches = g.subBatches || [];
        const hasSubBatches = subBatches.length > 0;

        // Feed matching by label (case-insensitive) for parent batch
        const batchDailys = hasSubBatches ? [] : dailysForName(g.batchName);
        const dailyFeedTotal = batchDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
        const legacyFeed = parseFloat(g.legacyFeedLbs) || parseFloat(g.totalFeedLbs) || 0;

        // Per-sub ledger metrics. Started counts come from stored fields
        // (no longer mutated by transfers). Transfers + trip attribution
        // + mortality are derived from audit logs. Sub adjusted feed
        // subtracts the per-sub transfer credit (sourced from breeders[],
        // not the parent-aggregate g.feedAllocatedToTransfers, so sub
        // and parent reconcile cleanly).
        const subFeedTotals = subBatches.map((sb) => {
          const sd = dailysForName(sb.name);
          const rawFeedSub =
            sd.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0) + (parseFloat(sb.legacyFeedLbs) || 0);
          const latest =
            [...sd].sort(
              (a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0,
            )[0] || null;
          const transfers = pigTransfersForSub(breeders, g.batchName, sb.name);
          const tripPigs = pigTripPigsForSub(g.processingTrips || [], sb.id);
          const mortality = pigMortalityForSub(g, sb.name);
          const started = (parseInt(sb.giltCount) || 0) + (parseInt(sb.boarCount) || 0);
          // Ledger current + processed-aware current via the shared lib
          // helpers so hub + future record page derive these identically.
          const ledgerCurrent = computeSubLedgerCurrent(g, sb, breeders);
          const currentCount = computeSubCurrentCount(g, sb, breeders);
          const dailyCount = latest?.pig_count;
          const adjustedFeed = Math.max(0, rawFeedSub - transfers.feedAllocLbs);
          return {
            sb,
            dailys: sd,
            latestDaily: latest,
            started,
            rawFeed: rawFeedSub,
            transferFeedCredit: transfers.feedAllocLbs,
            adjustedFeed,
            feedTotal: adjustedFeed, // back-compat alias
            transferCount: transfers.count,
            tripPigs,
            mortality,
            ledgerCurrent,
            currentCount,
            dailyCount,
          };
        });
        const subAdjustedFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.adjustedFeed, 0);
        const subRawFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.rawFeed, 0);
        const rawFeed = hasSubBatches ? subRawFeedTotal + legacyFeed : dailyFeedTotal + legacyFeed;
        // Parent aggregate transfer credit: prefer sum-of-subs (canonical
        // from breeders[]); fall back to g.feedAllocatedToTransfers for
        // parent-only batches that never had subs.
        const subTransferFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.transferFeedCredit, 0);
        const parentTransferAgg = pigTransfersForBatch(breeders, g.batchName);
        const feedAllocatedOut = hasSubBatches
          ? subTransferFeedTotal
          : parentTransferAgg.feedAllocLbs || parseFloat(g.feedAllocatedToTransfers) || 0;
        const totalFeed = Math.max(0, rawFeed - feedAllocatedOut);

        // Current pig count: ledger-derived for batches with subs;
        // latest-daily fallback for parent-only batches (no sub
        // attribution available without weigh_in linkage).
        const sortedDailys = hasSubBatches
          ? subFeedTotals
              .flatMap((sf) => sf.dailys)
              .sort((a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0)
          : [...batchDailys].sort(
              (a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0,
            );
        const latestDaily = sortedDailys[0] || null;
        // Ledger-derived current count via the shared lib helper (sums
        // active sub currents when sub-batched; parent-only ledger with a
        // latest-daily fallback otherwise). One source for hub + record page.
        const currentPigCount = computeBatchCurrentCount(g, breeders, {
          latestDailyPigCount: latestDaily?.pig_count ?? null,
        });
        // Freeze age once the batch is empty AND has at least one
        // processor trip — pin the reference date to the latest trip
        // so age stops advancing while the batch lingers archived.
        // Mortality/transfer-only emptying does NOT freeze (no trip
        // date to pin to). If a trip is later edited away and current
        // > 0 again, age resumes using today.
        const latestTripDate =
          trips
            .map((t) => (typeof t?.date === 'string' && t.date ? t.date : null))
            .filter(Boolean)
            .sort()
            .slice(-1)[0] || null;
        const ageRange =
          currentPigCount === 0 && latestTripDate
            ? calcAgeRange(g.cycleId, new Date(latestTripDate + 'T12:00:00'))
            : calcAgeRange(g.cycleId);
        // Started count for denominators: sum-of-subs (for hasSubBatches)
        // or parent stored gilts+boars. Both are now stable across
        // transfers — they reflect what entered the batch.
        const originalPigCount = hasSubBatches
          ? subFeedTotals.reduce((s, sf) => s + sf.started, 0)
          : (parseInt(g.giltCount) || 0) + (parseInt(g.boarCount) || 0) || parseInt(g.originalPigCount) || 0;
        // Feed cost
        const perLbCost = parseFloat(g.perLbFeedCost) || 0;
        const totalFeedCost = totalFeed > 0 && perLbCost > 0 ? totalFeed * perLbCost : null;
        // Feed conversion ratio = total feed / total live weight produced.
        // Standard FCR definition (lbs feed per lb live weight). The old
        // hybrid (avg-feed-per-pig / avg-live-weight) drifted whenever
        // original-count and pigs-processed weren't equal.
        const pigsProcessed = trips.reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
        const feedConversion = totalFeed > 0 && totalLive > 0 ? Math.round((totalFeed / totalLive) * 100) / 100 : null;
        const showTripForm = activeTripBatchId === g.id;
        const farrowPct = ageRange.total > 0 ? Math.round((ageRange.count / ageRange.total) * 100) : 0;
        const processingForecastByTripId = (() => {
          if (!g.cycleId || effectiveAdgLbsPerDay == null) return {};
          const out = {};
          const shippedBySub = {};
          const subMetaById = {};
          for (const sf of subFeedTotals) {
            subMetaById[sf.sb.id] = {
              populationCount: Math.max(0, sf.started - sf.transferCount - sf.mortality),
            };
          }
          const tripsForForecast = [...trips].sort(
            (a, b) =>
              (a.date || '').localeCompare(b.date || '') ||
              (parseInt(a.order) || 0) - (parseInt(b.order) || 0) ||
              String(a.id || '').localeCompare(String(b.id || '')),
          );

          for (const trip of tripsForForecast) {
            const tripDate = typeof trip.date === 'string' ? trip.date : null;
            if (!tripDate) continue;
            const tripAgeRange = libCalcAgeRange(
              g.cycleId,
              new Date(tripDate + 'T12:00:00'),
              breedingCycles,
              farrowingRecs,
            );
            const cycleAgeDaysAtTrip =
              tripAgeRange && tripAgeRange.minDays != null
                ? {minDays: tripAgeRange.minDays, maxDays: tripAgeRange.maxDays}
                : null;
            const distribution = buildFarrowingAgeDistribution({
              cycleId: g.cycleId,
              asOfDate: tripDate,
              breedingCycles,
              farrowingRecs,
              cycleAgeDaysAtRef: cycleAgeDaysAtTrip,
            });
            const attributions = (Array.isArray(trip.subAttributions) ? trip.subAttributions : [])
              .map((a) => ({subId: a && a.subId, count: parseInt(a && a.count) || 0}))
              .filter((a) => a.subId && a.count > 0);

            if (attributions.length === 0) {
              if (cycleAgeDaysAtTrip) {
                const min = cycleAgeDaysAtTrip.minDays * effectiveAdgLbsPerDay;
                const max = cycleAgeDaysAtTrip.maxDays * effectiveAdgLbsPerDay;
                out[trip.id] = {
                  min: Math.min(min, max),
                  max: Math.max(min, max),
                  avg: (min + max) / 2,
                  source: 'estimated-cycle-band',
                  hasActual: !!(tripAgeRange && tripAgeRange.hasActual),
                };
              }
              continue;
            }

            let min = null;
            let max = null;
            let avgNumerator = 0;
            let countTotal = 0;
            let hasActual = false;
            let source = null;
            for (const a of attributions) {
              const meta = subMetaById[a.subId];
              const offset = shippedBySub[a.subId] || 0;
              shippedBySub[a.subId] = offset + a.count;
              if (!meta || !distribution) continue;
              const window = projectFarrowingAgeWindow(distribution, {
                populationCount: meta.populationCount,
                rankOffset: offset,
                windowCount: a.count,
              });
              if (!window) continue;
              const wMin = Math.min(window.minDays, window.maxDays) * effectiveAdgLbsPerDay;
              const wMax = Math.max(window.minDays, window.maxDays) * effectiveAdgLbsPerDay;
              min = min == null ? wMin : Math.min(min, wMin);
              max = max == null ? wMax : Math.max(max, wMax);
              avgNumerator += window.avgDays * effectiveAdgLbsPerDay * a.count;
              countTotal += a.count;
              hasActual = hasActual || !!window.hasActual;
              source = source || window.source;
            }
            if (countTotal > 0 && min != null && max != null) {
              out[trip.id] = {min, max, avg: avgNumerator / countTotal, source, hasActual};
            }
          }
          return out;
        })();

        return (
          <div
            key={g.id}
            style={{
              background: 'white',
              border: `1px solid ${C ? C.farrowing : '#e0e0e0'}`,
              borderRadius: 10,
              marginBottom: 14,
              overflow: 'hidden',
              fontSize: 12,
            }}
          >
            {/* Batch header */}
            {(() => {
              const headerBg = C ? C.boar : '#f9f9f9';
              const ht = getReadableText(headerBg);
              return (
                <div
                  style={{
                    padding: '12px 16px',
                    background: headerBg,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px 16px',
                    alignItems: 'center',
                  }}
                >
                  <strong style={{fontSize: 14, color: ht}}>{g.batchName}</strong>
                  {/* Farm-born batches carry no sex split — suppress the
                      misleading "Gilts: 0 / Boars: 0"; the neutral Started/Current
                      count below conveys the size. */}
                  {!g.farmBorn && <span style={S.badge('#065f46', 'white')}>Gilts: {g.giltCount}</span>}
                  {!g.farmBorn && <span style={S.badge('#1e40af', 'white')}>Boars: {g.boarCount}</span>}
                  {currentPigCount !== null ? (
                    <span style={{color: ht, fontWeight: 500}}>
                      Current: <strong>{currentPigCount}</strong>
                    </span>
                  ) : (
                    originalPigCount > 0 && <span style={{color: ht, opacity: 0.85}}>Started: {originalPigCount}</span>
                  )}
                  <span style={{color: ht, fontWeight: 600}}>
                    Age: {ageRange.text}
                    {!ageRange.hasActual && ageRange.text !== '—' && (
                      <span style={{fontSize: 10, color: ht, opacity: 0.75, marginLeft: 4}}>(estimated)</span>
                    )}
                  </span>
                  {g.startDate && (
                    <span style={{color: ht, fontSize: 11, opacity: 0.85}}>Started {fmt(g.startDate)}</span>
                  )}
                  <span style={S.badge(sc.bg, sc.tx)}>{g.status}</span>
                  <div style={{marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
                    {g.status === 'active' ? (
                      <button
                        onClick={() => archiveBatch(g.id)}
                        style={{
                          fontSize: 11,
                          padding: '3px 10px',
                          borderRadius: 5,
                          border: '1px solid #d1d5db',
                          color: '#6b7280',
                          background: 'white',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Mark Processed
                      </button>
                    ) : (
                      <button
                        onClick={() => unarchiveBatch(g.id)}
                        style={{
                          fontSize: 11,
                          padding: '3px 10px',
                          borderRadius: 5,
                          border: '1px solid #085041',
                          color: '#085041',
                          background: 'white',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      onClick={() => openMortalityModal(g.id)}
                      style={{
                        fontSize: 11,
                        padding: '3px 10px',
                        borderRadius: 5,
                        border: '1px solid #fecaca',
                        color: '#b91c1c',
                        background: 'white',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + Mortality
                    </button>
                    <button
                      onClick={() => {
                        setNotice(null);
                        const f = {
                          batchName: g.batchName,
                          cycleId: g.cycleId || '',
                          giltCount: g.giltCount,
                          boarCount: g.boarCount,
                          startDate: g.startDate || '',
                          originalPigCount: g.originalPigCount || 0,
                          perLbFeedCost: g.perLbFeedCost || 0,
                          legacyFeedLbs: g.legacyFeedLbs || 0,
                          feedAllocatedToTransfers: g.feedAllocatedToTransfers || 0,
                          notes: g.notes || '',
                          status: g.status,
                        };
                        setFeederForm(f);
                        setOriginalFeederForm(f);
                        setEditFeederId(g.id);
                        setShowFeederForm(true);
                        setShowSubForm(null);
                      }}
                      style={{
                        fontSize: 11,
                        color: '#1d4ed8',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Summary stats */}
            {(() => {
              const anyDailys = hasSubBatches
                ? subFeedTotals.some((sf) => sf.dailys.length > 0)
                : batchDailys.length > 0;
              return trips.length > 0 || totalFeed > 0 || anyDailys;
            })() && (
              <div style={{padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb'}}>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8}}>
                  {[
                    {
                      label: 'Total feed',
                      val: totalFeed > 0 ? `${Math.round(totalFeed).toLocaleString()} lbs` : '—',
                      color: '#92400e',
                      hint:
                        feedAllocatedOut > 0
                          ? `raw ${Math.round(rawFeed).toLocaleString()} − ${Math.round(feedAllocatedOut).toLocaleString()} transferred out`
                          : dailyFeedTotal > 0 && legacyFeed > 0
                            ? `${Math.round(dailyFeedTotal).toLocaleString()} from dailys + ${Math.round(legacyFeed).toLocaleString()} legacy`
                            : dailyFeedTotal > 0
                              ? `from ${batchDailys.length} daily reports`
                              : null,
                    },
                    ...(feedAllocatedOut > 0
                      ? [
                          {
                            label: 'Feed → Breeding',
                            val: `−${Math.round(feedAllocatedOut).toLocaleString()} lbs`,
                            color: '#5b21b6',
                            hint: 'credited to transferred pigs (subtracted above)',
                          },
                        ]
                      : []),
                    {
                      label: 'Lbs per pig',
                      val: (() => {
                        const transferredCount = hasSubBatches
                          ? subFeedTotals.reduce((s, sf) => s + sf.transferCount, 0)
                          : parentTransferAgg.count;
                        const mortalityCount = hasSubBatches
                          ? subFeedTotals.reduce((s, sf) => s + sf.mortality, 0)
                          : pigMortalityForBatch(g);
                        const finishers = Math.max(0, originalPigCount - transferredCount - mortalityCount);
                        return totalFeed > 0 && finishers > 0 ? `${Math.round(totalFeed / finishers)} lbs/pig` : '—';
                      })(),
                      color: '#78350f',
                      hint: (() => {
                        const transferredCount = hasSubBatches
                          ? subFeedTotals.reduce((s, sf) => s + sf.transferCount, 0)
                          : parentTransferAgg.count;
                        const mortalityCount = hasSubBatches
                          ? subFeedTotals.reduce((s, sf) => s + sf.mortality, 0)
                          : pigMortalityForBatch(g);
                        const finishers = Math.max(0, originalPigCount - transferredCount - mortalityCount);
                        if (finishers <= 0) return null;
                        const parts = [`adjusted feed ÷ ${finishers}`];
                        if (transferredCount > 0 || mortalityCount > 0) {
                          const subParts = [`${originalPigCount} started`];
                          if (transferredCount > 0) subParts.push(`− ${transferredCount} transferred`);
                          if (mortalityCount > 0) subParts.push(`− ${mortalityCount} mortality`);
                          parts.push(`(${subParts.join(' ')})`);
                        }
                        return parts.join(' ');
                      })(),
                    },
                    {
                      label: 'Feed cost',
                      val: totalFeedCost
                        ? `$${totalFeedCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
                        : '—',
                      color: '#92400e',
                      hint: perLbCost > 0 ? `$${perLbCost}/lb` : null,
                    },
                    {
                      label: 'Feed conversion',
                      val: feedConversion ? `${feedConversion} lbs/lb` : '—',
                      color: '#78350f',
                    },
                    {
                      label: 'Pigs processed',
                      val: trips.reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0),
                      color: '#111827',
                    },
                    {
                      label: 'Total live wt',
                      val: totalLive > 0 ? `${Math.round(totalLive)} lbs` : '—',
                      color: '#1d4ed8',
                    },
                    {label: 'Avg carcass yield', val: overallYield ? `${overallYield}%` : '—', color: '#16a34a'},
                  ].map((s) => (
                    <div
                      key={s.label}
                      style={{
                        textAlign: 'center',
                        background: 'white',
                        border: '1px solid #e5e7eb',
                        borderRadius: 8,
                        padding: '6px 10px',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: '#9ca3af',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          marginBottom: 2,
                        }}
                      >
                        {s.label}
                      </div>
                      <div style={{fontSize: 15, fontWeight: 700, color: s.color}}>{s.val === 0 ? '—' : s.val}</div>
                      {s.hint && <div style={{fontSize: 10, color: '#9ca3af', marginTop: 1}}>{s.hint}</div>}
                    </div>
                  ))}
                </div>
                {(() => {
                  const allDailysCount = hasSubBatches
                    ? subFeedTotals.reduce((s, sf) => s + sf.dailys.length, 0)
                    : batchDailys.length;
                  return allDailysCount > 0 ? (
                    <div style={{marginTop: 8, fontSize: 11, color: '#6b7280'}}>
                      <span>
                        📋 {allDailysCount} daily report{allDailysCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ) : null;
                })()}
              </div>
            )}

            {/* Transferred-to-breeding note (per sub-batch breakdown) */}
            {(() => {
              const transferred = (breeders || []).filter(
                (b) => b && b.transferredFromBatch && b.transferredFromBatch.batchName === g.batchName,
              );
              if (transferred.length === 0) return null;
              const bySub = {};
              transferred.forEach((b) => {
                const k = b.transferredFromBatch.subBatchName || g.batchName;
                bySub[k] = (bySub[k] || 0) + 1;
              });
              return (
                <div
                  style={{
                    padding: '8px 16px',
                    borderBottom: '1px solid #e5e7eb',
                    background: '#f5f3ff',
                    fontSize: 12,
                    color: '#5b21b6',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{fontWeight: 700}}>{'→ Breeding:'}</span>
                  {Object.entries(bySub).map(([sub, count], i) => (
                    <span key={sub}>
                      {(i > 0 ? ' · ' : '') +
                        count +
                        ' ' +
                        (count === 1 ? 'pig' : 'pigs') +
                        ' out of ' +
                        sub +
                        ' sent to breeding pigs group'}
                    </span>
                  ))}
                </div>
              );
            })()}

            {/* Sub-batches panel */}
            <div style={{padding: '10px 16px', borderBottom: '1px solid #e5e7eb'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}>
                <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563'}}>
                  Sub-batches {subBatches.length > 0 ? `(${subBatches.length})` : ''}
                </div>
                <div style={{display: 'flex', gap: 6}}>
                  {showSubForm === g.id && !editSubId ? (
                    <button
                      onClick={() => closeSubForm(g.id)}
                      style={{
                        fontSize: 11,
                        color: '#6b7280',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      Close
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setNotice(null);
                        setShowSubForm(g.id);
                        setEditSubId(null);
                        setSubForm({name: '', sex: 'Gilts', count: 0, notes: ''});
                      }}
                      style={{
                        padding: '3px 10px',
                        borderRadius: 5,
                        border: 'none',
                        background: '#ecfdf5',
                        color: '#083d30',
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                      }}
                    >
                      + Add sub-batch
                    </button>
                  )}
                </div>
              </div>

              {/* Sub-batch form (modal) */}
              {showSubForm === g.id && (
                <div
                  onClick={() => closeSubForm(g.id)}
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,.45)',
                    zIndex: 500,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1rem',
                  }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'white',
                      borderRadius: 12,
                      width: '100%',
                      maxWidth: 480,
                      boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                    }}
                  >
                    <div
                      style={{
                        padding: '14px 20px',
                        borderBottom: '1px solid #e5e7eb',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                        {editSubId ? 'Edit Sub-batch' : 'New Sub-batch'}{' '}
                        <span style={{fontWeight: 400, color: '#9ca3af', fontSize: 11, marginLeft: 6}}>
                          Auto-saves as you type
                        </span>
                      </div>
                      <button
                        onClick={() => closeSubForm(g.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: 22,
                          cursor: 'pointer',
                          color: '#9ca3af',
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{padding: '16px 20px'}}>
                      <div style={{marginBottom: 10}}>
                        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
                      </div>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Sub-batch name *</span>
                        <div>
                          <input
                            value={subForm.name}
                            onChange={(e) => updSub(g.id, 'name', e.target.value)}
                            placeholder="e.g. P-26-01 A (GILTS)"
                            style={recordControl}
                          />
                          <div style={{fontSize: 10, color: '#9ca3af', marginTop: 2}}>
                            Must match the label used on daily reports
                          </div>
                        </div>
                      </div>
                      {!editSubId ? (
                        <>
                          <div className={recordFieldRowClass}>
                            <span style={recordFieldLabel}>Sex *</span>
                            <select
                              value={subForm.sex || 'Gilts'}
                              onChange={(e) => updSub(g.id, 'sex', e.target.value)}
                              style={recordControl}
                            >
                              <option value="Gilts">Gilts</option>
                              <option value="Boars">Boars</option>
                            </select>
                          </div>
                          <div className={recordFieldRowClass}>
                            <span style={recordFieldLabel}>Count *</span>
                            <input
                              type="number"
                              min="0"
                              value={subForm.count || ''}
                              onChange={(e) => updSub(g.id, 'count', e.target.value)}
                              style={recordControl}
                              placeholder={(() => {
                                const sex = subForm.sex || 'Gilts';
                                const parentTotal =
                                  sex === 'Boars' ? parseInt(g.boarCount) || 0 : parseInt(g.giltCount) || 0;
                                const usedBy = (g.subBatches || [])
                                  .filter(
                                    (s) =>
                                      (sex === 'Boars' ? parseInt(s.boarCount) || 0 : parseInt(s.giltCount) || 0) > 0,
                                  )
                                  .reduce(
                                    (a, s) =>
                                      a + (sex === 'Boars' ? parseInt(s.boarCount) || 0 : parseInt(s.giltCount) || 0),
                                    0,
                                  );
                                const remaining = Math.max(0, parentTotal - usedBy);
                                return remaining > 0 ? `Up to ${remaining} available` : '0 available';
                              })()}
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div
                            style={{
                              gridColumn: '1/-1',
                              padding: '10px 12px',
                              background: '#f9fafb',
                              border: '1px solid #e5e7eb',
                              borderRadius: 8,
                            }}
                          >
                            <div style={{fontSize: 11, color: '#9ca3af', marginBottom: 4}}>
                              Sex + count are locked. Edit the parent batch to redistribute.
                            </div>
                            <div style={{display: 'flex', gap: 14, fontSize: 13, color: '#111827', fontWeight: 600}}>
                              {(parseInt(subForm.giltCount) || 0) > 0 && <span>Gilts: {subForm.giltCount}</span>}
                              {(parseInt(subForm.boarCount) || 0) > 0 && <span>Boars: {subForm.boarCount}</span>}
                              <span style={{color: '#6b7280'}}>
                                Original count:{' '}
                                {(parseInt(subForm.giltCount) || 0) + (parseInt(subForm.boarCount) || 0)}
                              </span>
                            </div>
                          </div>
                        </>
                      )}
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Notes</span>
                        <input
                          value={subForm.notes}
                          onChange={(e) => updSub(g.id, 'notes', e.target.value)}
                          placeholder="Optional"
                          style={recordControl}
                        />
                      </div>
                    </div>
                    {editSubId && (
                      <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
                        <button onClick={() => deleteSubBatch(g.id, editSubId)} style={S.btnDanger}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {subBatches.length === 0 && showSubForm !== g.id && (
                <div style={{fontSize: 11, color: '#9ca3af', padding: '2px 0 6px'}}>
                  No sub-batches yet — daily reports start once you add a sub-batch. Add sub-batches to split A/B
                  groups.
                </div>
              )}

              {subBatches.map((sb) => {
                const sft = subFeedTotals.find((x) => x.sb.id === sb.id) || {
                  adjustedFeed: 0,
                  rawFeed: 0,
                  transferFeedCredit: 0,
                  dailys: [],
                  latestDaily: null,
                  currentCount: null,
                  started: 0,
                  transferCount: 0,
                  tripPigs: 0,
                  mortality: 0,
                  dailyCount: null,
                };
                const sbSc = statusColors[sb.status] || statusColors.active;
                const dailyVsLedger =
                  sft.dailyCount != null &&
                  sb.status !== 'processed' &&
                  Math.abs((parseInt(sft.dailyCount) || 0) - sft.ledgerCurrent) > 2;
                // Planned-trip projection for this sub (commit 4a).
                // Ronnie rule: forecast weight stays DOB/farrowing age at
                // trip date × Global ADG. Weigh-in weights do not alter
                // planned-trip forecast weights or dates.
                const subGiltCount = parseInt(sb.giltCount) || 0;
                const subBoarCount = parseInt(sb.boarCount) || 0;
                const isMixedSex = subGiltCount > 0 && subBoarCount > 0;
                const todayStr = todayISO();
                const cycleAgeForRender = g.cycleId
                  ? libCalcAgeRange(g.cycleId, new Date(todayStr + 'T12:00:00'), breedingCycles, farrowingRecs)
                  : null;
                const cycleAgeDaysAtRef =
                  cycleAgeForRender && cycleAgeForRender.minDays != null
                    ? {minDays: cycleAgeForRender.minDays, maxDays: cycleAgeForRender.maxDays}
                    : null;
                const ageDistributionAtRef = buildFarrowingAgeDistribution({
                  cycleId: g.cycleId,
                  asOfDate: todayStr,
                  breedingCycles,
                  farrowingRecs,
                  cycleAgeDaysAtRef,
                });
                const forecastPopulationCount = Math.max(0, sft.started - sft.transferCount - sft.mortality);
                const plannedRawForSub = (g.plannedProcessingTrips || []).filter((t) => t.subBatchId === sb.id);
                const plannedProjected = recalculateProjections(plannedRawForSub, {
                  referenceDate: todayStr,
                  globalAdgLbsPerDay: effectiveAdgLbsPerDay,
                  cycleAgeDaysAtRef,
                  ageDistributionAtRef,
                  populationCount: forecastPopulationCount,
                  alreadyShippedCount: sft.tripPigs,
                  targetWeightLbs: PLANNED_TRIP_TARGET_WEIGHT_LBS,
                  minSize: PLANNED_TRIP_MIN_SIZE,
                  overWeightWarnLbs: PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
                });
                return (
                  <React.Fragment key={sb.id}>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: '6px 12px',
                        padding: '8px 10px',
                        borderRadius: 7,
                        border: '1px solid #e5e7eb',
                        marginBottom: 6,
                        background: sb.status === 'processed' ? '#f9fafb' : 'white',
                        opacity: sb.status === 'processed' ? 0.7 : 1,
                      }}
                    >
                      <strong style={{fontSize: 12, color: '#111827'}}>{sb.name}</strong>
                      <span style={S.badge(sbSc.bg, sbSc.tx)}>{sb.status}</span>
                      {sft.started > 0 && (
                        <span style={{fontSize: 11, color: '#374151'}}>
                          Started: <strong>{sft.started}</strong>
                        </span>
                      )}
                      {sft.adjustedFeed > 0 && (
                        <span style={{fontSize: 11, color: '#92400e', fontWeight: 600}}>
                          🌾 {Math.round(sft.adjustedFeed).toLocaleString()} lbs feed
                        </span>
                      )}
                      {(() => {
                        const finishers = Math.max(0, sft.started - sft.transferCount - sft.mortality);
                        return sft.adjustedFeed > 0 && finishers > 0 ? (
                          <span
                            style={{fontSize: 11, color: '#78350f'}}
                            title={`adjusted feed ÷ ${finishers} (started ${sft.started}${sft.transferCount ? ` − ${sft.transferCount} transferred` : ''}${sft.mortality ? ` − ${sft.mortality} mortality` : ''})`}
                          >
                            ({Math.round(sft.adjustedFeed / finishers)} lbs/pig)
                          </span>
                        ) : null;
                      })()}
                      {sft.transferFeedCredit > 0 && (
                        <span
                          style={{fontSize: 10, color: '#6b7280'}}
                          title={`raw ${Math.round(sft.rawFeed).toLocaleString()} − ${Math.round(sft.transferFeedCredit).toLocaleString()} credited to ${sft.transferCount} transferred`}
                        >
                          (−{Math.round(sft.transferFeedCredit).toLocaleString()} → breeding)
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          color: '#111827',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <PlannerIcon iconKey={ANIMAL_ICON_KEYS.pig} size={14} />
                        {sft.currentCount} current
                      </span>
                      {dailyVsLedger && (
                        <span
                          style={{
                            fontSize: 10,
                            color: '#b91c1c',
                            background: '#fef2f2',
                            border: '1px solid #fecaca',
                            padding: '1px 6px',
                            borderRadius: 4,
                          }}
                          title="Latest daily count differs from ledger by more than 2"
                        >
                          ⚠ daily {sft.dailyCount}
                        </span>
                      )}
                      {sft.dailys.length > 0 && (
                        <span style={{fontSize: 11, color: '#6b7280'}}>📋 {sft.dailys.length} reports</span>
                      )}

                      <div style={{marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center'}}>
                        {sb.status === 'active' ? (
                          <button
                            onClick={() => archiveSubBatch(g.id, sb.id)}
                            style={{
                              fontSize: 11,
                              padding: '2px 8px',
                              borderRadius: 5,
                              border: '1px solid #d1d5db',
                              color: '#6b7280',
                              background: 'white',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Mark Processed
                          </button>
                        ) : (
                          <button
                            onClick={() => unarchiveSubBatch(g.id, sb.id)}
                            style={{
                              fontSize: 11,
                              padding: '2px 8px',
                              borderRadius: 5,
                              border: '1px solid #085041',
                              color: '#085041',
                              background: 'white',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          onClick={() => {
                            clearTimeout(subAutoSaveTimer.current);
                            setNotice(null);
                            setShowSubForm(g.id);
                            setEditSubId(sb.id);
                            setSubForm({
                              name: sb.name,
                              giltCount: sb.giltCount || 0,
                              boarCount: sb.boarCount || 0,
                              originalPigCount: sb.originalPigCount || 0,
                              notes: sb.notes || '',
                            });
                          }}
                          style={{
                            fontSize: 11,
                            color: '#1d4ed8',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Rename
                        </button>
                      </div>
                    </div>
                    {/* Planned trips for this sub (commit 4a, read-only).
                        Compact band beneath the sub row. Cards show date,
                        count, projected weight range, ready badge, and
                        warnings. Edit controls land in commit 4b. */}
                    {sb.status !== 'processed' && (
                      <div
                        data-planned-trips-sub={sb.id}
                        style={{
                          margin: '0 0 8px 0',
                          padding: '6px 10px',
                          borderRadius: 7,
                          border: '1px dashed #d1d5db',
                          background: '#fafafa',
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: '#6b7280',
                            textTransform: 'uppercase',
                            fontWeight: 600,
                            marginBottom: 6,
                          }}
                        >
                          Planned trips (forecast)
                        </div>
                        {isMixedSex && (
                          <div style={{fontSize: 11, color: '#92400e', fontStyle: 'italic'}}>
                            Mixed sex sub: split into separate gilts/boars subgroups before planning trips.
                          </div>
                        )}
                        {!isMixedSex && !g.cycleId && (
                          <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                            Link a breeding cycle to see planned trips.
                          </div>
                        )}
                        {!isMixedSex && g.cycleId && effectiveAdgLbsPerDay == null && (
                          <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                            Set Global ADG above to see planned trips.
                          </div>
                        )}
                        {!isMixedSex && g.cycleId && effectiveAdgLbsPerDay != null && plannedProjected.length === 0 && (
                          <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                            Projection unavailable — cycle age range not yet usable.
                          </div>
                        )}
                        {/* Manual + Add planned trip (admin/management only).
                              Sex comes from the sub itself (non-mixed subs are
                              gilt-only or boar-only). Mixed-sex hint above already
                              tells the user to split before planning. Date is
                              free-form per Codex's pre-build answer #2 — the chain
                              re-sorts by date+order on render. */}
                        {!isMixedSex && isManager && (
                          <div data-planned-trip-add-shell={sb.id} style={{marginBottom: 6}}>
                            {addingTripFor && addingTripFor.subBatchId === sb.id ? (
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  flexWrap: 'wrap',
                                  alignItems: 'center',
                                  background: 'white',
                                  border: '1px solid #d1d5db',
                                  borderRadius: 6,
                                  padding: '6px 8px',
                                  fontSize: 11,
                                }}
                              >
                                <input
                                  data-planned-trip-add-date={sb.id}
                                  type="date"
                                  value={addingTripDate}
                                  onChange={(e) => setAddingTripDate(e.target.value)}
                                  style={{
                                    fontSize: 11,
                                    padding: '2px 4px',
                                    border: '1px solid #d1d5db',
                                    borderRadius: 5,
                                    fontFamily: 'inherit',
                                    width: 132,
                                    minWidth: 132,
                                    maxWidth: 132,
                                    flex: '0 0 132px',
                                    boxSizing: 'border-box',
                                  }}
                                />
                                <input
                                  data-planned-trip-add-count={sb.id}
                                  type="number"
                                  min={1}
                                  placeholder="pigs"
                                  value={addingTripCount}
                                  onChange={(e) => setAddingTripCount(e.target.value)}
                                  style={{
                                    fontSize: 11,
                                    padding: '2px 4px',
                                    border: '1px solid #d1d5db',
                                    borderRadius: 5,
                                    fontFamily: 'inherit',
                                    width: 70,
                                  }}
                                />
                                <span style={{color: '#6b7280'}}>{addingTripFor.sex}</span>
                                <button
                                  data-planned-trip-add-save={sb.id}
                                  onClick={() => {
                                    const r = addPlannedTripById(g.id, {
                                      subBatchId: sb.id,
                                      sex: addingTripFor.sex,
                                      date: addingTripDate,
                                      plannedCount: parseInt(addingTripCount),
                                    });
                                    if (r && r.error) {
                                      setAddingTripError(r.error);
                                      return;
                                    }
                                    setAddingTripFor(null);
                                    setAddingTripDate('');
                                    setAddingTripCount('');
                                    setAddingTripError('');
                                  }}
                                  style={{
                                    fontSize: 10,
                                    padding: '3px 10px',
                                    borderRadius: 5,
                                    border: '1px solid #085041',
                                    background: '#085041',
                                    color: 'white',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  Add
                                </button>
                                <button
                                  onClick={() => {
                                    setAddingTripFor(null);
                                    setAddingTripDate('');
                                    setAddingTripCount('');
                                    setAddingTripError('');
                                  }}
                                  style={{
                                    fontSize: 10,
                                    padding: '3px 10px',
                                    borderRadius: 5,
                                    border: '1px solid #d1d5db',
                                    background: 'white',
                                    color: '#6b7280',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  Cancel
                                </button>
                                {addingTripError && (
                                  <span
                                    data-planned-trip-add-error={sb.id}
                                    style={{color: '#b91c1c', fontSize: 10, fontStyle: 'italic'}}
                                  >
                                    {addingTripError}
                                  </span>
                                )}
                              </div>
                            ) : (
                              (() => {
                                // Codex pig planned trips lane: when ANY trip in a
                                // (subBatchId, sex) chain is locked, disable Add for
                                // that chain — an add would draw pigs from the locked
                                // chain's plannedCount reservoir.
                                const giltChainLocked = isChainLocked(g.plannedProcessingTrips || [], sb.id, 'gilt');
                                const boarChainLocked = isChainLocked(g.plannedProcessingTrips || [], sb.id, 'boar');
                                return (
                                  <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                                    {(parseInt(sb.giltCount) || 0) > 0 && (
                                      <button
                                        data-planned-trip-add-button={`${sb.id}-gilt`}
                                        data-planned-trip-add-locked={giltChainLocked ? 'true' : 'false'}
                                        disabled={giltChainLocked}
                                        onClick={() => {
                                          if (giltChainLocked) return;
                                          setAddingTripFor({groupId: g.id, subBatchId: sb.id, sex: 'gilt'});
                                          setAddingTripDate(new Date().toISOString().slice(0, 10));
                                          setAddingTripCount('');
                                          setAddingTripError('');
                                        }}
                                        style={{
                                          fontSize: 10,
                                          padding: '3px 10px',
                                          borderRadius: 5,
                                          border: '1px solid #1d4ed8',
                                          background: giltChainLocked ? '#f3f4f6' : 'white',
                                          color: giltChainLocked ? '#9ca3af' : '#1d4ed8',
                                          cursor: giltChainLocked ? 'not-allowed' : 'pointer',
                                          fontFamily: 'inherit',
                                          fontWeight: 600,
                                          opacity: giltChainLocked ? 0.6 : 1,
                                        }}
                                        title={
                                          giltChainLocked ? 'Gilt chain has a locked trip — unlock first' : undefined
                                        }
                                      >
                                        + Add gilt trip
                                      </button>
                                    )}
                                    {(parseInt(sb.boarCount) || 0) > 0 && (
                                      <button
                                        data-planned-trip-add-button={`${sb.id}-boar`}
                                        data-planned-trip-add-locked={boarChainLocked ? 'true' : 'false'}
                                        disabled={boarChainLocked}
                                        onClick={() => {
                                          if (boarChainLocked) return;
                                          setAddingTripFor({groupId: g.id, subBatchId: sb.id, sex: 'boar'});
                                          setAddingTripDate(new Date().toISOString().slice(0, 10));
                                          setAddingTripCount('');
                                          setAddingTripError('');
                                        }}
                                        style={{
                                          fontSize: 10,
                                          padding: '3px 10px',
                                          borderRadius: 5,
                                          border: '1px solid #1d4ed8',
                                          background: boarChainLocked ? '#f3f4f6' : 'white',
                                          color: boarChainLocked ? '#9ca3af' : '#1d4ed8',
                                          cursor: boarChainLocked ? 'not-allowed' : 'pointer',
                                          fontFamily: 'inherit',
                                          fontWeight: 600,
                                          opacity: boarChainLocked ? 0.6 : 1,
                                        }}
                                        title={
                                          boarChainLocked ? 'Boar chain has a locked trip — unlock first' : undefined
                                        }
                                      >
                                        + Add boar trip
                                      </button>
                                    )}
                                  </div>
                                );
                              })()
                            )}
                          </div>
                        )}
                        {!isMixedSex && g.cycleId && effectiveAdgLbsPerDay != null && plannedProjected.length > 0 && (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                              gap: 6,
                            }}
                          >
                            {plannedProjected.map((t, ti) => {
                              const projRange =
                                t.projectedMinLbs != null && t.projectedMaxLbs != null
                                  ? `${Math.round(t.projectedMinLbs)} – ${Math.round(t.projectedMaxLbs)} lb${
                                      t.projectionHasActualFarrowing ? '' : ' (est.)'
                                    }`
                                  : '—';
                              const projAvg =
                                t.projectedAvgLbs != null ? `~${Math.round(t.projectedAvgLbs)} lb avg` : '';
                              // Move targets within this (sub, sex) chain. plannedProjected
                              // is already sorted by (date, order). nextSameSex receives
                              // forward moves; prevSameSex receives back moves.
                              const nextSameSex = plannedProjected.slice(ti + 1).find((nt) => nt.sex === t.sex);
                              const prevSameSex = plannedProjected
                                .slice(0, ti)
                                .reverse()
                                .find((pt) => pt.sex === t.sex);
                              // Chain trip count for THIS sex governs the delete-disable.
                              // A chain of one trip cannot be deleted (deletion would
                              // lose the planned-count signal).
                              const sameSexChainCount = plannedProjected.filter((ct) => ct.sex === t.sex).length;
                              const canDelete = isManager && sameSexChainCount > 1;
                              const isEditingDate = editingPlannedTripId === t.id;
                              // Lock state for this card. Locked trips hide every
                              // mutation affordance (date, ±1d, move, delete) so
                              // operators can only re-enable mutation by going
                              // through the inline two-step unlock.
                              const lockEntry = plannedTripLocks && plannedTripLocks[t.id];
                              const tripLocked = !!(lockEntry && lockEntry.locked);
                              const lockedByLabel = tripLocked
                                ? 'Locked by user: ' + (lockEntry.lockedByName || 'Unknown')
                                : null;
                              return (
                                <div
                                  key={t.id}
                                  data-planned-trip-id={t.id}
                                  data-planned-trip-sex={t.sex}
                                  data-planned-trip-locked={tripLocked ? 'true' : 'false'}
                                  style={{
                                    background: tripLocked ? '#f9fafb' : 'white',
                                    border: tripLocked ? '1px solid #cbd5f5' : '1px solid #e5e7eb',
                                    borderRadius: 6,
                                    padding: '6px 10px',
                                    fontSize: 11,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 2,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: 4,
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <span style={{fontWeight: 700, color: '#111827'}}>{fmt(t.date)}</span>
                                    {tripLocked && (
                                      <span
                                        data-planned-trip-locked-by={t.id}
                                        style={{
                                          fontSize: 10,
                                          fontWeight: 700,
                                          padding: '2px 8px',
                                          borderRadius: 10,
                                          background: '#eef2ff',
                                          color: '#3730a3',
                                          border: '1px solid #c7d2fe',
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 4,
                                        }}
                                        title={
                                          lockEntry && lockEntry.lockedAt
                                            ? 'Locked ' + fmt(lockEntry.lockedAt)
                                            : undefined
                                        }
                                      >
                                        🔒 {lockedByLabel}
                                      </span>
                                    )}
                                    {!tripLocked && isManager && (
                                      <div style={{display: 'inline-flex', gap: 3, alignItems: 'center'}}>
                                        <button
                                          data-planned-trip-edit-date={t.id}
                                          onClick={() => {
                                            if (isEditingDate) {
                                              setEditingPlannedTripId(null);
                                              setEditingPlannedTripDate('');
                                              return;
                                            }
                                            setEditingPlannedTripId(t.id);
                                            setEditingPlannedTripDate(t.date || '');
                                          }}
                                          style={{
                                            fontSize: 11,
                                            width: 24,
                                            height: 22,
                                            padding: 0,
                                            borderRadius: 5,
                                            border: '1px solid #bfdbfe',
                                            background: '#eff6ff',
                                            color: '#1d4ed8',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                          }}
                                          title="Open planned trip calendar"
                                        >
                                          📅
                                        </button>
                                        <button
                                          data-planned-trip-date-back={t.id}
                                          onClick={() => shiftPlannedTripDateById(g.id, t.id, t.date, -1)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 5px',
                                            borderRadius: 5,
                                            border: '1px solid #bfdbfe',
                                            background: 'white',
                                            color: '#1d4ed8',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Move planned trip date back 1 day"
                                        >
                                          ←1d
                                        </button>
                                        <button
                                          data-planned-trip-date-forward={t.id}
                                          onClick={() => shiftPlannedTripDateById(g.id, t.id, t.date, 1)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 5px',
                                            borderRadius: 5,
                                            border: '1px solid #bfdbfe',
                                            background: 'white',
                                            color: '#1d4ed8',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Move planned trip date forward 1 day"
                                        >
                                          1d→
                                        </button>
                                        <button
                                          data-planned-trip-lock={t.id}
                                          onClick={() => lockPlannedTrip(t.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 6px',
                                            borderRadius: 5,
                                            border: '1px solid #c7d2fe',
                                            background: 'white',
                                            color: '#3730a3',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Lock this planned trip (mark scheduled with the processor)"
                                        >
                                          🔒 Lock
                                        </button>
                                      </div>
                                    )}
                                    {!tripLocked && isEditingDate && (
                                      <input
                                        data-planned-trip-date-input={t.id}
                                        type="date"
                                        value={editingPlannedTripDate}
                                        onChange={(e) => {
                                          const nextDate = e.target.value;
                                          setEditingPlannedTripDate(nextDate);
                                          if (nextDate && nextDate !== t.date) {
                                            setPlannedTripDateById(g.id, t.id, nextDate);
                                          }
                                        }}
                                        style={{
                                          fontSize: 11,
                                          padding: '2px 4px',
                                          border: '1px solid #d1d5db',
                                          borderRadius: 5,
                                          fontFamily: 'inherit',
                                          width: 132,
                                        }}
                                      />
                                    )}
                                    <span style={{color: '#1e40af', fontWeight: 600}}>
                                      {t.plannedCount} {t.sex === 'gilt' ? 'gilt' : 'boar'}
                                      {t.plannedCount === 1 ? '' : 's'}
                                    </span>
                                  </div>
                                  <div style={{color: '#374151'}}>{projRange}</div>
                                  {projAvg && <div style={{color: '#6b7280'}}>{projAvg}</div>}
                                  <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2}}>
                                    {t.ready && (
                                      <span
                                        style={{
                                          fontSize: 9,
                                          fontWeight: 700,
                                          padding: '1px 6px',
                                          borderRadius: 8,
                                          background: '#d1fae5',
                                          color: '#065f46',
                                          textTransform: 'uppercase',
                                        }}
                                      >
                                        Ready
                                      </span>
                                    )}
                                    {t.warnings.includes('undersized') && (
                                      <span
                                        style={{
                                          fontSize: 9,
                                          fontWeight: 700,
                                          padding: '1px 6px',
                                          borderRadius: 8,
                                          background: '#fef3c7',
                                          color: '#92400e',
                                          textTransform: 'uppercase',
                                        }}
                                      >
                                        Under {PLANNED_TRIP_MIN_SIZE}
                                      </span>
                                    )}
                                    {t.warnings.includes('overweight') && (
                                      <span
                                        style={{
                                          fontSize: 9,
                                          fontWeight: 700,
                                          padding: '1px 6px',
                                          borderRadius: 8,
                                          background: '#fee2e2',
                                          color: '#991b1b',
                                          textTransform: 'uppercase',
                                        }}
                                      >
                                        Over {PLANNED_TRIP_OVER_WEIGHT_WARN_LBS}
                                      </span>
                                    )}
                                  </div>
                                  {/* Move arrows + delete (admin/management).
                                          ← back: send 1 pig from this trip to the PREVIOUS
                                          chain trip (heaviest in current rank window).
                                          → forward: send 1 pig from this trip to the NEXT
                                          chain trip (lightest in current rank window).
                                          First trip: forward only. Last trip: back only.
                                          Middle trips: both. Disabled when this trip has
                                          0 pigs to give. */}
                                  {!tripLocked && isManager && (nextSameSex || prevSameSex || canDelete) && (
                                    <div style={{display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap'}}>
                                      {prevSameSex && (
                                        <button
                                          data-planned-trip-move-back={t.id}
                                          disabled={(parseInt(t.plannedCount) || 0) <= 0}
                                          onClick={() => movePlannedTripPigsById(g.id, t.id, prevSameSex.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 6px',
                                            borderRadius: 5,
                                            border: '1px solid #d1d5db',
                                            background: 'white',
                                            color: (parseInt(t.plannedCount) || 0) > 0 ? '#1d4ed8' : '#9ca3af',
                                            cursor: (parseInt(t.plannedCount) || 0) > 0 ? 'pointer' : 'not-allowed',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Move 1 pig back to the previous planned trip (heaviest in this trip's rank window)"
                                        >
                                          ← −1
                                        </button>
                                      )}
                                      {nextSameSex && (
                                        <button
                                          data-planned-trip-move-forward={t.id}
                                          disabled={(parseInt(t.plannedCount) || 0) <= 0}
                                          onClick={() => movePlannedTripPigsById(g.id, t.id, nextSameSex.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 6px',
                                            borderRadius: 5,
                                            border: '1px solid #d1d5db',
                                            background: 'white',
                                            color: (parseInt(t.plannedCount) || 0) > 0 ? '#1d4ed8' : '#9ca3af',
                                            cursor: (parseInt(t.plannedCount) || 0) > 0 ? 'pointer' : 'not-allowed',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Move 1 pig forward to the next planned trip (lightest in this trip's rank window)"
                                        >
                                          −1 →
                                        </button>
                                      )}
                                      {canDelete && (
                                        <button
                                          data-planned-trip-delete={t.id}
                                          onClick={() => deletePlannedTripById(g.id, t.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 6px',
                                            borderRadius: 5,
                                            border: '1px solid #fecaca',
                                            background: 'white',
                                            color: '#b91c1c',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Delete this planned trip (its pigs move to the next, or previous if last)"
                                        >
                                          🗑
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {/* Locked trip — admin/management can unlock via a
                                          two-step inline confirmation. No window.confirm. */}
                                  {tripLocked &&
                                    isManager &&
                                    (unlockingTripId === t.id ? (
                                      <div
                                        data-planned-trip-unlock-warning={t.id}
                                        style={{
                                          display: 'flex',
                                          gap: 6,
                                          flexWrap: 'wrap',
                                          marginTop: 4,
                                          padding: '6px 8px',
                                          border: '1px solid #fecaca',
                                          background: '#fef2f2',
                                          borderRadius: 6,
                                          alignItems: 'center',
                                        }}
                                      >
                                        <span
                                          style={{
                                            color: '#991b1b',
                                            fontSize: 11,
                                            lineHeight: 1.3,
                                            flex: '1 1 100%',
                                          }}
                                        >
                                          This trip has already been scheduled with the processor. Only unlock if you
                                          have rescheduled with the processor.
                                        </span>
                                        <button
                                          data-planned-trip-unlock-cancel={t.id}
                                          onClick={() => setUnlockingTripId(null)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 8px',
                                            borderRadius: 5,
                                            border: '1px solid #d1d5db',
                                            background: 'white',
                                            color: '#4b5563',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          data-planned-trip-unlock-confirm={t.id}
                                          onClick={() => unlockPlannedTrip(t.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 10px',
                                            borderRadius: 5,
                                            border: 'none',
                                            background: '#b91c1c',
                                            color: 'white',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                            fontWeight: 600,
                                          }}
                                        >
                                          Confirm unlock
                                        </button>
                                      </div>
                                    ) : (
                                      <div style={{display: 'flex', marginTop: 4}}>
                                        <button
                                          data-planned-trip-unlock={t.id}
                                          onClick={() => setUnlockingTripId(t.id)}
                                          style={{
                                            fontSize: 10,
                                            padding: '2px 8px',
                                            borderRadius: 5,
                                            border: '1px solid #c7d2fe',
                                            background: 'white',
                                            color: '#3730a3',
                                            cursor: 'pointer',
                                            fontFamily: 'inherit',
                                          }}
                                          title="Unlock this planned trip (requires confirmation)"
                                        >
                                          🔓 Unlock
                                        </button>
                                      </div>
                                    ))}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Processing trips */}
            <div style={{padding: '10px 16px'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}>
                <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563'}}>
                  Processing trips {trips.length > 0 ? `(${trips.length})` : ''}
                </div>
                <span style={{fontSize: 10, color: '#9ca3af', fontStyle: 'italic'}}>
                  Trips originate from weigh-ins via Send-to-Trip
                </span>
              </div>

              {/* Trip form (modal) */}
              {showTripForm && (
                <div
                  onClick={closeTripForm}
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,.45)',
                    zIndex: 500,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1rem',
                  }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'white',
                      borderRadius: 12,
                      width: '100%',
                      maxWidth: 520,
                      boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                    }}
                  >
                    <div
                      style={{
                        padding: '14px 20px',
                        borderBottom: '1px solid #e5e7eb',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                        {editTripId ? 'Edit Processing Trip' : 'New Processing Trip'}{' '}
                        <span style={{fontWeight: 400, color: '#9ca3af', fontSize: 11, marginLeft: 6}}>
                          Auto-saves as you type
                        </span>
                      </div>
                      <button
                        onClick={closeTripForm}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: 22,
                          cursor: 'pointer',
                          color: '#9ca3af',
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{padding: '16px 20px'}}>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Processing date</span>
                        <input
                          type="date"
                          value={tripForm.date}
                          onChange={(e) => updTrip('date', e.target.value)}
                          style={recordControl}
                        />
                      </div>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Number of pigs</span>
                        <input
                          type="number"
                          min="0"
                          value={tripForm.pigCount || ''}
                          onChange={(e) => updTrip('pigCount', e.target.value)}
                          style={recordControl}
                        />
                      </div>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>
                          Live weights — enter each pig's weight separated by commas or spaces
                        </span>
                        <div>
                          <input
                            value={tripForm.liveWeights}
                            onChange={(e) => updTrip('liveWeights', e.target.value)}
                            placeholder="e.g. 245, 268, 231, 255, 240"
                            style={recordControl}
                          />
                          {tripForm.liveWeights &&
                            (() => {
                              const wts = parseLiveWeights(tripForm.liveWeights);
                              const total = wts.reduce((a, b) => a + b, 0);
                              const avg = wts.length > 0 ? Math.round(total / wts.length) : 0;
                              return wts.length > 0 ? (
                                <div style={{fontSize: 11, color: '#085041', marginTop: 3}}>
                                  {wts.length} pigs {'\u00b7'} Total: {Math.round(total)} lbs{'\u00b7'} Avg: {avg}{' '}
                                  lbs/pig
                                </div>
                              ) : null;
                            })()}
                          {editTripId &&
                            (() => {
                              const counts = tripSourceCounts(editTripId);
                              const keys = Object.keys(counts);
                              if (keys.length === 0) return null;
                              return (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: '#065f46',
                                    marginTop: 6,
                                    padding: '5px 9px',
                                    background: '#ecfdf5',
                                    border: '1px solid #a7f3d0',
                                    borderRadius: 5,
                                  }}
                                >
                                  <strong>Sources:</strong> {keys.map((k) => k + ' (' + counts[k] + ')').join(', ')}
                                </div>
                              );
                            })()}
                        </div>
                      </div>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Hanging weight (lbs) — total for this trip</span>
                        <div>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={tripForm.hangingWeight || ''}
                            onChange={(e) => updTrip('hangingWeight', e.target.value)}
                            style={recordControl}
                          />
                          {tripForm.hangingWeight > 0 && tripTotalLive(tripForm) > 0 && (
                            <div style={{fontSize: 11, color: '#16a34a', marginTop: 3}}>
                              Carcass yield: {tripYield(tripForm)}%
                            </div>
                          )}
                        </div>
                      </div>
                      <div className={recordFieldRowClass}>
                        <span style={recordFieldLabel}>Notes</span>
                        <input
                          value={tripForm.notes}
                          onChange={(e) => updTrip('notes', e.target.value)}
                          placeholder="Any notes for this trip..."
                          style={recordControl}
                        />
                      </div>
                    </div>
                    {editTripId && (
                      <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
                        <button
                          onClick={() => {
                            deleteTrip(g.id, editTripId);
                            setActiveTripBatchId(null);
                            setEditTripId(null);
                          }}
                          style={S.btnDanger}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Trip list */}
              {trips.length === 0 && !showTripForm && (
                <div style={{color: '#9ca3af', fontSize: 11, padding: '4px 0 8px'}}>
                  No processing trips yet — they’ll appear here once you Send-to-Trip from /pig/weighins
                </div>
              )}
              {trips.map((t) => {
                const live = tripTotalLive(t);
                const yld = tripYield(t);
                const wts = parseLiveWeights(t.liveWeights);
                const avg = wts.length > 0 ? Math.round(live / wts.length) : 0;
                const tripForecast = processingForecastByTripId[t.id] || null;
                const tripForecastAvg = tripForecast ? tripForecast.avg : null;
                const forecastDelta = avg > 0 && tripForecastAvg != null ? avg - tripForecastAvg : null;
                return (
                  <div
                    key={t.id}
                    style={{
                      borderTop: '1px solid #e5e7eb',
                      padding: '8px 0',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '4px 14px',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div style={{fontWeight: 600, minWidth: 90, color: '#111827'}}>{fmt(t.date)}</div>
                    <span>{parseInt(t.pigCount) || 0} pigs</span>
                    {live > 0 && (
                      <span style={{color: '#1d4ed8'}}>
                        Live: {Math.round(live)} lbs{avg > 0 ? ` (avg ${avg} lbs)` : ''}
                      </span>
                    )}
                    {tripForecast && (
                      <span data-pig-trip-forecast-compare={t.id} style={{color: '#6b7280'}}>
                        Forecast: {Math.round(tripForecast.min)}-{Math.round(tripForecast.max)} lbs
                        {tripForecast.hasActual ? '' : ' (est.)'}
                        {tripForecastAvg != null ? ` (avg ${Math.round(tripForecastAvg)} lbs)` : ''}
                        {forecastDelta != null && (
                          <strong style={{color: forecastDelta >= 0 ? '#065f46' : '#b91c1c', marginLeft: 6}}>
                            {forecastDelta >= 0 ? '+' : ''}
                            {Math.round(forecastDelta)} lbs
                          </strong>
                        )}
                      </span>
                    )}
                    {parseFloat(t.hangingWeight) > 0 && (
                      <span style={{color: '#085041'}}>Hang: {parseFloat(t.hangingWeight)} lbs</span>
                    )}
                    {yld !== null && <span style={{color: '#16a34a', fontWeight: 600}}>Yield: {yld}%</span>}
                    {t.notes && <span style={{color: '#9ca3af', fontStyle: 'italic'}}>{t.notes}</span>}
                    <div style={{marginLeft: 'auto', display: 'flex', gap: 8}}>
                      <button
                        onClick={() => {
                          setTripForm({
                            date: t.date,
                            pigCount: t.pigCount,
                            liveWeights: t.liveWeights,
                            hangingWeight: t.hangingWeight,
                            notes: t.notes || '',
                          });
                          setEditTripId(t.id);
                          setActiveTripBatchId(g.id);
                        }}
                        style={{
                          fontSize: 11,
                          color: '#1d4ed8',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteTrip(g.id, t.id)}
                        style={{
                          fontSize: 11,
                          color: '#b91c1c',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    {wts.length > 0 && (
                      <div style={{width: '100%', fontSize: 10, color: '#9ca3af', marginTop: 1}}>
                        Weights: {t.liveWeights}
                      </div>
                    )}
                    {(() => {
                      const counts = tripSourceCounts(t.id);
                      const keys = Object.keys(counts);
                      if (keys.length === 0) return null;
                      return (
                        <div style={{width: '100%', fontSize: 11, color: '#065f46', marginTop: 2}}>
                          <strong>From:</strong> {keys.map((k) => k + ' (' + counts[k] + ')').join(', ')}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>

            {/* Mortality summary (expandable) */}
            {(g.pigMortalities || []).length > 0 &&
              (() => {
                const morts = g.pigMortalities || [];
                const total = morts.reduce((s, m) => s + (parseInt(m.count) || 0), 0);
                const isOpen = expandedMortality === g.id;
                return (
                  <div
                    style={{
                      padding: '6px 16px',
                      background: '#fef2f2',
                      borderTop: '1px solid #f3f4f6',
                      fontSize: 11,
                    }}
                  >
                    <div
                      onClick={() => setExpandedMortality(isOpen ? null : g.id)}
                      style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}
                    >
                      <span style={{color: '#9ca3af'}}>{isOpen ? '▼' : '▶'}</span>
                      <span style={{color: '#b91c1c', fontWeight: 600}}>
                        {'💀 ' + total + ' ' + (total === 1 ? 'mortality' : 'mortalities') + ' on record'}
                      </span>
                      <span style={{color: '#9ca3af'}}>
                        {'(' + morts.length + ' ' + (morts.length === 1 ? 'entry' : 'entries') + ')'}
                      </span>
                    </div>
                    {isOpen && (
                      <div style={{marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4}}>
                        {[...morts].reverse().map((m) => (
                          <div
                            key={m.id}
                            style={{
                              display: 'flex',
                              gap: 10,
                              alignItems: 'center',
                              padding: '4px 8px',
                              background: 'white',
                              borderRadius: 5,
                              border: '1px solid #fde68a',
                              flexWrap: 'wrap',
                            }}
                          >
                            <span style={{color: '#374151', minWidth: 90, fontWeight: 600}}>{fmt(m.date)}</span>
                            <span style={{color: '#b91c1c', fontWeight: 700, minWidth: 32}}>{m.count}</span>
                            <span style={{color: '#6b7280', minWidth: 120}}>{m.sub_batch_name || 'Whole batch'}</span>
                            {m.comment && (
                              <span style={{color: '#374151', fontStyle: 'italic', flex: 1, minWidth: 120}}>
                                {m.comment}
                              </span>
                            )}
                            <span style={{color: '#9ca3af', fontSize: 10, marginLeft: 'auto'}}>{m.team_member}</span>
                            <button
                              onClick={() => deleteMortality(g.id, m.id)}
                              title="Delete"
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#b91c1c',
                                cursor: 'pointer',
                                fontSize: 13,
                                lineHeight: 1,
                                padding: '0 4px',
                                fontFamily: 'inherit',
                              }}
                            >
                              {'×'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Cycle info footer */}
            {tl && (
              <div
                style={{
                  padding: '6px 16px',
                  background: '#ecfdf5',
                  borderTop: '1px solid #e5e7eb',
                  fontSize: 11,
                  color: '#9ca3af',
                }}
              >
                {cycleLabel(cycle, cycleSeqMap)} · Farrowing: {fmtS(tl.farrowingStart)} → {fmtS(tl.farrowingEnd)} ·{' '}
                {boarNames.boar1}: {cycle.boar1Tags || '—'} · {boarNames.boar2}: {cycle.boar2Tags || '—'}
              </div>
            )}
          </div>
        );
      })}
      <RecordCollaborationSection
        sb={sb}
        authState={authState}
        entityType="pig.batch"
        entityId={group.id}
        entityLabel={group.batchName}
      />
    </>
  );
}
